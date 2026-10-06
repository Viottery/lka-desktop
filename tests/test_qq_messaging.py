"""Deterministic QQ interface acceptance; no real QQ or backend connections."""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import FastAPI
import httpx

from app.api.routes.plugins import router
from app.api.routes.qq_messaging import events
from app.plugins.lifecycle import start_qq_messaging, stop_qq_messaging
from app.plugins.qq_actions import QQActionClient, QQActionConfig
from app.plugins.qq_messaging import QQMessaging, QQMessagingConfig, MessagingError
from app.plugins.message_media import generated_path
from app.plugins.message_media import checked_addresses

PNG = b"\x89PNG\r\n\x1a\n" + b"test-media-payload"
GIF = b"GIF89a" + b"test-sticker-payload"
MP4 = b"\x00\x00\x00\x18ftypmp42" + b"test-video-payload"


class MessagingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        self.calls = []
        self.mode = "ok"
        self.login = "123456"
        self.config = QQMessagingConfig(enabled=True, send_enabled=True, api_token="a"*32,
            expected_self_id="123456", ws_token="event-secret", action_token="action-secret",
            db_path=Path(self.tmp.name)/"messages.db", media_dir=Path(self.tmp.name)/"media",
            image_max=512, video_max=1024, media_max=8192)
        def gateway(request):
            self.assertEqual(request.headers["Authorization"], "Bearer action-secret")
            action = request.url.path[1:]
            params = json.loads(request.content)
            self.calls.append((action, params))
            if action == "get_login_info":
                data = {"user_id": self.login}
            elif action == "fetch_custom_face":
                data = ["emoji_1", "bad/url", {"emoji_id": "emoji_2", "url": "private-url"}]
            else:
                if self.mode == "timeout":
                    raise httpx.ReadTimeout("private-message-secret", request=request)
                if self.mode == "failed":
                    return httpx.Response(200, json={"status":"failed", "retcode":1400, "message":"secret", "data":None})
                if self.mode == "bad_receipt":
                    data = {}
                else:
                    data = {"message_id": -len(self.calls)}
            return httpx.Response(200, json={"status":"ok", "retcode":0, "data":data})
        self.gateway = httpx.MockTransport(gateway)
        self.service = self.new_service()
        self.service.initialize()
        self.service.set_policy("private", "88888", True, True)
        self.service.set_policy("group", "99999", True, True)
        self.app = FastAPI()
        self.app.include_router(router)
        self.app.state.qq_messaging = self.service

    def new_service(self, config=None):
        config = config or self.config
        client = QQActionClient(QQActionConfig(config.action_url, config.action_token, config.expected_self_id), transport=self.gateway)
        return QQMessaging(config, client=client)

    async def asyncTearDown(self):
        await self.service.stop()
        self.tmp.cleanup()

    async def req(self, method, path, *, headers=None, peer="127.0.0.1", host="127.0.0.1:8780", **kwargs):
        auth = {"Authorization":"Bearer " + self.config.api_token}
        auth.update(headers or {})
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=(peer,1234)), base_url="http://"+host) as client:
            return await client.request(method, "/plugins/qq-messaging" + path, headers=auth, **kwargs)

    def event(self, mid=100, **kwargs):
        value = {"self_id":123456, "post_type":"message", "message_type":"private", "user_id":88888,
                 "message_id":mid, "time":100, "sender":{"user_id":88888, "nickname":"好友"},
                 "message":[{"type":"text","data":{"text":"你好"}}]}
        value.update(kwargs)
        return value

    async def uploaded(self, kind, data):
        result = await self.req("POST", "/media/"+kind, content=data)
        self.assertEqual(result.status_code, 201, result.text)
        return result.json()["id"]

    async def send(self, values, key="message_key_001", kind="private", target="88888"):
        return await self.req("POST", "/messages/send", headers={"Idempotency-Key":key},
                              json={"conversation_type":kind, "conversation_id":target, "segments":values})

    async def test_auth_origin_and_local_boundaries(self):
        for kwargs in ({"headers":{"Authorization":""}}, {"headers":{"Authorization":"Bearer wrong"}}):
            self.assertEqual((await self.req("GET", "/status", **kwargs)).status_code, 401)
        for kwargs in ({"peer":"192.168.1.2"}, {"host":"evil.test"},
                       {"headers":{"Origin":"http://evil.test"}}, {"headers":{"Sec-Fetch-Site":"cross-site"}},
                       {"headers":{"Sec-Fetch-Site":"same-site"}}):
            self.assertEqual((await self.req("GET", "/status", **kwargs)).status_code, 403)
        ok = await self.req("GET", "/status", headers={"Origin":"http://127.0.0.1:8780"})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.headers["cache-control"], "no-store")
        self.assertNotIn("secret", ok.text)
        self.assertNotIn("123456", ok.text)

    async def test_disabled_has_no_io_and_does_not_break_lifecycle(self):
        missing = Path(self.tmp.name)/"never-created.db"
        disabled = QQMessaging(replace(self.config, enabled=False, db_path=missing))
        await disabled.start()
        self.assertFalse(missing.exists())
        self.app.state.qq_messaging = disabled
        self.assertEqual((await self.req("GET", "/status")).status_code, 503)
        with patch("app.plugins.qq_messaging.QQMessagingConfig.from_env", side_effect=ValueError("secret")):
            await start_qq_messaging(self.app)
            await stop_qq_messaging(self.app)
            self.assertEqual((await self.req("GET", "/status")).status_code, 503)

    async def test_configuration_rejects_nonlocal_and_universal_socket(self):
        for url in ("ws://192.168.1.1:3001/event", "ws://127.0.0.1:3001/", "ws://127.0.0.1:3001/event?token=bad"):
            bad = self.new_service(replace(self.config, ws_url=url))
            with self.assertRaises(MessagingError):
                bad.initialize()
        with self.assertRaises(MessagingError):
            self.new_service(replace(self.config, api_token="short")).initialize()

    async def test_default_deny_and_boolean_policy(self):
        denied = await self.req("GET", "/messages?conversation_type=private&conversation_id=77777")
        self.assertEqual(denied.status_code, 403)
        self.assertIsNone(self.service.ingest(self.event(user_id=77777)))
        self.assertEqual((await self.send([{"type":"text","text":"hello"}], target="77777")).status_code, 403)
        bad = await self.req("PUT", "/conversations/private/77777", json={"receive_enabled":"true", "send_enabled":True})
        self.assertEqual(bad.status_code, 400)
        good = await self.req("PUT", "/conversations/private/77777", json={"receive_enabled":True, "send_enabled":False})
        self.assertEqual(good.status_code, 200)

    async def test_receive_dedup_persistence_cursor_group_name(self):
        self.service.ingest(json.dumps(self.event()))
        self.service.ingest(self.event())
        self.service.ingest(self.event(101))
        first = self.service.messages("private", "88888", 0, 1)
        second = self.service.messages("private", "88888", first["next_cursor"], 10)
        self.assertEqual(len(first["messages"]), 1)
        self.assertEqual(len(second["messages"]), 1)
        restarted = self.new_service()
        restarted.initialize()
        self.assertEqual(len(restarted.messages("private", "88888")["messages"]), 2)
        self.service.ingest(self.event(102, message_type="group", group_id=99999,
                            sender={"user_id":88888,"card":"群名片","nickname":"昵称"}))
        self.assertEqual(self.service.messages("group", "99999")["messages"][0]["sender_name"], "群名片")

    async def test_event_account_type_size_and_json_checks(self):
        for event in (self.event(self_id=222222), self.event(self_id=None), "{bad", "x"*(256*1024+1)):
            with self.assertRaises(MessagingError):
                self.service.ingest(event)
        for kind in ("notice", "request", "meta_event"):
            self.assertIsNone(self.service.ingest(self.event(post_type=kind)))
        self.assertEqual(self.service.messages("private", "88888")["messages"], [])

    async def test_message_sent_and_cq_normalization(self):
        self.service.ingest(self.event(post_type="message_sent", user_id=123456, target_id=88888,
                sender={"user_id":123456}, message="hi &amp; [CQ:face,id=0][CQ:image,url=https://gxh.vip.qq.com/a.gif,sub_type=1]"))
        msg = self.service.messages("private", "88888")["messages"][0]
        self.assertEqual(msg["direction"], "outgoing")
        self.assertEqual(msg["segments"][0]["text"], "hi & ")
        self.assertEqual(msg["segments"][2]["type"], "sticker")
        self.assertNotIn("https://", json.dumps(msg))

    async def test_receive_all_requested_media_types_without_raw_urls(self):
        values = [{"type":"text","data":{"text":"test"}}, {"type":"image","data":{"url":"https://x.qpic.cn/a?private=1"}},
                  {"type":"video","data":{"url":"https://x.qpic.cn/v"}},
                  {"type":"image","data":{"url":"https://gxh.vip.qq.com/club/item/parcel/item/x/y/raw300.gif","emoji_id":"12"}},
                  {"type":"face","data":{"id":0}}]
        self.service.ingest(self.event(message=values))
        result = await self.req("GET", "/messages?conversation_type=private&conversation_id=88888")
        self.assertEqual([x["type"] for x in result.json()["messages"][0]["segments"]], ["text","image","video","sticker","face"])
        for secret in ("https://", "qpic.cn", "private=1", "raw_event"):
            self.assertNotIn(secret, result.text)

    async def test_media_upload_content_hash_and_invalid_files(self):
        mid = await self.uploaded("image", PNG)
        result = await self.req("GET", "/media/"+mid)
        self.assertEqual(result.content, PNG)
        self.assertEqual(result.headers["content-type"], "image/png")
        self.assertEqual(result.headers["x-content-type-options"], "nosniff")
        for kind, data, status in (("image", b"<svg>bad</svg>",415), ("video",PNG,415), ("sticker", b"file:///C:/secret",415), ("image",PNG+b"x"*512,413)):
            self.assertEqual((await self.req("POST", "/media/"+kind, content=data)).status_code, status)
        self.assertEqual((await self.req("GET", "/media/../.env")).status_code, 404)
        self.assertEqual(len(list(self.config.media_dir.glob("*.tmp"))), 0)

    async def test_send_text_media_face_and_custom_sticker_protocol(self):
        image = await self.uploaded("image", PNG)
        video = await self.uploaded("video", MP4)
        sticker = await self.uploaded("sticker", GIF)
        segments = [{"type":"text","text":"[CQ:at,qq=all] is literal"}, {"type":"image","media_id":image},
                    {"type":"sticker","media_id":sticker}, {"type":"face","id":"0"},
                    {"type":"at","qq":"88888"}, {"type":"reply","id":"-123"}]
        result = await self.send(segments, kind="group", target="99999")
        self.assertEqual(result.json()["state"], "accepted", result.text)
        action, params = self.calls[-1]
        self.assertEqual(action, "send_msg")
        self.assertEqual(params["group_id"], 99999)
        self.assertEqual(params["message"][0]["data"]["text"], "[CQ:at,qq=all] is literal")
        self.assertTrue(params["message"][1]["data"]["file"].startswith("file:///"))
        self.assertEqual(params["message"][2]["data"]["sub_type"], 1)
        self.assertEqual(self.calls[-2][0], "get_login_info")
        video_result = await self.send([{"type":"video","media_id":video}], "video_key_001")
        self.assertEqual(video_result.json()["state"], "accepted")
        self.assertTrue(self.calls[-1][1]["message"][0]["data"]["file"].endswith(".mp4"))
        custom = await self.send([{"type":"custom_face","emoji_id":"emoji_1"}], "custom_key_001")
        self.assertEqual(custom.json()["state"], "accepted")
        self.assertEqual(self.calls[-1], ("send_custom_face", {"emoji_id":"emoji_1", "user_id":88888}))
        favorites = await self.req("GET", "/stickers")
        self.assertEqual(favorites.json()["stickers"], [{"emoji_id":"emoji_1"},{"emoji_id":"emoji_2"}])
        self.assertNotIn("private-url", favorites.text)

    async def test_send_key_is_durable_and_conflicts_rejected(self):
        segments = [{"type":"text","text":"hello"}]
        first, duplicate = await asyncio.gather(self.send(segments), self.send(segments))
        self.assertEqual(first.json(), duplicate.json())
        self.assertEqual(sum(action == "send_msg" for action,_ in self.calls), 1)
        conflict = await self.send([{"type":"text","text":"different"}])
        self.assertEqual(conflict.status_code, 409)
        restarted = self.new_service()
        restarted.initialize()
        self.assertEqual(await restarted.send("message_key_001", "private", "88888", segments), first.json())
        receipt = await self.req("GET", "/sends/message_key_001")
        self.assertEqual(receipt.json()["state"], "accepted")

    async def test_timeout_unknown_never_retries_explicit_failure_failed(self):
        self.mode = "timeout"
        segments = [{"type":"text","text":"hello"}]
        result = await self.send(segments)
        self.assertEqual(result.json()["state"], "unknown")
        self.assertNotIn("private-message-secret", result.text)
        await self.send(segments)
        self.assertEqual(sum(action == "send_msg" for action,_ in self.calls), 1)
        self.mode = "failed"
        result = await self.send(segments, "failure_key_001")
        self.assertEqual(result.json()["state"], "failed")
        self.assertNotIn("secret", result.text)
        self.mode = "bad_receipt"
        self.assertEqual((await self.send(segments, "missing_key_001")).json()["state"], "unknown")

    async def test_account_mismatch_prevents_send(self):
        self.login = "654321"
        result = await self.send([{"type":"text","text":"hello"}])
        self.assertEqual(result.json()["state"], "failed")
        self.assertEqual(result.json()["error"], "account_mismatch")
        self.assertEqual([a for a,_ in self.calls], ["get_login_info"])

    async def test_send_disabled_and_missing_key_paths_urls_rejected(self):
        self.service.config = replace(self.config, send_enabled=False)
        self.assertEqual((await self.send([{"type":"text","text":"hello"}])).status_code, 403)
        self.service.config = self.config
        for values in ([{"type":"image","file":"file:///C:/secret"}], [{"type":"video","media_id":"https://evil/a"}],
                       [{"type":"custom_face","emoji_id":"../../secret"}], [{"type":"text","text":""}], [{"type":"action","action":"delete_msg"}]):
            result = await self.send(values)
            self.assertIn(result.status_code, (400,404))
        self.assertEqual(self.calls, [])
        result = await self.req("POST", "/messages/send", json={"conversation_type":"private","conversation_id":"88888","segments":[{"type":"text","text":"hello"}]})
        self.assertEqual(result.status_code, 400)

    async def test_restart_pending_becomes_unknown_without_retry(self):
        with self.service.db() as db:
            db.execute("INSERT INTO sends VALUES (?,?,'digest','pending',NULL,NULL,'now')", (self.service.account,"pending_key_001"))
        restarted = self.new_service()
        restarted.initialize()
        self.assertEqual(restarted.send_receipt("pending_key_001")["state"], "unknown")
        self.assertEqual(self.calls, [])

    async def test_cancelled_send_records_unknown(self):
        reached = asyncio.Event()
        async def hang(*args):
            reached.set()
            await asyncio.Event().wait()
        self.service.client.call = hang
        task = asyncio.create_task(self.service.send("cancel_key_001", "private","88888",[{"type":"text","text":"hello"}]))
        await reached.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.service.send_receipt("cancel_key_001")["state"], "unknown")

    async def test_cache_received_provenance_and_revocation(self):
        self.service.ingest(self.event(message=[{"type":"image","data":{"url":"https://x.qpic.cn/a"}}]))
        seq = self.service.messages("private","88888")["messages"][0]["seq"]
        def fake_download(url, directory, key, limit, timeout, kind, permitted, **kwargs):
            self.assertTrue(permitted())
            generated_path(directory,key).write_bytes(PNG)
            return {"mime_type":"image/png","size_bytes":len(PNG),"sha256":"0"*64}
        with patch("app.plugins.qq_messaging.download", side_effect=fake_download):
            result = await self.req("POST", f"/messages/{seq}/media/0/cache")
        self.assertEqual(result.status_code, 200, result.text)
        mid = result.json()["id"]
        self.assertEqual((await self.req("GET", "/media/"+mid)).status_code, 200)
        self.service.set_policy("private","88888",False,True)
        self.assertEqual((await self.req("GET", "/media/"+mid)).status_code, 403)
        self.assertEqual((await self.req("POST", f"/messages/{seq}/media/0/cache")).status_code, 403)

    async def test_media_account_isolation_and_quota(self):
        mid = await self.uploaded("image", PNG)
        other = self.new_service(replace(self.config, expected_self_id="765432"))
        other.initialize()
        with self.assertRaises(MessagingError) as error:
            other.media(mid)
        self.assertEqual(error.exception.code, "media_not_found")
        (self.config.media_dir/"orphan.bin").write_bytes(b"x"*8192)
        self.assertEqual((await self.req("POST", "/media/image", content=PNG)).status_code, 507)

    async def test_message_queue_limit(self):
        self.service.config = replace(self.config, message_max=1)
        self.service.ingest(self.event())
        with self.assertRaises(MessagingError) as error:
            self.service.ingest(self.event(101))
        self.assertEqual(error.exception.code, "local_queue_full")
        self.assertEqual((await self.send([{"type":"text","text":"hello"}])).status_code, 507)
        self.assertEqual(self.calls, [])

    async def test_gateway_video_and_private_mention_constraints(self):
        video = await self.uploaded("video", MP4)
        self.assertEqual((await self.send([{"type":"video","media_id":video}, {"type":"text","text":"hello"}])).status_code, 400)
        self.assertEqual((await self.send([{"type":"at","qq":"88888"}])).status_code, 400)
        self.assertEqual(self.calls, [])

    async def test_official_sticker_cdn_extension_preserves_reader_policy(self):
        addresses = [(2,1,6,"",("8.8.8.8",443))]
        url = "https://gxh.vip.qq.com/club/item/parcel/item/x/y/raw300.gif"
        with patch("app.plugins.message_media.socket.getaddrinfo", return_value=addresses):
            with self.assertRaises(ValueError):
                checked_addresses(url)
            self.assertEqual(checked_addresses(url, extra_hosts=("gxh.vip.qq.com",))[0].hostname, "gxh.vip.qq.com")
            for unsafe in ("https://gxh.vip.qq.com.evil.test/a", "http://gxh.vip.qq.com/a", "https://user:secret@gxh.vip.qq.com/a"):
                with self.assertRaises(ValueError):
                    checked_addresses(unsafe, extra_hosts=("gxh.vip.qq.com",))
        with patch("app.plugins.message_media.socket.getaddrinfo", return_value=[(2,1,6,"",("127.0.0.1",443))]):
            with self.assertRaises(ValueError):
                checked_addresses(url, extra_hosts=("gxh.vip.qq.com",))

    async def test_cancelled_cache_waits_for_worker_and_cleans_files(self):
        import threading
        entered, release = threading.Event(), threading.Event()
        self.service.ingest(self.event(message=[{"type":"image","data":{"url":"https://x.qpic.cn/a"}}]))
        seq = self.service.messages("private","88888")["messages"][0]["seq"]
        def delayed(url,directory,key,*args,**kwargs):
            entered.set()
            release.wait(3)
            generated_path(directory,key).write_bytes(PNG)
            return {"mime_type":"image/png","size_bytes":len(PNG),"sha256":"0"*64}
        with patch("app.plugins.qq_messaging.download", side_effect=delayed):
            task = asyncio.create_task(self.service.cache_received(seq,0))
            await asyncio.to_thread(entered.wait,3)
            task.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(list(self.config.media_dir.iterdir()), [])

    async def test_revocation_during_cache_never_exposes_file(self):
        self.service.ingest(self.event(message=[{"type":"image","data":{"url":"https://x.qpic.cn/a"}}]))
        seq = self.service.messages("private","88888")["messages"][0]["seq"]
        def revoke(url,directory,key,*args,**kwargs):
            generated_path(directory,key).write_bytes(PNG)
            self.service.set_policy("private","88888",False,True)
            return {"mime_type":"image/png","size_bytes":len(PNG),"sha256":"0"*64}
        with patch("app.plugins.qq_messaging.download", side_effect=revoke):
            result = await self.req("POST",f"/messages/{seq}/media/0/cache")
        self.assertEqual(result.status_code,403)
        self.assertEqual(list(self.config.media_dir.iterdir()), [])

    async def test_json_body_limit_and_contract(self):
        self.assertEqual((await self.req("POST", "/messages/send", content=b"invalid")).status_code, 415)
        self.assertEqual((await self.req("POST", "/messages/send", headers={"Content-Type":"application/json"}, content=b"{" )).status_code, 400)
        for invalid in (b'{"x":NaN}', b'{"x":"\\ud800"}'):
            self.assertEqual((await self.req("POST", "/messages/send", headers={"Content-Type":"application/json"}, content=invalid)).status_code, 400)
        self.assertEqual((await self.req("POST", "/messages/send", headers={"Content-Type":"application/json"}, content=b"x"*(128*1024+1))).status_code, 413)
        self.assertEqual((await self.req("GET", "/messages?conversation_type=private&conversation_id=88888&limit=101")).status_code, 422)

    async def test_sse_uses_durable_cursor(self):
        self.service.ingest(self.event())
        class Request:
            async def is_disconnected(self):
                return False
        response = await events(Request(), "private","88888",0,self.service)
        value = await anext(response.body_iterator)
        self.assertIn("event: message", value)
        self.assertIn('"message_id":"100"', value)
        self.assertNotIn("secret", value)
        await response.body_iterator.aclose()

    async def test_websocket_receives_no_actions_account_mismatch_stops(self):
        service = self.new_service()
        frames = [json.dumps(self.event(100)), json.dumps(self.event(101,self_id=654321))]
        class Socket:
            async def __aenter__(self): return self
            async def __aexit__(self,*args): pass
            def __aiter__(self): return self
            async def __anext__(self):
                if not frames: raise StopAsyncIteration
                return frames.pop(0)
            async def send(self,*args): raise AssertionError("receiver must not send actions")
        def connect(url, **kwargs):
            self.assertEqual(kwargs["additional_headers"]["Authorization"], "Bearer event-secret")
            self.assertEqual(kwargs["max_size"], 256*1024)
            return Socket()
        service.connector = connect
        await service.start()
        await asyncio.wait_for(service._task, 3)
        self.assertEqual(service.last_error, "account_mismatch")
        self.assertEqual(service.connection_state, "stopped")
        self.assertEqual(len(service.messages("private","88888")["messages"]), 1)
        await service.stop()


if __name__ == "__main__":
    unittest.main()
