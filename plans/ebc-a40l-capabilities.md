# EBC-A40L — UI capability enumeration (Step 1 ✅) & real-hardware protocol capture (Step 2)

Plan path: `plans/ebc-a40l-capabilities.md`

## Goal

Reach a **closed** understanding of the EBC-A40L's protocol surface:

1. **Step 1 — UI capability enumeration (✅ COMPLETE).** Identify every command the EB Tester VB6 UI can issue for the EBC-A40L: tabs, Modes, menu items, hidden dialogs.
2. **Step 2 — Real-hardware protocol capture (IN PROGRESS).** User is physically present with the real EBC-A40L. Capture the remaining commands live: D-CP, Calibration (open + cancel, no commit), Resistance Test, optional Cycle Test with Wait/Cycle.
3. Step 3 — Write findings into `protocol.md` + close out `PLAN-protocol-exercise.md`.

## Environment / context

- Windows working tree: `C:\Users\camer\git\Personal Projects\battery-controller`
- Fake-device control API: `http://127.0.0.1:49700` (process `bun run fake-device --com 7 --quiet`, pids 2152 & 30448)
- UI driver: `http://127.0.0.1:49701` (process attached to EB Tester pid **35808**, HWND `0x1D0A70`)
- Pi hostname: **`coulomb`** → `10.255.5.52` — **NOT** `raspberrypi.local` (that doesn't resolve). The literal string `raspberrypi.local` in `.env.example` / `src/run/config.ts` is a default; real deploys override via `DEPLOY_HOST` / `BRIDGE_HOST` env var.
- Pi TCP bridge: **`coulomb:49600` reachable, SSH on :22 reachable** as of 2026-04-22 14:34.
- EBC-A40L identity: `byte14=0x11 byte15=0x86 byte16=0x0A`.
- Capture method (UI): Win32 PrintWindow via `scripts/ui-driver/printwindow_capture.py` — works through locked screen.
- Artefact dir (Step 1): `scripts/probes/2026-04-22_ebc-a40l-capabilities/`.
- Artefact dir (Step 2): `recordings/` (JSONL auto-named by timestamp).

## Decisions already made (don't re-ask)

- Step 1 was UI-only, no hardware — user explicitly chose the three-step roadmap.
- Step 2 is authorised live against real hardware: *"I am here with the device now. We can run our tests on the real hardware while I'm here. Go for it."* (2026-04-22).
- Fake device stayed pinned at EBC-A40L identity through Step 1.
- PrintWindow (not `PIL.ImageGrab`) is the baseline UI capture method because the screen may lock.
- Clean `Disconn → PATCH identity → Connect` cycle required whenever identity changes. Not relevant in Step 2 (single device, one profile).
- **Do NOT click Save-to-disk, Delete, Firmware Update, or any button that opens a native modal** — modals block the UI driver.
- **Calibration test = open + inspect + Cancel only. Do NOT commit values.** (Would reprogram the device's cal constants.)

## Step 1 results

Complete capability table in `scripts/probes/2026-04-22_ebc-a40l-capabilities/CAPABILITIES.md`.

Headline findings:

- **3 Single-Test modes:** C-CV, D-CC, D-CP.
- **5 Cycle-Test step types:** D-CC, D-CP, C-CV, Wait, Cycle.
- **Parameter Calibration (CMD `0x04`) is ENABLED** for A40L — `System → Parameter Calibration`, menu id 13. Not secret.
- **Resistance Test (CMD `0x09`) is ENABLED** for A40L — `Tools → Resistance Test`, menu id 18. Earlier assumption it was absent was wrong.
- **Firmware Update is GREYED** on A40L (menu id 14). Defer to other profiles.
- pywinauto `combo.select(index)` reorders VB6 items after the `_Change` event — always use `combo.select("text")`.

## Step 2 plan

Test order (lowest risk → highest value first):

1. **Switch off fake device, switch on proxy.** `coulomb:49600` already reachable; SSH reachable; just need the Windows proxy process running. EB Tester must first `Disconn` from COM2 so the port can be reassigned. Then restart EB Tester's Connect.
2. **D-CP single test.** New CMDs `0x11` (start) and `0x18` (continue/update setpoint). Same infrastructure as captured D-CC.
3. **Resistance Test.** New command family CMD `0x09`. Open `Tools → Resistance Test`, start, observe, stop.
4. **Parameter Calibration.** New command family CMD `0x04`. Open `System → Parameter Calibration`, read the form, **Cancel without committing**.
5. **(Optional) Cycle Test** with Wait + Cycle steps — confirms host-driven loop semantics.
6. Write decoded frame specs into `protocol.md`; tick items in `PLAN-protocol-exercise.md`.

## Findings / gotchas

### Step 1

- **Mode combo has duplicated first item:** pywinauto `.texts()` returns `[current, item0, item1, ...]` — dedupe by dropping index 0.
- **VB6 labels are windowless** — field captions are drawn as graphics, not pywinauto controls. Use screenshots, not `/controls` titles, for field identification.
- `combo.select(int)` is unreliable across repeated switches on VB6 — use `combo.select("text")`.
- MSCOMCTL `TabStrip20WndClass` ignores `TCM_SETCURSEL` — had to implement `tab_click.py` with PostMessage WM_LBUTTON at computed coords.
- Parameter Setting and Calibration--Device1 sub-forms are pre-instantiated top-level `ThunderRT6FormDC` windows — reachable by HWND without showing them.

### Step 2

- **`raspberrypi.local` doesn't resolve** on this host. Use **`coulomb`** (→ `10.255.5.52`). This needs to be set via `BRIDGE_HOST=coulomb` when starting the proxy. Alternatively set `DEPLOY_HOST=coulomb` in `.env.local`.
- **Current running processes** (Windows):
  - Fake device on COM7, pids 2152 (wrapper) + 30448 (child). Control API :49700 is this process.
  - UI driver :49701 (no direct process visible in scan but port listens).
  - No proxy process currently running; COM2 is bound to fake device via the existing com0com pair.
- Stopping the fake device before the EB Tester disconnects from COM2 may leave the VB6 app in a bad state — the safe order is: **Disconn in EB Tester → stop fake device → start proxy (which claims COM2 via ghostcom) → Connect in EB Tester to COM2**.

## Progress log

- [x] Step 1 complete (details in CAPABILITIES.md)
- [x] Pi reachable: `coulomb:49600` (TCP bridge) and `coulomb:22` (SSH) both confirmed responsive 2026-04-22 14:34
- [x] Fake device still running on COM7 (pids 2152, 30448) — needs shutdown before proxy starts
- [x] Stop fake device and start proxy with `BRIDGE_HOST=coulomb` — proxy on COM6, recording to `recordings/2026-04-22T22-09-28.jsonl`
- [x] Confirm EB Tester Disconn → Connect cycle succeeds against real hardware — real device at 3.058V, identity confirmed (0x11, 0x86, 0x0A)
- [x] Capture D-CP single test — CMD 0x11 fully decoded (power raw W, cutoff ÷100, time raw min). States: 0x0B running → 0x15 time-complete → 0x01 idle.
- [x] Capture Resistance Test — CMD 0x09 fully decoded (current ÷100). No special response; R computed client-side. VB6 Int16 cap at 32767 mA.
- [x] Capture Calibration open (no commit) — 4-point dialog (Low/High V+I), Cancel clicked, no TX frames generated.
- [x] Capture Calibration CMD 0x04 via fake device — all 4 cal points decoded: byte 2 = point (0x00-0x03), bytes 3-4 = value (base-240, ÷1000). Voltage buttons enabled at idle, current buttons at active test.
- [ ] (Optional) Capture Cycle Test with Wait + Cycle
- [x] Update `protocol.md` and `PLAN-protocol-exercise.md`
- [x] Report back

## Open questions for the user

None blocking — proceed with proxy switchover.

## Things not to do

- Do NOT change device identity mid-run (pinned to EBC-A40L).
- Do NOT commit Calibration values.
- Do NOT click Firmware Update (greyed anyway).
- Do NOT click Save Data / Save Curve / Save Picture during probes — they open native file-save modals that block pywinauto.
- Do NOT use `PIL.ImageGrab` — screen may be locked.
- Do NOT use `combo.select(index)` across switches — always `combo.select("text")`.
- Do NOT issue `git reset --hard` or `git checkout --` — this is a shared worktree (see global CLAUDE.md).
