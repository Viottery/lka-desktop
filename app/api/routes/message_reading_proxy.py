"""Bounded local UI proxy. The control credential never enters the page."""
import json
import os
import re
import asyncio
from urllib.parse import quote, urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

router = APIRouter()
_SEGMENT = r"[A-Za-z0-9_-]{1,160}"
_SENDER = r"[^/\\\x00-\x20\x7f%?#]{1,160}"
# Exact routes and per-endpoint query names; values are validated by the backend.
_ROUTES = (
    ('GET', 'messages/policies', frozenset([])),
    ('PUT', 'messages/policies', frozenset([])),
    ('GET', 'messages/conversations', frozenset(['limit', 'offset'])),
    ('GET', 'messages/conversations/resolve', frozenset(['query'])),
    ('GET', 'messages/conversations/[A-Za-z0-9_-]{1,160}/metadata', frozenset([])),
    ('GET', 'messages/conversations/[A-Za-z0-9_-]{1,160}/history', frozenset(['before_seq', 'limit'])),
    ('GET', 'messages/conversations/[A-Za-z0-9_-]{1,160}/summary', frozenset([])),
    ('GET', 'messages/conversations/[A-Za-z0-9_-]{1,160}/coverage', frozenset([])),
    ('GET', 'messages/conversations/[A-Za-z0-9_-]{1,160}/facts', frozenset(['limit', 'offset'])),
    ('GET', 'messages/conversations/[A-Za-z0-9_-]{1,160}/digest', frozenset([])),
    ('PATCH', 'messages/conversations/[A-Za-z0-9_-]{1,160}/metadata', frozenset([])),
    ('POST', 'messages/conversations/[A-Za-z0-9_-]{1,160}/analyze', frozenset([])),
    ('POST', 'messages/conversations/[A-Za-z0-9_-]{1,160}/retry', frozenset([])),
    ('GET', 'messages/search', frozenset(['query', 'conversation_key', 'sender', 'sender_id', 'since', 'until', 'limit', 'offset'])),
    ('GET', 'messages/recent', frozenset(['conversation_key', 'since', 'limit', 'offset'])),
    ('GET', 'messages/records/[A-Za-z0-9_-]{1,160}', frozenset([])),
    ('GET', 'messages/records/[A-Za-z0-9_-]{1,160}/context', frozenset(['before', 'after'])),
    ('GET', 'messages/attachments', frozenset(['conversation_key', 'kind', 'query', 'limit', 'offset'])),
    ('GET', 'messages/attachments/[A-Za-z0-9_-]{1,160}', frozenset([])),
    ('GET', 'messages/attachments/[A-Za-z0-9_-]{1,160}/content', frozenset([])),
    ('GET', 'messages/reading/participants', frozenset(['conversation_key', 'limit', 'cursor'])),
    ('GET', 'messages/reading/participants/[A-Za-z0-9_-]{1,160}/[^/\\\\\\x00-\\x20\\x7f%?#]{1,160}', frozenset([])),
    ('GET', 'messages/reading/participants/[A-Za-z0-9_-]{1,160}/[^/\\\\\\x00-\\x20\\x7f%?#]{1,160}/sources', frozenset(['limit', 'cursor'])),
    ('POST', 'messages/reading/participants/[A-Za-z0-9_-]{1,160}/[^/\\\\\\x00-\\x20\\x7f%?#]{1,160}/control', frozenset([])),
    ('GET', 'messages/reading/dossiers', frozenset(['conversation_key', 'limit', 'offset'])),
    ('GET', 'messages/reading/dossiers/[A-Za-z0-9_-]{1,160}/[^/\\\\\\x00-\\x20\\x7f%?#]{1,160}', frozenset(['limit', 'offset'])),
    ('GET', 'messages/reading/dossiers/[A-Za-z0-9_-]{1,160}/[^/\\\\\\x00-\\x20\\x7f%?#]{1,160}/sources', frozenset(['limit', 'offset'])),
    ('GET', 'messages/reading/focus/[A-Za-z0-9_-]{1,160}', frozenset([])),
    ('PUT', 'messages/reading/focus/[A-Za-z0-9_-]{1,160}', frozenset([])),
    ('GET', 'messages/reading/overview', frozenset(['conversation_key'])),
    ('GET', 'messages/reading/topics', frozenset(['conversation_key', 'limit', 'cursor', 'since', 'until'])),
    ('GET', 'messages/reading/topics/[A-Za-z0-9_-]{1,160}', frozenset([])),
    ('GET', 'messages/reading/topics/[A-Za-z0-9_-]{1,160}/sources', frozenset(['limit', 'cursor'])),
    ('GET', 'messages/reading/insights', frozenset(['conversation_key', 'limit', 'cursor', 'since', 'until', 'importance', 'unseen', 'kind'])),
    ('GET', 'messages/reading/insights/[A-Za-z0-9_-]{1,160}', frozenset([])),
    ('GET', 'messages/reading/insights/[A-Za-z0-9_-]{1,160}/sources', frozenset(['limit', 'cursor'])),
    ('POST', 'messages/reading/insights/[A-Za-z0-9_-]{1,160}/attention', frozenset([])),
    ('GET', 'messages/reading/profile', frozenset(['scope'])),
    ('PUT', 'messages/reading/profile', frozenset(['scope'])),
    ('GET', 'messages/matter-proposals', frozenset(['conversation_key', 'limit', 'cursor', 'state', 'since', 'until'])),
    ('GET', 'messages/matter-proposals/[A-Za-z0-9_-]{1,160}', frozenset([])),
    ('POST', 'messages/matter-proposals/[A-Za-z0-9_-]{1,160}/decision', frozenset([])),
    ('POST', 'messages/matter-proposals/[A-Za-z0-9_-]{1,160}/revalidate', frozenset([])),
    ('GET', 'messages/reading/evaluation/badcases', frozenset(['limit', 'cursor'])),
    ('GET', 'messages/reading/evaluation/badcases/[A-Za-z0-9_-]{1,160}', frozenset([])),
    ('POST', 'messages/reading/evaluation/badcases', frozenset([])),
    ('POST', 'messages/reading/evaluation/badcases/preview', frozenset([])),
    ('GET', 'background/services/message-reading', frozenset([])),
    ('POST', 'background/services/message-reading/pause', frozenset([])),
    ('POST', 'background/services/message-reading/resume', frozenset([])),
    ('GET', 'background/config', frozenset([])),
    ('GET', 'background/config/schema', frozenset([])),
    ('PATCH', 'background/config', frozenset([])),
    ('GET', 'agent/models', frozenset([])),
)
_MAX_BODY = 32768
_MAX_RESPONSE = 1048576


