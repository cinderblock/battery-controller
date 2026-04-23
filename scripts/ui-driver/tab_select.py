"""
One-shot helper to select a tab in a TabStrip20WndClass by index or by text.

Usage:
    python tab_select.py <mainwindow_hwnd> <tabstrip_hwnd> <index|text>

    # examples:
    python tab_select.py 0x1D0A70 0x821D0C 1              # by index
    python tab_select.py 0x1D0A70 0x821D0C "Cycle Test"   # by text

Prints the list of tab texts after the switch. Exit 0 on success.
"""

from __future__ import annotations

import sys

from pywinauto import Application


def parse_hwnd(s: str) -> int:
    s = s.strip()
    if s.lower().startswith("0x"):
        return int(s, 16)
    return int(s)


def main() -> int:
    if len(sys.argv) != 4:
        print(
            "usage: tab_select.py <mainwindow_hwnd> <tabstrip_hwnd> <index|text>",
            file=sys.stderr,
        )
        return 2

    main_hwnd = parse_hwnd(sys.argv[1])
    tab_hwnd = parse_hwnd(sys.argv[2])
    selector = sys.argv[3]

    app = Application(backend="win32").connect(handle=main_hwnd)
    window = app.window(handle=main_hwnd)
    tab = window.child_window(handle=tab_hwnd).wrapper_object()

    # Try pywinauto's TabControlWrapper.select() first; fall back to TCM_SETCURSEL.
    try:
        try:
            idx = int(selector)
            tab.select(idx)
            used = f"index={idx}"
        except ValueError:
            tab.select(selector)
            used = f"text={selector!r}"
    except Exception as exc:  # noqa: BLE001
        print(f"pywinauto select failed, raw TCM_SETCURSEL fallback: {exc}", file=sys.stderr)
        import ctypes

        TCM_SETCURSEL = 0x1330  # 0x1300 + 0x30
        try:
            idx = int(selector)
        except ValueError:
            # Find index by scanning tab texts
            count = tab.tab_count() if hasattr(tab, "tab_count") else 0
            idx = -1
            for i in range(count):
                try:
                    t = tab.get_tab_text(i)
                except Exception:  # noqa: BLE001
                    t = None
                if t == selector:
                    idx = i
                    break
            if idx < 0:
                print(f"tab text {selector!r} not found", file=sys.stderr)
                return 1
        ctypes.windll.user32.SendMessageW(tab_hwnd, TCM_SETCURSEL, idx, 0)
        used = f"fallback-index={idx}"

    # Enumerate resulting tabs
    try:
        texts = tab.texts()
    except Exception:  # noqa: BLE001
        texts = None

    print(f"selected: {used}")
    if texts:
        print(f"texts(): {texts}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
