"""Conservative Windows Git-source updater. Uses only the Python standard library.

No services are stopped or started here. Private backups and the retry journal stay
in .runtime/updates. A failed dependency installation is resumed, never reported
as a successful release or repaired with a destructive Git reset.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path

REPOSITORIES = {
    "frontend": "Viottery/lka-desktop",
    "backend": "Viottery/lka-backend",
}


class UpdateError(Exception):
    pass


def command(args, *, cwd=None, log=None, env=None):
    result = subprocess.run(
        [str(arg) for arg in args],
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=1800,
        check=False,
    )
    if log:
        with Path(log).open("ab") as stream:
            stream.write(result.stdout)
    if result.returncode:
        # Git/pip errors can contain credential-bearing URLs. Keep output private.
        raise UpdateError(
            f"Command failed ({Path(str(args[0])).name}); see the private update log."
        )
    return result.stdout.decode("utf-8", errors="replace").strip()


def git(root, *args, log=None):
    return command(["git", "-c", "core.quotepath=false", "-C", root, *args], log=log)


def save_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


@contextmanager
def update_lock(root):
    """OS advisory lock is released even when the updater is killed."""
    path = root / ".runtime/updates/updater.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        if path.stat().st_size == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise UpdateError("Another update/check is running. Wait for it to finish.") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def settings_for(root):
    path = root / ".runtime/update-settings.json"
    settings = json.loads(path.read_text(encoding="utf-8-sig")) if path.exists() else {}
    allowed = {
        "backend_mode",
        "backend_root",
        "backend_data_dir",
        "backend_config_file",
        "frontend_ports",
        "backend_ports",
        "backup_paths",
        "qq_dependencies",
    }
    if not isinstance(settings, dict) or set(settings) - allowed:
        raise UpdateError("Unknown update-settings.json keys; see docs/windows-updates.md.")
    mode = settings.setdefault("backend_mode", "external")
    if mode not in {"external", "native"}:
        raise UpdateError("backend_mode must be external or native.")
    for name in ("frontend_ports", "backend_ports"):
        ports = settings.setdefault(name, [8780] if name == "frontend_ports" else [8765])
        if not isinstance(ports, list) or any(
            type(p) is not int or not 1 <= p <= 65535 for p in ports
        ):
            raise UpdateError(f"Invalid {name}.")
    if type(settings.setdefault("qq_dependencies", False)) is not bool:
        raise UpdateError("qq_dependencies must be a boolean.")
    extras = settings.setdefault("backup_paths", [])
    if not isinstance(extras, list) or any(not isinstance(p, str) for p in extras):
        raise UpdateError("backup_paths must be an array of absolute paths.")
    paths = list(extras)
    if mode == "native":
        paths += [
            settings.get(key, "")
            for key in ("backend_root", "backend_data_dir", "backend_config_file")
        ]
    for value in paths:
        if not isinstance(value, str) or not Path(value).is_absolute() or not Path(value).exists():
            raise UpdateError("Configured backup/backend paths must be absolute and exist.")
    if mode == "native":
        backend = Path(settings["backend_root"]).resolve()
        if backend == root or backend in root.parents or root in backend.parents:
            raise UpdateError("Frontend and native backend must be separate checkouts.")
        if not (Path(settings["backend_data_dir"]) / "lka.sqlite3").is_file():
            raise UpdateError("backend_data_dir must contain the existing lka.sqlite3.")
    return settings


def official_remote(value, component):
    project = REPOSITORIES[component].lower()
    return value.lower().removesuffix(".git") in {
        f"https://github.com/{project}",
        f"git@github.com:{project}",
        f"ssh://git@github.com/{project}",
    }


def validate_checkout(root, component, *, expected_head=None):
    if Path(git(root, "rev-parse", "--show-toplevel")).resolve() != root:
        raise UpdateError(f"{component}: not a checkout root.")
    if git(root, "symbolic-ref", "--short", "HEAD") != "main":
        raise UpdateError(f"{component}: switch to main before updating.")
    if not official_remote(git(root, "remote", "get-url", "origin"), component):
        raise UpdateError(f"{component}: origin must point to the official GitHub repository.")
    if git(root, "status", "--porcelain", "--untracked-files=all"):
        raise UpdateError(
            f"{component}: uncommitted files found. Commit or preserve them before updating."
        )
    head = git(root, "rev-parse", "HEAD")
    if expected_head and head != expected_head:
        raise UpdateError(
            f"{component}: checkout changed during the update; no automatic reset attempted."
        )
    return head


def release_manifest(root, target):
    raw = git(root, "show", f"{target}:release-channel.json")
    if len(raw) > 16384:
        raise UpdateError("Release manifest is too large.")
    manifest = json.loads(raw)
    if (
        not isinstance(manifest, dict)
        or manifest.get("format") != 1
        or not isinstance(manifest.get("version"), str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", manifest["version"])
        or not isinstance(manifest.get("backend_commit"), str)
        or not re.fullmatch(r"[0-9a-f]{40}", manifest["backend_commit"])
    ):
        raise UpdateError("Invalid release-channel.json; no update applied.")
    return manifest


def private_target(name, component):
    parts = Path(name).parts
    return (
        any(p in {".runtime", ".venv", ".bootstrap", "logs", "backups"} for p in parts)
        or (Path(name).name.startswith(".env") and not name.endswith(".example"))
        or (component == "backend" and name == "config/local.toml")
        or name.endswith((".sqlite", ".sqlite3", ".db", ".dpapi", "-wal", "-shm"))
    )


def plan_component(root, component, target, old):
    # A local commit or divergent development branch must never be discarded.
    git(root, "merge-base", "--is-ancestor", old, target)
    names = git(root, "ls-tree", "-r", "--name-only", target).splitlines()
    if any(private_target(name, component) for name in names):
        raise UpdateError(f"{component}: release contains a private/runtime path.")
    changes = git(root, "diff", "--name-only", old, target).splitlines()
    return {
        "component": component,
        "root": str(root),
        "old": old,
        "target": target,
        "dependencies": component == "backend"
        or any(name in {"requirements.txt", "requirements-qq-reader.txt"} for name in changes),
        "java": component == "frontend"
        and any(name.startswith("desktop-pet-java/") for name in changes),
    }


def make_plan(root, settings, log):
    before = validate_checkout(root, "frontend")
    git(root, "fetch", "--no-tags", "origin", "main", log=log)
    target = git(root, "rev-parse", "FETCH_HEAD^{commit}")
    manifest = release_manifest(root, target)
    components = [plan_component(root, "frontend", target, before)]
    if settings["backend_mode"] == "native":
        backend = Path(settings["backend_root"]).resolve()
        old = validate_checkout(backend, "backend")
        git(backend, "fetch", "--no-tags", "origin", manifest["backend_commit"], log=log)
        pin = git(backend, "rev-parse", "FETCH_HEAD^{commit}")
        if pin != manifest["backend_commit"]:
            raise UpdateError("Backend fetch does not match the release manifest.")
        components.insert(0, plan_component(backend, "backend", pin, old))
    return {
        "format": 1,
        "version": manifest["version"],
        "backend_commit": manifest["backend_commit"],
        "settings": settings,
        "components": components,
        "stage": "planned",
    }


def process_blockers(root, settings):
    if os.name != "nt":
        raise UpdateError("Apply must run with native Windows Python.")
    raw = command(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            (
                "$ErrorActionPreference='Stop'; [Console]::OutputEncoding="
                "[Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process | "
                "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress"
            ),
        ]
    )
    processes = json.loads(raw)
    ignored = {os.getpid()}
    for _ in range(32):
        parents = {p["ParentProcessId"] for p in processes if p["ProcessId"] in ignored}
        if parents <= ignored:
            break
        ignored |= parents
    roots = [root]
    ports = settings["frontend_ports"][:]
    if settings["backend_mode"] == "native":
        roots.append(Path(settings["backend_root"]))
        ports += settings["backend_ports"]
    blockers = []
    for process in processes:
        if process["ProcessId"] in ignored:
            continue
        executable = (process.get("ExecutablePath") or "").replace("\\", "/").lower()
        line = (process.get("CommandLine") or "").replace("\\", "/").lower()
        relevant = Path(executable).name.startswith(("python", "java", "uvicorn", "uv.exe"))
        if relevant and any(
            str(path).replace("\\", "/").lower() + "/" in executable + " " + line for path in roots
        ):
            blockers.append(f"process {process['ProcessId']} ({Path(executable).name})")
    for port in sorted(set(ports)):
        with socket.socket() as connection:
            connection.settimeout(0.3)
            if connection.connect_ex(("127.0.0.1", port)) == 0:
                blockers.append(f"listening port {port}")
    if blockers:
        raise UpdateError(
            "Close the frontend/pet and selected native backend first: "
            + ", ".join(blockers)
            + ". The updater will not kill tasks or the QQ bridge."
        )


def is_link(path):
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def backup_tree(source, destination):
    """Copy data without following links; use SQLite online backup for WAL safety."""
    if is_link(source):
        raise UpdateError(
            "Backup source is a symbolic link. Back it up separately before updating."
        )
    paths = [source] if source.is_file() else [source, *source.rglob("*")]
    databases = set()
    for path in paths:
        if is_link(path):
            raise UpdateError(
                "Backup contains a symbolic link. Configure an explicit real backup path."
            )
        if path.is_file():
            with path.open("rb") as stream:
                if stream.read(16) == b"SQLite format 3\x00":
                    databases.add(path)
    sidecars = {
        Path(str(path) + suffix) for path in databases for suffix in ("-wal", "-shm", "-journal")
    }
    for path in paths:
        target = destination if path == source else destination / path.relative_to(source)
        if path in sidecars:
            continue
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if path in databases:
            deadline = time.monotonic() + 60

            def progress(*_, deadline=deadline):
                if time.monotonic() > deadline:
                    raise UpdateError("Database backup timed out; no code update applied.")

            with (
                closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as src,
                closing(sqlite3.connect(target)) as dst,
            ):
                src.backup(dst, pages=256, progress=progress)
                if dst.execute("PRAGMA quick_check").fetchone() != ("ok",):
                    raise UpdateError("Database backup integrity check failed.")
        else:
            shutil.copy2(path, target)


def backup_installations(root, plan, directory):
    paths = [(root / "data", "frontend/data")]
    paths += [
        (path, "frontend/" + path.name)
        for path in root.glob(".env*")
        if not path.name.endswith(".example")
    ]
    paths += [
        (path, "frontend/" + path.relative_to(root).as_posix())
        for path in (root / ".runtime").rglob("*.dpapi")
    ]
    settings = plan["settings"]
    if settings["backend_mode"] == "native":
        backend = Path(settings["backend_root"])
        paths += [
            (Path(settings["backend_data_dir"]), "backend/data"),
            (Path(settings["backend_config_file"]), "backend/local.toml"),
            (backend / ".env", "backend/.env"),
        ]
    paths += [(Path(path), f"extra/{i}") for i, path in enumerate(settings["backup_paths"])]
    required = {Path(path) for path in settings["backup_paths"]}
    if settings["backend_mode"] == "native":
        required |= {Path(settings["backend_data_dir"]), Path(settings["backend_config_file"])}
    inventory = []
    for source, relative in paths:
        if not source.exists():
            if source in required:
                raise UpdateError("A required backup source disappeared; no code updated.")
            continue
        source = source.absolute()
        if source == directory or source in directory.parents or directory in source.parents:
            raise UpdateError("Backup path overlaps the update backup directory.")
        print(f"Backing up: {relative}", flush=True)
        backup_tree(source, directory / "backup" / relative)
        inventory.append({"source": str(source), "backup": "backup/" + relative})
    for item in plan["components"]:
        # A Git bundle preserves the old and fetched code, independent of GitHub.
        git(
            Path(item["root"]),
            "bundle",
            "create",
            str(directory / f"{item['component']}.bundle"),
            "--all",
        )
    files = []
    for path in sorted(directory.rglob("*")):
        if path.is_file():
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            files.append(
                {
                    "path": path.relative_to(directory).as_posix(),
                    "size": path.stat().st_size,
                    "sha256": digest,
                }
            )
    save_json(directory / "backup-manifest.json", {"paths": inventory, "files": files})


def verify_backups(directory):
    manifests = list(directory.glob("snapshot-*/backup-manifest.json"))
    state = directory / "state.json"
    if (
        state.exists()
        and json.loads(state.read_text(encoding="utf-8")).get("stage") == "backed_up"
        and not manifests
    ):
        raise UpdateError("Saved update backup manifest is missing; inspect the update directory.")
    for manifest in manifests:
        value = json.loads(manifest.read_text(encoding="utf-8"))
        for entry in value["files"]:
            relative = Path(entry["path"])
            path = manifest.parent / relative
            if (
                relative.is_absolute()
                or ".." in relative.parts
                or is_link(path)
                or not path.is_file()
                or path.stat().st_size != entry["size"]
                or any(is_link(parent) for parent in path.parents)
            ):
                raise UpdateError(
                    "Update backup is missing or damaged. Preserve it for manual recovery."
                )
            with path.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != entry["sha256"]:
                    raise UpdateError("Update backup checksum mismatch; no further update applied.")


def installation_python(root):
    path = root / ".venv/Scripts/python.exe"
    if not path.is_file():
        raise UpdateError(
            "Existing Windows .venv is missing; complete the initial installation first."
        )
    return path


def finish_component(item, settings, log):
    root = Path(item["root"])
    python = installation_python(root)
    if item["dependencies"]:
        if item["component"] == "backend":
            uv = shutil.which("uv") or str(root / ".bootstrap/Scripts/uv.exe")
            if not Path(uv).is_file():
                raise UpdateError("Install uv before applying a native backend update.")
            command([uv, "sync", "--locked", "--python", python], cwd=root, log=log)
        else:
            command([python, "-m", "pip", "install", "-r", "requirements.txt"], cwd=root, log=log)
            if settings["qq_dependencies"]:
                command(
                    [python, "-m", "pip", "install", "-r", "requirements-qq-reader.txt"],
                    cwd=root,
                    log=log,
                )
    if item["java"]:
        env = {**os.environ, "LKA_UPDATE_FRONTEND_ROOT": str(root)}
        command(
            [
                "powershell.exe",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                (
                    "$ErrorActionPreference='Stop'; $root=$env:LKA_UPDATE_FRONTEND_ROOT; "
                    "& (Join-Path $root 'desktop-pet-java\\gradlew.bat') -p "
                    "(Join-Path $root 'desktop-pet-java') compileJava; exit $LASTEXITCODE"
                ),
            ],
            cwd=root,
            log=log,
            env=env,
        )
    command([python, "-c", "import fastapi, uvicorn"], cwd=root, log=log)
    for name in git(root, "ls-files", "app/*.py", "app/**/*.py").splitlines():
        ast.parse((root / name).read_bytes(), filename=name)


def apply_plan(root, plan, directory):
    log = directory / "update.log"
    # Recheck after fetch/backup; never stop the user's tasks for an update.
    process_blockers(root, plan["settings"])
    for item in plan["components"]:
        head = validate_checkout(Path(item["root"]), item["component"])
        if head not in {item["old"], item["target"]}:
            raise UpdateError(
                "Checkout changed since update planning. Preserve it before retrying."
            )
    # A user may have used the old installation after a failed attempt. Preserve
    # a fresh snapshot on every retry, without replacing the original backup.
    verify_backups(directory)
    attempt = directory / ("snapshot-" + uuid.uuid4().hex[:8])
    attempt.mkdir(mode=0o700)
    backup_installations(root, plan, attempt)
    plan["stage"] = "backed_up"
    save_json(directory / "state.json", plan)
    process_blockers(root, plan["settings"])
    for item in plan["components"]:
        print(f"Applying {item['component']} {item['target'][:12]}...", flush=True)
        path = Path(item["root"])
        head = validate_checkout(path, item["component"])
        if head not in {item["old"], item["target"]}:
            raise UpdateError("Checkout changed during update; no files reset.")
        git(path, "merge", "--ff-only", "--no-overwrite-ignore", item["target"], log=log)
        item["stage"] = "source_applied"
        save_json(directory / "state.json", plan)
        # Always rerun this on retry, including when Git already reached target.
        finish_component(item, plan["settings"], log)
        item["stage"] = "validated"
        save_json(directory / "state.json", plan)
    plan["stage"] = "complete"
    save_json(directory / "state.json", plan)
    print(
        "Update applied and dependency/syntax checks passed. Start LKA using your usual shortcut.",
        flush=True,
    )
    print(
        "Services were not restarted; verify the workbench and backend health after starting.",
        flush=True,
    )


def run(root, *, apply=False):
    root = root.resolve()
    settings = settings_for(root)
    updates = root / ".runtime/updates"
    with update_lock(root):
        # A pending release must finish before following a newer remote main.
        pending = []
        for path in updates.glob("*/state.json"):
            value = json.loads(path.read_text(encoding="utf-8"))
            if value.get("stage") != "complete":
                pending.append((path, value))
        if len(pending) > 1:
            raise UpdateError(
                "Multiple incomplete updates found; inspect .runtime/updates before proceeding."
            )
        if pending:
            path, plan = pending[0]
            if plan["settings"] != settings or plan["components"][-1]["root"] != str(root):
                raise UpdateError(
                    "Settings changed since an incomplete update. Restore the prior settings before retrying."
                )
            print(
                f"Incomplete update {plan['version']}; applying resumes its saved targets.",
                flush=True,
            )
            if apply:
                apply_plan(root, plan, path.parent)
            return plan
        plan = make_plan(root, settings, updates / "check.log")
        print(f"Release {plan['version']}", flush=True)
        for item in plan["components"]:
            status = "current" if item["old"] == item["target"] else "update available"
            print(
                f"{item['component']}: {item['old'][:12]} -> {item['target'][:12]} ({status})",
                flush=True,
            )
        if settings["backend_mode"] == "external":
            print(
                f"External WSL/cloud backend is managed separately; paired commit: {plan['backend_commit'][:12]}",
                flush=True,
            )
        if not apply or all(item["old"] == item["target"] for item in plan["components"]):
            return plan
        process_blockers(root, settings)
        for item in plan["components"]:
            installation_python(Path(item["root"]))
        directory = updates / (datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8])
        directory.mkdir(mode=0o700)
        save_json(directory / "state.json", plan)
        print(f"Backup and retry record: {directory}", flush=True)
        apply_plan(root, plan, directory)
        return plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply", action="store_true", help="Back up and apply; otherwise check only"
    )
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    try:
        run(args.root, apply=args.apply)
    except (UpdateError, OSError, ValueError, subprocess.TimeoutExpired):
        # Do not expose Git output, environment contents, or tracebacks with private data.
        error = sys.exception()
        message = str(error) if isinstance(error, UpdateError) else type(error).__name__
        print(
            f"Update stopped: {message}\nNo services were started or stopped. "
            "Keep .runtime/updates; retry the same entry to finish an interrupted update.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
