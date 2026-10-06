"""Synthetic ASGI/upstream checks; no production app, QQ, model or database."""
import os
import json
import hashlib
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
import httpx
from fastapi import FastAPI
from app.api.routes.plugins import router
from app.api.routes.message_reading_proxy import allowed_request, _is_person_name_route

RealClient = httpx.AsyncClient

class ReadingProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = FastAPI()
        self.app.include_router(router)
        self.calls = []
        self.response_override = None
        async def upstream(request):
            self.calls.append(request)
            if request.url.path.endswith("/decision"):
                return httpx.Response(409, json={"detail":"private-provider-key-and-chat"})
            if self.response_override is not None:
                return httpx.Response(200, json=self.response_override)
            return httpx.Response(200, json={"topics": [], "untrusted_data": True})
        self.upstream = httpx.MockTransport(upstream)

    async def request(self, path="messages/reading/overview", method="GET", headers=None, payload=None, host="127.0.0.1:8000", peer="127.0.0.1", token="private-control"):
        def client(**kwargs):
            kwargs["transport"] = self.upstream
            return RealClient(**kwargs)
        with patch.dict(os.environ, {"LKA_MESSAGES_CONTROL_TOKEN":token, "LKA_MESSAGE_READING_BACKEND_URL":"http://127.0.0.1:8765"}), patch("app.api.routes.message_reading_proxy.httpx.AsyncClient", side_effect=client):
            async with RealClient(transport=httpx.ASGITransport(app=self.app, client=(peer,1234)), base_url="http://" + host) as page:
                return await page.request(method, "/plugins/message-reading/" + path, headers=headers, json=payload)

    async def test_missing_control_token_always_denied(self):
        result = await self.request(token="")
        self.assertEqual(result.status_code, 401)
        self.assertEqual(self.calls, [])

    async def test_fixed_loopback_and_private_header_no_browser_auth(self):
        result = await self.request(headers={"Authorization":"Bearer browser-token", "Cookie":"secret=browser", "Origin":"http://127.0.0.1:8000"})
        self.assertEqual(result.status_code, 200)
        call = self.calls[0]
        self.assertEqual(str(call.url), "http://127.0.0.1:8765/messages/reading/overview")
        self.assertEqual(call.headers["X-LKA-Messages-Token"], "private-control")
        self.assertNotIn("authorization", call.headers)
        self.assertNotIn("cookie", call.headers)
        self.assertNotIn("private-control", result.text)
        self.assertEqual(result.headers["cache-control"], "no-store")

    async def test_get_history_enriches_only_exact_locally_approved_outbox_row(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "reader.db"
            db = sqlite3.connect(db_path)
            db.executescript("""
                CREATE TABLE approved_policies(platform TEXT,account_id TEXT,conversation_type TEXT,conversation_id TEXT,revision INTEGER);
                CREATE TABLE approved_protocols(platform TEXT,account_id TEXT,conversation_type TEXT,conversation_id TEXT,capture_epoch INTEGER,minimum_import_version INTEGER);
                CREATE TABLE message_outbox(platform TEXT,account_id TEXT,message_id TEXT,conversation_type TEXT,conversation_id TEXT,payload TEXT,policy_revision INTEGER,schema_version INTEGER,capture_epoch INTEGER,quarantined INTEGER,synced INTEGER);
            """)
            db.execute("INSERT INTO approved_policies VALUES('qq','acct','group','g1',4)")
            db.execute("INSERT INTO approved_protocols VALUES('qq','acct','group','g1',3,2)")
            db.execute("INSERT INTO message_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
                "qq", "acct", "provider-1", "group", "g1",
                json.dumps({"ui_content_parts": [{"ordinal": 2, "kind": "image", "url": "https://private.invalid"}]}),
                4, 2, 3, 0, 1))
            db.commit()
            db.close()
            self.app.state.qq_reader = SimpleNamespace(_db_path=db_path)
            identity = {"platform": "qq", "account_id": "acct", "conversation_type": "group", "conversation_id": "g1"}
            packed = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            matched = {"platform": "qq", "account_id": "acct", "conversation_key": "message_conversation_" + hashlib.sha256(packed).hexdigest(),
                       "provider_message_id": "provider-1", "text": "authorized"}
            denied = dict(matched, conversation_key="message_conversation_wrong")
            self.response_override = {"history": {"messages": [matched, denied]}}
            result = await self.request("messages/conversations/conversation/history?limit=20")
            self.assertEqual(result.status_code, 200)
            data = result.json()["history"]["messages"]
            self.assertEqual(data[0]["ui_content_parts"], [{"ordinal": 2, "kind": "image"}])
            self.assertNotIn("ui_content_parts", data[1])
            self.assertNotIn("private.invalid", result.text)

    async def test_participant_and_dossier_routes_enrich_only_authorized_success_responses(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "reader.db"
            db = sqlite3.connect(db_path)
            db.executescript("""
                CREATE TABLE approved_policies(platform TEXT,account_id TEXT,conversation_type TEXT,conversation_id TEXT,revision INTEGER);
                CREATE TABLE approved_protocols(platform TEXT,account_id TEXT,conversation_type TEXT,conversation_id TEXT,capture_epoch INTEGER,minimum_import_version INTEGER);
                CREATE TABLE message_outbox(platform TEXT,account_id TEXT,message_id TEXT,conversation_type TEXT,conversation_id TEXT,payload TEXT,policy_revision INTEGER,schema_version INTEGER,capture_epoch INTEGER,quarantined INTEGER,synced INTEGER);
            """)
            db.execute("INSERT INTO approved_policies VALUES('qq','acct','group','g1',4)")
            db.execute("INSERT INTO approved_protocols VALUES('qq','acct','group','g1',3,2)")
            db.execute("INSERT INTO message_outbox VALUES(?,?,?,?,?,?,?,?,?,?,?)", (
                "qq", "acct", "m1", "group", "g1",
                json.dumps({"sender_id": "888", "sender_name": "本地群名片"}), 4, 2, 3, 0, 1))
            db.commit()
            db.close()
            self.app.state.qq_reader = SimpleNamespace(_db_path=db_path)
            identity = {"platform": "qq", "account_id": "acct", "conversation_type": "group", "conversation_id": "g1"}
            packed = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
            key = "message_conversation_" + hashlib.sha256(packed).hexdigest()
            self.response_override = {"participants": [{"conversation_key": key, "sender_id": "888"}]}
            for path in ("messages/reading/participants?conversation_key=conv&limit=20",
                         "messages/reading/dossiers?conversation_key=conv&limit=20&offset=0"):
                result = await self.request(path)
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json()["participants"][0]["sender_name"], "本地群名片")
            self.assertTrue(_is_person_name_route("messages/reading/participants/conv/888"))
            self.assertTrue(_is_person_name_route("messages/reading/dossiers/conv/888"))
            self.assertFalse(_is_person_name_route("messages/reading/participants/conv/888/sources"))

    async def test_peer_host_origin_fetch_site_rejected(self):
        for kwargs in ({"peer":"192.168.1.1"}, {"host":"evil.example"}, {"headers":{"Origin":"http://evil.example"}}, {"headers":{"Sec-Fetch-Site":"cross-site"}}):
            self.assertEqual((await self.request(**kwargs)).status_code, 403)
        self.assertEqual(self.calls, [])

    async def test_path_query_and_method_are_bounded(self):
        for path in ("matters", "integrations/messages/import", "background/jobs/id/retry", "messages/reading/overview?token=secret", "messages/reading/topics/id/../../matters"):
            self.assertEqual((await self.request(path)).status_code, 404)
        self.assertFalse(allowed_request("DELETE", "messages/matter-proposals/id"))
        self.assertFalse(allowed_request("POST", "messages/reading/overview"))
        self.assertTrue(allowed_request("POST", "messages/matter-proposals/id/decision"))

    async def test_conflict_sanitized_and_no_redirect(self):
        result = await self.request("messages/matter-proposals/id/decision", method="POST", payload={"action":"reject"})
        self.assertEqual(result.status_code, 409)
        self.assertNotIn("private-provider", result.text)

    async def test_settings_cannot_change_other_domains(self):
        for payload in ({"expected_revision":1,"memory":{}}, {"background":{"max_llm_concurrency":99}}, {"background":[]}, {"message_history":[]}):
            result = await self.request("background/config", method="PATCH", payload=payload)
            self.assertEqual(result.status_code, 422)
        self.assertEqual(self.calls, [])

    async def test_request_body_bound(self):
        result = await self.request("messages/matter-proposals/id/decision", method="POST", payload={"reason":"x"*40000})
        self.assertEqual(result.status_code, 413)
        self.assertEqual(self.calls, [])

    async def test_keyset_cursor_passed_only_as_query(self):
        result = await self.request("messages/reading/topics/id/sources?limit=20&cursor=opaque")
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.calls[0].url.params["cursor"], "opaque")

    async def test_participant_focus_exact_routes_and_queries(self):
        for path, method in (("messages/reading/participants?conversation_key=conv&limit=2&cursor=c", "GET"),
                             ("messages/reading/participants/conv/platform%3A%E5%BC%A0%E4%B8%89", "GET"),
                             ("messages/reading/participants/conv/123/sources?limit=20&cursor=c", "GET"),
                             ("messages/reading/participants/conv/123/control", "POST"),
                             ("messages/reading/focus/conv", "GET"),
                             ("messages/reading/focus/conv", "PUT")):
            self.assertEqual((await self.request(path, method=method, payload={"expected_revision":1} if method != "GET" else None)).status_code, 200)
        self.assertIn("platform%3A", str(self.calls[1].url))
        for path, method in (("messages/reading/participants/conv/123/sources/control", "POST"),
                             ("messages/reading/participants/conv/a%2Fb", "GET"),
                             ("messages/reading/participants/conv/a%5Cb", "GET"),
                             ("messages/reading/participants/conv/%252e%252e", "GET"),
                             ("messages/reading/participants/conv/123?limit=1", "GET"),
                             ("messages/reading/participants?since=2026", "GET"),
                             ("messages/reading/focus/conv?cursor=c", "PUT"),
                             ("messages/reading/participants/conv/123", "DELETE")):
            self.assertIn((await self.request(path, method=method)).status_code, {404,405})

    async def test_local_evaluation_has_exact_paths_and_private_control(self):
        for path, method in (("messages/reading/evaluation/badcases/preview", "POST"),
                             ("messages/reading/evaluation/badcases", "POST"),
                             ("messages/reading/evaluation/badcases", "GET"),
                             ("messages/reading/evaluation/badcases/message_badcase_id", "GET")):
            self.assertTrue(allowed_request(method, path))
            result = await self.request(path, method=method, payload={"evidence_message_ids":["synthetic"]} if method == "POST" else None)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(self.calls[-1].headers["X-LKA-Messages-Token"], "private-control")
        for path, method in (("messages/reading/evaluation/badcases/upload", "POST"),
                             ("messages/reading/evaluation/badcases/train", "POST"),
                             ("messages/reading/evaluation/badcases/id", "PUT"),
                             ("messages/reading/evaluation/badcases/id", "DELETE")):
            self.assertFalse(allowed_request(method, path))

    async def test_discovery_history_search_dossiers_and_labels(self):
        reads = (
            "messages/conversations?limit=20&offset=0",
            "messages/conversations/resolve?query=Ops",
            "messages/conversations/conv/metadata",
            "messages/conversations/conv/history?limit=20&before_seq=21",
            "messages/conversations/conv/summary",
            "messages/conversations/conv/coverage",
            "messages/conversations/conv/facts?limit=20&offset=0",
            "messages/search?query=hello&sender=Alice&sender_id=u1&since=100&until=200&limit=20&offset=0&conversation_key=conv",
            "messages/recent?conversation_key=conv&since=100&limit=20&offset=0",
            "messages/records/message_id",
            "messages/records/message_id/context?before=10&after=10",
            "messages/attachments?conversation_key=conv&kind=image&query=photo&limit=20&offset=0",
            "messages/attachments/attachment_id",
            "messages/reading/dossiers?conversation_key=conv&limit=20&offset=0",
            "messages/reading/dossiers/conv/platform%3AAlice?limit=20&offset=0",
            "messages/reading/dossiers/conv/platform%3AAlice/sources?limit=20&offset=0",
            "messages/policies",
        )
        for path in reads:
            with self.subTest(path=path):
                self.assertEqual((await self.request(path)).status_code, 200)
        for path, method, payload in (
            ("messages/conversations/conv/metadata", "PATCH", {"expected_revision":0,"user_alias":"Ops"}),
            ("messages/policies", "PUT", {"expected_revision":1}),
            ("messages/conversations/conv/analyze", "POST", {}),
            ("messages/conversations/conv/retry", "POST", {"expected_updated_at":"2026-10-05T00:00:00Z"}),
        ):
            self.assertEqual((await self.request(path, method=method, payload=payload)).status_code, 200)
            self.assertEqual(self.calls[-1].headers["X-LKA-Messages-Token"], "private-control")
            self.assertIn("content-length", self.calls[-1].headers)

    async def test_endpoint_query_names_and_binary_or_encoded_paths_rejected(self):
        paths = (
            "messages/conversations?query=Ops",
            "messages/conversations/resolve?conversation_key=conv",
            "messages/records/id?limit=2",
            "messages/records/id/context?cursor=x",
            "messages/reading/overview?since=100",
            "messages/reading/dossiers?cursor=x",
            "messages/reading/dossiers/conv/alice?since=100",
            "messages/conversations/conv/history?offset=20",

            "messages/reading/dossiers/conv/a%2Fb",
            "messages/reading/dossiers/conv/a%5Cb",
            "messages/reading/dossiers/conv/%252e%252e",
            "messages/records/%252f",
            "messages/search?query=hi&token=secret",
            "messages/search?query=hi&authorization=secret",
        )
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual((await self.request(path)).status_code, 404)
        for path, method in (
            ("messages/conversations/conv/metadata?expected_revision=1", "PATCH"),
            ("messages/policies?scope=global", "PUT"),
            ("messages/reading/dossiers/conv/alice/control", "POST"),
        ):
            self.assertEqual((await self.request(path, method=method, payload={})).status_code, 404)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
