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


@router.api_route("/workbench/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def workbench_proxy(path: str, request: Request):
    require_workbench_page(request)
    if not _route(request.method, path, set(request.query_params.keys())):
        raise HTTPException(404, "Unsupported workbench request")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > _MAX_BODY:
            raise HTTPException(413, "Request too large")
    base = _upstream()
    headers = {"Accept": request.headers.get("accept", "application/json")}
    content_type = request.headers.get("content-type")
    if content_type:
        headers["Content-Type"] = content_type
    url = base + "/" + quote(path, safe="/")
    try:
        streaming_request = path in _STREAMS or path.endswith("/stream") or path == "background/events"
        timeout = httpx.Timeout(connect=10, read=None if streaming_request else 30, write=30, pool=10)
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
        status = upstream.status_code if upstream.status_code in {400, 401, 403, 404, 409, 413, 422, 429} else 502
        await upstream.aclose()
        await client.aclose()
        return Response(json.dumps({"detail": "workbench_request_failed"}), status_code=status,
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
        limit = _MAX_FILE_RESPONSE if path.endswith("/file/raw") else _MAX_RESPONSE
        async for chunk in upstream.aiter_bytes():
            size += len(chunk)
            if size > limit:
                raise HTTPException(502, "Workbench response too large")
            chunks.append(chunk)
        status = upstream.status_code
        return Response(b"".join(chunks), status_code=status, media_type=media_type,
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    except httpx.HTTPError:
        raise HTTPException(502, "Workbench backend unavailable") from None
    finally:
        await upstream.aclose()
        await client.aclose()
