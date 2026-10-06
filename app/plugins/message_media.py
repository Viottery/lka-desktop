"""Private durable QQ media cache; no URLs or local paths leave this module."""
from __future__ import annotations

import asyncio
import hashlib
import html
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit


def extract_media(event):
    segments = event.get("message", event.get("raw_message", []))
    if isinstance(segments, str):
        segments = [{"type": m.group(1), "data": dict(pair.split("=", 1) for pair in m.group(2).split(",") if "=" in pair)}
                    for m in re.finditer(r"\[CQ:([^,\]]+),([^\]]*)\]", segments)]
    if not isinstance(segments, list):
        return []
    refs = []
    for ordinal, segment in enumerate(segments):
        if not isinstance(segment, dict) or segment.get("type") not in {"image", "video"}:
            continue
        data = segment.get("data", {})
        if not isinstance(data, dict):
            continue
        if str(data.get("sub_type", "")) == "1" or any(data.get(k) for k in ("emoji_id", "emoji_package_id", "package_id", "key")) or "表情" in str(data.get("summary", "")):
            continue
        candidate = data.get("url") or data.get("file")
        url = html.unescape(candidate) if isinstance(candidate, str) and candidate.startswith(("https://", "http://")) else None
        name = data.get("file")
        name = name if isinstance(name, str) and not urlsplit(name).scheme and "/" not in name and "\\" not in name else None
        refs.append({"ordinal": ordinal, "kind": segment["type"], "file_name": name[:255] if name else None, "url": url})
        if len(refs) == 20:
            break
    return refs


