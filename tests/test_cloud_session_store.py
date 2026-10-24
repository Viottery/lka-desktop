"""Synthetic session storage tests; no real account credentials or network."""
import base64
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from app.api.routes import cloud_gateway
from app.core import cloud_session_store as store

HUB = "https://hub.example.ts.net"


def fake_crypt(raw, *, decrypt=False):
    return base64.b64decode(raw, validate=True) if decrypt else base64.b64encode(raw)


class CloudSessionStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / "session.dpapi")
        self.env = patch.dict(os.environ, {"LKA_CLOUD_SESSION_PATH": self.path, "LKA_CLOUD_ORIGIN": HUB})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.crypt = patch.object(store, "_crypt", side_effect=fake_crypt)
        self.crypt.start()
        self.addCleanup(self.crypt.stop)
        self.expiry = int(time.time()) + 3600

    def save(self):
        session = cloud_gateway._Session()
        session.set("synthetic-token", {"username": "tester"}, self.expiry, HUB)
        return session

    def test_new_service_restores_session_without_browser_storage(self):
        self.save()
        token, account, expiry, origin = cloud_gateway._Session().snapshot()
        self.assertEqual((token, account, expiry, origin), ("synthetic-token", {"username": "tester"}, self.expiry, HUB))
        self.assertNotIn(b"synthetic-token", Path(self.path).read_bytes())
        self.assertEqual(list(Path(self.path).parent.iterdir()), [Path(self.path)])

    def test_logout_removes_disk_session(self):
        self.save().clear()
        self.assertFalse(Path(self.path).exists())
        self.assertEqual(cloud_gateway._Session().snapshot()[0], "")

    def test_stale_response_cannot_delete_newer_login(self):
        session = self.save()
        session.set("new-token", {"username": "tester"}, self.expiry, HUB)
        session.clear("synthetic-token")
        self.assertEqual(cloud_gateway._Session().snapshot()[0], "new-token")

    def test_session_cannot_cross_hub_or_store(self):
        session = self.save()
        with patch.dict(os.environ, {"LKA_CLOUD_ORIGIN": "https://other.example.ts.net"}):
            self.assertEqual(session.snapshot()[0], "")
            self.assertEqual(cloud_gateway._Session().snapshot()[0], "")
        with patch.dict(os.environ, {"LKA_CLOUD_SESSION_PATH": self.path + ".other"}):
            self.assertEqual(session.snapshot()[0], "")

    def test_expiry_deletes_saved_credential(self):
        session = self.save()
        with patch("app.api.routes.cloud_gateway.time.time", return_value=self.expiry + 1):
            self.assertEqual(session.snapshot()[0], "")
        self.assertFalse(Path(self.path).exists())

    def test_expired_malformed_or_unprotectable_records_fail_closed(self):
        for raw in [b"bad ciphertext", fake_crypt(json.dumps([]).encode()),
                    fake_crypt(json.dumps({"version": 1, "origin": HUB, "token": "x", "account": {}, "expires_at": 1}).encode())]:
            Path(self.path).write_bytes(raw)
            self.assertEqual(cloud_gateway._Session().snapshot()[0], "")
        self.save()
        with patch.object(store, "_crypt", side_effect=store.SessionStorageError("wrong Windows user")):
            self.assertEqual(cloud_gateway._Session().snapshot()[0], "")

    def test_storage_failure_does_not_publish_successful_login(self):
        with (patch.object(store, "_crypt", side_effect=store.SessionStorageError("unavailable")),
              self.assertRaises(store.SessionStorageError)):
            self.save()
        self.assertFalse(Path(self.path).exists())

    def test_default_remains_memory_only(self):
        with patch.dict(os.environ, {"LKA_CLOUD_SESSION_PATH": ""}):
            session = self.save()
            self.assertEqual(session.snapshot()[0], "synthetic-token")
            self.assertEqual(cloud_gateway._Session().snapshot()[0], "")
        self.assertFalse(Path(self.path).exists())

    @unittest.skipUnless(os.name == "nt", "Actual CurrentUser DPAPI requires Windows")
    def test_native_dpapi_roundtrip_and_tamper(self):
        self.crypt.stop()
        raw = store._crypt(b"synthetic-secret")
        self.assertNotIn(b"synthetic-secret", raw)
        self.assertEqual(store._crypt(raw, decrypt=True), b"synthetic-secret")
        with self.assertRaises(store.SessionStorageError):
            store._crypt(b"corrupt" + raw[7:], decrypt=True)


if __name__ == "__main__":
    unittest.main()
