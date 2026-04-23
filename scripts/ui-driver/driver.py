"""
UI driver for the EB Tester VB6 app.

Exposes a small HTTP API on top of pywinauto so an external controller
(an LLM, a script, a human with curl) can enumerate controls, click
buttons, read labels, and screenshot the application window.

We use pywinauto's `win32` backend because VB6 uses Thunder* window
classes that the older MSAA-based backend handles more reliably than
the modern UIA backend. You can override with `--backend uia` if
something doesn't show up.

Run:
    uv run python scripts/ui-driver/driver.py --help
    uv run python scripts/ui-driver/driver.py            # default: :49701

See scripts/ui-driver/README.md for setup.
"""

from __future__ import annotations

import argparse
import io
import logging
import sys
import threading
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from pywinauto import Application, Desktop
from pywinauto.findwindows import ElementNotFoundError

log = logging.getLogger("ui-driver")

# ── Global app state ──────────────────────────────────────────────────

# pywinauto Application object (or None if not attached)
_app: Application | None = None
# The selected top-level window element
_window: Any | None = None
_backend: str = "win32"
_lock = threading.RLock()


def get_window() -> Any:
    """Return the currently attached window, or 400 if not attached."""
    with _lock:
        if _window is None:
            raise HTTPException(
                status_code=400,
                detail="Not attached. POST /attach or /launch first.",
            )
        return _window


# ── Request models ────────────────────────────────────────────────────


class AttachRequest(BaseModel):
    title: str | None = None
    title_re: str | None = None  # regex
    class_name: str | None = None
    process: int | None = None


class LaunchRequest(BaseModel):
    exe_path: str
    wait_title_re: str | None = None
    timeout: float = 20.0


