from __future__ import annotations

import argparse
import ctypes
import platform
import sys
import time
from typing import Any


class _MissingQt(RuntimeError):
    pass


def _load_qt() -> dict[str, Any]:
    try:
        from PyQt6.QtCore import QPoint, Qt, QTimer, QUrl
        from PyQt6.QtGui import QColor, QCursor
        from PyQt6.QtWebEngineWidgets import QWebEngineView
        from PyQt6.QtWidgets import QApplication, QMainWindow
    except ImportError as error:
        raise _MissingQt(
            "PyQt6/PyQt6-WebEngine is not installed. Run the Windows setup or install "
            "requirements-windows-agent.txt in the project venv."
        ) from error
    return {
        "QApplication": QApplication,
        "QColor": QColor,
        "QCursor": QCursor,
        "QMainWindow": QMainWindow,
        "QPoint": QPoint,
        "QTimer": QTimer,
        "Qt": Qt,
        "QUrl": QUrl,
        "QWebEngineView": QWebEngineView,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Open the Spine desktop pet in a transparent Qt WebEngine window.")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--width", type=int, default=360)
    parser.add_argument("--height", type=int, default=520)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    try:
        qt = _load_qt()
    except _MissingQt as error:
        print(str(error), file=sys.stderr)
        return 2

    QApplication = qt["QApplication"]
    QColor = qt["QColor"]
    QCursor = qt["QCursor"]
    QMainWindow = qt["QMainWindow"]
    QPoint = qt["QPoint"]
    QTimer = qt["QTimer"]
    Qt = qt["Qt"]
    QUrl = qt["QUrl"]
    QWebEngineView = qt["QWebEngineView"]

    class PanelPage(QMainWindow):
        def __init__(self, url: str, *, work_mode: bool = False) -> None:
            super().__init__()
            self.setWindowTitle("理事所 · 工作台" if work_mode else "理事所 · 快速任务")
            self.resize(1320, 840) if work_mode else self.resize(430, 680)
            self.extra_windows: list[PanelPage] = []

            class ChatView(QWebEngineView):
                def createWindow(inner_self, _window_type: Any) -> QWebEngineView:
                    popup = PanelPage(f"{url.split('/desktop-pet/')[0]}/desktop-pet/chat.html?mode=work", work_mode=True)
                    self.extra_windows.append(popup)
                    popup.show()
                    return popup.centralWidget()

            view = ChatView(self)
            view.urlChanged.connect(self._update_mode)
            view.setUrl(QUrl(url))
            self.setCentralWidget(view)

        def _update_mode(self, url: QUrl) -> None:
            if "mode=work" in url.toString():
                self.setWindowTitle("理事所 · 工作台")
                if self.width() < 1000:
                    self.resize(1320, 840)

    class PetPage(QWebEngineView):
        def __init__(self, owner: "PetWindow") -> None:
            super().__init__(owner)
            self.owner = owner
            self.setStyleSheet("background: transparent; border: 0px;")
            self.setMouseTracking(True)

        def createWindow(self, _window_type: Any) -> QWebEngineView:
            panel = PanelPage(f"{self.owner.base_url}/desktop-pet/chat.html?mode=quick")
            self.owner.panels.append(panel)
            panel.show()
            return panel.centralWidget()

        def mousePressEvent(self, event: Any) -> None:
            if event.button() == Qt.MouseButton.LeftButton:
                self.owner.begin_drag(event)
                event.accept()
                return
            super().mousePressEvent(event)

        def mouseMoveEvent(self, event: Any) -> None:
            if self.owner.is_dragging:
                self.owner.update_drag(event)
                event.accept()
                return
            super().mouseMoveEvent(event)

        def mouseReleaseEvent(self, event: Any) -> None:
            if event.button() == Qt.MouseButton.LeftButton and self.owner.is_dragging:
                self.owner.end_drag()
                event.accept()
                return
            super().mouseReleaseEvent(event)

    class PetWindow(QMainWindow):
        def __init__(self) -> None:
            super().__init__()
            self.base_url = args.base_url.rstrip("/")
            self.panels: list[PanelPage] = []
            self.drag_origin: QPoint | None = None
            self.window_origin: QPoint | None = None
            self.is_dragging = False
            self.is_click_through = False
            self.left_down = False
            self.drag_guard_until = 0.0

            flags = (
                Qt.WindowType.FramelessWindowHint
                | Qt.WindowType.WindowStaysOnTopHint
                | Qt.WindowType.Tool
            )
            self.setWindowFlags(flags)
            self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
            self.setWindowTitle("理事所 · 真理")
            self.resize(args.width, args.height)
            self.setStyleSheet("background: transparent; border: 0px;")

            self.view = PetPage(self)
            self.view.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
            self.view.page().setBackgroundColor(QColor(0, 0, 0, 0))
            self.view.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)
            self.view.setUrl(QUrl(f"{self.base_url}/desktop-pet/?layer=1&qt=1"))
            self.setCentralWidget(self.view)

            self.hit_timer = QTimer(self)
            self.hit_timer.timeout.connect(self.update_click_through)
            self.hit_timer.start(60)

        def begin_drag(self, event: Any) -> bool:
            if event.button() != Qt.MouseButton.LeftButton:
                return False

            self.left_down = True
            self.drag_guard_until = time.monotonic() + 0.9
            self.set_click_through(False)

            if self.start_native_drag():
                self.left_down = False
                self.is_dragging = False
                self.drag_origin = None
                self.window_origin = None
                self.drag_guard_until = time.monotonic() + 0.35
                return True

            self.drag_origin = event.globalPosition().toPoint()
            self.window_origin = self.pos()
            self.is_dragging = True
            return True

        def update_drag(self, event: Any) -> None:
            if self.left_down and self.drag_origin is not None and self.window_origin is not None:
                delta = event.globalPosition().toPoint() - self.drag_origin
                self.move(self.window_origin + delta)

        def end_drag(self) -> None:
            self.drag_origin = None
            self.window_origin = None
            self.is_dragging = False
            self.left_down = False
            self.drag_guard_until = time.monotonic() + 0.12

        def start_native_drag(self) -> bool:
            # Prefer Qt's system move for frameless windows; fallback to Win32 message drag.
            handle = self.windowHandle()
            if handle is not None:
                try:
                    started = handle.startSystemMove()
                    if started:
                        return True
                except Exception:
                    pass

            if platform.system() != "Windows":
                return False
            try:
                user32 = ctypes.windll.user32
                user32.ReleaseCapture()
                wm_nclbuttondown = 0x00A1
                htcaption = 0x0002
                user32.SendMessageW(int(self.winId()), wm_nclbuttondown, htcaption, 0)
                return True
            except Exception:
                return False

        def update_click_through(self) -> None:
            if platform.system() != "Windows" or self.left_down or time.monotonic() < self.drag_guard_until:
                return
            cursor = QCursor.pos()
            local = self.mapFromGlobal(cursor)
            self.set_click_through(not self.is_interactive_point(local))

        def is_interactive_point(self, point: QPoint) -> bool:
            if point.x() < 0 or point.y() < 0 or point.x() >= self.width() or point.y() >= self.height():
                return False

            width = max(1, self.width())
            height = max(1, self.height())
            center_x = width / 2
            center_y = height - min(150, height * 0.28)
            radius_x = width * 0.25
            radius_y = height * 0.22
            dx = (point.x() - center_x) / radius_x
            dy = (point.y() - center_y) / radius_y
            body_hit = dx * dx + dy * dy <= 1.0
            menu_hit = point.y() > height - 62 and width * 0.40 <= point.x() <= width * 0.60
            return body_hit or menu_hit

        def set_click_through(self, enabled: bool) -> None:
            if platform.system() != "Windows" or enabled == self.is_click_through:
                return
            hwnd = int(self.winId())
            gexstyle = -20
            ws_ex_layered = 0x00080000
            ws_ex_transparent = 0x00000020
            swp_no_size = 0x0001
            swp_no_move = 0x0002
            swp_no_zorder = 0x0004
            swp_no_activate = 0x0010
            swp_framechanged = 0x0020
            user32 = ctypes.windll.user32
            get_window_long = user32.GetWindowLongPtrW if hasattr(user32, "GetWindowLongPtrW") else user32.GetWindowLongW
            set_window_long = user32.SetWindowLongPtrW if hasattr(user32, "SetWindowLongPtrW") else user32.SetWindowLongW
            style = int(get_window_long(hwnd, gexstyle)) | ws_ex_layered
            if enabled:
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
            self.is_click_through = enabled

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(True)
    window = PetWindow()
    screen = app.primaryScreen().availableGeometry()
    window.move(screen.right() - args.width - 80, screen.bottom() - args.height - 60)
    window.show()
    if args.debug:
        window.view.page().setDevToolsPage(window.view.page())
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
