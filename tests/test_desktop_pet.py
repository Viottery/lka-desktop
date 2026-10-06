from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException, Request
from pydantic import ValidationError

from app.api.routes.pet import SessionWorkspaceCreateRequest, create_session_workspace
from app.pet.models import PetActionRequest, PetStatePatch
from app.pet.state import PetStateStore


def test_pet_manifest_includes_ui_and_interaction_endpoints(tmp_path: Path) -> None:
    store = PetStateStore(tmp_path / "state.json")

    manifest = store.manifest()

    assert manifest["ui"]["entry"] == "/desktop-pet/"
    assert manifest["endpoints"]["action"] == "/pet/action"
    assert manifest["endpoints"]["chat"] == "/pet/chat"
    assert manifest["state"]["active_profile_id"] == manifest["profiles"][0]["id"]


def test_pet_action_opens_interaction_panel_and_persists_state(tmp_path: Path) -> None:
    store = PetStateStore(tmp_path / "state.json")

    state = store.apply_action(PetActionRequest(action="open_interaction"))
    reloaded = store.load()

    assert state.panel_open is True
    assert state.animation == "wave"
    assert reloaded.panel_open is True
    assert reloaded.bubble == "交互面板已打开。"


def test_pet_state_scale_is_clamped_to_profile_bounds(tmp_path: Path) -> None:
    store = PetStateStore(tmp_path / "state.json")

    state = store.patch(PetStatePatch(scale=9.0))

    assert state.scale == 1.6


def test_pet_move_action_is_available_for_spine_profiles(tmp_path: Path) -> None:
    store = PetStateStore(tmp_path / "state.json")

    state = store.apply_action(PetActionRequest(action="move"))

    assert state.animation == "move"
    assert state.mood == "working"


def test_session_workspace_is_created_once_under_configured_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LKA_SESSION_WORKSPACE_BASE", str(tmp_path / "workspaces"))
    request = Request({"type": "http", "client": ("127.0.0.1", 12345)})
    payload = SessionWorkspaceCreateRequest(session_id="conv_123")

    first = create_session_workspace(payload, request)
    second = create_session_workspace(payload, request)

    assert first == second
    assert Path(first["path"]).is_dir()
    assert Path(first["path"]).parent == tmp_path / "workspaces"


def test_session_workspace_accepts_absolute_custom_parent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LKA_SESSION_WORKSPACE_BASE", str(tmp_path / "default"))
    request = Request({"type": "http", "client": ("127.0.0.1", 12345)})
    chosen = tmp_path / "chosen"
    result = create_session_workspace(SessionWorkspaceCreateRequest(session_id="conv_456", base_path=str(chosen)), request)
    assert Path(result["path"]).parent == chosen
    with pytest.raises(HTTPException) as error:
        create_session_workspace(SessionWorkspaceCreateRequest(session_id="conv_456", base_path="relative"), request)
    assert error.value.status_code == 422


def test_session_workspace_maps_opaque_ids_to_safe_stable_directories(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LKA_SESSION_WORKSPACE_BASE", str(tmp_path))
    request = Request({"type": "http", "client": ("127.0.0.1", 12345)})
    for session_id in ("legacy:session.中文", "../elsewhere", "CON", "x" * 150):
        payload = SessionWorkspaceCreateRequest(session_id=session_id)
        first = create_session_workspace(payload, request)
        second = create_session_workspace(payload, request)
        assert first == second
        assert Path(first["path"]).parent == tmp_path
        assert Path(first["path"]).name.startswith("session-")
        assert Path(first["path"]).is_dir()
    assert not (tmp_path.parent / "elsewhere").exists()
    with pytest.raises(ValidationError):
        SessionWorkspaceCreateRequest(session_id="")
    with pytest.raises(ValidationError):
        SessionWorkspaceCreateRequest(session_id="x" * 201)


def test_session_workspace_rejects_remote_request(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LKA_SESSION_WORKSPACE_BASE", str(tmp_path))
    with pytest.raises(HTTPException) as error:
        create_session_workspace(
            SessionWorkspaceCreateRequest(session_id="conv_123"),
            Request({"type": "http", "client": ("192.0.2.4", 12345)}),
        )
    assert error.value.status_code == 403
    assert not (tmp_path / "conv_123").exists()
