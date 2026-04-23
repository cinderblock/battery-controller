"""
Enumerate all descendant controls of an arbitrary HWND. Useful for peeking
at hidden sub-dialogs without having to show them.

Usage:
    python enum_children.py <hwnd>
"""

from __future__ import annotations

import json
import sys

from pywinauto import Application


def parse_hwnd(s: str) -> int:
    s = s.strip()
    if s.lower().startswith("0x"):
        return int(s, 16)
    return int(s)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: enum_children.py <hwnd>", file=sys.stderr)
        return 2

    hwnd = parse_hwnd(sys.argv[1])
    app = Application(backend="win32").connect(handle=hwnd)
    window = app.window(handle=hwnd)

    out = []

    def walk(elem, depth):
        try:
            rect = elem.rectangle()
            r = [rect.left, rect.top, rect.right, rect.bottom]
        except Exception:  # noqa: BLE001
            r = None
        out.append({
            "depth": depth,
            "handle": elem.handle,
            "class_name": getattr(elem, "class_name", lambda: None)(),
            "title": getattr(elem, "window_text", lambda: None)(),
            "visible": getattr(elem, "is_visible", lambda: None)(),
            "enabled": getattr(elem, "is_enabled", lambda: None)(),
            "rect": r,
        })
        try:
            for c in elem.children():
                walk(c, depth + 1)
        except Exception:  # noqa: BLE001
            pass

    walk(window.wrapper_object(), 0)
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
