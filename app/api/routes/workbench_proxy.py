"""Explicit, bounded proxy for the desktop workbench API."""
from __future__ import annotations

import ipaddress
import json
import os
import re
from urllib.parse import quote, urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

router = APIRouter()
_ID = r"[A-Za-z0-9_-]{1,200}"
_ROUTES = (
    ("GET", r"agent/models", {"refresh"}),
    ("GET", r"agent/ui-defaults", set()), ("PUT", r"agent/ui-defaults", set()),
    ("POST", r"agent/turn", set()), ("POST", r"agent/turn/stream", set()),
    ("GET", r"agent/safety-reviews", set()),
    ("POST", r"agent/safety-reviews/" + _ID + r"/decision", set()),
    ("GET", r"agent/runs/" + _ID, set()),
    ("GET", r"agent/runs/" + _ID + r"/snapshot", set()),
    ("GET", r"agent/runs/" + _ID + r"/events", {"after_sequence", "limit"}),
    ("GET", r"agent/runs/" + _ID + r"/stream", {"after_sequence"}),
    ("POST", r"agent/runs/" + _ID + r"/cancel", set()),
    ("POST", r"agent/runs/" + _ID + r"/resume", set()),
    ("POST", r"agent/runs/" + _ID + r"/continue", set()),
    ("POST", r"agent/runs/" + _ID + r"/children/" + _ID + r"/(?:cancel|retry)", set()),
    ("GET", r"sessions", {"limit", "offset", "q", "project_id"}), ("POST", r"sessions", set()),
    ("GET", r"knowledge/file-types", set()),
    ("POST", r"sessions/" + _ID + r"/attachments", set()),
    ("GET", r"sessions/" + _ID + r"/attachments/att_[0-9a-f]{32}", set()),
    ("GET", r"sessions/" + _ID + r"/attachments/att_[0-9a-f]{32}/raw", set()),
    ("GET", r"sessions/deleted", {"limit", "offset", "q"}),
    ("GET", r"sessions/" + _ID, set()), ("PATCH", r"sessions/" + _ID, set()),
    ("DELETE", r"sessions/" + _ID, {"only_if_empty", "expected_updated_at"}),
    ("POST", r"sessions/" + _ID + r"/restore", set()),
    ("PUT", r"sessions/" + _ID + r"/workspace", set()),
    ("GET", r"sessions/" + _ID + r"/files", {"path", "query", "offset", "limit"}),
    ("GET", r"sessions/" + _ID + r"/file", {"path"}),
    ("GET", r"sessions/" + _ID + r"/file/raw", {"path"}),
    ("GET", r"projects", {"limit", "offset", "q"}), ("POST", r"projects", set()),
    ("GET", r"projects/" + _ID, set()), ("PATCH", r"projects/" + _ID, set()),
    ("GET", r"projects/" + _ID + r"/sessions", {"limit", "offset", "q"}),
    ("GET", r"memories", {"scope", "workspace_path", "include_candidates", "limit", "offset"}),
    ("GET", r"memories/export", {"scope", "workspace_path", "include_candidates", "limit", "offset"}),
    ("GET", r"memories/learning", {"scope", "workspace_path"}), ("PUT", r"memories/learning", set()),
    ("GET", r"memories/" + _ID, {"workspace_path"}),
    ("GET", r"memories/" + _ID + r"/sources", {"workspace_path"}),
    ("PATCH", r"memories/" + _ID, set()), ("POST", r"memories", set()),
    ("DELETE", r"memories/" + _ID, {"workspace_path", "expected_version"}),
    ("POST", r"memories/projects/" + _ID + r"/relocate", set()),
    ("GET", r"memories/file", {"scope", "workspace_path"}),
    ("POST", r"memories/file/generate", {"scope", "workspace_path"}),
    ("GET", r"memories/file/preview", {"scope", "workspace_path"}),
    ("POST", r"memories/file/import", {"scope", "workspace_path"}),
    ("GET", r"background/jobs", {"scope", "limit", "offset"}),
    ("GET", r"background/health", set()),
    ("POST", r"background/jobs/" + _ID + r"/(?:retry|cancel)", set()),
    ("GET", r"background/config", set()), ("GET", r"background/config/schema", set()),
    ("PATCH", r"background/config", set()), ("DELETE", r"background/config", {"expected_revision"}),
    ("GET", r"background/events", {"interval"}),
    ("POST", r"workspaces/index", set()), ("GET", r"openapi\.json", set()),
)
_MAX_BODY = 1024 * 1024
_MAX_RESPONSE = 8 * 1024 * 1024
_MAX_FILE_RESPONSE = 128 * 1024 * 1024
_MAX_IMAGE_UPLOAD = 10 * 1024 * 1024
_MAX_DOCUMENT_UPLOAD = 64 * 1024 * 1024
_MAX_IMAGE_RESPONSE = 10 * 1024 * 1024
_MAX_DOCUMENT_RESPONSE = 64 * 1024 * 1024
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".heic", ".heif", ".bmp", ".tif", ".tiff"}
_STREAMS = {"agent/turn/stream"}


