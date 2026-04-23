"""
One-shot helper to select an item in a ThunderRT6ComboBox by index or by text.

Why this exists: the main driver.py only exposes /click, /set_text, /read_text.
None of those reliably drive VB6 ComboBoxes — set_text falls back to
type_keys which requires focus and can leave the dropdown open; CB_SETCURSEL
via raw SendMessage doesn't fire the CBN_SELCHANGE notification that VB6
code handlers expect. pywinauto's ComboBoxWrapper.select(item) does both
the CB_SETCURSEL and the parent-WM_COMMAND notification, so the VB6
_Change() handler fires and the dependent UI actually updates.

Usage:
    python combo_select.py <mainwindow_hwnd> <combo_hwnd> <index|text>

    # examples:
    python combo_select.py 0x1D0A70 0x174E20C 1         # by index
    python combo_select.py 0x1D0A70 0x174E20C "D-CC"    # by text

Exit code 0 on success, 1 on failure. Prints the resulting selected text.
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
        print("usage: combo_select.py <mainwindow_hwnd> <combo_hwnd> <index|text>", file=sys.stderr)
        return 2

    main_hwnd = parse_hwnd(sys.argv[1])
    combo_hwnd = parse_hwnd(sys.argv[2])
    selector = sys.argv[3]

    app = Application(backend="win32").connect(handle=main_hwnd)
    window = app.window(handle=main_hwnd)

    combo = window.child_window(handle=combo_hwnd).wrapper_object()

    # Try index first if input parses as an int; otherwise pass through as text.
    try:
        idx = int(selector)
        combo.select(idx)
        used = f"index={idx}"
    except ValueError:
        combo.select(selector)
        used = f"text={selector!r}"

    new_text = combo.window_text()
    try:
        items = combo.texts()
    except Exception:  # noqa: BLE001
        items = None

    print(f"selected: {used} -> {new_text!r}")
    if items is not None:
        print(f"texts(): {items}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