def cache_key(platform, account_id, message_id, ordinal):
    return hashlib.sha256(json.dumps([platform, account_id, message_id, ordinal], separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


def media_type(header):
    if header.startswith(b"\x89PNG\r\n\x1a\n"): return "image/png"
    if header.startswith(b"\xff\xd8\xff"): return "image/jpeg"
    if header.startswith((b"GIF87a", b"GIF89a")): return "image/gif"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP": return "image/webp"
    if header[4:8] == b"ftyp": return "video/mp4"
    if header.startswith(b"\x1aE\xdf\xa3"): return "video/webm"
    return None


def checked_addresses(url, *, extra_hosts=()):
    p = urlsplit(url)
    host = (p.hostname or "").lower()
    if p.scheme != "https" or p.username is not None or p.password is not None or p.fragment or p.port not in (None, 443) or not (host == "multimedia.nt.qq.com.cn" or host.endswith(".qpic.cn") or host in extra_hosts):
        raise ValueError("unsafe_url")
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(row[4][0]).is_global for row in addresses):
        raise ValueError("unsafe_url")
    return p, addresses


def generated_path(directory, key, suffix=".bin"):
    directory = Path(directory).absolute()
    if not re.fullmatch(r"[0-9a-f]{64}", key): raise ValueError("cache_path")
    for component in (directory, *directory.parents):
        if component.is_symlink() or (component.exists() and getattr(component.stat(), "st_file_attributes", 0) & 1024):
            raise ValueError("cache_path")
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (key + suffix)
    if path.is_symlink() or (path.exists() and getattr(path.stat(), "st_file_attributes", 0) & 1024): raise ValueError("cache_path")
    return path


def download(url, directory, key, limit, timeout, kind, permitted=lambda: True, *, extra_hosts=()):
    p, addresses = checked_addresses(url, extra_hosts=extra_hosts)
    conn = http.client.HTTPSConnection(p.hostname, timeout=timeout, context=ssl.create_default_context())
    # Connect only to the address validated above; keep the original TLS SNI.
    family, socktype, proto, _, address = addresses[0]
    sock = socket.socket(family, socktype, proto)
    sock.settimeout(timeout)
    tmp = generated_path(directory, key, ".tmp")
    final = generated_path(directory, key)
    try:
        sock.connect(address)
        conn.sock = conn._context.wrap_socket(sock, server_hostname=p.hostname)
        conn.request("GET", p.path + ("?" + p.query if p.query else ""), headers={"Accept": "image/*,video/*"})
        response = conn.getresponse()
        if response.status != 200: raise ValueError("download_http_error")
        length = response.getheader("Content-Length")
        if length and int(length) > limit: raise ValueError("too_large")
        digest, size, header = hashlib.sha256(), 0, b""
        deadline = time.monotonic() + timeout
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as output:
            while True:
                if not permitted(): raise ValueError("revoked")
                if time.monotonic() > deadline: raise ValueError("download_timeout")
                chunk = response.read(65536)
                if not chunk: break
                size += len(chunk)
                if size > limit: raise ValueError("too_large")
                header = (header + chunk)[:32]
                digest.update(chunk)
                output.write(chunk)
        mime = media_type(header)
        if not mime or not mime.startswith(kind + "/"): raise ValueError("unsupported_media")
        if not permitted(): raise ValueError("revoked")
        os.replace(tmp, final)
        if not permitted():
            final.unlink()
            raise ValueError("revoked")
        return {"mime_type": mime, "size_bytes": size, "sha256": digest.hexdigest()}
    finally:
        conn.close()
        sock.close()
        if tmp.exists(): tmp.unlink()


class MediaCache:
    def __init__(self, reader):
        self.reader = reader
        self.directory = os.getenv("QQ_MEDIA_CACHE_DIR", "data/qq/media")
        self.enabled = os.getenv("QQ_MEDIA_ENABLED", "false").lower() in {"1", "true", "yes", "on"}
        self.ttl = max(60, int(os.getenv("QQ_MEDIA_TTL_SECONDS", "259200")))
        self.quota = max(1, int(os.getenv("QQ_MEDIA_MAX_BYTES", "2147483648")))
        self.image_limit = max(1, int(os.getenv("QQ_MEDIA_IMAGE_MAX_BYTES", "20971520")))
        self.video_limit = max(1, int(os.getenv("QQ_MEDIA_VIDEO_MAX_BYTES", "209715200")))
        self.timeout = max(1, int(os.getenv("QQ_MEDIA_DOWNLOAD_TIMEOUT_SECONDS", "60")))
        self.state = "idle" if self.enabled else "disabled"
        self.last_error_class = None
        self.counters = {key: 0 for key in ("pending", "cached", "failed", "unavailable", "expired")}

    def status(self):
        return {"enabled": self.enabled, "state": self.state,
                "last_error_class": self.last_error_class, "counters": dict(self.counters)}

    def refresh_counters(self):
        with self.reader._connect_db() as c:
            counts = dict(c.execute("SELECT state,COUNT(*) FROM private_media GROUP BY state"))
        self.counters = {key: int(counts.get(key, 0)) for key in self.counters}

    def initialize(self, c):
        c.execute("CREATE TABLE IF NOT EXISTS approved_media_policies(platform TEXT,account_id TEXT,conversation_type TEXT,conversation_id TEXT,revision INTEGER,media_enabled INTEGER,PRIMARY KEY(platform,account_id,conversation_type,conversation_id))")
        c.execute("CREATE TABLE IF NOT EXISTS private_media(cache_key TEXT PRIMARY KEY,platform TEXT,account_id TEXT,message_id TEXT,conversation_type TEXT,conversation_id TEXT,policy_revision INTEGER,ordinal INTEGER,kind TEXT,url TEXT,state TEXT,metadata TEXT,expires_at INTEGER,attempts INTEGER DEFAULT 0,next_retry INTEGER DEFAULT 0,synced INTEGER DEFAULT 0)")
        columns = {r[1] for r in c.execute("PRAGMA table_info(private_media)")}
        if "capture_epoch" not in columns:
            c.execute("ALTER TABLE private_media ADD COLUMN capture_epoch INTEGER")
        c.execute("CREATE INDEX IF NOT EXISTS private_media_jobs ON private_media(synced,next_retry)")
        c.execute("CREATE INDEX IF NOT EXISTS private_media_expiry ON private_media(state,expires_at)")
        c.execute("CREATE TABLE IF NOT EXISTS private_media_legacy_cache(cache_key TEXT PRIMARY KEY,capture_epoch INTEGER NOT NULL)")
        for row in c.execute("SELECT cache_key FROM private_media WHERE state='pending'"):
            tmp = generated_path(self.directory,row[0],".tmp")
            if tmp.exists(): tmp.unlink()
            final = generated_path(self.directory,row[0])
            if final.exists(): final.unlink()

    def enqueue(self, c, msg, refs, revision):
        if not self.enabled: return
        key = self.reader._policy_key(msg)
        policy = c.execute("SELECT media_enabled FROM approved_media_policies WHERE platform=? AND account_id=? AND conversation_type=? AND conversation_id=? AND revision=?", (*key, revision)).fetchone()
        if not policy or not policy[0]: return
        for ref in refs:
            state = "pending" if ref.get("url") else "unavailable"
            c.execute("INSERT OR IGNORE INTO private_media(cache_key,platform,account_id,message_id,conversation_type,conversation_id,policy_revision,ordinal,kind,url,state,metadata,expires_at,capture_epoch) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (cache_key(msg["platform"],msg["account_id"],msg["message_id"],ref["ordinal"]),msg["platform"],msg["account_id"],msg["message_id"],msg["conversation_type"],msg["conversation_id"],revision,ref["ordinal"],ref["kind"],ref.get("url"),state,"{}",int(time.time())+self.ttl,msg.get("capture_epoch") if msg.get("schema_version") == 2 else None))

    @staticmethod
    def permission_query():
        return """SELECT 1 FROM approved_media_policies p
         JOIN approved_policies a USING(platform,account_id,conversation_type,conversation_id,revision)
         LEFT JOIN approved_protocols v USING(platform,account_id,conversation_type,conversation_id)
         WHERE p.platform=d.platform AND p.account_id=d.account_id
         AND p.conversation_type=d.conversation_type AND p.conversation_id=d.conversation_id
         AND p.media_enabled=1 AND (
          (d.capture_epoch IS NULL AND p.revision=d.policy_revision AND COALESCE(v.minimum_import_version,1)=1)
          OR (d.capture_epoch IS NOT NULL AND d.capture_epoch=v.capture_epoch))"""

    def allowed(self, c, row):
        if self.reader.config.expected_self_id and row["account_id"] != self.reader.config.expected_self_id: return False
        return c.execute(f"SELECT 1 FROM private_media d WHERE d.cache_key=? AND EXISTS ({self.permission_query()})", (row["cache_key"],)).fetchone() is not None

    def preserve_legacy_cache(self, c, revisions, media_policies, protocols):
        """Retain acknowledged v1 bytes on upgrade; never grant import permission."""
        incoming = {tuple(row[:4]): row[4] for row in revisions}
        media = {tuple(row[:4]): (row[4], row[5]) for row in media_policies or []}
        protocol = {tuple(row[:4]): (row[4], row[5]) for row in protocols or []}
        old_protocol = {tuple(row[:4]): (row[4], row[5]) for row in c.execute("SELECT * FROM approved_protocols")}
        # Revoke before cleanup, so reauthorizing cannot resurrect a stale grant.
        for row in c.execute("SELECT l.cache_key,l.capture_epoch,d.platform,d.account_id,d.conversation_type,d.conversation_id FROM private_media_legacy_cache l LEFT JOIN private_media d USING(cache_key)").fetchall():
            key = tuple(row[2:6])
            if (key not in incoming or media.get(key) != (incoming[key], 1)
                    or protocol.get(key) != (row[1], 2)):
                c.execute("DELETE FROM private_media_legacy_cache WHERE cache_key=?", (row[0],))
        rows = c.execute(f"SELECT d.* FROM private_media d JOIN message_outbox m USING(platform,account_id,message_id) WHERE d.capture_epoch IS NULL AND d.state='cached' AND d.synced=1 AND m.synced=1 AND m.quarantined=0 AND EXISTS ({self.permission_query()})").fetchall()
        for row in rows:
            key = tuple(row[name] for name in ("platform", "account_id", "conversation_type", "conversation_id"))
            old = old_protocol.get(key)
            if (old and old[1] == 1 and key in incoming
                    and media.get(key) == (incoming[key], 1)
                    and protocol.get(key) == (old[0], 2)):
                c.execute("INSERT OR IGNORE INTO private_media_legacy_cache VALUES(?,?)", (row["cache_key"], old[0]))

    @staticmethod
    def legacy_cache_query():
        return """SELECT 1 FROM private_media_legacy_cache l
         JOIN approved_protocols v ON v.platform=d.platform AND v.account_id=d.account_id
          AND v.conversation_type=d.conversation_type AND v.conversation_id=d.conversation_id
         JOIN approved_policies a USING(platform,account_id,conversation_type,conversation_id)
         JOIN approved_media_policies p USING(platform,account_id,conversation_type,conversation_id,revision)
         WHERE l.cache_key=d.cache_key AND l.capture_epoch=v.capture_epoch
          AND v.minimum_import_version=2 AND p.media_enabled=1
          AND d.capture_epoch IS NULL AND d.synced=1 AND d.state IN ('cached','expired')"""

    def cache_allowed(self, c, row):
        if self.reader.config.expected_self_id and row["account_id"] != self.reader.config.expected_self_id: return False
        return self.allowed(c, row) or c.execute(f"SELECT 1 FROM private_media d WHERE d.cache_key=? AND EXISTS ({self.legacy_cache_query()})", (row["cache_key"],)).fetchone() is not None

    def cleanup(self):
        with self.reader._connect_db() as c:
            rows = c.execute(f"SELECT d.* FROM private_media d WHERE (NOT EXISTS ({self.permission_query()}) AND NOT EXISTS ({self.legacy_cache_query()})) OR (d.state!='expired' AND d.expires_at<=?) ORDER BY d.expires_at LIMIT 200", (int(time.time()),)).fetchall()
            for row in rows:
                revoked = not self.cache_allowed(c, row)
                if revoked or row["expires_at"] <= time.time():
                    path = generated_path(self.directory, row["cache_key"])
                    if path.exists(): path.unlink()
                    tmp = generated_path(self.directory, row["cache_key"], ".tmp")
                    if tmp.exists(): tmp.unlink()
                    if revoked:
                        c.execute("DELETE FROM private_media_legacy_cache WHERE cache_key=?", (row["cache_key"],))
                        c.execute("DELETE FROM private_media WHERE cache_key=?", (row["cache_key"],))
                    elif row["state"] != "expired":
                        c.execute(f"UPDATE private_media AS d SET state='expired',url=NULL,synced=CASE WHEN EXISTS ({self.legacy_cache_query()}) THEN 1 ELSE 0 END WHERE cache_key=?", (row["cache_key"],))

    def reserve(self, limit):
        with self.reader._connect_db() as c:
            rows = c.execute("SELECT * FROM private_media WHERE state='cached' ORDER BY expires_at").fetchall()
            total = sum(json.loads(r["metadata"]).get("size_bytes", 0) for r in rows)
            for row in rows:
                if total + limit <= self.quota: break
                path = generated_path(self.directory, row["cache_key"])
                if path.exists(): path.unlink()
                total -= json.loads(row["metadata"]).get("size_bytes", 0)
                c.execute(f"UPDATE private_media AS d SET state='expired',url=NULL,synced=CASE WHEN EXISTS ({self.legacy_cache_query()}) THEN 1 ELSE 0 END WHERE cache_key=?", (row["cache_key"],))

    def permitted(self, row):
        if self.reader._stop.is_set() or row['expires_at'] <= time.time(): return False
        with self.reader._connect_db() as c: return self.allowed(c,row)

    def next_job(self):
        with self.reader._connect_db() as c:
            rows = c.execute("SELECT d.* FROM private_media d JOIN message_outbox m USING(platform,account_id,message_id) WHERE m.synced=1 AND m.quarantined=0 AND d.synced=0 AND d.next_retry<=? ORDER BY d.rowid LIMIT 100", (int(time.time()),)).fetchall()
            return next((dict(r) for r in rows if self.allowed(c,r)), None)

    async def step(self):
        row = await asyncio.to_thread(self.next_job)
        if not row:
            self.state = "idle"
            return
        self.state = "downloading" if row["state"] == "pending" else "syncing"
        metadata = json.loads(row["metadata"])
        if row["state"] == "pending":
            cancelled = threading.Event()
            download_task = None
            try:
                limit = min(self.quota, self.image_limit if row["kind"] == "image" else self.video_limit)
                await asyncio.to_thread(self.reserve, limit)
                with self.reader._connect_db() as c:
                    if not self.allowed(c, row): return
                download_task = asyncio.create_task(asyncio.to_thread(download, row["url"], self.directory, row["cache_key"], limit, self.timeout, row["kind"], lambda: not cancelled.is_set() and self.permitted(row)))
                metadata = await asyncio.shield(download_task)
                row["state"] = "cached"
            except asyncio.CancelledError:
                cancelled.set()
                if download_task is not None:
                    # Drain the old worker before stop returns; it owns this key's .tmp.
                    try: await asyncio.shield(download_task)
                    except Exception: pass
                raise
            except Exception as exc:
                self.last_error_class = type(exc).__name__[:64]
                code = str(exc) if isinstance(exc, ValueError) and str(exc) in {"unsafe_url","too_large","unsupported_media","download_http_error","download_timeout"} else "download_error"
                row["attempts"] += 1
                row["state"] = "failed" if row["attempts"] >= 3 or code in {"unsafe_url","too_large","unsupported_media"} else "pending"
                self.state = row["state"]
                metadata = {"error_code": code}
            with self.reader._connect_db() as c:
                if not self.permitted(row):
                    path = generated_path(self.directory, row["cache_key"])
                    if path.exists(): path.unlink()
                    if not self.allowed(c,row):
                        c.execute("DELETE FROM private_media WHERE cache_key=?",(row["cache_key"],))
                    elif row["expires_at"] <= time.time():
                        c.execute("UPDATE private_media SET state='expired',url=NULL,synced=0 WHERE cache_key=?",(row["cache_key"],))
                    # Stopping leaves pending durable work available for the next start.
                    return
                c.execute("UPDATE private_media SET state=?,metadata=?,attempts=?,next_retry=?,url=CASE WHEN ?='pending' THEN url ELSE NULL END WHERE cache_key=?",(row["state"],json.dumps(metadata),row["attempts"],int(time.time())+min(300,10*2**row["attempts"]),row["state"],row["cache_key"]))
            if row["state"] == "pending": return
        payload = {k: row[k] for k in ("platform","account_id","message_id","conversation_type","conversation_id","policy_revision","ordinal","state")}
        if row.get("capture_epoch") is not None:
            payload["capture_epoch"] = row["capture_epoch"]
        payload.update(metadata)
        payload["expires_at"] = row["expires_at"]
        with self.reader._connect_db() as c:
            if self.reader._stop.is_set() or not self.allowed(c,row): return
        response = await self.reader._post_media({"schema_version":2 if row.get("capture_epoch") is not None else 1,"media":[payload]})
        matching = lambda item: isinstance(item,dict) and all(item.get(k)==row[k] for k in ("platform","account_id","message_id","ordinal"))
        acked = any(matching(i) for i in response.get("acknowledged",[]))
        rejected = any(matching(i) and i.get("permanent") is True for i in response.get("rejected",[]))
        with self.reader._connect_db() as c:
            if acked: c.execute("UPDATE private_media SET synced=1 WHERE cache_key=?",(row["cache_key"],))
            elif rejected: c.execute("UPDATE private_media SET synced=-1 WHERE cache_key=?",(row["cache_key"],))
            else: c.execute("UPDATE private_media SET next_retry=? WHERE cache_key=?",(int(time.time())+10,row["cache_key"]))
        self.state = "idle" if acked else "pending"
        if acked: self.last_error_class = None

    async def run(self):
        next_cleanup = 0
        next_counts = 0
        while not self.reader._stop.is_set():
            try:
                if time.monotonic() >= next_cleanup:
                    await asyncio.to_thread(self.cleanup)
                    next_cleanup = time.monotonic()+60
                if self.enabled: await self.step()
                if time.monotonic() >= next_counts:
                    await asyncio.to_thread(self.refresh_counters)
                    next_counts = time.monotonic()+10
            except asyncio.CancelledError: raise
            except Exception as exc:
                # Exception messages may include private CDN URLs. Expose the class only.
                self.last_error_class = type(exc).__name__[:64]
                self.state = "error"
            try: await asyncio.wait_for(self.reader._stop.wait(),timeout=2)
            except asyncio.TimeoutError: pass
