"""Synthetic checks for approved local QQ participant names."""
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from app.plugins.message_ui_content import _conversation_key
from app.plugins.message_people import enrich_participant_names


class MessagePeopleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "reader.db"
        with closing(sqlite3.connect(self.path)) as db, db:
            db.executescript("""
                CREATE TABLE approved_policies(platform TEXT,account_id TEXT,conversation_type TEXT,conversation_id TEXT,revision INTEGER);
                CREATE TABLE approved_protocols(platform TEXT,account_id TEXT,conversation_type TEXT,conversation_id TEXT,capture_epoch INTEGER,minimum_import_version INTEGER);
                CREATE TABLE message_outbox(platform TEXT,account_id TEXT,message_id TEXT,conversation_type TEXT,conversation_id TEXT,payload TEXT,policy_revision INTEGER,schema_version INTEGER,capture_epoch INTEGER,quarantined INTEGER,synced INTEGER);
            """)
            db.execute("INSERT INTO approved_policies VALUES('qq','acct','group','g1',4)")
            db.execute("INSERT INTO approved_protocols VALUES('qq','acct','group','g1',7,2)")

    def outbox(self, message_id, sender_id, sender_name, *, account="acct", conv="g1", revision=4,
               epoch=7, quarantined=0, synced=1):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("INSERT INTO message_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
                "qq", account, message_id, "group", conv,
                json.dumps({"sender_id": sender_id, "sender_name": sender_name,
                            "text": "private message body must not be returned"}),
                revision, 2, epoch, quarantined, synced))

    def key(self):
        return _conversation_key({"platform": "qq", "account_id": "acct",
                                 "conversation_type": "group", "conversation_id": "g1"})

    def test_backend_key_id_shape_gets_latest_nickname_and_group_card(self):
        self.outbox("old", "100", "旧昵称")
        self.outbox("new", "100", "群名片甲")
        response = {"participants": [{"conversation_key": self.key(), "sender_id": "100", "summary": "backend"}]}
        enrich_participant_names(response, self.path)
        self.assertEqual(response["participants"][0]["sender_name"], "群名片甲")
        self.assertNotIn("text", response["participants"][0])
        self.assertNotIn("private message body", json.dumps(response))

    def test_existing_name_and_wrong_identity_are_never_overwritten(self):
        self.outbox("m1", "100", "本地昵称")
        response = {"dossiers": [
            {"conversation_key": self.key(), "sender_id": "100", "sender_name": "后端权威名"},
            {"conversation_key": self.key(), "sender_id": "999"},
            {"conversation_key": "message_conversation_wrong", "sender_id": "100"},
        ]}
        enrich_participant_names(response, self.path)
        self.assertEqual(response["dossiers"][0]["sender_name"], "后端权威名")
        self.assertNotIn("sender_name", response["dossiers"][1])
        self.assertNotIn("sender_name", response["dossiers"][2])

    def test_revoked_stale_quarantined_unsynced_and_wrong_epoch_are_ignored(self):
        for args in (("stale_revision", "1", "错修订", {"revision": 3}),
                     ("quarantine", "2", "隔离名", {"quarantined": 1}),
                     ("unsynced", "3", "未同步名", {"synced": 0}),
                     ("old_epoch", "4", "旧epoch名", {"epoch": 6})):
            self.outbox(*args[:3], **args[3])
        response = {"participants": [{"conversation_key": self.key(), "sender_id": str(i)} for i in range(1, 5)]}
        enrich_participant_names(response, self.path)
        self.assertTrue(all("sender_name" not in row for row in response["participants"]))
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("DELETE FROM approved_policies")
        response = {"participants": [{"conversation_key": self.key(), "sender_id": "1"}]}
        enrich_participant_names(response, self.path)
        self.assertNotIn("sender_name", response["participants"][0])

    def test_missing_database_is_not_created(self):
        missing = Path(self.temp.name) / "missing.db"
        response = {"participants": [{"conversation_key": self.key(), "sender_id": "100"}]}
        enrich_participant_names(response, missing)
        self.assertFalse(missing.exists())
        self.assertNotIn("sender_name", response["participants"][0])


if __name__ == "__main__":
    unittest.main()
