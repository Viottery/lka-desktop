from __future__ import annotations

import ipaddress
import hashlib
import ntpath
import os
import re
import string
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.pet.models import PetActionRequest, PetChatRequest, PetStatePatch
from app.pet.state import _dump_model, get_pet_state_store
from app.runtime.conversation_queue import get_conversation_queue_manager

router = APIRouter(prefix="/pet", tags=["desktop-pet"])


_MAX_DIRECTORY_SCAN = 10_000


def _require_local_page(request: Request) -> None:
    """Limit directory metadata access to the same local origin as the desktop UI."""
    host = request.client.host if request.client else ""
    try:
        address = ipaddress.ip_address(host)
        local_client = address.is_loopback or bool(
            getattr(address, "ipv4_mapped", None) and address.ipv4_mapped.is_loopback
        )
    except ValueError:
        local_client = host.lower() == "localhost"
    if not local_client:
        raise HTTPException(status_code=403, detail="This action is local only")

    try:
        request_host = request.url.hostname or ""
        host_address = ipaddress.ip_address(request_host)
        local_host = host_address.is_loopback or bool(
            getattr(host_address, "ipv4_mapped", None) and host_address.ipv4_mapped.is_loopback
        )
    except ValueError:
        local_host = request_host.lower() == "localhost"
    if not local_host:
        raise HTTPException(status_code=403, detail="This action is local only")

    origin = request.headers.get("origin")
    origin_matches = False
    if origin:
        try:
            parsed = urlsplit(origin)
            origin_port = parsed.port or (443 if parsed.scheme == "https" else 80)
            request_port = request.url.port or (443 if request.url.scheme == "https" else 80)
        except ValueError:
            raise HTTPException(status_code=403, detail="Same origin required") from None
        if (parsed.scheme != request.url.scheme or parsed.hostname != request_host
                or origin_port != request_port or parsed.path or parsed.query or parsed.fragment):
            raise HTTPException(status_code=403, detail="Same origin required")
        origin_matches = True
    fetch_site = request.headers.get("sec-fetch-site", "").lower()
    if fetch_site == "cross-site" or fetch_site == "same-site" and not origin_matches:
        raise HTTPException(status_code=403, detail="Same origin required")
    if fetch_site and fetch_site not in {"same-origin", "same-site", "none", "cross-site"}:
        raise HTTPException(status_code=403, detail="Same origin required")


def _workspace_browse_roots() -> list[dict[str, str]]:
    """Return browseable local roots without probing remote Windows shares."""
    roots: list[Path] = []
    if os.name == "nt":
        try:
            import ctypes
            mask = ctypes.windll.kernel32.GetLogicalDrives()
            for index, letter in enumerate(string.ascii_uppercase):
                if not mask & (1 << index):
                    continue
                drive = f"{letter}:\\"
                # DRIVE_FIXED only; GetDriveTypeW avoids enumerating unavailable/network drives.
                if ctypes.windll.kernel32.GetDriveTypeW(drive) == 3:
                    roots.append(Path(drive))
        except (AttributeError, OSError):
            roots = []
    else:
        roots = [Path("/")]
    return [{"name": root.anchor or str(root), "path": str(root)} for root in roots]


def _workspace_initial_path() -> Path:
    configured = os.environ.get("LKA_SESSION_WORKSPACE_BASE", "").strip()
    return Path(configured).expanduser() if configured else _default_session_workspace_root()


