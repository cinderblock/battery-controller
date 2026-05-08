# Protocol Exercise Plan for EB Tester

**Goal:** Fill the remaining unknowns in `protocol.md` by running controlled tests through the proxy and capturing the raw serial traffic.

**How to resume:** Run `bun proxy` to start the serial proxy, open EB Tester, connect to the proxy's virtual COM port, and work through the checklist below. Short tests (10–15 seconds) are enough — we need the protocol bytes, not full capacity tests. Annotate in the proxy console as you go.

---

## Phase 1: Core Unknowns (Highest Priority)

These 3 tests fill the biggest gaps in the protocol documentation.

- [ ] **1. D-CC Discharge** — Set ~1A, cutoff 2.80V. Let it run ~30s then manually stop.
  - Captures: CMD 0x01 payload, discharge state byte, response bytes 6-7 during discharge.
  - Resolves: Is discharge state 0x0A? Do bytes 6-7 carry capacity during discharge?

- [ ] **2. C-CV Charge to completion** — Charge a nearly-full cell (small remaining capacity, low cutoff current like 0.05A) so it finishes quickly.
  - Captures: The "charge complete" state byte transition.
  - Resolves: What state byte means "done"? (Must be distinct from 0x02 idle and 0x0C active charging.)

- [ ] **3. Disconnect battery mid-test** — Start charging, then physically unplug the battery leads.
  - Captures: Error/protection state byte.
  - Resolves: What does ErrDconn look like on the wire?

## Phase 2: Mode Coverage

- [x] **4. D-CP Discharge** — 5W, cutoff 2.50V, 1 min max. ✅ Captured 2026-04-22.
  - CMD 0x11 payload: bytes 2-3 = power (raw W, NO divisor), bytes 4-5 = cutoff (÷100), bytes 6-7 = time (raw min).
  - State 0x0B = running, 0x15 = time-complete (one transitional frame), 0x01 = post-test idle.
  - Recording: `recordings/2026-04-22T22-09-28.jsonl`

- [ ] **5. C-LiPo charge** — Standard Li-ion cell.
  - Captures: CMD 0x51. Verify it uses same 3-field layout as C-CV (0x21).

- [ ] **6. C-NiMH charge** (if you have a NiMH cell).
  - Captures: CMD 0x31. Verify payload structure.

- [ ] **7. Stop command** — Hit Stop in EB during an active test.
  - Captures: CMD 0x06 in isolation. Confirm device transitions back to idle (0x02).

## Phase 3: Advanced Features

- [x] **8. Step test** — ✅ Captured 2026-05-06 via fake device + EB Tester automation.
  - 3-step program: D-CC (1A, cutoff 2.50V, 1 min) → Wait (1 min) → C-CV (1A, 3.65V, cutoff 2A).
  - **Host-side orchestration confirmed**: VB6 app sends individual start commands per step. No program upload, no special cycle command.
  - Step 1: CMD 0x01 (D-CC start) `fa 01 00 64 01 0a 00 01 6f f8` — current=1A, cutoff=2.50V, time=1min (bytes 6-7 = 0x00 0x01).
  - Cutoff detection: VB6 monitors voltage in RX frames, sends CMD 0x02 (toggle) to stop when cutoff reached.
  - Step 2 (Wait): Pure host-side — 64 seconds of silence between toggle and next start.
  - Step 3: CMD 0x21 (C-CV start) `fa 21 00 64 01 7d 00 c8 01 f8` — current=1A, voltage=3.65V, bytes 6-7 = 0x00 0xC8 (=200, cutoff current 2A).
  - Heartbeat (CMD 0x0A) observed with byte 3 = 0x01 (counter?).
  - UI shows step numbering as "Cycle-Step" (e.g. "1-1", "1-2", "1-3"). Active step highlighted yellow (Wait) or red (running).
  - **RX byte 14 stayed 0** — because max time was only 1 minute (base240(1) = [0x00, 0x01]). Byte 14 is the hi byte of the bytes 14-15 base-240 time/cutoff pair, NOT a step number. Confirmed 2026-05-07: time=300 → byte14=0x01, byte15=0x3C on real hardware. Step tracking is entirely host-side.

