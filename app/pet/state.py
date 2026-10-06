from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any

from app.pet.models import PetActionRequest, PetProfile, PetState, PetStatePatch, SpineAsset


DEFAULT_PROFILES = [
    PetProfile(
        id="agent",
        name="Agent",
        role="workspace companion",
        accent="#3f7f6b",
        description="默认助手入口。放入 Spine 资源后可替换为真实小人。",
    ),
    PetProfile(
        id="operator",
        name="Operator",
        role="spine-ready profile",
        accent="#6b73c8",
        description="Spine 资源预留位，适合接入本地 skeleton/atlas/texture。",
        spine=SpineAsset(
            skeleton_url="",
            atlas_url="",
            texture_prefix="",
            runtime_script_url="",
        ),
    ),
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dump_model(model: Any) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump()
    return model.dict()


class PetStateStore:
    def __init__(self, state_path: Path, profiles_path: Path | None = None) -> None:
        self.state_path = state_path
        self.profiles_path = profiles_path or state_path.with_name("profiles.json")

    def list_profiles(self) -> list[PetProfile]:
        if self.profiles_path.exists():
            raw_profiles = json.loads(self.profiles_path.read_text(encoding="utf-8"))
            return [PetProfile(**item) for item in raw_profiles]
        return DEFAULT_PROFILES.copy()

    def load(self) -> PetState:
        if not self.state_path.exists():
            return self._default_state()
        try:
            state = PetState(**json.loads(self.state_path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            return self._default_state()

        profile_ids = {profile.id for profile in self.list_profiles()}
        if state.active_profile_id not in profile_ids:
            state.active_profile_id = self._default_profile_id()
        return state

    def save(self, state: PetState) -> PetState:
        state.updated_at = _now_iso()
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(
            json.dumps(_dump_model(state), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return state

    def patch(self, patch: PetStatePatch) -> PetState:
        state = self.load()
        updates = _dump_model(patch)
        for key, value in updates.items():
            if value is not None:
                setattr(state, key, value)
        state = self._normalize_state(state)
        return self.save(state)

    def apply_action(self, request: PetActionRequest) -> PetState:
        state = self.load()
        action = request.action
        payload = request.payload

        if action == "poke":
            state.animation = "poke"
            state.mood = "happy"
            state.bubble = "嗯？我听着呢。"
        elif action == "wave":
            state.animation = "wave"
            state.mood = "happy"
            state.bubble = "打开面板就能和我聊。"
        elif action == "think":
            state.animation = "think"
            state.mood = "thinking"
            state.bubble = "让我想一下。"
        elif action == "work":
            state.animation = "work"
            state.mood = "working"
            state.bubble = "正在处理任务。"
        elif action == "sleep":
            state.animation = "sleep"
            state.mood = "idle"
            state.bubble = "我先待机。"
        elif action == "move":
            state.animation = "move"
            state.mood = "working"
            state.bubble = "我移动一下。"
        elif action == "say":
            state.animation = payload.get("animation") or state.animation
            state.mood = payload.get("mood") or state.mood
            state.bubble = str(payload.get("text") or state.bubble)[:180]
        elif action == "open_interaction":
            state.panel_open = True
            state.animation = "wave"
            state.mood = "happy"
            state.bubble = "交互面板已打开。"
        elif action == "close_interaction":
            state.panel_open = False
            state.animation = "idle"
            state.mood = "idle"
            state.bubble = "我会在桌面边上等你。"
        elif action == "switch_profile":
            state.active_profile_id = str(payload.get("profile_id") or state.active_profile_id)
            state.animation = "idle"
            state.mood = "idle"
            state.bubble = "形态已切换。"
        elif action == "set_animation":
            state.animation = payload.get("animation") or state.animation
        elif action == "set_scale":
            state.scale = float(payload.get("scale", state.scale))
        elif action == "toggle_manual":
            state.manual_mode = bool(payload.get("enabled", not state.manual_mode))
            state.bubble = "手动模式已开启。" if state.manual_mode else "手动模式已关闭。"
        elif action == "toggle_transparent":
            state.transparent_mode = bool(payload.get("enabled", not state.transparent_mode))
            state.bubble = "透明穿透已开启。" if state.transparent_mode else "透明穿透已关闭。"

        state = self._normalize_state(state)
        return self.save(state)

    def manifest(self) -> dict[str, Any]:
        state = self.load()
        return {
            "profiles": [_dump_model(profile) for profile in self.list_profiles()],
            "state": _dump_model(state),
            "endpoints": {
                "state": "/pet/state",
                "action": "/pet/action",
                "chat": "/pet/chat",
                "chat_jobs": "/chat/jobs/{job_id}",
            },
            "ui": {
                "entry": "/desktop-pet/",
                "asset_base": "/desktop-pet/assets/",
            },
        }

    def _default_profile_id(self) -> str:
        profiles = self.list_profiles()
        return profiles[0].id if profiles else "agent"

    def _default_state(self) -> PetState:
        return PetState(active_profile_id=self._default_profile_id(), updated_at=_now_iso())

    def _normalize_state(self, state: PetState) -> PetState:
        profiles = self.list_profiles()
        profile_by_id = {profile.id: profile for profile in profiles}
        profile = profile_by_id.get(state.active_profile_id) or profiles[0]
        state.active_profile_id = profile.id
        if state.animation not in profile.animations:
            state.animation = profile.default_animation
        state.scale = max(profile.min_scale, min(profile.max_scale, state.scale))
        state.bubble = state.bubble[:180]
        return state


_DEFAULT_STORE: PetStateStore | None = None


def get_pet_state_store() -> PetStateStore:
    global _DEFAULT_STORE
    if _DEFAULT_STORE is None:
        _DEFAULT_STORE = PetStateStore(Path("data/pet/state.json"))
    return _DEFAULT_STORE
