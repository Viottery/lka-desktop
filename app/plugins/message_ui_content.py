"""Sanitized, local-only QQ segment labels for the desktop UI."""
from __future__ import annotations

import re
import json
import hashlib
import sqlite3
from typing import Any
from pathlib import Path

_KINDS = {
    "image": "image", "video": "video", "sticker": "sticker", "face": "face",
    "custom_face": "custom_face", "mface": "mface", "record": "record", "file": "file",
    "forward": "forward", "node": "forward", "json": "json", "xml": "xml",
    "music": "music", "poke": "poke",
}
_CQ_SEGMENT = re.compile(r"\[CQ:([A-Za-z0-9_]+)(?:,([^\]]*))?\]", re.IGNORECASE)
_CQ_PAIR = re.compile(r"(?:^|,)([A-Za-z0-9_]+)=((?:&#44;|&#91;|&#93;|&amp;|[^,])*)", re.IGNORECASE)
_SAFE_NAME = re.compile(r"[^\x00-\x1f\x7f/\\:]{1,255}\Z")


def _safe_file_name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip()
    if not candidate or candidate in {".", ".."} or not _SAFE_NAME.fullmatch(candidate):
        return None
    if candidate.lower().startswith(("http:", "https:")):
        return None
    return candidate


def _part(ordinal: int, kind: str, data: Any) -> dict[str, Any]:
    result: dict[str, Any] = {"ordinal": ordinal, "kind": kind}
    if kind == "face" and isinstance(data, dict):
        face_id = data.get("id")
        if isinstance(face_id, int) and not isinstance(face_id, bool) and face_id >= 0:
            result["id"] = face_id
        elif isinstance(face_id, str) and face_id.isdigit() and len(face_id) <= 10:
            result["id"] = int(face_id)
    if kind == "file" and isinstance(data, dict):
        safe_name = _safe_file_name(data.get("name")) or _safe_file_name(data.get("file"))
        if safe_name:
            result["name"] = safe_name
    return result


def _segment_kind(raw_kind: str, data: Any) -> str:
    lowered = raw_kind.lower()
    if lowered == "image" and isinstance(data, dict):
        if (str(data.get("sub_type", "")) == "1"
                or any(data.get(key) for key in ("emoji_id", "emoji_package_id", "package_id", "key"))
                or (isinstance(data.get("summary"), str) and "表情" in data["summary"])):
            return "sticker"
    return _KINDS.get(lowered, "unsupported")


def _from_segments(segments: Any) -> list[dict[str, Any]]:
    if not isinstance(segments, list):
        return []
    parts = []
    for ordinal, segment in enumerate(segments):
        if not isinstance(segment, dict):
            continue
        raw_kind = segment.get("type")
        if not isinstance(raw_kind, str) or raw_kind.lower() == "text":
            continue
        if raw_kind.lower() in {"at", "reply"}:
            continue
        data = segment.get("data") if isinstance(segment.get("data"), dict) else {}
        kind = _segment_kind(raw_kind, data)
        parts.append(_part(ordinal, kind, data))
        if len(parts) >= 100:
            break
    return parts


def _from_cq(value: str) -> list[dict[str, Any]]:
    parts = []
    ordinal = 0
    cursor = 0
    for match in _CQ_SEGMENT.finditer(value):
        if value[cursor:match.start()].strip():
            ordinal += 1
        data: dict[str, str] = {}
        for pair in _CQ_PAIR.finditer(match.group(2) or ""):
            raw = pair.group(2)
            # CQ escaping is decoded only for the small allowlisted fields below.
            data[pair.group(1).lower()] = (raw.replace("&#44;", ",").replace("&#91;", "[")
                .replace("&#93;", "]").replace("&amp;", "&"))
        if match.group(1).lower() in {"at", "reply"}:
            ordinal += 1
            cursor = match.end()
            continue
        kind = _segment_kind(match.group(1), data)
        parts.append(_part(ordinal, kind, data))
        ordinal += 1
        cursor = match.end()
        if len(parts) >= 100:
            break
    return parts


def extract_ui_content_parts(event: dict[str, Any]) -> list[dict[str, Any]]:
    """Return display labels only; never retain URLs, paths, or raw OneBot data."""
    message = event.get("message", event.get("raw_message"))
    if isinstance(message, list):
        return _from_segments(message)
    if isinstance(message, str):
        return _from_cq(message)
    return []


