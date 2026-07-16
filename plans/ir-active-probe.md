# Active IR Probe — periodic current twiddle to measure internal resistance mid-run

> Related: `plans/internal-resistance-estimate.md` (the passive per-run median IR this builds on),
> `plans/sequence-variables-and-backoff.md` (per-step `bind`/`backoff` pattern this mirrors).

## Goal

Measure DC internal resistance _repeatedly during a running discharge_ by having the host
briefly step the current down (e.g. 40 A → 10 A for ~8 s) every few minutes, then restore it.
Each twiddle is a clean, large-ΔI current step the existing estimator can turn into an
`R = ΔV/ΔI` sample — giving a **time series of mΩ across the run** instead of one number at
the end. Plot that running estimate on the temperature chart's (new) right-hand axis.

Opt-in **per step** in a sequence (a toggle on d-cc steps), matching how `backoff` works.

## Why (physics rationale — decided, don't re-derive)

- Signal scales with **ΔI amplitude**, not dI/dt. Noise floor is fixed: 1 mV voltage
  quantization, ~10 mA current, ~2 s sample period. Fractional error in R ≈ `1 mV / (R·ΔI)`.
  - 3 mΩ cell: 40→35 A (ΔI=5) → ΔV=15 mV → ~7% error; 40→10 A (ΔI=30) → ΔV=90 mV → ~1%.
  - So a **big** step matters most for _healthy_ (low-mΩ) cells, where sag is tiny. The known
    bad cells (7–40 mΩ) resolve fine even at small ΔI; a truly healthy <1 mΩ cell is the hard
    end (40 A × 1 mΩ = 40 mV, still only ~2.5%).
- **Step down, keep a non-zero floor** (40→10, not 40→0). Dropping to rest injects a
  relaxation transient and changes the polarization state; stepping between two _loaded_
  currents keeps the cell electrochemically comparable → cleaner ohmic+fast-pol ΔV. Also
  briefly _reduces_ heat/stress rather than adding it.
- **Charge cost negligible**: 40→10 A held ~8 s removes ~0.05 Ah on 200 Ah (0.025%). Probe
  freely (every few minutes).
- **Timescale limit**: at ~2 s sampling we always get a ~2 s DC-IR (ohmic + fast
  polarization mixed). We cannot isolate pure ohmic without ms sampling the protocol doesn't
  expose. The probe gives a _cleaner, repeated, larger-ΔI DC-IR_, not a new kind of measurement.

## Design

- **Step field** (mirrors `backoff?`): `probe?: { periodS: number; lowA: number; holdS: number }`
  on `StepDCC`. Defaults: `periodS: 600` (10 min), `lowA: 10`, `holdS: 8`.
  - v1: **d-cc only** — direct current control gives the cleanest, most controlled ΔI.
    d-cp (twiddle via power) and c-cv (device controls current toward a voltage target) are
    future work; probing c-cv is awkward and out of scope.
- **Scheduler in `CycleRunner`**: when a d-cc step with `probe` starts (`executeCurrentStep`),
  arm a repeating timer. Each fire: remember the resolved setpoint, `continueDCC(lowA, cutoffV,
<preserved max time>)`, then after `holdS` `continueDCC(setpointA, cutoffV, <preserved>)`.
  Clear the timer on step complete (`onSessionEvent` idle), `advanceAfterStep`, `abort`,
  `stop`, and backoff retry. Data keeps flowing into the same run row throughout.
- **Estimator → time series**: refactor `ir-estimate.ts` so the per-step samples are exposed
  as `estimateIrSamples(points, mode) → { t, mohm }[]`; the existing median wraps it. The
  probe dips then surface as a sequence of samples the frontend can plot. (Pure, unit-tested,
  zero hardware risk — build this first.)
