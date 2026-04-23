"""PrintWindow-based screenshot capture.

`PIL.ImageGrab` (used by pywinauto's `capture_as_image`) captures from the
screen compositor, which fails when the Windows session is locked: the
lock screen is drawn on top of everything and that is what we get.

The Win32 `PrintWindow` API is different — it instructs the target window
to paint itself into a supplied device context. It works even when the
window is occluded, off-screen, or the session is locked, because the
app does the painting (WM_PRINT / WM_PRINTCLIENT) into memory, not
through the screen compositor.

With the `PW_RENDERFULLCONTENT` flag (available on Windows 8.1+), DWM is
asked to render even composited/accelerated content, which matters for
some VB6 controls that use GDI+ primitives.

Usage:
    python printwindow_capture.py <hwnd-hex-or-dec> <out.png>

Example:
    python printwindow_capture.py 0x1D0A70 main.png
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

# User32
GetWindowRect = user32.GetWindowRect
GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
GetWindowRect.restype = wintypes.BOOL

GetDC = user32.GetDC
GetDC.argtypes = [wintypes.HWND]
GetDC.restype = wintypes.HDC

ReleaseDC = user32.ReleaseDC
ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
ReleaseDC.restype = ctypes.c_int

PrintWindow = user32.PrintWindow
PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]
PrintWindow.restype = wintypes.BOOL

# Gdi32
CreateCompatibleDC = gdi32.CreateCompatibleDC
CreateCompatibleDC.argtypes = [wintypes.HDC]
CreateCompatibleDC.restype = wintypes.HDC

CreateCompatibleBitmap = gdi32.CreateCompatibleBitmap
CreateCompatibleBitmap.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int]
CreateCompatibleBitmap.restype = wintypes.HBITMAP

SelectObject = gdi32.SelectObject
SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
SelectObject.restype = wintypes.HGDIOBJ

DeleteObject = gdi32.DeleteObject
DeleteObject.argtypes = [wintypes.HGDIOBJ]
DeleteObject.restype = wintypes.BOOL

DeleteDC = gdi32.DeleteDC
DeleteDC.argtypes = [wintypes.HDC]
DeleteDC.restype = wintypes.BOOL

# Flags for PrintWindow
PW_CLIENTONLY = 0x00000001
PW_RENDERFULLCONTENT = 0x00000002


def capture(hwnd: int, out_path: str, flags: int = PW_RENDERFULLCONTENT) -> tuple[int, int]:
    """Capture the given HWND to `out_path` as PNG. Returns (w, h)."""
    # Lazy-import PIL so the simple error message is clear if missing.
    from PIL import Image  # noqa: PLC0415

    r = wintypes.RECT()
    if not GetWindowRect(hwnd, ctypes.byref(r)):
        raise OSError(f"GetWindowRect failed, err={ctypes.get_last_error()}")
    w = r.right - r.left
    h = r.bottom - r.top
    if w <= 0 or h <= 0:
        raise ValueError(f"Window has zero size: {r.left},{r.top},{r.right},{r.bottom}")

    h_screen_dc = GetDC(None)
    if not h_screen_dc:
        raise OSError(f"GetDC(None) failed, err={ctypes.get_last_error()}")
    try:
        h_mem_dc = CreateCompatibleDC(h_screen_dc)
        if not h_mem_dc:
            raise OSError(f"CreateCompatibleDC failed, err={ctypes.get_last_error()}")
        h_bmp = CreateCompatibleBitmap(h_screen_dc, w, h)
        if not h_bmp:
            DeleteDC(h_mem_dc)
            raise OSError(f"CreateCompatibleBitmap failed, err={ctypes.get_last_error()}")
        old = SelectObject(h_mem_dc, h_bmp)
        try:
            if not PrintWindow(hwnd, h_mem_dc, flags):
                err = ctypes.get_last_error()
                # Some windows don't support PW_RENDERFULLCONTENT; fall back to 0.
                if flags != 0 and not PrintWindow(hwnd, h_mem_dc, 0):
                    raise OSError(f"PrintWindow failed, err={err}")

            # Convert HBITMAP to PIL.Image via GetDIBits.
            BI_RGB = 0
            class BITMAPINFOHEADER(ctypes.Structure):
                _fields_ = [
                    ("biSize", wintypes.DWORD),
                    ("biWidth", ctypes.c_long),
                    ("biHeight", ctypes.c_long),
                    ("biPlanes", wintypes.WORD),
                    ("biBitCount", wintypes.WORD),
                    ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD),
                    ("biXPelsPerMeter", ctypes.c_long),
                    ("biYPelsPerMeter", ctypes.c_long),
                    ("biClrUsed", wintypes.DWORD),
                    ("biClrImportant", wintypes.DWORD),
                ]

            class BITMAPINFO(ctypes.Structure):
                _fields_ = [
                    ("bmiHeader", BITMAPINFOHEADER),
                    ("bmiColors", wintypes.DWORD * 3),
                ]

            bi = BITMAPINFO()
            bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
            bi.bmiHeader.biWidth = w
            bi.bmiHeader.biHeight = -h  # negative = top-down
            bi.bmiHeader.biPlanes = 1
            bi.bmiHeader.biBitCount = 32
            bi.bmiHeader.biCompression = BI_RGB
            bi.bmiHeader.biSizeImage = 0

            buf_size = w * h * 4
            buf = (ctypes.c_ubyte * buf_size)()
            GetDIBits = gdi32.GetDIBits
            GetDIBits.argtypes = [
                wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
                ctypes.c_void_p, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
            ]
            GetDIBits.restype = ctypes.c_int
            DIB_RGB_COLORS = 0
            ok = GetDIBits(h_mem_dc, h_bmp, 0, h, ctypes.byref(buf),
                           ctypes.byref(bi), DIB_RGB_COLORS)
            if not ok:
                raise OSError(f"GetDIBits failed, err={ctypes.get_last_error()}")

            # BGRA → RGBA
            img = Image.frombuffer("RGBA", (w, h), bytes(buf), "raw", "BGRA", 0, 1)
            img.save(out_path, format="PNG")
            return w, h
        finally:
            SelectObject(h_mem_dc, old)
            DeleteObject(h_bmp)
            DeleteDC(h_mem_dc)
    finally:
        ReleaseDC(None, h_screen_dc)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    hwnd_arg = sys.argv[1]
    out = sys.argv[2]
    hwnd = int(hwnd_arg, 16) if hwnd_arg.lower().startswith("0x") else int(hwnd_arg)
    w, h = capture(hwnd, out)
    print(f"Captured {w}x{h} → {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
