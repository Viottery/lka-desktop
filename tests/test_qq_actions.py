import asyncio
import json
import unittest

import httpx

from app.plugins.qq_actions import QQActionClient, QQActionConfig, QQActionError, MAX_RESPONSE_BYTES


def ok(data):
    return httpx.Response(200, json={"status": "ok", "retcode": 0, "data": data})


class QQActionTests(unittest.IsolatedAsyncioTestCase):
    def client(self, handler, **config):
        return QQActionClient(QQActionConfig(token="private-token", expected_self_id="123", **config),
                              transport=httpx.MockTransport(handler))

    async def error(self, coro, code, status=None):
        with self.assertRaises(QQActionError) as caught:
            await coro
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(caught.exception.status_code, status)
        self.assertEqual(str(caught.exception), code)
        return caught.exception

    async def test_account_integer_and_string_and_array_results(self):
        for identifier in (123, "123"):
            client = self.client(lambda req: ok({"user_id": identifier}))
            self.assertTrue(await client.verify_account())
        data = ["first", "second"]
        self.assertEqual(await self.client(lambda req: ok(data)).call("fetch_custom_face", {}), data)

    async def test_send_verifies_account_then_sends_bearer_and_exact_payload(self):
        calls = []
        def handler(request):
            self.assertEqual(request.headers["Authorization"], "Bearer private-token")
            calls.append((request.url.path, json.loads(request.content)))
            return ok({"user_id": 123} if request.url.path == "/get_login_info" else {"message_id": "7"})
        params = {"user_id": "999", "message": [{"type": "text", "data": {"text": "hello"}}]}
        self.assertEqual(await self.client(handler).call("send_msg", params), {"message_id": "7"})
        self.assertEqual(calls, [("/get_login_info", {}), ("/send_msg", params)])

    async def test_sticker_and_send_each_check_account(self):
        calls = []
        def handler(request):
            calls.append(request.url.path)
            return ok({"user_id": "123"} if request.url.path == "/get_login_info" else {"message_id": 7})
        client = self.client(handler)
        await client.call("send_custom_face", {"user_id": 999, "emoji_id": "id"})
        await client.call("send_msg", {"user_id": 999, "message": "test"})
        self.assertEqual(calls, ["/get_login_info", "/send_custom_face", "/get_login_info", "/send_msg"])

    async def test_account_mismatch_and_invalid_account_prevent_write(self):
        for identifier, code in (("wrong", "account_mismatch"), (True, "protocol_error"), (None, "protocol_error")):
            calls = []
            def handler(request):
                calls.append(request.url.path)
                return ok({"user_id": identifier})
            await self.error(self.client(handler).call("send_msg", {"message": "test"}), code)
            self.assertEqual(calls, ["/get_login_info"])

    async def test_http200_retcode_failure_is_sanitized(self):
        client = self.client(lambda req: httpx.Response(200, json={
            "status": "failed", "retcode": 100, "message": "private-token/body/secret", "data": None}))
        await self.error(client.call("get_msg", {"message_id": 1}), "action_failed", 200)

    async def test_redirect_and_auth_rejected_without_follow_or_send(self):
        for status, code in ((302, "protocol_error"), (401, "auth_error"), (403, "auth_error"), (500, "action_failed")):
            calls = []
            def handler(request):
                calls.append(request.url.path)
                return httpx.Response(status, headers={"Location": "http://remote.invalid/secret"}, text="secret")
            await self.error(self.client(handler).call("send_msg", {}), code, status)
            self.assertEqual(calls, ["/get_login_info"])

    async def test_timeout_send_is_never_retried(self):
        calls = []
        def handler(request):
            calls.append(request.url.path)
            if request.url.path == "/get_login_info":
                return ok({"user_id": 123})
            raise httpx.ReadTimeout("private-token/url", request=request)
        await self.error(self.client(handler).call("send_msg", {}), "timeout")
        self.assertEqual(calls, ["/get_login_info", "/send_msg"])

    async def test_network_error_sanitized(self):
        def handler(request):
            raise httpx.ConnectError("private-token/url", request=request)
        await self.error(self.client(handler).call("get_login_info", {}), "network_error")

    async def test_protocol_and_size_bound(self):
        for body in (b"not json", b"[]", b'{"status":"ok","retcode":false,"data":{}}',
                     b'{"status":"ok","retcode":0}', b"x" * (MAX_RESPONSE_BYTES + 1)):
            await self.error(self.client(lambda req: httpx.Response(200, content=body)).call("get_msg", {}),
                             "protocol_error", 200)

    async def test_oversized_stream_stops_before_consuming_remaining_data(self):
        class LargeStream(httpx.AsyncByteStream):
            reads = 0
            closed = False
            async def __aiter__(self):
                for _ in range(32):
                    self.reads += 1
                    yield b"x" * (64 * 1024)
            async def aclose(self):
                self.closed = True
        stream = LargeStream()
        await self.error(self.client(lambda req: httpx.Response(200, stream=stream)).call("get_msg", {}),
                         "protocol_error", 200)
        self.assertEqual(stream.reads, 17)
        self.assertTrue(stream.closed)

    async def test_send_retcode_failure_is_never_retried(self):
        calls = []
        def handler(request):
            calls.append(request.url.path)
            if request.url.path == "/get_login_info":
                return ok({"user_id": 123})
            return httpx.Response(200, json={"status": "failed", "retcode": 100, "data": None})
        await self.error(self.client(handler).call("send_msg", {}), "action_failed", 200)
        self.assertEqual(calls, ["/get_login_info", "/send_msg"])

    async def test_concurrent_calls_isolate_results_and_snapshot_payload(self):
        pending = asyncio.Event()
        async def handler(request):
            if request.url.path == "/get_login_info":
                await pending.wait()
                return ok({"user_id": 123})
            params = json.loads(request.content)
            await asyncio.sleep(0)
            return ok(params)
        client = self.client(handler)
        params = {"user_id": 999, "message": [{"type": "text", "data": {"text": "original"}}]}
        send = asyncio.create_task(client.call("send_msg", params))
        await asyncio.sleep(0)
        params["message"][0]["data"]["text"] = "changed"
        pending.set()
        results = await asyncio.gather(send, *[client.call("get_msg", {"message_id": n}) for n in range(10)])
        self.assertEqual(results[0]["message"][0]["data"]["text"], "original")
        self.assertEqual(results[1:], [{"message_id": n} for n in range(10)])

    async def test_unknown_actions_and_invalid_params_never_call_transport(self):
        def handler(request):
            self.fail("Unexpected HTTP request")
        client = self.client(handler)
        await self.error(client.call("delete_msg", {}), "unsupported_action")
        await self.error(client.call("fetch_custom_face_details", {}), "unsupported_action")
        await self.error(client.call("get_msg", []), "invalid_params")
        await self.error(client.call("get_msg", {"x": float("nan")}), "invalid_params")

    def test_config_local_http_and_secret_repr(self):
        for url in ("https://127.0.0.1:3002", "http://192.168.1.1", "http://example.org",
                    "http://u:p@127.0.0.1", "http://127.0.0.1?token=x", "http://127.0.0.1#x",
                    "http://127.0.0.1/api", "http://127.0.0.1:0", "http://127.0.0.1:99999"):
            with self.assertRaises(QQActionError):
                self.client(lambda req: ok({}), url=url)
        for url in ("http://127.0.0.1:3002", "http://localhost:3002", "http://[::1]:3002"):
            self.client(lambda req: ok({}), url=url)
        for token, account in (("", "123"), ("bad\nheader", "123"), ("x", ""), ("x", True)):
            with self.assertRaises(QQActionError):
                QQActionClient(QQActionConfig(token=token, expected_self_id=account))
        config = QQActionConfig(token="secret-secret", expected_self_id="hidden-account")
        self.assertNotIn("secret-secret", repr(config))
        self.assertNotIn("hidden-account", repr(config))


if __name__ == "__main__":
    unittest.main()
