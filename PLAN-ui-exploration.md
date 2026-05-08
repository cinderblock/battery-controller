# EB Tester UI Exploration Plan

A living checklist for systematically walking through the EB Tester VB6 GUI against the fake device, to characterise every remaining unknown in the protocol. Update findings inline as items complete.

**Setup assumed** (restart if any fail):

| Piece        | Port   | Command                                         |
| ------------ | ------ | ----------------------------------------------- |
| Fake device  | COM2   | `bun run fake-device`                           |
| Control API  | :49700 | (started by fake device)                        |
| UI driver    | :49701 | `uv run python scripts/ui-driver/driver.py --auto-attach ".*EB Tester.*"` |
| EB Tester    | —      | Connected to COM2                               |

How to record traffic during any exercise below:

```bash
# With fake-device running, all TX/RX is logged to its SSE stream.
# To save to a file for later analysis:
bun run fake-device --log-dir recordings/<session-name>
```

---

## 1. Device identification — complete the byte-16 → device table

Priority: **medium** (was high). Most of this is done as of the 2026-04-22 sweep.

- [x] **1.1** Re-run a full 0x00–0xEF sweep with `deviceTypeByte=0` and `deviceSubtypeByte=0` fixed. ✅ Done 2026-04-22 — see `scripts/probes/2026-04-22_00-44-35-byte16/` (174 screenshots).
- [x] **1.2** OCR the device name out of each screenshot. ✅ Done — see `scripts/extract-device-names.ts`, output in `scripts/probes/2026-04-22_00-44-35-byte16/device-names.json` (raw OCR) and `device-names.curated.json` (with visual corrections + mirror recovery). 42 distinct devices mapped across `0x01`–`0x2A`.
- [x] **1.3** Verify the `0x01..0x2a` vs `0x65..0x8e` duplicate-range hypothesis. ✅ Confirmed — every captured mirror pair agrees; the range `0x65`–`0x8E` exactly mirrors `0x01`–`0x2A` (offset +0x64).
- [ ] **1.4** Investigate the `(byte14=0xEF, byte15=0xEF, byte16=0x0A) → EBC-A` anomaly — sweep byte 14 with byte 15 fixed at 0xEF, and vice-versa; does the UI fall through to a different lookup path when 14/15 carry magic values?
- [x] **1.5** Update `scripts/device-table.json` and `protocol.md` with the completed mapping. ✅ Done 2026-04-22.
- [x] **1.6** **Re-sweep `0xAF`–`0xEF`** — complete as of 2026-04-22T22:30Z.
  - ✅ `0xAF`–`0xDC` (46 values) confirmed `No Device` via OCR row 1 on every probe. The original sweep had actually captured `0xAF`–`0xB8` cleanly (the window-off-screen failure didn't start until `0xB9`); the 2026-04-22T18:00Z re-sweep then picked up `0xB9`–`0xDC` (36 additional screenshots, merged into the main probe dir).
  - ✅ `0xDD`–`0xEF` (19 values) closed by the 2026-04-22T22:30Z third re-sweep (task 1.6.1). Done in two short bursts (`0xDD`–`0xE6`, then `0xE7`–`0xEF`) after the Windows session was unlocked — neither burst hit the screen-grab failure. All 19 values read `No Device` in OCR row 1. Screenshots captured at 1.5× DPI (1445×1065 instead of the prior 963×710), so OCR on the burst sub-dirs used scaled row regions `--row1 21,993,143,26 --row2 21,1022,143,26`; the 19 corrected entries were then merged into the main probe dir's `device-names.json`. The 19 PNGs were also copied into the main probe dir's `screenshots/` for completeness.
  - Findings from the full re-sweep are consolidated in `scripts/probes/2026-04-22_00-44-35-byte16/device-names.curated.json` (`_0x8F_0xEF`, which now covers all 97 rejected values). Raw per-burst artefacts are retained under `scripts/probes/2026-04-22_resweep-b9-ef/`, `scripts/probes/2026-04-22_resweep2-dd-e6/`, and `scripts/probes/2026-04-22_resweep2-e7-ef/`. `scripts/device-table.json` and `protocol.md` updated in the same change.
- [x] **1.6.1** **Third re-sweep for `0xDD`–`0xEF`** — complete 2026-04-22T22:30Z. All 19 values read `No Device`. The 16 still-unmapped canonical devices (`EBD-USB+`, `EBC-A05+`, `EBC-A20+`, `EBC-A50L`, `EBD-M03+`, `EBD-M05`, `EBD-M10`, `EBC-A10+`, `EBD-A100L`, `EBC-A40L-40A`, and the six `-V3` / `-72V3` / `-108V3` / `-200W` variants) therefore have no byte16 home anywhere in `0x00`–`0xEF` — confirming the hypothesis that they must be selected by a different mechanism. Most likely candidate: info-packet bytes 14/15 magic values (see task 1.4 and the `(byte14=0xEF, byte15=0xEF, byte16=0x0A) → EBC-A` anomaly, which is now the leading concrete hint).
  - ✅ **Fourth verification pass** — 2026-04-22T23:00Z. The user flagged that the EB Tester UI may have been in a stuck state during the 2026-04-22T22:30Z pass and asked to close/reopen and retry. EB Tester was relaunched fresh (pid 35808), and a known-good baseline was established (byte16=0x0A on the fresh instance correctly displayed `EBC-A40L`). All 19 values `0xDD`–`0xEF` were then re-swept under identical conditions (fixed14=fixed15=0x00, reconnect-per-probe) into `scripts/probes/2026-04-22_resweep3-dd-ef/` — 19 PNGs, all at standard DPI (963×710). OCR with default row regions read `No Device` from row 1 for every value with confidence 95 (row 2 contained only the row-selector digit `1`, not a latched device). Finding reproduced, no changes to the 0x8F..0xEF rejection range. Technical note: the Windows session was locked during this pass, which broke `PIL.ImageGrab`. Worked around by adding `scripts/ui-driver/printwindow_capture.py` (Win32 `PrintWindow` API) which renders the window's own paint buffer into a memory DC and captures correctly regardless of lock-screen state / Z-order. Sweep driver: `scripts/probes/_resweep3_dd-ef.ps1`.

**Known so far:**

- **42 devices mapped.** Byte16 `0x01`–`0x2A` each selects a distinct device.
- **Two "No Device" zones confirmed.** Byte16 `0x2B`–`0x64` (58 values) and `0x8F`–`0xEF` (97 values) both universally rejected. Together: 155 of 239 probed bytes reject.
- **Mirror pattern confirmed — and bounded.** Byte16 `N+0x64` ≡ byte16 `N` for `N` in `0x01`–`0x2A` (i.e. range `0x65`–`0x8E`). No mirror mismatches found across all clean captures. The mirror does NOT cycle further — `0xC9`–`0xEF`, which would be a "second mirror" spanning the primary range and beyond, all read "No Device".
- **Full `0x00`–`0xEF` byte16 space characterised.** 0 bytes unprobed. The 16 unmapped canonical devices must be selected by a mechanism other than byte16 alone — prime suspect: info-packet bytes 14/15 magic (task 1.4).
- **Byte 16 is not a linear index** into the binary's DeviceTable at `0x1E634`/`0x1F64C`. A separate indirection exists in the VB6 code.

---

## 2. EBD-family probing

Priority: **high**. All probing so far has used the EBC-A40L profile. The UI may take different branches when byte 1 (state) indicates an EBD device.

- [ ] **2.1** Write a minimal `ebd-a40l.ts` fake profile — idle state `0x00`, current divisor 10,000, byte 16 still `0x0A` (we'll change it per-probe).
- [ ] **2.2** Repeat the byte-16 sweep using the EBD profile. Does it produce the same mapping, or do the "EBD-*" names now appear at different const values?
- [ ] **2.3** Confirm Meter mode shows up for byte 16 = `0x0b` (EBD-A) and capture its TX command when started.
- [ ] **2.4** Capture D-CV discharge-mode TX command (visible on EBD-A per the original sweep).

---

## 3. Per-mode detail capture

### 3.1 Discharge modes

- [ ] **3.1.1** D-CC start / continue — already captured on EBC-A40L (`0x01` / `0x08`). Re-confirm on EBD-A once profile exists.
- [ ] **3.1.2** D-CP start / continue — already captured (`0x11` / `0x18`).
- [ ] **3.1.3** **D-CV start** — not yet captured. Available on EBD-A per the sweep. Capture command byte and payload format.

### 3.2 Charge modes

Currently only C-CV (`0x21` / `0x28`) is captured. The UI on EBC-A offers seven chemistries — likely CMD table entries `0x31..0x71`.

- [ ] **3.2.1** C-NiMh — expected CMD `0x31`. Confirm payload (current, cutoff?).
- [ ] **3.2.2** C-NiCD — expected CMD `0x41`. Same format?
- [ ] **3.2.3** C-LiPo — expected CMD `0x51`.
- [ ] **3.2.4** C-LiFe — expected CMD `0x61`.
- [ ] **3.2.5** C-VRLA — expected CMD `0x71`.
- [ ] **3.2.6** C-PB — unknown CMD; may overlap with VRLA.
- [ ] **3.2.7** C-Liion — shares C-LiPo profile per binary?

For each: click Start with a representative setpoint, record TX bytes, log the Continue variant too.

### 3.3 Meter / Monitor modes

- [ ] **3.3.1** Meter mode (EBD-A and similar) — what CMD does Start emit? Does it stream the same RX packets?
- [ ] **3.3.2** Monitor button on Single Test — confirmed no-TX on EBC-A40L. Re-verify on EBD profiles.

### 3.4 Resistance test

- [ ] **3.4.1** Does `frmRes` appear on any profile? Which byte-16 values? Capture CMD `0x09` payload.
  - ✅ **Confirmed available on EBC-A40L** 2026-04-22T23:30Z via menu enumeration. `Tools → Resistance Test` is enabled for the A40L profile (see `scripts/probes/2026-04-22_ebc-a40l-capabilities/menus.json`, menu id 18). Previously assumed A40L lacked resistance capability; it does have one. Capture of the CMD `0x09` payload is unblocked — start with the fake device, then real hardware.

---

## 4. Error / protection states

Priority: **medium**. Error strings in the binary: `ErrStop`, `ErrStart`, `ErrSet`, `ErrComm`, `ErrConn`, `ErrDconn`, `ErrAutoInit`, `ErrQC`, `ErrPE`, `ErrTim`, `ErrTlb`, `ErrCap`, `ErrCurve`, `ErrCurve2`, `ErrData`.

Fake-device probing (Apr 2026) ruled out "state byte = error code" across 0x00–0xEE. Likely triggered by specific frame patterns instead.

- [ ] **4.1** Inject malformed frames (bad checksum, bad length, truncated) during idle and during a running test. Which errors fire? (Watch `frmMsg`.)
- [ ] **4.2** Start a test, then stop emitting RX entirely for >60s — does heartbeat loss trigger `ErrDconn`?
- [ ] **4.3** Out-of-range setpoint values (current > device max, negative values, values just below 0xF0). Does the device echo an error state or does the UI reject client-side?
- [ ] **4.4** Inject state bytes that are *close* to running states but not equal — e.g. 0x0D between 0x0C (C-CV) and 0x0E. Does any trigger a warning/error UI?
- [ ] **4.5** Send a response with state bytes beyond 0xEE (0xEF, which is literally the 0xF0-1 boundary).

For each firing error, record: which state/action preceded it, what the UI displayed, and whether any RX/TX distinguishes the error path.

---

## 5. Calibration protocol (CMD `0x04`)

Priority: **low** — risky to test against real hardware, but safe against fake.

- [x] **5.1** Find the calibration menu entry (likely `frmAdj`, tied to a secret combo or command-line flag). ✅ Found 2026-04-22T23:30Z — **not secret at all**, it's `System → Parameter Calibration` in the top menu bar (menu id 13). Enabled for EBC-A40L. Invokes a top-level `Calibration--Device1` ThunderRT6FormDC (HWND known at runtime). Form layout: 2 Voltage calibration points + 2 Current calibration points, each with target-value TextBox and per-point `Calibration` button, plus form-level `Reset` / `OK` / `Cancel`. Full child tree: `scripts/probes/2026-04-22_ebc-a40l-capabilities/calibration_controls.json`. Tasks 5.2 / 5.3 can now proceed by clicking that menu entry.
- [ ] **5.2** Click through calibrate flow; capture all TX bytes. Do NOT save any calibration data to real device.
- [ ] **5.3** Document CMD `0x04` payload layout.

---

## 6. Step test and Cycle test (detail pass)

Cycle is already confirmed host-driven (Apr 2026). Step is presumed host-driven by analogy. Still missing:

- [ ] **6.1** Multi-chemistry step program — mix C-NiMh + D-CC + C-LiPo steps. Confirm each step emits the per-mode Start command. (Byte 14 is NOT a step number — it's the hi byte of the base-240 time/cutoff echo pair. Confirmed 2026-05-07.)
- [ ] **6.2** Cycle count > 1 — confirm host re-issues Start rather than using a device-side loop counter.
- [ ] **6.3** Cycle through all step types (Wait, Cycle, C-*, D-*) and produce a definitive "step protocol" spec in `protocol.md`.

---

## 7. Firmware update (`frmUpdate`)

Priority: **low**. Error strings suggest `ErrUPD`, "Failed! Please check TTL cable".

- [ ] **7.1** Trigger firmware-update flow on fake device (may require specific device ID or version to unlock).
  - Note 2026-04-22T23:30Z: `System → Firmware Update` menu item is **greyed / disabled** on EBC-A40L (menu id 14 in `scripts/probes/2026-04-22_ebc-a40l-capabilities/menus.json`). So the A40L profile doesn't unlock it. Revisit once an EBD-USB+ or other profile is fake-able — or find the condition (specific model code? firmware version? `--debug` flag?) that un-greys it.
- [ ] **7.2** Capture the initiation TX command and any flash-data framing. Likely a completely different protocol family (possibly falls out of the base-240 frame format).

---

## 8. Dialogs and non-serial UI (completeness)

No TX/RX expected from these, but worth confirming:

- [ ] **8.1** **Save Data** (disk toolbar icon): once a test has produced data, verify the Save dialog just writes a local `.dat`/`.csv` and emits no serial traffic.
- [ ] **8.2** **Save Picture** (image toolbar icon): confirm no TX, check what file format is written.
- [ ] **8.3** **Display Setting** (wrench icon): iterate every setting, confirm purely client-side.
- [ ] **8.4** **About** dialog (info icon): already confirmed no TX. Record version string for future reference.
- [ ] **8.5** **Color / display** sub-dialogs (`frmColor`, `frmDisp`, `frmShow`): confirm client-side.
- [x] **8.6** **Parameter Setting** combo box — full enumeration of mode options per device profile. ✅ Done for **EBC-A40L** 2026-04-22T23:30Z — see `scripts/probes/2026-04-22_ebc-a40l-capabilities/CAPABILITIES.md`. Single Test offers exactly 3 modes (`C-CV`, `D-CC`, `D-CP`); Cycle Test step editor offers 5 step types (`D-CC`, `D-CP`, `C-CV`, `Wait`, `Cycle`). No hidden modes, no chemistry-specific charge modes. Other profiles (EBC-A, EBD-*) pending separate pass.

---

## 9. Advanced / not yet scoped

- [ ] **9.1** **Remote mode** (`cmSocket` / `modSocketMaster`) — the app has a TCP socket module. How does remote mode affect serial behavior? Does it proxy commands?
- [ ] **9.2** **USB QC** (`frmUSB`) — only relevant to EBD-USB+ profiles. Needs a USB+ fake profile.
- [ ] **9.3** **Auto control** (`frmCtrlAuto`) — what modes / what's the difference from manual Single Test?
- [ ] **9.4** **2-channel control** (`frmCtrl2S` / `frmRun2S`) — needs a multi-channel fake profile (EBD-A2S / EBD-A5S / EBC-A5M). How is channel selection encoded?
- [ ] **9.5** **DC5V** mode — appears on EBC-A05 per the sweep. What command does it emit?
- [ ] **9.6** **The 7-mode charger chemistry set on EBC-A** — compare the EBC-A (7 modes) vs EBC-A40L (3 modes) UI differences side by side.

---

## 10. Anomalies & oddities

- [ ] **10.1** `(byte14=0xEF, byte15=0xEF, byte16=0x0A)` → UI displays **EBC-A** instead of EBC-A40L. Reproduce, then sweep 14 and 15 independently to find the boundary. Is there a specific magic value that overrides the byte-16 lookup?
- [ ] **10.2** **Info packet cadence.** Does the device ever send info packets while a test is running, or only while idle? Our capture suggests only idle — confirm by injecting info packets mid-test and observing UI reaction.
- [ ] **10.3** **Heartbeat tolerance.** 60 s cadence documented. What's the actual timeout before `ErrDconn`? Probe by delaying responses.

---

## Execution tips

- Group each session under `recordings/ui-probe-<topic>/` so the JSONL + screenshots stay together.
- Always start with a known idle state — `curl -X POST http://127.0.0.1:49700/reset` between experiments.
- For each item, record before/after UI screenshots + the TX bytes in the checklist entry. Don't just mark `[x]` — note the CMD byte or the state byte that resolved it.
- When an item produces a structural finding (e.g. "all 7 charge chemistries share the same payload layout"), promote it to `protocol.md` in the same change.
- If a probe result contradicts an earlier confirmed finding, flag it in this file AND in `protocol.md`; don't silently update.

## Related files

- [`protocol.md`](./protocol.md) — authoritative protocol documentation (Device Identification section covers current byte-16 findings).
- [`scripts/device-table.json`](./scripts/device-table.json) — `deviceIdByte.mappings` is the JSON form of the const → device table.
- [`PLAN-protocol-exercise.md`](./PLAN-protocol-exercise.md) — original proxy-based real-hardware plan (still relevant for confirming fake-device findings against the physical EBC-A40L).
- [`scripts/README.md`](./scripts/README.md) — fake-device + UI-driver setup and control API.
