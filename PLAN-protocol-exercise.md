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

- [ ] **8. Step test** — Create a 3-step program (e.g. Charge → Wait → Discharge) and run it.
  - Captures: How steps are communicated — individual commands per step? Or uploaded program? Watch byte 14 (step number) increment.

- [ ] **9. Cycle test** — Set up a 2-cycle charge/discharge.
  - Captures: How cycling is orchestrated (host-driven vs device-driven?).

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
