package com.agenticrag.pet;

import com.sun.jna.Native;
import com.sun.jna.Platform;
import com.sun.jna.Pointer;
import com.sun.jna.platform.win32.Kernel32;
import com.sun.jna.platform.win32.User32;
import com.sun.jna.platform.win32.WinDef;
import com.sun.jna.platform.win32.WinDef.HWND;
import com.sun.jna.platform.win32.WinDef.RECT;
import com.sun.jna.platform.win32.WinUser;
import com.sun.jna.ptr.IntByReference;

import java.util.ArrayList;
import java.util.List;

public class NativeWindowController {
    private static final int GWL_EXSTYLE = -20;
    private static final int WS_EX_TOOLWINDOW = 0x00000080;
    private static final int WS_EX_APPWINDOW = 0x00040000;
    private static final int WS_EX_TOPMOST = 0x00000008;
    private static final HWND HWND_TOPMOST = new HWND(new Pointer(-1L));

    public boolean isWindows() {
        return Platform.isWindows();
    }

    public void configurePetWindow(long hwndValue, boolean topmost, boolean hideTaskbar) {
        if (!isWindows() || hwndValue == 0L) {
            return;
        }
        configurePetWindow(toHwnd(hwndValue), topmost, hideTaskbar);
    }

    public void configurePetWindow(String windowTitle, boolean topmost, boolean hideTaskbar) {
        if (!isWindows()) {
            return;
        }

        HWND hwnd = findWindow(windowTitle);
        if (hwnd == null) {
            return;
        }

        configurePetWindow(hwnd, topmost, hideTaskbar);
    }

    public void configureCurrentProcessPetWindows(String windowTitle, boolean topmost, boolean hideTaskbar) {
        if (!isWindows()) {
            return;
        }
        for (HWND hwnd : findCurrentProcessWindows(windowTitle)) {
            configurePetWindow(hwnd, topmost, hideTaskbar);
        }
    }

    public void keepTopmost(long hwndValue) {
        if (!isWindows() || hwndValue == 0L) {
            return;
        }
        User32.INSTANCE.SetWindowPos(
                toHwnd(hwndValue),
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                WinUser.SWP_NOMOVE | WinUser.SWP_NOSIZE | WinUser.SWP_NOACTIVATE
        );
    }

    public void keepCurrentProcessPetWindowsTopmost(String windowTitle) {
        if (!isWindows()) {
            return;
        }
        for (HWND hwnd : findCurrentProcessWindows(windowTitle)) {
            User32.INSTANCE.SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    WinUser.SWP_NOMOVE | WinUser.SWP_NOSIZE | WinUser.SWP_NOACTIVATE
            );
        }
    }

    public int[] getWindowTopLeft(long hwndValue) {
        if (!isWindows() || hwndValue == 0L) {
            return null;
        }

        RECT rect = new RECT();
        boolean ok = User32.INSTANCE.GetWindowRect(toHwnd(hwndValue), rect);
        if (!ok) {
            return null;
        }
        return new int[]{rect.left, rect.top};
    }

    public int[] getCursorPosition() {
        if (!isWindows()) {
            return null;
        }
        WinDef.POINT point = new WinDef.POINT();
        boolean ok = User32.INSTANCE.GetCursorPos(point);
        if (!ok) {
            return null;
        }
        return new int[]{point.x, point.y};
    }

    public boolean moveWindowTo(long hwndValue, int x, int y) {
        if (!isWindows() || hwndValue == 0L) {
            return false;
        }
        return User32.INSTANCE.SetWindowPos(
                toHwnd(hwndValue), null, x, y, 0, 0,
                WinUser.SWP_NOSIZE | WinUser.SWP_NOZORDER | WinUser.SWP_NOACTIVATE
        );
    }

    public void setClickThrough(long hwndValue, boolean enabled) {
        if (!isWindows() || hwndValue == 0L) {
            return;
        }
        setClickThrough(toHwnd(hwndValue), enabled);
    }

    public void setClickThrough(String windowTitle, boolean enabled) {
        if (!isWindows()) {
            return;
        }

        HWND hwnd = findWindow(windowTitle);
        if (hwnd == null) {
            return;
        }

        setClickThrough(hwnd, enabled);
    }

    private void configurePetWindow(HWND hwnd, boolean topmost, boolean hideTaskbar) {
        int style = User32.INSTANCE.GetWindowLong(hwnd, GWL_EXSTYLE);
        style |= WinUser.WS_EX_LAYERED;

        if (hideTaskbar) {
            style = (style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
        }
        if (topmost) {
            style |= WS_EX_TOPMOST;
        }

        User32.INSTANCE.SetWindowLong(hwnd, GWL_EXSTYLE, style);
        refreshFrame(hwnd);

        if (topmost) {
            User32.INSTANCE.SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    WinUser.SWP_NOMOVE | WinUser.SWP_NOSIZE | WinUser.SWP_NOACTIVATE
            );
        }
    }

    private void setClickThrough(HWND hwnd, boolean enabled) {
        int style = User32.INSTANCE.GetWindowLong(hwnd, GWL_EXSTYLE);
        style |= WinUser.WS_EX_LAYERED;
        if (enabled) {
            style |= WinUser.WS_EX_TRANSPARENT;
        } else {
            style &= ~WinUser.WS_EX_TRANSPARENT;
        }

        User32.INSTANCE.SetWindowLong(hwnd, GWL_EXSTYLE, style);
        refreshFrame(hwnd);
    }

    private HWND toHwnd(long hwndValue) {
        return new HWND(Pointer.createConstant(hwndValue));
    }

    private List<HWND> findCurrentProcessWindows(String title) {
        int currentProcessId = Kernel32.INSTANCE.GetCurrentProcessId();
        List<HWND> windows = new ArrayList<>();

        User32.INSTANCE.EnumWindows((hwnd, data) -> {
            if (!User32.INSTANCE.IsWindowVisible(hwnd)) {
                return true;
            }

            IntByReference processId = new IntByReference();
            User32.INSTANCE.GetWindowThreadProcessId(hwnd, processId);
            if (processId.getValue() != currentProcessId) {
                return true;
            }

            String windowText = getWindowText(hwnd);
            if (title == null || title.isEmpty() || title.equals(windowText)) {
                windows.add(hwnd);
            }
            return true;
        }, null);

        return windows;
    }

    private String getWindowText(HWND hwnd) {
        char[] text = new char[512];
        User32.INSTANCE.GetWindowText(hwnd, text, text.length);
        return Native.toString(text);
    }

    private HWND findWindow(String title) {
        for (int i = 0; i < 20; i++) {
            HWND hwnd = User32.INSTANCE.FindWindow(null, title);
            if (hwnd != null) {
                return hwnd;
            }
            sleep(40);
        }
        return null;
    }

    private void refreshFrame(HWND hwnd) {
        User32.INSTANCE.SetWindowPos(
                hwnd,
                null,
                0,
                0,
                0,
                0,
                WinUser.SWP_NOMOVE
                        | WinUser.SWP_NOSIZE
                        | WinUser.SWP_NOZORDER
                        | WinUser.SWP_NOACTIVATE
                        | WinUser.SWP_FRAMECHANGED
        );
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
