# Internal Resistance Estimate Per Cell

> Follow-up work (sequence variables + discharge auto-backoff) is tracked in
> `plans/sequence-variables-and-backoff.md`.

## Goal

Auto-compute a DC internal-resistance (IR) estimate for each cell, updated as cells are
tested, so high-IR cells (like the 3 "failed" ones from 2026-07-10..12) are visible at a
glance instead of looking like dead cells.

## Context / why

- Cells 3, 4, 5 showed ~7–40 mΩ effective resistance (healthy TS-LFP200AHA < 1 mΩ):
  voltage slams to the 3.7/3.8 V CV limit instantly on charge, collapses below the 2.8 V
  cutoff instantly on 40 A discharge, rests at healthy 3.2–3.47 V.
- Charger has 4-wire sensing directly on the cell → the sag is real (cell + terminal
  oxide under the sense point), not clamp contact in the current path.
- Dev cell 2 got 108 Ah but at 10 A — 4× less sag than the 40 A tests, so comparisons
  need the IR number to be meaningful.

## Method

DC-IR from current steps: scan consecutive data-point pairs in a run; where |ΔI| ≥ 5 A
within ≤ 5 s, R = ΔV/ΔI (sign-corrected: current is unsigned in the data, so discharge
expects ΔV/ΔI < 0). Take the median of accepted samples. The rest→load step at the start
of every run (first point is I=0 at rest voltage) is the main sample; stop transitions
add more. Slow CV taper never passes the 5 A threshold, so it can't pollute the estimate.
This is a ~2 s-timescale DC-IR (includes some polarization) — fine for ranking cells.

Verified against real runs: cell 5 charge (run 123) 3.215→3.700 V @ 22.85 A ≈ 21.2 mΩ,
cell 5 discharge (run 125) ≈ 21.4 mΩ — consistent, so the method holds.

## Design

- `src/server/ir-estimate.ts` — pure `estimateIrMohm(points, mode)` → median mΩ + sample
  count, or null. Modes: c-cv / d-cc / d-cp only (never wait).
- DB migration v6: `ALTER TABLE test_runs ADD COLUMN ir_mohm REAL`.
  - NULL = not computed; 0 = computed, no estimate possible; > 0 = estimate in mΩ.
- `TestRecorder.finalizeRun()` computes + stores IR after finalizing a run.
- Startup backfill (guarded by settings key `ir_backfill_v1`) computes IR for all
  existing ended runs once.
- `getCells()` gains `latest_ir_mohm` (subquery: most recent run with ir_mohm > 0).
- `CellCapacityStats` gains `latestIrMohm`, `medianIrMohm`, `irRunCount`.
- Frontend: Cells modal shows the mΩ badge per cell.

## Decisions already made (don't re-ask)

- 4-wire sensing confirmed → treat measured sag as cell-side, no lead-resistance fudge.
- Keep all 13 cells if possible; real-world use won't need 40 A. IR number is for
  ranking/tracking recovery (terminal cleaning, gentle cycles), not pass/fail.
- Do NOT deploy/restart the server while a cycle is running (run 127 was charging on
  coulomb when this work started).

## Progress

- [x] Diagnose "failed" cells (high IR, not overcharge — setpoints 3.7/3.8 V CV are safe)
- [x] Plan
- [x] ir-estimate.ts + tests
- [x] DB migration + finalize hook + backfill
- [x] Cell stats + /api/cells latest_ir_mohm
- [x] Frontend badge in Cells modal
- [x] Validate estimator against a copy of the live DB (offline, no deploy) — see table in session notes; cell 2 ≈ 2.6 mΩ, cell 3 ≈ 38 mΩ, cell 4 ≈ 8.6 mΩ, cell 5 ≈ 21 mΩ
- [x] Commit
- [x] Deployed 2026-07-12 (mid-charge; recovery clean). Live per-cell IR:
      F02731 2.83, F02726 7.55, F02729 21.28, F02732 40.63 mΩ.

## Findings / gotchas

- `current_a` in data_points is unsigned magnitude for both charge and discharge.
- First data point of a run has elapsed ≈ 0 and I = 0 with V = rest voltage (device
  reports one idle reading before load) — that's what makes the start-step sample work.
- Wait runs record voltage-only points (I = 0) — excluded by mode filter.
- test_runs rows are returned via SELECT \*, so the new column flows through the API
  without route changes.
