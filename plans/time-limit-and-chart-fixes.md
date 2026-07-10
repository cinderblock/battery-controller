# Time-limit enforcement + chart UX fixes (July 2026)

## Goal

1. **Charge (C-CV) time limit is never enforced** — user's 5h-limited charge step ran past 5h.
2. Fix "200tMax" mislabel in TopBar during charge.
3. More chart filtering/coloring controls (second battery now under test).
4. Fix chart tooltip / closest-series highlighting.
5. Plot live temperatures during a run (currently only latest point per channel).
6. Compute filtered dT/dt per temp channel (low noise).
7. (Found during review) Temp alert during a cycle advances to next step instead of aborting.

## Environment / context

- Live system on Pi (`pi@coulomb`) is mid-charge — **do not deploy or touch until user says the step is done**. User is letting it ride and will stop manually.
- Shared working tree: `src/server/serial.ts` and `src/server/tcp-bridge.ts` have uncommitted changes from another thread — do not touch or stage them.
- Deploy: `bun run start` is deploy watcher (`src/run/deploy.ts`); host is in deploy config (`pi@coulomb`).

## Root-cause findings (don't re-derive)

- **The 5h bug is NOT a base-240/unit-switching decode bug.** The C-CV start frame (`0x21`)
  carries only current, target V, cutoff current — the protocol has **no time field for charge**.
  EB Tester enforces all time cutoffs **host-side** with a client timer, then sends `0x02` load
  toggle (protocol.md "Cycle Test" section + confirmed capture note). Our server never implemented
  that for C-CV; discharge modes (D-CC/D-CP) get the limit sent in-frame and the device enforces it.
- **"200 tMax" display**: RX bytes 14-15 echo max time (min) for D-CC/D-CP but **cutoff current
  (raw ÷100 → A) for C-CV** (protocol.md line ~697). The user's charge had cutoff 2.00 A → raw 200.
  `TopBar.tsx` labels the raw value "tMax" unconditionally. Cosmetic, but confirms the device was
  never told a time limit.
- **Tooltip bugs in `Chart.tsx` setCursor**:
  - `s.metric.charAt(0).toUpperCase() === s.metric.charAt(0)` is always false (metrics are
    lowercase) → every series' Y position computed on the **V scale**.
  - `u.valToPos(val, scale, true)` returns canvas px (DPR-scaled, bbox-offset) but is compared
    against `u.cursor.top` (CSS px) → distances wrong on any hi-DPI screen.
  - Series with no sample at the hovered X index are dropped from the tooltip even though
    spanGaps draws them there (merged X axis makes most series sparse).
- **Legend color mismatch**: chart colors assigned by index over *visible* runs
  (`mergeRunsForChart`), legend swatches by index over *all* runs → mismatch once anything is
  hidden/filtered. Fix via a stable runId→color map computed once in ChartView.
- **Temp alert vs cycle**: `index.ts` tempAlert handler calls `session.stop()`; during a cycle the
  runner sees device→idle while status='running' and **advances to the next step** (could restart
  charging an overheating cell). Must abort the cycle instead.
- `colorByMode` state in ChartView is dead code (never read).
- StartModal has no max-time input; only SequenceEditor sets `maxTimeMin`. API already accepts it.

## Decisions made

- Host-side time enforcement lives in **DeviceSession** (not CycleRunner) so it covers single
  tests AND cycle steps, and survives restarts via the existing recovery path (recovered
  `testStartTime` + `setpoint_max_time_min` from the run row).
- For D-CC/D-CP the device is primary enforcement; host adds a +1 min backstop.
- When the host limit fires: `stop('time_limit')` → device idles → cycle runner naturally
  advances to the next step (desired: a time-capped step is a completed step).
- Run `end_reason` should say `time_limit` (recorder consumes a stop-reason hint from session).
- dT/dt: 2-state Kalman filter (T, rate) server-side in TemperatureManager, handles irregular
  sampling, resets on >120s gaps; expose `dTdtCPerMin` in readings; show in TopBar chips.
- Live temps: accumulate points client-side in useDeviceSession (like livePoints), t = current
  reading.elapsedS; merge with historical per-run temp data in ChartView.
- Chart colors: `colorBy` = run (default) | mode (charge blues / discharge oranges) | cell.
  Cell filter dropdown (All / per-cell / no-cell). Controls in bottom bar next to days filter.
