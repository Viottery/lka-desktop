"""Local generic composer file cache: metadata only, never an Agent input."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
import httpx

from app.api.routes.composer_files import router


class ComposerFileCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "cache"
        self.app = FastAPI()
        self.app.include_router(router)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app, client=("127.0.0.1", 3210)),
            base_url="http://127.0.0.1:8780",
        )
        self.patch = patch("app.api.routes.composer_files._COMPOSER_CACHE_DIR", self.root)
        self.patch.start()

    async def asyncTearDown(self):
        self.patch.stop()
        await self.client.aclose()
        self.temp.cleanup()

    async def post(self, data=b"generic file", filename="report.txt", host="127.0.0.1:8780",
                   peer="127.0.0.1", headers=None):
        actual = {"Content-Type": "application/octet-stream", "X-Filename": filename}
        actual.update(headers or {})
        return await self.client.post("http://" + host + "/pet/composer-files", content=data,
            headers=actual, extensions={"client": (peer, 3210)})

    async def test_cache_preserves_bytes_and_returns_non_agent_metadata_only(self):
        data = b"opaque payload\x00"
        response = await self.post(data, "%E5%9B%BE%E7%89%87.bin")
        self.assertEqual(response.status_code, 200, response.text)
        metadata = response.json()
        self.assertEqual(metadata["filename"], "图片.bin")
        self.assertEqual(metadata["size_bytes"], len(data))
        self.assertEqual(metadata["status"], "cached")
        self.assertFalse(metadata["agent_ready"])
        self.assertNotIn("path", metadata)
        cache_id = metadata["cache_id"]
        self.assertEqual((self.root / (cache_id + ".bin")).read_bytes(), data)
        self.assertEqual((self.root / (cache_id + ".json")).exists(), True)

    async def test_limits_types_and_filename_controls(self):
        too_big = await self.post(b"x" * (10 * 1024 * 1024 + 1))
        self.assertEqual(too_big.status_code, 413)
        wrong_type = await self.post(headers={"Content-Type": "image/png"})
        self.assertEqual(wrong_type.status_code, 415)
        for name in ("", "%00bad", "%2E%2E", "x" * 241):
            response = await self.post(filename=name)
            self.assertEqual(response.status_code, 422, name)
        self.assertFalse(self.root.exists())
        empty = await self.post(b"")
        self.assertEqual(empty.status_code, 422)
        self.assertFalse(self.root.exists())

    async def test_directory_creation_error_is_sanitized(self):
        with patch.object(Path, "mkdir", side_effect=OSError("private path details")):
            response = await self.post()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"], "Local file cache unavailable")
        self.assertNotIn("private path details", response.text)

    async def test_access_gate_requires_local_or_allowlisted_same_origin(self):
        denied = await self.post(host="192.0.2.2:8780", peer="192.0.2.4")
        self.assertEqual(denied.status_code, 403)
        allowed = await self.post(host="192.0.2.2:8780", peer="192.0.2.4",
            headers={"Origin": "http://192.0.2.2:8780", "Sec-Fetch-Site": "same-origin"})
        # No allowlist is installed for this synthetic origin.
        self.assertEqual(allowed.status_code, 403)
        with patch.dict(os.environ, {"LKA_WORKBENCH_ORIGINS": "http://192.0.2.2:8780"}):
            approved = await self.post(host="192.0.2.2:8780", peer="192.0.2.4",
                headers={"Origin": "http://192.0.2.2:8780", "Sec-Fetch-Site": "same-origin"})
        self.assertEqual(approved.status_code, 200, approved.text)


if __name__ == "__main__":
    unittest.main()