def allowed_request(method, path):
    if any(segment in {".", ".."} for segment in path.split("/")):
        return False
    return any(method == verb and re.fullmatch(pattern, path)
               for verb, pattern, _ in _ROUTES)


def allowed_query(method, path, names):
    for verb, pattern, allowed in _ROUTES:
        if method == verb and re.fullmatch(pattern, path):
            return all(name in allowed for name in names)
    return False


def require_local_page(request):
    from app.api.routes.plugins import _loopback
    if not request.client or not _loopback(request.client.host) or not _loopback(request.url.hostname or ""):
        raise HTTPException(403, "Local access only")
    origin = request.headers.get("origin")
    if origin:
        parsed = urlsplit(origin)
        if parsed.scheme != request.url.scheme or parsed.netloc != request.url.netloc or parsed.path or parsed.query or parsed.fragment:
            raise HTTPException(403, "Same origin required")
    # A Java bridge has no Origin; ordinary cross-site browser writes do.
    if request.headers.get("sec-fetch-site") in {"cross-site", "same-site"}:
        raise HTTPException(403, "Same origin required")


@router.api_route("/message-reading/{path:path}", methods=["GET", "POST", "PUT", "PATCH"])
async def message_reading_proxy(path: str, request: Request):
    require_local_page(request)
    if not allowed_request(request.method, path) or not allowed_query(request.method, path, request.query_params):
        raise HTTPException(404, "Unsupported reading request")
    token = os.environ.get("LKA_MESSAGES_CONTROL_TOKEN", "").strip()
    if not token:
        raise HTTPException(401, "Message control is not paired")
    base = os.environ.get("LKA_MESSAGE_READING_BACKEND_URL", "http://127.0.0.1:8765").rstrip("/")
    from app.api.routes.plugins import _loopback
    try:
        address = urlsplit(base)
        valid = address.scheme == "http" and _loopback(address.hostname or "") and not address.username and not address.password and not address.query and not address.fragment and address.path in {"", "/"}
    except ValueError:
        valid = False
    if not valid:
        raise HTTPException(503, "Message backend unavailable")
    if request.method == "GET" and re.fullmatch(r"messages/attachments/" + _SEGMENT + r"/content", path):
        return await _attachment_content(request, base, path, token)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > _MAX_BODY:
            raise HTTPException(413, "Request too large")
    if body:
        try:
            payload = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            raise HTTPException(422, "Invalid JSON") from None
        if not isinstance(payload, dict):
            raise HTTPException(422, "Invalid request")
        if path == "background/config":
            if (set(payload) - {"expected_revision", "message_history", "background"}
                    or not isinstance(payload.get("message_history", {}), dict)
                    or not isinstance(payload.get("background", {}), dict)
                    or set(payload.get("background", {})) - {"daily_cost_limit"}):
                raise HTTPException(422, "Only message settings and shared cost cap are allowed")
    headers = {"X-LKA-Messages-Token": token, "Accept": "application/json", "Content-Type": "application/json"}
    try:
        # No forwarded browser auth, Host, Origin, cookies or arbitrary destination.
        async with httpx.AsyncClient(timeout=25, follow_redirects=False, trust_env=False) as client:
            async with client.stream(request.method, base + "/" + quote(path, safe="/"),
                                     params=list(request.query_params.multi_items()), headers=headers,
                                     content=bytes(body)) as upstream:
                response_body = bytearray()
                async for chunk in upstream.aiter_bytes():
                    response_body.extend(chunk)
                    if len(response_body) > _MAX_RESPONSE:
                        raise HTTPException(502, "Reading response too large")
                if not 200 <= upstream.status_code < 300:
                    code = upstream.status_code if upstream.status_code in {401, 403, 404, 409, 422, 503} else 502
                    return Response(json.dumps({"detail": "reading_request_failed"}), status_code=code,
                                    media_type="application/json", headers={"Cache-Control": "no-store"})
                is_person_name_route = (request.method == "GET" and _is_person_name_route(path))
                if request.method == "GET" and (_may_contain_message_rows(path) or is_person_name_route) and "application/json" in upstream.headers.get("content-type", "").lower():
                    try:
                        decoded = json.loads(response_body)
                    except (ValueError, UnicodeDecodeError):
                        decoded = None
                    reader = getattr(request.app.state, "qq_reader", None)
                    db_path = getattr(reader, "_db_path", None)
                    if decoded is not None and db_path is not None:
                        try:
                            if _may_contain_message_rows(path):
                                from app.plugins.message_ui_content import enrich_authorized_rows
                                decoded = await asyncio.to_thread(enrich_authorized_rows, decoded, db_path)
                            if is_person_name_route:
                                from app.plugins.message_people import enrich_participant_names
                                decoded = await asyncio.to_thread(enrich_participant_names, decoded, db_path)
                            enriched_body = json.dumps(decoded, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                            if len(enriched_body) <= _MAX_RESPONSE:
                                response_body = bytearray(enriched_body)
                        except Exception:
                            # Local metadata enrichment is optional; preserve a valid backend response.
                            pass
                return Response(bytes(response_body), media_type="application/json",
                                headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    except httpx.HTTPError:
        raise HTTPException(503, "Message backend unavailable") from None


def _may_contain_message_rows(path: str) -> bool:
    return (path == "messages/search"
            or re.fullmatch(r"messages/conversations/" + _SEGMENT + r"/history", path) is not None
            or re.fullmatch(r"messages/records/" + _SEGMENT + r"(?:/context)?", path) is not None
            or (path.startswith("messages/reading/") and path.endswith("/sources")))


def _is_person_name_route(path: str) -> bool:
    return (path in {"messages/reading/participants", "messages/reading/dossiers"}
            or re.fullmatch(r"messages/reading/participants/" + _SEGMENT + r"/" + _SENDER, path) is not None
            or re.fullmatch(r"messages/reading/dossiers/" + _SEGMENT + r"/" + _SENDER, path) is not None)


async def _attachment_content(request, base, path, token):
    """Bounded same-origin media relay; private CONTROL header stays on the host."""
    from fastapi.responses import StreamingResponse
    headers = {"X-LKA-Messages-Token": token, "Accept": "image/*,video/*"}
    range_header = request.headers.get("range")
    if range_header:
        if not re.fullmatch(r"bytes=(?:[0-9]{1,12}-[0-9]{0,12}|-[0-9]{1,12})", range_header):
            raise HTTPException(416, "Invalid media range")
        headers["Range"] = range_header
    client = httpx.AsyncClient(timeout=25, follow_redirects=False, trust_env=False)
    upstream = None
    maximum = 200 * 1024 * 1024
    try:
        upstream = await client.send(client.build_request("GET", base + "/" + quote(path, safe="/"), headers=headers), stream=True)
        if upstream.status_code not in {200, 206}:
            code = upstream.status_code if upstream.status_code in {401, 403, 404, 416, 503} else 502
            raise HTTPException(code, "Media unavailable")
        mime = upstream.headers.get("content-type", "").split(";", 1)[0].strip()
        if mime not in {"image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4", "video/webm"}:
            raise HTTPException(502, "Unsupported media response")
        try:
            length = int(upstream.headers.get("content-length", ""))
        except ValueError:
            raise HTTPException(502, "Invalid media response") from None
        if not 0 <= length <= maximum or upstream.headers.get("content-encoding"):
            raise HTTPException(502, "Media response too large")
        result_headers = {"Cache-Control":"no-store", "X-Content-Type-Options":"nosniff",
                          "Content-Security-Policy":"default-src 'none'; sandbox", "Content-Length":str(length)}
        if upstream.status_code == 206:
            content_range = upstream.headers.get("content-range", "")
            matched = re.fullmatch(r"bytes ([0-9]+)-([0-9]+)/([0-9]+)", content_range)
            if not matched or not 0 <= int(matched[1]) <= int(matched[2]) < int(matched[3]) <= maximum:
                raise HTTPException(502, "Invalid media range response")
            result_headers["Content-Range"] = content_range
        if upstream.headers.get("accept-ranges") == "bytes":
            result_headers["Accept-Ranges"] = "bytes"
        async def stream():
            size = 0
            try:
                async for chunk in upstream.aiter_raw(chunk_size=65536):
                    size += len(chunk)
                    if size > length or size > maximum:
                        return
                    yield chunk
            finally:
                await upstream.aclose()
                await client.aclose()
        return StreamingResponse(stream(), status_code=upstream.status_code, media_type=mime, headers=result_headers)
    except HTTPException:
        if upstream is not None:
            await upstream.aclose()
        await client.aclose()
        raise
    except httpx.HTTPError:
        if upstream is not None:
            await upstream.aclose()
        await client.aclose()
        raise HTTPException(503, "Message backend unavailable") from None
