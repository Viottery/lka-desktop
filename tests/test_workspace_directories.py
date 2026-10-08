"""Local, metadata-only workspace directory browsing API tests."""
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import httpx
from fastapi import FastAPI, HTTPException

from app.api.routes.pet import _validate_browse_path, _workspace_browse_roots, router


class WorkspaceDirectoryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = FastAPI()
        self.app.include_router(router)
        self.transport = httpx.ASGITransport(app=self.app, client=("127.0.0.1", 1234))
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://127.0.0.1:8780")
        await self.client.__aenter__()

    async def asyncTearDown(self):
        await self.client.__aexit__(None, None, None)

    async def test_empty_path_starts_at_configured_workspace_and_lists_only_directories(self):
        with TemporaryDirectory() as temporary, patch.dict(os.environ, {"LKA_SESSION_WORKSPACE_BASE": temporary}):
            parent = Path(temporary)
            (parent / "alpha").mkdir()
            (parent / "secret.txt").write_text("private contents")

            result = await self.client.get("/pet/workspace-directories")

            self.assertEqual(result.status_code, 200)
            body = result.json()
            self.assertEqual(body["path"], temporary)
            self.assertEqual(body["parent"], str(parent.parent))
            self.assertEqual(body["directories"], [{"name": "alpha", "path": str(parent / "alpha")}])
            self.assertTrue(body["roots"])
            self.assertIsNone(body["next_offset"])
            self.assertFalse(body["truncated"])
            self.assertNotIn("secret.txt", result.text)
            self.assertEqual((parent / "secret.txt").read_text(), "private contents")

    async def test_opted_in_remote_can_create_only_in_configured_parent(self):
        with TemporaryDirectory() as temporary, TemporaryDirectory() as forbidden:
            origin = "http://mobile.workbench.test:8780"
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=("100.64.1.3", 1234)), base_url=origin) as remote:
                with patch.dict(os.environ, {"LKA_SESSION_WORKSPACE_BASE": temporary, "LKA_WORKBENCH_ORIGINS": "", "LKA_REMOTE_WORKSPACE_ROOTS": ""}):
                    denied = await remote.post("/pet/session-workspace", json={"session_id": "synthetic-remote"})
                    self.assertEqual(denied.status_code, 403)
                    self.assertEqual(list(Path(temporary).iterdir()), [])
                with patch.dict(os.environ, {"LKA_SESSION_WORKSPACE_BASE": temporary, "LKA_WORKBENCH_ORIGINS": origin, "LKA_REMOTE_WORKSPACE_ROOTS": ""}):
                    result = await remote.post("/pet/session-workspace", headers={"Origin": origin}, json={"session_id": "synthetic-remote"})
                    self.assertEqual(result.status_code, 200)
                    created = Path(result.json()["path"])
                    self.assertTrue(created.is_dir())
                    self.assertEqual(created.parent, Path(temporary).resolve())
                    retry = await remote.post("/pet/session-workspace", headers={"Origin": origin}, json={"session_id": "synthetic-remote"})
                    self.assertEqual(retry.json(), result.json())
                    cross_site = await remote.post("/pet/session-workspace", headers={"Origin": "http://evil.example"}, json={"session_id": "synthetic-cross-site"})
                    self.assertEqual(cross_site.status_code, 403)
                    outside = await remote.post("/pet/session-workspace", headers={"Origin": origin}, json={"session_id": "synthetic-outside", "base_path": forbidden})
                    self.assertEqual(outside.status_code, 403)
                    self.assertEqual(list(Path(forbidden).iterdir()), [])
                    listing = await remote.get("/pet/workspace-directories", headers={"Origin": origin})
                    self.assertEqual(listing.status_code, 200, "allowlisted mobile can browse computer folders")
                    self.assertEqual(listing.json()["path"], str(Path(temporary).resolve()))
                    rejected = await remote.get("/pet/workspace-directories", headers={"Origin": "http://evil.example"})
                    self.assertEqual(rejected.status_code, 403)

    async def test_filtering_and_offset_pagination_are_stable(self):
        with TemporaryDirectory() as temporary:
            parent = Path(temporary)
            for name in ("Alpha", "alpine", "beta", "gamma"):
                (parent / name).mkdir()
            result = await self.client.get("/pet/workspace-directories", params={"path": temporary, "query": "AL", "limit": 1})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["directories"], [{"name": "Alpha", "path": str(parent / "Alpha")}])
            self.assertEqual(result.json()["next_offset"], 1)

            next_page = await self.client.get("/pet/workspace-directories", params={"path": temporary, "query": "al", "offset": 1, "limit": 1})
            self.assertEqual(next_page.json()["directories"], [{"name": "alpine", "path": str(parent / "alpine")}])
            self.assertIsNone(next_page.json()["next_offset"])

    async def test_rejects_remote_and_cross_site_requests(self):
        with TemporaryDirectory() as temporary:
            remote = httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app, client=("192.0.2.10", 1234)),
                base_url="http://127.0.0.1:8780",
            )
            async with remote:
                result = await remote.get("/pet/workspace-directories", params={"path": temporary})
                self.assertEqual(result.status_code, 403)
            for headers in (
                {"Origin": "http://evil.example"},
                {"Sec-Fetch-Site": "cross-site"},
                {"Sec-Fetch-Site": "same-site"},
            ):
                result = await self.client.get("/pet/workspace-directories", params={"path": temporary}, headers=headers)
                self.assertEqual(result.status_code, 403)

    async def test_same_origin_is_allowed_and_dns_rebinding_host_is_denied(self):
        with TemporaryDirectory() as temporary:
            result = await self.client.get(
                "/pet/workspace-directories",
                params={"path": temporary},
                headers={"Origin": "http://127.0.0.1:8780", "Sec-Fetch-Site": "same-origin"},
            )
            self.assertEqual(result.status_code, 200)
            rebound = await self.client.get(
                "/pet/workspace-directories",
                params={"path": temporary},
                headers={"Host": "attacker.example", "Origin": "http://attacker.example"},
            )
            self.assertEqual(rebound.status_code, 403)

    async def test_rejects_bad_paths_without_creating_directories(self):
        with TemporaryDirectory() as temporary:
            parent = Path(temporary)
            (parent / "file.txt").write_text("content")
            for path, expected in (
                ("relative/path", 422),
                (str(parent / "missing"), 404),
                (str(parent / "file.txt"), 422),
                ("//server/share", 422),
                ("bad\x00path", 422),
            ):
                with self.subTest(path=repr(path)):
                    result = await self.client.get("/pet/workspace-directories", params={"path": path})
                    self.assertEqual(result.status_code, expected)
            self.assertFalse((parent / "missing").exists())

    async def test_pagination_and_scan_limit_are_reported(self):
        with TemporaryDirectory() as temporary:
            parent = Path(temporary)
            for name in ("a", "b", "c"):
                (parent / name).mkdir()
            with patch("app.api.routes.pet._MAX_DIRECTORY_SCAN", 2):
                result = await self.client.get("/pet/workspace-directories", params={"path": temporary, "limit": 1})
            self.assertEqual(result.status_code, 200)
            self.assertTrue(result.json()["truncated"])
            self.assertEqual(result.json()["next_offset"], 1)

    async def test_paths_are_canonical_and_symlink_entries_are_omitted(self):
        with TemporaryDirectory() as temporary:
            parent = Path(temporary)
            target = parent / "target"
            target.mkdir()
            branch = parent / "branch"
            branch.mkdir()
            link = branch / "link"
            try:
                link.symlink_to(target, target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"directory symlinks unavailable: {exc}")

            normalized = await self.client.get(
                "/pet/workspace-directories",
                params={"path": str(branch / ".." / "branch" / ".." / "target")},
            )
            self.assertEqual(normalized.status_code, 200)
            self.assertEqual(normalized.json()["path"], str(target.resolve()))

            listing = await self.client.get("/pet/workspace-directories", params={"path": str(branch)})
            self.assertEqual(listing.status_code, 200)
            self.assertEqual(listing.json()["directories"], [])

    async def test_default_path_is_validated(self):
        with patch("app.api.routes.pet._workspace_initial_path", return_value=Path("relative/default")):
            result = await self.client.get("/pet/workspace-directories")
        self.assertEqual(result.status_code, 422)

    @unittest.skipUnless(os.name == "nt", "Windows drive enumeration policy")
    def test_windows_roots_include_fixed_drives_only_and_reject_unc(self):
        import ctypes

        mask = (1 << 2) | (1 << 3)  # C: and D:
        with patch.object(ctypes.windll.kernel32, "GetLogicalDrives", return_value=mask), patch.object(
            ctypes.windll.kernel32,
            "GetDriveTypeW",
            side_effect=lambda drive: 3 if drive == "C:\\" else 4,
        ):
            roots = _workspace_browse_roots()
        self.assertEqual(roots, [{"name": "C:\\", "path": "C:\\"}])
        with self.assertRaises(HTTPException) as error:
            _validate_browse_path("\\\\server\\share", roots)
        self.assertEqual(error.exception.status_code, 422)
        self.assertIn("Network and UNC", error.exception.detail)


if __name__ == "__main__":
    unittest.main()