- [x] **8b. D-CC bytes 6-7: base-240 time pair or two independent bytes?** — ✅ Resolved 2026-05-06 via fake device + EB Tester Single Test.
  - **Answer: base-240 time pair. Our `encodeBase240` is correct.**
  - VB6 app sends base-240 encoded time in TX bytes 6-7. No cap, no separate byte treatment.
  - Test data (all via Single Test D-CC, 1A, cutoff 2.50V):
    - time=0 → `[0x00, 0x00]` = base240(0) — unlimited
    - time=239 → `[0x00, 0xEF]` = base240(239) — max single-byte value
    - time=240 → `[0x01, 0x00]` = base240(240) — rolls over to hi byte
    - time=300 → `[0x01, 0x3C]` = base240(300) — original question value
    - time=9999 → `[0x29, 0x9F]` = base240(9999) — no UI cap
  - Test 2 (step index in byte 6): **No.** Step test #8 sent time=1 → [0x00, 0x01]. Byte 6 is purely the base-240 high byte, not a step index. Step tracking is entirely host-side.
  - Test 3 (real hardware): unnecessary — VB6 encoding is base-240, and VB6 works correctly with real hardware, so the device agrees.

- [ ] **9. Cycle test** — Set up a 2-cycle charge/discharge.
  - Captures: How cycling is orchestrated (host-driven vs device-driven?).
  - **Hypothesis from step test**: likely also host-driven — VB6 app just re-runs the step program for each cycle.

- [ ] **10. Change setpoints mid-test** — Start D-CC at 1A, then change to 2A while running.
  - Captures: CMD 0x08 (continue). Confirm it updates setpoints without restarting.

## Phase 4: Edge Cases & Identification

- [x] **11. Resistance test** — ✅ Captured 2026-04-22. Available on EBC-A40L via `Tools → Resistance Test`.
  - CMD 0x09: bytes 2-3 = test current (base-240, ÷100 → A), bytes 4-7 = zeros.
  - No special response frame — VB6 app computes R = ΔV/I client-side from voltage dip.
  - Tested at 1A (0 mΩ), 5A (3.0 mΩ), 10A (2.5 mΩ), 20A (2.7 mΩ), 30A (2.9 mΩ), 32A (2.8 mΩ).
  - VB6 `CInt()` overflow at 32768 mA silently blocks higher values.
  - Recording: `recordings/2026-04-22T22-09-28.jsonl`

- [x] **12. Calibration screen** — ✅ Inspected 2026-04-22, CMD 0x04 captured via fake device.
  - 4-point system: Low Volt / High Volt / Low Curr / High Curr, each with target-value entry + "Calibration" button.
  - CMD 0x04 fully decoded: byte 2 = cal point (0x00-0x03), bytes 3-4 = reference value (base-240, ÷1000).
  - Voltage buttons enabled at idle; current buttons enabled only during active test.
  - Captured via fake device (no risk to real hardware cal memory).
  - Examples: Low Volt 3.800V → `FA 04 00 0F C8 00 00 00 C3 F8`, High Curr 10A → `FA 04 03 29 A0 00 00 00 8E F8`.

- [ ] **13. Heartbeat observation** — Leave EB connected but idle for 2+ minutes.
  - Captures: Confirm heartbeat cadence and counter behavior.

- [ ] **14. Fresh connect/init sequence** — Close EB, reopen, connect to COM.
  - Captures: Full init handshake, info packet alternation pattern.

---

## Execution Tips

- **Annotate as you go** — type what you're doing into the proxy console (it gets logged as notes in the JSONL).
- **Short tests are fine** — even 10–15 seconds of each mode gives us the protocol bytes.
- **Phase 1 is the money** — those 3 tests fill the biggest gaps. The rest is gravy.
