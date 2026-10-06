"""Authenticated local interfaces; action/WS tokens never enter browser code."""
import asyncio
import hmac
import json
import sqlite3
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from app.plugins.qq_messaging import MessagingError, encoded

router = APIRouter(prefix="/qq-messaging", tags=["qq-messaging"])


def local_auth(request: Request, response: Response):
    from app.api.routes.plugins import _loopback
    if (not request.client or not _loopback(request.client.host)
            or not _loopback(request.url.hostname or "")):
        raise HTTPException(403, "local_access_only")
    if request.headers.get("sec-fetch-site") in {"cross-site", "same-site"}:
        raise HTTPException(403, "same_origin_required")
    origin = request.headers.get("origin")
    if origin:
        try:
            p = urlsplit(origin)
            valid = (p.scheme == request.url.scheme and p.netloc == request.url.netloc
                     and not p.path and not p.query and not p.fragment)
        except ValueError:
            valid = False
        if not valid:
            raise HTTPException(403, "same_origin_required")
    service = getattr(request.app.state, "qq_messaging", None)
    if service is None or not service.ready:
        raise HTTPException(503, "messaging_disabled")
    authorization = request.headers.get("authorization", "")
    expected = "Bearer " + service.config.api_token
    if not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(401, "authentication_required", headers={"WWW-Authenticate": "Bearer"})
    response.headers["Cache-Control"] = "no-store"
    return service


async def invoke(method, *args):
    try:
        if asyncio.iscoroutinefunction(method):
            return await method(*args)
        return await asyncio.to_thread(method, *args)
    except MessagingError as exc:
        raise HTTPException(exc.status, exc.code) from None
    except (OSError, sqlite3.Error):
        raise HTTPException(503, "storage_error") from None


async def body(request):
    if request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
        raise HTTPException(415, "json_required")
    payload = bytearray()
    async for chunk in request.stream():
        if len(payload) + len(chunk) > 128*1024:
            raise HTTPException(413, "request_too_large")
        payload.extend(chunk)
    try:
        value = json.loads(payload)
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(400, "invalid_json") from None
    if not isinstance(value, dict):
        raise HTTPException(400, "invalid_request")
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, UnicodeError, RecursionError):
        raise HTTPException(400, "invalid_json") from None
    return value


@router.get("/status")
async def status(service=Depends(local_auth)):
    return service.status()


@router.get("/capabilities")
async def capabilities(service=Depends(local_auth)):
    c = service.config
    return {"schema_version": 1, "receive": ["text", "image", "video", "sticker", "face", "at", "reply"],
            "send": ["text", "image", "video", "sticker", "custom_face", "face", "at", "reply"],
            "send_enabled": c.send_enabled, "image_max_bytes": c.image_max, "video_max_bytes": c.video_max,
            "media_max_bytes": c.media_max, "idempotency_key_required": True,
            "conversation_policy": "default_deny", "delivery_receipt": "gateway_acceptance_only",
            "video_must_be_standalone": True, "mentions_require_group": True,
            "custom_face_must_be_standalone": True}


@router.get("/conversations/{kind}/{target}")
async def policy(kind: str, target: str, service=Depends(local_auth)):
    return await invoke(service.policy, kind, target)


@router.put("/conversations/{kind}/{target}")
async def update_policy(kind: str, target: str, request: Request, service=Depends(local_auth)):
    value = await body(request)
    if set(value) != {"receive_enabled", "send_enabled"}:
        raise HTTPException(400, "invalid_policy")
    # Policy changes and sends share a lock so revocation completes before later writes.
    async with service._send_lock:
        return await invoke(service.set_policy, kind, target, value["receive_enabled"], value["send_enabled"])


@router.get("/messages")
async def messages(conversation_type: str, conversation_id: str, after: int = Query(0, ge=0),
                   limit: int = Query(50, ge=1, le=100), service=Depends(local_auth)):
    return await invoke(service.messages, conversation_type, conversation_id, after, limit)


@router.get("/events")
async def events(request: Request, conversation_type: str, conversation_id: str,
                 after: int = Query(0, ge=0), service=Depends(local_auth)):
    # Validate policy before returning streaming headers.
    await invoke(service.messages, conversation_type, conversation_id, after, 1)
    async def stream():
        cursor, heartbeat = after, time.monotonic()
        while not await request.is_disconnected():
            try:
                page = await asyncio.to_thread(service.messages, conversation_type, conversation_id, cursor, 100)
            except MessagingError as exc:
                yield "event: error\ndata: " + encoded({"error": exc.code}) + "\n\n"
                return
            except (OSError, sqlite3.Error):
                yield 'event: error\ndata: {"error":"storage_error"}\n\n'
                return
            for item in page["messages"]:
                cursor = item["seq"]
                yield f"id: {cursor}\nevent: message\ndata: {encoded(item)}\n\n"
            if time.monotonic() - heartbeat > 15:
                yield ": heartbeat\n\n"
                heartbeat = time.monotonic()
            if not page["has_more"]:
                await asyncio.sleep(.5)
    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.post("/media/{kind}", status_code=201)
async def upload(kind: str, request: Request, service=Depends(local_auth)):
    # Raw binary body, not a filename/path/URL and not multipart form data.
    return await invoke(service.upload, kind, request.stream())


@router.get("/media/{media_id}")
async def content(media_id: str, service=Depends(local_auth)):
    row = await invoke(service.media, media_id)
    path = await invoke(service.media_path, row)
    return FileResponse(path, media_type=row["mime"], filename=media_id + path.suffix,
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                 "Content-Security-Policy": "default-src 'none'; sandbox"})


@router.post("/messages/{seq}/media/{ordinal}/cache")
async def cache(seq: int, ordinal: int, service=Depends(local_auth)):
    if seq < 1 or not 0 <= ordinal < 100:
        raise HTTPException(400, "invalid_media_reference")
    return await invoke(service.cache_received, seq, ordinal)


@router.get("/stickers")
async def stickers(limit: int = Query(48, ge=1, le=100), service=Depends(local_auth)):
    return await invoke(service.stickers, limit)


@router.post("/messages/send")
async def send(request: Request, service=Depends(local_auth)):
    value = await body(request)
    if set(value) != {"conversation_type", "conversation_id", "segments"}:
        raise HTTPException(400, "invalid_request")
    return await invoke(service.send, request.headers.get("idempotency-key"),
                        value["conversation_type"], value["conversation_id"], value["segments"])


@router.get("/sends/{key}")
async def receipt(key: str, service=Depends(local_auth)):
    return await invoke(service.send_receipt, key)