def _loopback(host: str) -> bool:
    try:
        address = ipaddress.ip_address(host)
        mapped = getattr(address, "ipv4_mapped", None)
        return address.is_loopback or bool(mapped and mapped.is_loopback)
    except ValueError:
        return host.lower() == "localhost"


def _origin(value: str):
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username
                or parsed.password or parsed.path or parsed.query or parsed.fragment):
            return None
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        return parsed.scheme.lower(), parsed.hostname.lower(), port
    except ValueError:
        return None


def is_local_page(request: Request) -> bool:
    peer = request.client.host if request.client else ""
    return _loopback(peer) and _loopback(request.url.hostname or "")


def require_workbench_page(request: Request) -> None:
    """Require local same-origin access, or an explicitly allowlisted remote origin."""
    host = request.url.hostname or ""
    local = is_local_page(request)
    allowed = {_origin(item.strip()) for item in os.environ.get("LKA_WORKBENCH_ORIGINS", "").split(";") if item.strip()}
    request_origin = (request.url.scheme, host.lower(), request.url.port or (443 if request.url.scheme == "https" else 80))
    remote_allowed = not local and request_origin in allowed
    if not (local or remote_allowed):
        raise HTTPException(403, "Workbench access denied")
    origin = request.headers.get("origin")
    if origin:
        parsed_origin = _origin(origin)
        if parsed_origin != request_origin:
            raise HTTPException(403, "Same origin required")
    fetch_site = request.headers.get("sec-fetch-site", "").lower()
    if fetch_site == "cross-site" or fetch_site == "same-site" and not origin:
        raise HTTPException(403, "Same origin required")
    if fetch_site and fetch_site not in {"same-origin", "same-site", "none", "cross-site"}:
        raise HTTPException(403, "Same origin required")


def _route(method: str, path: str, query_names) -> bool:
    if any(part in {".", ".."} for part in path.split("/")):
        return False
    return any(method == verb and re.fullmatch(pattern, path) and query_names <= allowed
               for verb, pattern, allowed in _ROUTES)


def _upstream() -> str:
    raw = (os.environ.get("LKA_WORKBENCH_BACKEND_URL")
           or os.environ.get("LKA_MESSAGE_READING_BACKEND_URL")
           or "http://127.0.0.1:8765").strip()
    try:
        parsed = urlsplit(raw)
        valid = (parsed.scheme == "http" and _loopback(parsed.hostname or "")
                 and parsed.port in {None, 80, 8765} and not parsed.username
                 and not parsed.password and not parsed.query and not parsed.fragment
                 and parsed.path in {"", "/"})
    except ValueError:
        valid = False
    if not valid:
        raise HTTPException(503, "Workbench backend unavailable")
    return raw.rstrip("/")


async def _bounded_error_body(upstream: httpx.Response, limit: int = 8192) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in upstream.aiter_bytes(chunk_size=limit):
        if size + len(chunk) > limit:
            return b""
        chunks.append(chunk)
        size += len(chunk)
    return b"".join(chunks)


