"""Session-bound local workspace file transfer for the desktop workbench."""
from __future__ import annotations

import asyncio
import sys
import ctypes
import json
import ntpath
import os
import posixpath
import re
import stat
import threading
import uuid
from ctypes import wintypes
from urllib.parse import quote, unquote_to_bytes

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from app.api.routes.workbench_proxy import _ID, _upstream, require_workbench_page

router = APIRouter(prefix="/pet/workspace-files", tags=["workspace-files"])


class _ClosingStreamingResponse(StreamingResponse):
    """Close opened file and directory handles on completion or disconnect."""

    def __init__(self, content, *, close_callback, **kwargs):
        super().__init__(content, **kwargs)
        self._close_callback = close_callback

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._close_callback()

_MAX_UPLOAD_BYTES = 64 * 1024 * 1024
_MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024
_MAX_SESSION_RESPONSE = 16 * 1024 * 1024
_CHUNK_SIZE = 256 * 1024
_DEVICE_NAMES = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)),
                 *(f"lpt{i}" for i in range(1, 10))}


def _filename(value: str) -> str:
    if not value or re.search(r"%(?![0-9a-fA-F]{2})", value):
        raise HTTPException(422, "Invalid filename encoding")
    try:
        name = unquote_to_bytes(value).decode("utf-8", errors="strict")
    except UnicodeError:
        raise HTTPException(422, "Invalid filename encoding") from None
    if (not name or name in {".", ".."} or "/" in name or "\\" in name or ":" in name
            or any(ord(char) < 32 or ord(char) == 127 or char in "*?<>|\"" for char in name)
            or name.endswith((".", " ")) or len(name.encode("utf-8")) > 240
            or name.split(".", 1)[0].casefold() in _DEVICE_NAMES):
        raise HTTPException(422, "Invalid filename")
    return name


def _relative_parts(value: str, *, allow_empty: bool) -> tuple[str, ...]:
    if not value and allow_empty:
        return ()
    if (not value or value.startswith(("/", "\\")) or "\\" in value or ":" in value
            or any(ord(char) < 32 or ord(char) == 127 or char in "*?<>|\"" for char in value)
            or len(value.encode("utf-8")) > 4096):
        raise HTTPException(422, "Invalid relative path")
    parts = tuple(value.split("/"))
    for part in parts:
        if (not part or part in {".", ".."} or part.endswith((".", " "))
                or part.split(".", 1)[0].casefold() in _DEVICE_NAMES):
            raise HTTPException(422, "Invalid relative path")
    return parts


def _normalize_workspace(value: str, platform_name: str) -> str:
    if platform_name == "windows":
        normalized = ntpath.normpath(value.replace("/", "\\"))
        drive, tail = ntpath.splitdrive(normalized)
        if not drive or not tail.startswith("\\") or drive.startswith("\\"):
            raise HTTPException(409, "Windows workspace is unavailable on this frontend")
        return ntpath.normcase(normalized)
    if platform_name in {"linux", "macos"}:
        if not value.startswith("/"):
            raise HTTPException(409, "POSIX workspace is unavailable on this frontend")
        return posixpath.normpath(value)
    raise HTTPException(409, "This workspace platform is not supported by the local frontend")


def _same_workspace(actual: str, expected: str, platform_name: str) -> bool:
    try:
        return _normalize_workspace(actual, platform_name) == _normalize_workspace(expected, platform_name)
    except HTTPException:
        return False


def _open_session_client():
    return httpx.AsyncClient(
        timeout=httpx.Timeout(connect=5, read=10, write=5, pool=5),
        follow_redirects=False, trust_env=False,
    )


