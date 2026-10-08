"""Read-only, account-bound lookup for names of groups the local QQ joined."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import ipaddress
import json
import math
from pathlib import Path
import re
import time
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.plugins.qq_actions import QQActionClient, QQActionConfig, QQActionError


class GroupDirectoryError(Exception):
    def __init__(self, code: str, status: int = 503):
        self.code, self.status = code, status
        super().__init__(code)


def _qq_id(value: Any) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    normalized = str(value).strip()
    if not re.fullmatch(r"[0-9]{1,20}", normalized) or int(normalized) <= 0:
        return None
    return str(int(normalized))


def _group_rows(value: Any) -> dict[str, str]:
    if not isinstance(value, list) or len(value) > 20000:
        raise GroupDirectoryError("protocol_error", 502)
    groups: dict[str, str] = {}
    for row in value:
        if not isinstance(row, dict):
            raise GroupDirectoryError("protocol_error", 502)
        group_id = _qq_id(row.get("group_id"))
        name = row.get("group_name")
        if group_id is None or not isinstance(name, str):
            raise GroupDirectoryError("protocol_error", 502)
        # Do not return control characters or unbounded provider fields to the UI.
        name = "".join(char for char in name.strip() if ord(char) >= 32 and ord(char) != 127)[:128]
        groups[group_id] = name
    return groups


class SnowLumaMetadataClient:
    """Bounded read-only adapter to SnowLuma's authenticated local WebUI."""

    ALLOWED_ACTIONS = frozenset({"get_login_info", "get_group_list", "get_group_info"})
    MAX_RESPONSE_BYTES = 1024 * 1024
    MAX_CREDENTIAL_BYTES = 16 * 1024

    def __init__(self, base_url: str, credential_path: str | Path, expected_self_id: str | int,
                 *, timeout: float = 8, transport=None):
        try:
            parsed = urlsplit(base_url)
            host = parsed.hostname
            local = host == "localhost" or bool(host and ipaddress.ip_address(host).is_loopback)
            if (parsed.scheme not in {"http", "https"} or not local
                    or parsed.username is not None or parsed.password is not None
                    or parsed.query or parsed.fragment or parsed.path not in {"", "/"}
                    or parsed.port == 0):
                raise ValueError()
            if (isinstance(timeout, bool) or not math.isfinite(timeout)
                    or timeout <= 0 or timeout > 8):
                raise ValueError()
            account = _qq_id(expected_self_id)
            if account is None:
                raise ValueError()
            path = Path(credential_path)
            if not path.is_absolute() or path.is_symlink() or not path.is_file():
                raise ValueError()
            if getattr(path.stat(), "st_file_attributes", 0) & 1024:
                raise ValueError()
            for parent in path.parents:
                if parent.is_symlink() or (parent.exists()
                        and getattr(parent.stat(), "st_file_attributes", 0) & 1024):
                    raise ValueError()
            if path.name != "control.private.json" or path.stat().st_size > self.MAX_CREDENTIAL_BYTES:
                raise ValueError()
            credentials = json.loads(path.read_text(encoding="utf-8"))
            token = credentials.get("token") if isinstance(credentials, dict) else None
            password = credentials.get("password") if isinstance(credentials, dict) else None
            if not isinstance(token, str) or not token or not isinstance(password, str) or not password:
                raise ValueError()
        except (OSError, ValueError, TypeError, AttributeError, json.JSONDecodeError):
            raise QQActionError("invalid_config") from None
        self.expected_self_id = account
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._password = password
        self._timeout = timeout
        self._transport = transport

    async def _request(self, method: str, path: str, *, payload=None, retry_auth=True):
        try:
            async with httpx.AsyncClient(transport=self._transport, trust_env=False,
                                         follow_redirects=False, timeout=self._timeout) as client:
                async with client.stream(method, self._base_url + path,
                        json=payload, headers={"Authorization": "Bearer " + self._token}) as response:
                    status = response.status_code
                    if status == 401 and retry_auth:
                        await self._login()
                        return await self._request(method, path, payload=payload, retry_auth=False)
                    if status in (401, 403):
                        raise QQActionError("auth_error", status_code=status)
                    if 300 <= status < 400:
                        raise QQActionError("protocol_error", status_code=status)
                    if not 200 <= status < 300:
                        raise QQActionError("action_failed", status_code=status)
                    body = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=64 * 1024):
                        if len(body) + len(chunk) > self.MAX_RESPONSE_BYTES:
                            raise QQActionError("protocol_error", status_code=status)
                        body.extend(chunk)
                    try:
                        return json.loads(body)
                    except (ValueError, UnicodeError, RecursionError):
                        raise QQActionError("protocol_error", status_code=status) from None
        except QQActionError:
            raise
        except httpx.TimeoutException:
            raise QQActionError("timeout") from None
        except httpx.RequestError:
            raise QQActionError("network_error") from None

    async def _login(self):
        try:
            async with httpx.AsyncClient(transport=self._transport, trust_env=False,
                                         follow_redirects=False, timeout=self._timeout) as client:
                async with client.stream("POST", self._base_url + "/api/login",
                        json={"password": self._password}) as response:
                    if response.status_code != 200:
                        raise QQActionError("auth_error", status_code=response.status_code)
                    body = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=64 * 1024):
                        if len(body) + len(chunk) > self.MAX_RESPONSE_BYTES:
                            raise QQActionError("protocol_error", status_code=response.status_code)
                        body.extend(chunk)
                    try:
                        result = json.loads(body)
                    except (ValueError, UnicodeError, RecursionError):
                        raise QQActionError("protocol_error", status_code=response.status_code) from None
                    if not isinstance(result, dict) or result.get("success") is not True:
                        raise QQActionError("auth_error", status_code=response.status_code)
                    token = result.get("token")
                    if not isinstance(token, str) or not token:
                        raise QQActionError("protocol_error", status_code=response.status_code)
                    self._token = token
        except QQActionError:
            raise
        except httpx.TimeoutException:
            raise QQActionError("timeout") from None
        except httpx.RequestError:
            raise QQActionError("network_error") from None

    async def _action(self, action: str, params: dict[str, Any]):
        if action not in self.ALLOWED_ACTIONS:
            raise QQActionError("unsupported_action")
        if not isinstance(params, dict):
            raise QQActionError("invalid_params")
        if action in {"get_login_info", "get_group_list"} and params:
            raise QQActionError("invalid_params")
        if action == "get_group_info":
            group_id = _qq_id(params.get("group_id")) if set(params) == {"group_id"} else None
            if group_id is None:
                raise QQActionError("invalid_params")
            params = {"group_id": group_id}
        result = await self._request("POST", "/api/debug/invoke",
                payload={"uin": self.expected_self_id, "action": action, "params": params})
        if (not isinstance(result, dict) or result.get("status") != "ok"
                or type(result.get("retcode")) is not int or result["retcode"] != 0
                or "data" not in result):
            raise QQActionError("action_failed")
        return result["data"]

    async def verify_account(self) -> bool:
        result = await self._request("GET", "/api/qq-list")
        rows = result.get("list") if isinstance(result, dict) else None
        if not isinstance(rows, list):
            raise QQActionError("protocol_error")
        if not any(isinstance(row, dict)
                   and _qq_id(row.get("uin")) == self.expected_self_id for row in rows):
            raise QQActionError("account_mismatch")
        data = await self._action("get_login_info", {})
        actual = _qq_id(data.get("user_id")) if isinstance(data, dict) else None
        if actual != self.expected_self_id:
            raise QQActionError("account_mismatch")
        return True

    async def call(self, action: str, params: dict[str, Any]):
        return await self._action(action, params)


