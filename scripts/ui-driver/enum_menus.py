"""
Enumerate the menu tree of a window via Win32 API (GetMenu,
GetMenuItemCount, GetSubMenu, GetMenuStringW, GetMenuItemInfoW).

This reads MENU structure directly without opening/activating anything,
so it's safe against VB6 forms — no focus change, no events fired.

Usage:
    python enum_menus.py <hwnd>
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import json
import sys

user32 = ctypes.windll.user32

MF_POPUP = 0x00000010
MF_SEPARATOR = 0x00000800
MF_GRAYED = 0x00000001
MF_DISABLED = 0x00000002
MF_CHECKED = 0x00000008

MIIM_ID = 0x00000002
MIIM_TYPE = 0x00000010
MIIM_STATE = 0x00000001
MIIM_SUBMENU = 0x00000004
MIIM_FTYPE = 0x00000100
MIIM_STRING = 0x00000040

MFT_SEPARATOR = 0x00000800


class MENUITEMINFOW(ctypes.Structure):
    _fields_ = [
        ("cbSize", wt.UINT),
        ("fMask", wt.UINT),
        ("fType", wt.UINT),
        ("fState", wt.UINT),
        ("wID", wt.UINT),
        ("hSubMenu", wt.HMENU),
        ("hbmpChecked", wt.HBITMAP),
        ("hbmpUnchecked", wt.HBITMAP),
        ("dwItemData", ctypes.c_void_p),
        ("dwTypeData", wt.LPWSTR),
        ("cch", wt.UINT),
        ("hbmpItem", wt.HBITMAP),
    ]


GetMenu = user32.GetMenu
GetMenu.argtypes = [wt.HWND]
GetMenu.restype = wt.HMENU

GetMenuItemCount = user32.GetMenuItemCount
GetMenuItemCount.argtypes = [wt.HMENU]
GetMenuItemCount.restype = wt.INT

GetSubMenu = user32.GetSubMenu
GetSubMenu.argtypes = [wt.HMENU, wt.INT]
GetSubMenu.restype = wt.HMENU

GetMenuItemInfoW = user32.GetMenuItemInfoW
GetMenuItemInfoW.argtypes = [wt.HMENU, wt.UINT, wt.BOOL, ctypes.POINTER(MENUITEMINFOW)]
GetMenuItemInfoW.restype = wt.BOOL


def get_item_text(hmenu, pos):
    # Two-pass: first with cch=0 to get length, then allocate buffer.
    mii = MENUITEMINFOW()
    mii.cbSize = ctypes.sizeof(MENUITEMINFOW)
    mii.fMask = MIIM_STRING | MIIM_FTYPE | MIIM_STATE | MIIM_ID | MIIM_SUBMENU
    mii.dwTypeData = None
    mii.cch = 0
    if not GetMenuItemInfoW(hmenu, pos, True, ctypes.byref(mii)):
        return None, mii
    # Now reserve buffer
    length = mii.cch + 1
    buf = ctypes.create_unicode_buffer(length)
    mii2 = MENUITEMINFOW()
    mii2.cbSize = ctypes.sizeof(MENUITEMINFOW)
    mii2.fMask = MIIM_STRING | MIIM_FTYPE | MIIM_STATE | MIIM_ID | MIIM_SUBMENU
    mii2.dwTypeData = ctypes.cast(buf, wt.LPWSTR)
    mii2.cch = length
    if not GetMenuItemInfoW(hmenu, pos, True, ctypes.byref(mii2)):
        return None, mii
    return buf.value, mii2


def walk_menu(hmenu, depth=0):
    if not hmenu:
        return []
    count = GetMenuItemCount(hmenu)
    items = []
    for i in range(count):
        text, info = get_item_text(hmenu, i)
        sub = info.hSubMenu if info else 0
        ftype = info.fType if info else 0
        state = info.fState if info else 0
        item = {
            "pos": i,
            "id": info.wID if info else None,
            "text": text,
            "separator": bool(ftype & MFT_SEPARATOR),
            "grayed": bool(state & MF_GRAYED),
            "disabled": bool(state & MF_DISABLED),
            "checked": bool(state & MF_CHECKED),
            "submenu": bool(sub),
        }
        if sub:
            item["children"] = walk_menu(sub, depth + 1)
        items.append(item)
    return items


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: enum_menus.py <hwnd>", file=sys.stderr)
        return 2
    s = sys.argv[1].strip()
    hwnd = int(s, 16) if s.lower().startswith("0x") else int(s)
    hmenu = GetMenu(hwnd)
    if not hmenu:
        print(json.dumps({"error": "window has no menu bar", "hwnd": hwnd}, indent=2))
        return 1
    tree = walk_menu(hmenu)
    print(json.dumps({"hwnd": hwnd, "hmenu": hmenu, "items": tree}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