- **Chart trace**: add a right-hand mΩ axis to the temperature chart and plot the running
  estimate (from live points via `estimateIrSamples`, or `estimateIrSamples` over a loaded
  run's points). Needs right-axis support in `Chart.tsx` + redo the stacked-chart gutter
  alignment math in `ChartView.tsx:469-477` (temp chart currently has _no_ right axis).
- **UI toggle**: in `StepProperties.tsx`, a probe on/off chip on d-cc steps + period/lowA/hold
  fields when on (no dropdowns — inline chips/inputs, per user prefs).

## Blocker — device `0x08` continue semantics UNCONFIRMED (must resolve before hardware)

`continueDCC` (CMD `0x08`) is currently only reachable via one manual API route
(`index.ts:598`); the CycleRunner never uses it (backoff _restarts_ with `startDCC`). Its
mid-run device behavior is listed "not yet captured" in `CLAUDE.md` / `protocol.md`. Unknowns
that gate the twiddle:

1. Does the device **zero its elapsed timer** on `0x08`? If so, a probe every 10 min keeps
   restarting the max-time clock → silently defeats the time limit. (Host watchdog re-arms via
   `armTimeLimit` on every `continue*` — `device-session.ts:615` — and reads device elapsedS,
   so this depends entirely on device behavior.)
2. Does it **reset the capacity/energy accumulator** on `0x08`? If so the run's Ah/Wh would be
   corrupted by every probe.
3. Does it even **accept a current change mid-D-CC**, or does it require stop→start?

Plan: implement + validate against the **fake device** first (make its `0x08` handling model
whatever we decide is correct), then **capture real-hardware `0x08` behavior** (fake first,
then real, per `PLAN-protocol-exercise.md`), then enable on prod. Do NOT send twiddles to the
real 200 Ah cell until 1–3 are answered.

## Coupled: browser RAM fix (do alongside — the live IR trace rides the same path)

`useDeviceSession.ts` accumulates `livePoints`/`liveTempPoints` unbounded for a run and does a
full-array copy (`[...ref]`) on **every** SSE reading/temperature event (lines 235, 368);
`ChartView` re-derives the whole chart from the new array each tick → O(n²) allocation on
multi-hour runs, a likely contributor to the reported browser OOM. The live IR trace would add
another such array, so fix the pattern here (bounded/decimated buffer or throttled/append-only
publish) as part of this work. NOT confirmed to be the whole RAM story (CameraView/RTSP, chart
canvas are other suspects) — a heap snapshot would confirm.

## Decisions already made (don't re-ask)

- Per-step opt-in toggle (configurable period/lowA/hold), not a global fixed probe — matches
  the existing sequence-editor model. (User: "Do it"; earlier lean toward configurable.)
- Step DOWN to a non-zero floor; big ΔI preferred. d-cc only for v1.
- Fake-device-first; no hardware twiddle until `0x08` semantics captured.
- Do NOT deploy/restart the server while a cycle is running (standing project rule).

## Staged plan

1. [x] `estimateIrSamples()` time series + refactor median to use it + tests. (pure, safe)
2. [ ] `probe?` field on StepDCC (shared server type + frontend sequence-types) + validation.
3. [ ] Fake device: model `0x08` continue (elapsed/capacity behavior we decide is correct).
4. [ ] CycleRunner probe scheduler (arm/fire/disarm) + tests, validated vs fake device.
5. [ ] Chart: right mΩ axis on temp chart + running-estimate trace.
6. [ ] StepProperties UI toggle + fields.
7. [x] Browser RAM fix in useDeviceSession live buffers. (pulled forward at user request)
8. [ ] Capture real-hardware `0x08` behavior; only then enable probe on prod.

## Progress log

- Researched current passive IR (finalizeRun + backfill), confirmed `continueDCC` exists but
  is unexercised by the runner, and identified the `0x08`-semantics blocker + the RAM leak
  path. Wrote this plan.
- Stage 1 done: `estimateIrSamples(points, mode)` extracts the per-step DC-IR time series;
  `estimateIrMohm` now wraps it (median). 17 tests pass. Encoded the design constraint that
  probe-hold points must be ~2 s apart or the restore step exceeds `MAX_STEP_DT_S` (5 s).
- Decisions (user): `0x08` semantics unknown → build fake-device-first, capture real behavior
  later, don't twiddle real hardware yet. Browser RAM: fix now (pulled ahead of the feature).
- Stage 7 done (early): bounded the live chart buffers in `useDeviceSession.ts`. Root cause —
  `livePoints`/`liveTempPoints` grew unbounded per run (temps: one push per channel per packet)
  and every SSE tick did a full-array copy + whole-chart re-derive → unbounded retained + O(n²)
  churn on multi-hour runs. Now capped (`MAX_LIVE_POINTS` 4000, `MAX_TEMP_POINTS` 6000) with
  graceful decimation (recent full-res, older halved; temps decimated per-channel to stay
  aligned). Lossless for the live chart — full data is server-side in `data_points`. Chart
  layer itself (uPlot, canvas) was already leak-clean. NOTE: not yet confirmed on-device to be
  the _whole_ RAM story; if OOM persists, take a heap snapshot (CameraView/RTSP is next suspect).
  Next feature step: `probe?` field on StepDCC, then fake-device `0x08` modeling.
