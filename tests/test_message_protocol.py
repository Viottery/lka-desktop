import asyncio
import json
from pathlib import Path
import tempfile
import unittest

from app.plugins.message_sources import MockMessageSource
from app.plugins.qq_reader import QQReader, QQReaderConfig, normalize_event


def event(message_id="one", message=None):
    return {"post_type": "message", "message_type": "group", "self_id": "acct",
            "message_id": message_id, "user_id": "sender", "group_id": "group",
            "message": message if message is not None else [{"type": "text", "data": {"text": "hello"}}]}


class MessageProtocolTests(unittest.TestCase):
    def policies(self, reader, revision=1, epoch=1, minimum=2):
        key = ("qq", "acct", "group", "group")
        reader._replace_policies([(*key, revision)], [(*key, revision, 1)], [(*key, epoch, minimum)])

    def reader(self, folder):
        reader = QQReader(QQReaderConfig(db_path=str(Path(folder) / "reader.db")))
        reader._initialize_db()
        return reader

    def test_native_metadata_is_ordered_and_raw_text_is_unknown(self):
        native = normalize_event(event(message=[{"type": "at", "data": {"qq": "acct"}},
            {"type": "at", "data": {"qq": "all"}}, {"type": "reply", "data": {"id": "missing"}},
            {"type": "text", "data": {"text": "@nickname"}}]), schema_version=2, capture_epoch=3)
        self.assertEqual(native["mentions"], [{"kind": "user", "user_id": "acct"}, {"kind": "all"}])
        self.assertEqual(native["reply_to_message_id"], "missing")
        self.assertEqual([p["kind"] for p in native["content_parts"]], ["mention", "mention", "reply", "text"])
        self.assertEqual(native["metadata_capabilities"]["mentions"], "supported")
        raw = normalize_event(event(message="@acct [CQ:at,qq=acct]"), schema_version=2, capture_epoch=3)
        self.assertEqual(raw["mentions"], [])
        self.assertEqual(raw["metadata_capabilities"]["mentions"], "unknown")
        self.assertEqual(raw["content_parts"], [])
        self.assertEqual(normalize_event(event())["schema_version"], 1)
        with self.assertRaisesRegex(ValueError, "metadata_too_large"):
            normalize_event(event(message=[{"type": "at", "data": {"qq": "acct"}}] * 101), schema_version=2, capture_epoch=3)

    def test_upgrade_quarantines_legacy_without_relabeling_and_survives_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            reader = self.reader(folder)
            self.policies(reader, minimum=1)
            self.assertTrue(reader._store(normalize_event(event("legacy")), ""))
            self.assertEqual(reader._normalize_qq_event(event())["schema_version"], 1)
            self.policies(reader, revision=2, epoch=2)
            self.assertEqual(reader._get_batch(), [])
            self.assertIsNone(reader._store(normalize_event(event("late-v1")), ""))
            with reader._connect_db() as c:
                old = c.execute("SELECT capture_epoch,quarantined,payload FROM message_outbox").fetchone()
                self.assertIsNone(old[0])
                self.assertEqual(old[1], 1)
                self.assertEqual(json.loads(old[2])["schema_version"], 1)
            self.assertTrue(reader._store(reader._normalize_qq_event(event("new")), ""))
            restart = self.reader(folder)
            restart._load_cached_policies()
            self.assertEqual(restart._get_batch()[0]["capture_epoch"], 2)
            self.assertEqual(restart._normalize_qq_event(event("next"))["schema_version"], 2)

    def test_schedule_revision_preserves_v2_but_epoch_revocation_is_permanent(self):
        with tempfile.TemporaryDirectory() as folder:
            reader = self.reader(folder)
            self.policies(reader)
            msg = reader._normalize_qq_event(event())
            reader._store(msg, "")
            self.policies(reader, revision=9)
            self.assertEqual(reader._count_pending(), 1)
            self.assertEqual(reader._get_batch()[0]["capture_epoch"], 1)
            self.policies(reader, revision=10, epoch=2)
            self.assertEqual(reader._get_batch(), [])
            self.assertIsNone(reader._store(dict(msg, message_id="late"), ""))
            self.policies(reader, revision=11, epoch=1)
            self.assertEqual(reader._get_batch(), [])

    def test_v2_media_uses_capture_epoch_for_schedule_changes_and_revoke(self):
        with tempfile.TemporaryDirectory() as folder:
            reader = self.reader(folder)
            reader._media.enabled = True
            reader._media.directory = str(Path(folder) / "media")
            self.policies(reader)
            msg = reader._normalize_qq_event(event())
            reader._store(msg, "", [{"ordinal": 0, "kind": "image", "url": None}])
            reader._mark_synced([("qq", "acct", "one")])
            self.policies(reader, revision=2)
            row = reader._media.next_job()
            self.assertEqual(row["capture_epoch"], 1)
            reader._media.cleanup()
            self.assertIsNotNone(reader._media.next_job())
            sent = []
            async def post(payload):
                sent.append(payload)
                return {"acknowledged": [{"platform": "qq", "account_id": "acct", "message_id": "one", "ordinal": 0}]}
            reader._post_media = post
            asyncio.run(reader._media.step())
            self.assertEqual(sent[0]["schema_version"], 2)
            self.assertEqual(sent[0]["media"][0]["capture_epoch"], 1)
            self.policies(reader, revision=3, epoch=2)
            with reader._connect_db() as c:
                self.assertFalse(reader._media.allowed(c, row))

    def test_mixed_batches_preserve_versions_and_mock_accepts_v2(self):
        with tempfile.TemporaryDirectory() as folder:
            reader = self.reader(folder)
            self.policies(reader, minimum=1)
            legacy = normalize_event(event("legacy"))
            current = normalize_event(event("native"), schema_version=2, capture_epoch=1)
            reader._store(legacy, "")
            reader._store(current, "")
            self.assertEqual([m["schema_version"] for m in reader._get_batch()], [1])
            reader._mark_synced([("qq", "acct", "legacy")])
            self.assertEqual([m["schema_version"] for m in reader._get_batch()], [2])
            self.assertEqual(MockMessageSource().normalize(current), current)
            self.assertEqual(QQReader._generic_message(current)["metadata_capabilities"]["reply"], "supported")


if __name__ == "__main__":
    unittest.main()