class ControlSelector(BaseModel):
    auto_id: str | None = None
    title: str | None = None
    title_re: str | None = None
    class_name: str | None = None
    control_type: str | None = None  # for UIA backend
    # Positional fallback: "Button #3" etc.
    best_match: str | None = None
    # Disambiguators when the above match multiple controls. Essential
    # for VB6 where a caption like "Start" appears on several panels.
    handle: int | None = None  # exact HWND
    found_index: int | None = None  # Nth match among otherwise-identical criteria

    def kwargs(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.auto_id:
            out["auto_id"] = self.auto_id
        if self.title:
            out["title"] = self.title
        if self.title_re:
            out["title_re"] = self.title_re
        if self.class_name:
            out["class_name"] = self.class_name
        if self.control_type:
            out["control_type"] = self.control_type
        if self.best_match:
            out["best_match"] = self.best_match
        if self.handle is not None:
            out["handle"] = self.handle
        if self.found_index is not None:
            out["found_index"] = self.found_index
        if not out:
            raise HTTPException(
                status_code=400,
                detail="Provide at least one of auto_id / title / title_re / class_name / control_type / best_match / handle / found_index.",
            )
        return out


class ClickRequest(ControlSelector):
    button: str = "left"  # "left" | "right" | "middle"
    double: bool = False
    # "message" — BM_CLICK via SendMessage (click()); works off-screen and
    #             regardless of window focus/DPI. Preferred for VB6.
    # "input"   — real mouse event via click_input(); needs the window
    #             visible on-screen at its reported coordinates. Brittle
    #             on multi-monitor / HiDPI, and doesn't always reach
    #             VB6 handlers.
    # "auto"    — try message first, fall back to input.
    method: str = "message"


class SetTextRequest(ControlSelector):
    text: str


# ── FastAPI app ───────────────────────────────────────────────────────

api = FastAPI(title="EB Tester UI driver")


@api.get("/")
def root() -> dict[str, Any]:
    with _lock:
        attached = _window is not None
        title = None
        pid = None
        if attached:
            try:
                title = _window.window_text()
                pid = _window.process_id()
            except Exception as exc:  # noqa: BLE001
                title = f"<error: {exc}>"
    return {
        "name": "EB Tester UI driver",
        "backend": _backend,
        "attached": attached,
        "window_title": title,
        "pid": pid,
        "endpoints": [
            "GET  /status",
            "GET  /windows",
            "POST /attach    {title?|title_re?|class_name?|process?}",
            "POST /launch    {exe_path, wait_title_re?, timeout?}",
            "POST /detach",
            "GET  /controls  (flat list, attached window)",
            "POST /click     {auto_id?|title?|...}",
            "POST /set_text  {text, auto_id?|title?|...}",
            "POST /read_text {auto_id?|title?|...}",
            "GET  /screenshot (image/png)",
            "POST /quit      close the app",
        ],
    }


@api.get("/status")
def status() -> dict[str, Any]:
    return root()


@api.get("/windows")
def list_windows() -> list[dict[str, Any]]:
    """List all top-level windows currently visible on the desktop."""
    out: list[dict[str, Any]] = []
    for w in Desktop(backend=_backend).windows():
        try:
            out.append(
                {
                    "title": w.window_text(),
                    "class_name": w.class_name(),
                    "process_id": w.process_id(),
                    "handle": w.handle,
                    "visible": bool(w.is_visible()),
                }
            )
        except Exception as exc:  # noqa: BLE001
            out.append({"error": str(exc)})
    return out


@api.post("/attach")
def attach(req: AttachRequest) -> dict[str, Any]:
    global _app, _window
    kwargs: dict[str, Any] = {}
    if req.title:
        kwargs["title"] = req.title
    if req.title_re:
        kwargs["title_re"] = req.title_re
    if req.class_name:
        kwargs["class_name"] = req.class_name
    if req.process:
        kwargs["process"] = req.process
    if not kwargs:
        raise HTTPException(400, "Provide at least one of title / title_re / class_name / process.")

    try:
        app = Application(backend=_backend).connect(**kwargs)
        window = app.window(**kwargs) if (req.title or req.title_re or req.class_name) else app.top_window()
        # Force realization so subsequent calls are fast
        window.wait("exists enabled visible", timeout=10)
    except ElementNotFoundError as exc:
        raise HTTPException(404, f"No matching window: {exc}") from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Attach failed: {exc}") from exc

    with _lock:
        _app = app
        _window = window
    return status()


@api.post("/launch")
def launch(req: LaunchRequest) -> dict[str, Any]:
    global _app, _window
    try:
        app = Application(backend=_backend).start(req.exe_path, timeout=req.timeout)
        if req.wait_title_re:
            window = app.window(title_re=req.wait_title_re)
            window.wait("exists enabled visible", timeout=req.timeout)
        else:
            window = app.top_window()
            window.wait("exists enabled visible", timeout=req.timeout)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Launch failed: {exc}") from exc

    with _lock:
        _app = app
        _window = window
    return status()


@api.post("/detach")
def detach() -> dict[str, Any]:
    global _app, _window
    with _lock:
        _app = None
        _window = None
    return status()


@api.get("/controls")
def controls() -> list[dict[str, Any]]:
    """Recursively enumerate every control in the attached window."""
    w = get_window()
    out: list[dict[str, Any]] = []

    def walk(elem: Any, depth: int) -> None:
        try:
            info: dict[str, Any] = {
                "depth": depth,
                "handle": getattr(elem, "handle", None),
                "class_name": elem.class_name() if hasattr(elem, "class_name") else None,
                "title": elem.window_text() if hasattr(elem, "window_text") else None,
                "auto_id": getattr(elem, "automation_id", lambda: None)(),
                "control_type": getattr(elem, "friendly_class_name", lambda: None)(),
                "rect": None,
                "visible": None,
                "enabled": None,
            }
            try:
                rect = elem.rectangle()
                info["rect"] = [rect.left, rect.top, rect.right, rect.bottom]
            except Exception:  # noqa: BLE001, S110
                pass
            try:
                info["visible"] = bool(elem.is_visible())
            except Exception:  # noqa: BLE001, S110
                pass
            try:
                info["enabled"] = bool(elem.is_enabled())
            except Exception:  # noqa: BLE001, S110
                pass
            out.append(info)
        except Exception as exc:  # noqa: BLE001
            out.append({"depth": depth, "error": str(exc)})
            return
        try:
            for child in elem.children():
                walk(child, depth + 1)
        except Exception:  # noqa: BLE001, S110
            pass

    walk(w, 0)
    return out


def _resolve_control(selector: ControlSelector) -> Any:
    w = get_window()
    try:
        return w.child_window(**selector.kwargs())
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(404, f"Control not found: {exc}") from exc


@api.post("/click")
def click(req: ClickRequest) -> dict[str, Any]:
    control = _resolve_control(req)
    # Snapshot the control's static info BEFORE clicking, because
    # `title`/`class_name` re-resolve the selector lazily, and the
    # click may change the caption (Connect → Disconn, Start → Stop,
    # etc), invalidating the selector for the post-click readback.
    before_title = _safe(control.window_text)
    before_class = _safe(control.class_name)

    def input_click() -> None:
        if req.double:
            control.double_click_input(button=req.button)
        else:
            control.click_input(button=req.button)

    def message_click() -> None:
        # click() (no _input) uses BM_CLICK / SendMessage and works even
        # when the window is off-screen or not focused. Only supports
        # left button, single click.
        if req.button != "left":
            raise ValueError("message click only supports button='left'")
        if req.double:
            control.double_click()
        else:
            control.click()

    used = req.method
    try:
        if req.method == "message":
            message_click()
        elif req.method == "auto":
            try:
                message_click()
                used = "message"
            except Exception as exc:  # noqa: BLE001
                log.warning("message click failed, falling back to input: %s", exc)
                input_click()
                used = "input"
        else:
            input_click()
            used = "input"
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Click failed ({used}): {exc}") from exc
    return {
        "clicked": req.model_dump(exclude_none=True),
        "method": used,
        "title": before_title,
        "class_name": before_class,
    }


@api.post("/set_text")
def set_text(req: SetTextRequest) -> dict[str, Any]:
    control = _resolve_control(req)
    try:
        # Prefer `set_edit_text` for Edit controls; fall back to type_keys.
        if hasattr(control, "set_edit_text"):
            control.set_edit_text(req.text)
        else:
            control.type_keys(req.text, with_spaces=True)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"set_text failed: {exc}") from exc
    return {"set": req.text, "title": _safe(control.window_text)}


