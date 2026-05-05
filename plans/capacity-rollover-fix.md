# Capacity Rollover Fix

## Goal

Fix the capacity decoding for high-capacity runs (>10 Ah). The EBC-A40L device changes its capacity encoding at ~10,000 mAh (10 Ah), and our current code doesn't handle this, resulting in wildly incorrect capacity values in the database.

## Environment / Context

- Device: EBC-A40L (40A charger/discharger)
- Cells: ThunderSky TS-LFP200AHA 200Ah LiFePO4
- Server: coulomb (Raspberry Pi), reachable at `https://coulomb.tomsawyerlabs.com`
- DB: SQLite at `/opt/battery-controller/data/battery.db`
- All 55 runs in the DB have incorrect capacity data (every completed run exceeds 10 Ah)
- Protocol: base-240 encoded, 2-byte capacity in payload bytes [5,6], field7 in bytes [7,8]

## The Problem (confirmed from run #4 and live run #56)

Before ~10 Ah: Capacity encoding works as expected.
- bytes 5-6 = base-240 encoded capacity in mAh (divisor=1)
- bytes 7-8 = 0
- Rate: +22 mAh per 2s tick at 40A

At ~10,000 mAh: Device changes encoding.
- payload[5] (hi byte) jumps by exactly +99
- Rate drops to +2-3 per 2s tick (exactly 1/10 of true rate)
- **Each base-240 unit now represents 10 mAh, not 1 mAh**

Correction formula: `true_cap = last_pre_transition_cap + (encoded - transition_encoded) * 10`

## Decisions Already Made

- Extracted `CapacityTracker` class into separate file for testability
- Detection uses jump threshold (>20,000 mAh sudden increase while running)
- field7 (bytes 7-8) is NOT used — confirmed 0 even after transition
- CapacityTracker handles: detection, correction, reset, serialization/recovery

## Findings / Gotchas

- **field7 = 0 after transition** — confirmed in live run #56 (2026-05-04). Even after crossing 10 Ah, rawField7 remains 0. Earlier server logs reporting "Field7 non-zero" may refer to different conditions.
- The proxy JSONL recordings (in recordings/) never reached the transition — max capacity was 9,423 mAh
- All 55 runs in the DB have incorrect capacity data (they all exceeded 10 Ah but used the <10Ah formula)
- The old "capacity wrap at 57,600" detection code was dead — the reading emission used the local `capacityMah` (raw decoded) instead of `this.capacityMah` (corrected), so corrections never reached emitted readings
- **Live validation (run #56)**: At 955.9s, corrected=10,591 mAh vs theoretical 10,621 mAh = 0.3% error
- **Transition point in run #56**: point 450 (cap=9991) -> point 451 (cap=33769), jump=23778

## New Files

- `src/server/capacity-tracker.ts` — CapacityTracker class with detection, correction, state serialization
- `src/server/capacity-tracker.test.ts` — 11 tests including live run #56 data, all passing
- `src/server/__tests__/run4-fixture.json` — fixture data from historical run #4

## Modified Files

- `src/server/device-session.ts` — uses CapacityTracker, emits corrected capacity in readings
- `src/server/index.ts` — recovery logic uses CapacityState interface

## Progress Log

- [x] Confirmed DB data is wrong (46,691 mAh vs expected 139,220 mAh for run #4)
- [x] Found the exact transition point: ~10,000 mAh, hi-byte jumps by +99
- [x] Confirmed 10x rate change post-transition
- [x] Started diagnostic discharge (run #56) to capture live transition data
- [x] Confirmed field7 = 0 after transition (run #56, 2026-05-04)
- [x] Determined exact formula for high-capacity decoding
- [x] Wrote CapacityTracker with full test suite (11 tests, all passing)
- [x] Fixed device-session.ts to use CapacityTracker and emit corrected values
- [x] Fixed critical bug: reading emission used raw value instead of corrected
- [x] Verified no new type errors introduced
- [x] Validated correction formula against live run #56 data (0.3% accuracy)
- [x] Deployed fix to coulomb (2026-05-04)
- [x] Ran DB migration: 17 runs corrected, 61,899 data points fixed
- [x] Migration verified idempotent (second run: 0 corrections)
- [x] Verified corrected discharge runs match expected capacity within 0.0-0.2%
- [x] Fixed pre-existing deploy bug: getTempFile() trailing newline in ssh.ts

## Recovery high-cap detection bug (found 2026-05-05)

Two-layer bug in the recovery provider (`src/server/index.ts`):

### Layer 1: highCapMode detection was inverted
**Symptom:** After service restart during discharge past 10 Ah, TopBar shows raw base-240 value instead of corrected. Device LCD correct.
**Root cause:** `lastPoint.capacity_mah > rawCapMah + HIGH_CAP_JUMP` — compares corrected DB value against raw + 20k. In high-cap mode the raw is always *larger* than corrected below ~58 Ah, so this is false when it should be true.
**Fix:** Changed to `rawCapMah > HIGH_CAP_THRESHOLD` (>20,000). Low-cap maxes at ~11k; high-cap starts at ~33,769.

### Layer 2: DB has corrupted capacity values from previous bad recovery
**Symptom:** Even with correct highCapMode detection, TopBar still shows wrong values after restart. At 77.7 Ah true capacity, showed 40.5 Ah (= raw base-240 value).
**Root cause:** Recovery sets `transitionTrue = lastPoint.capacity_mah`. If the DB was storing raw (uncorrected) values from a period when highCapMode wasn't detected, the recovery anchors to the wrong baseline. Example: DB had 40,500 (raw) instead of 77,700 (corrected).
**Fix:** Compute approximate true capacity from raw (`10 * raw - 327,600`, derived from EBC-A40L constants: transitionTrue≈10,000, hi-byte jump=99×240=23,760). Compare with DB value — if divergence >10%, DB is likely storing raw values, use computed instead. Accuracy: ±500 mAh (~0.5 Ah) from transitionTrue uncertainty.

### Also fixed
`this.capacityMah = 0` added in `setMode()` alongside `capTracker.reset()` to prevent one-packet stale reading at step transitions.

## Open Questions

1. ~~What does field7 encode?~~ **Answered: field7 = 0 even after transition.** Its purpose remains unknown but it's not needed for capacity correction.
2. Does the encoding change again at 100 Ah? (Run #56 still in progress — will take ~9 hours at 40A to reach 200Ah)
3. Is there a second encoding change? The +99 offset at 10 Ah might repeat at higher thresholds.

## Things Not To Do

- Don't rely solely on synthetic data — use the real captured transition data
- Don't use field7 for capacity correction — it's 0 even after transition
- Don't assume the old wrap detection (57,600) was ever working — it wasn't, due to the emission bug
- Don't compare corrected DB values against raw device values for high-cap detection — the relationship inverts depending on capacity
