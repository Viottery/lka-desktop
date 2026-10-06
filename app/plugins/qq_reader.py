"""Opt-in local QQ message reader. It never sends OneBot application actions."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import html
import json
import logging
import os
import re
import sqlite3
import time
from urllib.parse import urlunsplit
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit
from app.plugins.message_sources import QQMessageSource
from app.plugins.message_media import MediaCache, extract_media
from app.plugins.message_ui_content import extract_ui_content_parts

LOG = logging.getLogger(__name__)
WS_TRANSPORT_LOG = logging.getLogger("qq_reader.websocket_transport")
WS_TRANSPORT_LOG.disabled = True
MAX_EVENT_BYTES = 64 * 1024
MAX_QUEUE = 32
MAX_TEXT = 16_384
MAX_ID = 256
MAX_NAME = 512
MAX_BATCH = 100
MAX_PENDING_OUTBOX = 10_000
PING_INTERVAL = 20
PING_TIMEOUT = 20
OPEN_TIMEOUT = 10
OUTBOX_ELIGIBLE = """m.synced=0 AND m.quarantined=0 AND (
 (m.schema_version=1 AND m.policy_revision=p.revision AND COALESCE(v.minimum_import_version,1)=1)
 OR (m.schema_version=2 AND m.capture_epoch=v.capture_epoch))"""
OUTBOX_JOIN = """message_outbox m JOIN approved_policies p USING(platform,account_id,conversation_type,conversation_id)
 LEFT JOIN approved_protocols v USING(platform,account_id,conversation_type,conversation_id)"""
_CQ = re.compile(r"\[CQ:.*?\]", re.IGNORECASE)


class OutboxFull(RuntimeError):
    """Raised internally to apply bounded backpressure without discarding text."""


def _local_host(host: str) -> bool:
    return host.lower() in {"127.0.0.1", "::1", "localhost"}


def _check_ws_url(value: str) -> str:
    try:
        p = urlsplit(value)
        _ = p.port
    except (TypeError, ValueError):
        raise ValueError("invalid_ws_url") from None
    if (p.scheme not in {"ws", "wss"} or not p.hostname or not _local_host(p.hostname)
            or p.username is not None or p.password is not None or p.query or p.fragment):
        raise ValueError("invalid_ws_url")
    return value


def _check_sync_url(value: str) -> str:
    try:
        p = urlsplit(value)
        _ = p.port
    except (TypeError, ValueError):
        raise ValueError("invalid_sync_url") from None
    if (p.scheme != "http" or not p.hostname or not _local_host(p.hostname)
            or p.username is not None or p.password is not None or p.query or p.fragment
            or p.path not in {"/integrations/qq/messages/import", "/integrations/messages/import"}):
        raise ValueError("invalid_sync_url")
    return value


@dataclass(frozen=True)
class QQReaderConfig:
    enabled: bool = False
    ws_url: str = "ws://127.0.0.1:3001/event"
    ws_token: str = field(default="", repr=False)
    expected_self_id: str = field(default="", repr=False)
    sync_url: str = ""
    sync_token: str = field(default="", repr=False)
    db_path: str = "data/qq/reader.db"
    store_raw_event: bool = False
    platform: str = field(default_factory=lambda: os.name, repr=False)

    @classmethod
    def from_env(cls) -> "QQReaderConfig":
        return cls(
            enabled=os.getenv("QQ_READER_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"},
            ws_url=os.getenv("QQ_WS_URL", "ws://127.0.0.1:3001/event"),
            ws_token=os.getenv("QQ_WS_TOKEN", ""),
            expected_self_id=os.getenv("QQ_EXPECTED_SELF_ID", "").strip(),
            sync_url=os.getenv("QQ_SYNC_URL", ""),
            sync_token=os.getenv("QQ_SYNC_TOKEN", ""),
            db_path=os.getenv("QQ_DB_PATH", "data/qq/reader.db"),
            store_raw_event=os.getenv("QQ_STORE_RAW_EVENT", "").strip().lower() in {"1", "true", "yes", "on"},
        )


def _clean_cq(value: str) -> str:
    # Remove CQ segments before decoding HTML/protocol escapes, so escaped CQ
    # introducers cannot become executable-looking markup.
    return html.unescape(_CQ.sub("", value))


def normalize_event(event: dict[str, Any], received_at: int | None = None, *, schema_version: int = 1,
                    capture_epoch: int | None = None) -> dict[str, Any] | None:
    if event.get("post_type") != "message" or event.get("message_type") not in {"private", "group"}:
        return None
    def scalar_id(value: Any) -> str | None:
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            return None
        normalized = str(value)
        return normalized if normalized.strip() else None

    self_id = scalar_id(event.get("self_id"))
    message_id = scalar_id(event.get("message_id"))
    sender = event.get("sender") if isinstance(event.get("sender"), dict) else {}
    sender_id = scalar_id(sender.get("user_id")) or scalar_id(event.get("user_id"))
    conv_id = scalar_id(event.get("group_id")) if event["message_type"] == "group" else sender_id
    if not self_id or not message_id or not sender_id or not conv_id:
        return None
    raw_message = event.get("message")
    if not isinstance(raw_message, (str, list)):
        raw_message = event.get("raw_message")
    if isinstance(raw_message, str):
        text = _clean_cq(raw_message)
    elif isinstance(raw_message, list):
        pieces = []
        for seg in raw_message:
            if isinstance(seg, dict) and seg.get("type") == "text":
                data = seg.get("data")
                if isinstance(data, dict) and isinstance(data.get("text"), str):
                    pieces.append(data["text"])
        text = "".join(pieces)
    else:
        text = ""
    content_kind = "text" if text.strip() else "unsupported"
    if len(text) > MAX_TEXT:
        raise ValueError("text_too_large")
    conv = event["message_type"]
    name = (sender.get("card") or sender.get("nickname") or "") if conv == "group" else (sender.get("nickname") or "")
    sent = event.get("time")
    sent_at = sent if isinstance(sent, int) and not isinstance(sent, bool) and 0 < sent <= 253402300799 else None
    for val, limit in ((self_id, MAX_ID), (message_id, MAX_ID), (sender_id, MAX_ID), (conv_id, MAX_ID), (str(name), MAX_NAME)):
        if len(val) > limit:
            raise ValueError("field_too_large")
    result = {
        "schema_version": schema_version, "platform": "qq", "account_id": self_id,
        "self_id": self_id, "message_id": message_id,
        "conversation_type": conv, "conversation_id": conv_id,
        "sender_id": sender_id, "sender_name": str(name), "display_name": str(name), "text": text,
        "content_kind": content_kind,
        "attachments": [{k: ref[k] for k in ("ordinal", "kind", "file_name")} for ref in extract_media(event)],
        "sent_at": sent_at, "received_at": int(received_at if received_at is not None else time.time()),
        # Kept in the Windows-local outbox for display only. _generic_message
        # uses an explicit backend allowlist and deliberately omits this field.
        "ui_content_parts": extract_ui_content_parts(event),
    }
    if schema_version == 2:
        if not isinstance(capture_epoch, int) or isinstance(capture_epoch, bool) or capture_epoch < 1:
            raise ValueError("invalid_capture_epoch")
        native = isinstance(raw_message, list)
        mentions, parts, reply = [], [], None
        for seg in raw_message if native else []:
            if not isinstance(seg, dict):
                raise ValueError("invalid_metadata")
            data = seg.get("data") if isinstance(seg.get("data"), dict) else {}
            kind = seg.get("type")
            if kind == "text" and isinstance(data.get("text"), str):
                parts.append({"kind": "text", "text": data["text"]})
            elif kind == "at":
                target = scalar_id(data.get("qq"))
                if not target or len(target) > MAX_ID:
                    raise ValueError("invalid_metadata")
                mention = {"kind": "all"} if target == "all" else {"kind": "user", "user_id": target}
                mentions.append(mention)
                parts.append({"kind": "mention", "mention": mention})
            elif kind == "reply":
                target = scalar_id(data.get("id"))
                if not target or len(target) > MAX_ID or reply is not None:
                    raise ValueError("invalid_metadata")
                reply = target
                parts.append({"kind": "reply", "message_id": target})
            else:
                parts.append({"kind": "unsupported"})
            if len(parts) > 100 or len(mentions) > 100:
                raise ValueError("metadata_too_large")
        result.update(capture_epoch=capture_epoch, mentions=mentions, reply_to_message_id=reply,
                      thread_id=None, content_parts=parts, adapter_id="qq_reader.onebot",
                      adapter_version="2", metadata_capabilities={
                          "mentions": "supported" if native else "unknown",
                          "reply": "supported" if native else "unknown", "thread": "not_provided",
                          "content_parts": "supported" if native else "unknown"})
    return result


class QQReader:
    def __init__(self, config: QQReaderConfig | None = None, *,
                 ws_connect: Callable[..., Any] | None = None,
                 http_transport: Any = None,
                 message_source_factory: Callable[[], Any] | None = None):
        self.config = config or QQReaderConfig.from_env()
        self._ws_connect = ws_connect
        self._http = http_transport
        self._message_source_factory = message_source_factory
        self._task: asyncio.Task | None = None
        self._sync_task: asyncio.Task | None = None
        self._policy_task: asyncio.Task | None = None
        self._media_task: asyncio.Task | None = None
        self._media = MediaCache(self)
        self._stop = asyncio.Event()
        self._connection_state = "disabled"
        self._last_received_at: str | None = None
        self._last_error: str | None = None
        self._sync_state = "not_configured" if not self.config.sync_url else "pending"
        self._policies: set[tuple[str, str, str, str]] = set()
        self._policy_state = "unavailable"
        self._counts = {"received": 0, "stored": 0, "duplicates": 0, "ignored": 0, "parse_errors": 0, "sync_attempts": 0, "synced": 0, "queue_full": 0}
        self._started = False

    def status(self) -> dict[str, Any]:
        pending = getattr(self, "_pending_count", 0)
        return {"enabled": bool(self.config.enabled), "connection_state": self._connection_state,
                "last_received_at": self._last_received_at, "last_error": self._last_error,
                "sync_state": self._sync_state, "policy_state": self._policy_state,
                "counters": dict(self._counts), "pending_count": pending,
                "media": self._media.status()}

    async def start(self) -> None:
        if self._started or not self.config.enabled:
            return
        if self.config.platform != "nt":
            self._connection_state, self._last_error = "stopped", "windows_only"
            return
        try:
            _check_ws_url(self.config.ws_url)
            if not isinstance(self.config.ws_token, str) or not self.config.ws_token.strip():
                raise ValueError("invalid_ws_auth")
            if self.config.sync_url:
                _check_sync_url(self.config.sync_url)
                if not isinstance(self.config.sync_token, str) or not self.config.sync_token.strip() or self.config.sync_token == self.config.ws_token:
                    raise ValueError("invalid_sync_auth")
            self._validate_db_path()
        except ValueError as exc:
            self._connection_state, self._last_error = "stopped", str(exc)
            return
        self._started = True
        self._stop.clear()
        await asyncio.to_thread(self._initialize_db)
        await asyncio.to_thread(self._load_cached_policies)
        if self.config.sync_url:
            try:
                await self._refresh_policies()
            except Exception:
                self._policy_state = "stale" if self._policies else "unavailable"
        self._pending_count = await asyncio.to_thread(self._count_pending)
        self._task = asyncio.create_task(self._receive_loop(), name="qq-reader")
        if self.config.sync_url:
            self._sync_task = asyncio.create_task(self._sync_loop(), name="qq-reader-sync")
            self._policy_task = asyncio.create_task(self._policy_loop(), name="qq-reader-policies")
            self._media_task = asyncio.create_task(self._media.run(), name="qq-reader-media")

    async def stop(self) -> None:
        self._stop.set()
        for task in (self._task, self._sync_task, self._policy_task, self._media_task):
            if task:
                task.cancel()
        await asyncio.gather(*(t for t in (self._task, self._sync_task, self._policy_task, self._media_task) if t), return_exceptions=True)
        self._media_task = None
        self._task = self._sync_task = self._policy_task = None
        self._started = False
        if self.config.enabled and self._connection_state != "stopped":
            self._connection_state = "stopped"

    def _validate_db_path(self) -> Path:
        path = Path(self.config.db_path).expanduser()
        raw = str(path)
        if raw.startswith(("\\\\", "//")) or raw.startswith("\\\\wsl$"):
            raise ValueError("invalid_db_path")
        if not path.is_absolute():
            path = Path.cwd() / path
        # Disallow UNC/network share paths; Windows drive paths on non-Windows
        # cannot be used for production by virtue of platform gating.
        if str(path).startswith("\\\\"):
            raise ValueError("invalid_db_path")
        return path

    @contextmanager
    def _connect_db(self):
        conn = sqlite3.connect(str(self._db_path), timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            yield conn
        except Exception:
            conn.rollback()
            raise
        else:
            conn.commit()
        finally:
            conn.close()

    def _initialize_db(self) -> None:
        self._db_path = self._validate_db_path()
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect_db() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("CREATE TABLE IF NOT EXISTS approved_policies (platform TEXT NOT NULL, account_id TEXT NOT NULL, conversation_type TEXT NOT NULL, conversation_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(platform,account_id,conversation_type,conversation_id))")
            c.execute("CREATE TABLE IF NOT EXISTS message_outbox (platform TEXT NOT NULL, account_id TEXT NOT NULL, message_id TEXT NOT NULL, conversation_type TEXT NOT NULL, conversation_id TEXT NOT NULL, payload TEXT NOT NULL, raw_event TEXT, policy_revision INTEGER NOT NULL, synced INTEGER NOT NULL DEFAULT 0, quarantined INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(platform,account_id,message_id))")
            c.execute("CREATE TABLE IF NOT EXISTS approved_protocols (platform TEXT,account_id TEXT,conversation_type TEXT,conversation_id TEXT,capture_epoch INTEGER NOT NULL,minimum_import_version INTEGER NOT NULL,PRIMARY KEY(platform,account_id,conversation_type,conversation_id))")
            columns = {r[1] for r in c.execute("PRAGMA table_info(message_outbox)")}
            if "schema_version" not in columns:
                c.execute("ALTER TABLE message_outbox ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1")
            if "capture_epoch" not in columns:
                c.execute("ALTER TABLE message_outbox ADD COLUMN capture_epoch INTEGER")
            self._media.initialize(c)

    def _store(self, msg: dict[str, Any], raw: str, media_refs=None) -> bool | None:
        # Raw OneBot media/sticker segments may carry private CDN links even when ignored.
        raw_value = None
        if self.config.store_raw_event and not media_refs and not msg.get("attachments") and "[CQ:" not in raw and '"url"' not in raw:
            try:
                raw_event = json.loads(raw)
                raw_message = raw_event.get("message", raw_event.get("raw_message", []))
                plain_segments = not isinstance(raw_message, list) or all(isinstance(seg,dict) and seg.get("type") == "text" for seg in raw_message)
                if plain_segments: raw_value = raw
            except (TypeError, ValueError, AttributeError):
                pass
        platform, account_id, conv_type, conv_id = self._policy_key(msg)
        with self._connect_db() as c:
            c.execute("BEGIN IMMEDIATE")
            policy = c.execute("SELECT revision FROM approved_policies WHERE platform=? AND account_id=? AND conversation_type=? AND conversation_id=?",
                               (platform, account_id, conv_type, conv_id)).fetchone()
            if policy is None:
                c.rollback()
                return None
            protocol = c.execute("SELECT capture_epoch,minimum_import_version FROM approved_protocols WHERE platform=? AND account_id=? AND conversation_type=? AND conversation_id=?", (platform, account_id, conv_type, conv_id)).fetchone()
            version = msg.get("schema_version", 1)
            epoch = msg.get("capture_epoch") if version == 2 else None
            if (protocol and version < protocol[1]) or (version == 2 and (not protocol or epoch != protocol[0])):
                c.rollback()
                return None
            existing = c.execute("SELECT 1 FROM message_outbox WHERE platform=? AND account_id=? AND message_id=?",
                                 (platform, account_id, msg["message_id"])).fetchone()
            if existing:
                c.rollback()
                return False
            pending = c.execute("SELECT COUNT(*) FROM message_outbox WHERE synced=0 AND quarantined=0").fetchone()[0]
            if pending >= MAX_PENDING_OUTBOX:
                c.rollback()
                raise OutboxFull("local_queue_full")
            cur = c.execute("INSERT OR IGNORE INTO message_outbox(platform,account_id,message_id,conversation_type,conversation_id,payload,raw_event,policy_revision,schema_version,capture_epoch,synced,quarantined) VALUES(?,?,?,?,?,?,?,?,?,?,0,0)",
                            (platform, account_id, msg["message_id"], conv_type, conv_id,
                             json.dumps(msg, ensure_ascii=False), raw_value, policy[0], version, epoch))
            self._media.enqueue(c, msg, media_refs or [], policy[0])
            c.commit()
            return cur.rowcount == 1

    async def _accept_normalized(self, msg: dict[str, Any], raw: str = "", media_refs=None) -> bool | None:
        """Shared whitelist gate and durable outbox path for every source."""
        while not self._stop.is_set():
            try:
                inserted = await asyncio.to_thread(self._store, msg, raw, media_refs)
                break
            except OutboxFull:
                self._last_error = "local_queue_full"
                self._counts["queue_full"] += 1
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=1)
                except asyncio.TimeoutError:
                    continue
        else:
            return None
        if inserted is None:
            self._counts["ignored"] += 1
            return None
        self._last_received_at = datetime.now(timezone.utc).isoformat()
        if inserted:
            self._counts["stored"] += 1
            self._pending_count = getattr(self, "_pending_count", 0) + 1
        else:
            self._counts["duplicates"] += 1
        return inserted

    def _count_pending(self) -> int:
        with self._connect_db() as c:
            query = f"SELECT COUNT(*) FROM {OUTBOX_JOIN} WHERE {OUTBOX_ELIGIBLE}"
            args = ()
            if self.config.expected_self_id:
                query += " AND m.account_id=?"
                args = (self.config.expected_self_id,)
            return int(c.execute(query, args).fetchone()[0])

    def _get_batch(self) -> list[dict[str, Any]]:
        with self._connect_db() as c:
            query = f"SELECT m.payload FROM {OUTBOX_JOIN} WHERE {OUTBOX_ELIGIBLE}"
            args = ()
            if self.config.expected_self_id:
                query += " AND m.account_id=?"
                args = (self.config.expected_self_id,)
            rows = c.execute(query + " ORDER BY m.rowid LIMIT ?", (*args, MAX_BATCH)).fetchall()
        messages = [json.loads(row[0]) for row in rows]
        # Each request has one envelope version; queued versions remain intact.
        return [m for m in messages if m.get("schema_version", 1) == messages[0].get("schema_version", 1)] if messages else []

    def _policy_key(self, msg: dict[str, Any]) -> tuple[str, str, str, str]:
        return (str(msg.get("platform", "qq")), str(msg.get("account_id", msg.get("self_id", ""))),
                str(msg.get("conversation_type", "")), str(msg.get("conversation_id", "")))

    def _approved(self, msg: dict[str, Any]) -> bool:
        return self._policy_key(msg) in self._policies

    def _load_cached_policies(self) -> None:
        with self._connect_db() as c:
            self._policies = {tuple(row[:4]) for row in c.execute("SELECT platform,account_id,conversation_type,conversation_id FROM approved_policies")}
        self._policy_state = "cached" if self._policies else "empty"

    async def _get_json(self, url: str) -> dict[str, Any]:
        if self._http is not None:
            response = await self._http.get(url, headers={"Authorization": f"Bearer {self.config.sync_token}"},
                                            follow_redirects=False, trust_env=False)
        else:
            import httpx
            async with httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=10) as client:
                response = await client.get(url, headers={"Authorization": f"Bearer {self.config.sync_token}"})
        if response.status_code < 200 or response.status_code >= 300:
            raise RuntimeError("policy_http_error")
        result = response.json()
        return result if isinstance(result, dict) else {}

    async def _refresh_policies(self) -> None:
        p = urlsplit(self.config.sync_url)
        url = urlunsplit((p.scheme, p.netloc, "/integrations/messages/policies", "", ""))
        result = await self._get_json(url)
        entries = result.get("policies")
        if not isinstance(entries, list):
            raise RuntimeError("invalid_policy_response")
        approved, revisions, media_policies, protocols = set(), [], [], []
        for item in entries:
            if not isinstance(item, dict) or item.get("record_enabled") is not True:
                continue
            fields = (item.get("platform"), item.get("account_id"), item.get("conversation_type"), item.get("conversation_id"))
            if all(isinstance(value, str) and value for value in fields):
                approved.add(tuple(fields))
                revisions.append((*fields, int(item.get("revision", 0))))
                media_policies.append((*fields, int(item.get("revision", 0)), int(item.get("media_enabled") is True)))
                epoch, minimum = item.get("capture_epoch", 1), item.get("minimum_import_version", 1)
                if type(epoch) is not int or epoch < 1 or type(minimum) is not int or minimum not in (1, 2):
                    raise RuntimeError("invalid_policy_response")
                protocols.append((*fields, epoch, minimum))
        await asyncio.to_thread(self._replace_policies, revisions, media_policies, protocols)
        self._policies, self._policy_state = approved, "ready" if approved else "empty"
        self._pending_count = await asyncio.to_thread(self._count_pending)

    def _replace_policies(self, revisions: list[tuple[Any, ...]], media_policies=None, protocols=None) -> None:
        with self._connect_db() as c:
            c.execute("BEGIN IMMEDIATE")
            c.execute("CREATE TEMP TABLE incoming_policies (platform TEXT, account_id TEXT, conversation_type TEXT, conversation_id TEXT, revision INTEGER, PRIMARY KEY(platform,account_id,conversation_type,conversation_id))")
            self._media.preserve_legacy_cache(c, revisions, media_policies, protocols)
            c.executemany("INSERT INTO incoming_policies VALUES(?,?,?,?,?)", revisions)
            c.execute("DELETE FROM approved_policies")
            c.execute("INSERT INTO approved_policies SELECT * FROM incoming_policies")
            c.execute("DROP TABLE incoming_policies")
            c.execute("DELETE FROM approved_protocols")
            c.executemany("INSERT INTO approved_protocols VALUES(?,?,?,?,?,?)", protocols or [])
            c.execute(f"UPDATE message_outbox SET quarantined=1 WHERE synced=0 AND quarantined=0 AND rowid NOT IN (SELECT m.rowid FROM {OUTBOX_JOIN} WHERE {OUTBOX_ELIGIBLE})")
            if media_policies is not None:
                c.execute("DELETE FROM approved_media_policies")
                c.executemany("INSERT INTO approved_media_policies VALUES(?,?,?,?,?,?)", media_policies)
            c.commit()

    async def _policy_loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self._refresh_policies()
            except asyncio.CancelledError:
                raise
            except Exception:
                self._policy_state = "stale" if self._policies else "unavailable"
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=10)
            except asyncio.TimeoutError:
                pass

    def _replace_media_policies(self, policies) -> None:
        with self._connect_db() as c:
            c.execute("DELETE FROM approved_media_policies")
            c.executemany("INSERT INTO approved_media_policies VALUES(?,?,?,?,?,?)", policies)

    def _mark_synced(self, pairs: list[tuple[str, str, str]]) -> int:
        with self._connect_db() as c:
            c.execute("BEGIN IMMEDIATE")
            c.executemany("UPDATE message_outbox SET synced=1 WHERE platform=? AND account_id=? AND message_id=? AND synced=0", pairs)
            count = c.total_changes
            c.commit()
            return count

    def _quarantine(self, pairs: list[tuple[str, str, str]]) -> int:
        if not pairs:
            return 0
        with self._connect_db() as c:
            c.execute("BEGIN IMMEDIATE")
            c.executemany("UPDATE message_outbox SET quarantined=1 WHERE platform=? AND account_id=? AND message_id=? AND synced=0", pairs)
            count = c.total_changes
            c.commit()
            return count

    async def _connect(self):
        if self._ws_connect:
            return await self._ws_connect(self.config.ws_url, additional_headers=self._headers(), max_size=MAX_EVENT_BYTES, max_queue=MAX_QUEUE, proxy=None,
                                          ping_interval=PING_INTERVAL, ping_timeout=PING_TIMEOUT, open_timeout=OPEN_TIMEOUT,
                                          logger=WS_TRANSPORT_LOG)
        try:
            from websockets.asyncio.client import connect
        except ImportError as exc:
            raise RuntimeError("websockets_unavailable") from exc
        class NoRedirectConnect(connect):
            def process_redirect(self, exc):
                return exc
        return NoRedirectConnect(self.config.ws_url, additional_headers=self._headers(), max_size=MAX_EVENT_BYTES, max_queue=MAX_QUEUE, proxy=None,
                                 ping_interval=PING_INTERVAL, ping_timeout=PING_TIMEOUT, open_timeout=OPEN_TIMEOUT,
                                 logger=WS_TRANSPORT_LOG)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.config.ws_token}"} if self.config.ws_token else {}

    async def _receive_loop(self) -> None:
        delay = 1
        while not self._stop.is_set():
            try:
                self._connection_state = "connecting"
                source = self._message_source_factory() if self._message_source_factory else QQMessageSource(self._connect, self._normalize_qq_event)
                await self._consume_source(source)
                if self._stop.is_set():
                    return
                self._connection_state, delay = "connected", 1
                if self._last_error in {"websocket_error", "websockets_unavailable"}:
                    self._last_error = None
                LOG.info("QQ Reader connected")
                if not self._stop.is_set():
                    self._connection_state = "offline"
                    try:
                        await asyncio.wait_for(self._stop.wait(), timeout=delay)
                    except asyncio.TimeoutError:
                        pass
                    delay = min(delay * 2, 60)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._connection_state = "offline"
                self._last_error = "websockets_unavailable" if isinstance(exc, RuntimeError) and str(exc) == "websockets_unavailable" else "websocket_error"
                LOG.info("QQ Reader connection unavailable (%s)", self._last_error)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    pass
                delay = min(delay * 2, 60)

    def _normalize_qq_event(self, event):
        msg = normalize_event(event)
        if msg is None:
            return None
        with self._connect_db() as c:
            protocol = c.execute("SELECT capture_epoch,minimum_import_version FROM approved_protocols WHERE platform=? AND account_id=? AND conversation_type=? AND conversation_id=?", self._policy_key(msg)).fetchone()
        return normalize_event(event, msg["received_at"], schema_version=2, capture_epoch=protocol[0]) if protocol and protocol[1] == 2 else msg

    async def _consume_source(self, source: Any) -> None:
        """Run any statically registered source through the shared whitelist/outbox path."""
        await source.connect()
        self._connection_state = "connected"
        try:
            async for raw in source.receive():
                # Receiving a frame proves the transport has recovered, even
                # while the connection remains open indefinitely.
                if self._last_error in {"websocket_error", "websockets_unavailable"}:
                    self._last_error = None
                self._counts["received"] += 1
                is_qq = isinstance(source, QQMessageSource)
                if is_qq:
                    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_EVENT_BYTES:
                        self._last_error = "event_too_large"
                        self._counts["parse_errors"] += 1
                        continue
                    try:
                        event = json.loads(raw)
                    except (TypeError, ValueError):
                        self._last_error = "invalid_event"
                        self._counts["parse_errors"] += 1
                        continue
                else:
                    event = raw
                if not isinstance(event, dict):
                    self._counts["ignored"] += 1
                    continue
                if (is_qq and self.config.expected_self_id and "self_id" in event
                        and str(event["self_id"]) != self.config.expected_self_id):
                    self._last_error = "account_mismatch"
                    self._connection_state = "stopped"
                    self._stop.set()
                    return
                try:
                    msg = source.normalize(event)
                    if msg is None:
                        self._counts["ignored"] += 1
                        continue
                    inserted = await self._accept_normalized(msg, raw if isinstance(raw, str) else "", extract_media(event) if is_qq else [])
                    if inserted is False:
                        LOG.info("QQ Reader duplicate messages=%d", self._counts["duplicates"])
                except ValueError as exc:
                    self._last_error = str(exc) if str(exc) in {"text_too_large", "field_too_large"} else "invalid_event"
                    self._counts["parse_errors"] += 1
                    LOG.info("QQ Reader event rejected (%s)", self._last_error)
                except Exception:
                    self._last_error = "storage_error"
                    self._counts["parse_errors"] += 1
                    LOG.info("QQ Reader message storage failed (%s)", self._last_error)
        finally:
            await source.stop()

    async def _sync_loop(self) -> None:
        delay = 1
        while not self._stop.is_set():
            try:
                batch = await asyncio.to_thread(self._get_batch)
                self._pending_count = len(batch) if len(batch) < MAX_BATCH else await asyncio.to_thread(self._count_pending)
            except asyncio.CancelledError:
                raise
            except Exception:
                self._sync_state = "storage_error"
                self._last_error = "storage_error"
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=delay)
                except asyncio.TimeoutError:
                    pass
                delay = min(delay * 2, 60)
                continue
            if not batch:
                self._sync_state = "idle"
                delay = 2
            else:
                self._sync_state = "syncing"
                self._counts["sync_attempts"] += 1
                try:
                    response = await self._post_sync({"schema_version": batch[0].get("schema_version", 1), "messages": [self._generic_message(m) for m in batch]})
                    if self._last_error == "sync_offline":
                        self._last_error = None
                    ack = response.get("acknowledged") if isinstance(response, dict) else None
                    allowed = {(m["platform"], m["account_id"], m["message_id"]):
                               (m["platform"], m["account_id"], m["message_id"]) for m in batch}
                    pairs = []
                    if isinstance(ack, list):
                        for item in ack:
                            if not isinstance(item, dict) or not isinstance(item.get("message_id"), str):
                                continue
                            key = (item.get("platform", "qq"), item.get("account_id", item.get("self_id")), item["message_id"])
                            pair = allowed.get(key)
                            if pair and pair not in pairs:
                                pairs.append(pair)
                    rejected = response.get("rejected") if isinstance(response, dict) else None
                    poison = []
                    if isinstance(rejected, list):
                        for item in rejected:
                            if not isinstance(item, dict) or item.get("permanent") is not True or not isinstance(item.get("message_id"), str):
                                continue
                            key = (item.get("platform", "qq"), item.get("account_id", item.get("self_id")), item["message_id"])
                            pair = allowed.get(key)
                            if pair:
                                poison.append(pair)
                    if poison:
                        await asyncio.to_thread(self._quarantine, poison)
                    marked = await asyncio.to_thread(self._mark_synced, pairs) if pairs else 0
                    self._counts["synced"] += marked
                    self._pending_count = await asyncio.to_thread(self._count_pending)
                    self._sync_state = "idle" if self._pending_count == 0 else "pending"
                    delay = 1 if marked else min(delay * 2, 60)
                except asyncio.CancelledError:
                    raise
                except sqlite3.Error:
                    self._sync_state = "storage_error"
                    self._last_error = "storage_error"
                    delay = min(delay * 2, 60)
                except Exception:
                    self._sync_state = "offline"
                    self._last_error = "sync_offline"
                    delay = min(delay * 2, 60)
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

    async def _post_sync(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._post_payload(payload, "/integrations/messages/import")

    async def _post_media(self, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._post_payload(payload, "/integrations/messages/media")

    async def _post_payload(self, payload: dict[str, Any], endpoint: str) -> dict[str, Any]:
        _check_sync_url(self.config.sync_url)
        p = urlsplit(self.config.sync_url)
        generic_url = urlunsplit((p.scheme, p.netloc, endpoint, "", ""))
        if self._http is not None:
            response = await self._http.post(generic_url, json=payload,
                                             headers={"Authorization": f"Bearer {self.config.sync_token}"},
                                             follow_redirects=False, trust_env=False)
            if response.status_code < 200 or response.status_code >= 300:
                raise RuntimeError("sync_http_error")
            result = response.json()
            return result if isinstance(result, dict) else {}
        import httpx
        async with httpx.AsyncClient(follow_redirects=False, trust_env=False, timeout=10) as client:
            response = await client.post(generic_url, json=payload,
                                         headers={"Authorization": f"Bearer {self.config.sync_token}"})
            if response.status_code < 200 or response.status_code >= 300:
                raise RuntimeError("sync_http_error")
            result = response.json()
            return result if isinstance(result, dict) else {}

    @staticmethod
    def _generic_message(msg: dict[str, Any]) -> dict[str, Any]:
        result = {"platform": msg.get("platform", "qq"), "account_id": msg.get("account_id", msg.get("self_id", "")),
                "message_id": msg["message_id"], "conversation_type": msg["conversation_type"],
                "conversation_id": msg["conversation_id"], "sender_id": msg["sender_id"],
                "sender_name": msg.get("sender_name", msg.get("display_name", "")), "text": msg["text"],
                "sent_at": msg.get("sent_at"), "received_at": msg["received_at"],
                "content_kind": msg.get("content_kind", "text"), "attachments": msg.get("attachments", [])}
        if msg.get("schema_version") == 2:
            result.update({k: msg[k] for k in ("capture_epoch", "mentions", "reply_to_message_id", "thread_id", "content_parts", "adapter_id", "adapter_version", "metadata_capabilities")})
        return result
