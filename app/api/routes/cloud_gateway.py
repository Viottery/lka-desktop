"""Loopback-only gateway from the local frontend service to the cloud hub.

The service logs in as a native client and holds the account token locally.
An optional Windows DPAPI store restores it across service restarts. Pages never see it: they call /cloud-auth/* to sign in or out and
/cloud/* for allowlisted hub features (真理, 待办, 项目, 记忆, 设备, 远程任务).
Remote browsers (LKA_WORKBENCH_ORIGINS) are refused; phones open the hub or a
node page directly, each with its own login.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import threading
import time
from urllib.parse import quote, urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from app.api.routes.workbench_proxy import (
    _ID,
    _MAX_BODY,
    _MAX_RESPONSE,
    _verified_context,
    is_local_page,
)
from app.core import cloud_session_store

router = APIRouter()
_MAX_ATTACHMENT = 256 * 1024 * 1024
_TASK = r"[A-Za-z0-9_.:-]{1,200}"
_DEVICE = r"[\w.-]{1,120}"
_PAGE = {"limit", "offset"}
# Hub features used by the local workbench and pet. Ordinary sessions on a
# replica stay on /workbench; only assistant-owned sessions and runs come here.
_ROUTES = (
    ("GET", r"client/info", set()),
    ("GET", r"agent/models", {"refresh"}),
    ("POST", r"managers/default", set()),
    ("GET", r"managers/" + _ID, set()), ("PATCH", r"managers/" + _ID, set()),
    ("GET", r"managers/" + _ID + r"/goals", _PAGE),
    ("GET", r"managers/" + _ID + r"/events", {"after", "limit"}),
    ("GET", r"managers/" + _ID + r"/executions", {"after", "limit"}),
    ("GET", r"managers/" + _ID + r"/deliveries", {"after", "limit"}),
    ("GET", r"sessions/" + _ID, {"message_limit", "message_view", "before_message_id", "after_message_id"}),
    ("PATCH", r"sessions/" + _ID, set()),
    ("GET", r"sessions/" + _ID + r"/runs", _PAGE | {"client_request_id"}),
    ("GET", r"sessions/" + _ID + r"/inputs", set()),
    ("POST", r"sessions/" + _ID + r"/inputs", set()),
    ("POST", r"sessions/" + _ID + r"/inputs/resume", set()),
    ("POST", r"sessions/" + _ID + r"/attachments", set()),
    ("GET", r"sessions/" + _ID + r"/attachments/att_[0-9a-f]{32}", set()),
    ("GET", r"sessions/" + _ID + r"/attachments/att_[0-9a-f]{32}/raw", set()),
    ("GET", r"agent/runs/" + _ID, set()),
    ("GET", r"agent/runs/" + _ID + r"/snapshot", set()),
    ("GET", r"agent/runs/" + _ID + r"/events", {"after_sequence", "limit"}),
    ("GET", r"agent/runs/" + _ID + r"/stream", {"after_sequence"}),
    ("GET", r"agent/runs/" + _ID + r"/safety-reviews", set()),
    ("POST", r"agent/runs/" + _ID + r"/(?:interrupt|replace|cancel|resume|continue)", set()),
    ("POST", r"agent/safety-reviews/" + _ID + r"/decision", set()),
    ("GET", r"matters/sync", {"after", "limit"}),
    ("GET", r"matters", {"limit", "offset", "status", "q", "kind", "parent_matter_id", "project_id", "due_before", "due_after", "unscheduled", "scheduled_on", "scheduled_before", "scheduled_after", "inbox", "section", "visibility"}),
    ("POST", r"matters", set()),
    ("GET", r"matters/" + _ID, set()), ("PATCH", r"matters/" + _ID, set()),
    ("DELETE", r"matters/" + _ID, {"expected_revision"}),
    ("POST", r"matters/" + _ID + r"/restore", set()),
    ("GET", r"projects", {"limit", "offset", "q"}), ("POST", r"projects", set()),
    ("GET", r"projects/" + _ID, set()), ("PATCH", r"projects/" + _ID, set()),
    ("GET", r"projects/" + _ID + r"/sessions", {"limit", "offset", "q"}),
    ("GET", r"memories", {"scope", "workspace_path", "include_candidates", "limit", "offset"}),
    ("GET", r"memories/export", {"scope", "workspace_path", "include_candidates", "limit", "offset"}),
    ("GET", r"memories/feedback", {"scope", "workspace_path", "limit", "offset"}),
    ("GET", r"memories/learning", {"scope", "workspace_path"}), ("PUT", r"memories/learning", set()),
    ("GET", r"memories/" + _ID, {"workspace_path"}),
    ("GET", r"memories/" + _ID + r"/sources", {"workspace_path"}),
    ("PATCH", r"memories/" + _ID, set()), ("POST", r"memories", set()),
    ("DELETE", r"memories/" + _ID, {"workspace_path", "expected_version"}),
    ("GET", r"memories/file", {"scope", "workspace_path"}),
    ("GET", r"memories/file/preview", {"scope", "workspace_path"}),
    ("GET", r"background/jobs", {"scope", "limit", "offset"}),
    ("GET", r"background/health", set()),
    ("GET", r"background/config", set()), ("GET", r"background/config/schema", set()),
    ("PATCH", r"background/config", set()), ("DELETE", r"background/config", {"expected_revision"}),
    ("POST", r"background/jobs/" + _ID + r"/(?:retry|cancel)", set()),
    ("GET", r"background/events", {"interval"}),
    # Cluster management: devices, connections, assistant remote tasks, sync review.
    ("GET", r"devices", _PAGE), ("POST", r"devices", set()),
    ("GET", r"devices/selection", {"selection_key"}), ("PUT", r"devices/selection", {"selection_key"}),
    ("POST", r"devices/selection/resolve", {"selection_key"}),
    ("GET", r"devices/" + _DEVICE, set()), ("PATCH", r"devices/" + _DEVICE, set()),
    ("POST", r"devices/" + _DEVICE + r"/(?:revoke|rotate)", set()),
    ("POST", r"devices/" + _DEVICE + r"/connections/revoke", set()),
    ("GET", r"remote-execution/targets", set()),
    ("GET", r"remote-execution/tasks", {"owner_session_id", "limit", "offset"}),
    ("GET", r"remote-execution/tasks/" + _TASK, _PAGE),
    ("POST", r"remote-execution/tasks/" + _TASK + r"/(?:cancel|pause|resume|answer|instruction)", set()),
    ("POST", r"remote-execution/tasks/" + _TASK + r"/reviews/" + _TASK, set()),
    ("GET", r"sync/status", set()),
    ("GET", r"sync/proposals", {"limit"}),
    ("POST", r"sync/proposals/" + _DEVICE + r"/" + _TASK + r"/resolve", set()),
    ("GET", r"sync/memory-records/conflicts", _PAGE),
    ("GET", r"auth/sessions", set()), ("DELETE", r"auth/sessions/[A-Za-z0-9_-]{1,200}", set()),
    ("GET", r"auth/accounts", set()), ("POST", r"auth/accounts", set()),
    ("PATCH", r"auth/accounts/[A-Za-z0-9_-]{1,200}", set()),
    ("POST", r"auth/accounts/[A-Za-z0-9_-]{1,200}/password", set()),
)
# Enrollment/rotation responses carry a device token shown once to this page;
# the gateway relays them unchanged and never stores them.


class _Session:
    """Shared native session; optional CurrentUser DPAPI persistence, never passwords."""

    def __init__(self):
        self.lock = threading.Lock()
        self.token = ""
        self.account = None
        self.expires_at = 0
        self.origin = ""
        self.loaded_store = None

    def _restore(self):
        path = os.environ.get("LKA_CLOUD_SESSION_PATH", "").strip()
        origin = cloud_origin()
        key = (path, origin)
        if self.loaded_store != key:
            self.token, self.account, self.expires_at, self.origin = "", None, 0, origin
            self.loaded_store = key
            saved = cloud_session_store.load(path, origin)
            if saved:
                self.token, self.account, self.expires_at = saved["token"], saved["account"], saved["expires_at"]
        return path

    def snapshot(self):
        with self.lock:
            path = self._restore()
            if self.token and self.expires_at and self.expires_at <= time.time():
                self.token, self.account, self.expires_at = "", None, 0
                cloud_session_store.clear(path)
            return self.token, self.account, self.expires_at, self.origin

    def set(self, token, account, expires_at, origin):
        with self.lock:
            path = os.environ.get("LKA_CLOUD_SESSION_PATH", "").strip()
            if token:
                cloud_session_store.save(path, {"token": token, "account": account,
                                               "expires_at": expires_at, "origin": origin})
            else:
                cloud_session_store.clear(path)
            self.loaded_store = (path, origin)
            self.token, self.account, self.expires_at, self.origin = token, account, expires_at, origin

    def clear(self, token=None):
        with self.lock:
            path = self._restore()
            if token is None or token == self.token:
                self.token, self.account, self.expires_at = "", None, 0
                cloud_session_store.clear(path)


_session = _Session()


class LoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256, repr=False)


class PasswordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(min_length=1, max_length=256, repr=False)
    new_password: str = Field(min_length=12, max_length=256, repr=False)


def cloud_origin() -> str:
    """The configured hub origin; HTTPS only, no credentials, path or query."""
    raw = os.environ.get("LKA_CLOUD_ORIGIN", "").strip().rstrip("/")
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
        valid = (parsed.scheme == "https" and parsed.hostname and not parsed.username
                 and not parsed.password and parsed.path in {"", "/"} and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    return raw if valid else ""


def client_mode() -> str:
    """Return the supported frontend mode; unknown values fail closed."""
    raw = os.environ.get("LKA_CLIENT_MODE", "local").strip().lower()
    return raw if raw in {"local", "cloud"} else "invalid"


def _require_local(request: Request) -> None:
    if not is_local_page(request):
        raise HTTPException(403, "Cloud gateway is available only to this computer")
    origin = request.headers.get("origin")
    if origin:
        try:
            parsed = urlsplit(origin)
            same = (parsed.scheme, (parsed.hostname or "").lower(), parsed.port or (443 if parsed.scheme == "https" else 80)) == (
                request.url.scheme, (request.url.hostname or "").lower(), request.url.port or (443 if request.url.scheme == "https" else 80))
        except ValueError:
            same = False
        if not same:
            raise HTTPException(403, "Same origin required")
    fetch_site = request.headers.get("sec-fetch-site", "").lower()
    if fetch_site in {"cross-site", "same-site"}:
        raise HTTPException(403, "Same origin required")


def _route(method: str, path: str, query_names) -> bool:
    if any(part in {".", ".."} for part in path.split("/")):
        return False
    return any(method == verb and re.fullmatch(pattern, path) and query_names <= allowed
               for verb, pattern, allowed in _ROUTES)


def _native_headers(token: str = "") -> dict:
    headers = {"X-LKA-Client": "native", "Accept": "application/json", "Accept-Encoding": "identity"}
    if token:
        headers["X-LKA-Account-Token"] = token
    return headers


def _public_status():
    token, account, expires_at, origin = _session.snapshot()
    configured = cloud_origin()
    return {"configured": bool(configured), "origin": configured,
            "logged_in": bool(token) and origin == configured,
            "account": account if token and origin == configured else None,
            "expires_at": expires_at if token else 0}


def _detail(raw: bytes) -> str | None:
    try:
        value = json.loads(raw.decode("utf-8")) if raw else {}
    except (ValueError, UnicodeError):
        return None
    detail = value.get("detail") if isinstance(value, dict) else None
    # Pydantic lists are reduced to field names; never reflect submitted values.
    if isinstance(detail, list):
        return "；".join(str(item.get("msg", ""))[:120] for item in detail[:4] if isinstance(item, dict)) or None
    return detail[:300] if isinstance(detail, str) else None


@router.get("/cloud-auth/status")
async def cloud_status(request: Request):
    _require_local(request)
    status = await asyncio.to_thread(_public_status)
    status["client_mode"] = client_mode()
    return Response(json.dumps(status), media_type="application/json", headers={"Cache-Control": "no-store"})


@router.post("/cloud-auth/login")
async def cloud_login(payload: LoginRequest, request: Request):
    _require_local(request)
    origin = cloud_origin()
    if not origin:
        raise HTTPException(503, "cloud_not_configured")
    try:
        context = await asyncio.to_thread(_verified_context)
        async with httpx.AsyncClient(timeout=httpx.Timeout(20, connect=10), follow_redirects=False,
                                     trust_env=False, verify=context) as client:
            upstream = await client.post(origin + "/auth/login", headers=_native_headers(),
                                         json={"username": payload.username, "password": payload.password})
    except httpx.HTTPError:
        raise HTTPException(502, "cloud_unreachable") from None
    if upstream.status_code != 200:
        status = upstream.status_code if upstream.status_code in {401, 403, 404, 422, 429} else 502
        detail = {401: "账号或密码不正确。", 403: "云端未允许原生客户端登录（auth.allow_bearer_sessions）。",
                  404: "云端未开启账号登录。", 429: "登录尝试过多，请稍后再试。"}.get(status, "cloud_login_failed")
        raise HTTPException(status, detail)
    data = upstream.json()
    token = data.get("token") if isinstance(data, dict) else None
    if not isinstance(token, str) or not token:
        raise HTTPException(502, "云端未返回原生会话，请确认已开启 auth.allow_bearer_sessions。")
    try:
        await asyncio.to_thread(_session.set, token, data.get("account"), int(data.get("expires_at") or 0), origin)
    except cloud_session_store.SessionStorageError:
        raise HTTPException(503, "cloud_session_storage_unavailable") from None
    return Response(json.dumps(await asyncio.to_thread(_public_status)), media_type="application/json", headers={"Cache-Control": "no-store"})


@router.post("/cloud-auth/logout", status_code=204)
async def cloud_logout(request: Request):
    _require_local(request)
    token, _account, _expires, origin = await asyncio.to_thread(_session.snapshot)
    await asyncio.to_thread(_session.clear)
    if token and origin:
        try:
            context = await asyncio.to_thread(_verified_context)
            async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False, verify=context) as client:
                await client.post(origin + "/auth/logout", headers=_native_headers(token))
        except httpx.HTTPError:
            pass  # The local credential is already gone; the hub session expires on its own.
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.post("/cloud-auth/password", status_code=204)
async def cloud_password(payload: PasswordRequest, request: Request):
    _require_local(request)
    token, _account, _expires, origin = await asyncio.to_thread(_session.snapshot)
    if not token or origin != cloud_origin():
        raise HTTPException(401, "cloud_login_required")
    try:
        context = await asyncio.to_thread(_verified_context)
        async with httpx.AsyncClient(timeout=20, follow_redirects=False, trust_env=False, verify=context) as client:
            upstream = await client.post(origin + "/auth/password", headers=_native_headers(token),
                                         json={"current_password": payload.current_password, "new_password": payload.new_password})
    except httpx.HTTPError:
        raise HTTPException(502, "cloud_unreachable") from None
    if upstream.status_code == 204:
        await asyncio.to_thread(_session.clear, token)  # The hub revoked every session of this account.
        return Response(status_code=204, headers={"Cache-Control": "no-store"})
    status = upstream.status_code if upstream.status_code in {400, 401, 403, 422, 429} else 502
    if status == 401:
        await asyncio.to_thread(_session.clear, token)
    raise HTTPException(status, _detail(upstream.content) if status in {400, 422} else "cloud_password_failed")


@router.post("/cloud-auth/connections/{device_id}")
async def cloud_issue_grant(device_id: str, request: Request):
    """Issue a one-use node grant for this page to navigate with; never cached."""
    _require_local(request)
    if not re.fullmatch(_DEVICE, device_id):
        raise HTTPException(422, "invalid device")
    return await _forward(request, "devices/" + device_id + "/connections")


@router.api_route("/cloud/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def cloud_proxy(path: str, request: Request):
    _require_local(request)
    if not _route(request.method, path, set(request.query_params.keys())):
        raise HTTPException(404, "Unsupported cloud request")
    return await _forward(request, path)


async def _forward(request: Request, path: str):
    origin = cloud_origin()
    if not origin:
        raise HTTPException(503, "cloud_not_configured")
    token, _account, _expires, logged_origin = await asyncio.to_thread(_session.snapshot)
    if not token or logged_origin != origin:
        raise HTTPException(401, "cloud_login_required")
    is_attachment = request.method == "POST" and path.endswith("/attachments")
    limit = _MAX_ATTACHMENT if is_attachment else _MAX_BODY
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise HTTPException(413, "Request too large")
    headers = _native_headers(token)
    headers["Accept"] = request.headers.get("accept", "application/json")
    if request.headers.get("content-type"):
        headers["Content-Type"] = request.headers["content-type"]
    if is_attachment and request.headers.get("x-filename"):
        headers["X-Filename"] = request.headers["x-filename"]
    streaming = path.endswith("/stream") or path == "background/events"
    # httpx decodes gzip before the bounded response relay; never forward stale encoding headers.
    headers["Accept-Encoding"] = "identity" if streaming else "gzip"
    timeout = httpx.Timeout(connect=10, read=None if streaming else 600 if is_attachment else 30,
                            write=600 if is_attachment else 30, pool=10)
    try:
        context = await asyncio.to_thread(_verified_context)
        client = httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False, verify=context)
        upstream = await client.send(client.build_request(
            request.method, origin + "/" + quote(path, safe="/"),
            params=list(request.query_params.multi_items()), headers=headers, content=bytes(body)), stream=True)
    except BaseException as exc:
        if "client" in locals():
            await client.aclose()
        if isinstance(exc, httpx.HTTPError):
            raise HTTPException(502, "cloud_unreachable") from None
        raise
    media_type = upstream.headers.get("content-type", "application/octet-stream")
    if upstream.status_code >= 400:
        try:
            raw = b""
            async for chunk in upstream.aiter_bytes():
                raw += chunk
                if len(raw) > 8192:
                    raw = b""
                    break
        except httpx.HTTPError:
            raw = b""
        finally:
            await upstream.aclose()
            await client.aclose()
        status = upstream.status_code if upstream.status_code in {400, 401, 403, 404, 409, 413, 415, 422, 429} else 502
        if status == 401:
            await asyncio.to_thread(_session.clear, token)
        payload = {"detail": _detail(raw) or "cloud_request_failed"}
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
            # session_busy carries identifiers the client needs to reconnect.
            if isinstance(parsed, dict):
                for name in ("session_id", "run_id"):
                    if isinstance(parsed.get(name), str) and re.fullmatch(_ID, parsed[name]):
                        payload[name] = parsed[name]
        except (ValueError, UnicodeError):
            pass
        return Response(json.dumps(payload, ensure_ascii=False), status_code=status,
                        media_type="application/json", headers={"Cache-Control": "no-store"})
    if streaming or media_type.lower().startswith("text/event-stream"):
        async def relay():
            try:
                async for chunk in upstream.aiter_bytes():
                    yield chunk
            except httpx.HTTPError:
                return
            finally:
                await upstream.aclose()
                await client.aclose()
        return StreamingResponse(relay(), status_code=upstream.status_code, media_type=media_type,
                                 headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    try:
        chunks, size = [], 0
        limit = _MAX_ATTACHMENT if path.endswith("/raw") else _MAX_RESPONSE
        async for chunk in upstream.aiter_bytes():
            size += len(chunk)
            if size > limit:
                raise HTTPException(502, "Cloud response too large")
            chunks.append(chunk)
        raw = b"".join(chunks)
        response_headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
        if upstream.headers.get("content-disposition"):
            response_headers["Content-Disposition"] = upstream.headers["content-disposition"]
        return Response(raw, status_code=upstream.status_code, media_type=media_type, headers=response_headers)
    except httpx.HTTPError:
        raise HTTPException(502, "cloud_unreachable") from None
    finally:
        await upstream.aclose()
        await client.aclose()
