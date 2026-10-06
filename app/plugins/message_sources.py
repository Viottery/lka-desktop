"""Local message source adapters share a normalized event pipeline."""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Iterable
from typing import Any, Protocol


class MessageSource(Protocol):
    """Small lifecycle contract used by live and deterministic sources."""

    async def connect(self) -> None: ...
    def receive(self) -> AsyncIterator[Any]: ...
    def normalize(self, event: Any) -> dict[str, Any] | None: ...
    def status(self) -> dict[str, Any]: ...
    async def stop(self) -> None: ...


class MockMessageSource:
    """Synthetic iterator source; it performs no I/O and is safe for tests."""

    def __init__(self, events: Iterable[Any] = ()):
        self._events = list(events)
        self._connected = False
        self._stopped = False

    async def connect(self) -> None:
        self._connected = True

    async def receive(self) -> AsyncIterator[Any]:
        for event in self._events:
            if self._stopped:
                break
            yield event
            await asyncio.sleep(0)

    def normalize(self, event: Any) -> dict[str, Any] | None:
        return event if isinstance(event, dict) and event.get("schema_version") in (1, 2) else None

    def status(self) -> dict[str, Any]:
        return {"connected": self._connected and not self._stopped, "source": "mock"}

    async def stop(self) -> None:
        self._stopped = True
        self._connected = False


class QQMessageSource:
    """Adapter for QQ Reader's existing local WebSocket connection."""

    def __init__(self, connector: Any, normalizer: Any):
        self._connector = connector
        self._normalizer = normalizer
        self._socket = None
        self._connected = False
        self._iterator = None

    async def connect(self) -> None:
        self._socket = await self._connector()
        self._connected = True

    def receive(self) -> AsyncIterator[Any]:
        self._iterator = self._iterate()
        return self._iterator

    async def _iterate(self) -> AsyncIterator[Any]:
        if self._socket is None:
            raise RuntimeError("source_not_connected")
        async with self._socket as socket:
            async for event in socket:
                yield event
        self._connected = False

    def normalize(self, event: Any) -> dict[str, Any] | None:
        if isinstance(event, str):
            try:
                event = json.loads(event)
            except (TypeError, ValueError):
                return None
        return self._normalizer(event) if isinstance(event, dict) else None

    def status(self) -> dict[str, Any]:
        return {"connected": self._connected, "source": "qq"}

    async def stop(self) -> None:
        self._connected = False
        if self._iterator is not None:
            await self._iterator.aclose()
            self._iterator = None
        socket = self._socket
        if socket is not None and hasattr(socket, "close"):
            result = socket.close()
            if hasattr(result, "__await__"):
                await result


# Deliberate static registration: source packages do not load arbitrary modules.
MESSAGE_SOURCE_TYPES = {"qq": QQMessageSource, "mock": MockMessageSource}
