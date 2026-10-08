"""Synthetic workspace transfer API tests; never contact a real backend."""
import asyncio
import os
import subprocess
import threading
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote, urlsplit
from unittest.mock import patch

import httpx
from fastapi import FastAPI

from app.api.routes.workspace_files import router

RealClient = httpx.AsyncClient
SESSION_ID = "session_test"


class WorkspaceFileTransferTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.outside = Path(self.temp.name + "-outside")
        self.outside.mkdir(exist_ok=True)
        self.workspace_path = str(self.root).replace("\\", "/")
        self.platform = "windows" if os.name == "nt" else "linux"
        self.app = FastAPI()
        self.app.include_router(router)
        self.calls = []
        self.handler = self._default_handler
        self.transport = httpx.MockTransport(self._dispatch)

    async def asyncTearDown(self):
        self.temp.cleanup()
        try:
            self.outside.rmdir()
        except OSError:
            pass

    def _session_payload(self, *, path=None, platform=None, status="active"):
        return {"session": {
            "session_id": SESSION_ID,
            "status": status,
            "workspace": {
                "path": path or self.workspace_path,
                "platform": platform or self.platform,
                "backend_path": "/mnt/d/backend-workspace",
            },
        }, "messages": []}

    async def _default_handler(self, request):
        self.calls.append(request)
        if request.url.path == "/sessions/" + SESSION_ID:
            return httpx.Response(200, json=self._session_payload())
        return httpx.Response(404, json={"detail": "not found"})

    async def _dispatch(self, request):
        return await self.handler(request)

    async def request(self, method, path, *, content=None, headers=None, host="127.0.0.1:8780",
                      peer="127.0.0.1", allowed_origin=None):
        env = {"LKA_WORKBENCH_BACKEND_URL": "http://127.0.0.1:8765"}
        if allowed_origin:
            env["LKA_WORKBENCH_ORIGINS"] = allowed_origin

        def make_client(**kwargs):
            kwargs["transport"] = self.transport
            return RealClient(**kwargs)

        with patch.dict(os.environ, env, clear=False), patch(
                "app.api.routes.workspace_files.httpx.AsyncClient", side_effect=make_client):
            async with RealClient(transport=httpx.ASGITransport(app=self.app, client=(peer, 3210)),
                                  base_url="http://" + host) as client:
                return await client.request(method, path, headers=headers, content=content)

    def _query(self, route, *, path=None):
        params = {"workspace": self.workspace_path}
        if path is not None:
            params["path"] = path
        return f"/pet/workspace-files/{SESSION_ID}/{route}?" + httpx.QueryParams(params).__str__()

    async def test_upload_writes_raw_bytes_under_bound_workspace_and_collision_renames(self):
        folder = self.root / "reports"
        folder.mkdir()
        payload = b"\x00raw\xffdocument"
        second_payload = b"different replacement attempt"
        encoded_filename = quote("résumé.txt", safe="")
        url = self._query("upload", path="reports")
        first = await self.request("POST", url, content=payload, headers={
            "Content-Type": "application/octet-stream", "X-Filename": encoded_filename,
        })
        second = await self.request("POST", url, content=second_payload, headers={
            "Content-Type": "application/octet-stream", "X-Filename": encoded_filename,
        })
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json(), {"filename": "résumé.txt", "path": "reports/résumé.txt",
                                        "size_bytes": len(payload), "renamed": False})
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["filename"], "résumé (2).txt")
        self.assertTrue(second.json()["renamed"])
        self.assertEqual((folder / "résumé.txt").read_bytes(), payload)
        self.assertEqual((folder / "résumé (2).txt").read_bytes(), second_payload)
        self.assertEqual(sum(r.url.path == "/sessions/" + SESSION_ID for r in self.calls), 4)
        self.assertTrue(all(r.headers.get("authorization") is None for r in self.calls))

    async def test_upload_revalidates_workspace_before_publish(self):
        count = 0
        async def switched(request):
            nonlocal count
            count += 1
            self.calls.append(request)
            actual = self.workspace_path if count == 1 else self.workspace_path + "/changed"
            return httpx.Response(200, json=self._session_payload(path=actual))
        self.handler = switched
        response = await self.request("POST", self._query("upload"), content=b"data", headers={
            "Content-Type": "application/octet-stream", "X-Filename": "report.txt",
        })
        self.assertEqual(response.status_code, 409, response.text)
        self.assertFalse((self.root / "report.txt").exists())
        self.assertEqual(list(self.root.glob(".lka-upload-*.tmp")), [])

    async def test_deleted_or_mismatched_workspace_is_rejected(self):
        async def changed(request):
            self.calls.append(request)
            return httpx.Response(200, json=self._session_payload(path=self.workspace_path + "-other"))
        self.handler = changed
        mismatch = await self.request("GET", self._query("download", path="file.txt"))
        self.assertEqual(mismatch.status_code, 409)

        async def deleted(request):
            self.calls.append(request)
            return httpx.Response(200, json=self._session_payload(status="deleted"))
        self.handler = deleted
        missing = await self.request("GET", self._query("download", path="file.txt"))
        self.assertEqual(missing.status_code, 404)

    async def test_remote_origin_gate_matches_workbench_proxy(self):
        denied = await self.request("GET", self._query("download", path="file.txt"),
                                    host="192.0.2.2:8780", peer="192.0.2.4")
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(self.calls, [])
        allowed = await self.request("GET", self._query("download", path="file.txt"),
            host="192.0.2.2:8780", peer="192.0.2.4",
            headers={"Origin": "http://192.0.2.2:8780", "Sec-Fetch-Site": "same-origin"},
            allowed_origin="http://192.0.2.2:8780")
        self.assertEqual(allowed.status_code, 404)
        self.assertEqual(len(self.calls), 1)

    async def test_filename_and_relative_path_attacks_rejected_and_symlink_directory_blocked(self):
        base_upload = "/pet/workspace-files/" + SESSION_ID + "/upload"
        invalid = await self.request("POST", self._query("upload", path="../outside"), content=b"x",
            headers={"Content-Type": "application/octet-stream", "X-Filename": "safe.txt"})
        self.assertEqual(invalid.status_code, 422)
        invalid_name = await self.request("POST", base_upload + "?workspace=" + quote(self.workspace_path, safe=""),
            content=b"x", headers={"Content-Type": "application/octet-stream", "X-Filename": quote("../escape.txt", safe="")})
        self.assertEqual(invalid_name.status_code, 422)
        for name in ("CON.txt", "file:stream.txt", "trailing. "):
            response = await self.request("POST", base_upload + "?workspace=" + quote(self.workspace_path, safe=""),
                content=b"x", headers={"Content-Type": "application/octet-stream", "X-Filename": quote(name, safe="")})
            self.assertEqual(response.status_code, 422, name)

        link = self.root / "escape"
        try:
            link.symlink_to(self.outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            if os.name != "nt":
                self.skipTest("Local symlink creation is unavailable")
            result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(self.outside)],
                                    capture_output=True, text=True, check=False)
            if result.returncode != 0:
                self.skipTest("Windows junction creation is unavailable")
        symlink_response = await self.request("POST", self._query("upload", path="escape"), content=b"x",
            headers={"Content-Type": "application/octet-stream", "X-Filename": "escape.txt"})
        self.assertEqual(symlink_response.status_code, 409)
        self.assertFalse((self.outside / "escape.txt").exists())

    async def test_windows_workspace_root_junction_is_rejected(self):
        if os.name != "nt":
            self.skipTest("Windows junction validation runs on the native frontend")
        junction = self.root.parent / (self.root.name + "-workspace-junction")
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(self.root)],
                                capture_output=True, text=True, check=False)
        if result.returncode != 0:
            self.skipTest("Windows junction creation is unavailable")
        try:
            self.workspace_path = str(junction).replace("\\", "/")
            response = await self.request("POST", self._query("upload"), content=b"data", headers={
                "Content-Type": "application/octet-stream", "X-Filename": "outside.txt",
            })
            self.assertEqual(response.status_code, 409)
            self.assertFalse((self.root / "outside.txt").exists())
        finally:
            junction.rmdir()

    async def test_oversize_upload_and_disconnected_upload_clean_temporary_files(self):
        with patch("app.api.routes.workspace_files._MAX_UPLOAD_BYTES", 16):
            response = await self.request("POST", self._query("upload"), content=b"x" * 17,
                headers={"Content-Type": "application/octet-stream", "X-Filename": "large.bin"})
        self.assertEqual(response.status_code, 413)
        self.assertFalse((self.root / "large.bin").exists())
        self.assertEqual(list(self.root.glob(".lka-upload-*.tmp")), [])

        url = urlsplit(self._query("upload"))
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "POST", "scheme": "http", "path": url.path,
            "raw_path": url.path.encode(), "query_string": url.query.encode(),
            "headers": [(b"host", b"127.0.0.1:8780"),
                        (b"content-type", b"application/octet-stream"),
                        (b"x-filename", b"cancelled.bin")],
            "client": ("127.0.0.1", 3210), "server": ("127.0.0.1", 8780),
        }
        messages = iter([
            {"type": "http.request", "body": b"partial bytes", "more_body": True},
            {"type": "http.disconnect"},
        ])
        async def receive():
            return next(messages)
        async def send(_message):
            return None
        def make_client(**kwargs):
            kwargs["transport"] = self.transport
            return RealClient(**kwargs)
        with patch.dict(os.environ, {"LKA_WORKBENCH_BACKEND_URL": "http://127.0.0.1:8765"}, clear=False), patch(
                "app.api.routes.workspace_files.httpx.AsyncClient", side_effect=make_client):
            try:
                await self.app(scope, receive, send)
            except Exception:
                pass
        self.assertFalse((self.root / "cancelled.bin").exists())
        self.assertEqual(list(self.root.glob(".lka-upload-*.tmp")), [])

    async def test_task_cancel_during_stage_creation_drains_and_cleans_acquired_file(self):
        entered = threading.Event()
        release = threading.Event()
        real_create = __import__("app.api.routes.workspace_files", fromlist=["_SafeDirectory"])._SafeDirectory.create_stage
        def blocked_create(directory, name):
            acquired = real_create(directory, name)
            entered.set()
            if not release.wait(5):
                raise TimeoutError("test did not release stage acquisition")
            return acquired
        url = self._query("upload")
        with patch("app.api.routes.workspace_files._SafeDirectory.create_stage", new=blocked_create):
            task = asyncio.create_task(self.request("POST", url, content=b"payload", headers={
                "Content-Type": "application/octet-stream", "X-Filename": "cancel-stage.txt",
            }))
            try:
                deadline = asyncio.get_running_loop().time() + 5
                while not entered.is_set() and asyncio.get_running_loop().time() < deadline:
                    await asyncio.sleep(0.01)
                self.assertTrue(entered.is_set(), "stage creation worker did not start")
                task.cancel()
            finally:
                release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertFalse((self.root / "cancel-stage.txt").exists())
        self.assertEqual(list(self.root.glob(".lka-upload-*.tmp")), [])

    async def test_task_cancel_during_write_drains_before_stage_cleanup(self):
        entered = threading.Event()
        release = threading.Event()
        real_write = __import__("app.api.routes.workspace_files", fromlist=["_write_all"])._write_all
        def blocked_write(stream, data):
            entered.set()
            if not release.wait(5):
                raise TimeoutError("test did not release upload write")
            return real_write(stream, data)
        url = self._query("upload")
        with patch("app.api.routes.workspace_files._write_all", new=blocked_write):
            task = asyncio.create_task(self.request("POST", url, content=b"payload", headers={
                "Content-Type": "application/octet-stream", "X-Filename": "cancel-write.txt",
            }))
            try:
                deadline = asyncio.get_running_loop().time() + 5
                while not entered.is_set() and asyncio.get_running_loop().time() < deadline:
                    await asyncio.sleep(0.01)
                self.assertTrue(entered.is_set(), "upload write worker did not start")
                task.cancel()
            finally:
                release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertFalse((self.root / "cancel-write.txt").exists())
        self.assertEqual(list(self.root.glob(".lka-upload-*.tmp")), [])

    async def test_download_returns_bytes_encoded_disposition_and_content_length(self):
        filename = "résumé report.html"
        content = b"<html>ordinary arbitrary bytes</html>"
        (self.root / filename).write_bytes(content)
        response = await self.request("GET", self._query("download", path=filename))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, content)
        self.assertEqual(response.headers.get("content-type"), "application/octet-stream")
        self.assertEqual(response.headers.get("content-length"), str(len(content)))
        self.assertEqual(response.headers.get("content-disposition"),
                         "attachment; filename*=UTF-8''" + quote(filename, safe=""))
        self.assertEqual(response.headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(response.headers.get("cache-control"), "no-store")

    async def test_download_rejects_symlink_and_caps_size(self):
        outside_file = self.outside / "secret.txt"
        outside_file.write_text("secret")
        link = self.root / "secret-link.txt"
        try:
            link.symlink_to(outside_file)
        except (OSError, NotImplementedError):
            self.skipTest("Local symlink creation is unavailable")
        blocked = await self.request("GET", self._query("download", path="secret-link.txt"))
        self.assertEqual(blocked.status_code, 404)

        oversized = self.root / "large.bin"
        with oversized.open("wb") as stream:
            stream.truncate(128 * 1024 * 1024 + 1)
        response = await self.request("GET", self._query("download", path="large.bin"))
        self.assertEqual(response.status_code, 413)

    async def test_download_closes_open_file_when_client_disconnects(self):
        filename = "large-download.bin"
        (self.root / filename).write_bytes(b"x" * (512 * 1024))
        real_open = __import__("app.api.routes.workspace_files", fromlist=["_SafeDirectory"])._SafeDirectory.open_file
        opened = []
        def tracked_open(directory, name):
            fd = real_open(directory, name)
            opened.append(fd)
            return fd
        url = urlsplit(self._query("download", path=filename))
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "GET", "scheme": "http", "path": url.path,
            "raw_path": url.path.encode(), "query_string": url.query.encode(),
            "headers": [(b"host", b"127.0.0.1:8780")],
            "client": ("127.0.0.1", 3210), "server": ("127.0.0.1", 8780),
        }
        receives_body = False
        disconnected = asyncio.Event()
        async def receive():
            nonlocal receives_body
            if not receives_body:
                receives_body = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await disconnected.wait()
            return {"type": "http.disconnect"}
        async def send(message):
            if message["type"] == "http.response.body" and message.get("body"):
                raise OSError("synthetic client disconnect")
        def make_client(**kwargs):
            kwargs["transport"] = self.transport
            return RealClient(**kwargs)
        with patch.dict(os.environ, {"LKA_WORKBENCH_BACKEND_URL": "http://127.0.0.1:8765"}, clear=False), patch(
                "app.api.routes.workspace_files.httpx.AsyncClient", side_effect=make_client), patch(
                "app.api.routes.workspace_files._SafeDirectory.open_file", new=tracked_open):
            try:
                await self.app(scope, receive, send)
            except BaseException:
                pass
        self.assertEqual(len(opened), 1)
        with self.assertRaises(OSError):
            os.fstat(opened[0])

    async def test_download_rejects_traversal_and_missing_file(self):
        traversal = await self.request("GET", self._query("download", path="../secret"))
        self.assertEqual(traversal.status_code, 422)
        missing = await self.request("GET", self._query("download", path="missing.txt"))
        self.assertEqual(missing.status_code, 404)


if __name__ == "__main__":
    unittest.main()
