"""Same-origin UI adapter; QQ service credentials stay in the local host."""
import os
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse

from app.api.routes.message_reading_proxy import require_local_page
from app.api.routes.qq_messaging import body, invoke
from app.plugins.qq_actions import QQActionConfig, QQActionError
from app.plugins.qq_group_names import GroupDirectoryError, QQGroupNames, SnowLumaMetadataClient
from app.plugins.qq_messaging import QQMessagingConfig

def local_ui(request: Request, response: Response):
    require_local_page(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"


router = APIRouter(prefix="/qq-ui", tags=["qq-ui"], dependencies=[Depends(local_ui)])


def ui_write(request: Request):
    # A custom header prevents simple cross-site form requests; native hosts set it too.
    if request.headers.get("x-lka-ui-intent") != "1":
        raise HTTPException(403, "explicit_ui_request_required")


def active(request: Request):
    service = getattr(request.app.state, "qq_messaging", None)
    if service is None or not service.ready:
        raise HTTPException(503, "messaging_disabled")
    return service


@router.get("/status")
async def status(request: Request):
    service = getattr(request.app.state, "qq_messaging", None)
    reader = getattr(request.app.state, "qq_reader", None)
    state = service.status() if service else {
        "enabled": False, "ready": False, "send_enabled": False,
        "connection_state": "disabled", "last_received_at": None, "last_error": None}
    config = getattr(service, "config", None)
    reader_config = getattr(reader, "config", None)
    account = getattr(service, "account", "") or getattr(reader_config, "expected_self_id", "")
    if not str(account).isdigit() or len(str(account)) > 20:
        account = ""
    return {**state, "account_id": str(account),
            "reading_paired": bool(os.getenv("LKA_MESSAGES_CONTROL_TOKEN", "").strip()),
            "configured": bool(config), "ui_adapter_version": 1}


def _group_names(request: Request):
    directory = getattr(request.app.state, "qq_group_names", None)
    if directory is not None:
        return directory
    service = getattr(request.app.state, "qq_messaging", None)
    config = getattr(service, "config", None) or QQMessagingConfig.from_env()
    metadata_url = os.getenv("QQ_METADATA_URL", "").strip()
    credential_path = os.getenv("QQ_METADATA_CREDENTIAL_PATH", "").strip()
    if config.action_token.strip():
        action_config = QQActionConfig(url=config.action_url, token=config.action_token,
                                       expected_self_id=config.expected_self_id,
                                       timeout=min(config.timeout, 8.0))
        directory = QQGroupNames(action_config)
    elif metadata_url and credential_path:
        metadata_client = SnowLumaMetadataClient(metadata_url, credential_path,
                                                  config.expected_self_id, timeout=8)
        directory = QQGroupNames(client=metadata_client,
                                 expected_self_id=config.expected_self_id)
    else:
        raise QQActionError("invalid_config")
    request.app.state.qq_group_names = directory
    return directory


@router.get("/groups/{group_id}")
async def group_name(group_id: str, request: Request, account_id: str = Query(..., min_length=1, max_length=20)):
    """Return only a joined group's name for the explicitly paired local QQ account."""
    try:
        directory = _group_names(request)
        return await directory.name_for(group_id, account_id)
    except GroupDirectoryError as exc:
        raise HTTPException(exc.status, exc.code) from None
    except QQActionError:
        raise HTTPException(503, "configuration_error") from None
    except (TypeError, ValueError, OSError):
        raise HTTPException(503, "configuration_error") from None


@router.get("/capabilities")
async def capabilities(request: Request):
    service = getattr(request.app.state, "qq_messaging", None)
    c = getattr(service, "config", None) or QQMessagingConfig()
    return {"image_max_bytes": c.image_max, "video_max_bytes": c.video_max,
            "video_must_be_standalone": True, "custom_face_must_be_standalone": True,
            "mentions_require_group": True,
            "image_types": ["image/png", "image/jpeg", "image/gif", "image/webp"],
            "video_types": ["video/mp4", "video/webm"]}


@router.get("/conversations/{kind}/{target}")
async def policy(kind: str, target: str, request: Request):
    return await invoke(active(request).policy, kind, target)


@router.put("/conversations/{kind}/{target}", dependencies=[Depends(ui_write)])
async def update_policy(kind: str, target: str, request: Request):
    service = active(request)
    value = await body(request)
    if set(value) != {"receive_enabled", "send_enabled"}:
        raise HTTPException(400, "invalid_policy")
    async with service._send_lock:
        return await invoke(service.set_policy, kind, target, value["receive_enabled"], value["send_enabled"])


@router.get("/messages")
async def messages(request: Request, conversation_type: str, conversation_id: str,
                   after: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100)):
    return await invoke(active(request).messages, conversation_type, conversation_id, after, limit)


@router.post("/messages/send", dependencies=[Depends(ui_write)])
async def send(request: Request):
    value = await body(request)
    if set(value) != {"idempotency_key", "conversation_type", "conversation_id", "segments"}:
        raise HTTPException(400, "invalid_request")
    return await invoke(active(request).send, value["idempotency_key"], value["conversation_type"],
                        value["conversation_id"], value["segments"])


@router.get("/sends/{key}")
async def receipt(key: str, request: Request):
    return await invoke(active(request).send_receipt, key)


@router.get("/stickers")
async def stickers(request: Request, limit: int = Query(48, ge=1, le=100)):
    return await invoke(active(request).stickers, limit)


@router.post("/media/{kind}", status_code=201, dependencies=[Depends(ui_write)])
async def upload(kind: str, request: Request):
    return await invoke(active(request).upload, kind, request.stream())


@router.get("/media/{media_id}")
async def content(media_id: str, request: Request):
    service = active(request)
    row = await invoke(service.media, media_id)
    path = await invoke(service.media_path, row)
    return FileResponse(path, media_type=row["mime"], filename=media_id + path.suffix,
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                 "Content-Security-Policy": "default-src 'none'; sandbox"})


@router.post("/messages/{seq}/media/{ordinal}/cache", dependencies=[Depends(ui_write)])
async def cache(seq: int, ordinal: int, request: Request):
    if seq < 1 or not 0 <= ordinal < 100:
        raise HTTPException(400, "invalid_media_reference")
    return await invoke(active(request).cache_received, seq, ordinal)
