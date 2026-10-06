from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import re
import shlex
import threading
import time
from uuid import uuid4

from app.core.config import get_settings
from app.runtime.platform import default_desktop_directory, default_workspace_root, is_windows
from app.runtime.process_runner import arun_process, run_process
from app.runtime.shell_providers import resolve_shell_provider


_READ_ONLY_PREFIXES = (
    "pwd",
    "ls",
    "find",
    "rg",
    "grep",
    "cat",
    "sed",
    "head",
    "tail",
    "wc",
    "stat",
    "git status",
    "git diff",
    "git show",
    "get-location",
    "get-childitem",
    "get-content",
    "select-string",
    "python -m pytest",
    "pytest",
)

_WRITE_COMMAND_PATTERNS = (
    r"(^|[\s;&|])(touch|mkdir|cp|mv|tee|chmod|chown|truncate)\b",
    r"(^|[\s;&|])(new-item|set-content|add-content|copy-item|move-item|rename-item|out-file)\b",
    r"(^|[\s;&|])sed\s+[^;&|]*\s-i(\s|$)",
    r"(^|[\s;&|])python(3)?\b.*\b(open|write_text|write_bytes|mkdir|touch|rename|replace)\s*\(",
    r"(^|[\s;&|])python(3)?\b.*\b(shutil\.copy|shutil\.move|Path\s*\()",
    r"(^|[\s;&|])(npm|pip|uv|poetry|cargo|go|make)\s+",
    r"(^|[\s;&|])git\s+(add|commit|merge|rebase|pull|push|checkout|switch|branch|reset|clean|restore)\b",
)

_DESTRUCTIVE_PATTERNS = (
    r"(^|[\s;&|])rm(\s|$)",
    r"(^|[\s;&|])rmdir(\s|$)",
    r"(^|[\s;&|])shred(\s|$)",
    r"(^|[\s;&|])(remove-item|del|erase|rd|ri)\b",
    r"(^|[\s;&|])git\s+(reset|clean|restore)\b",
)

_DANGEROUS_PATTERNS = (
    r"(^|[\s;&|])sudo(\s|$)",
    r"(^|[\s;&|])start-process\b.*-verb\s+runas\b",
    r"rm\s+-rf\s+/",
    r"mkfs(\.| )",
    r"(^|[\s;&|])(shutdown|reboot|halt|poweroff)(\s|$)",
    r"(^|[\s;&|])(restart-computer|stop-computer|format-volume|clear-disk)(\s|$)",
    r"dd\s+if=",
    r"(:\(\)\s*\{\s*:\|\:&\s*\};:)",
    r"curl\b[^|]*\|\s*(sh|bash)",
    r"wget\b[^|]*\|\s*(sh|bash)",
    r">\s*/dev/sd[a-z]",
    r"chmod\s+-R\s+777\s+/",
    r"chown\s+-R\s+/\b",
    r"(^|[\s;&|])(ssh|scp|rsync)\s+",
)

