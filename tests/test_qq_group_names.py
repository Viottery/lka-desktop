"""Group names are read-only, scoped to the locally paired QQ account."""
import unittest
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from app.api.routes import qq_ui
from app.api.routes.plugins import router as plugins_router
from app.plugins.qq_actions import QQActionConfig, QQActionError
from app.plugins.qq_group_names import GroupDirectoryError, QQGroupNames, SnowLumaMetadataClient


class FakeActions:
    def __init__(self, groups):
        self.groups = groups
        self.calls = []
        self.verified = 0
        self.verify_error = None

    async def verify_account(self):
        self.verified += 1
        if self.verify_error:
            raise self.verify_error
        return True

    async def call(self, action, params):
        self.calls.append((action, params))
        if action == "get_group_list":
            return self.groups
        if action == "get_group_info":
            return {"group_id": params["group_id"], "group_name": "Fetched name"}
        raise AssertionError("unexpected action")


class GroupNamesTests(unittest.IsolatedAsyncioTestCase):
    def make_directory(self, groups):
        client = FakeActions(groups)
        return QQGroupNames(QQActionConfig(token="x" * 32, expected_self_id="123456"),
                            client=client), client

    async def test_reads_one_joined_group_and_caches_directory(self):
        directory, client = self.make_directory([
            {"group_id": 98765, "group_name": "Project group", "member_count": 22},
            {"group_id": "12345", "group_name": "Another group"},
        ])
        first = await directory.name_for("98765", "123456")
        second = await directory.name_for(98765, 123456)
        self.assertEqual(first, {"account_id": "123456", "group_id": "98765",
                                 "group_name": "Project group", "cached": False, "stale": False})
        self.assertTrue(second["cached"])
        self.assertEqual(client.verified, 2)
        self.assertEqual(client.calls, [("get_group_list", {})])

    async def test_rejects_account_mismatch_before_contacting_qq(self):
        directory, client = self.make_directory([])
        with self.assertRaises(GroupDirectoryError) as caught:
            await directory.name_for("98765", "654321")
        self.assertEqual((caught.exception.code, caught.exception.status), ("account_mismatch", 409))
        self.assertEqual((client.verified, client.calls), (0, []))

    async def test_only_returns_groups_present_in_joined_group_list(self):
        directory, client = self.make_directory([{"group_id": "12345", "group_name": "Known"}])
        with self.assertRaises(GroupDirectoryError) as caught:
            await directory.name_for("99999", "123456")
        self.assertEqual((caught.exception.code, caught.exception.status), ("group_not_found", 404))
        self.assertEqual(client.calls, [("get_group_list", {})])

    async def test_falls_back_to_get_group_info_when_joined_list_has_no_name(self):
        directory, client = self.make_directory([{"group_id": "98765", "group_name": ""}])
        result = await directory.name_for("98765", "123456")
        self.assertEqual(result["group_name"], "Fetched name")
        self.assertEqual(client.calls, [("get_group_list", {}),
                                        ("get_group_info", {"group_id": "98765"})])

    async def test_rejects_malformed_or_unbounded_group_list(self):
        for rows in (None, [None], [{"group_id": "3"}]):
            directory, _ = self.make_directory(rows)
            with self.assertRaises(GroupDirectoryError) as caught:
                await directory.name_for("3", "123456")
            self.assertEqual((caught.exception.code, caught.exception.status), ("protocol_error", 502))

    async def test_failure_backoff_avoids_one_timeout_per_requested_group(self):
        directory, client = self.make_directory([])
        client.verify_error = QQActionError("timeout")
        for group in ("1", "2", "3"):
            with self.assertRaises(GroupDirectoryError) as caught:
                await directory.name_for(group, "123456")
            self.assertEqual(caught.exception.code, "timeout")
        self.assertEqual(client.verified, 1)
        self.assertEqual(client.calls, [])

    async def test_transient_failure_uses_marked_stale_cache_but_account_change_clears_it(self):
        directory, client = self.make_directory([{"group_id": "98765", "group_name": "Project group"}])
        await directory.name_for("98765", "123456")
        directory._verified_at = 0
        client.verify_error = QQActionError("network_error")
        stale = await directory.name_for("98765", "123456")
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["group_name"], "Project group")

        directory._retry_after = 0
        client.verify_error = QQActionError("account_mismatch")
        with self.assertRaises(GroupDirectoryError) as caught:
            await directory.name_for("98765", "123456")
        self.assertEqual(caught.exception.code, "account_mismatch")
        self.assertIsNone(directory._snapshot)

    async def test_ui_lookup_works_with_messaging_and_sending_disabled_and_caps_timeout(self):
        directory, _ = self.make_directory([{"group_id": "98765", "group_name": "Project group"}])
        metadata_client = FakeActions([])
        app = FastAPI()
        app.include_router(plugins_router)
        app.state.qq_messaging = SimpleNamespace(config=SimpleNamespace(
            action_url="http://127.0.0.1:3002", action_token="",
            expected_self_id="123456", timeout=60, enabled=False, send_enabled=False), ready=False)
        with patch.dict(os.environ, {"QQ_METADATA_URL": "http://127.0.0.1:5099",
                                     "QQ_METADATA_CREDENTIAL_PATH": "C:/private/control.json"}), \
                patch.object(qq_ui, "SnowLumaMetadataClient", return_value=metadata_client) as make_client, \
                patch.object(qq_ui, "QQGroupNames", return_value=directory) as make_directory:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                         base_url="http://127.0.0.1:8000") as client_http:
                response = await client_http.get("/plugins/qq-ui/groups/98765?account_id=123456")
                cross_origin = await client_http.get("/plugins/qq-ui/groups/98765?account_id=123456",
                                                    headers={"Origin": "http://evil.example"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["group_name"], "Project group")
        self.assertEqual(cross_origin.status_code, 403)
        self.assertEqual(make_client.call_args.args[:3],
                         ("http://127.0.0.1:5099", "C:/private/control.json", "123456"))
        self.assertEqual(make_client.call_args.kwargs["timeout"], 8)
        self.assertIs(make_directory.call_args.kwargs["client"], metadata_client)
        self.assertFalse(app.state.qq_messaging.config.send_enabled)

    async def test_snowluma_refreshes_session_token_in_memory_and_only_invokes_read_actions(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "control.private.json"
            original = {"token": "old-test-token", "password": "test-password"}
            path.write_text(json.dumps(original), encoding="utf-8")
            calls = []

            def handler(request):
                auth = request.headers.get("Authorization")
                calls.append((request.method, request.url.path, auth,
                              json.loads(request.content) if request.content else None))
                if request.url.path == "/api/qq-list":
                    if auth == "Bearer old-test-token":
                        return httpx.Response(401, json={"error": "expired"})
                    return httpx.Response(200, json={"list": [{"uin": "123456", "nickname": "synthetic"}]})
                if request.url.path == "/api/login":
                    self.assertEqual(json.loads(request.content), {"password": "test-password"})
                    return httpx.Response(200, json={"success": True, "token": "fresh-test-token",
                                                     "mustChangePassword": False})
                if request.url.path == "/api/debug/invoke":
                    payload = json.loads(request.content)
                    self.assertIn(payload["action"], {"get_login_info", "get_group_list", "get_group_info"})
                    if payload["action"] == "get_login_info":
                        data = {"user_id": "123456"}
                    else:
                        data = [{"group_id": "98765", "group_name": "Synthetic group"}]
                    return httpx.Response(200, json={"status": "ok", "retcode": 0, "data": data})
                self.fail("unexpected SnowLuma route")

            client = SnowLumaMetadataClient("http://127.0.0.1:5099", path, "123456",
                                             timeout=8, transport=httpx.MockTransport(handler))
            self.assertTrue(await client.verify_account())
            groups = await client.call("get_group_list", {})
            with self.assertRaises(QQActionError) as caught:
                await client.call("send_msg", {"message": "never sent"})
            self.assertEqual(caught.exception.code, "unsupported_action")
            self.assertEqual(groups, [{"group_id": "98765", "group_name": "Synthetic group"}])
            self.assertIn(("POST", "/api/login", None,
                           {"password": "test-password"}), calls)
            self.assertTrue(any(call[1] == "/api/qq-list" and call[2] == "Bearer fresh-test-token"
                                for call in calls))
            actions = [call[3]["action"] for call in calls if call[1] == "/api/debug/invoke"]
            self.assertEqual(actions, ["get_login_info", "get_group_list"])
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), original)

    def test_snowluma_requires_loopback_and_bounded_timeout(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "control.private.json"
            path.write_text('{"token":"token","password":"password"}', encoding="utf-8")
            for url, timeout in (("http://192.168.1.5:5099", 8),
                                 ("http://127.0.0.1:5099", 8.1),
                                 ("http://user@127.0.0.1:5099", 8),
                                 ("http://127.0.0.1:5099/?token=secret", 8)):
                with self.assertRaises(QQActionError):
                    SnowLumaMetadataClient(url, path, "123456", timeout=timeout)

    async def test_same_origin_ui_route_returns_sanitized_one_group_response(self):
        directory, _ = self.make_directory([{"group_id": "98765", "group_name": "Project group"}])
        app = FastAPI()
        app.include_router(plugins_router)
        app.state.qq_group_names = directory
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://127.0.0.1:8000") as client:
            response = await client.get("/plugins/qq-ui/groups/98765?account_id=123456",
                                        headers={"Origin": "http://127.0.0.1:8000"})
            mismatch = await client.get("/plugins/qq-ui/groups/98765?account_id=654321",
                                        headers={"Origin": "http://127.0.0.1:8000"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"account_id": "123456", "group_id": "98765",
                                           "group_name": "Project group", "cached": False,
                                           "stale": False})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(mismatch.status_code, 409)


if __name__ == "__main__":
    unittest.main()
