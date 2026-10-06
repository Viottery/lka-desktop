# Windows Desktop Pet Entry

This project exposes a Windows desktop pet entry with a stable native
transparent shell. The pet body is intentionally not hosted in WebView because
Windows WebView2 transparency is unreliable for this use case and can leave an
opaque background. WebView/browser rendering is kept for the interaction panel
and debugging fallback only.

## Entry Points

- Native transparent pet launcher: `scripts/start-desktop-pet.ps1`
- JavaFX transparent pet launcher: `scripts/start-desktop-pet-java.ps1`
- Spine pet implementation: `app/pet/qt_spine_window.py`
- Static native fallback: `app/pet/native_window.py`
- Java window implementation: `desktop-pet-java/src/main/java/com/agenticrag/pet/`
- Transparent layer URL: `http://127.0.0.1:8000/desktop-pet/?layer=1`
- Browser fallback UI: `http://127.0.0.1:8000/desktop-pet/`
- Manifest: `GET /pet/manifest`
- State: `GET /pet/state`
- Update state: `PUT /pet/state`
- Action: `POST /pet/action`
- Chat through pet: `POST /pet/chat`

The normal startup path is the Qt WebEngine transparent Spine shell. It reuses
the existing local Spine WebGL assets and opens interaction panels as app
windows instead of browser tabs. The Tk/Win32 shell is available with `-Static`
as a conservative fallback.

## Data Flow

1. The frontend loads `GET /pet/manifest`.
2. It renders the active pet profile and state.
3. Clicks on the pet call `POST /pet/action`.
4. Opening the panel calls `POST /pet/action` with `open_interaction`.
5. Messages from the panel call `POST /pet/chat`, which delegates to the
   existing conversation queue used by `/chat`.
6. Pet state is persisted in `data/pet/state.json`.

## Action Contract

```http
POST /pet/action
Content-Type: application/json

{
  "action": "poke",
  "payload": {}
}
```

Supported actions:

- `poke`
- `wave`
- `think`
- `work`
- `sleep`
- `move`
- `say`
- `open_interaction`
- `close_interaction`
- `switch_profile`
- `set_animation`
- `set_scale`
- `toggle_manual`
- `toggle_transparent`

## Chat Contract

```http
POST /pet/chat
Content-Type: application/json

{
  "message": "帮我总结 README",
  "conversation_id": "pet-local",
  "mode": "wait"
}
```

The response includes the updated pet `state`, the queue `job`, and the normal
agent `result`.

## Spine Assets

The frontend has a Spine 3.5 WebGL renderer adapter for binary `.skel` assets.
The current local profile file wires the PRTS "真理" build assets:

- default skin: `truth-default-build`
- book skin: `truth-book-build`
- idle maps to `Relax` / `RelaxW`
- interaction maps to `Interact` / `InteractW`
- movement maps to `Move` / `MoveW`

To wire another Spine 3.5 asset:

1. Put assets under `app/web/pet/assets/<profile-id>/`.
2. Create `data/pet/profiles.json`.
3. Fill the profile's `spine` block:

```json
[
  {
    "id": "operator",
    "name": "Operator",
    "accent": "#6b73c8",
    "spine": {
      "runtime": "spine-webgl",
      "skeleton_url": "/desktop-pet/assets/operator/model.skel",
      "atlas_url": "/desktop-pet/assets/operator/model.atlas",
      "texture_url": "/desktop-pet/assets/operator/model.png",
      "runtime_script_url": "/desktop-pet/vendor/spine-webgl-3.6-binary.js",
      "animation_map": {
        "idle": "Relax",
        "poke": "Interact",
        "move": "Move",
        "sleep": "Sleep"
      },
      "skeleton_scale": 0.52,
      "floor_offset": 24
    },
    "animations": ["idle", "poke", "move", "sleep"],
    "default_animation": "idle",
    "min_scale": 0.7,
    "max_scale": 1.6
  }
]
```

If a profile is missing assets, the page falls back to a canvas-rendered
placeholder so the API and interaction workflow remain testable.

The active Spine runtime is `app/web/pet/vendor/spine-webgl-3.6-binary.js`,
with a local compatibility patch for the PRTS Spine 3.5 binary format. The
character assets are stored locally from `https://static.prts.wiki/spine/`.

## Native Window Behavior

The Java Spine desktop pet uses the local build skeleton's `Relax`, `Interact`,
`Move`, `Sit`, `Sleep`, and (for the book outfit) `Special` animations:

- A single left click plays `Interact` after a 260 ms double-click window; a second
  click within that window plays `Special` when available, without playing `Interact` first.
  Holding for at least 580 ms without dragging makes the pet sit.
- Dragging moves the pet at cursor speed and leaves it at the released screen position.
  It does not snap to application windows or the desktop edge.
- The pet periodically walks horizontally toward targets across the current monitor
  while keeping its current vertical position. It pauses automatic motion while the
  right-click quick window is open or while the user drags it.
- The quick window's pet settings menu offers greeting, ceremonial dance, sitting,
  sleeping, and returning to standing. Its existing automatic behavior switch
  controls random actions and roaming.

Run `gradlew.bat verifyPetMotion --offline` in `desktop-pet-java` to check the
roam-target rules without opening a desktop session.

## Windows Launcher

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-desktop-pet.ps1
```

The script starts the native FastAPI app and opens the pet entry in a frameless,
transparent, always-on-top native window. The pet window talks to the backend
through `/pet/state` and `/pet/action`; quick tasks open
`/desktop-pet/chat.html?mode=quick`, and the workbench opens
`/desktop-pet/chat.html?mode=work`.

Use the browser fallback only for debugging:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-desktop-pet.ps1 -Browser
```

Use the static fallback when Qt WebEngine is unavailable:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-desktop-pet.ps1 -Static
```

Use the old pywebview layer only when testing that host specifically:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-desktop-pet.ps1 -WebView
```

## Java Environment

Install or validate Java 21 (Temurin) for this project:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-java-env.ps1 -InstallPrereqs
```

The script validates `java -version`, refreshes shell PATH from registry,
and exports `JAVA_HOME` for the current session.

## JavaFX Window Entry

Run Java desktop pet window (it keeps the existing `/desktop-pet/?layer=1`
frontend, but hosts it in a JavaFX transparent shell):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-desktop-pet-java.ps1
```

The Java version mirrors the core window strategy used by ArkPets on Windows:

- transparent undecorated window (`StageStyle.TRANSPARENT`)
- hide taskbar entry via `WS_EX_TOOLWINDOW` / `WS_EX_APPWINDOW`
- keep topmost using native window APIs
- dynamic click-through by toggling `WS_EX_TRANSPARENT`
- left-drag window move and double-click open panel