def _validate_browse_path(raw_path: str, roots: list[dict[str, str]]) -> Path:
    if "\x00" in raw_path:
        raise HTTPException(status_code=422, detail="Path cannot contain a NUL character")
    if raw_path.startswith(("\\\\", "//")):
        raise HTTPException(status_code=422, detail="Network and UNC paths cannot be browsed")
    supplied_path = Path(raw_path)
    if not supplied_path.is_absolute():
        raise HTTPException(status_code=422, detail="Path must be absolute")
    path = supplied_path.expanduser()
    if os.name == "nt":
        # Normalize lexically first, then reject reparse points before descending
        # through them. This prevents junctions/symlinks from reaching UNC targets.
        path = Path(ntpath.normpath(str(path)))
        drive, _ = os.path.splitdrive(str(path))
        if not drive:
            raise HTTPException(status_code=422, detail="Choose a local drive path")
        if not any(root["path"].casefold().startswith(drive.casefold()) for root in roots):
            raise HTTPException(status_code=422, detail="Choose an available local fixed drive")
        parts = path.parts
        component = Path(parts[0])
        for part in parts[1:]:
            component = component / part
            try:
                is_junction = getattr(component, "is_junction", lambda: False)()
                if component.is_symlink() or is_junction:
                    raise HTTPException(status_code=422, detail="Paths through symlinks or junctions cannot be browsed")
            except OSError:
                raise HTTPException(status_code=422, detail=f"Cannot inspect path component: {component}") from None
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Directory does not exist: {path}")
    if not path.is_dir():
        raise HTTPException(status_code=422, detail=f"Path is not a directory: {path}")
    canonical = path.resolve()
    if os.name == "nt":
        canonical_text = str(canonical)
        if canonical_text.startswith(("\\\\", "//")):
            raise HTTPException(status_code=422, detail="Network and UNC paths cannot be browsed")
        drive, _ = os.path.splitdrive(canonical_text)
        if not any(root["path"].casefold().startswith(drive.casefold()) for root in roots):
            raise HTTPException(status_code=422, detail="Resolved path is not on an available local fixed drive")
    return canonical


@router.get("/workspace-directories")
def browse_workspace_directories(
    request: Request,
    path: str = Query(default="", max_length=4096),
    query: str = Query(default="", max_length=256),
    offset: int = Query(default=0, ge=0, le=1_000_000),
    limit: int = Query(default=100, ge=1, le=200),
) -> dict:
    """List directory names on the frontend machine; never read files or create paths."""
    from app.api.routes.workbench_proxy import require_workbench_page
    require_workbench_page(request)
    roots = _workspace_browse_roots()
    if path:
        current = _validate_browse_path(path, roots)
    else:
        initial = _workspace_initial_path()
        try:
            current = _validate_browse_path(str(initial), roots)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
            fallback = Path.home()
            try:
                current = _validate_browse_path(str(fallback), roots)
            except HTTPException as home_error:
                if home_error.status_code != 404 or not roots:
                    raise
                current = _validate_browse_path(roots[0]["path"], roots)
    parent_path = current.parent if current.parent != current else None
    matches: list[tuple[str, str]] = []
    scanned = 0
    truncated = False
    needle = query.casefold()
    try:
        with os.scandir(current) as entries:
            for entry in entries:
                scanned += 1
                if scanned > _MAX_DIRECTORY_SCAN:
                    truncated = True
                    break
                try:
                    child_path = Path(entry.path)
                    if entry.is_symlink() or getattr(child_path, "is_junction", lambda: False)():
                        continue
                    if entry.is_dir(follow_symlinks=False) and needle in entry.name.casefold():
                        matches.append((entry.name, str(current / entry.name)))
                except OSError:
                    continue
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=f"Cannot list directory (permission denied): {current}") from exc
    except OSError as exc:
        raise HTTPException(status_code=422, detail=f"Cannot list directory: {current} ({exc.strerror or exc})") from exc
    matches.sort(key=lambda item: (item[0].casefold(), item[0]))
    page = matches[offset:offset + limit]
    next_offset = offset + len(page) if offset + len(page) < len(matches) else None
    return {
        "path": str(current),
        "parent": str(parent_path) if parent_path is not None else None,
        "roots": roots,
        "directories": [{"name": name, "path": child_path} for name, child_path in page],
        "next_offset": next_offset,
        "truncated": truncated,
    }


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
    from app.api.routes.workbench_proxy import require_workbench_page, is_local_page
    require_workbench_page(request)
    local = is_local_page(request)
    requested_root = payload.base_path.strip()
    if requested_root and not Path(requested_root).is_absolute():
        raise HTTPException(status_code=422, detail="Workspace base path must be absolute")
    default_root = _default_session_workspace_root().resolve()
    root = (Path(requested_root).expanduser() if requested_root else default_root).resolve()
    if not local:
        allowed_roots = {default_root}
        allowed_roots.update(Path(item.strip()).expanduser().resolve()
            for item in os.environ.get("LKA_REMOTE_WORKSPACE_ROOTS", "").split(";") if item.strip())
        if root not in allowed_roots:
            raise HTTPException(status_code=403, detail="Remote workspace root is not enabled")
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