- Tooltip: interpolate sparse series between bracketing points; compute distances in CSS px on
  the correct scale; drive uPlot focus (`focus.alpha` + `setSeries`) from the same nearest-series
  computation; bold the nearest row in the tooltip.

## Progress

- [x] Investigate time-limit bug (root cause above)
- [x] Investigate tooltip/highlight bugs
- [x] Plan written
- [x] Server: DeviceSession host-side max-time watchdog + stop reason
- [x] Server: recovery carries maxTimeMin (index.ts provider + RecoveryState)
- [x] Server: cycle-runner + /api/test/start|continue pass maxTimeMin to startCCV
- [x] Server: temp alert aborts cycle (index.ts wiring, abort(reason))
- [x] Server: Kalman dT/dt (`src/server/temp-rate-filter.ts` + tests, wired into TemperatureManager)
- [x] Recorder: end_reason 'time_limit' / 'temp_alert' via session.consumeStopReason()
- [x] Frontend: TopBar mode-aware tMax/Icut display + dT/dt in temp chips
- [x] Frontend: Chart tooltip fixes + nearest-series focus highlight (uPlot focus.alpha)
- [x] Frontend: color-by (run/mode/cell) + cell filter + stable color map
- [x] Frontend: live temp accumulation + chart plotting; temperature metric on by default
- [x] biome format on touched files, tsc clean on touched files, 17 tests pass, bundles build
- [x] Committed: 46f9e61 (server), 52d95a9 (frontend)
- [x] End Step button (two-tap confirm) + POST /api/cycle/end-step + end_reason='step_ended_early' (fb4d751)
- [x] TopBar temp chips link to /temperature settings page (fb4d751)
- [x] Deployed 2026-07-10 ~13:46 + 13:59 PDT (two passes; second pushed camera-off env).
      Verified: cycle program #15 recovered mid-charge (run #110 reopened, 4.3s gap,
      time limit 480 min armed from setpoints), camera reports configured:false.
- [x] Camera disabled: RTSP_URL/RTSP_FILTER commented out in .env.local; deploy.ts now
      always writes the Pi env file so removals propagate, and --once mode exits (4d7a30f).

## Round 2 (2026-07-10, committed, NOT deployed — user will say when)

- 7722b40 (server): ?cellId= on /api/runs/recent; DELETE /api/cells/:id (+force);
  temp readings persist on the run's elapsed clock (device elapsed), fixing drift
  on recovered runs.
- b3f46db (frontend): temps on a separate chart below the main one, x-synced
  (crosshair + drag-zoom, plot areas padded to align). Temp series per (run,
  channel) — the old per-channel merge concatenated points across runs' separate
  elapsed axes, which is why the temp timebase looked wrong. Cells modal replaces
  the cell dropdown: lists ALL cells (cell #1 was missing because it derived from
  the 100-most-recent runs), per-cell hide, "Load runs" for out-of-window cells,
  two-step cell deletion (escalates when the cell has runs — for the "asdf" cell).

## Deploy notes

- `bun src/run/deploy.ts --once` is the one-shot deploy (fixed to exit; was hanging on
  lingering handles). `bun run start` is the continuous watch-deploy.
- Shutdown noise fixed (07e26ef, committed but NOT yet deployed): gracefulShutdown now
  drains the HTTP server (2s cap) before tearing down session/recorder/DB, so deploy
  restarts no longer log "Cannot use a closed database" for in-flight requests.
  Deploy this with the next batch — do not restart the Pi service just for it.

## Session-collision note (2026-07-09)

A second Claude session was concurrently implementing the same request in this
working tree (its plan: `plans/time-limit-tooltip-filters.md`, now marked
superseded). Its buggy tooltip/filter code was what the user was complaining
about; its cycle-runner `timeLimitTimer` was removed in favor of the
DeviceSession watchdog. Its `daysPast` filter and `.filter-select` CSS were
kept and committed as part of this work. If that session resumes, it should
read this plan first. `src/server/serial.ts` + `tcp-bridge.ts` still hold
older (May 8) uncommitted WIP from someone else — left untouched, unstaged.

## Things not to do

- Don't deploy while the charge is running (user said hands off the live system).
- Don't touch `src/server/serial.ts` / `src/server/tcp-bridge.ts` (another thread's WIP).
- Don't "fix" the 5h bug by encoding time into the C-CV frame — the protocol has no such field.
- Don't add a StartModal time field (unrequested feature; API already accepts maxTimeMin).
