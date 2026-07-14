# Step-detail tooltips + timeout handling, and temp-chart zoom snapback

Two threads in one session (2026-07-14):

- **Task A** (original ask): completed sequence steps should expose more detail
  (total time, currents, Wh, etc.) via a tap/hover popover — NOT an HTML
  `title=` (forbidden globally). Plus special handling when charge/discharge
  steps time out (the following step is a less-valid test).
- **Task B** (interrupt, urgent): the temperature chart re-zooms to a narrow
  time window every time a new temp value arrives; zooming out doesn't reveal
  all temp data.

## Environment
- Project: C:\Users\camer\git\Personal Projects\battery-controller
- Frontend: React + uPlot in `src/frontend`. Server (Bun) in `src/server`.
- No `typecheck` script. Lint/format: `bun run lint` (biome). Typecheck via
  `bunx tsc --noEmit` (tsconfig.json present).
- Deploy: `bun run start` (watch) deploys to Pi (`pi@coulomb`).
- Possibly a **live test running** — historically this repo warns "don't touch
  live system." Confirm before deploying.

## Task B — temp-chart zoom snapback (ROOT CAUSE FOUND)

Two stacked charts share `syncKey="bc-time"` (main V/I/W/Ah + temperature),
both x = elapsed seconds. X-zoom is propagated between them manually in the
`setScale` hook via `propagateXZoom` (Chart.tsx ~472-485). uPlot's native
`cursor.sync` only shares the crosshair.

`Chart.tsx` calls `u.setData(data, !userZoomRef.current)` on every data tick.
When NOT user-zoomed, `resetScales=true` → uPlot autoscales x to **that
chart's own data extent** and fires `setScale` → `propagateXZoom` pushes that
extent onto the peer.

The main chart's x-extent = all runs + live (superset). The temp chart's
x-extent = only runs that have temperature data (often just the live run, or a
subset) → **narrower**. So each temp packet autoscales the temp chart to its
smaller window and forces that window onto the main chart → the whole view
"zooms in to a certain window," and full data is hidden.

### Fix (best-way, keeps stacked charts aligned)
1. `Chart.tsx`: add optional `xExtent?: [number, number]` prop. In the x-scale
   `range` callback, when in full view, expand to the shared `xExtent` so both
   charts adopt the **same** full x-domain (stay aligned; no snap).
2. `Chart.tsx`: suppress `propagateXZoom` for scale changes that originate from
   an internal `setData`/creation autoscale (a `suppressSyncRef` set around
   `setData` and `new uPlot`). Only genuine user gestures (drag/wheel/dblclick,
   which go through `setScale` not `setData`) sync across charts.
3. `ChartView.tsx`: compute the union x-extent of `chartData` + `tempChartData`
   and pass as `xExtent` to both `<Chart>` instances (time mode only).

## Task A — step-detail popover + timeout handling

Data already exists server-side. `test_runs` (db.ts) stores per run/step:
`final_capacity_mah`, `final_energy_mwh`, `peak_voltage_v`, `min_voltage_v`,
`peak_current_a`, `duration_s`, `ir_mohm`, `heat_mwh`, `end_reason`, setpoints.
Timeouts are ALREADY recorded as `end_reason='time_limit'` (host-side
enforcement in device-session.ts:466). Backoff/instant-trip runs excluded via
`exclude_from_capacity`.

The `cycle-timeline-bar` in `TopBar.tsx` renders each step; `CycleState`
(cycle-runner.ts + api-client.ts) currently only carries `stepCapacities`,
`stepDurations`, `stepExpectedS`, `stepLabels`, `execStepTypes`.

### Plan
1. Extend `CycleState` with a `stepDetails` array (per exec step): energyWh,
   peakCurrentA, min/peakV, irMohm, endReason, timedOut, avg current (derive
   from Ah/duration), setpoint summary. Populate in cycle-runner from the run
   rows (both live-complete and resume paths).
2. `TopBar.tsx`: wrap each **completed** timeline step in the existing
   `Tooltip` component (tap-to-expand friendly) showing the detail. NO
   `title=`. Verify Tooltip works on touch (may need tabindex/role=button).
3. Timeout handling: when a step's `endReason==='time_limit'`, mark the step
   visually (badge/hatch) AND flag the *following* step as "reduced-validity"
   (its starting SoC is unknown because the prior step didn't reach cutoff).
   Surface this in that step's popover and with a visual cue on the bar.

## Decisions
- No HTML `title=` tooltips anywhere (global rule). Use `Tooltip.tsx`.

## Progress log
- [x] Mapped both codepaths; root-caused Task B.
- [x] Task B fix: Chart.tsx `xExtent` prop + `autoscalingRef` suppresses
      autoscale-origin propagation; ChartView computes `sharedXExtent` union and
      passes to both charts. Typechecks clean (touched files), bundles clean.
- [ ] Verify Task B — needs deploy (restarts Pi service mid-test). WAITING on
      user OK since a live test is running.
- [x] Task A: `CycleState.stepDetails` (server cycle-runner + frontend
      api-client). Derived from finalized `test_runs` rows via `runToStepDetail`;
      populated on step advance, resume, cleared on backoff. `timedOut` =
      `end_reason === 'time_limit'`.
- [x] Task A: TopBar `TimelineStep` subcomponent — tap/hover detail popover
      (portalled to <body> to escape the 20px bar's overflow clip). Shows time,
      capacity, energy, avg/peak current, V range, IR, heat, end reason. No
      `title=`. Focusable so it works on touch (tap → focus → open).
- [x] Task A: timeout visual — `step-timedout` red bottom stripe + ⏱ glyph;
      following test step flagged `step-suspect` (amber stripe + `!`) with a
      "prior step timed out — result less reliable" warning in its popover.
- [ ] Verify Task A + B in browser (needs deploy — WAITING on user OK).

## Things not to do
- Don't re-add a timer to cycle-runner for time limits (host-side enforcement
  already lives in DeviceSession — see time-limit-and-chart-fixes.md).
- Don't touch a live test without asking.
