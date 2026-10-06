"""Local status only; QQ credentials and messages never reach the browser."""
from datetime import datetime
import ipaddress
import re
from urllib.parse import urlsplit
from fastapi import APIRouter, HTTPException, Request, Response

router = APIRouter(prefix="/plugins", tags=["plugins"])
from app.api.routes.message_reading_proxy import router as message_reading_router
router.include_router(message_reading_router)
from app.api.routes.qq_messaging import router as qq_messaging_router
router.include_router(qq_messaging_router)
from app.api.routes.qq_ui import router as qq_ui_router
router.include_router(qq_ui_router)
STATES = {"disabled", "stopped", "connecting", "connected", "offline"}
SYNC_STATES = {"not_configured", "pending", "idle", "syncing", "offline", "storage_error"}
ERRORS = {"windows_only", "invalid_ws_url", "invalid_sync_url", "invalid_sync_auth",
          "invalid_db_path", "invalid_ws_auth", "websockets_unavailable", "websocket_error",
          "event_too_large", "text_too_large", "field_too_large", "invalid_event",
          "storage_error", "sync_offline", "configuration_error", "account_mismatch", "reader_error"}
ERRORS.add("local_queue_full")

def _loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
        return address.is_loopback or bool(getattr(address, "ipv4_mapped", None) and address.ipv4_mapped.is_loopback)
    except ValueError:
        return False

def _safe_media(value):
    value = value if isinstance(value, dict) else {}
    counters = value.get("counters") if isinstance(value.get("counters"), dict) else {}
    error = value.get("last_error_class")
    return {"enabled": value.get("enabled") is True,
            "state": value.get("state") if value.get("state") in {"disabled", "idle", "downloading", "syncing", "pending", "failed", "error"} else "disabled",
            "last_error_class": error if isinstance(error, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", error) else None,
            "counters": {key: counters[key] if type(counters.get(key)) is int and counters[key] >= 0 else 0
                         for key in ("pending", "cached", "failed", "unavailable", "expired")}}

@router.get("/qq-reader/status")
async def qq_reader_status(request: Request, response: Response):
    if not request.client or not _loopback(request.client.host) or not _loopback(request.url.hostname or ""):
        raise HTTPException(403, "Local access only")
    origin = request.headers.get("origin")
    if origin:
        try:
            parsed = urlsplit(origin)
        except ValueError:
            raise HTTPException(403, "Same origin required") from None
        if (parsed.scheme != request.url.scheme or parsed.netloc != request.url.netloc
                or parsed.path or parsed.query or parsed.fragment):
            raise HTTPException(403, "Same origin required")
    reader = getattr(request.app.state, "qq_reader", None)
    response.headers["Cache-Control"] = "no-store"
    state = reader.status() if reader else getattr(request.app.state, "qq_reader_status", {})
    stamp = state.get("last_received_at")
    try:
        stamp = datetime.fromisoformat(stamp).isoformat() if isinstance(stamp, str) and len(stamp) < 64 else None
    except ValueError:
        stamp = None
    error = state.get("last_error")
    return {"plugin_id": "qq_reader", "enabled": state.get("enabled") is True,
            "connection_state": state.get("connection_state") if state.get("connection_state") in STATES else "disabled",
            "sync_state": state.get("sync_state") if state.get("sync_state") in SYNC_STATES else "not_configured",
            "last_received_at": stamp,
            "last_error": error if error in ERRORS else ("reader_error" if error else None),
            "pending_count": state.get("pending_count") if isinstance(state.get("pending_count"), int) and state.get("pending_count") >= 0 else 0,
            "media": _safe_media(state.get("media"))}