_REDIRECTION_PATTERN = re.compile(r"(?<![<>])(?:>>?|[12]>>?|&>)\s*([^\s;&|]+)")
_QUOTED_PATH_PATTERN = re.compile(
    r"(?P<quote>['\"])(?P<path>[A-Za-z]:[\\/][^'\"]+|\\\\[^'\"]+|\.\.?[\\/][^'\"]+|[A-Za-z0-9_.-]+[\\/][^'\"]+)(?P=quote)"
)
_PYTHON_PATH_ARG_PATTERN = re.compile(
    r"\b(?:Path|open)\s*\(\s*(?P<quote>['\"])(?P<path>[^'\"]+)(?P=quote)"
)
_POWERSHELL_PATH_ARG_PATTERN = re.compile(
    r"\b(?:"
    r"ReadAllText|WriteAllText|AppendAllText|ReadAllLines|WriteAllLines|"
    r"FileInfo\]::new|DirectoryInfo\]::new"
    r")\s*\(\s*(?P<quote>['\"])(?P<path>[^'\"]+)(?P=quote)",
    flags=re.IGNORECASE,
)
_COMMANDS_WITH_BARE_PATH_ARGS = {
    "rm",
    "rmdir",
    "shred",
    "remove-item",
    "del",
    "erase",
    "rd",
    "ri",
    "touch",
    "mkdir",
    "cp",
    "mv",
    "tee",
    "truncate",
    "new-item",
    "set-content",
    "add-content",
    "copy-item",
    "move-item",
    "rename-item",
    "out-file",
    "get-content",
}
_COMMAND_POSITIONAL_PATH_LIMITS = {
    "set-content": 1,
    "add-content": 1,
    "out-file": 1,
    "new-item": 1,
    "copy-item": 2,
    "move-item": 2,
    "rename-item": 2,
    "cp": 2,
    "mv": 2,
    "tee": 1,
    "touch": 1,
    "mkdir": 1,
    "truncate": 1,
}
_WRITE_PATH_PARAMETER_NAMES = {
    "-path",
    "-literalpath",
    "-filepath",
    "-destination",
    "-destinationpath",
    "-targetpath",
}
_WRITE_DEST_POSITION = {
    "set-content": [1],
    "add-content": [1],
    "out-file": [1],
    "new-item": [1],
    "copy-item": [2],
    "move-item": [2],
    "rename-item": [2],
    "cp": [2],
    "mv": [2],
    "tee": [1],
    "touch": [1],
    "mkdir": [1],
    "truncate": [1],
}
_PATH_PARAMETER_NAMES = {
    "-path",
    "-literalpath",
    "-filepath",
    "-destination",
    "-targetpath",
    "-destinationpath",
    "-source",
}
_NON_PATH_PARAMETER_NAMES_WITH_VALUE = {
    "-encoding",
    "-filter",
    "-itemtype",
    "-type",
    "-value",
}


@dataclass(frozen=True)
class ShellPolicyDecision:
    allowed: bool
    reason: str
    risk_level: str
    workspace_root: str
    write_detected: bool
    touched_paths: list[str]
    violations: list[str]


@dataclass(frozen=True)
class ShellApprovalRequest:
    approval_id: str
    command: str
    cwd: str
    risk_level: str
    reason: str
    touched_paths: list[str]
    policy_violations: list[str]
    conversation_id: str
    created_at_ts: float
    expires_at_ts: float


@dataclass
class ShellExecutionResult:
    allowed: bool
    command: str
    cwd: str
    exit_code: int
    stdout: str
    stderr: str
    duration_seconds: float
    risk_level: str
    policy_reason: str
    truncated: bool
    workspace_root: str = ""
    write_detected: bool = False
    touched_paths: list[str] | None = None
    policy_violations: list[str] | None = None
    approval_required: bool = False
    approval_id: str = ""
    approval_expires_at_ts: float = 0.0


_APPROVAL_LOCK = threading.Lock()
_PENDING_APPROVALS: dict[str, ShellApprovalRequest] = {}


def _normalize_command(command: str) -> str:
    return re.sub(r"\s+", " ", command).strip()


