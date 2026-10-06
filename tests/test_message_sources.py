import asyncio
import tempfile
import unittest
from pathlib import Path

from app.plugins.message_sources import MockMessageSource
from app.plugins.qq_reader import MAX_PENDING_OUTBOX, OutboxFull, QQReader, QQReaderConfig, normalize_event


class PolicyResponse:
    status_code = 200
    def json(self):
        return {"policies": []}


class PolicyHTTP:
    async def get(self, url, **kwargs):
        self.url, self.kwargs = url, kwargs
        return PolicyResponse()


class RejectOneHTTP:
    async def post(self, url, **kwargs):
        return PolicyResponseWithResult({"acknowledged":[{"platform":"qq","account_id":"acct","message_id":"good"}],
            "rejected":[{"platform":"qq","account_id":"acct","message_id":"poison","reason":"invalid","permanent":True}]})


class PolicyResponseWithResult:
    status_code = 200
    def __init__(self, data): self.data = data
    def json(self): return self.data


class MessageSourceTests(unittest.TestCase):
    def test_mock_source_uses_normalized_iterator_contract(self):
        async def run():
            source = MockMessageSource([{"schema_version": 1, "message_id": "synthetic-1"}, "bad"])
            await source.connect()
            values = [value async for value in source.receive()]
            normalized = [source.normalize(value) for value in values]
            state = source.status()
            await source.stop()
            return normalized, state, source.status()
        values, state, stopped = asyncio.run(run())
        self.assertEqual(values, [{"schema_version": 1, "message_id": "synthetic-1"}, None])
        self.assertTrue(state["connected"])
        self.assertFalse(stopped["connected"])

    def test_storage_fails_closed_and_revocation_stops_pending_send(self):
        async def run(db):
            http = PolicyHTTP()
            reader = QQReader(QQReaderConfig(enabled=True, sync_url="http://127.0.0.1/integrations/messages/import",
                                             sync_token="import-only", db_path=str(db)), http_transport=http)
            reader._initialize_db()
            msg = normalize_event({"post_type":"message", "message_type":"private", "self_id":"acct",
                "message_id":"synthetic-1", "user_id":"peer", "message":"synthetic body", "time":"invalid"})
            denied = reader._store(msg, "raw")
            reader._policies.add(("qq", "acct", "private", "peer"))
            with reader._connect_db() as c:
                c.execute("INSERT INTO approved_policies VALUES('qq','acct','private','peer',1)")
            inserted = reader._store(msg, "raw")
            pending_before = reader._get_batch()
            await reader._refresh_policies()
            pending_after = reader._get_batch()
            return reader, msg, denied, inserted, pending_before, pending_after, http
        with tempfile.TemporaryDirectory() as folder:
            reader, msg, denied, inserted, before, after, http = asyncio.run(run(Path(folder) / "messages.db"))
        self.assertFalse(denied)
        self.assertTrue(inserted)
        self.assertEqual(len(before), 1)
        self.assertEqual(after, [])
        self.assertIsNone(msg["sent_at"])
        self.assertEqual(msg["received_at"].__class__, int)
        self.assertEqual(http.url, "http://127.0.0.1/integrations/messages/policies")
        self.assertEqual(http.kwargs["headers"], {"Authorization": "Bearer import-only"})

    def test_mock_normalized_event_uses_same_accept_path_as_qq(self):
        async def run(db):
            reader = QQReader(QQReaderConfig(db_path=str(db)))
            reader._initialize_db()
            with reader._connect_db() as c:
                c.execute("INSERT INTO approved_policies VALUES('qq','acct','private','peer',1)")
            msg = {"schema_version":1,"platform":"qq","account_id":"acct","self_id":"acct",
                "message_id":"synthetic-mock-1","conversation_type":"private","conversation_id":"peer",
                "sender_id":"peer","sender_name":"Synthetic","text":"mock body","sent_at":123,
                "received_at":124,"content_kind":"text"}
            source = MockMessageSource([msg])
            await reader._consume_source(source)
            return reader.status()
        with tempfile.TemporaryDirectory() as folder:
            state = asyncio.run(run(Path(folder) / "mock.db"))
        self.assertEqual(state["counters"]["stored"], 1)

    def test_revision_change_isolates_old_outbox_and_legacy_table_is_untouched(self):
        async def run(db):
            import sqlite3
            conn = sqlite3.connect(db)
            conn.execute("CREATE TABLE messages (self_id TEXT, message_id TEXT, payload TEXT)")
            conn.execute("INSERT INTO messages VALUES('legacy','old','synthetic')")
            conn.commit(); conn.close()
            reader = QQReader(QQReaderConfig(db_path=str(db)))
            reader._initialize_db()
            revisions = [("qq", "acct", "private", "peer", 1)]
            reader._replace_policies(revisions)
            msg = normalize_event({"post_type":"message", "message_type":"private", "self_id":"acct",
                "message_id":"queued", "user_id":"peer", "message":"synthetic", "time":123})
            stored = reader._store(msg, "")
            reader._replace_policies([("qq", "acct", "private", "peer", 2)])
            batch = reader._get_batch()
            with reader._connect_db() as c:
                legacy = c.execute("SELECT payload FROM messages WHERE self_id='legacy'").fetchone()[0]
                quarantine = c.execute("SELECT quarantined FROM message_outbox WHERE message_id='queued'").fetchone()[0]
            return stored, batch, legacy, quarantine, reader._count_pending()
        with tempfile.TemporaryDirectory() as folder:
            stored, batch, legacy, quarantine, pending = asyncio.run(run(Path(folder) / "revision.db"))
        self.assertTrue(stored)
        self.assertEqual(batch, [])
        self.assertEqual(legacy, "synthetic")
        self.assertEqual(quarantine, 1)
        self.assertEqual(pending, 0)

    def test_outbox_cap_raises_backpressure_instead_of_discarding_rows(self):
        from unittest.mock import patch
        async def run(db):
            reader = QQReader(QQReaderConfig(db_path=str(db)))
            reader._initialize_db()
            reader._replace_policies([("qq", "acct", "private", "peer", 1)])
            first = normalize_event({"post_type":"message", "message_type":"private", "self_id":"acct",
                "message_id":"one", "user_id":"peer", "message":"one", "time":1})
            second = dict(first, message_id="two")
            with patch("app.plugins.qq_reader.MAX_PENDING_OUTBOX", 1):
                stored = reader._store(first, "")
                with self.assertRaises(OutboxFull):
                    reader._store(second, "")
            return stored, await asyncio.to_thread(reader._get_batch)
        with tempfile.TemporaryDirectory() as folder:
            stored, batch = asyncio.run(run(Path(folder) / "cap.db"))
        self.assertTrue(stored)
        self.assertEqual([message["message_id"] for message in batch], ["one"])

    def test_permanent_rejection_is_quarantined_while_good_ack_commits(self):
        async def run(db):
            reader = QQReader(QQReaderConfig(db_path=str(db), sync_url="http://127.0.0.1/integrations/messages/import",
                sync_token="import-token"), http_transport=RejectOneHTTP())
            reader._initialize_db()
            reader._replace_policies([("qq", "acct", "private", "peer", 1)])
            for message_id in ("poison", "good"):
                msg = {"schema_version":1,"platform":"qq","account_id":"acct","self_id":"acct",
                    "message_id":message_id,"conversation_type":"private","conversation_id":"peer",
                    "sender_id":"peer","text":message_id,"sent_at":1,"received_at":2,"content_kind":"text"}
                self.assertTrue(reader._store(msg, ""))
            async def wake():
                reader._stop.set(); return False
            reader._stop.wait = wake
            await reader._sync_loop()
            with reader._connect_db() as c:
                states = {row[0]:(row[1],row[2]) for row in c.execute("SELECT message_id,synced,quarantined FROM message_outbox")}
            return states, reader._get_batch()
        with tempfile.TemporaryDirectory() as folder:
            states, batch = asyncio.run(run(Path(folder) / "reject.db"))
        self.assertEqual(states, {"poison":(0,1), "good":(1,0)})
        self.assertEqual(batch, [])


if __name__ == "__main__":
    unittest.main()