async def _session_workspace(session_id: str, expected_workspace: str) -> tuple[str, str]:
    """Re-read backend authority; return (platform, native path)."""
    url = f"{_upstream()}/sessions/{session_id}"
    try:
        async with _open_session_client() as client:
            async with client.stream("GET", url, headers={"Accept": "application/json"}) as response:
                if response.status_code == 404:
                    raise HTTPException(404, "Active session not found")
                if response.status_code != 200:
                    raise HTTPException(502, "Workspace service unavailable")
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(raw) + len(chunk) > _MAX_SESSION_RESPONSE:
                        raise HTTPException(502, "Workspace service response too large")
                    raw.extend(chunk)
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeError):
                    raise HTTPException(502, "Invalid workspace service response") from None
    except HTTPException:
        raise
    except httpx.HTTPError:
        raise HTTPException(502, "Workspace service unavailable") from None
    session = payload.get("session") if isinstance(payload, dict) else None
    workspace = session.get("workspace") if isinstance(session, dict) else None
    if not isinstance(session, dict) or session.get("session_id") != session_id:
        raise HTTPException(404, "Active session not found")
    if session.get("status") == "deleted":
        raise HTTPException(404, "Active session not found")
    if session.get("status") != "active":
        raise HTTPException(409, "Session is not active")
    if not isinstance(workspace, dict) or not workspace.get("path"):
        raise HTTPException(409, "Session has no bound workspace")
    platform_name = str(workspace.get("platform") or "").lower()
    actual = str(workspace.get("path"))
    if not _same_workspace(actual, expected_workspace, platform_name):
        raise HTTPException(409, "Session workspace changed")
    local_platform = ("windows" if os.name == "nt" else "macos" if sys.platform == "darwin"
                     else "linux" if os.name == "posix" else "unsupported")
    if platform_name != local_platform:
        raise HTTPException(409, "Session workspace is not on this frontend platform")
    # Windows frontends must use the preserved drive path, never backend_path (which may be /mnt/d/...).
    native_path = ntpath.normpath(actual.replace("/", "\\")) if local_platform == "windows" else posixpath.normpath(actual)
    return platform_name, native_path


