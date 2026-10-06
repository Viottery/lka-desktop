# Windows Pet Frontend Notes

This document organizes the Windows desktop pet frontend files, runtime entry
points, and profile configuration workflow.

## 1. Frontend File Layout

Primary pet frontend files:

- `app/web/pet/index.html`: desktop pet layer UI
- `app/web/pet/pet.css`: desktop pet layer styles
- `app/web/pet/pet.js`: desktop pet layer logic and rendering bridge
- `app/web/pet/chat.html`: interaction panel page
- `app/web/pet/chat.css`: interaction panel styles
- `app/web/pet/chat.js`: interaction panel logic
- `app/web/pet/vendor/`: local runtime libraries (Spine/Pixi)
- `app/web/pet/assets/`: local pet assets

Backend pet endpoints used by the frontend:

- `GET /pet/manifest`
- `GET /pet/state`
- `PUT /pet/state`
- `POST /pet/action`
- `POST /pet/chat`
- `POST /pet/session-workspace` (creates one folder per session under Documents or an optional absolute `base_path`; local callers only)

## 2. Profile Configuration

Profile source of truth:

- `data/pet/profiles.json`

Each profile should define:

- `id`, `name`, `accent`, `description`
- `spine` asset URLs (`skeleton_url`, `atlas_url`, `texture_url`)
- `spine.animation_map` for action-to-animation mapping
- `animations`, `default_animation`, and scale limits

State persistence:

- runtime state file: `data/pet/state.json` (generated locally)

## 3. Runtime Pages and Modes

Pet layer page:

- `/desktop-pet/?layer=1`

Quick task panel:

- `/desktop-pet/chat.html?mode=quick`

Large workbench:

- `/desktop-pet/chat.html?mode=work`

From a quick task that already has messages, use **继续在工作台** to open
`?mode=work&session_id=<id>`; a running task also passes `run_id` so the workbench
can reconnect to its saved event stream. The ordinary **工作台** button still
opens a fresh task. Each window keeps its own selected conversation.

The desktop pet's right-click menu opens either mode. Both modes share the same
session store and Agent calls. The old `?mode=panel` URL redirects to quick mode.
New sessions create a folder under the Windows Documents known folder at
`Local Knowledge Agent/Workspaces/<session_id>`; set
`LKA_SESSION_WORKSPACE_BASE` to use a different parent folder. Users can select
an existing folder from the work settings panel.

The session sidebar also has an `已删除` view. Deletion calls the backend
`DELETE /sessions/{session_id}` before removing a session locally; the backend
marks the row as deleted. `GET /sessions/deleted` lists recoverable sessions,
and `POST /sessions/{session_id}/restore` restores one with its messages.
Unsent local drafts have no backend row, so their snapshot is kept in the
frontend's local storage for recovery. Session workspace files are not removed.
No automatic expiry or purge is currently implemented.
The Java quick panel passes its backend URL to the browser workbench, so both
windows use the same session database. Reopening either window starts on a new
task; existing conversations remain accessible in the sidebar. A saved
conversation is not removed locally if its backend deletion returns 404.

The current interaction model also provides:

- Per-session input drafts, including JavaFX's native input field; switching
  sessions or reopening a window restores the draft. A successful send clears
  only that session's draft.
- A ten-second **撤销** action after deletion. Older deleted sessions remain
  recoverable in **已删除** without a time limit.
- Backend-wide title/message search, 30 results per page and a **加载更早的会话**
  action. `Ctrl+Shift+K` focuses search; Up/Down moves between results.
- A collapsible run timeline, visible manual safety approvals, and a failed
  task action that copies the prior request back into an empty draft for review.
- Workbench **文件** and **设置** tabs. File listing and preview use the backend's
  loopback-only read-only session workspace endpoints. Text is limited to
  256 KiB; PNG/JPEG/WebP/PDF previews are limited to 8 MiB. Symlinks and paths
  outside the bound workspace cannot be browsed.
- Drag or use arrow keys on the column separators to resize the session and
  right panels. Widths are saved locally; the right panel becomes a drawer at
  narrower widths, and the composer remains visible at low heights.

The frontend polls the backend while visible and refreshes on focus, so JavaFX
and browser windows converge even though they have separate browser storage.
Same-browser tabs also use storage events. The backend remains the source of
truth for saved messages, titles, deletion, and workspace binding.

Browser fallback:

- `/desktop-pet/`

## 4. Windows Launcher Matrix

Python launcher:

- script: `scripts/start-desktop-pet.ps1`
- default path: Qt WebEngine transparent window
- fallback: `-Static` for native placeholder window
- fallback: `-WebView` for pywebview host
- debug: `-Browser` opens browser page

Java launcher:

- script: `scripts/start-desktop-pet-java.ps1`
- `-Spine` starts Java Spine rendering mode
- default run mode can choose static or web layer flags
- logs written to `logs/desktop-pet-java.out.log` and
  `logs/desktop-pet-java.err.log`

## 5. Asset Update Workflow

1. Add new model files under `app/web/pet/assets/<profile-id>/...`.
2. Add or update profile entry in `data/pet/profiles.json`.
3. Verify mapped animation names in `spine.animation_map`.
4. Start backend with `.\run-native-local.ps1`.
5. Launch pet window with `.\scripts\start-desktop-pet.ps1`.
6. Validate interaction actions (`poke`, `wave`, `sleep`, `move`) and panel chat.

## 6. Git Hygiene For Pet Development

Should remain tracked:

- `app/web/pet/**` source files
- `data/pet/profiles.json`
- selected pet assets under `app/web/pet/assets/**`

Should stay local (ignored):

- `.runtime/`
- `logs/`
- `backups/`
- `smoke_output/`
- `desktop-pet-java/build/`
- `desktop-pet-java/.gradle/`
- `data/pet/state.json`
- `data/memory/*.db`

Related overview docs:

- [`docs/desktop-pet-entry.md`](desktop-pet-entry.md)
- [`docs/windows-native-runtime-guide.md`](windows-native-runtime-guide.md)
- [`docs/windows-native-agent.md`](windows-native-agent.md)
