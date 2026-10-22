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
                      content=None, host="127.0.0.1:8780", peer="127.0.0.1", env=None):
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
                return await client.request(method, "/workbench/" + path, headers=headers, json=payload, content=content)

    async def test_verification_context_is_built_once_off_the_event_loop(self):
        import asyncio
        import ssl
        import threading
        from app.api.routes import workbench_proxy

        main_thread = threading.get_ident()
        context = ssl.create_default_context()
        threads = []
        def build(**kwargs):
            self.assertFalse(kwargs["trust_env"])
            threads.append(threading.get_ident())
            return context
        with patch.object(workbench_proxy, "_tls_context", None), patch.object(
                workbench_proxy.httpx, "create_ssl_context", side_effect=build) as create:
            # Concurrent requests share one initialization; verification stays on.
            contexts = await asyncio.gather(*(asyncio.to_thread(workbench_proxy._verified_context) for _ in range(6)))
            self.assertTrue(all(value is context for value in contexts))
            await self.request()
            self.assertEqual(create.call_count, 1)
            self.assertNotEqual(threads[0], main_thread)
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

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

    async def test_manager_input_queue_routes_are_explicit_and_queryless(self):
        for path, method in (("sessions/s1/inputs", "GET"), ("sessions/s1/inputs", "POST"),
                             ("sessions/s1/inputs/resume", "POST")):
            body = {"client_message_id": "stable-id", "user_input": "queued", "attachment_ids": []}
            result = await self.request(path, method, payload=body if method == "POST" else None)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(self.calls[-1].url.path, "/" + path)
            if method == "POST":
                self.assertEqual(__import__("json").loads(self.calls[-1].content), body)
        for path, method in (("sessions/s1/inputs?token=secret", "GET"),
                             ("sessions/s1/inputs?limit=20", "POST"),
                             ("sessions/s1/inputs/resume", "GET"), ("sessions/s1/inputs", "DELETE"),
                             ("sessions/s1/inputs/unknown", "POST")):
            self.assertEqual((await self.request(path, method)).status_code, 404)

    async def test_matter_routes_are_bounded_and_forward_cas_payload(self):
        result = await self.request("matters?kind=task&status=active&unscheduled=true&offset=50")
        self.assertEqual(result.status_code, 200)
        result = await self.request("matters/sync?after=12&limit=200")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(str(self.calls[-1].url), "http://127.0.0.1:8765/matters/sync?after=12&limit=200")
        result = await self.request("matters?scheduled_on=2026-10-19&inbox=true&section=Draft")
        self.assertEqual(result.status_code, 200)
        for path in ("matters/sync?token=secret", "matters/sync?after=1&cursor=2"):
            self.assertEqual((await self.request(path)).status_code, 404)
        payload = {"title": "Draft", "expected_revision": 3, "due_at": None,
                   "scheduled_on": "2026-10-19", "scheduled_start": None, "scheduled_end": None}
        result = await self.request("matters/m1", "PATCH", payload=payload)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(__import__("json").loads(self.calls[-1].content), payload)
        result = await self.request("matters/m1?expected_revision=3", "DELETE")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(str(self.calls[-1].url), "http://127.0.0.1:8765/matters/m1?expected_revision=3")
        for path, method in (("matters/m1?token=secret", "DELETE"), ("matters?token=secret", "GET"),
                             ("matters/m1/source-links", "POST")):
            result = await self.request(path, method)
            self.assertEqual(result.status_code, 404)

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

    async def test_memory_feedback_probe_and_exact_query_allowlist(self):
        path = "memories/feedback"
        query = "scope=project&workspace_path=C%3A%2Fsynthetic&limit=1&offset=0"
        response = await self.request(path + "?" + query)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(str(self.calls[-1].url), "http://127.0.0.1:8765/" + path + "?" + query)
        self.assertTrue(_route("GET", path, {"limit"}))
        for name in ("include_candidates", "token", "unexpected"):
            self.assertFalse(_route("GET", path, {name}))
        self.assertFalse(_route("POST", path, set()))
        before = len(self.calls)
        response = await self.request(path + "?token=forbidden")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(len(self.calls), before)

    async def test_explicit_route_allowlist(self):
        self.assertTrue(_route("GET", "sessions/s1/files", {"limit"}))
        self.assertTrue(_route("POST", "agent/turn", set()))
        self.assertTrue(_route("POST", "agent/runs/run_1/interrupt", set()))
        self.assertTrue(_route("POST", "agent/runs/run_1/replace", set()))
        self.assertFalse(_route("POST", "agent/runs/run_1/interrupt", {"unexpected"}))
        self.assertFalse(_route("GET", "sessions/s1/files", {"arbitrary"}))
        self.assertFalse(_route("POST", "plugins/qq-ui/messages/send", set()))
        self.assertTrue(_route("DELETE", "matters/m1", {"expected_revision"}))
        self.assertTrue(_route("POST", "matters/m1/restore", set()))
        self.assertFalse(_route("DELETE", "matters/m1", {"arbitrary"}))
        self.assertTrue(_route("POST", "sessions/s1/workspace/materialize", set()))

    async def test_run_interrupt_and_replace_are_forwarded_same_origin(self):
        import json
        for path, payload in (
            ("agent/runs/run_1/interrupt", {}),
            ("agent/runs/run_1/replace", {
                "command_id": "replace-1",
                "user_input": "Continue with a different approach",
                "session_id": "session-1",
            }),
        ):
            response = await self.request(
                path, "POST", headers={"Origin": "http://127.0.0.1:8780"}, payload=payload)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(self.calls[-1].url.path, "/" + path)
            self.assertEqual(self.calls[-1].content, json.dumps(payload, separators=(",", ":")).encode())

    async def test_ipv4_peer_loopback_check_and_observed_memory_routes(self):
        from app.api.routes.workbench_proxy import _loopback
        self.assertFalse(_loopback("192.0.2.10"))
        self.assertTrue(_loopback("127.0.0.1"))
        self.assertTrue(_route("GET", "memories", {"scope", "include_candidates", "limit", "offset"}))
        self.assertTrue(_route("GET", "memories/learning", {"scope", "workspace_path"}))
        self.assertTrue(_route("DELETE", "memories/m1", {"workspace_path", "expected_version"}))
        self.assertTrue(_route("POST", "memories/file/import", {"scope", "workspace_path"}))
        self.assertTrue(_route("GET", "background/events", {"interval"}))

    async def test_image_routes_proxy_raw_bytes_metadata_and_raw_with_bounds(self):
        body = b"synthetic-image-bytes"
        async def upstream(request):
            self.calls.append(request)
            if request.url.path.endswith("/raw"):
                return httpx.Response(200, content=body, headers={"content-type": "image/png"})
            return httpx.Response(200, json={"attachment_id": "att_" + "a" * 32})
        self.transport = httpx.MockTransport(upstream)
        upload = await self.request("sessions/s1/attachments", "POST",
            headers={"Content-Type": "image/png", "X-Filename": "%E5%9B%BE.png"}, content=body)
        self.assertEqual(upload.status_code, 200)
        self.assertEqual(self.calls[0].content, body)
        self.assertEqual(self.calls[0].headers["x-filename"], "%E5%9B%BE.png")
        meta = await self.request("sessions/s1/attachments/att_" + "a" * 32)
        self.assertEqual(meta.status_code, 200)
        raw = await self.request("sessions/s1/attachments/att_" + "a" * 32 + "/raw")
        self.assertEqual(raw.content, body)
        with patch("app.api.routes.workbench_proxy._MAX_IMAGE_UPLOAD", 16):
            too_large = await self.request("sessions/s1/attachments", "POST",
                headers={"Content-Type": "image/png", "X-Filename": "x.png"}, content=b"x" * 17)
        self.assertEqual(too_large.status_code, 413)
        self.assertEqual(len(self.calls), 3)

    async def test_document_upload_accepts_over_64_mib_and_rejects_over_limit(self):
        body = b"d" * (64 * 1024 * 1024 + 1)
        async def upstream(request):
            self.calls.append(request)
            return httpx.Response(200, json={"attachment_id": "att_" + "b" * 32, "kind": "document"})
        self.transport = httpx.MockTransport(upstream)
        uploaded = await self.request("sessions/s1/attachments", "POST",
            headers={"Content-Type": "application/octet-stream", "X-Filename": "report.pdf"}, content=body)
        self.assertEqual(uploaded.status_code, 200)
        self.assertEqual(self.calls[0].content, body)
        self.assertEqual(self.calls[0].headers["x-filename"], "report.pdf")
        with patch("app.api.routes.workbench_proxy._MAX_DOCUMENT_UPLOAD", 16):
            too_large = await self.request("sessions/s1/attachments", "POST",
                headers={"Content-Type": "application/octet-stream", "X-Filename": "report.pdf"},
                content=b"d" * 17)
        self.assertEqual(too_large.status_code, 413)
        self.assertEqual(len(self.calls), 1)

    async def test_document_raw_preserves_download_header_and_bounds(self):
        filename = "report%20%E5%9B%BE.html"
        disposition = "attachment; filename*=UTF-8''" + filename
        body = b"<html><script>unsafe()</script></html>"
        async def upstream(_request):
            return httpx.Response(200, content=body, headers={
                "content-type": "text/html; charset=utf-8",
                "content-disposition": disposition,
            })
        self.transport = httpx.MockTransport(upstream)
        response = await self.request("sessions/s1/attachments/att_" + "c" * 32 + "/raw")
        self.assertEqual(response.content, body)
        self.assertEqual(response.headers.get("content-disposition"), disposition)
        self.assertIn("attachment", response.headers["content-disposition"])

        async def missing_disposition(_request):
            return httpx.Response(200, content=body, headers={"content-type": "text/html"})
        self.transport = httpx.MockTransport(missing_disposition)
        response = await self.request("sessions/s1/attachments/att_" + "c" * 32 + "/raw")
        self.assertEqual(response.headers.get("content-disposition"), "attachment")

        async def oversized_document(_request):
            return httpx.Response(200, content=b"x" * 17, headers={
                "content-type": "application/pdf", "content-disposition": disposition,
            })
        self.transport = httpx.MockTransport(oversized_document)
        with patch("app.api.routes.workbench_proxy._MAX_DOCUMENT_RESPONSE", 16):
            response = await self.request("sessions/s1/attachments/att_" + "c" * 32 + "/raw")
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "Workbench response too large")

    async def test_document_upload_errors_are_bounded_and_sanitized(self):
        async def upload_error(request):
            self.calls.append(request)
            return httpx.Response(422, json={"detail": "Invalid, encrypted or unreadable document, or no extractable text."})
        self.transport = httpx.MockTransport(upload_error)
        response = await self.request("sessions/s1/attachments", "POST",
            headers={"Content-Type": "application/octet-stream", "X-Filename": "report.pdf"}, content=b"x")
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "The document is unreadable or contains no extractable text.")
        async def unsupported(request):
            return httpx.Response(415, json={"detail": "Unsupported attachment file type."})
        self.transport = httpx.MockTransport(unsupported)
        response = await self.request("sessions/s1/attachments", "POST",
            headers={"Content-Type": "application/octet-stream", "X-Filename": "report.exe"}, content=b"x")
        self.assertEqual(response.status_code, 415)
        self.assertEqual(response.json()["detail"], "This document file type is not supported.")

    async def test_knowledge_file_type_catalog_route_is_allowlisted(self):
        self.assertTrue(_route("GET", "knowledge/file-types", set()))
        self.assertFalse(_route("GET", "knowledge/file-types", {"refresh"}))
        async def catalog(_request):
            return httpx.Response(200, json={"file_types": [{"extensions": [".pdf"], "index_supported": True}]})
        self.transport = httpx.MockTransport(catalog)
        response = await self.request("knowledge/file-types")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["file_types"][0]["index_supported"])

    async def test_image_raw_response_is_bounded(self):
        async def upstream(_request):
            return httpx.Response(200, content=b"x" * 17,
                                  headers={"content-type": "image/png"})
        self.transport = httpx.MockTransport(upstream)
        with patch("app.api.routes.workbench_proxy._MAX_IMAGE_RESPONSE", 16):
            response = await self.request("sessions/s1/attachments/att_" + "a" * 32 + "/raw")
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "Workbench response too large")

    async def test_image_validation_errors_are_sanitized(self):
        async def upstream(request):
            self.calls.append(request)
            return httpx.Response(422, json={"detail": "Selected model has not enabled image input (supports_vision)."})
        self.transport = httpx.MockTransport(upstream)
        response = await self.request("agent/turn", "POST", payload={"user_input": "x"})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "The selected model does not have image input enabled.")
        async def upload_error(request):
            return httpx.Response(413, json={"detail": "Image exceeds four million pixels."})
        self.transport = httpx.MockTransport(upload_error)
        response = await self.request("sessions/s1/attachments", "POST",
            headers={"Content-Type": "image/png", "X-Filename": "x.png"}, content=b"x")
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json()["detail"], "Image exceeds the four million pixel limit.")

    async def test_error_body_is_bounded_and_unexpected_vision_errors_stay_generic(self):
        stream = ChunkStream([b"{" + b"x" * 9000])
        async def oversized(_request):
            return httpx.Response(422, stream=stream)
        self.transport = httpx.MockTransport(oversized)
        response = await self.request("agent/turn", "POST", payload={"user_input": "x"})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["detail"], "workbench_request_failed")
        self.assertTrue(stream.closed)

        async def unrelated(_request):
            return httpx.Response(422, json={"detail": "Provider says supports_vision but private diagnostic"})
        self.transport = httpx.MockTransport(unrelated)
        response = await self.request("agent/turn", "POST", payload={"user_input": "x"})
        self.assertEqual(response.json()["detail"], "workbench_request_failed")

    async def test_manager_allowlist_and_safe_disabled_contract(self):
        self.assertTrue(_route("POST", "managers/default", set()))
        self.assertTrue(_route("GET", "managers/s1", set()))
        self.assertTrue(_route("PATCH", "managers/s1", set()))
        self.assertFalse(_route("POST", "managers", set()))
        self.assertFalse(_route("DELETE", "managers/s1", set()))
        self.assertTrue(_route("GET", "managers/s1/goals", set()))
        self.assertFalse(_route("POST", "managers/default", {"token"}))
        self.assertTrue(_route("GET", "matters", {"visibility"}))
        for status, detail, expected in [(409, "management_disabled", "management_disabled"),
                                          (401, "private credential diagnostic", "workbench_request_failed"),
                                          (409, {"private": "object"}, "workbench_request_failed")]:
            async def manager_error(_request):
                return httpx.Response(status, json={"detail": detail})
            self.transport = httpx.MockTransport(manager_error)
            response = await self.request("managers/default", "POST")
            self.assertEqual(response.status_code, status)
            self.assertEqual(response.json()["detail"], expected)

    async def test_busy_session_turn_conflict_preserves_only_safe_run_identity(self):
        busy = {"detail": "private provider diagnostic", "session_id": "session_1", "run_id": "run-2",
                "prompt": "private prompt", "credential": "private token", "nested": {"private": True}}
        async def busy_response(_request):
            return httpx.Response(409, json=busy)
        self.transport = httpx.MockTransport(busy_response)
        for path in ("agent/turn", "agent/turn/stream"):
            with self.subTest(path=path):
                response = await self.request(path, "POST", payload={"session_id": "session_1", "user_input": "synthetic"})
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json(), {"detail": "session_busy", "session_id": "session_1", "run_id": "run-2"})
                self.assertNotIn("private", response.text)
                self.assertEqual(response.headers["cache-control"], "no-store")
        for path, method in (("managers/default", "POST"), ("sessions/s1", "PATCH")):
            response = await self.request(path, method, payload={})
            self.assertEqual(response.json(), {"detail": "workbench_request_failed"})

    async def test_busy_session_ids_require_exact_bounded_strings_and_conflict_status(self):
        cases = [
            (409, {"session_id": "s1"}),
            (409, {"session_id": "s1", "run_id": "r/secret"}),
            (409, {"session_id": "s1", "run_id": "r" * 201}),
            (409, {"session_id": 12, "run_id": "r1"}),
            (409, {"session_id": "s1", "run_id": {"secret": True}}),
            (409, {"session_id": "s1", "run_id": "r1\n"}),
            (422, {"session_id": "s1", "run_id": "r1"}),
        ]
        for status, fields in cases:
            with self.subTest(status=status, fields=fields):
                async def unsafe_response(_request):
                    return httpx.Response(status, json={"detail": "private", **fields})
                self.transport = httpx.MockTransport(unsafe_response)
                response = await self.request("agent/turn/stream", "POST", payload={"user_input": "synthetic"})
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json(), {"detail": "workbench_request_failed"})

    async def test_deleted_default_manager_conflict_maps_to_safe_code(self):
        async def deleted_response(_request):
            return httpx.Response(409, json={
                "detail": "Default management session is unavailable; restore or explicitly replace it",
                "session_id": "private_deleted_session", "private": "private diagnostic"})
        self.transport = httpx.MockTransport(deleted_response)
        response = await self.request("managers/default", "POST")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "default_manager_deleted"})
        response = await self.request("managers/s1")
        self.assertEqual(response.json(), {"detail": "workbench_request_failed"})

    async def test_global_assistant_read_routes_forward_only_exact_pagination(self):
        routes = [
            ("managers/s1/goals", "limit=20&offset=40"),
            ("managers/s1/events", "after=7&limit=20"),
            ("managers/s1/executions", "after=7&limit=20"),
            ("managers/s1/deliveries", "after=7&limit=20"),
            ("sessions/s1/runs", "limit=20&offset=40"),
        ]
        for path, query in routes:
            with self.subTest(path=path):
                response = await self.request(path + "?" + query, headers={"Authorization": "Bearer browser-secret"})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(str(self.calls[-1].url), "http://127.0.0.1:8765/" + path + "?" + query)
                self.assertNotIn("authorization", self.calls[-1].headers)
                self.assertTrue(_route("GET", path, set()))
                for method in ("POST", "PATCH", "PUT", "DELETE"):
                    self.assertFalse(_route(method, path, set()))
                self.assertFalse(_route("GET", path + "/private", set()))
                self.assertFalse(_route("GET", path, {"token"}))
        self.assertFalse(_route("GET", "managers/s1/goals", {"after"}))
        self.assertFalse(_route("GET", "managers/s1/events", {"offset"}))
        self.assertFalse(_route("GET", "managers/s1/executions", {"status"}))
        self.assertFalse(_route("GET", "sessions/s1/runs", {"after"}))
        self.assertFalse(_route("GET", "managers/s1/goals/g1", set()))
        self.assertFalse(_route("GET", "managers/s1/unknown", set()))
        before = len(self.calls)
        for path in ("managers/s1/events?offset=1", "managers/s1/goals/g1", "sessions/s1/runs?token=private"):
            response = await self.request(path)
            self.assertEqual(response.status_code, 404)
        self.assertEqual(len(self.calls), before, "rejected routes never reach the backend")

    async def test_global_assistant_controller_patch_preserves_revision_and_body(self):
        payload = {"expected_revision": 7, "status": "paused"}
        response = await self.request("managers/s1", "PATCH", payload=payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.calls[-1].method, "PATCH")
        self.assertEqual(str(self.calls[-1].url), "http://127.0.0.1:8765/managers/s1")
        import json
        self.assertEqual(json.loads(self.calls[-1].content), payload)
        self.assertFalse(_route("PATCH", "managers/s1", {"expected_revision"}))

    async def test_image_route_allowlist_is_narrow(self):
        self.assertTrue(_route("POST", "sessions/s1/attachments", set()))
        self.assertTrue(_route("GET", "sessions/s1/attachments/att_" + "a" * 32 + "/raw", set()))
        self.assertFalse(_route("DELETE", "sessions/s1/attachments/att_" + "a" * 32, set()))
        self.assertFalse(_route("GET", "sessions/s1/attachments/att_bad/raw", set()))


if __name__ == "__main__":
    unittest.main()
