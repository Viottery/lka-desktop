"""Synthetic-only checks for sanitized local UI segment labels."""
import json
import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.plugins.message_ui_content import enrich_authorized_rows, extract_ui_content_parts, sanitize_ui_content_parts
from app.plugins.qq_reader import QQReader, QQReaderConfig, normalize_event


def conversation_key(platform, account_id, conversation_type, conversation_id):
    identity = {"platform": platform, "account_id": account_id,
                "conversation_type": conversation_type, "conversation_id": conversation_id}
    encoded = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "message_conversation_" + hashlib.sha256(encoded).hexdigest()


class MessageUiContentTests(unittest.TestCase):
    def test_normalized_parts_are_bounded_sanitized_and_not_synced(self):
        event = {"post_type": "message", "message_type": "group", "self_id": "acct",
                 "message_id": "msg", "group_id": "group", "user_id": "sender",
                 "message": [
                     {"type": "text", "data": {"text": "hello"}},
                     {"type": "at", "data": {"qq": "1"}},
                     {"type": "reply", "data": {"id": "previous"}},
                     {"type": "image", "data": {"url": "https://private.example/image", "file": "image.png"}},
                     {"type": "image", "data": {"emoji_id": "emoji", "url": "https://private.example/sticker"}},
                     {"type": "face", "data": {"id": "14", "url": "https://private.example/face"}},
                     {"type": "file", "data": {"name": "../../secret.txt", "file": "safe.txt"}},
                     {"type": "mystery", "data": {"token": "private"}},
                 ]}
        normalized = normalize_event(event)
        self.assertEqual(normalized["ui_content_parts"], [
            {"ordinal": 3, "kind": "image"}, {"ordinal": 4, "kind": "sticker"},
            {"ordinal": 5, "kind": "face", "id": 14}, {"ordinal": 6, "kind": "file", "name": "safe.txt"},
            {"ordinal": 7, "kind": "unsupported"},
        ])
        self.assertNotIn("private.example", json.dumps(normalized["ui_content_parts"]))
        self.assertNotIn("token", json.dumps(normalized["ui_content_parts"]))
        generic = QQReader._generic_message(normalized)
        self.assertNotIn("ui_content_parts", generic)
        self.assertEqual(extract_ui_content_parts({"message": "a[CQ:video,file=clip.mp4][CQ:face,id=5]"}),
                         [{"ordinal": 1, "kind": "video"}, {"ordinal": 2, "kind": "face", "id": 5}])
        self.assertEqual(len(sanitize_ui_content_parts([{"ordinal": i, "kind": "sticker"} for i in range(150)])), 100)

    def test_proxy_enrichment_requires_exact_current_consent(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "reader.db"
            db = sqlite3.connect(db_path)
            db.executescript("""
                CREATE TABLE approved_policies(platform TEXT,account_id TEXT,conversation_type TEXT,conversation_id TEXT,revision INTEGER);
                CREATE TABLE approved_protocols(platform TEXT,account_id TEXT,conversation_type TEXT,conversation_id TEXT,capture_epoch INTEGER,minimum_import_version INTEGER);
                CREATE TABLE message_outbox(platform TEXT,account_id TEXT,message_id TEXT,conversation_type TEXT,conversation_id TEXT,payload TEXT,policy_revision INTEGER,schema_version INTEGER,capture_epoch INTEGER,quarantined INTEGER,synced INTEGER);
            """)
            db.execute("INSERT INTO approved_policies VALUES('qq','acct','group','group-1',7)")
            db.execute("INSERT INTO approved_protocols VALUES('qq','acct','group','group-1',9,2)")
            parts = [{"ordinal": 1, "kind": "image", "url": "https://private.invalid"},
                     {"ordinal": 2, "kind": "face", "id": 8, "token": "secret"}]
            payload = json.dumps({"ui_content_parts": parts})
            rows = [
                ("qq", "acct", "m1", "group", "group-1", payload, 7, 2, 9, 0, 1),
                ("qq", "acct", "m2", "group", "group-1", payload, 6, 2, 9, 0, 1), # stale revision
                ("qq", "acct", "m3", "group", "group-1", payload, 7, 2, 8, 0, 1), # stale epoch
                ("qq", "acct", "m4", "group", "group-1", payload, 7, 2, 9, 1, 1), # quarantined
                ("qq", "acct", "m5", "private", "group-1", payload, 7, 2, 9, 0, 1), # wrong conversation
            ]
            db.executemany("INSERT INTO message_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
            db.commit()
            db.close()

            key = conversation_key("qq", "acct", "group", "group-1")
            def row(message_id, conversation_type=None, conversation_id=None, group_key=key):
                result = {"platform": "qq", "account_id": "acct", "conversation_key": group_key,
                          "provider_message_id": message_id, "text": "authorized"}
                if conversation_type is not None:
                    result["conversation_type"] = conversation_type
                if conversation_id is not None:
                    result["conversation_id"] = conversation_id
                return result
            response = {"history": {"messages": [row("m1"), row("m2"), row("m3"), row("m4"), row("m5"),
                                                   row("m1", group_key="message_conversation_wrong")]}}
            result = enrich_authorized_rows(response, db_path)
            self.assertEqual(result["history"]["messages"][0]["ui_content_parts"],
                             [{"ordinal": 1, "kind": "image"}, {"ordinal": 2, "kind": "face", "id": 8}])
            for item in result["history"]["messages"][1:]:
                self.assertNotIn("ui_content_parts", item)
            self.assertNotIn("private.invalid", json.dumps(result))
            self.assertNotIn("token", json.dumps(result))

    def test_missing_database_is_never_created(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.db"
            result = enrich_authorized_rows({"record": {}}, path)
            self.assertEqual(result, {"record": {}})
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
