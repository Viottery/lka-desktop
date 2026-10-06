"""Read-only display-name enrichment from the locally approved QQ outbox."""
from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

from app.plugins.message_ui_content import _conversation_key

_KEY_PREFIX = "message_conversation_"
_NAME_CONTROLS = re.compile(r"[\x00-\x1f\x7f]")
_MAX_ROWS = 500
_MAX_POLICIES = 20000


def _name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 256 or _NAME_CONTROLS.search(value):
        return None
    return value


def _rows(response: Any):
    """Yield only participant/dossier rows from known backend containers."""
    if not isinstance(response, dict):
        return
    for key in ("participants", "dossiers"):
        rows = response.get(key)
        if isinstance(rows, list):
            for row in rows[:_MAX_ROWS]:
                if isinstance(row, dict):
                    yield row
    # Detail endpoints return one person/dossier as the response object.
    if "sender_id" in response and "conversation_key" in response:
        yield response


def enrich_participant_names(response: Any, db_path: str | Path | None) -> Any:
    """Add a local sender_name only to backend-authorized rows with a matching conversation key.

    SQLite is opened read-only. Only the currently approved policy revision and protocol epoch,
    synchronized non-quarantined outbox rows are eligible. The query returns names only.
    """
    if not isinstance(response, dict) or not db_path:
        return response
    people: dict[str, set[str]] = {}
    for row in _rows(response):
        if _name(row.get("sender_name")):
            continue
        key, sender_id = row.get("conversation_key"), _name(row.get("sender_id"))
        if isinstance(key, str) and key.startswith(_KEY_PREFIX) and len(key) == len(_KEY_PREFIX) + 64 and sender_id:
            people.setdefault(key, set()).add(sender_id)
    if not people:
        return response

    path = Path(db_path)
    if not path.is_file():
        return response
    db = None
    try:
        db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=0.2)
        db.row_factory = sqlite3.Row
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"approved_policies", "approved_protocols", "message_outbox"}.issubset(tables):
            return response
        policies = db.execute("""SELECT platform,account_id,conversation_type,conversation_id,revision
            FROM approved_policies LIMIT ?""", (_MAX_POLICIES + 1,)).fetchall()
        if len(policies) > _MAX_POLICIES:
            return response

        targets: dict[tuple[str, str, str, str, int], set[str]] = {}
        for policy in policies:
            identity = tuple(policy[k] for k in ("platform", "account_id", "conversation_type", "conversation_id"))
            if any(not isinstance(item, str) or not item for item in identity):
                continue
            key = _conversation_key(dict(zip(("platform", "account_id", "conversation_type", "conversation_id"), identity)))
            if key in people:
                targets[(*identity, int(policy["revision"]))] = people[key]

        name_map: dict[tuple[str, str], str] = {}
        for identity_revision, senders in targets.items():
            platform, account, conv_type, conv_id, revision = identity_revision
            ordered_senders = sorted(senders)
            for start in range(0, len(ordered_senders), 400):
                batch = ordered_senders[start:start + 400]
                placeholders = ",".join("?" for _ in batch)
                query = f"""WITH names AS (
                    SELECT json_extract(m.payload,'$.sender_id') AS sender_id,
                           NULLIF(trim(json_extract(m.payload,'$.sender_name')),'') AS sender_name,
                           ROW_NUMBER() OVER (PARTITION BY json_extract(m.payload,'$.sender_id') ORDER BY m.rowid DESC) AS rn
                    FROM message_outbox m
                    JOIN approved_policies p USING(platform,account_id,conversation_type,conversation_id)
                    LEFT JOIN approved_protocols v USING(platform,account_id,conversation_type,conversation_id)
                    WHERE m.platform=? AND m.account_id=? AND m.conversation_type=? AND m.conversation_id=?
                      AND p.revision=? AND m.policy_revision=p.revision
                      AND m.quarantined=0 AND m.synced=1 AND json_valid(m.payload)
                      AND json_extract(m.payload,'$.sender_id') IN ({placeholders})
                      AND ((m.schema_version=1 AND COALESCE(v.minimum_import_version,1)=1)
                        OR (m.schema_version=2 AND m.capture_epoch=v.capture_epoch))
                      AND NULLIF(trim(json_extract(m.payload,'$.sender_name')),'') IS NOT NULL
                ) SELECT sender_id,sender_name FROM names WHERE rn=1"""
                try:
                    for match in db.execute(query, (platform, account, conv_type, conv_id, revision, *batch)):
                        sender_id = _name(match["sender_id"])
                        sender_name = _name(match["sender_name"])
                        if sender_id and sender_name:
                            conv_key = _conversation_key({"platform": platform, "account_id": account,
                                                          "conversation_type": conv_type, "conversation_id": conv_id})
                            name_map[(conv_key, sender_id)] = sender_name
                except sqlite3.Error:
                    # Older SQLite without JSON/window support simply keeps the backend fallback.
                    return response

        for row in _rows(response):
            if _name(row.get("sender_name")):
                continue
            key, sender_id = row.get("conversation_key"), _name(row.get("sender_id"))
            if sender_id and isinstance(key, str):
                cached = name_map.get((key, sender_id))
                if cached:
                    row["sender_name"] = cached
    except (OSError, sqlite3.Error, ValueError, TypeError, OverflowError):
        return response
    finally:
        if db is not None:
            db.close()
    return response