class _SafeDirectory:
    """A held, no-follow directory chain and operations relative to its final directory."""

    def __init__(self, platform_name: str, root: str, directories: tuple[str, ...]):
        self.platform_name = platform_name
        self.root = root
        self.directories = directories
        self.fds: list[int] = []
        self.handles: list[int] = []
        self.path = ""
        self.fd = -1

    def open(self) -> "_SafeDirectory":
        if self.platform_name in {"linux", "macos"}:
            if not os.path.isabs(self.root):
                raise HTTPException(409, "Workspace is unavailable")
            flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
            try:
                current = os.open("/", flags)
                self.fds.append(current)
                for part in [item for item in self.root.split("/") if item]:
                    current = os.open(part, flags, dir_fd=current)
                    self.fds.append(current)
                for part in self.directories:
                    current = os.open(part, flags, dir_fd=current)
                    self.fds.append(current)
                self.fd = current
                return self
            except OSError as exc:
                self.close()
                if exc.errno in {2, 20}:
                    raise HTTPException(404, "Workspace directory not found") from None
                if exc.errno in {13, 40, _not_a_directory_errno()}:
                    raise HTTPException(409, "Workspace path is unsafe or unavailable") from None
                raise HTTPException(409, "Workspace path is unavailable") from None
        if self.platform_name == "windows":
            try:
                self._open_windows()
                return self
            except (OSError, ValueError):
                self.close()
                raise HTTPException(409, "Workspace path is unsafe or unavailable") from None
        raise HTTPException(409, "This workspace platform is not supported by the local frontend")

    def _open_windows(self) -> None:
        normalized = ntpath.normpath(self.root.replace("/", "\\"))
        drive, tail = ntpath.splitdrive(normalized)
        if not drive or drive.startswith("\\") or not tail.startswith("\\"):
            raise ValueError("Workspace must use a local drive path")
        components = [item for item in tail.split("\\") if item]
        components.extend(self.directories)
        current = drive + "\\"
        _open_windows_directory(current, self.handles)
        for part in components:
            current = ntpath.join(current, part)
            _open_windows_directory(current, self.handles)
        self.path = current

    def create_stage(self, name: str) -> tuple[int, str]:
        if self.platform_name in {"linux", "macos"}:
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(name, flags, 0o600, dir_fd=self.fd)
            return fd, name
        stage_path = ntpath.join(self.path, name)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
        return os.open(stage_path, flags, 0o600), stage_path

    def unlink_stage(self, stage: str) -> None:
        try:
            if self.platform_name in {"linux", "macos"}:
                os.unlink(stage, dir_fd=self.fd)
            else:
                os.unlink(stage)
        except FileNotFoundError:
            pass

    def publish(self, stage: str, filename: str) -> tuple[str, bool]:
        stem, extension = (ntpath.splitext(filename) if self.platform_name == "windows"
                           else posixpath.splitext(filename))
        for suffix in range(1, 100_000):
            selected = filename if suffix == 1 else f"{stem} ({suffix}){extension}"
            try:
                if self.platform_name in {"linux", "macos"}:
                    os.link(stage, selected, src_dir_fd=self.fd, dst_dir_fd=self.fd,
                            follow_symlinks=False)
                    os.unlink(stage, dir_fd=self.fd)
                else:
                    # On Windows rename fails when the destination exists, while remaining
                    # atomic on fixed filesystems that do not support hard links.
                    os.rename(stage, ntpath.join(self.path, selected))
                return selected, suffix != 1
            except FileExistsError:
                continue
            except OSError as exc:
                if self.platform_name == "windows" and getattr(exc, "winerror", None) in {80, 183}:
                    continue
                raise
        raise OSError("No unused destination name")

    def open_file(self, filename: str) -> int:
        if self.platform_name in {"linux", "macos"}:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            return os.open(filename, flags, dir_fd=self.fd)
        path = ntpath.join(self.path, filename)
        handle = _open_windows_file(path)
        try:
            import msvcrt
            return msvcrt.open_osfhandle(handle, os.O_RDONLY | getattr(os, "O_BINARY", 0))
        except Exception:
            _close_windows_handle(handle)
            raise

    def close(self) -> None:
        for fd in reversed(self.fds):
            try:
                os.close(fd)
            except OSError:
                pass
        self.fds.clear()
        for handle in reversed(self.handles):
            _close_windows_handle(handle)
        self.handles.clear()


def _not_a_directory_errno() -> int:
    import errno
    return errno.ENOTDIR


def _windows_api():
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                   wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.GetFileInformationByHandleEx.restype = wintypes.BOOL
    kernel.GetFileInformationByHandleEx.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    kernel.GetFileType.restype = wintypes.DWORD
    kernel.GetFileType.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    return kernel


class _FileAttributeTagInfo(ctypes.Structure):
    _fields_ = [("FileAttributes", wintypes.DWORD), ("ReparseTag", wintypes.DWORD)]


def _open_windows_directory(path: str, handles: list[int]) -> None:
    kernel = _windows_api()
    flags = 0x02000000 | 0x00200000  # BACKUP_SEMANTICS | OPEN_REPARSE_POINT
    handle = kernel.CreateFileW(path, 0x80, 0x1 | 0x2, None, 3, flags, None)
    invalid = ctypes.c_void_p(-1).value
    if handle == invalid:
        raise OSError(ctypes.get_last_error(), "Cannot open workspace directory")
    info = _FileAttributeTagInfo()
    if (not kernel.GetFileInformationByHandleEx(handle, 9, ctypes.byref(info), ctypes.sizeof(info))
            or info.FileAttributes & 0x400 or not info.FileAttributes & 0x10):
        kernel.CloseHandle(handle)
        raise OSError("Workspace contains a reparse point or non-directory")
    handles.append(int(handle))


