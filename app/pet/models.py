from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


PetMood = Literal["idle", "happy", "thinking", "working", "alert"]
PetAnimation = Literal["idle", "wave", "poke", "think", "work", "sleep", "move"]
PetAction = Literal[
    "poke",
    "wave",
    "think",
    "work",
    "sleep",
    "move",
    "say",
    "open_interaction",
    "close_interaction",
    "switch_profile",
    "set_animation",
    "set_scale",
    "toggle_manual",
    "toggle_transparent",
]


class SpineAsset(BaseModel):
    runtime: Literal["spine-webgl", "spine-player", "none"] = "none"
    skeleton_url: str = ""
    atlas_url: str = ""
    texture_url: str = ""
    texture_prefix: str = ""
    runtime_script_url: str = ""
    animation_map: dict[str, str] = Field(default_factory=dict)
    skeleton_scale: float = 0.5
    x_offset: float = 0.0
    floor_offset: float = 24.0
    premultiplied_alpha: bool = False


class PetProfile(BaseModel):
    id: str
    name: str
    role: str = "assistant"
    accent: str = "#3f7f6b"
    description: str = ""
    spine: SpineAsset = Field(default_factory=SpineAsset)
    animations: list[str] = Field(default_factory=lambda: ["idle", "wave", "poke", "think", "work", "sleep", "move"])
    default_animation: str = "idle"
    min_scale: float = 0.7
    max_scale: float = 1.6


class PetState(BaseModel):
    active_profile_id: str = "agent"
    animation: PetAnimation = "idle"
    mood: PetMood = "idle"
    bubble: str = "我在这里。"
    panel_open: bool = False
    manual_mode: bool = False
    transparent_mode: bool = False
    scale: float = 1.0
    updated_at: str = ""


class PetStatePatch(BaseModel):
    active_profile_id: str | None = None
    animation: PetAnimation | None = None
    mood: PetMood | None = None
    bubble: str | None = None
    panel_open: bool | None = None
    manual_mode: bool | None = None
    transparent_mode: bool | None = None
    scale: float | None = None


class PetActionRequest(BaseModel):
    action: PetAction
    payload: dict[str, Any] = Field(default_factory=dict)


class PetChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    conversation_id: str | None = None
    mode: Literal["wait", "background"] = "wait"
