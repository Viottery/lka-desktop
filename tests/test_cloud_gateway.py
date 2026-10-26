"""Synthetic cloud gateway tests; no real hub, credentials, data or model calls."""
import gzip
import json
import os
import re
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from app.api.routes.cloud_gateway import _ROUTES, _route, cloud_origin, router
from fastapi import FastAPI

from app.api.routes import cloud_gateway

RealClient = httpx.AsyncClient
ROUTES_FILE = Path(__file__).parent / "fixtures" / "backend_routes.json"
HUB = "https://hub.example.ts.net"


class CloudGatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        cloud_gateway._session.set("", None, 0, "")
        self.app = FastAPI()
        self.app.include_router(router)
        self.calls = []

        async def upstream(request):
            self.calls.append(request)
            path = request.url.path
            if path == "/auth/login":
                body = json.loads(request.content)
                if body["password"] != "correct-horse":
                    return httpx.Response(401, json={"detail": "Invalid credentials"})
                return httpx.Response(200, json={"account": {"user_id": "u1", "username": "owner"}, "session_id": "s1",
                                                 "csrf_token": "csrf", "expires_at": 4102444800, "token": "account-token"})
            if path == "/auth/logout":
                return httpx.Response(204)
            if path == "/devices/desktop-a/connections":
                return httpx.Response(201, json={"grant": "g" * 40, "origin": "https://desktop-a.example.ts.net", "node_id": "desktop-a"})
            if path in {"/background/config", "/background/config/schema"}:
                return httpx.Response(200, json={"synthetic": True})
            if path == "/managers/default":
                return httpx.Response(401, json={"detail": "Account authentication required"})
            if path == "/sessions/synthetic-history":
                return httpx.Response(200, content=gzip.compress(json.dumps({"session": {"session_id": "synthetic-history"}, "messages": [], "message_page": {"has_more": False}}).encode()), headers={"Content-Encoding": "gzip", "Content-Type": "application/json"})
            if path == "/devices":
                return httpx.Response(200, json={"items": [{"node_id": "desktop-a"}]})
            return httpx.Response(404, json={"detail": "nope"})
        self.transport = httpx.MockTransport(upstream)

    async def request(self, path, method="GET", payload=None, peer="127.0.0.1", host="127.0.0.1:8780", headers=None, env=None):
        options = {"LKA_CLOUD_ORIGIN": HUB}
        options.update(env or {})

        def make_client(**kwargs):
            kwargs["transport"] = self.transport
            return RealClient(**kwargs)
        with patch.dict(os.environ, options, clear=False), patch(
                "app.api.routes.cloud_gateway.httpx.AsyncClient", side_effect=make_client):
            async with RealClient(transport=httpx.ASGITransport(app=self.app, client=(peer, 3210)), base_url="http://" + host) as client:
                return await client.request(method, path, json=payload, headers=headers)

    async def login(self):
        response = await self.request("/cloud-auth/login", "POST", {"username": "owner", "password": "correct-horse"})
        self.assertEqual(response.status_code, 200)
        return response

    async def test_exact_turn_correlation_query_reaches_hub(self):
        await self.login()
        self.calls.clear()
        await self.request("/cloud/sessions/synthetic/runs?limit=2&client_request_id=input-unique")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0].url.path, "/sessions/synthetic/runs")
        self.assertEqual(self.calls[0].url.params["client_request_id"], "input-unique")
        self.assertEqual(self.calls[0].url.params["limit"], "2")

    async def test_paged_history_accepts_gzip_and_relays_decoded_json(self):
        await self.login()
        response = await self.request("/cloud/sessions/synthetic-history?message_limit=30&after_message_id=m_1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["message_page"], {"has_more": False})
        self.assertNotIn("content-encoding", response.headers)
        self.assertEqual(self.calls[-1].headers["accept-encoding"], "gzip")
        self.assertEqual(self.calls[-1].url.params["after_message_id"], "m_1")
        conversation = await self.request("/cloud/sessions/synthetic-history?message_limit=30&message_view=conversation&before_message_id=m_2")
        self.assertEqual(conversation.status_code, 200)
        self.assertEqual(self.calls[-1].url.params["message_view"], "conversation")
        self.assertEqual(self.calls[-1].url.params["before_message_id"], "m_2")
        self.assertEqual((await self.request("/cloud/sessions/synthetic-history?unexpected=1")).status_code, 404)

    async def test_login_keeps_token_in_process_and_never_returns_it(self):
        response = await self.login()
        self.assertNotIn("account-token", response.text)
        self.assertNotIn("csrf", response.text)
        self.assertTrue(response.json()["logged_in"])
        login_call = self.calls[0]
        self.assertEqual(login_call.headers["x-lka-client"], "native")
        self.assertNotIn("origin", login_call.headers)

    async def test_proxy_attaches_account_header_not_authorization(self):
        await self.login()
        response = await self.request("/cloud/devices?limit=100&offset=0", headers={"Authorization": "Bearer page-token", "Cookie": "a=b"})
        self.assertEqual(response.status_code, 200)
        forwarded = self.calls[-1]
        self.assertEqual(forwarded.headers["x-lka-account-token"], "account-token")
        self.assertNotIn("authorization", forwarded.headers)
        self.assertNotIn("cookie", forwarded.headers)

    async def test_background_config_routes_use_account_auth_and_preserve_payload(self):
        self.assertEqual((await self.request("/cloud/background/config")).status_code, 401)
        await self.login()
        for method, suffix, payload in [
            ("GET", "", None), ("GET", "/schema", None),
            ("PATCH", "", {"expected_revision": 3, "memory": {"enabled": True}}),
            ("DELETE", "?expected_revision=3", None),
        ]:
            response = await self.request("/cloud/background/config" + suffix, method, payload)
            self.assertEqual(response.status_code, 200)
            sent = self.calls[-1]
            self.assertEqual(sent.headers["x-lka-account-token"], "account-token")
            self.assertEqual(sent.method, method)
            if payload:
                self.assertEqual(json.loads(sent.content), payload)
            if method == "DELETE":
                self.assertEqual(sent.url.params["expected_revision"], "3")
        for method, suffix in [("POST", ""), ("PATCH", "/schema"), ("GET", "?unknown=1")]:
            self.assertEqual((await self.request("/cloud/background/config" + suffix, method)).status_code, 404)

    async def test_requires_login_and_configured_https_origin(self):
        self.assertEqual((await self.request("/cloud/devices")).status_code, 401)
        self.assertEqual((await self.request("/cloud-auth/login", "POST", {"username": "o", "password": "p"},
                                             env={"LKA_CLOUD_ORIGIN": "http://hub.example"})).status_code, 503)
        with patch.dict(os.environ, {"LKA_CLOUD_ORIGIN": "https://user:pw@hub.example"}):
            self.assertEqual(cloud_origin(), "")

    async def test_remote_browsers_are_refused(self):
        response = await self.request("/cloud-auth/status", peer="100.64.0.8", host="desk.example.ts.net:8780",
                                      env={"LKA_WORKBENCH_ORIGINS": "http://desk.example.ts.net:8780"})
        self.assertEqual(response.status_code, 403)
        cross = await self.request("/cloud-auth/status", headers={"Origin": "http://evil.example"})
        self.assertEqual(cross.status_code, 403)

    async def test_hub_401_clears_the_local_session(self):
        await self.login()
        response = await self.request("/cloud/managers/default", "POST", {})
        self.assertEqual(response.status_code, 401)
        self.assertFalse((await self.request("/cloud-auth/status")).json()["logged_in"])

    async def test_wrong_password_is_reported_without_echo(self):
        response = await self.request("/cloud-auth/login", "POST", {"username": "owner", "password": "wrong-password-value"})
        self.assertEqual(response.status_code, 401)
        self.assertNotIn("wrong-password-value", response.text)

    async def test_grant_issue_is_relayed_for_navigation(self):
        await self.login()
        response = await self.request("/cloud-auth/connections/desktop-a", "POST", {})
        self.assertEqual(response.status_code, 201)
        self.assertEqual(self.calls[-1].url.path, "/devices/desktop-a/connections")

    async def test_unlisted_and_traversal_paths_are_refused(self):
        await self.login()
        for path in ("/cloud/node/heartbeat", "/cloud/sync/changes", "/cloud/devices/../auth/login", "/cloud/messages/conversations"):
            self.assertEqual((await self.request(path)).status_code, 404, path)
        self.assertFalse(_route("POST", "devices/desktop-a/connections", set()))

    async def test_logout_revokes_upstream_and_forgets_token(self):
        await self.login()
        response = await self.request("/cloud-auth/logout", "POST")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.calls[-1].url.path, "/auth/logout")
        self.assertFalse((await self.request("/cloud-auth/status")).json()["logged_in"])


class CloudRouteSyncTest(unittest.TestCase):
    def test_every_cloud_route_exists_on_the_backend(self):
        rows = json.loads(ROUTES_FILE.read_text("utf-8"))
        backend = [(row["method"], re.compile(re.sub(r"\{[^}]+\}", "[^/]+", row["path"].lstrip("/")) + "$")) for row in rows]
        missing = []
        for verb, pattern, _ in _ROUTES:
            probe = re.sub(r"\[[^\]]*\]\{[^}]*\}|\[[^\]]*\]\+|\[[^\]]*\]\*", "id_1", pattern)
            for group in re.findall(r"\(\?:([^)]*)\)", probe):
                for branch in group.split("|"):
                    candidate = probe.replace(f"(?:{group})", branch, 1).replace("\\.", ".")
                    if not any(method == verb and regex.match(candidate) for method, regex in backend):
                        missing.append(f"{verb} {candidate}")
                break
            else:
                probe = probe.replace("\\.", ".")
                if not any(method == verb and regex.match(probe) for method, regex in backend):
                    missing.append(f"{verb} {probe}")
        self.assertEqual(missing, [], "cloud gateway forwards routes the backend does not have")


if __name__ == "__main__":
    unittest.main()