@api.post("/read_text")
def read_text(req: ControlSelector) -> dict[str, Any]:
    control = _resolve_control(req)
    return {
        "title": _safe(control.window_text),
        "texts": _safe(control.texts) if hasattr(control, "texts") else None,
        "class_name": _safe(control.class_name),
    }


@api.get("/screenshot")
def screenshot(bring_to_front: bool = True) -> Response:
    """Capture the attached window as PNG.

    pywinauto's `capture_as_image()` internally calls `PIL.ImageGrab.grab(...)`
    against the window's screen-coordinate rectangle. If another window is
    in front (e.g. a terminal during automation), the grab returns the
    occluding content, not the target window. So by default we raise the
    target to the foreground before capturing. Pass `bring_to_front=false`
    to skip (useful if the caller has already arranged Z-order).
    """
    import time

    w = get_window()
    if bring_to_front:
        try:
            # If minimized, restore first so the window has a screen rect.
            try:
                if w.is_minimized():
                    w.restore()
            except Exception:  # noqa: BLE001, S110
                pass
            try:
                w.set_focus()
            except Exception:  # noqa: BLE001, S110
                # set_focus can fail on win32 for off-screen windows; fall back.
                try:
                    w.set_foreground()
                except Exception:  # noqa: BLE001, S110
                    pass
            # Give the compositor a beat to repaint before the grab.
            time.sleep(0.1)
        except Exception as exc:  # noqa: BLE001
            log.warning("bring_to_front failed (continuing): %s", exc)
    try:
        img = w.capture_as_image()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Screenshot failed: {exc}") from exc
    if img is None:
        raise HTTPException(500, "Screenshot returned no image (window may have zero size)")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")


@api.post("/quit")
def quit_app() -> dict[str, Any]:
    global _app, _window
    with _lock:
        if _app is None:
            raise HTTPException(400, "Not attached.")
        try:
            _app.kill()
        finally:
            _app = None
            _window = None
    return {"killed": True}


# ── Helpers ───────────────────────────────────────────────────────────


def _safe(fn: Any) -> Any:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        return f"<error: {exc}>"


# ── Entry point ───────────────────────────────────────────────────────


def main() -> int:
    global _backend
    parser = argparse.ArgumentParser(description="EB Tester UI driver (pywinauto + FastAPI)")
    parser.add_argument("--port", type=int, default=49701, help="HTTP API port (default: 49701)")
    parser.add_argument("--host", default="127.0.0.1", help="HTTP API host (default: 127.0.0.1)")
    parser.add_argument(
        "--backend",
        choices=("win32", "uia"),
        default="win32",
        help="pywinauto backend. win32 is usually best for VB6.",
    )
    parser.add_argument(
        "--auto-attach",
        help="Attach to a window whose title matches this regex on startup.",
    )
    args = parser.parse_args()

    _backend = args.backend
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    if args.auto_attach:
        try:
            attach(AttachRequest(title_re=args.auto_attach))
            log.info("Auto-attached to window matching %r", args.auto_attach)
        except HTTPException as exc:
            log.warning("Auto-attach failed (will run unattached): %s", exc.detail)

    log.info("UI driver listening on http://%s:%d  (backend=%s)", args.host, args.port, _backend)
    uvicorn.run(api, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
