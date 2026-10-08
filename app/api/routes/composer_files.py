"""Local-only durable cache for generic composer uploads."""
from __future__ import annotations

import json
import functools
import os
import tempfile
import uuid
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from app.api.routes.workbench_proxy import require_workbench_page

router = APIRouter(prefix="/pet", tags=["composer-files"])

_COMPOSER_CACHE_DIR = Path(__file__).resolve().parents[3] / ".runtime" / "pet-composer-cache"
_FILENAME_MAX_BYTES = 240
_MAX_COMPOSER_FILE = 10 * 1024 * 1024


def _safe_cache_filename(encoded: str) -> str:
    try:
        value = unquote(encoded, errors="strict")
    except (UnicodeError, ValueError):
        raise HTTPException(422, "Invalid filename encoding") from None
    value = value.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if (not value or value in {".", ".."} or any(ord(char) < 32 or ord(char) == 127 for char in value)
            or len(value.encode("utf-8")) > _FILENAME_MAX_BYTES):
        raise HTTPException(422, "Invalid filename")
    return value


def _store_cache_file(*, directory: Path, cache_id: str, raw: bytes, metadata: dict) -> None:
    """Persist bytes and metadata off the event loop using atomic replacements."""
    data_path = directory / (cache_id + ".bin")
    metadata_path = directory / (cache_id + ".json")
    temporary_name = ""
    temp_meta = directory / ("." + cache_id + ".json.tmp")
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if directory.is_symlink():
            raise OSError("Unsafe cache directory")
        fd, temporary_name = tempfile.mkstemp(prefix=".upload-", dir=directory)
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if os.name == "posix":
            os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, data_path)
        descriptor = os.open(temp_meta, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(metadata, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_meta, metadata_path)
    except OSError:
        for path in (Path(temporary_name) if temporary_name else None, data_path, metadata_path, temp_meta):
            if path is None:
                continue
            try:
                path.unlink()
            except OSError:
                pass
        raise


@router.post("/composer-files")
async def cache_composer_file(request: Request):
    require_workbench_page(request)
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/octet-stream":
        raise HTTPException(415, "Use application/octet-stream")
    filename_header = request.headers.get("x-filename", "")
    if not filename_header:
        raise HTTPException(422, "Filename is required")
    filename = _safe_cache_filename(filename_header)
    cache_id = uuid.uuid4().hex
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > _MAX_COMPOSER_FILE:
            raise HTTPException(413, "File exceeds the 10 MiB cache limit")
        raw.extend(chunk)
    if not raw:
        raise HTTPException(422, "Empty files cannot be cached")
    metadata = {"cache_id": cache_id, "filename": filename, "size_bytes": len(raw),
                "status": "cached", "agent_ready": False}
    try:
        await run_in_threadpool(
            functools.partial(
                _store_cache_file, directory=_COMPOSER_CACHE_DIR, cache_id=cache_id,
                raw=bytes(raw), metadata=metadata,
            )
        )
    except OSError:
        raise HTTPException(503, "Local file cache unavailable") from None
    return metadata
