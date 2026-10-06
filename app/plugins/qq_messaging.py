"""Optional, account-bound local QQ messaging. No backend or Agent integration."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
from urllib.parse import urlsplit
import uuid

from app.plugins.qq_actions import QQActionClient, QQActionConfig, QQActionError
from app.plugins.message_media import download, generated_path, media_type


class MessagingError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


def flag(name):
    return os.getenv(name, "false").lower().strip() in {"1", "true", "yes", "on"}


def qq_id(value, *, signed=False):
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise MessagingError("invalid_id")
    value = str(value)
    if not re.fullmatch(r"-?[0-9]{1,20}" if signed else r"[0-9]{1,20}", value):
        raise MessagingError("invalid_id")
    if not signed and int(value) <= 0:
        raise MessagingError("invalid_id")
    return str(int(value))


def conversation(kind, target):
    if kind not in {"private", "group"}:
        raise MessagingError("invalid_conversation")
    return kind, qq_id(target)


def stamp():
    return datetime.now(timezone.utc).isoformat()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


@dataclass(frozen=True)
class QQMessagingConfig:
    enabled: bool = False
    send_enabled: bool = False
    api_token: str = field(default="", repr=False)
    expected_self_id: str = field(default="", repr=False)
    ws_url: str = "ws://127.0.0.1:3001/event"
    ws_token: str = field(default="", repr=False)
    action_url: str = "http://127.0.0.1:3002"
    action_token: str = field(default="", repr=False)
    db_path: Path = Path("data/qq/messaging.db")
    media_dir: Path = Path("data/qq/messaging-media")
    image_max: int = 20 * 1024 * 1024
    video_max: int = 200 * 1024 * 1024
    media_max: int = 2 * 1024 * 1024 * 1024
    message_max: int = 100000
    timeout: float = 60

    @classmethod
    def from_env(cls):
        return cls(enabled=flag("QQ_MESSAGING_ENABLED"), send_enabled=flag("QQ_SEND_ENABLED"),
                   api_token=os.getenv("QQ_MESSAGING_API_TOKEN", ""),
                   expected_self_id=os.getenv("QQ_EXPECTED_SELF_ID", ""),
                   ws_url=os.getenv("QQ_WS_URL", "ws://127.0.0.1:3001/event"),
                   ws_token=os.getenv("QQ_WS_TOKEN", ""),
                   action_url=os.getenv("QQ_ACTION_URL", "http://127.0.0.1:3002"),
                   action_token=os.getenv("QQ_ACTION_TOKEN", ""),
                   db_path=Path(os.getenv("QQ_MESSAGING_DB_PATH", "data/qq/messaging.db")),
                   media_dir=Path(os.getenv("QQ_MESSAGING_MEDIA_DIR", "data/qq/messaging-media")),
                   image_max=int(os.getenv("QQ_MESSAGING_IMAGE_MAX_BYTES", str(20*1024*1024))),
                   video_max=int(os.getenv("QQ_MESSAGING_VIDEO_MAX_BYTES", str(200*1024*1024))),
                   media_max=int(os.getenv("QQ_MESSAGING_MEDIA_MAX_BYTES", str(2*1024*1024*1024))),
                   message_max=int(os.getenv("QQ_MESSAGING_MESSAGE_MAX", "100000")),
                   timeout=float(os.getenv("QQ_ACTION_TIMEOUT_SECONDS", "60")))


EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
       "image/webp": ".webp", "video/mp4": ".mp4", "video/webm": ".webm"}


class QQMessaging:
    def __init__(self, config=None, *, client=None, connector=None):
        self.config = config or QQMessagingConfig.from_env()
        self.client = client
        self.connector = connector
        self.connection_state = "disabled"
        self.last_error = None
        self.last_received_at = None
        self._task = None
        self._db_lock = threading.RLock()
        self._send_lock = asyncio.Lock()
        self._media_lock = asyncio.Lock()
        self.account = ""
        self.ready = False

    def initialize(self):
        c = self.config
        if not c.enabled:
            return
        try:
            self.account = qq_id(c.expected_self_id)
            if len(c.api_token) < 32 or any(ord(x) < 33 or ord(x) > 126 for x in c.api_token):
                raise ValueError()
            if not c.ws_token or any(ord(x) < 33 or ord(x) > 126 for x in c.ws_token):
                raise ValueError()
            p = urlsplit(c.ws_url)
            import ipaddress
            local = p.hostname == "localhost" or ipaddress.ip_address(p.hostname).is_loopback
            if (p.scheme != "ws" or not local or p.username is not None or p.password is not None
                    or p.query or p.fragment or p.path not in {"/event", "/event/"} or p.port == 0):
                raise ValueError()
            if not (0 < c.image_max <= 20*1024*1024 and 0 < c.video_max <= 200*1024*1024
                    and max(c.image_max, c.video_max) <= c.media_max <= 10*1024*1024*1024
                    and 1 <= c.message_max <= 1000000 and 0 < c.timeout <= 120):
                raise ValueError()
            # Validate generated media directory and DB ancestors against links/reparse points.
            generated_path(c.media_dir, "0" * 64)
            db_path = c.db_path.absolute()
            for part in (db_path, *db_path.parents):
                if part.is_symlink() or (part.exists() and getattr(part.stat(), "st_file_attributes", 0) & 1024):
                    raise ValueError()
            db_path.parent.mkdir(parents=True, exist_ok=True)
            if self.client is None:
                self.client = QQActionClient(QQActionConfig(c.action_url, c.action_token, self.account, c.timeout))
            with self.db() as db:
                db.executescript("""
                    CREATE TABLE IF NOT EXISTS policies (
                        account TEXT, kind TEXT, target TEXT, receive_enabled INTEGER, send_enabled INTEGER,
                        PRIMARY KEY(account,kind,target));
                    CREATE TABLE IF NOT EXISTS messages (
                        seq INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT, message_id TEXT,
                        kind TEXT, target TEXT, direction TEXT, sender_id TEXT, sender_name TEXT,
                        sent_at INTEGER, received_at TEXT, segments TEXT, refs TEXT,
                        UNIQUE(account,message_id));
                    CREATE INDEX IF NOT EXISTS message_cursor ON messages(account,kind,target,seq);
                    CREATE TABLE IF NOT EXISTS media (
                        id TEXT PRIMARY KEY, account TEXT, kind TEXT, mime TEXT, size INTEGER,
                        sha256 TEXT, created_at TEXT, source_kind TEXT, source_target TEXT);
                    CREATE TABLE IF NOT EXISTS sends (
                        account TEXT, key TEXT, digest TEXT, state TEXT, message_id TEXT, error TEXT,
                        created_at TEXT, PRIMARY KEY(account,key));
                """)
                db.execute("UPDATE sends SET state='unknown',error='interrupted' WHERE account=? AND state='pending'", (self.account,))
            self.ready = True
            self.connection_state = "stopped"
        except (ValueError, TypeError, OSError, MessagingError, QQActionError, sqlite3.Error):
            self.last_error = "configuration_error"
            raise MessagingError("configuration_error", 503) from None

    @contextmanager
    def db(self):
        with self._db_lock:
            db = sqlite3.connect(self.config.db_path, timeout=1)
            db.row_factory = sqlite3.Row
            try:
                with db:
                    yield db
            finally:
                db.close()

    def require_ready(self):
        if not self.ready:
            raise MessagingError("messaging_disabled", 503)

    async def start(self):
        await asyncio.to_thread(self.initialize)
        if self.ready:
            self._task = asyncio.create_task(self._receive(), name="qq-messaging-events")

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        self.connection_state = "stopped" if self.ready else "disabled"

    def status(self):
        return {"enabled": self.config.enabled, "ready": self.ready,
                "send_enabled": self.config.send_enabled and self.ready,
                "connection_state": self.connection_state, "last_received_at": self.last_received_at,
                "last_error": self.last_error}

    async def _receive(self):
        from websockets.asyncio.client import connect
        connector = self.connector or connect
        delay = 1
        while True:
            self.connection_state = "connecting"
            try:
                async with connector(self.config.ws_url,
                        additional_headers={"Authorization": "Bearer " + self.config.ws_token},
                        proxy=None, max_size=256*1024, max_queue=16,
                        ping_interval=20, ping_timeout=20, open_timeout=10, close_timeout=3) as socket:
                    self.connection_state, self.last_error, delay = "connected", None, 1
                    async for frame in socket:
                        try:
                            await asyncio.to_thread(self.ingest, frame)
                        except MessagingError as exc:
                            self.last_error = exc.code
                            if exc.code == "account_mismatch":
                                self.connection_state = "stopped"
                                return
                        except sqlite3.Error:
                            self.last_error = "storage_error"
                self.connection_state = "offline"
            except asyncio.CancelledError:
                raise
            except Exception:
                self.connection_state, self.last_error = "offline", "websocket_error"
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)

    def policy(self, kind, target):
        self.require_ready()
        kind, target = conversation(kind, target)
        with self.db() as db:
            row = db.execute("SELECT * FROM policies WHERE account=? AND kind=? AND target=?",
                             (self.account, kind, target)).fetchone()
        return {"conversation_type": kind, "conversation_id": target,
                "receive_enabled": bool(row and row["receive_enabled"]),
                "send_enabled": bool(row and row["send_enabled"])}

    def set_policy(self, kind, target, receive_enabled, send_enabled):
        self.require_ready()
        kind, target = conversation(kind, target)
        if type(receive_enabled) is not bool or type(send_enabled) is not bool:
            raise MessagingError("invalid_policy")
        with self.db() as db:
            db.execute("INSERT OR REPLACE INTO policies VALUES (?,?,?,?,?)",
                       (self.account, kind, target, receive_enabled, send_enabled))
        return self.policy(kind, target)

    def allowed(self, kind, target, permission):
        if not self.policy(kind, target)[permission + "_enabled"]:
            raise MessagingError("conversation_not_allowed", 403)

    def ingest(self, frame):
        self.require_ready()
        if isinstance(frame, (bytes, str)):
            if len(frame) > 256*1024 or (isinstance(frame, str) and len(frame.encode()) > 256*1024):
                raise MessagingError("event_too_large")
            try:
                event = json.loads(frame)
            except (ValueError, UnicodeError, RecursionError):
                raise MessagingError("invalid_event") from None
        else:
            event = frame
        if not isinstance(event, dict):
            raise MessagingError("invalid_event")
        if event.get("self_id") is not None and qq_id(event["self_id"]) != self.account:
            raise MessagingError("account_mismatch", 409)
        if event.get("post_type") not in {"message", "message_sent"}:
            return None
        if qq_id(event.get("self_id")) != self.account:
            raise MessagingError("account_mismatch", 409)
        kind = event.get("message_type")
        direction = "outgoing" if event["post_type"] == "message_sent" else "incoming"
        target = event.get("group_id") if kind == "group" else (event.get("target_id") or event.get("user_id"))
        kind, target = conversation(kind, target)
        try:
            self.allowed(kind, target, "receive")
        except MessagingError:
            return None
        mid = qq_id(event.get("message_id"), signed=True)
        sender = event.get("sender") if isinstance(event.get("sender"), dict) else {}
        sender_id = qq_id(sender.get("user_id") or event.get("user_id"))
        if sender_id == self.account:
            direction = "outgoing"
        name = sender.get("card") or sender.get("nickname") or ""
        name = name[:128] if isinstance(name, str) else ""
        sent = event.get("time")
        sent = sent if type(sent) is int and 0 <= sent <= 99999999999 else None
        segments, refs = self._incoming(event.get("message", event.get("raw_message", [])))
        with self.db() as db:
            if db.execute("SELECT 1 FROM messages WHERE account=? AND message_id=?", (self.account, mid)).fetchone():
                return None
            if db.execute("SELECT count(*) FROM messages").fetchone()[0] >= self.config.message_max:
                raise MessagingError("local_queue_full", 507)
            db.execute("INSERT INTO messages(account,message_id,kind,target,direction,sender_id,sender_name,sent_at,received_at,segments,refs) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                       (self.account, mid, kind, target, direction, sender_id, name, sent, stamp(), encoded(segments), encoded(refs)))
        self.last_received_at, self.last_error = stamp(), None
        return mid

    def _incoming(self, values):
        if isinstance(values, str):
            # CQ strings are decoded as data, never evaluated or returned as HTML.
            result, start = [], 0
            for match in re.finditer(r"\[CQ:([a-z_]+)(?:,([^\]]*))?\]", values):
                if match.start() > start:
                    result.append({"type": "text", "data": {"text": html.unescape(values[start:match.start()])}})
                data = dict(pair.split("=", 1) for pair in (match[2] or "").split(",") if "=" in pair)
                result.append({"type": match[1], "data": {k: html.unescape(v) for k, v in data.items()}})
                start = match.end()
            if start < len(values):
                result.append({"type": "text", "data": {"text": html.unescape(values[start:])}})
            values = result
        if not isinstance(values, list) or len(values) > 100:
            raise MessagingError("invalid_segments")
        segments, refs = [], {}
        total_text = 0
        for value in values:
            if not isinstance(value, dict) or not isinstance(value.get("data", {}), dict):
                raise MessagingError("invalid_segments")
            kind, data = value.get("type"), value.get("data", {})
            if kind == "text":
                text = data.get("text", "")
                if not isinstance(text, str):
                    raise MessagingError("invalid_segments")
                total_text += len(text.encode())
                if total_text > 65536:
                    raise MessagingError("text_too_large")
                segments.append({"type": "text", "text": text})
            elif kind in {"image", "video", "sticker"}:
                if kind == "image" and (str(data.get("sub_type")) == "1" or data.get("emoji_id") or "表情" in str(data.get("summary", ""))):
                    kind = "sticker"
                ordinal = len(segments)
                segments.append({"type": kind, "ordinal": ordinal, "media_id": None})
                url = data.get("url") or data.get("file")
                if isinstance(url, str) and len(url) <= 8192 and url.startswith("https://"):
                    refs[str(ordinal)] = html.unescape(url)
            elif kind in {"face", "reply", "at"}:
                key = "qq" if kind == "at" else "id"
                val = str(data.get(key, ""))
                if re.fullmatch(r"(?:-?[0-9]{1,20}|all)", val):
                    segments.append({"type": kind, key: val})
            else:
                segments.append({"type": "unsupported"})
        return segments, refs

    def messages(self, kind, target, after=0, limit=50):
        kind, target = conversation(kind, target)
        self.allowed(kind, target, "receive")
        if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 100:
            raise MessagingError("invalid_cursor")
        with self.db() as db:
            rows = db.execute("SELECT * FROM messages WHERE account=? AND kind=? AND target=? AND seq>? ORDER BY seq LIMIT ?",
                              (self.account, kind, target, after, limit)).fetchall()
        values = [{"seq": r["seq"], "message_id": r["message_id"], "conversation_type": kind,
                   "conversation_id": target, "direction": r["direction"], "sender_id": r["sender_id"],
                   "sender_name": r["sender_name"], "sent_at": r["sent_at"], "received_at": r["received_at"],
                   "segments": json.loads(r["segments"])} for r in rows]
        return {"messages": values, "next_cursor": rows[-1]["seq"] if rows else after,
                "has_more": len(rows) == limit}

    def media(self, mid):
        self.require_ready()
        if not isinstance(mid, str) or not re.fullmatch(r"[0-9a-f]{64}", mid):
            raise MessagingError("media_not_found", 404)
        with self.db() as db:
            row = db.execute("SELECT * FROM media WHERE id=? AND account=?", (mid, self.account)).fetchone()
        if row is None:
            raise MessagingError("media_not_found", 404)
        if row["source_kind"]:
            self.allowed(row["source_kind"], row["source_target"], "receive")
        return dict(row)

    def media_path(self, row):
        path = generated_path(self.config.media_dir, row["id"], EXT[row["mime"]])
        if not path.is_file() or path.stat().st_size != row["size"]:
            raise MessagingError("media_unavailable", 410)
        return path

    def public_media(self, row):
        return {k: row[k] for k in ("id", "kind", "mime", "size", "sha256", "created_at")}

    def _quota(self, reserve):
        # Count files too, including orphaned uploads after a crash.
        size = sum(p.stat().st_size for p in self.config.media_dir.absolute().iterdir() if p.is_file())
        if size + reserve > self.config.media_max:
            raise MessagingError("media_quota_exceeded", 507)

    def _save_media(self, mid, kind, meta, source_kind=None, source_target=None):
        row = {"id": mid, "account": self.account, "kind": kind, "mime": meta["mime_type"],
               "size": meta["size_bytes"], "sha256": meta["sha256"], "created_at": stamp(),
               "source_kind": source_kind, "source_target": source_target}
        with self.db() as db:
            db.execute("INSERT INTO media VALUES (:id,:account,:kind,:mime,:size,:sha256,:created_at,:source_kind,:source_target)", row)
        return row

    async def upload(self, kind, stream):
        self.require_ready()
        if kind not in {"image", "video", "sticker"}:
            raise MessagingError("unsupported_media")
        limit = self.config.video_max if kind == "video" else self.config.image_max
        async with self._media_lock:
            await asyncio.to_thread(self._quota, limit)
            mid = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
            tmp = generated_path(self.config.media_dir, mid, ".tmp")
            final = None
            size, digest, header = 0, hashlib.sha256(), bytearray()
            try:
                with tmp.open("xb") as dest:
                    async for chunk in stream:
                        size += len(chunk)
                        if size > limit:
                            raise MessagingError("media_too_large", 413)
                        if len(header) < 32:
                            header.extend(chunk[:32-len(header)])
                        digest.update(chunk)
                        await asyncio.to_thread(dest.write, chunk)
                mime = media_type(bytes(header))
                if not mime or not mime.startswith(("video" if kind == "video" else "image") + "/"):
                    raise MessagingError("invalid_media_type", 415)
                final = generated_path(self.config.media_dir, mid, EXT[mime])
                await asyncio.to_thread(tmp.replace, final)
                row = await asyncio.to_thread(self._save_media, mid, kind,
                              {"mime_type": mime, "size_bytes": size, "sha256": digest.hexdigest()})
                return self.public_media(row)
            except BaseException:
                if final:
                    final.unlink(missing_ok=True)
                raise
            finally:
                tmp.unlink(missing_ok=True)

    async def cache_received(self, seq, ordinal):
        self.require_ready()
        async with self._media_lock:
            with self.db() as db:
                row = db.execute("SELECT * FROM messages WHERE seq=? AND account=?", (seq, self.account)).fetchone()
            if row is None:
                raise MessagingError("message_not_found", 404)
            self.allowed(row["kind"], row["target"], "receive")
            segments = json.loads(row["segments"])
            if not 0 <= ordinal < len(segments) or segments[ordinal]["type"] not in {"image", "video", "sticker"}:
                raise MessagingError("unsupported_media")
            segment = segments[ordinal]
            if segment.get("media_id"):
                return self.public_media(self.media(segment["media_id"]))
            url = json.loads(row["refs"]).get(str(ordinal))
            if not url:
                raise MessagingError("media_source_unavailable", 410)
            kind = segment["type"]
            limit = self.config.video_max if kind == "video" else self.config.image_max
            await asyncio.to_thread(self._quota, limit)
            mid = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
            def permitted():
                return self.policy(row["kind"], row["target"])["receive_enabled"]
            final = None
            try:
                transfer = asyncio.create_task(asyncio.to_thread(download, url, self.config.media_dir, mid, limit,
                              self.config.timeout, "video" if kind == "video" else "image", permitted,
                              extra_hosts=("gxh.vip.qq.com",)))
                try:
                    meta = await asyncio.shield(transfer)
                except asyncio.CancelledError:
                    # Let the bounded worker stop before cleaning its generated file.
                    try:
                        await transfer
                    except Exception:
                        pass
                    raise
                if not permitted():
                    raise MessagingError("conversation_not_allowed", 403)
                final = generated_path(self.config.media_dir, mid, EXT[meta["mime_type"]])
                generated_path(self.config.media_dir, mid).replace(final)
                media = self._save_media(mid, kind, meta, row["kind"], row["target"])
                segment["media_id"] = mid
                with self.db() as db:
                    db.execute("UPDATE messages SET segments=? WHERE seq=? AND account=?", (encoded(segments), seq, self.account))
                return self.public_media(media)
            except MessagingError:
                if final:
                    final.unlink(missing_ok=True)
                raise
            except Exception:
                if final:
                    final.unlink(missing_ok=True)
                raise MessagingError("media_download_failed", 502) from None
            finally:
                generated_path(self.config.media_dir, mid).unlink(missing_ok=True)

    def _outgoing(self, values):
        if not isinstance(values, list) or not 1 <= len(values) <= 50:
            raise MessagingError("invalid_segments")
        if len(values) > 1 and any(isinstance(v, dict) and v.get("type") == "video" for v in values):
            raise MessagingError("video_must_be_standalone")
        result, text_size = [], 0
        for value in values:
            if not isinstance(value, dict):
                raise MessagingError("invalid_segments")
            kind = value.get("type")
            if kind == "text":
                text = value.get("text")
                if not isinstance(text, str) or not text:
                    raise MessagingError("invalid_text")
                text_size += len(text.encode())
                if text_size > 65536:
                    raise MessagingError("text_too_large", 413)
                result.append({"type": "text", "data": {"text": text}})
            elif kind in {"image", "video", "sticker"}:
                media = self.media(value.get("media_id"))
                if media["kind"] != kind:
                    raise MessagingError("media_kind_mismatch")
                data = {"file": self.media_path(media).as_uri()}
                if kind == "sticker":
                    data.update(sub_type=1, summary="[动画表情]")
                result.append({"type": "video" if kind == "video" else "image", "data": data})
            elif kind in {"face", "reply", "at"}:
                key = "qq" if kind == "at" else "id"
                val = value.get(key)
                if kind == "at" and val == "all":
                    valid = "all"
                elif kind == "face" and str(val) == "0" and not isinstance(val, bool):
                    valid = "0"
                else:
                    valid = qq_id(val, signed=kind == "reply")
                result.append({"type": kind, "data": {key: valid}})
            elif kind == "custom_face" and len(values) == 1:
                emoji = value.get("emoji_id")
                if not isinstance(emoji, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", emoji):
                    raise MessagingError("invalid_emoji_id")
                return "send_custom_face", {"emoji_id": emoji}
            else:
                raise MessagingError("unsupported_segment")
        return "send_msg", {"message": result, "auto_escape": True}

    def send_receipt(self, key):
        self.require_ready()
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", key):
            raise MessagingError("invalid_idempotency_key")
        with self.db() as db:
            row = db.execute("SELECT * FROM sends WHERE account=? AND key=?", (self.account, key)).fetchone()
        if row is None:
            raise MessagingError("send_not_found", 404)
        return {k: row[k] for k in ("key", "state", "message_id", "error", "created_at")}

    def _finish_send(self, key, state, mid=None, error=None):
        with self.db() as db:
            db.execute("UPDATE sends SET state=?,message_id=?,error=? WHERE account=? AND key=?",
                       (state, mid, error, self.account, key))
        return self.send_receipt(key)

    async def send(self, key, kind, target, values):
        self.require_ready()
        kind, target = conversation(kind, target)
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,128}", key):
            raise MessagingError("invalid_idempotency_key")
        if not isinstance(values, list) or len(encoded(values).encode()) > 128*1024:
            raise MessagingError("invalid_segments")
        # Snapshot before awaiting; key represents exactly one logical message.
        values = json.loads(encoded(values))
        digest = hashlib.sha256(encoded([kind, target, values]).encode()).hexdigest()
        async with self._send_lock:
            with self.db() as db:
                prior = db.execute("SELECT digest FROM sends WHERE account=? AND key=?", (self.account, key)).fetchone()
            if prior:
                if prior["digest"] != digest:
                    raise MessagingError("idempotency_conflict", 409)
                return self.send_receipt(key)
            if not self.config.send_enabled:
                raise MessagingError("sending_disabled", 403)
            self.allowed(kind, target, "send")
            if kind == "private" and any(isinstance(v, dict) and v.get("type") == "at" for v in values):
                raise MessagingError("mention_requires_group")
            action, params = self._outgoing(values)
            params["group_id" if kind == "group" else "user_id"] = int(target)
            if action == "send_msg":
                params["message_type"] = kind
            with self.db() as db:
                if (db.execute("SELECT count(*) FROM sends").fetchone()[0] >= self.config.message_max
                        or db.execute("SELECT count(*) FROM messages").fetchone()[0] >= self.config.message_max):
                    raise MessagingError("local_queue_full", 507)
                db.execute("INSERT INTO sends VALUES (?,?,?,'pending',NULL,NULL,?)", (self.account, key, digest, stamp()))
            try:
                data = await self.client.call(action, params)
                if not isinstance(data, dict) or data.get("message_id") is None:
                    return self._finish_send(key, "unknown", error="invalid_receipt")
                mid = qq_id(data["message_id"], signed=True)
                receipt = self._finish_send(key, "accepted", mid)
                # Record outbound locally even when message_sent echo is unavailable.
                with self.db() as db:
                    db.execute("INSERT OR IGNORE INTO messages(account,message_id,kind,target,direction,sender_id,sender_name,sent_at,received_at,segments,refs) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                               (self.account, mid, kind, target, "outgoing", self.account, "", None, stamp(), encoded(values), "{}"))
                return receipt
            except QQActionError as exc:
                certain = exc.code in {"account_mismatch", "auth_error", "invalid_config", "invalid_params", "unsupported_action"} or (exc.code == "action_failed" and exc.status_code == 200)
                return self._finish_send(key, "failed" if certain else "unknown", error=exc.code)
            except asyncio.CancelledError:
                self._finish_send(key, "unknown", error="interrupted")
                raise
            except Exception:
                return self._finish_send(key, "unknown", error="send_error")

    async def stickers(self, count=48):
        self.require_ready()
        if not 1 <= count <= 100:
            raise MessagingError("invalid_limit")
        try:
            await self.client.verify_account()
            data = await self.client.call("fetch_custom_face", {"count": count, "return_type": "id"})
        except QQActionError as exc:
            raise MessagingError(exc.code, 502) from None
        if not isinstance(data, list):
            raise MessagingError("protocol_error", 502)
        values = []
        for entry in data[:count]:
            emoji = entry if isinstance(entry, str) else entry.get("id", entry.get("emoji_id")) if isinstance(entry, dict) else None
            if isinstance(emoji, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,256}", emoji):
                values.append({"emoji_id": emoji})
        return {"stickers": values}
