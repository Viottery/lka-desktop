"""Every workbench proxy route must exist on the backend.

tests/fixtures/backend_routes.json is the backend's OpenAPI route list. Refresh it
from lka_backend after adding backend routes, e.g.:

    python -c "import json;from app.api.main import create_app;s=create_app().openapi();\
print(json.dumps(sorted([{'method':m.upper(),'path':p} for p,o in s['paths'].items() for m in o \
if m in ('get','post','put','patch','delete')],key=lambda r:(r['path'],r['method'])),indent=1))"
"""

import json
import re
import unittest
from pathlib import Path

from app.api.routes.workbench_proxy import _ROUTES

ROUTES_FILE = Path(__file__).parent / "fixtures" / "backend_routes.json"
# Backend features the browser workbench is expected to reach. A backend route
# under one of these prefixes that the proxy does not forward fails the test
# unless it is listed in NOT_FORWARDED with a reason.
FORWARDED_PREFIXES = ("matters", "projects", "memories")
NOT_FORWARDED = {
    ("GET", "matters/search"): "agent tool path; the UI reads /matters/sync",
    ("POST", "matters/{matter_id}/source-links"): "message-sourced links go through review",
    ("POST", "projects/{project_id}/relocate"): "not exposed in the workbench",
    ("POST", "memories/maintenance"): "operator maintenance, not a workbench action",
    ("POST", "memories/merges/{merge_id}/undo"): "not exposed in the workbench",
}
# Served by FastAPI itself, so absent from the OpenAPI path list.
FRAMEWORK_ROUTES = {("GET", r"openapi\.json")}


def _sample(path_template: str) -> str:
    return re.sub(r"\{[^}]+\}", "id_1", path_template.lstrip("/"))


def _backend_routes() -> list[tuple[str, str]]:
    return [(row["method"], row["path"].lstrip("/")) for row in json.loads(ROUTES_FILE.read_text("utf-8"))]


class WorkbenchRouteSyncTest(unittest.TestCase):
    def test_every_proxy_route_exists_on_the_backend(self):
        backend = [(method, re.compile(re.sub(r"\{[^}]+\}", "[^/]+", path) + "$")) for method, path in _backend_routes()]
        missing = []
        for verb, pattern, _ in _ROUTES:
            if (verb, pattern) in FRAMEWORK_ROUTES:
                continue
            probe = re.sub(r"\[[^\]]*\]\{[^}]*\}|\[[^\]]*\]\+|\[[^\]]*\]\*", "id_1", pattern)
            # Take the first branch of each alternation; every branch is checked below.
            branches = re.findall(r"\(\?:([^)]*)\)", probe)
            for group in branches:
                probe = probe.replace(f"(?:{group})", group.split("|")[0], 1)
            probe = probe.replace("\\.", ".")
            if not any(method == verb and regex.match(probe) for method, regex in backend):
                missing.append(f"{verb} {pattern}")
        self.assertEqual(missing, [], "proxy forwards routes the backend does not have")

    def test_backend_features_used_by_the_workbench_are_forwarded(self):
        unforwarded = []
        for method, path in _backend_routes():
            if not path.startswith(FORWARDED_PREFIXES) or (method, path) in NOT_FORWARDED:
                continue
            sample = _sample(path)
            if not any(method == verb and re.fullmatch(pattern, sample) for verb, pattern, _ in _ROUTES):
                unforwarded.append(f"{method} {path}")
        self.assertEqual(unforwarded, [], "backend routes missing from the workbench proxy allowlist")


if __name__ == "__main__":
    unittest.main()
