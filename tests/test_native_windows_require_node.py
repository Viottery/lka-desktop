"""Source contract checks for opt-in native Windows replica startup."""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "run-lka-native-windows.ps1"


def test_require_node_is_opt_in_and_added_to_backend_command_only():
    source = SCRIPT.read_text(encoding="utf-8")
    assert re.search(r"\[switch\]\$RequireNode", source)
    assert "if ($RequireNode) { $backendArguments += '--require-node' }" in source
    assert "-Arguments $backendArguments -RequireNode:$RequireNode" in source
    assert "-Arguments $frontendArguments" in source
    assert "LKA_DATA_DIR = (Join-Path $BackendRoot 'data\\runtime')" in source
    assert "LKA_LOCAL_CONFIG = (Join-Path $BackendRoot 'config\\local.toml')" in source


def test_reuse_requires_exact_flag_in_actual_cim_process_command_line():
    source = SCRIPT.read_text(encoding="utf-8")
    assert 'Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"' in source
    assert "$tokens -contains $Argument" in source
    assert "-Argument '--require-node'" in source
    assert "It was left running; stop it yourself before starting this node." in source
    # The guard is before health/reuse and no process stop is present in its branch.
    guard = source.index("if ($RequireNode -and $Name -eq 'backend'")
    wait = source.index("Wait-Service $process $Url $Name $errLog", guard)
    assert guard < wait
    assert "taskkill.exe" not in source[guard:wait]
