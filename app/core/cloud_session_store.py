"""Optional Windows-user encrypted storage for the local hub account session."""
from __future__ import annotations

import ctypes
import json
import os
import tempfile
import time
from ctypes import wintypes
from pathlib import Path

_MAX_BYTES = 65536


class SessionStorageError(OSError):
    pass


def _crypt(data: bytes, *, decrypt: bool = False) -> bytes:
    """Use CurrentUser DPAPI; never fall back to a plaintext credential file."""
    if os.name != "nt":
        raise SessionStorageError("Encrypted cloud session storage requires Windows DPAPI")

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
    source, target = Blob(len(data), buffer), Blob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    function = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)):
        raise SessionStorageError("Windows could not protect or restore the cloud session")
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel32.LocalFree(target.data)


def load(path: str, origin: str) -> dict | None:
    if not path or not origin:
        return None
    try:
        with Path(path).open("rb") as stream:
            raw = stream.read(_MAX_BYTES + 1)
        if len(raw) > _MAX_BYTES:
            return None
        value = json.loads(_crypt(raw, decrypt=True))
        if (not isinstance(value, dict) or value.get("version") != 1 or value.get("origin") != origin
                or not isinstance(value.get("token"), str) or not 0 < len(value["token"]) <= 8192
                or not isinstance(value.get("account"), dict)
                or type(value.get("expires_at")) is not int or value["expires_at"] <= time.time()):
            return None
        return value
    except (OSError, ValueError, UnicodeError):
        return None


def save(path: str, value: dict) -> None:
    if not path:
        return
    destination = Path(path)
    try:
        raw = _crypt(json.dumps(dict(value, version=1), separators=(",", ":")).encode("utf-8"))
        if len(raw) > _MAX_BYTES:
            raise SessionStorageError("Cloud session record is too large")
        destination.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=destination.name + ".", dir=destination.parent)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
        finally:
            Path(temporary).unlink(missing_ok=True)
    except OSError as error:
        raise SessionStorageError("Could not save the encrypted cloud session") from error


def clear(path: str) -> None:
    if path:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError as error:
            raise SessionStorageError("Could not remove the encrypted cloud session") from error
