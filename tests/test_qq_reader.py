import asyncio
import json
import logging
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.plugins.qq_reader import QQReader, QQReaderConfig, WS_TRANSPORT_LOG, normalize_event

try:
    from websockets.asyncio.server import serve
except ImportError:
    serve = None


def event(self_id="100", message_id="7", message="hi", kind="private"):
    return {"post_type": "message", "message_type": kind, "self_id": self_id,
            "message_id": message_id, "user_id": "sender", "group_id": "group-1",
            "time": 123, "message": message,
            "sender": {"user_id": "sender", "nickname": "Nick", "card": "Card"}}


class FakeSocket:
    def __init__(self, values):
        self.values = iter(values)
    async def __aenter__(self):
        return self
    async def __aexit__(self, *_):
        return None
    def __aiter__(self):
        return self
    async def __anext__(self):
        try:
            return next(self.values)
        except StopIteration:
            raise StopAsyncIteration


class FakeHTTPResponse:
    status_code = 200
    def __init__(self, data): self.data = data
    def json(self): return self.data


class FakeHTTP:
    def __init__(self, responses): self.responses = iter(responses); self.calls = []
    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        response = next(self.responses)
        if isinstance(response, Exception): raise response
        return FakeHTTPResponse(response)


class QQReaderTests(unittest.TestCase):
    @staticmethod
    def allow(reader, message):
        policy = (message.get("platform", "qq"), message.get("account_id", message["self_id"]),
                  message["conversation_type"], message["conversation_id"])
        reader._policies.add(policy)
        with reader._connect_db() as c:
            c.execute("INSERT OR REPLACE INTO approved_policies VALUES(?,?,?,?,1)", policy)

    def test_expected_account_mismatch_disconnects_without_storing(self):
        async def run(db):
            calls = 0
            async def connector(url, **kwargs):
                nonlocal calls
                calls += 1
                return FakeSocket([json.dumps({'post_type':'meta_event', 'self_id':'wrong-account'}),
                                   json.dumps(event('wrong-account', '1', 'private text'))])
            reader = QQReader(QQReaderConfig(enabled=True, expected_self_id='wanted-account',
                ws_token='test-token', db_path=str(db), platform='nt'), ws_connect=connector)
            await reader.start()
            await asyncio.sleep(.1)
            state = reader.status()
            await reader.stop()
            with reader._connect_db() as c:
                count = c.execute('SELECT COUNT(*) FROM message_outbox').fetchone()[0]
            return state, count, calls
        with tempfile.TemporaryDirectory() as d:
            state, count, calls = asyncio.run(run(Path(d)/'guard.db'))
        self.assertEqual(state['last_error'], 'account_mismatch')
        self.assertEqual(state['connection_state'], 'stopped')
        self.assertEqual(count, 0)
        self.assertEqual(calls, 1)
        self.assertIsNone(state['last_received_at'])

    def test_sync_queue_only_contains_expected_account(self):
        with tempfile.TemporaryDirectory() as d:
            reader = QQReader(QQReaderConfig(db_path=str(Path(d)/'guard.db'), expected_self_id='wanted'))
            reader._initialize_db()
            first = normalize_event(event('wanted', '1')); self.allow(reader, first)
            second = normalize_event(event('other', '1')); self.allow(reader, second)
            reader._store(first, 'raw')
            reader._store(second, 'raw')
            self.assertEqual(reader._count_pending(), 1)
            self.assertEqual([m['self_id'] for m in reader._get_batch()], ['wanted'])

    def test_default_disabled_does_not_create_database_or_tasks(self):
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "never.db"
            reader = QQReader(QQReaderConfig(enabled=False, db_path=str(db), platform="nt"))
            asyncio.run(reader.start())
            self.assertFalse(db.exists())
            self.assertIsNone(reader._task)
            self.assertEqual(reader.status()["connection_state"], "disabled")

    def test_normalization_filters_and_sanitizes(self):
        self.assertIsNone(normalize_event({"post_type": "notice"}))
        msg = normalize_event(event(message="Hi[CQ:image,file=x] &amp; &#91;CQ:at,qq=1&#93;"))
        self.assertEqual(msg["text"], "Hi & [CQ:at,qq=1]")
        self.assertEqual(msg["conversation_type"], "private")
        group = normalize_event(event(kind="group"))
        self.assertEqual(group["display_name"], "Card")
        self.assertEqual(group["conversation_id"], "group-1")
        unsupported = normalize_event(event(message=[{"type": "image", "data": {"url": "secret"}}]))
        self.assertEqual(unsupported["content_kind"], "unsupported")
        self.assertEqual(unsupported["text"], "")
        bad_time = event(); bad_time["time"] = "not-a-time"
        self.assertIsNone(normalize_event(bad_time)["sent_at"])
        for invalid in (False, 0.0, -1, 253402300800):
            bad_time["time"] = invalid
            self.assertIsNone(normalize_event(bad_time)["sent_at"])
        fallback = event(); fallback.pop("message"); fallback["raw_message"] = "fallback body"
        self.assertEqual(normalize_event(fallback)["text"], "fallback body")
        top_level_sender = event(); top_level_sender["sender"] = {}; top_level_sender["user_id"] = "fallback"
        self.assertEqual(normalize_event(top_level_sender)["sender_id"], "fallback")
        for key, value in (("self_id", None), ("message_id", [])):
            bad = event()
            bad[key] = value
            self.assertIsNone(normalize_event(bad))
        for value in (None, "", [], {}):
            bad_group = event(kind="group")
            bad_group["group_id"] = value
            self.assertIsNone(normalize_event(bad_group))
        bad_sender = event()
        bad_sender["sender"]["user_id"] = None
        bad_sender["user_id"] = None
        self.assertIsNone(normalize_event(bad_sender))
        with self.assertRaisesRegex(ValueError, "text_too_large"):
            normalize_event(event(message="x" * 16385))

    def test_receive_deduplicates_scopes_by_account_and_ignores_nonmessages(self):
        async def run(db):
            items = [event(), event(message="changed"), event(self_id="200"), {"post_type": "message_sent"}]
            async def connector(url, **kw):
                self.assertEqual(url, "ws://127.0.0.1:3001/event")
                self.assertEqual(kw["max_size"], 65536)
                self.assertIsNone(kw["proxy"])
                self.assertEqual(kw["additional_headers"], {"Authorization": "Bearer test-token"})
                self.assertEqual((kw["ping_interval"], kw["ping_timeout"], kw["open_timeout"]), (20, 20, 10))
                self.assertTrue(kw["logger"].disabled)
                return FakeSocket([json.dumps(x) for x in items])
            reader = QQReader(QQReaderConfig(enabled=True, db_path=str(db), platform="nt", ws_token="test-token"), ws_connect=connector)
            await asyncio.to_thread(reader._initialize_db)
            self.allow(reader, normalize_event(event()))
            self.allow(reader, normalize_event(event(self_id="200")))
            await reader.start()
            await asyncio.sleep(.1)
            await reader.stop()
            rows = await asyncio.to_thread(reader._get_batch)
            return reader.status(), rows
        with tempfile.TemporaryDirectory() as d:
            status, rows = asyncio.run(run(Path(d) / "reader.db"))
        self.assertEqual(len(rows), 2)
        self.assertEqual({x["self_id"] for x in rows}, {"100", "200"})
        self.assertEqual(next(x for x in rows if x["self_id"] == "100")["text"], "hi")
        self.assertEqual(status["counters"]["duplicates"], 1)
        self.assertEqual(status["counters"]["ignored"], 1)

    def test_reconnects_and_rejects_oversize_frame(self):
        async def run(db):
            attempts = 0
            async def connector(url, **kw):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise OSError("private exception details")
                return FakeSocket(["x" * 65537, json.dumps(event())])
            reader = QQReader(QQReaderConfig(enabled=True, db_path=str(db), platform="nt", ws_token="test-token"), ws_connect=connector)
            captured = []
            handler = logging.Handler()
            handler.emit = lambda record: captured.append(record.getMessage())
            logger = logging.getLogger("app.plugins.qq_reader")
            old_level = logger.level
            logger.setLevel(logging.INFO)
            logger.addHandler(handler)
            await asyncio.to_thread(reader._initialize_db)
            self.allow(reader, normalize_event(event()))
            await reader.start()
            await asyncio.sleep(1.15)
            await reader.stop()
            logger.removeHandler(handler)
            logger.setLevel(old_level)
            return attempts, reader.status(), captured
        with tempfile.TemporaryDirectory() as d:
            attempts, status, captured = asyncio.run(run(Path(d) / "reader.db"))
        self.assertGreaterEqual(attempts, 2)
        self.assertEqual(status["counters"]["parse_errors"], 1)
        self.assertEqual(status["counters"]["stored"], 1)
        self.assertNotIn("private exception details", repr(status))
        self.assertNotIn("private exception details", " ".join(captured))

    def test_recovered_live_connection_clears_transport_error(self):
        async def run(db):
            attempts = 0
            class LiveSocket(FakeSocket):
                async def __anext__(self):
                    try:
                        return next(self.values)
                    except StopIteration:
                        await asyncio.Event().wait()
            async def connector(url, **kwargs):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    raise OSError("temporary connection failure")
                return LiveSocket([json.dumps({"post_type": "meta_event", "self_id": "100"})])
            reader = QQReader(QQReaderConfig(enabled=True, db_path=str(db), platform="nt",
                                            ws_token="test-token"), ws_connect=connector)
            await reader.start()
            try:
                for _ in range(100):
                    if reader.status()["counters"]["received"]:
                        break
                    await asyncio.sleep(.02)
                state = reader.status()
                self.assertGreaterEqual(attempts, 2)
                self.assertEqual(state["connection_state"], "connected")
                self.assertIsNone(state["last_error"])
                self.assertFalse(reader._task.done())
            finally:
                await reader.stop()
        with tempfile.TemporaryDirectory() as directory:
            asyncio.run(run(Path(directory) / "reader.db"))

    def test_sync_storage_error_does_not_end_retry_task(self):
        async def run():
            reader = QQReader(QQReaderConfig(enabled=True, sync_url="http://localhost/integrations/qq/messages/import",
                                             sync_token="sync-token", platform="nt"))
            def fail_read():
                raise sqlite3.OperationalError("private database details")
            reader._get_batch = fail_read
            task = asyncio.create_task(reader._sync_loop())
            await asyncio.sleep(.05)
            state, still_running = reader.status()["sync_state"], not task.done()
            reader._stop.set()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            return state, still_running
        state, still_running = asyncio.run(run())
        self.assertEqual(state, "storage_error")
        self.assertTrue(still_running)

    def test_sync_loop_requires_matching_ack_and_retries_offline(self):
        async def run(db):
            reader = QQReader(QQReaderConfig(enabled=True,
                sync_url="http://localhost/integrations/qq/messages/import",
                sync_token="separate-sync-token", db_path=str(db), platform="nt"))
            await asyncio.to_thread(reader._initialize_db)
            for mid, body in (("1", "first body"), ("2", "second body"), ("3", "third body")):
                normalized = normalize_event(event("account", mid, body))
                assert normalized is not None
                self.allow(reader, normalized)
                await asyncio.to_thread(reader._store, normalized, "secret raw")
            assert len(await asyncio.to_thread(reader._get_batch)) == 3

            class SequenceHTTP:
                def __init__(self): self.calls = []; self.reader = None; self.options_ok = True
                async def post(self, url, **kwargs):
                    self.calls.append(kwargs)
                    self.options_ok = self.options_ok and url == "http://localhost/integrations/messages/import"
                    self.options_ok = self.options_ok and kwargs.get("headers") == {"Authorization": "Bearer separate-sync-token"}
                    self.options_ok = self.options_ok and kwargs.get("follow_redirects") is False and kwargs.get("trust_env") is False
                    n = len(self.calls)
                    if n == 1:
                        return FakeHTTPResponse({"acknowledged": [{"self_id": "outside", "message_id": "evil"}]})
                    if n == 2:
                        return FakeHTTPResponse({"error": "ignored response body"})
                    if n == 3:
                        return FakeHTTPResponse({"acknowledged": [{"self_id": "account", "message_id": "1"}, {"self_id": "outside", "message_id": "evil"}]})
                    if n == 4:
                        raise OSError("private offline response")
                    self.reader._stop.set()
                    return FakeHTTPResponse({"acknowledged": [{"self_id": "account", "message_id": "2"}, {"self_id": "account", "message_id": "3"}]})
            http = SequenceHTTP()
            http.reader = reader
            reader._http = http
            async def immediate_wait():
                await asyncio.sleep(0)
                return False
            reader._stop.wait = immediate_wait
            task = asyncio.create_task(reader._sync_loop())
            done, _ = await asyncio.wait({task}, timeout=3)
            if not done:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                return reader.status(), [], [], len(http.calls), http.options_ok
            await task
            rows = await asyncio.to_thread(reader._get_batch)
            with reader._connect_db() as c:
                raw_values = [r[0] for r in c.execute("SELECT raw_event FROM message_outbox ORDER BY rowid")]
            return reader.status(), rows, raw_values, len(http.calls), http.options_ok
        with tempfile.TemporaryDirectory() as d:
            status, rows, raw_values, calls, options_ok = asyncio.run(run(Path(d) / "sync.db"))
        self.assertEqual(calls, 5, status)
        self.assertTrue(options_ok)
        self.assertEqual(status["sync_state"], "idle")
        self.assertIsNone(status["last_error"])
        self.assertEqual(status["pending_count"], 0)
        self.assertEqual(status["counters"]["synced"], 3)
        self.assertEqual(rows, [])
        self.assertEqual(raw_values, [None, None, None])

    @unittest.skipIf(serve is None, "optional websockets dependency is unavailable")
    def test_real_local_websocket_receives_read_only_reconnects_after_oversize(self):
        async def run(db):
            app_frames = []
            accepted = 0
            async def handler(ws):
                nonlocal accepted
                accepted += 1
                if accepted == 1:
                    await ws.send(json.dumps(event(message="x" * 70000)))
                else:
                    await ws.send(json.dumps(event("local-account", "local-message", "from fake server")))
                try:
                    async for frame in ws:
                        app_frames.append(frame)
                except Exception:
                    pass
            server = await serve(handler, "127.0.0.1", 0, ping_interval=None)
            port = server.sockets[0].getsockname()[1]
            reader = QQReader(QQReaderConfig(enabled=True, ws_url=f"ws://127.0.0.1:{port}/event",
                                             ws_token="local-test-token", db_path=str(db), platform="nt"))
            reader._initialize_db()
            with reader._connect_db() as c:
                c.execute("INSERT INTO approved_policies VALUES('qq','local-account','private','sender',1)")
            try:
                await reader.start()
                for _ in range(60):
                    if reader.status()["counters"]["stored"]:
                        break
                    await asyncio.sleep(.1)
                await asyncio.sleep(.2)
                status = reader.status()
            finally:
                await reader.stop()
                server.close()
                await server.wait_closed()
            rows = await asyncio.to_thread(reader._get_batch)
            return status, accepted, app_frames, rows
        captured = []
        handler = logging.Handler()
        handler.emit = lambda record: captured.append(record.getMessage())
        reader_logger = logging.getLogger("app.plugins.qq_reader")
        root_logger = logging.getLogger()
        old_root_level = root_logger.level
        reader_logger.addHandler(handler)
        WS_TRANSPORT_LOG.addHandler(handler)
        root_logger.setLevel(logging.DEBUG)
        try:
            with tempfile.TemporaryDirectory() as d:
                status, accepted, app_frames, rows = asyncio.run(run(Path(d) / "reader.db"))
        finally:
            reader_logger.removeHandler(handler)
            WS_TRANSPORT_LOG.removeHandler(handler)
            root_logger.setLevel(old_root_level)
        self.assertGreaterEqual(accepted, 2)
        self.assertEqual(app_frames, [])
        self.assertEqual(status["counters"]["stored"], 1)
        self.assertEqual(rows[0]["text"], "from fake server")
        combined_logs = " ".join(captured)
        self.assertNotIn("local-test-token", combined_logs)
        self.assertNotIn("from fake server", combined_logs)

    @unittest.skipIf(serve is None, "optional websockets dependency is unavailable")
    def test_websocket_redirect_is_rejected_without_forwarding_token(self):
        async def run():
            target_hits = 0
            async def target_handler(ws):
                nonlocal target_hits
                target_hits += 1
            target = await serve(target_handler, "127.0.0.1", 0)
            target_port = target.sockets[0].getsockname()[1]
            request_headers = []
            async def redirect_client(reader, writer):
                request_headers.append(await reader.readuntil(b"\r\n\r\n"))
                response = (f"HTTP/1.1 302 Found\r\nLocation: ws://127.0.0.1:{target_port}/event\r\n"
                            "Content-Length: 0\r\n\r\n")
                writer.write(response.encode())
                await writer.drain()
                writer.close()
                await writer.wait_closed()
            redirect = await asyncio.start_server(redirect_client, "127.0.0.1", 0)
            port = redirect.sockets[0].getsockname()[1]
            reader = QQReader(QQReaderConfig(enabled=True, ws_url=f"ws://127.0.0.1:{port}/event",
                                             ws_token="do-not-forward-this", platform="nt"))
            try:
                connect_obj = await reader._connect()
                with self.assertRaises(Exception):
                    async with await connect_obj:
                        self.fail("redirect unexpectedly connected")
                await asyncio.sleep(.1)
            finally:
                redirect.close()
                target.close()
                await redirect.wait_closed()
                await target.wait_closed()
            return request_headers, target_hits
        headers, hits = asyncio.run(run())
        self.assertEqual(hits, 0)
        self.assertIn(b"authorization: bearer do-not-forward-this", headers[0].lower())

    def test_persistence_and_partial_ack(self):
        async def run(db):
            http = FakeHTTP([{"acknowledged": [{"self_id": "a", "message_id": "1"}, {"self_id": "stranger", "message_id": "x"}]}])
            cfg = QQReaderConfig(enabled=True, db_path=str(db), platform="nt", sync_url="http://127.0.0.1/integrations/qq/messages/import", sync_token="sync")
            reader = QQReader(cfg, http_transport=http)
            await asyncio.to_thread(reader._initialize_db)
            first = normalize_event(event("a", "1")); self.allow(reader, first)
            second = normalize_event(event("a", "2")); self.allow(reader, second)
            await asyncio.to_thread(reader._store, first, "raw")
            await asyncio.to_thread(reader._store, second, "raw")
            batch = await asyncio.to_thread(reader._get_batch)
            result = await reader._post_sync({"schema_version": 1, "messages": batch})
            ack = [("qq", x["self_id"], x["message_id"]) for x in result["acknowledged"] if x["self_id"] == "a"]
            await asyncio.to_thread(reader._mark_synced, ack)
            self.assertEqual(len(await asyncio.to_thread(reader._get_batch)), 1)
            self.assertEqual(http.calls[0][1]["follow_redirects"], False)
            restarted = QQReader(cfg)
            restarted._db_path = db
            self.assertEqual(len(await asyncio.to_thread(restarted._get_batch)), 1)
        with tempfile.TemporaryDirectory() as d:
            asyncio.run(run(Path(d) / "reader.db"))

    def test_offline_sync_retains_pending_and_config_validation(self):
        async def run(db):
            http = FakeHTTP([OSError("sensitive body")])
            cfg = QQReaderConfig(enabled=True, db_path=str(db), platform="nt", sync_url="http://localhost/integrations/qq/messages/import", sync_token="sync")
            reader = QQReader(cfg, http_transport=http)
            await asyncio.to_thread(reader._initialize_db)
            message = normalize_event(event()); self.allow(reader, message)
            await asyncio.to_thread(reader._store, message, "raw")
            try: await reader._post_sync({"schema_version": 1, "messages": await asyncio.to_thread(reader._get_batch)})
            except OSError: pass
            self.assertEqual(len(await asyncio.to_thread(reader._get_batch)), 1)
        with tempfile.TemporaryDirectory() as d:
            asyncio.run(run(Path(d) / "reader.db"))
        self.assertNotIn("sensitive body", repr(QQReaderConfig(ws_token="secret", sync_token="other")))
        bad = QQReader(QQReaderConfig(enabled=True, ws_url="ws://user:pass@localhost:3001/event", db_path="unused", platform="nt"))
        asyncio.run(bad.start())
        self.assertEqual(bad.status()["last_error"], "invalid_ws_url")
        self.assertFalse(Path("unused").exists())
        missing_token = QQReader(QQReaderConfig(enabled=True, ws_token="  ", db_path="unused-token.db", platform="nt"))
        asyncio.run(missing_token.start())
        self.assertEqual(missing_token.status()["last_error"], "invalid_ws_auth")
        self.assertFalse(Path("unused-token.db").exists())


if __name__ == "__main__":
    unittest.main()
