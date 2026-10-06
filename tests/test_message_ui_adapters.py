"""Synthetic local UI/credential/media checks; never connect QQ or production."""
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from tempfile import TemporaryDirectory

import httpx
from fastapi import FastAPI
from app.api.routes.plugins import router
from app.plugins.qq_messaging import QQMessaging, QQMessagingConfig

RealClient = httpx.AsyncClient
PNG = b"\x89PNG\r\n\x1a\nhello"


class BodyStream(httpx.AsyncByteStream):
    def __init__(self, body): self.body, self.closed = body, False
    async def __aiter__(self):
        yield self.body[:5]
        yield self.body[5:]
    async def aclose(self): self.closed = True


class UIAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = TemporaryDirectory()
        config=QQMessagingConfig(enabled=True,send_enabled=True,api_token="private-api-token"*3,
            expected_self_id="123456",ws_token="private-event-token",action_token="private-action-token",
            db_path=Path(self.tmp.name)/"message.db",media_dir=Path(self.tmp.name)/"media")
        self.calls=[]
        class Client:
            async def call(inner,action,params):
                self.calls.append((action,params));return {"message_id":123}
        self.service=QQMessaging(config,client=Client());self.service.initialize()
        self.service.set_policy("private","88888",True,True)
        self.app=FastAPI();self.app.include_router(router);self.app.state.qq_messaging=self.service

    async def asyncTearDown(self): self.tmp.cleanup()

    async def request(self,path,method="GET",headers=None,host="127.0.0.1:8780",peer="127.0.0.1",**kwargs):
        async with RealClient(transport=httpx.ASGITransport(app=self.app,client=(peer,1)),base_url="http://"+host) as client:
            return await client.request(method,path,headers=headers,**kwargs)

    async def test_status_and_capabilities_work_disabled_without_leaking_credentials(self):
        with patch.dict(os.environ,{"LKA_MESSAGES_CONTROL_TOKEN":"private-control-token"}):
            result=await self.request("/plugins/qq-ui/status")
        self.assertTrue(result.json()["reading_paired"])
        self.assertNotIn("private-",result.text)
        self.assertEqual(result.headers["cache-control"],"no-store")
        self.app.state.qq_messaging=None
        self.assertFalse((await self.request("/plugins/qq-ui/status")).json()["enabled"])
        self.assertEqual((await self.request("/plugins/qq-ui/capabilities")).status_code,200)

    async def test_cross_site_host_peer_and_simple_forms_denied(self):
        for kwargs in ({"headers":{"Origin":"http://evil.test"}}, {"headers":{"Sec-Fetch-Site":"cross-site"}}, {"peer":"192.168.1.2"},{"host":"evil.test"}):
            self.assertEqual((await self.request("/plugins/qq-ui/status",**kwargs)).status_code,403)
        request={"idempotency_key":"unique_key_1","conversation_type":"private","conversation_id":"88888","segments":[{"type":"text","text":"test"}]}
        self.assertEqual((await self.request("/plugins/qq-ui/messages/send",method="POST",json=request)).status_code,403)
        self.assertEqual(self.calls,[])

    async def test_explicit_native_and_browser_send_use_existing_permission_and_idempotency(self):
        payload={"idempotency_key":"unique_key_1","conversation_type":"private","conversation_id":"88888","segments":[{"type":"text","text":"test"}]}
        for _ in range(2):
            result=await self.request("/plugins/qq-ui/messages/send",method="POST",headers={"X-LKA-UI-Intent":"1"},json=payload)
            self.assertEqual(result.json()["state"],"accepted")
        self.assertEqual(len(self.calls),1)
        self.assertNotIn("token",result.text)
        payload["conversation_id"]="99999";payload["idempotency_key"]="unique_key_2"
        self.assertEqual((await self.request("/plugins/qq-ui/messages/send",method="POST",headers={"X-LKA-UI-Intent":"1"},json=payload)).status_code,403)
        self.assertEqual(len(self.calls),1)

    async def test_upload_get_and_disabled_send_permission(self):
        uploaded=await self.request("/plugins/qq-ui/media/image",method="POST",headers={"X-LKA-UI-Intent":"1"},content=PNG)
        self.assertEqual(uploaded.status_code,201)
        downloaded=await self.request("/plugins/qq-ui/media/"+uploaded.json()["id"])
        self.assertEqual(downloaded.content,PNG)
        self.assertEqual(downloaded.headers["x-content-type-options"],"nosniff")
        self.service.set_policy("private","88888",True,False)
        policy=await self.request("/plugins/qq-ui/conversations/private/88888")
        self.assertFalse(policy.json()["send_enabled"])

    async def relay(self,*,code=200,mime="image/png",length=None,range_header=None,extra=None):
        self.stream=BodyStream(PNG);self.upstream_request=None
        def upstream(request):
            self.upstream_request=request
            headers={"Content-Type":mime,"Content-Length":str(len(PNG) if length is None else length),**(extra or {})}
            return httpx.Response(code,headers=headers,stream=self.stream)
        transport=httpx.MockTransport(upstream)
        def client(**kwargs): return RealClient(transport=transport,**kwargs)
        headers={"Authorization":"Bearer browser-secret","Cookie":"browser-cookie"}
        if range_header:headers["Range"]=range_header
        with patch.dict(os.environ,{"LKA_MESSAGES_CONTROL_TOKEN":"server-private-control","LKA_MESSAGE_READING_BACKEND_URL":"http://127.0.0.1:8765"}),patch("app.api.routes.message_reading_proxy.httpx.AsyncClient",side_effect=client):
            return await self.request("/plugins/message-reading/messages/attachments/attachment_1/content",headers=headers)

    async def test_media_stream_private_auth_range_and_cleanup(self):
        result=await self.relay()
        self.assertEqual(result.content,PNG)
        self.assertEqual(result.status_code,200)
        self.assertTrue(self.stream.closed)
        self.assertEqual(self.upstream_request.headers["X-LKA-Messages-Token"],"server-private-control")
        self.assertNotIn("Authorization",self.upstream_request.headers)
        self.assertNotIn("Cookie",self.upstream_request.headers)
        result=await self.relay(code=206,range_header="bytes=0-",extra={"Content-Range":"bytes 0-12/13","Accept-Ranges":"bytes"})
        self.assertEqual(result.status_code,206)
        self.assertEqual(self.upstream_request.headers["Range"],"bytes=0-")

    async def test_media_nonmedia_redirect_oversize_and_bad_range_denied(self):
        for kwargs in ({"mime":"text/html"},{"code":302},{"length":201*1024*1024},{"code":206,"extra":{"Content-Range":"private-token"}}):
            result=await self.relay(**kwargs)
            self.assertEqual(result.status_code,502)
            self.assertTrue(self.stream.closed)
            self.assertNotIn("private-token",result.text)
        result=await self.relay(range_header="bytes=0-1,4-5")
        self.assertEqual(result.status_code,416)
        self.assertIsNone(self.upstream_request)


if __name__=="__main__":unittest.main()
