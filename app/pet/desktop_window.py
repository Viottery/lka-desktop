from __future__ import annotations

import argparse
import ctypes
import inspect
import platform
import subprocess
import sys
from typing import Any


def _filtered_kwargs(function: Any, values: dict[str, Any]) -> dict[str, Any]:
    parameters = inspect.signature(function).parameters
    return {key: value for key, value in values.items() if key in parameters}


class NativeWindowBridge:
    def __init__(self, panel_url: str) -> None:
        self.window: Any | None = None
        self.panel_url = panel_url
        self._click_through = False

    def attach(self, window: Any) -> None:
        self.window = window
        self.apply_transparency()
        self.set_click_through(self._click_through)

    def apply_transparency(self) -> dict[str, Any]:
        if platform.system() != "Windows" or self.window is None:
            return {"ok": False, "reason": "native transparency is only applied on Windows"}

        applied: list[str] = []
        try:
            native = self.window.native
            webview_control = getattr(native, "webview", None)

            try:
                from System.Drawing import Color

                transparent = Color.FromArgb(0, 0, 0, 0)
                if webview_control is not None and hasattr(webview_control, "DefaultBackgroundColor"):
                    webview_control.DefaultBackgroundColor = transparent
                    applied.append("webview2-default-background")
                if hasattr(native, "BackColor"):
                    native.BackColor = Color.Black
                    applied.append("window-back-color")
                if hasattr(native, "TransparencyKey"):
                    native.TransparencyKey = Color.Black
                    applied.append("window-transparency-key")
            except Exception:
                pass

            hwnd = self._hwnd()
            if hwnd:
                self._set_layered_style(hwnd, enabled=True)
                applied.append("layered-window-style")
        except Exception as error:
            return {"ok": False, "reason": str(error), "applied": applied}

        return {"ok": True, "applied": applied}

    def set_click_through(self, enabled: bool) -> dict[str, Any]:
        self._click_through = bool(enabled)
        if platform.system() != "Windows" or self.window is None:
            return {"ok": False, "enabled": self._click_through, "reason": "window is not ready"}

        hwnd = self._hwnd()
        if not hwnd:
            return {"ok": False, "enabled": self._click_through, "reason": "native window handle not found"}

        try:
            self._set_layered_style(hwnd, enabled=True, click_through=self._click_through)
        except Exception as error:
            return {"ok": False, "enabled": self._click_through, "reason": str(error)}
        return {"ok": True, "enabled": self._click_through}

    def open_panel_window(self) -> dict[str, Any]:
        try:
            subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "app.pet.desktop_window",
                    "--url",
                    self.panel_url,
                    "--width",
                    "540",
                    "--height",
                    "720",
                    "--panel-window",
                ],
                cwd=sys.path[0] or None,
                close_fds=True,
            )
        except Exception as error:
            return {"ok": False, "reason": str(error)}
        return {"ok": True, "url": self.panel_url}

    def _hwnd(self) -> int:
        if self.window is None:
            return 0
        native = self.window.native
        handle = getattr(native, "Handle", None)
        if handle is None:
            return 0
        try:
            return int(handle.ToInt64())
        except AttributeError:
            return int(handle)

    @staticmethod
    def _set_layered_style(hwnd: int, *, enabled: bool, click_through: bool = False) -> None:
        user32 = ctypes.windll.user32
        gexstyle = -20
        ws_ex_layered = 0x00080000
        ws_ex_transparent = 0x00000020
        swp_no_size = 0x0001
        swp_no_move = 0x0002
        swp_no_zorder = 0x0004
        swp_no_activate = 0x0010
        swp_framechanged = 0x0020

        get_window_long = user32.GetWindowLongPtrW if hasattr(user32, "GetWindowLongPtrW") else user32.GetWindowLongW
        set_window_long = user32.SetWindowLongPtrW if hasattr(user32, "SetWindowLongPtrW") else user32.SetWindowLongW

        style = int(get_window_long(hwnd, gexstyle))
        if enabled:
            style |= ws_ex_layered
        else:
            style &= ~ws_ex_layered
        if click_through:
            style |= ws_ex_transparent
        else:
            style &= ~ws_ex_transparent
        set_window_long(hwnd, gexstyle, style)
        user32.SetWindowPos(
            hwnd,
            0,
            0,
            0,
            0,
            0,
            swp_no_size | swp_no_move | swp_no_zorder | swp_no_activate | swp_framechanged,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Open the desktop pet as a native transparent Windows layer.")
    parser.add_argument("--url", default="http://127.0.0.1:8000/desktop-pet/?layer=1")
    parser.add_argument("--width", type=int, default=360)
    parser.add_argument("--height", type=int, default=520)
    parser.add_argument("--x", type=int, default=None)
    parser.add_argument("--y", type=int, default=None)
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--panel-window", action="store_true")
    args = parser.parse_args()

    try:
        import webview
    except ImportError:
        print(
            "pywebview is not installed. Install it in the project venv with: "
            ".\\.venv\\Scripts\\python.exe -m pip install pywebview",
            file=sys.stderr,
        )
        return 2

    base_url = args.url.split("/desktop-pet/")[0]
    panel_url = base_url + "/desktop-pet/chat.html?mode=quick"
    native_bridge = NativeWindowBridge(panel_url=panel_url)
    transparent = not args.panel_window
    window_kwargs = _filtered_kwargs(
        webview.create_window,
        {
            "title": "理事所 · 快速任务" if args.panel_window else "理事所 · 真理",
            "url": args.url,
            "js_api": native_bridge,
            "width": args.width,
            "height": args.height,
            "x": args.x,
            "y": args.y,
            "resizable": args.panel_window,
            "frameless": not args.panel_window,
            "easy_drag": False,
            "on_top": not args.panel_window,
            "transparent": transparent,
            "background_color": "#000000" if transparent else "#eef0f4",
            "text_select": True,
        },
    )
    window = webview.create_window(**window_kwargs)
    if transparent:
        window.events.before_show += lambda: native_bridge.attach(window)

    start_kwargs = _filtered_kwargs(webview.start, {"debug": args.debug, "gui": "edgechromium"})
    webview.start(**start_kwargs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
