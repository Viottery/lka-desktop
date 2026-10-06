"""Bounded local SnowLuma OneBot action client; no response data is logged."""
from dataclasses import dataclass, field
import ipaddress
import json
import math
from typing import Any
from urllib.parse import urlsplit

import httpx


ALLOWED_ACTIONS = frozenset({
    "get_login_info", "send_msg", "send_custom_face", "fetch_custom_face",
    "fetch_custom_face_detail", "get_msg", "get_friend_msg_history",
    "get_group_msg_history", "get_group_list", "get_group_info",
    "get_image", "get_record", "get_file",
})
WRITE_ACTIONS = frozenset({"send_msg", "send_custom_face"})
MAX_RESPONSE_BYTES = 1024 * 1024


class QQActionError(Exception):
    """Public errors contain only a stable code and optional HTTP status."""

    def __init__(self, code: str, *, status_code: int | None = None):
        self.code = code
        self.status_code = status_code
        super().__init__(code)


@dataclass(frozen=True)
class QQActionConfig:
    url: str = "http://127.0.0.1:3002"
    token: str = field(default="", repr=False)
    expected_self_id: str | int = field(default="", repr=False)
    timeout: float = 60.0


def _account_id(value: Any) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    normalized = str(value).strip()
    return normalized or None


class QQActionClient:
    def __init__(self, config: QQActionConfig, transport=None):
        self.config = config
        self._transport = transport
        try:
            parsed = urlsplit(config.url)
            host = parsed.hostname
            # Only loopback addresses and the local host name are accepted.
            valid_host = host == "localhost" or bool(host and ipaddress.ip_address(host).is_loopback)
            if (parsed.scheme != "http" or not valid_host or parsed.username is not None
                    or parsed.password is not None or parsed.query or parsed.fragment
                    or parsed.path not in ("", "/") or parsed.port == 0):
                raise ValueError()
            if (not isinstance(config.token, str) or not config.token.strip()
                    or any(ord(c) < 33 or ord(c) > 126 for c in config.token)
                    or _account_id(config.expected_self_id) is None
                    or isinstance(config.timeout, bool) or not math.isfinite(config.timeout)
                    or config.timeout <= 0):
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise QQActionError("invalid_config") from None
        self._base_url = config.url.rstrip("/")

    async def verify_account(self) -> bool:
        data = await self._request("get_login_info", {})
        actual = _account_id(data.get("user_id")) if isinstance(data, dict) else None
        if actual is None:
            raise QQActionError("protocol_error")
        if actual != _account_id(self.config.expected_self_id):
            raise QQActionError("account_mismatch")
        return True

    async def call(self, action: str, params: dict) -> Any:
        if not isinstance(action, str) or action not in ALLOWED_ACTIONS:
            raise QQActionError("unsupported_action")
        if not isinstance(params, dict):
            raise QQActionError("invalid_params")
        try:
            # Validate and snapshot before awaiting the account check. A caller
            # cannot alter the send request while it is being authorized.
            payload = json.loads(json.dumps(params, allow_nan=False))
        except (TypeError, ValueError, OverflowError, RecursionError):
            raise QQActionError("invalid_params") from None
        if action in WRITE_ACTIONS:
            await self.verify_account()
        return await self._request(action, payload)

    async def _request(self, action: str, params: dict) -> Any:
        try:
            async with httpx.AsyncClient(
                transport=self._transport, trust_env=False, follow_redirects=False,
                timeout=self.config.timeout,
            ) as client:
                async with client.stream(
                    "POST", f"{self._base_url}/{action}", json=params,
                    headers={"Authorization": f"Bearer {self.config.token}"},
                ) as response:
                    status = response.status_code
                    if status in (401, 403):
                        raise QQActionError("auth_error", status_code=status)
                    if 300 <= status < 400:
                        raise QQActionError("protocol_error", status_code=status)
                    if not 200 <= status < 300:
                        raise QQActionError("action_failed", status_code=status)
                    body = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=64 * 1024):
                        if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                            raise QQActionError("protocol_error", status_code=status)
                        body.extend(chunk)
                    try:
                        result = json.loads(body)
                    except (ValueError, UnicodeError, RecursionError):
                        raise QQActionError("protocol_error", status_code=status) from None
                    if not isinstance(result, dict):
                        raise QQActionError("protocol_error", status_code=status)
                    retcode = result.get("retcode")
                    if isinstance(retcode, bool) or not isinstance(retcode, int):
                        raise QQActionError("protocol_error", status_code=status)
                    if retcode != 0 or result.get("status") == "failed":
                        raise QQActionError("action_failed", status_code=status)
                    if result.get("status") != "ok" or "data" not in result:
                        raise QQActionError("protocol_error", status_code=status)
                    return result["data"]
        except httpx.TimeoutException:
            raise QQActionError("timeout") from None
        except httpx.RequestError:
            raise QQActionError("network_error") from None
