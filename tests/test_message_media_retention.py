"""Synthetic local cache fixtures only; no transport, services, or LLM calls."""
import asyncio
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from app.plugins.message_media import cache_key, generated_path
from app.plugins.qq_reader import QQReader, QQReaderConfig, normalize_event


class LegacyMediaRetentionTests(unittest.TestCase):
    identity = ("qq", "synthetic-account", "group", "synthetic-group")

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.reader = QQReader(QQReaderConfig(db_path=str(Path(self.folder.name) / "reader.db")))
        self.reader._initialize_db()
        self.reader._media.enabled = True
        self.reader._media.directory = str(Path(self.folder.name) / "media")
        self.policy(1, 1)

    def policy(self, revision, minimum, epoch=1, media=True, record=True):
        key = self.identity
        self.reader._replace_policies([(*key, revision)] if record else [],
            [(*key, revision, int(media))] if record else [],
            [(*key, epoch, minimum)] if record else [])

    def fixture(self, state="cached", media_synced=1, parent_synced=1):
        message = normalize_event({"post_type": "message", "message_type": "group",
            "self_id": self.identity[1], "group_id": self.identity[3], "message_id": "synthetic-message",
            "user_id": "synthetic-sender", "message": []})
        self.reader._store(message, "", [{"ordinal": 0, "kind": "image", "url": None}])
        key = cache_key(self.identity[0], self.identity[1], message["message_id"], 0)
        path = generated_path(self.reader._media.directory, key)
        path.write_bytes(b"synthetic-local-bytes")
        with self.reader._connect_db() as conn:
            conn.execute("UPDATE message_outbox SET synced=?", (parent_synced,))
            conn.execute("UPDATE private_media SET state=?,synced=?,metadata=?", (state, media_synced,
                json.dumps({"size_bytes": path.stat().st_size})))
        return path

    def row(self):
        with self.reader._connect_db() as conn:
            row = conn.execute("SELECT * FROM private_media").fetchone()
            return dict(row) if row else None

    def test_upgrade_keeps_acknowledged_bytes_without_import_grant(self):
        path = self.fixture()
        self.policy(2, 2)
        self.reader._media.cleanup()
        self.assertTrue(path.exists())
        row = self.row()
        self.assertIsNone(row["capture_epoch"])
        self.assertEqual(row["synced"], 1)
        with self.reader._connect_db() as conn:
            self.assertFalse(self.reader._media.allowed(conn, row))
            self.assertTrue(self.reader._media.cache_allowed(conn, row))
            self.assertEqual(json.loads(conn.execute("SELECT payload FROM message_outbox").fetchone()[0])["schema_version"], 1)
        self.assertFalse(self.reader._media.permitted(row))
        self.assertIsNone(self.reader._media.next_job())
        async def forbidden(_payload):
            self.fail("legacy cache must never upload")
        self.reader._post_media = forbidden
        async def inline_thread(function, *args, **kwargs):
            return function(*args, **kwargs)
        # The only offloaded work is synthetic SQLite selection; avoid sandbox
        # event-loop thread wakeups while still executing the actual worker.
        with patch("asyncio.to_thread", side_effect=inline_thread):
            asyncio.run(self.reader._media.step())
        self.policy(3, 2)
        self.reader._media.cleanup()
        self.assertTrue(path.exists())
        restart = QQReader(self.reader.config)
        restart._initialize_db()
        restart._media.directory = self.reader._media.directory
        restart._media.cleanup()
        self.assertTrue(path.exists())

    def test_unsynced_or_pending_v1_does_not_get_cache_grant(self):
        for state, media_synced, parent_synced in [("cached", 0, 1), ("cached", 1, 0), ("pending", 1, 1)]:
            with self.subTest(state=state, media_synced=media_synced, parent_synced=parent_synced):
                path = self.fixture(state, media_synced, parent_synced)
                self.policy(2, 2)
                self.reader._media.cleanup()
                self.assertFalse(path.exists())
                self.assertIsNone(self.row())
                self.assertEqual(self.reader._get_batch(), [])
                with self.reader._connect_db() as conn:
                    conn.execute("DELETE FROM message_outbox")
                self.policy(1, 1)

    def test_epoch_change_revokes_before_cleanup_and_cannot_restore(self):
        path = self.fixture()
        self.policy(2, 2)
        self.policy(3, 2, epoch=2)
        self.policy(4, 2, epoch=1)
        self.reader._media.cleanup()
        self.assertFalse(path.exists())
        self.assertIsNone(self.row())

    def test_missing_old_protocol_never_guesses_epoch(self):
        path = self.fixture()
        with self.reader._connect_db() as conn:
            conn.execute("DELETE FROM approved_protocols")
        self.policy(2, 2)
        self.reader._media.cleanup()
        self.assertFalse(path.exists())
        self.assertIsNone(self.row())

    def test_changed_epoch_during_upgrade_does_not_grant(self):
        path = self.fixture()
        self.policy(2, 2, epoch=2)
        self.reader._media.cleanup()
        self.assertFalse(path.exists())
        self.assertIsNone(self.row())

    def test_media_revoked_during_upgrade_does_not_grant(self):
        path = self.fixture()
        self.policy(2, 2, media=False)
        self.policy(3, 2)
        self.reader._media.cleanup()
        self.assertFalse(path.exists())
        self.assertIsNone(self.row())

    def test_media_off_then_on_cannot_restore(self):
        path = self.fixture()
        self.policy(2, 2)
        self.policy(3, 2, media=False)
        self.policy(4, 2)
        self.reader._media.cleanup()
        self.assertFalse(path.exists())
        self.assertIsNone(self.row())

    def test_record_off_then_on_cannot_restore(self):
        path = self.fixture()
        self.policy(2, 2)
        self.policy(3, 2, record=False)
        self.policy(4, 2)
        self.reader._media.cleanup()
        self.assertFalse(path.exists())
        self.assertIsNone(self.row())

    def test_ttl_expires_bytes_without_requeue(self):
        path = self.fixture()
        self.policy(2, 2)
        with self.reader._connect_db() as conn:
            conn.execute("UPDATE private_media SET expires_at=?", (int(time.time()) - 1,))
        self.reader._media.cleanup()
        self.assertFalse(path.exists())
        self.assertEqual(self.row()["state"], "expired")
        self.assertEqual(self.row()["synced"], 1)
        self.reader._media.cleanup()
        self.assertEqual(self.row()["state"], "expired")
        self.assertIsNone(self.reader._media.next_job())

    def test_quota_eviction_does_not_requeue(self):
        path = self.fixture()
        self.policy(2, 2)
        self.reader._media.quota = 1
        self.reader._media.reserve(1)
        self.assertFalse(path.exists())
        self.assertEqual(self.row()["state"], "expired")
        self.assertEqual(self.row()["synced"], 1)
        self.assertIsNone(self.reader._media.next_job())


if __name__ == "__main__":
    unittest.main()
