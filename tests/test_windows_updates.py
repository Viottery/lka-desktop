"""Offline updater integration tests with disposable local Git repositories."""

import importlib.util
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "windows_updater", Path(__file__).resolve().parents[1] / "scripts/update_lka.py"
)
updater = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(updater)


def git(root, *args):
    return (
        subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.STDOUT)
        .decode()
        .strip()
    )


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="lka-update-test-")
        self.base = Path(self.temporary.name)
        self.front = self.base / "frontend"
        self.back = self.base / "backend"
        self.remotes = {}
        self.old = {}
        self.new = {}
        for name, root in (("backend", self.back), ("frontend", self.front)):
            root.mkdir()
            git(root, "init", "-b", "main")
            git(root, "config", "user.name", "Updater test")
            git(root, "config", "user.email", "test@example.invalid")
            (root / ".gitignore").write_text(
                ".runtime/\n.venv/\n.env\ndata/private/\nconfig/local.toml\n"
            )
            (root / "app").mkdir()
            (root / "app/probe.py").write_text("VERSION = 1\n")
            (root / "requirements.txt").write_text("# dependencies\n")
            if name == "frontend":
                (root / "release-channel.json").write_text(
                    json.dumps(
                        {"format": 1, "version": "0.1.0", "backend_commit": self.new["backend"]}
                    )
                )
            git(root, "add", ".")
            git(root, "commit", "-m", "initial")
            self.old[name] = git(root, "rev-parse", "HEAD")
            (root / "app/probe.py").write_text("VERSION = 2\n")
            git(root, "add", ".")
            git(root, "commit", "-m", "release")
            self.new[name] = git(root, "rev-parse", "HEAD")
            remote = self.base / f"{name}.git"
            subprocess.check_output(
                ["git", "clone", "--bare", str(root), str(remote)], stderr=subprocess.STDOUT
            )
            self.remotes[root.resolve()] = remote
            # A disposable branch switch creates the installed older checkout.
            git(root, "switch", "-c", "installed", self.old[name])
            git(root, "branch", "-D", "main")
            git(root, "branch", "-m", "main")
            git(
                root,
                "remote",
                "add",
                "origin",
                "https://github.com/" + updater.REPOSITORIES[name] + ".git",
            )
            (root / ".venv/Scripts").mkdir(parents=True)
            (root / ".venv/Scripts/python.exe").write_bytes(b"placeholder")
        (self.front / ".env").write_text("PRIVATE_TEST=preserve-me\n")
        self.data = self.front / "data/private"
        self.data.mkdir(parents=True)
        with closing(sqlite3.connect(self.data / "sessions.db")) as connection, connection:
            connection.execute("CREATE TABLE sessions (content TEXT)")
            connection.execute("INSERT INTO sessions VALUES ('keep my history')")
        self.settings = {
            "backend_mode": "external",
            "frontend_ports": [],
            "backend_ports": [],
            "backup_paths": [],
            "qq_dependencies": False,
        }
        self.write_settings()
        self.real_git = updater.git

        def offline_git(root, *args, **kwargs):
            if args[0] == "fetch":
                args = ("fetch", "--no-tags", str(self.remotes[Path(root).resolve()]), args[-1])
            return self.real_git(root, *args, **kwargs)

        self.fetch_patch = patch.object(updater, "git", side_effect=offline_git)
        self.fetch_patch.start()
        self.addCleanup(self.fetch_patch.stop)
        self.addCleanup(self.temporary.cleanup)

    def write_settings(self):
        path = self.front / ".runtime/update-settings.json"
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(self.settings))

    def configure_native(self):
        data = self.back / "data/private"
        data.mkdir(parents=True)
        with closing(sqlite3.connect(data / "lka.sqlite3")) as connection, connection:
            connection.execute("CREATE TABLE memory (value TEXT)")
            connection.execute("INSERT INTO memory VALUES ('existing memory')")
        config = self.back / "config/local.toml"
        config.parent.mkdir()
        config.write_text("# existing private config\n")
        self.settings.update(
            backend_mode="native",
            backend_root=str(self.back),
            backend_data_dir=str(data),
            backend_config_file=str(config),
        )
        self.write_settings()

    def test_check_fetches_pair_without_changing_code_or_private_data(self):
        with patch.object(updater, "process_blockers") as blockers:
            result = updater.run(self.front)
        blockers.assert_not_called()
        self.assertEqual(result["components"][0]["target"], self.new["frontend"])
        self.assertEqual(git(self.front, "rev-parse", "HEAD"), self.old["frontend"])
        self.assertEqual((self.front / ".env").read_text(), "PRIVATE_TEST=preserve-me\n")
        self.assertFalse(list((self.front / ".runtime/updates").glob("*/state.json")))

    def test_apply_updates_pair_and_preserves_configs_databases_and_credentials(self):
        self.configure_native()
        credential = self.front / ".runtime/cloud/session.dpapi"
        credential.parent.mkdir()
        credential.write_bytes(b"existing-paired-credential")
        with (
            patch.object(updater, "process_blockers"),
            patch.object(updater, "finish_component") as finish,
        ):
            plan = updater.run(self.front, apply=True)
        self.assertEqual(plan["stage"], "complete")
        self.assertEqual(finish.call_count, 2)
        self.assertEqual(git(self.front, "rev-parse", "HEAD"), self.new["frontend"])
        self.assertEqual(git(self.back, "rev-parse", "HEAD"), self.new["backend"])
        self.assertEqual(credential.read_bytes(), b"existing-paired-credential")
        state = next((self.front / ".runtime/updates").glob("*/state.json"))
        snapshot = next(state.parent.glob("snapshot-*"))
        with closing(sqlite3.connect(snapshot / "backup/backend/data/lka.sqlite3")) as connection:
            self.assertEqual(
                connection.execute("SELECT value FROM memory").fetchone()[0], "existing memory"
            )
        self.assertTrue((snapshot / "backend.bundle").is_file())
        self.assertTrue((snapshot / "backup-manifest.json").is_file())
        self.assertEqual(
            (snapshot / "backup/frontend/.env").read_text(), (self.front / ".env").read_text()
        )
        self.assertFalse(git(self.front, "status", "--porcelain"))

    def test_dirty_or_untrusted_checkout_is_not_updated(self):
        (self.front / "app/probe.py").write_text("USER_EDIT = True\n")
        with self.assertRaisesRegex(updater.UpdateError, "uncommitted"):
            updater.run(self.front, apply=True)
        self.assertEqual(git(self.front, "rev-parse", "HEAD"), self.old["frontend"])
        git(self.front, "add", "app/probe.py")
        git(self.front, "commit", "-m", "user work")
        git(self.front, "remote", "set-url", "origin", "https://example.invalid/untrusted.git")
        with self.assertRaisesRegex(updater.UpdateError, "official"):
            updater.run(self.front, apply=True)

    def test_real_python_import_and_syntax_validation_after_fast_forward(self):
        with (
            patch.object(updater, "process_blockers"),
            patch.object(updater, "installation_python", return_value=Path(sys.executable)),
        ):
            result = updater.run(self.front, apply=True)
        self.assertEqual(result["stage"], "complete")
        self.assertEqual(result["components"][0]["stage"], "validated")

    def test_local_commits_and_divergence_are_not_discarded(self):
        (self.front / "own.txt").write_text("user work")
        git(self.front, "add", "own.txt")
        git(self.front, "commit", "-m", "local work")
        head = git(self.front, "rev-parse", "HEAD")
        with self.assertRaises(updater.UpdateError):
            updater.run(self.front, apply=True)
        self.assertEqual(git(self.front, "rev-parse", "HEAD"), head)

    def test_running_service_blocks_before_backup_or_code_changes(self):
        with patch.object(
            updater, "process_blockers", side_effect=updater.UpdateError("running service")
        ):
            with self.assertRaisesRegex(updater.UpdateError, "running service"):
                updater.run(self.front, apply=True)
        self.assertEqual(git(self.front, "rev-parse", "HEAD"), self.old["frontend"])
        self.assertFalse(list((self.front / ".runtime/updates").glob("*/state.json")))

    def test_failed_dependency_sync_resumes_saved_pair_even_if_remote_moves(self):
        with (
            patch.object(updater, "process_blockers"),
            patch.object(
                updater,
                "finish_component",
                side_effect=updater.UpdateError("simulated dependency failure"),
            ),
        ):
            with self.assertRaisesRegex(updater.UpdateError, "dependency failure"):
                updater.run(self.front, apply=True)
        state = next((self.front / ".runtime/updates").glob("*/state.json"))
        self.assertEqual(json.loads(state.read_text())["stage"], "backed_up")
        self.assertEqual((self.front / ".env").read_text(), "PRIVATE_TEST=preserve-me\n")
        # The retry must not fetch a different release or treat updated HEAD as success.
        with (
            patch.object(
                updater, "make_plan", side_effect=AssertionError("must use saved release")
            ),
            patch.object(updater, "process_blockers"),
            patch.object(updater, "finish_component") as finish,
        ):
            result = updater.run(self.front, apply=True)
        self.assertEqual(result["stage"], "complete")
        finish.assert_called_once()
        self.assertEqual(len(list(state.parent.glob("snapshot-*"))), 2)

    def test_settings_change_during_pending_update_is_rejected(self):
        with (
            patch.object(updater, "process_blockers"),
            patch.object(updater, "finish_component", side_effect=updater.UpdateError("failure")),
            self.assertRaises(updater.UpdateError),
        ):
            updater.run(self.front, apply=True)
        self.settings["frontend_ports"] = [19001]
        self.write_settings()
        with self.assertRaisesRegex(updater.UpdateError, "Settings changed"):
            updater.run(self.front, apply=True)

    def test_sqlite_backup_captures_wal_and_does_not_copy_stale_sidecars(self):
        database = self.base / "wal.db"
        connection = sqlite3.connect(database)
        self.addCleanup(connection.close)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE entries (value TEXT)")
        connection.execute("INSERT INTO entries VALUES ('in the WAL')")
        connection.commit()
        target = self.base / "snapshot/database.db"
        updater.backup_tree(database, target)
        with closing(sqlite3.connect(target)) as snapshot:
            self.assertEqual(
                snapshot.execute("SELECT value FROM entries").fetchone(), ("in the WAL",)
            )

    def test_git_refuses_overwriting_ignored_private_file(self):
        # Target has a newly tracked file colliding with an ignored local file.
        # --no-overwrite-ignore must reject it, even for nonstandard private names.
        path = self.front / "data/private/local.txt"
        path.write_text("preserve local content")
        git(self.front, "add", "-f", str(path))
        git(self.front, "commit", "-m", "target adds ignored-path file")
        target = git(self.front, "rev-parse", "HEAD")
        # Recreate older branch without changing the ignored local file's contents.
        git(self.front, "switch", "-c", "old-install", self.old["frontend"])
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("preserve local content")
        with self.assertRaises(updater.UpdateError):
            updater.git(self.front, "merge", "--ff-only", "--no-overwrite-ignore", target)
        self.assertEqual(path.read_text(), "preserve local content")

    def test_bad_settings_and_manifest_fail_closed(self):
        self.settings["unexpected"] = "bad"
        self.write_settings()
        with self.assertRaisesRegex(updater.UpdateError, "Unknown"):
            updater.settings_for(self.front)
        with patch.object(
            updater, "git", return_value='{"format":1,"version":"bad","backend_commit":"main"}'
        ):
            with self.assertRaisesRegex(updater.UpdateError, "Invalid release"):
                updater.release_manifest(self.front, "ignored")

    def test_invalid_backend_paths_and_backup_recursion_are_rejected(self):
        self.configure_native()
        self.settings["backend_data_dir"] = str(self.base / "missing")
        self.write_settings()
        with self.assertRaisesRegex(updater.UpdateError, "absolute and exist"):
            updater.settings_for(self.front)
        directory = self.front / ".runtime/updates/attempt"
        directory.mkdir(parents=True)
        plan = {
            "settings": {
                **self.settings,
                "backend_mode": "external",
                "backup_paths": [str(self.front)],
            },
            "components": [],
        }
        with self.assertRaisesRegex(updater.UpdateError, "overlaps"):
            updater.backup_installations(self.front, plan, directory)

    def test_damaged_backup_blocks_retry_without_overwriting_snapshot(self):
        with (
            patch.object(updater, "process_blockers"),
            patch.object(updater, "finish_component", side_effect=updater.UpdateError("failure")),
            self.assertRaises(updater.UpdateError),
        ):
            updater.run(self.front, apply=True)
        state = next((self.front / ".runtime/updates").glob("*/state.json"))
        snapshot = next(state.parent.glob("snapshot-*"))
        (snapshot / "backup/frontend/.env").write_text("tampered")
        with (
            patch.object(updater, "process_blockers"),
            self.assertRaisesRegex(updater.UpdateError, "damaged"),
        ):
            updater.run(self.front, apply=True)
        self.assertEqual(len(list(state.parent.glob("snapshot-*"))), 1)

    def test_release_cannot_track_private_config(self):
        (self.front / ".env").write_text("PRIVATE_TEST=keep\n")
        git(self.front, "add", "-f", ".env")
        git(self.front, "commit", "-m", "invalid private release")
        with self.assertRaisesRegex(updater.UpdateError, "private/runtime"):
            updater.plan_component(
                self.front, "frontend", git(self.front, "rev-parse", "HEAD"), self.old["frontend"]
            )

    def test_only_one_updater_can_hold_lock_and_lock_releases(self):
        with updater.update_lock(self.front):
            with self.assertRaisesRegex(updater.UpdateError, "Another update"):
                with updater.update_lock(self.front):
                    self.fail("lock was acquired twice")
        with updater.update_lock(self.front):
            pass

    @unittest.skipUnless(os.name == "nt", "native Windows process inventory")
    def test_native_process_and_port_preflight(self):
        # The updater excludes its own process/ancestors, without stopping anything.
        updater.process_blockers(self.front, self.settings)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            self.settings["frontend_ports"] = [listener.getsockname()[1]]
            with self.assertRaisesRegex(updater.UpdateError, "listening port"):
                updater.process_blockers(self.front, self.settings)
        self.settings["frontend_ports"] = []
        root = self.base / "前端 工作区"
        root.mkdir()
        child = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)", str(root / "app/probe.py")]
        )
        try:
            with self.assertRaisesRegex(updater.UpdateError, f"process {child.pid}"):
                updater.process_blockers(root, self.settings)
        finally:
            child.terminate()
            child.wait(timeout=10)


if __name__ == "__main__":
    unittest.main()
