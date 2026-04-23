"""
Click a tab header in an ActiveX TabStrip20WndClass by clicking at screen
coordinates. The TabStrip's native messages (TCM_SETCURSEL) do not work on
MSCOMCTL TabStrip (it is an OLE control, not a native TabControl), and
pywinauto exposes no `.select()` for this class. Clicking the header pixel
is the reliable path.

Usage:
    python tab_click.py <mainwindow_hwnd> <tabstrip_hwnd> <tab_index>

    The tab_index is 0-based (0 = leftmost tab). The tab-header row is
    assumed to be at the TabStrip's top edge, about 36 physical pixels
    tall. Each tab header is assumed to occupy an equal slice; for a
    2-tab strip (e.g. Single Test / Cycle Test) this is accurate enough.
    For strips with many tabs it will miss — in that case pass explicit
    coordinates via --x/--y.
"""

from __future__ import annotations

import argparse
import sys

from pywinauto import Application


def parse_hwnd(s: str) -> int:
    s = s.strip()
    if s.lower().startswith("0x"):
        return int(s, 16)
    return int(s)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("main_hwnd")
    ap.add_argument("tab_hwnd")
    ap.add_argument("tab_index", type=int, nargs="?", default=None)
    ap.add_argument("--tab-count", type=int, default=2, help="total number of tab headers to divide the strip by (default 2)")
    ap.add_argument("--header-h", type=int, default=36, help="tab-header row height in physical pixels (default 36)")
    ap.add_argument("--x", type=int, default=None, help="explicit x coord within TabStrip rect (overrides tab_index)")
    ap.add_argument("--y", type=int, default=None, help="explicit y coord within TabStrip rect (overrides tab_index)")
    args = ap.parse_args()

    main_hwnd = parse_hwnd(args.main_hwnd)
    tab_hwnd = parse_hwnd(args.tab_hwnd)

    app = Application(backend="win32").connect(handle=main_hwnd)
    window = app.window(handle=main_hwnd)
    tab = window.child_window(handle=tab_hwnd).wrapper_object()

    rect = tab.rectangle()  # screen coords

    if args.x is not None and args.y is not None:
        x_in_strip = args.x
        y_in_strip = args.y
        label = f"explicit=({x_in_strip},{y_in_strip})"
    else:
        if args.tab_index is None:
            print("error: must provide tab_index or both --x and --y", file=sys.stderr)
            return 2
        width = rect.right - rect.left
        slice_w = width // args.tab_count
        # Click center of the target slice in the header row
        x_in_strip = slice_w * args.tab_index + slice_w // 2
        y_in_strip = args.header_h // 2  # middle of header row
        label = f"tab#{args.tab_index} coords=({x_in_strip},{y_in_strip})"

    # .click() (no _input) uses PostMessage WM_LBUTTON* — works through
    # locked screen and without bringing the window to the foreground.
    tab.click(coords=(x_in_strip, y_in_strip))

    print(f"clicked {label} within rect={rect}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