@router.api_route("/workbench/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def workbench_proxy(path: str, request: Request):
    require_workbench_page(request)
    if not _route(request.method, path, set(request.query_params.keys())):
        raise HTTPException(404, "Unsupported workbench request")
    is_attachment_upload = request.method == "POST" and bool(
        re.fullmatch(r"sessions/" + _ID + r"/attachments", path)
    )
    filename_header = request.headers.get("x-filename", "")
    decoded_filename = filename_header.rsplit("/", 1)[-1].lower()
    is_image_upload = is_attachment_upload and (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower().startswith("image/")
        or any(decoded_filename.endswith(ext) for ext in _IMAGE_EXTENSIONS)
    )
    body_limit = (_MAX_IMAGE_UPLOAD if is_image_upload else _MAX_DOCUMENT_UPLOAD) if is_attachment_upload else _MAX_BODY
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > body_limit:
            message = ("Image exceeds 10 MiB" if is_image_upload else
                       "Document exceeds 64 MiB" if is_attachment_upload else "Request too large")
            raise HTTPException(413, message)
    if is_attachment_upload and not filename_header:
        raise HTTPException(422, "Attachment filename is required")
    base = _upstream()
    headers = {"Accept": request.headers.get("accept", "application/json")}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["Content-Type"] = content_type
    if is_attachment_upload:
        headers["X-Filename"] = filename_header
    url = base + "/" + quote(path, safe="/")
    try:
        streaming_request = path in _STREAMS or path.endswith("/stream") or path == "background/events"
        timeout = httpx.Timeout(connect=10, read=None if streaming_request else 180 if is_attachment_upload and not is_image_upload else 30, write=30, pool=10)
        client = httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False)
        headers["Accept-Encoding"] = "identity"
        upstream_request = client.build_request(request.method, url,
            params=list(request.query_params.multi_items()), headers=headers, content=bytes(body))
        upstream = await client.send(upstream_request, stream=True)
    except BaseException as exc:
        if "client" in locals():
            await client.aclose()
        if isinstance(exc, httpx.HTTPError):
            raise HTTPException(502, "Workbench backend unavailable") from None
        raise
    media_type = upstream.headers.get("content-type", "application/octet-stream")
    if upstream.status_code >= 400:
        status = upstream.status_code if upstream.status_code in {400, 401, 403, 404, 409, 413, 415, 422, 429} else 502
        detail = "workbench_request_failed"
        try:
            if ("/attachments" in path and status in {413, 415, 422}) or path in {"agent/turn", "agent/turn/stream"}:
                try:
                    bounded_body = await _bounded_error_body(upstream)
                    upstream_error = json.loads(bounded_body.decode("utf-8")) if bounded_body else {}
                except (ValueError, UnicodeError, httpx.HTTPError):
                    upstream_error = {}
                raw_detail = upstream_error.get("detail") if isinstance(upstream_error, dict) else None
                if "/attachments" in path and status in {413, 415, 422}:
                    known_errors = {
                        "Attachment exceeds 10 MiB.": "Image exceeds the 10 MiB upload limit.",
                        "Attachment exceeds 64 MiB.": "Document exceeds the 64 MiB upload limit.",
                        "Unsupported attachment file type.": "This document file type is not supported.",
                        "Document media type does not match its filename.": "The document content type does not match its file type.",
                        "Binary source does not match declared text type.": "The selected document does not match its file type.",
                        "Invalid, encrypted or unreadable document, or no extractable text.": "The document is unreadable or contains no extractable text.",
                        "Invalid, encrypted or unreadable document, or no extractable text. PDF text-layer extraction only; scanned PDFs require separate OCR.": "The PDF is unreadable or has no extractable text. Scanned PDFs require OCR.",
                        "Document extraction metadata exceeds its limit.": "The document contains too much extraction metadata.",
                        "Image exceeds four million pixels.": "Image exceeds the four million pixel limit.",
                        "Animated or multi-frame images are not supported.": "Animated or multi-frame images are not supported.",
                        "Only PNG, JPEG and WebP images are supported.": "Choose a PNG, JPEG, or WebP image.",
                        "Image content does not match its media type.": "The selected image does not match its file type.",
                        "Invalid or corrupt image.": "The selected image is invalid or corrupt.",
                        "Invalid attachment filename.": "The image filename is invalid.",
                        "Attachment filename is too long.": "The image filename is too long.",
                    }
                    if isinstance(raw_detail, str) and raw_detail in known_errors:
                        detail = known_errors[raw_detail]
                elif raw_detail == "Selected model has not enabled image input (supports_vision).":
                    detail = "The selected model does not have image input enabled."
        finally:
            try:
                await upstream.aclose()
            finally:
                await client.aclose()
        return Response(json.dumps({"detail": detail}), status_code=status,
                        media_type="application/json", headers={"Cache-Control": "no-store"})
    if (path in _STREAMS or path.endswith("/stream") or path == "background/events"
            or path.endswith("/file/raw") or media_type.lower().startswith("text/event-stream")):
        async def relay():
            try:
                total = 0
                limit = _MAX_FILE_RESPONSE if path.endswith("/file/raw") else None
                async for chunk in upstream.aiter_bytes():
                    total += len(chunk)
                    if limit is not None and total > limit:
                        break
                    yield chunk
            except httpx.HTTPError:
                # The downstream response has started; terminate without exposing upstream diagnostics.
                return
            finally:
                await upstream.aclose()
                await client.aclose()
        return StreamingResponse(relay(), status_code=upstream.status_code, media_type=media_type,
                                 headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    try:
        chunks, size = [], 0
        is_attachment_raw = path.endswith("/raw") and "/attachments/" in path
        disposition = upstream.headers.get("content-disposition")
        is_document_raw = is_attachment_raw and (
            bool(disposition) or not media_type.lower().startswith("image/")
        )
        limit = (_MAX_DOCUMENT_RESPONSE if is_document_raw else _MAX_IMAGE_RESPONSE) if is_attachment_raw else _MAX_FILE_RESPONSE if path.endswith("/file/raw") else _MAX_RESPONSE
        async for chunk in upstream.aiter_bytes():
            size += len(chunk)
            if size > limit:
                raise HTTPException(502, "Workbench response too large")
            chunks.append(chunk)
        status = upstream.status_code
        response_headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
        if is_attachment_raw:
            if disposition:
                response_headers["Content-Disposition"] = disposition
            elif is_document_raw:
                response_headers["Content-Disposition"] = "attachment"
        return Response(b"".join(chunks), status_code=status, media_type=media_type,
                        headers=response_headers)
    except httpx.HTTPError:
        raise HTTPException(502, "Workbench backend unavailable") from None
    finally:
        await upstream.aclose()
        await client.aclose()
