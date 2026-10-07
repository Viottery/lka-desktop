"""Synthetic proxy tests; no real backend, credentials, data or model calls."""
import os
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from app.api.routes.workbench_proxy import router, _route, _upstream

RealClient = httpx.AsyncClient


class ChunkStream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk

    async def aclose(self):
        self.closed = True


class WorkbenchProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = FastAPI()
        self.app.include_router(router)
        self.calls = []
        self.streams = []
        async def upstream(request):
            self.calls.append(request)
            if request.url.path.endswith("/turn/stream"):
                stream = ChunkStream([b"event: token\ndata: raw\n\n", b"x" * (8 * 1024 * 1024 + 1)])
                self.streams.append(stream)
                return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=stream)
            return httpx.Response(200, json={"sessions": [{"session_id": "synthetic"}]})
        self.transport = httpx.MockTransport(upstream)

    async def request(self, path="sessions?limit=50", method="GET", headers=None, payload=None,
                      host="127.0.0.1:8780", peer="127.0.0.1", env=None):
        options = {"LKA_WORKBENCH_BACKEND_URL": "http://127.0.0.1:8765"}
        if env:
            options.update(env)
        def make_client(**kwargs):
            kwargs["transport"] = self.transport
            return RealClient(**kwargs)
        with patch.dict(os.environ, options, clear=False), patch(
                "app.api.routes.workbench_proxy.httpx.AsyncClient", side_effect=make_client):
            async with RealClient(transport=httpx.ASGITransport(app=self.app, client=(peer, 3210)),
                                  base_url="http://" + host) as client:
                return await client.request(method, "/workbench/" + path, headers=headers, json=payload)

    async def test_loopback_list_forwards_path_query_bodyless_and_strips_browser_credentials(self):
        response = await self.request(headers={"Authorization": "Bearer browser-secret",
                                                "Cookie": "session=browser-secret",
                                                "Origin": "http://127.0.0.1:8780"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["sessions"][0]["session_id"], "synthetic")
        call = self.calls[0]
        self.assertEqual(str(call.url), "http://127.0.0.1:8765/sessions?limit=50")
        self.assertNotIn("authorization", call.headers)
        self.assertNotIn("cookie", call.headers)
        self.assertNotIn("origin", call.headers)
        self.assertNotIn("browser-secret", response.text)

    async def test_remote_requires_exact_opt_in_origin_and_same_origin_headers(self):
        denied = await self.request(host="192.0.2.2:8780", peer="192.0.2.4")
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(self.calls, [])
        allowed = await self.request(host="192.0.2.2:8780", peer="192.0.2.4",
            headers={"Origin": "http://192.0.2.2:8780", "Sec-Fetch-Site": "same-origin"},
            env={"LKA_WORKBENCH_ORIGINS": "http://192.0.2.2:8780"})
        self.assertEqual(allowed.status_code, 200)
        mismatch = await self.request(host="192.0.2.2:8780", peer="192.0.2.4",
            headers={"Origin": "http://evil.example"},
            env={"LKA_WORKBENCH_ORIGINS": "http://192.0.2.2:8780"})
        self.assertEqual(mismatch.status_code, 403)
        cross_site = await self.request(host="192.0.2.2:8780", peer="192.0.2.4",
            headers={"Origin": "http://192.0.2.2:8780", "Sec-Fetch-Site": "cross-site"},
            env={"LKA_WORKBENCH_ORIGINS": "http://192.0.2.2:8780"})
        self.assertEqual(cross_site.status_code, 403)

    async def test_unknown_routes_methods_and_query_names_are_rejected(self):
        for path, method in (("integrations/qq/messages/import", "POST"),
                             ("sessions/one/restore", "GET"),
                             ("sessions?unexpected=1", "GET"),
                             ("../health", "GET")):
            response = await self.request(path, method)
            self.assertEqual(response.status_code, 404, (path, method))
        self.assertEqual(self.calls, [])

    async def test_server_url_is_fixed_loopback_and_rejects_nonlocal_or_path(self):
        for value in ("https://127.0.0.1:8765", "http://example.test", "http://u:p@127.0.0.1",
                      "http://127.0.0.1:badport", "http://127.0.0.1:8765/api",
                      "http://127.0.0.1?q=secret", "http://127.0.0.1#x"):
            with patch.dict(os.environ, {"LKA_WORKBENCH_BACKEND_URL": value}):
                with self.assertRaises(Exception):
                    _upstream()

    async def test_sse_is_relayed_without_json_reencoding(self):
        response = await self.request("agent/turn/stream", "POST", payload={"user_input": "test"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/event-stream"))
        self.assertEqual(response.content[:24], b"event: token\ndata: raw\n\n")
        self.assertEqual(len(response.content), 24 + 8 * 1024 * 1024 + 1)
        self.assertTrue(self.streams[0].closed)
        self.assertEqual(self.calls[0].content, b'{"user_input":"test"}')

    async def test_explicit_route_allowlist(self):
        self.assertTrue(_route("GET", "sessions/s1/files", {"limit"}))
        self.assertTrue(_route("POST", "agent/turn", set()))
        self.assertFalse(_route("GET", "sessions/s1/files", {"arbitrary"}))
        self.assertFalse(_route("POST", "plugins/qq-ui/messages/send", set()))

    async def test_ipv4_peer_loopback_check_and_observed_memory_routes(self):
        from app.api.routes.workbench_proxy import _loopback
        self.assertFalse(_loopback("192.0.2.10"))
        self.assertTrue(_loopback("127.0.0.1"))
        self.assertTrue(_route("GET", "memories", {"scope", "include_candidates", "limit", "offset"}))
        self.assertTrue(_route("GET", "memories/learning", {"scope", "workspace_path"}))
        self.assertTrue(_route("DELETE", "memories/m1", {"workspace_path", "expected_version"}))
        self.assertTrue(_route("POST", "memories/file/import", {"scope", "workspace_path"}))
        self.assertTrue(_route("GET", "background/events", {"interval"}))


if __name__ == "__main__":
    unittest.main()
