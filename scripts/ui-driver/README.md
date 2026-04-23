# UI driver — pywinauto wrapper

HTTP API on top of [pywinauto](https://pywinauto.readthedocs.io/) that
lets you list, click, and read controls in the EB Tester VB6 app from
outside the Python process (curl, an MCP client, anything).

The driver is a thin shim. Real control resolution happens in pywinauto
itself — see its docs for the full selector vocabulary.

## Install

Python 3.11+ with [uv](https://docs.astral.sh/uv/) is the smoothest path.
All `pywinauto` packaging quirks are hidden behind `uv`.

```powershell
# Inside scripts/ui-driver/
uv venv
uv pip install -r requirements.txt

# Run it
uv run python driver.py --help
uv run python driver.py                           # listens on :49701
uv run python driver.py --auto-attach "EB Tester"
```

If you'd rather use plain pip:

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python driver.py
```

## Backends

pywinauto has two backends:

- **`win32` (default)** — uses Win32/MSAA. Reliable for VB6's Thunder*
  controls. This is what you want.
- **`uia`** — modern UI Automation. Sometimes finds controls the win32
  backend misses, but often shows VB6 apps as an opaque blob of
  `Custom` controls. Try only if `win32` fails you.

Override with `--backend uia`.

## Quick tour

With the VB6 app running:

```bash
# Find the window
curl -s http://127.0.0.1:49701/windows | python -m json.tool

# Attach to it (regex on the title)
curl -s -X POST http://127.0.0.1:49701/attach \
  -H 'content-type: application/json' \
  -d '{"title_re":"EB.*Tester"}' | python -m json.tool

# Dump every control so you know what you can poke
curl -s http://127.0.0.1:49701/controls | python -m json.tool

# Click a button by its caption
curl -s -X POST http://127.0.0.1:49701/click \
  -H 'content-type: application/json' \
  -d '{"title":"Start"}'

# Read a label (what's the voltage display showing?)
curl -s -X POST http://127.0.0.1:49701/read_text \
  -H 'content-type: application/json' \
  -d '{"best_match":"lblVoltage"}'

# Type into a field
curl -s -X POST http://127.0.0.1:49701/set_text \
  -H 'content-type: application/json' \
  -d '{"best_match":"txtCurrent","text":"1.50"}'

# Grab a PNG screenshot of the window
curl -s http://127.0.0.1:49701/screenshot -o window.png
```

## Control selectors

Any endpoint that operates on a control accepts one or more of:

| Field           | Meaning                                                    |
|-----------------|------------------------------------------------------------|
| `auto_id`       | Windows AutomationId (rare on VB6, common on WPF/.NET)     |
| `title`         | Exact window text / control caption                        |
| `title_re`      | Regex over window text                                     |
| `class_name`    | Win32 window class (`ThunderRT6CommandButton`, etc.)       |
| `control_type`  | UIA control type name (e.g. `Button`, `Edit`)              |
| `best_match`    | Fuzzy pywinauto match on caption / label / class           |

You usually want `title` or `best_match`. `best_match` is forgiving of
whitespace and casing.

## Combining with the fake device

Nothing in this driver knows about the fake device and vice versa — they
share no state. The integration happens in whatever drives them:

```
while exploring:
  screenshot = GET ui-driver:49701/screenshot
  before_log = GET fake-device:49700/log?limit=1
  POST ui-driver:49701/click {title: "Start"}
  sleep 0.5
  after_log  = GET fake-device:49700/log?limit=10
  # diff before_log and after_log to see what the click transmitted
```

## Helper scripts

Alongside the HTTP driver there are small single-shot scripts that use
the same pywinauto venv. They're for cases the HTTP API doesn't cover
cleanly — driving ComboBoxes, TabStrips, enumerating hidden forms, and
reading the menu bar.

Run them with the venv's Python, e.g.
`scripts\ui-driver\.venv\Scripts\python.exe scripts\ui-driver\<script>.py …`.

| Script | What it does |
|--------|--------------|
| `printwindow_capture.py <hwnd> <out.png>` | PrintWindow-based screenshot — works when the session is locked or the window is occluded. Use whenever `/screenshot` might fail. |
| `combo_select.py <main_hwnd> <combo_hwnd> <index\|text>` | Select a ThunderRT6ComboBox item via pywinauto's `ComboBoxWrapper.select()` (which also fires the VB6 `_Change` event, unlike raw `CB_SETCURSEL`). |
| `tab_select.py <main_hwnd> <tab_hwnd> <index\|text>` | Native `TCM_SETCURSEL` tab switch. Works for native `SysTabControl32`; not for MSCOMCTL `TabStrip20WndClass` — use `tab_click.py` instead. |
| `tab_click.py <main_hwnd> <tab_hwnd> <index>` | PostMessage WM_LBUTTON click on a tab header at computed coordinates. Use for MSCOMCTL `TabStrip20WndClass` (the right-hand Single/Cycle Test tabs). Also accepts `--x / --y` for explicit in-strip coords. |
| `enum_children.py <hwnd>` | Recursive control dump as JSON. Works on any top-level window — including hidden sub-dialogs like the Parameter Calibration form — without needing to show them first. |
| `enum_menus.py <hwnd>` | Read the menu bar tree via Win32 `GetMenu` / `GetMenuItemInfoW`. Non-invasive — no focus change, no events. |

## Known rough edges

- **Modal dialogs will stall the driver.** If the app raises a message
  box, pywinauto operations on the parent window can block until it's
  dismissed. The `/quit` endpoint still works — use it if stuck.
- **VB6 owner-drawn controls** (the big graph panel, maybe the mode
  buttons) may not expose child controls to either backend. Fall back
  to screenshots + OCR, or click by window rectangle coordinates.
- **TX6-family Thunder controls** sometimes report `class_name` as
  `ThunderRT6UserControlDC` with no `title`. Use `best_match` or
  iterate by child index.