def _open_windows_file(path: str) -> int:
    kernel = _windows_api()
    flags = 0x00200000 | 0x08000000  # OPEN_REPARSE_POINT | SEQUENTIAL_SCAN
    handle = kernel.CreateFileW(path, 0x80000000, 0x1 | 0x2, None, 3, flags, None)
    invalid = ctypes.c_void_p(-1).value
    if handle == invalid:
        code = ctypes.get_last_error()
        raise OSError(code, "Cannot open workspace file")
    info = _FileAttributeTagInfo()
    if (not kernel.GetFileInformationByHandleEx(handle, 9, ctypes.byref(info), ctypes.sizeof(info))
            or info.FileAttributes & (0x400 | 0x10) or kernel.GetFileType(handle) != 1):
        kernel.CloseHandle(handle)
        raise OSError("Workspace file is not a regular file")
    return int(handle)


def _close_windows_handle(handle: int) -> None:
    if os.name == "nt":
        _windows_api().CloseHandle(handle)


def _safe_directory(platform_name: str, root: str, directories: tuple[str, ...]) -> _SafeDirectory:
    return _SafeDirectory(platform_name, root, directories).open()


async def _critical_to_thread(operation, *args):
    """Drain a blocking file operation before propagating task cancellation."""
    worker = asyncio.create_task(asyncio.to_thread(operation, *args))
    cancelled = False
    while not worker.done():
        try:
            await asyncio.shield(worker)
        except asyncio.CancelledError:
            cancelled = True
    try:
        result = worker.result()
    except BaseException:
        if cancelled:
            raise asyncio.CancelledError
        raise
    if cancelled:
        raise asyncio.CancelledError
    return result


async def _open_authoritative_directory(session_id: str, expected: str, relative_dirs: tuple[str, ...]):
    platform_name, root = await _session_workspace(session_id, expected)
    acquired = {}
    def open_and_record():
        directory = _safe_directory(platform_name, root, relative_dirs)
        acquired["directory"] = directory
        return directory
    try:
        return await _critical_to_thread(open_and_record)
    except asyncio.CancelledError:
        directory = acquired.get("directory")
        if directory is not None:
            await _critical_to_thread(directory.close)
        raise


def _write_all(stream, data: bytes) -> None:
    view = memoryview(data)
    written = 0
    while written < len(view):
        count = stream.write(view[written:])
        if not count:
            raise OSError("Workspace upload write made no progress")
        written += count


@router.post("/{session_id}/upload")
async def upload_workspace_file(
    session_id: str,
    request: Request,
    path: str = Query(default="", max_length=4096),
    workspace: str = Query(..., min_length=1, max_length=4096),
):
    require_workbench_page(request)
    if not re.fullmatch(_ID, session_id):
        raise HTTPException(404, "Active session not found")
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/octet-stream":
        raise HTTPException(415, "Use application/octet-stream")
    filename = _filename(request.headers.get("x-filename", ""))
    relative_dirs = _relative_parts(path, allow_empty=True)
    directory = await _open_authoritative_directory(session_id, workspace, relative_dirs)
    stage_name = ".lka-upload-" + uuid.uuid4().hex + ".tmp"
    acquired_stage = {}
    stage = ""
    stage_fd = None
    stream = None
    size = 0
    try:
        def create_and_record_stage():
            fd, stage_path = directory.create_stage(stage_name)
            acquired_stage.update(fd=fd, path=stage_path)
            return fd, stage_path
        stage_fd, stage = await _critical_to_thread(create_and_record_stage)
        stream = os.fdopen(stage_fd, "wb", buffering=0)
        stage_fd = None
        acquired_stage["fd"] = None
        async for chunk in request.stream():
            size += len(chunk)
            if size > _MAX_UPLOAD_BYTES:
                raise HTTPException(413, "File exceeds the 64 MiB upload limit")
            await _critical_to_thread(_write_all, stream, chunk)
        await _critical_to_thread(stream.flush)
        await _critical_to_thread(os.fsync, stream.fileno())
        await _critical_to_thread(stream.close)
        stream = None
        # Do not publish into a workspace that changed or whose session was deleted mid-upload.
        await _session_workspace(session_id, workspace)
        filename_saved, renamed = await _critical_to_thread(directory.publish, stage, filename)
        stage = ""
        saved_path = "/".join((*relative_dirs, filename_saved))
        return {"filename": filename_saved, "path": saved_path, "size_bytes": size, "renamed": renamed}
    except HTTPException:
        raise
    except OSError:
        raise HTTPException(409, "Workspace file could not be saved safely") from None
    finally:
        def cleanup_upload():
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
            elif stage_fd is not None:
                try:
                    os.close(stage_fd)
                except OSError:
                    pass
            elif acquired_stage.get("fd") is not None:
                try:
                    os.close(acquired_stage["fd"])
                except OSError:
                    pass
                acquired_stage["fd"] = None
            cleanup_stage = stage or acquired_stage.get("path", "")
            if cleanup_stage:
                try:
                    directory.unlink_stage(cleanup_stage)
                except OSError:
                    pass
            directory.close()
        try:
            await _critical_to_thread(cleanup_upload)
        except OSError:
            pass


