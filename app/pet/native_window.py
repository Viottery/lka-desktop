from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


TRANSPARENT_COLOR = "#ff00ff"


@dataclass
class DragState:
    start_x: int = 0
    start_y: int = 0
    window_x: int = 0
    window_y: int = 0
    moved: bool = False


class PetHttpClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def get_json(self, path: str) -> dict[str, Any]:
        with urllib.request.urlopen(f"{self.base_url}{path}", timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))

    def post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))


class NativePetWindow:
    def __init__(self, base_url: str, width: int, height: int) -> None:
        import tkinter as tk

        self.tk = tk
        self.base_url = base_url.rstrip("/")
        self.client = PetHttpClient(self.base_url)
        self.width = width
        self.height = height
        self.drag = DragState()
        self.state: dict[str, Any] = {"bubble": "我在这里。", "mood": "idle"}
        self.manifest: dict[str, Any] = {}
        self.panel_process: subprocess.Popen[Any] | None = None
        self.pet_image_path = ""
        self.pet_image: Any | None = None

        self.root = tk.Tk()
        self.root.title("理事所 · 真理")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.configure(bg=TRANSPARENT_COLOR)
        if platform.system() == "Windows":
            self.root.wm_attributes("-transparentcolor", TRANSPARENT_COLOR)

        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        x = max(0, screen_width - width - 80)
        y = max(0, screen_height - height - 90)
        self.root.geometry(f"{width}x{height}+{x}+{y}")

        self.canvas = tk.Canvas(
            self.root,
            width=width,
            height=height,
            bg=TRANSPARENT_COLOR,
            highlightthickness=0,
            bd=0,
        )
        self.canvas.pack(fill="both", expand=True)

        self.menu = tk.Menu(self.root, tearoff=False)
        self.menu.add_command(label="打开交互面板", command=self.open_panel)
        self.menu.add_command(label="互动一下", command=lambda: self.run_action("poke"))
        self.menu.add_command(label="待机", command=lambda: self.run_action("sleep"))
        self.menu.add_separator()
        self.menu.add_command(label="退出桌宠", command=self.root.destroy)

        self.canvas.bind("<ButtonPress-1>", self.begin_drag)
        self.canvas.bind("<B1-Motion>", self.drag_window)
        self.canvas.bind("<ButtonRelease-1>", self.end_drag)
        self.canvas.bind("<Button-3>", self.open_menu)
        self.canvas.bind("<Double-Button-1>", lambda _event: self.open_panel())

        self.root.after(100, self.refresh_state)
        self.root.after(200, self.apply_tool_window_style)

    def run(self) -> None:
        self.draw()
        self.root.mainloop()

    def refresh_state(self) -> None:
        try:
            self.manifest = self.client.get_json("/pet/manifest")
            self.state = self.manifest.get("state") or self.client.get_json("/pet/state")
        except (OSError, urllib.error.URLError, TimeoutError):
            self.state = {**self.state, "bubble": "后端还没连上。"}
        self.draw()
        self.root.after(3000, self.refresh_state)

    def run_action(self, action: str, payload: dict[str, Any] | None = None) -> None:
        try:
            response = self.client.post_json("/pet/action", {"action": action, "payload": payload or {}})
            self.state = response.get("state") or self.state
        except (OSError, urllib.error.URLError, TimeoutError) as error:
            self.state = {**self.state, "bubble": f"接口调用失败：{error}"}
        self.draw()

    def open_panel(self) -> None:
        self.run_action("open_interaction")
        if self.panel_process and self.panel_process.poll() is None:
            return
        panel_url = f"{self.base_url}/desktop-pet/?mode=panel"
        try:
            self.panel_process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "app.pet.desktop_window",
                    "--url",
                    panel_url,
                    "--width",
                    "540",
                    "--height",
                    "720",
                    "--panel-window",
                ],
                cwd=Path(__file__).resolve().parents[2],
                close_fds=True,
            )
        except OSError as error:
            self.state = {**self.state, "bubble": f"面板打开失败：{error}"}
            self.draw()

    def begin_drag(self, event: Any) -> None:
        self.drag = DragState(
            start_x=event.x_root,
            start_y=event.y_root,
            window_x=self.root.winfo_x(),
            window_y=self.root.winfo_y(),
            moved=False,
        )

    def drag_window(self, event: Any) -> None:
        dx = event.x_root - self.drag.start_x
        dy = event.y_root - self.drag.start_y
        if abs(dx) > 2 or abs(dy) > 2:
            self.drag.moved = True
        self.root.geometry(f"+{self.drag.window_x + dx}+{self.drag.window_y + dy}")

    def end_drag(self, _event: Any) -> None:
        if not self.drag.moved:
            self.run_action("poke")

    def open_menu(self, event: Any) -> None:
        self.menu.tk_popup(event.x_root, event.y_root)

    def draw(self) -> None:
        c = self.canvas
        c.delete("all")
        accent = "#527f95"
        mood = str(self.state.get("mood") or "idle")
        bubble = str(self.state.get("bubble") or "我在这里。")[:42]

        if self.draw_asset_texture():
            if mood == "alert":
                c.create_text(282, 108, text="!", fill="#c43d4b", font=("Segoe UI", 30, "bold"))
        else:
            c.create_oval(78, 154, 242, 325, fill="#f7fbfa", outline="#243b44", width=3)
            c.create_oval(62, 70, 258, 225, fill="#fff8ef", outline="#243b44", width=3)
            c.create_arc(82, 44, 155, 118, start=20, extent=130, style="arc", outline=accent, width=8)
            c.create_arc(165, 44, 238, 118, start=30, extent=130, style="arc", outline=accent, width=8)
            c.create_oval(114, 132, 126, 144, fill="#263238", outline="")
            c.create_oval(194, 132, 206, 144, fill="#263238", outline="")
            if mood == "alert":
                c.create_line(145, 172, 175, 172, fill="#263238", width=4)
            else:
                c.create_arc(138, 150, 182, 185, start=205, extent=130, style="arc", outline="#263238", width=4)

            c.create_rectangle(135, 226, 185, 310, fill=accent, outline="")
            c.create_text(160, 264, text="AGENT", fill="#ffffff", font=("Segoe UI", 11, "bold"), angle=90)

        if bubble:
            c.create_rectangle(18, 8, 302, 58, fill="#ffffff", outline="#c8d5d8", width=1)
            c.create_text(160, 33, text=bubble, fill="#13211d", font=("Microsoft YaHei UI", 10), width=260)

    def draw_asset_texture(self) -> bool:
        image_path = self.current_texture_path()
        if not image_path:
            return False
        if image_path != self.pet_image_path:
            try:
                original = self.tk.PhotoImage(file=image_path)
            except self.tk.TclError:
                return False
            max_width = 280
            max_height = 280
            scale = max(original.width() / max_width, original.height() / max_height, 1)
            subsample = max(1, int(scale + 0.999))
            self.pet_image = original.subsample(subsample, subsample)
            self.pet_image_path = image_path
        if not self.pet_image:
            return False
        self.canvas.create_image(self.width // 2, self.height - 24, image=self.pet_image, anchor="s")
        return True

    def current_texture_path(self) -> str:
        profile_id = self.state.get("active_profile_id")
        profiles = self.manifest.get("profiles") or []
        profile = next((item for item in profiles if item.get("id") == profile_id), profiles[0] if profiles else None)
        texture_url = ((profile or {}).get("spine") or {}).get("texture_url") or ""
        if not texture_url.startswith("/desktop-pet/"):
            return ""
        relative = texture_url.removeprefix("/desktop-pet/")
        asset_path = Path(__file__).resolve().parents[1] / "web" / "pet" / relative
        return str(asset_path) if asset_path.exists() else ""

    def apply_tool_window_style(self) -> None:
        if platform.system() != "Windows":
            return
        try:
            import ctypes

            hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id())
            gexstyle = -20
            ws_ex_toolwindow = 0x00000080
            ws_ex_appwindow = 0x00040000
            get_window_long = ctypes.windll.user32.GetWindowLongPtrW
            set_window_long = ctypes.windll.user32.SetWindowLongPtrW
            style = int(get_window_long(hwnd, gexstyle))
            style = (style | ws_ex_toolwindow) & ~ws_ex_appwindow
            set_window_long(hwnd, gexstyle, style)
        except Exception:
            return


def main() -> int:
    parser = argparse.ArgumentParser(description="Open a stable native transparent desktop pet window.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--width", type=int, default=320)
    parser.add_argument("--height", type=int, default=360)
    args = parser.parse_args()

    NativePetWindow(base_url=args.base_url, width=args.width, height=args.height).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
