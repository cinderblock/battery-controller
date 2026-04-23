# Probe captures

Output of `bun run scripts/probe-devices.ts`. Each probe run is a
self-contained, timestamped directory holding:

```
scripts/probes/<YYYY-MM-DD_HH-MM-SS>-<axis>/
├── config.json           CLI args + service snapshot at run start
├── probe-log.jsonl       one JSON line per probe (see schema below)
└── screenshots/
    └── probe-<axis>-0xXX_t0xYY_s0xZZ_c0xWW.png
```

The run directories themselves are gitignored (too large to commit) but
this README and any post-run summaries that get generated here stay
tracked.

## Probe log entry shape

Each line in `probe-log.jsonl`:

```ts
{
  idx: number,           // 0-based index within this sweep
  byte14: number,        // raw byte value sent as deviceTypeByte
  byte15: number,        //                      deviceSubtypeByte
  byte16: number,        //                      deviceConstantByte
  screenshot: string,    // path relative to the run dir (e.g. "screenshots/…png")
  screenshotBytes: number,
  windowTitle: string | null,  // EB Tester main-window title at capture time
  patchMs: number,       // how long /identity PATCH took
  screenshotMs: number,  // how long /screenshot took
  totalMs: number,       // patch + settle + screenshot + title read
  t: string,             // ISO timestamp of the probe start
  error?: string,        // present iff the probe failed
}
```

## Screenshot filename encoding

```
probe-<axis>-<sweptValue>_t<byte14>_s<byte15>_c<byte16>.png
              ─────────── the value that was varied
                         ─ byte 14 (deviceTypeByte, aka "type")
                                 ─ byte 15 (deviceSubtypeByte, aka "subtype")
                                           ─ byte 16 (deviceConstantByte, aka "deviceId")
```

All values are lowercase `0xhh`. Sorting filenames lexicographically
produces chronological order within an axis sweep.

## Next step

After a sweep, run the OCR pass (TODO — see
[`../../PLAN-ui-exploration.md`](../../PLAN-ui-exploration.md) task 1.2)
to extract the device-name string from each screenshot and produce the
final `byte → device` table. The OCR results get merged into
[`../device-table.json`](../device-table.json) and
[`../../protocol.md`](../../protocol.md).

## Capture fallback: PrintWindow

The UI driver's `/screenshot` endpoint uses `PIL.ImageGrab`, which
captures from the screen compositor. That fails when the Windows
session is locked (you get the lock-screen background instead of the
EB Tester window) and when another window occludes EB Tester.

For those cases there's a fallback capture tool at
[`../ui-driver/printwindow_capture.py`](../ui-driver/printwindow_capture.py)
that calls the Win32 `PrintWindow` API with `PW_RENDERFULLCONTENT`. It
asks the target window to paint itself into a memory DC, so it works
even when the session is locked, the window is off-screen, or another
window is on top.

```powershell
# Example: capture EB Tester main window (HWND from `GET /status`).
$py = 'scripts\ui-driver\.venv\Scripts\python.exe'
& $py scripts\ui-driver\printwindow_capture.py 0x1D0A70 out.png
```

A full PrintWindow-based sweep of `0xDD..0xEF` was run this way in
`2026-04-22_resweep3-dd-ef/`; the driver PowerShell script is
[`_resweep3_dd-ef.ps1`](./_resweep3_dd-ef.ps1).