@dataclass
class _Snapshot:
    loaded_at: float
    names: dict[str, str]


class QQGroupNames:
    """Caches the small group-id/name directory and refreshes it in the background."""

    def __init__(self, config: QQActionConfig | None = None, *, client=None,
                 expected_self_id: str | int | None = None, cache_seconds: float = 60,
                 account_check_seconds: float = 3, failure_backoff_seconds: float = 30):
        self.config = config
        self.expected_self_id = _qq_id(expected_self_id if expected_self_id is not None
                                       else getattr(config, "expected_self_id", None))
        if self.expected_self_id is None:
            raise QQActionError("invalid_config")
        self.client = client or QQActionClient(config)
        self.cache_seconds = cache_seconds
        self.account_check_seconds = account_check_seconds
        self.failure_backoff_seconds = failure_backoff_seconds
        self._snapshot: _Snapshot | None = None
        self._verified_at = 0.0
        self._retry_after = 0.0
        self._failure: tuple[str, int] | None = None
        self._lock = asyncio.Lock()
        self._epoch = 0
        self._refresh_task: asyncio.Task | None = None
        self._verification_task: asyncio.Task | None = None
        self._verification_task_started_at = 0.0

    @staticmethod
    def _error(exc: QQActionError) -> GroupDirectoryError:
        status = 409 if exc.code == "account_mismatch" else 502 if exc.code in {"protocol_error", "action_failed"} else 503
        return GroupDirectoryError(exc.code, status)

    def _record_failure(self, error: GroupDirectoryError) -> None:
        self._failure = (error.code, error.status)
        self._retry_after = time.monotonic() + self.failure_backoff_seconds
        if error.code == "account_mismatch":
            self._epoch += 1
            self._snapshot = None
            self._verified_at = 0.0
            self._refresh_task = None
            self._verification_task = None

    def _start_verification_locked(self) -> asyncio.Task:
        task = self._verification_task
        if task is None or task.done():
            task = asyncio.create_task(self._verify_account(self._epoch))
            self._verification_task = task
            self._verification_task_started_at = time.monotonic()
        return task

    async def _verify_account(self, epoch: int) -> GroupDirectoryError | None:
        current_task = asyncio.current_task()
        error = None
        try:
            await self.client.verify_account()
        except QQActionError as exc:
            error = self._error(exc)
        except GroupDirectoryError as exc:
            error = exc
        except Exception:
            error = GroupDirectoryError("temporarily_unavailable", 503)
        async with self._lock:
            if self._epoch == epoch:
                if error is not None:
                    self._record_failure(error)
                else:
                    self._verified_at = time.monotonic()
            elif error is None:
                # A concurrent account mismatch invalidated this check while
                # it was in flight; its success cannot authorize this lookup.
                error = GroupDirectoryError("account_mismatch", 409)
            if self._verification_task is current_task:
                self._verification_task = None
                self._verification_task_started_at = 0.0
        return error

    async def _ensure_verified(self, *, force: bool = False,
                               not_before: float | None = None) -> GroupDirectoryError | None:
        while True:
            async with self._lock:
                task = self._verification_task
                wait_then_recheck = (task is not None and not task.done()
                                     and not_before is not None
                                     and self._verification_task_started_at < not_before)
                if task is None or task.done():
                    if (not force and time.monotonic() - self._verified_at
                            < self.account_check_seconds):
                        return None
                    task = self._start_verification_locked()
                elif not wait_then_recheck:
                    task = self._start_verification_locked()
            # All callers await one check, but the directory lock remains free
            # so cached lookups and refresh completion can make progress.
            error = await asyncio.shield(task)
            if error is not None:
                return error
            if not wait_then_recheck:
                return None

    def _start_refresh_locked(self) -> asyncio.Task:
        task = self._refresh_task
        if task is None or task.done():
            task = asyncio.create_task(self._refresh_directory(self._epoch))
            self._refresh_task = task
        return task

    async def _refresh_directory(self, epoch: int) -> None:
        current_task = asyncio.current_task()
        try:
            groups = _group_rows(await self.client.call("get_group_list", {}))
            fetched_at = time.monotonic()
            # Bind the fetched directory to the same account before and after
            # the action. The caller verified before scheduling; force a
            # coalesced post-fetch check before publishing the new snapshot.
            error = await self._ensure_verified(force=True, not_before=fetched_at)
            if error is not None:
                raise error
        except QQActionError as exc:
            error = self._error(exc)
            async with self._lock:
                if self._epoch == epoch:
                    self._record_failure(error)
        except GroupDirectoryError as exc:
            async with self._lock:
                if self._epoch == epoch:
                    self._record_failure(exc)
        except Exception:
            # Provider/client failures are surfaced as a bounded service error;
            # avoid leaving an unobserved background-task exception.
            async with self._lock:
                if self._epoch == epoch:
                    self._record_failure(GroupDirectoryError("temporarily_unavailable", 503))
        else:
            async with self._lock:
                if self._epoch == epoch:
                    self._snapshot = _Snapshot(time.monotonic(), groups)
                    self._verified_at = time.monotonic()
                    self._failure = None
                    self._retry_after = 0.0
        finally:
            async with self._lock:
                if self._refresh_task is current_task:
                    self._refresh_task = None

    def _stale_or_raise(self, group_id: str, error: GroupDirectoryError) -> dict[str, Any]:
        snapshot = self._snapshot
        if (error.code != "account_mismatch" and snapshot is not None
                and time.monotonic() - snapshot.loaded_at <= max(self.cache_seconds, 1800)
                and group_id in snapshot.names):
            return {"account_id": self.expected_self_id, "group_id": group_id,
                    "group_name": snapshot.names[group_id], "cached": True, "stale": True}
        raise error

    async def name_for(self, group_id: Any, account_id: Any) -> dict[str, Any]:
        normalized_id = _qq_id(group_id)
        normalized_account = _qq_id(account_id)
        expected_account = self.expected_self_id
        if normalized_id is None:
            raise GroupDirectoryError("invalid_group_id", 400)
        if normalized_account is None or expected_account is None or normalized_account != expected_account:
            raise GroupDirectoryError("account_mismatch", 409)

        loaded_by_this_request = False
        while True:
            refresh: asyncio.Task | None = None
            verify: asyncio.Task | None = None
            async with self._lock:
                now = time.monotonic()
                snapshot = self._snapshot
                cached = snapshot is not None and now - snapshot.loaded_at < self.cache_seconds
                if now < self._retry_after:
                    code, status = self._failure or ("temporarily_unavailable", 503)
                    return self._stale_or_raise(normalized_id, GroupDirectoryError(code, status))
                if now - self._verified_at >= self.account_check_seconds:
                    verify = self._start_verification_locked()

                if verify is None:
                    snapshot = self._snapshot
                    cached = snapshot is not None and time.monotonic() - snapshot.loaded_at < self.cache_seconds
                else:
                    snapshot = None
                    cached = False
                if verify is None and snapshot is not None and normalized_id in snapshot.names:
                    name = snapshot.names[normalized_id]
                    if not cached:
                        # Keep known labels responsive while one account-bound
                        # refresh runs. The response explicitly marks the old
                        # label stale; a cold/unknown lookup waits below.
                        self._start_refresh_locked()
                        stale_age = time.monotonic() - snapshot.loaded_at
                        if name and stale_age <= max(self.cache_seconds, 1800):
                            return {"account_id": expected_account, "group_id": normalized_id,
                                    "group_name": name, "cached": True, "stale": True}
                    elif name:
                        return {"account_id": expected_account, "group_id": normalized_id,
                                "group_name": name, "cached": not loaded_by_this_request,
                                "stale": False}
                    if cached:
                        return await self._group_info_locked(normalized_id, snapshot)
                    refresh = self._refresh_task
                elif verify is None and snapshot is not None and cached:
                    raise GroupDirectoryError("group_not_found", 404)
                elif verify is None:
                    refresh = self._start_refresh_locked()

            # Shield shared tasks so cancelling one request does not cancel
            # work needed by other concurrent lookups.
            if verify is not None:
                await asyncio.shield(verify)
            elif refresh is not None:
                await asyncio.shield(refresh)
                loaded_by_this_request = True

    async def _group_info_locked(self, group_id: str, snapshot: _Snapshot) -> dict[str, Any]:
        try:
            info = await self.client.call("get_group_info", {"group_id": group_id})
            if not isinstance(info, dict) or _qq_id(info.get("group_id")) != group_id:
                raise GroupDirectoryError("protocol_error", 502)
            value = info.get("group_name")
            name = ""
            if isinstance(value, str):
                name = "".join(c for c in value.strip() if ord(c) >= 32 and ord(c) != 127)[:128]
                snapshot.names[group_id] = name
        except QQActionError as exc:
            error = self._error(exc)
            self._record_failure(error)
            return self._stale_or_raise(group_id, error)
        except GroupDirectoryError as exc:
            self._record_failure(exc)
            return self._stale_or_raise(group_id, exc)
        return {"account_id": self.expected_self_id, "group_id": group_id,
                "group_name": name, "cached": True, "stale": False}