@router.get("/{session_id}/download")
async def download_workspace_file(
    session_id: str,
    request: Request,
    path: str = Query(..., min_length=1, max_length=4096),
    workspace: str = Query(..., min_length=1, max_length=4096),
):
    require_workbench_page(request)
    if not re.fullmatch(_ID, session_id):
        raise HTTPException(404, "Active session not found")
    relative_parts = _relative_parts(path, allow_empty=False)
    directory = await _open_authoritative_directory(session_id, workspace, relative_parts[:-1])
    opened = {}
    fd = None
    file_stream = None
    transferred_to_response = False
    try:
        def open_and_record_file():
            file_fd = directory.open_file(relative_parts[-1])
            opened["fd"] = file_fd
            return file_fd
        fd = await _critical_to_thread(open_and_record_file)
        metadata = await _critical_to_thread(os.fstat, fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise HTTPException(404, "Workspace file not found")
        if metadata.st_size > _MAX_DOWNLOAD_BYTES:
            raise HTTPException(413, "File exceeds the 128 MiB download limit")
        file_stream = os.fdopen(fd, "rb", buffering=0)
        fd = None
        filename = relative_parts[-1]
        content_disposition = "attachment; filename*=UTF-8''" + quote(filename, safe="")

        close_lock = threading.Lock()
        closed = False
        def close_download():
            nonlocal closed
            with close_lock:
                if closed:
                    return
                closed = True
                try:
                    file_stream.close()
                finally:
                    directory.close()

        async def body():
            sent = 0
            try:
                while sent < metadata.st_size:
                    block = await _critical_to_thread(
                        file_stream.read, min(_CHUNK_SIZE, metadata.st_size - sent)
                    )
                    if not block:
                        break
                    sent += len(block)
                    yield block
            finally:
                await _critical_to_thread(close_download)

        response = _ClosingStreamingResponse(body(), close_callback=close_download,
            media_type="application/octet-stream", headers={
                "Content-Length": str(metadata.st_size),
                "Content-Disposition": content_disposition,
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            })
        transferred_to_response = True
        return response
    except HTTPException:
        raise
    except OSError:
        raise HTTPException(404, "Workspace file not found") from None
    finally:
        if not transferred_to_response:
            def cleanup_download():
                file_fd = fd if fd is not None else opened.get("fd")
                if file_stream is not None:
                    try:
                        file_stream.close()
                    except OSError:
                        pass
                elif file_fd is not None:
                    try:
                        os.close(file_fd)
                    except OSError:
                        pass
                directory.close()
            try:
                await _critical_to_thread(cleanup_download)
            except OSError:
                pass