def sanitize_ui_content_parts(value: Any) -> list[dict[str, Any]]:
    """Revalidate local payload metadata before it is added to backend rows."""
    if not isinstance(value, list):
        return []
    output = []
    for item in value[:100]:
        if not isinstance(item, dict):
            continue
        ordinal = item.get("ordinal")
        kind = item.get("kind")
        if type(ordinal) is not int or ordinal < 0 or not isinstance(kind, str):
            continue
        if kind not in {*_KINDS.values(), "unsupported"}:
            continue
        result = {"ordinal": ordinal, "kind": kind}
        face_id = item.get("id")
        if kind == "face" and type(face_id) is int and 0 <= face_id <= 2**31 - 1:
            result["id"] = face_id
        name = _safe_file_name(item.get("name"))
        if kind == "file" and name:
            result["name"] = name
        output.append(result)
    return output


_ROW_CONTAINERS = frozenset({
    "messages", "sources", "history", "context", "search", "records", "record",
    "results", "items",
})
_IDENTITY_FIELDS = (
    "platform", "account_id", "conversation_type", "conversation_id", "provider_message_id",
)


def _conversation_key(identity: dict[str, str]) -> str:
    encoded = json.dumps({key: identity[key] for key in ("platform", "account_id", "conversation_type", "conversation_id")},
                         ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "message_conversation_" + hashlib.sha256(encoded).hexdigest()


def enrich_authorized_rows(response: Any, db_path: str | Path | None) -> Any:
    """Add display-only segment kinds to backend-authorized rows, when local consent still matches."""
    if not isinstance(response, (dict, list)) or not db_path:
        return response
    path = Path(db_path)
    if not path.is_file():
        return response
    try:
        uri = path.resolve().as_uri() + "?mode=ro"
        db = sqlite3.connect(uri, uri=True, timeout=0.2)
        db.row_factory = sqlite3.Row
    except (OSError, sqlite3.Error, ValueError):
        return response

    visited = 0
    matched_rows = 0
    try:
        def visit(value: Any, depth: int = 0) -> None:
            nonlocal visited, matched_rows
            if visited >= 1200 or depth > 8:
                return
            visited += 1
            if isinstance(value, dict):
                platform, account_id, conversation_type, conversation_id, provider_id = (value.get(field) for field in _IDENTITY_FIELDS)
                valid_base = all(isinstance(part, str) and 0 < len(part) <= 256
                                 for part in (platform, account_id, provider_id))
                full_conversation = (isinstance(conversation_type, str) and 0 < len(conversation_type) <= 256
                                     and isinstance(conversation_id, str) and 0 < len(conversation_id) <= 256)
                conversation_key = value.get("conversation_key")
                has_key = isinstance(conversation_key, str) and len(conversation_key) <= 160
                if valid_base and (full_conversation or has_key):
                    matched_rows += 1
                    if matched_rows <= 500:
                        try:
                            query = """SELECT m.payload,m.platform,m.account_id,m.conversation_type,m.conversation_id FROM message_outbox m
                                   JOIN approved_policies p USING(platform,account_id,conversation_type,conversation_id)
                                   LEFT JOIN approved_protocols v USING(platform,account_id,conversation_type,conversation_id)
                                   WHERE m.platform=? AND m.account_id=? AND m.message_id=?
                                     AND p.revision=m.policy_revision AND m.quarantined=0 AND m.synced=1
                                     AND ((m.schema_version=1 AND COALESCE(v.minimum_import_version,1)=1)
                                       OR (m.schema_version=2 AND m.capture_epoch=v.capture_epoch))
                                   """
                            params: tuple[Any, ...] = (platform, account_id, provider_id)
                            if full_conversation:
                                query += " AND m.conversation_type=? AND m.conversation_id=?"
                                params += (conversation_type, conversation_id)
                            query += " LIMIT 1"
                            local = db.execute(query, params).fetchone()
                            if local:
                                local_identity = {key: local[key] for key in ("platform", "account_id", "conversation_type", "conversation_id")}
                                identity_matches = ((conversation_type is None or conversation_type == local["conversation_type"])
                                                    and (conversation_id is None or conversation_id == local["conversation_id"]))
                                key_matches = full_conversation or conversation_key == _conversation_key(local_identity)
                                if identity_matches and key_matches:
                                    stored = json.loads(local["payload"])
                                    safe_parts = sanitize_ui_content_parts(stored.get("ui_content_parts") if isinstance(stored, dict) else None)
                                    if safe_parts:
                                        value["ui_content_parts"] = safe_parts
                        except (sqlite3.Error, ValueError, TypeError, AttributeError):
                            pass
                for key in _ROW_CONTAINERS:
                    child = value.get(key)
                    if isinstance(child, (dict, list)):
                        visit(child, depth + 1)
            elif isinstance(value, list):
                for child in value[:500]:
                    if isinstance(child, (dict, list)):
                        visit(child, depth + 1)

        visit(response)
    finally:
        db.close()
    return response
