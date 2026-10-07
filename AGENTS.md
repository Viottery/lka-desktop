# LKA Desktop development

This repository is **理事所 / LKA Desktop**; the desktop character is **真理**.
Read `README.MD` and the relevant handoff in `docs/` before changing behavior.
Inspect Git state and preserve unrelated user changes.

## Location and runtime

- On the current workstation, development and the active Windows frontend both
  use `D:\lka-desktop` (`/mnt/d/lka-desktop` in WSL). The old
  `D:\agent-bot-frontend` directory is a rollback copy, not a development target.
- Backend development and daily operation use the independent WSL `lka_backend`
  repository and `lka-backend.service`; do not start a second Windows daily backend.
- The desktop shortcut uses `run-lka-windows.ps1 -NoBackend`. QQ bridge hosting
  is independent under ignored `.runtime/snowluma/`; reuse it when healthy.
  Local migration/rollback records are ignored under `.runtime/migration-20261006/`.
- The public launcher is `run-lka-windows.ps1 -NoBackend`; browser mode adds
  `-NoPet -OpenBrowser`. It restarts frontend processes. Default ports: frontend
  8780, backend 8765. Check actual process roots and backend URL before debugging.

## Code and validation

- `app/web/pet/`: shared chat, quick tasks, workbench, messages, memory and projects;
  native HTML/CSS/JS without a bundler build.
- `desktop-pet-java/`: Java 21, native windows, Spine pet, IME and host bridge.
- `app/main.py`, `app/api/routes/`, `app/plugins/`: local Python service and QQ adapters.
- Agent/tool execution, persistent sessions and analysis belong to the backend.
  Compare raw backend response/SSE/trace with UI output before assigning a fault.
- Run targeted browser scripts from `package.json`, relevant Python tests or Java
  compile/interaction checks. Read `docs/repository_delivery.md` before publishing.

## Local data

Keep `.env`, `.runtime/`, `.venv/`, logs, QQ databases/media, credentials and pet
state out of Git. The paired control credential is DPAPI protected and only enters
Python's environment, never Java/browser arguments. Do not recreate pairing during
routine startup. Back up SQLite consistently; never share it across Windows/WSL.
The current QQ client still maps an original DLL from the old directory: keep that
rollback copy intact until QQ exits. Do not reinject/restart QQ, send messages,
clear data or enable additional integrations as an incidental frontend fix.
Do not commit or push unless requested.
