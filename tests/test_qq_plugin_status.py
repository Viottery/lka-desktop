"""Isolated status endpoint/lifecycle tests; no real app, QQ or backend."""
import unittest
from unittest.mock import patch
from tempfile import TemporaryDirectory
from pathlib import Path
from types import SimpleNamespace
from fastapi import FastAPI
import httpx
from app.api.routes.plugins import router
from app.plugins.lifecycle import start_qq_reader, stop_qq_reader

class StatusTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = FastAPI()
        self.app.include_router(router)

    async def request(self, *, peer="127.0.0.1", host="127.0.0.1:8000", headers=None, method="GET"):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=(peer, 1234)), base_url="http://" + host) as client:
            return await client.request(method, "/plugins/qq-reader/status", headers=headers)

    async def test_disabled_is_safe_and_read_only(self):
        result = await self.request()
        self.assertEqual(result.status_code, 200)
        self.assertFalse(result.json()["enabled"])
        self.assertEqual((await self.request(method="POST")).status_code, 405)

    async def test_local_peer_host_and_same_origin_required(self):
        for args in ({"peer":"192.168.1.2"}, {"host":"evil.example"}, {"headers":{"Origin":"https://evil.example"}}):
            self.assertEqual((await self.request(**args)).status_code, 403)
        self.assertEqual((await self.request(headers={"Origin":"http://127.0.0.1:8000"})).status_code, 200)

    async def test_only_sanitized_status_fields_exposed(self):
        secret = "private-body-or-token"
        self.app.state.qq_reader = SimpleNamespace(status=lambda: {
            "enabled":True, "connection_state":"connected", "last_received_at":secret,
            "last_error":secret, "sync_state":"pending", "token":secret, "text":secret,
            "db_path":secret, "counters":{"self_id":secret},
            "media":{"enabled":True,"state":secret,"last_error_class":secret,
                     "counters":{"cached":secret,"url":secret},"url":secret}})
        result = await self.request()
        self.assertNotIn(secret, result.text)
        self.assertEqual(result.json()["last_error"], "reader_error")
        self.assertIsNone(result.json()["last_received_at"])
        self.assertEqual(result.json()["pending_count"], 0)
        self.assertEqual(len(result.json()), 8)
        self.assertEqual(result.json()["media"]["state"], "disabled")
        self.assertIsNone(result.json()["media"]["last_error_class"])
        self.assertEqual(result.json()["media"]["counters"]["cached"], 0)

    async def test_disabled_lifecycle_has_no_io(self):
        with TemporaryDirectory() as tmp, patch.dict("os.environ", {"QQ_READER_ENABLED":"false", "QQ_DB_PATH":str(Path(tmp)/"qq.db")}):
            await start_qq_reader(self.app)
            await stop_qq_reader(self.app)
            self.assertFalse((Path(tmp)/"qq.db").exists())

    async def test_start_failure_does_not_break_frontend_or_expose_exception(self):
        with patch("app.plugins.lifecycle.QQReaderConfig.from_env", side_effect=ValueError("sensitive")):
            await start_qq_reader(self.app)
            result = await self.request()
            self.assertNotIn("sensitive", result.text)
            self.assertEqual(result.json()["last_error"], "configuration_error")
            await stop_qq_reader(self.app)

if __name__ == "__main__":
    unittest.main()