def _split_csv_paths(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _safe_conversation_id(conversation_id: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", (conversation_id or "").strip())
    return cleaned[:64].strip("._-") or "default"


def resolve_conversation_workspace_root(conversation_id: str) -> Path:
    settings = get_settings()
    configured_base = (settings.shell_conversation_workspace_base or "").strip()
    if configured_base:
        base_dir = Path(configured_base).expanduser().resolve()
    else:
        base_dir = default_desktop_directory()
    parent_name = (settings.shell_conversation_workspace_parent or "").strip() or "agentic-rag-workspaces"
    safe_id = _safe_conversation_id(conversation_id)
    workspace_root = (base_dir / parent_name / safe_id).resolve()
    workspace_root.mkdir(parents=True, exist_ok=True)
    return workspace_root


def _resolve_workspace_root(conversation_id: str | None = None) -> Path:
    if (conversation_id or "").strip():
        return resolve_conversation_workspace_root(str(conversation_id))
    settings = get_settings()
    return default_workspace_root(settings.shell_workspace_root)


def _allowed_roots(workspace_root: Path) -> list[Path]:
    settings = get_settings()
    roots = [workspace_root]
    for item in _split_csv_paths(settings.shell_allowed_extra_roots):
        roots.append(Path(item).expanduser().resolve())
    return roots


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _is_within_any_root(path: Path, roots: list[Path]) -> bool:
    return any(_is_relative_to(path, root) for root in roots)


def _protected_paths(workspace_root: Path) -> list[Path]:
    settings = get_settings()
    protected: list[Path] = []
    for item in _split_csv_paths(settings.shell_protected_paths):
        raw = Path(item).expanduser()
        protected.append((raw if raw.is_absolute() else workspace_root / raw).resolve())
    return protected


def _is_protected_path(path: Path, protected: list[Path]) -> bool:
    return any(path == item or _is_relative_to(path, item) for item in protected)


def _looks_like_path(token: str) -> bool:
    if not token or token.startswith("-"):
        return False
    return (
        token.startswith("/")
        or token.startswith(".")
        or token.startswith("./")
        or token.startswith("../")
        or token.startswith("\\\\")
        or re.match(r"^[A-Za-z]:[\\/]", token) is not None
        or "/" in token
        or "\\" in token
    )


def _clean_path_token(token: str) -> str:
    return token.strip().strip("'\"").rstrip(",;)")


def _resolve_command_path(token: str, *, cwd: Path, force: bool = False) -> Path | None:
    cleaned = _clean_path_token(token)
    if not force and not _looks_like_path(cleaned):
        return None
    if cleaned.startswith(("http://", "https://")):
        return None
    path = Path(cleaned).expanduser()
    return (path if path.is_absolute() else cwd / path).resolve()


def _split_command_tokens(command: str) -> list[str]:
    try:
        return shlex.split(command, posix=not is_windows())
    except ValueError:
        return command.split()


def _split_command_segments(command: str) -> list[str]:
    segments: list[str] = []
    current: list[str] = []
    quote: str | None = None
    escaped = False

    for char in command:
        if escaped:
            current.append(char)
            escaped = False
            continue
        if char == "`":
            current.append(char)
            escaped = True
            continue
        if quote:
            current.append(char)
            if char == quote:
                quote = None
            continue
        if char in {"'", '"'}:
            current.append(char)
            quote = char
            continue
        if char in {";", "&", "|"}:
            segment = "".join(current).strip()
            if segment:
                segments.append(segment)
            current = []
            continue
        current.append(char)

    segment = "".join(current).strip()
    if segment:
        segments.append(segment)
    return segments


def _extract_path_references(command: str, *, cwd: Path) -> list[Path]:
    candidates: list[str] = []

    candidates.extend(match.group("path") for match in _QUOTED_PATH_PATTERN.finditer(command))
    resolved: list[Path] = []
    seen: set[str] = set()
    for token in candidates:
        path = _resolve_command_path(token, cwd=cwd)
        if path is None:
            continue
        key = str(path)
        if key not in seen:
            seen.add(key)
            resolved.append(path)
    for match in _PYTHON_PATH_ARG_PATTERN.finditer(command):
        path = _resolve_command_path(match.group("path"), cwd=cwd, force=True)
        if path is None:
            continue
        key = str(path)
        if key not in seen:
            seen.add(key)
            resolved.append(path)
    for match in _POWERSHELL_PATH_ARG_PATTERN.finditer(command):
        path = _resolve_command_path(match.group("path"), cwd=cwd, force=True)
        if path is None:
            continue
        key = str(path)
        if key not in seen:
            seen.add(key)
            resolved.append(path)
    for path in _bare_path_args(command, cwd=cwd):
        key = str(path)
        if key not in seen:
            seen.add(key)
            resolved.append(path)
    for path in _redirection_targets(command, cwd=cwd):
        key = str(path)
        if key not in seen:
            seen.add(key)
            resolved.append(path)
    return resolved


def _bare_path_args(command: str, *, cwd: Path) -> list[Path]:
    paths: list[Path] = []
    for segment in _split_command_segments(command):
        tokens = _split_command_tokens(segment)
        if not tokens:
            continue
        command_name = Path(tokens[0]).name.lower()
        if command_name not in _COMMANDS_WITH_BARE_PATH_ARGS:
            continue

        positional_count = 0
        positional_limit = _COMMAND_POSITIONAL_PATH_LIMITS.get(command_name)
        expect_path_arg = False
        expect_non_path_arg = False
        for token in tokens[1:]:
            if not token:
                continue
            if expect_non_path_arg:
                expect_non_path_arg = False
                continue
            lowered = token.lower()
            if lowered in _PATH_PARAMETER_NAMES:
                expect_path_arg = True
                continue
            if lowered in _NON_PATH_PARAMETER_NAMES_WITH_VALUE:
                expect_non_path_arg = True
                continue
            if token.startswith("-"):
                expect_path_arg = False
                continue
            if expect_path_arg:
                path = _resolve_command_path(token, cwd=cwd, force=True)
                expect_path_arg = False
                positional_count += 1
            elif positional_limit is None or positional_count < positional_limit:
                path = _resolve_command_path(token, cwd=cwd, force=True)
                positional_count += 1
            else:
                path = _resolve_command_path(token, cwd=cwd)
            if path is not None:
                paths.append(path)
    return paths


def _redirection_targets(command: str, *, cwd: Path) -> list[Path]:
    targets: list[Path] = []
    for match in _REDIRECTION_PATTERN.finditer(command):
        path = _resolve_command_path(match.group(1), cwd=cwd, force=True)
        if path is not None:
            targets.append(path)
    return targets


def _extract_write_path_references(command: str, *, cwd: Path) -> list[Path]:
    write_paths: list[Path] = []
    seen: set[str] = set()

    def add_path(path: Path | None) -> None:
        if path is None:
            return
        key = str(path)
        if key in seen:
            return
        seen.add(key)
        write_paths.append(path)

    for path in _redirection_targets(command, cwd=cwd):
        add_path(path)

    for segment in _split_command_segments(command):
        tokens = _split_command_tokens(segment)
        if not tokens:
            continue
        command_name = Path(tokens[0]).name.lower()

        expect_write_path = False
        positional_index = 0
        destination_positions = set(_WRITE_DEST_POSITION.get(command_name, []))
        for token in tokens[1:]:
            if not token:
                continue
            lowered = token.lower()
            if expect_write_path:
                add_path(_resolve_command_path(token, cwd=cwd, force=True))
                expect_write_path = False
                continue
            if lowered in _WRITE_PATH_PARAMETER_NAMES:
                expect_write_path = True
                continue
            if lowered in _NON_PATH_PARAMETER_NAMES_WITH_VALUE:
                expect_write_path = False
                continue
            if token.startswith("-"):
                continue
            positional_index += 1
            if positional_index in destination_positions:
                add_path(_resolve_command_path(token, cwd=cwd, force=True))
                continue

    return write_paths


def _has_write_intent(command: str) -> bool:
    normalized = _normalize_command(command)
    if _REDIRECTION_PATTERN.search(normalized):
        return True
    if _has_destructive_intent(normalized):
        return True
    return any(re.search(pattern, normalized, flags=re.IGNORECASE) for pattern in _WRITE_COMMAND_PATTERNS)


def _has_destructive_intent(command: str) -> bool:
    normalized = _normalize_command(command)
    return any(re.search(pattern, normalized, flags=re.IGNORECASE) for pattern in _DESTRUCTIVE_PATTERNS)


def _classify_risk(command: str, *, write_detected: bool, destructive_detected: bool) -> str:
    normalized = _normalize_command(command).lower()
    if destructive_detected:
        return "high"
    if write_detected:
        return "medium"
    if any(normalized.startswith(prefix) for prefix in _READ_ONLY_PREFIXES):
        return "low"
    return "medium"


def _policy_decision(
    command: str,
    *,
    cwd: str | None = None,
    conversation_id: str | None = None,
    approved: bool = False,
) -> ShellPolicyDecision:
    settings = get_settings()
    workspace_root = _resolve_workspace_root(conversation_id)
    resolved_cwd = Path(cwd or workspace_root).resolve()
    touched_paths: list[Path] = []
    violations: list[str] = []

    def decision(allowed: bool, reason: str, risk_level: str = "blocked") -> ShellPolicyDecision:
        return ShellPolicyDecision(
            allowed=allowed,
            reason=reason,
            risk_level=risk_level,
            workspace_root=str(workspace_root),
            write_detected=_has_write_intent(command),
            touched_paths=[str(path) for path in touched_paths],
            violations=violations.copy(),
        )

    if not settings.shell_runtime_enabled:
        violations.append("runtime_disabled")
        return decision(False, "shell runtime is disabled by configuration.")

    normalized = _normalize_command(command)
    if not normalized:
        violations.append("empty_command")
        return decision(False, "empty shell command.")

    for pattern in _DANGEROUS_PATTERNS:
        if re.search(pattern, normalized, flags=re.IGNORECASE):
            violations.append("dangerous_pattern")
            return decision(False, "shell command blocked by dangerous-pattern policy.")

    allowed_roots = _allowed_roots(workspace_root)
    protected_paths = _protected_paths(workspace_root)
    if not _is_within_any_root(resolved_cwd, allowed_roots):
        touched_paths.append(resolved_cwd)
        violations.append("cwd_outside_workspace")
        return decision(False, "shell cwd is outside the configured workspace roots.")

    touched_paths = _extract_path_references(normalized, cwd=resolved_cwd)
    write_detected = _has_write_intent(normalized)
    if write_detected:
        write_targets = _extract_write_path_references(normalized, cwd=resolved_cwd)
        outside_write_targets = [path for path in write_targets if not _is_within_any_root(path, allowed_roots)]
        if outside_write_targets:
            violations.append("write_path_outside_workspace")
            return decision(False, "shell command writes outside the configured workspace roots.")

        protected_writes = [path for path in write_targets if _is_protected_path(path, protected_paths)]
        if protected_writes:
            violations.append("protected_write")
            return decision(False, "shell command writes to protected workspace paths.")

    destructive_detected = _has_destructive_intent(normalized)
    risk_level = _classify_risk(
        normalized,
        write_detected=write_detected,
        destructive_detected=destructive_detected,
    )
    policy_mode = settings.shell_policy_mode.strip().lower() or "workspace-write"
    if policy_mode == "disabled":
        violations.append("policy_disabled")
        return decision(False, "shell runtime policy mode is disabled.")
    if policy_mode == "read-only" and (write_detected or risk_level != "low"):
        violations.append("write_requires_workspace_policy")
        return decision(False, "shell command requires write-capable policy mode.", risk_level)
    if destructive_detected and not approved and not settings.shell_allow_destructive_commands:
        violations.append("destructive_command")
        approval_mode = settings.shell_approval_mode.strip().lower() or "high-risk"
        if approval_mode in {"high-risk", "write", "all"}:
            violations.append("approval_required")
            return decision(False, "approval required for destructive workspace command.", risk_level)
        return decision(False, "destructive shell commands are disabled by policy.", risk_level)
    if approved and destructive_detected:
        return decision(True, "allowed by approval", risk_level)
    return decision(True, "allowed", risk_level)


def _prune_expired_approvals(now: float | None = None) -> None:
    current = time.time() if now is None else now
    expired = [
        approval_id
        for approval_id, request in _PENDING_APPROVALS.items()
        if request.expires_at_ts <= current
    ]
    for approval_id in expired:
        _PENDING_APPROVALS.pop(approval_id, None)


def _create_approval_request(
    *,
    command: str,
    cwd: str,
    policy: ShellPolicyDecision,
    conversation_id: str | None = None,
    reason_override: str | None = None,
) -> ShellApprovalRequest:
    settings = get_settings()
    now = time.time()
    request = ShellApprovalRequest(
        approval_id=f"shell_approval_{uuid4().hex}",
        command=_normalize_command(command),
        cwd=cwd,
        risk_level=policy.risk_level,
        reason=(reason_override or policy.reason).strip() or policy.reason,
        touched_paths=policy.touched_paths,
        policy_violations=policy.violations,
        conversation_id=(conversation_id or "").strip(),
        created_at_ts=now,
        expires_at_ts=now + max(1, settings.shell_approval_ttl_seconds),
    )
    with _APPROVAL_LOCK:
        _prune_expired_approvals(now)
        _PENDING_APPROVALS[request.approval_id] = request
    return request


def list_pending_shell_approvals() -> list[dict[str, object]]:
    with _APPROVAL_LOCK:
        _prune_expired_approvals()
        return [asdict(item) for item in _PENDING_APPROVALS.values()]


def create_shell_approval_request(
    command: str,
    *,
    cwd: str | None = None,
    conversation_id: str | None = None,
    reason: str = "user confirmation required before execution.",
) -> dict[str, object] | None:
    """
    Create an explicit user-confirmation approval ticket for a shell command.
    Returns None when the command is blocked by policy and cannot be proposed.
    """
    policy = _policy_decision(command, cwd=cwd, conversation_id=conversation_id, approved=False)
    resolved_cwd = str(Path(cwd or policy.workspace_root).resolve())
    if not policy.allowed:
        return None
    request = _create_approval_request(
        command=command,
        cwd=resolved_cwd,
        policy=policy,
        conversation_id=conversation_id,
        reason_override=reason,
    )
    return asdict(request)


def preview_shell_policy(
    command: str,
    *,
    cwd: str | None = None,
    conversation_id: str | None = None,
) -> ShellPolicyDecision:
    """
    Perform policy pre-check without executing the command.
    This is intended for agent-side safety orchestration:
    rules first, then model review, then execution.
    """
    return _policy_decision(command, cwd=cwd, conversation_id=conversation_id, approved=False)


def get_pending_shell_approval(approval_id: str) -> dict[str, object] | None:
    with _APPROVAL_LOCK:
        _prune_expired_approvals()
        item = _PENDING_APPROVALS.get(approval_id)
        return asdict(item) if item is not None else None


def reject_shell_approval(approval_id: str) -> bool:
    with _APPROVAL_LOCK:
        _prune_expired_approvals()
        return _PENDING_APPROVALS.pop(approval_id, None) is not None


def _consume_shell_approval(approval_id: str, *, command: str, cwd: str) -> ShellApprovalRequest | None:
    with _APPROVAL_LOCK:
        _prune_expired_approvals()
        request = _PENDING_APPROVALS.get(approval_id)
        if request is None:
            return None
        if request.command != _normalize_command(command) or Path(request.cwd).resolve() != Path(cwd).resolve():
            return None
        return _PENDING_APPROVALS.pop(approval_id)


def _truncate_output(text: str) -> tuple[str, bool]:
    settings = get_settings()
    cleaned = text.strip()
    if len(cleaned) <= settings.shell_max_output_chars:
        return cleaned, False
    limit = max(0, settings.shell_max_output_chars - 1)
    return cleaned[:limit].rstrip() + "…", True


def run_shell_command(
    command: str,
    *,
    cwd: str | None = None,
    conversation_id: str | None = None,
    approval_id: str | None = None,
) -> ShellExecutionResult:
    settings = get_settings()
    initial_policy = _policy_decision(command, cwd=cwd, conversation_id=conversation_id)
    resolved_cwd = str(Path(cwd or initial_policy.workspace_root).resolve())
    approved = False
    if approval_id:
        approved = _consume_shell_approval(
            approval_id,
            command=command,
            cwd=resolved_cwd,
        ) is not None
    policy = _policy_decision(
        command,
        cwd=resolved_cwd,
        conversation_id=conversation_id,
        approved=approved,
    )
    if not policy.allowed:
        approval_request: ShellApprovalRequest | None = None
        if "approval_required" in policy.violations:
            approval_request = _create_approval_request(
                command=command,
                cwd=resolved_cwd,
                policy=policy,
                conversation_id=conversation_id,
            )
        return ShellExecutionResult(
            allowed=False,
            command=_normalize_command(command),
            cwd=resolved_cwd,
            exit_code=-3 if approval_request else -1,
            stdout="",
            stderr="",
            duration_seconds=0.0,
            risk_level=policy.risk_level,
            policy_reason=policy.reason,
            truncated=False,
            workspace_root=policy.workspace_root,
            write_detected=policy.write_detected,
            touched_paths=policy.touched_paths,
            policy_violations=policy.violations,
            approval_required=approval_request is not None,
            approval_id=approval_request.approval_id if approval_request else "",
            approval_expires_at_ts=approval_request.expires_at_ts if approval_request else 0.0,
        )

    provider = resolve_shell_provider(
        provider_name=settings.shell_provider,
        shell_program=settings.shell_program,
    )
    process_result = run_process(
        provider.spawn_args(command),
        cwd=resolved_cwd,
        timeout_seconds=settings.shell_command_timeout_seconds,
    )
    stdout, stdout_truncated = _truncate_output(process_result.stdout)
    stderr, stderr_truncated = _truncate_output(process_result.stderr)
    if process_result.timed_out:
        return ShellExecutionResult(
            allowed=True,
            command=_normalize_command(command),
            cwd=resolved_cwd,
            exit_code=-2,
            stdout=stdout,
            stderr=stderr,
            duration_seconds=process_result.duration_seconds,
            risk_level=policy.risk_level,
            policy_reason=f"command timed out after {settings.shell_command_timeout_seconds}s.",
            truncated=stdout_truncated or stderr_truncated,
            workspace_root=policy.workspace_root,
            write_detected=policy.write_detected,
            touched_paths=policy.touched_paths,
            policy_violations=policy.violations,
        )
    return ShellExecutionResult(
        allowed=True,
        command=_normalize_command(command),
        cwd=resolved_cwd,
        exit_code=process_result.exit_code,
        stdout=stdout,
        stderr=stderr,
        duration_seconds=process_result.duration_seconds,
        risk_level=policy.risk_level,
        policy_reason=policy.reason,
        truncated=stdout_truncated or stderr_truncated,
        workspace_root=policy.workspace_root,
        write_detected=policy.write_detected,
        touched_paths=policy.touched_paths,
        policy_violations=policy.violations,
    )


async def arun_shell_command(
    command: str,
    *,
    cwd: str | None = None,
    conversation_id: str | None = None,
) -> ShellExecutionResult:
    settings = get_settings()
    policy = _policy_decision(command, cwd=cwd, conversation_id=conversation_id)
    resolved_cwd = str(Path(cwd or policy.workspace_root).resolve())
    if not policy.allowed:
        approval_request: ShellApprovalRequest | None = None
        if "approval_required" in policy.violations:
            approval_request = _create_approval_request(
                command=command,
                cwd=resolved_cwd,
                policy=policy,
                conversation_id=conversation_id,
            )
        return ShellExecutionResult(
            allowed=False,
            command=_normalize_command(command),
            cwd=resolved_cwd,
            exit_code=-3 if approval_request else -1,
            stdout="",
            stderr="",
            duration_seconds=0.0,
            risk_level=policy.risk_level,
            policy_reason=policy.reason,
            truncated=False,
            workspace_root=policy.workspace_root,
            write_detected=policy.write_detected,
            touched_paths=policy.touched_paths,
            policy_violations=policy.violations,
            approval_required=approval_request is not None,
            approval_id=approval_request.approval_id if approval_request else "",
            approval_expires_at_ts=approval_request.expires_at_ts if approval_request else 0.0,
        )

    provider = resolve_shell_provider(
        provider_name=settings.shell_provider,
        shell_program=settings.shell_program,
    )
    process_result = await arun_process(
        provider.spawn_args(command),
        cwd=resolved_cwd,
        timeout_seconds=settings.shell_command_timeout_seconds,
    )
    stdout, stdout_truncated = _truncate_output(process_result.stdout)
    stderr, stderr_truncated = _truncate_output(process_result.stderr)
    if process_result.timed_out:
        return ShellExecutionResult(
            allowed=True,
            command=_normalize_command(command),
            cwd=resolved_cwd,
            exit_code=-2,
            stdout=stdout,
            stderr=stderr,
            duration_seconds=process_result.duration_seconds,
            risk_level=policy.risk_level,
            policy_reason=f"command timed out after {settings.shell_command_timeout_seconds}s.",
            truncated=stdout_truncated or stderr_truncated,
            workspace_root=policy.workspace_root,
            write_detected=policy.write_detected,
            touched_paths=policy.touched_paths,
            policy_violations=policy.violations,
        )
    return ShellExecutionResult(
        allowed=True,
        command=_normalize_command(command),
        cwd=resolved_cwd,
        exit_code=process_result.exit_code,
        stdout=stdout,
        stderr=stderr,
        duration_seconds=process_result.duration_seconds,
        risk_level=policy.risk_level,
        policy_reason=policy.reason,
        truncated=stdout_truncated or stderr_truncated,
        workspace_root=policy.workspace_root,
        write_detected=policy.write_detected,
        touched_paths=policy.touched_paths,
        policy_violations=policy.violations,
    )
