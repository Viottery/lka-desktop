from __future__ import annotations

import ipaddress
import hashlib
import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.pet.models import PetActionRequest, PetChatRequest, PetStatePatch
from app.pet.state import _dump_model, get_pet_state_store
from app.runtime.conversation_queue import get_conversation_queue_manager

router = APIRouter(prefix="/pet", tags=["desktop-pet"])


class SessionWorkspaceCreateRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=200)
    base_path: str = Field(default="", max_length=1000)


def _workspace_folder_name(session_id: str) -> str:
    """Keep ordinary IDs readable and map opaque IDs to one safe folder name."""
    reserved = {"con", "prn", "aux", "nul"}
    reserved.update(f"com{number}" for number in range(1, 10))
    reserved.update(f"lpt{number}" for number in range(1, 10))
    if re.fullmatch(r"[a-z0-9_-]{1,100}", session_id) and session_id not in reserved:
        return session_id
    return "session-" + hashlib.sha256(session_id.encode("utf-8")).hexdigest()


def _default_session_workspace_root() -> Path:
    configured = os.environ.get("LKA_SESSION_WORKSPACE_BASE", "").strip()
    if configured:
        return Path(configured).expanduser()
    if os.name == "nt":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            ) as key:
                documents, _ = winreg.QueryValueEx(key, "Personal")
            return Path(os.path.expandvars(documents)) / "Local Knowledge Agent" / "Workspaces"
        except OSError:
            pass
    return Path.home() / "Documents" / "Local Knowledge Agent" / "Workspaces"


@router.post("/session-workspace")
def create_session_workspace(payload: SessionWorkspaceCreateRequest, request: Request) -> dict[str, str]:
    """Create a local, isolated folder for one desktop session."""
    host = request.client.host if request.client else ""
    try:
        address = ipaddress.ip_address(host)
        if not (address.is_loopback or getattr(address, "ipv4_mapped", None) and address.ipv4_mapped.is_loopback):
            raise ValueError("remote client")
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="This action is local only") from exc

    requested_root = payload.base_path.strip()
    if requested_root and not Path(requested_root).is_absolute():
        raise HTTPException(status_code=422, detail="Workspace base path must be absolute")
    root = (Path(requested_root).expanduser() if requested_root else _default_session_workspace_root()).resolve()
    workspace = root / _workspace_folder_name(payload.session_id)
    try:
        workspace.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Cannot create workspace: {exc}") from exc
    if workspace.is_symlink() or workspace.resolve().parent != root:
        raise HTTPException(status_code=409, detail="Workspace path is not inside the configured root")
    return {"path": workspace.as_posix()}


@router.get("/manifest")
async def get_pet_manifest() -> dict:
    return get_pet_state_store().manifest()


@router.get("/state")
async def get_pet_state() -> dict:
    return _dump_model(get_pet_state_store().load())


@router.put("/state")
async def update_pet_state(patch: PetStatePatch) -> dict:
    return _dump_model(get_pet_state_store().patch(patch))


@router.post("/action")
async def run_pet_action(request: PetActionRequest) -> dict:
    state = get_pet_state_store().apply_action(request)
    return {"state": _dump_model(state)}


@router.post("/chat")
async def chat_from_pet(request: PetChatRequest) -> dict:
    store = get_pet_state_store()
    thinking = store.patch(PetStatePatch(animation="think", mood="thinking", bubble="正在思考。", panel_open=True))

    manager = get_conversation_queue_manager()
    job = await manager.submit(
        question=request.message,
        conversation_id=request.conversation_id,
        mode=request.mode,
    )

    if request.mode == "background":
        return {"state": _dump_model(thinking), "job": job.to_public_dict()}

    if job.status == "failed":
        state = store.patch(PetStatePatch(animation="idle", mood="alert", bubble=job.error or "对话失败。"))
        raise HTTPException(status_code=500, detail={"state": _dump_model(state), "error": job.error})

    result = job.result or {}
    answer = str(result.get("answer") or result.get("grounded_answer") or "").strip()
    bubble = answer[:120] if answer else "任务完成。"
    state = store.patch(PetStatePatch(animation="wave", mood="happy", bubble=bubble, panel_open=True))
    return {
        "state": _dump_model(state),
        "job": job.to_public_dict(),
        "result": result,
    }
