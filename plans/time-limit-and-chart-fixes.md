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
- [ ] Server: DeviceSession host-side max-time watchdog + stop reason
- [ ] Server: recovery carries maxTimeMin (index.ts provider + RecoveryState)
- [ ] Server: cycle-runner + /api/test/start|continue pass maxTimeMin to startCCV
- [ ] Server: temp alert aborts cycle (index.ts wiring)
- [ ] Server: Kalman dT/dt in TemperatureManager
- [ ] Recorder: end_reason 'time_limit' via session stop-reason hint
- [ ] Frontend: TopBar mode-aware tMax/Icut display + dT/dt in temp chips
- [ ] Frontend: Chart tooltip fixes + nearest-series focus highlight
- [ ] Frontend: color-by + cell filter + stable color map (ChartView/LegendPanel/chart-data)
- [ ] Frontend: live temp accumulation + chart plotting (useDeviceSession/ChartView)
- [ ] lint/format, tests, commit
- [ ] Deploy after user finishes current charge step manually; verify restart recovery picks the cycle back up

## Things not to do

- Don't deploy while the charge is running (user said hands off the live system).
- Don't touch `src/server/serial.ts` / `src/server/tcp-bridge.ts` (another thread's WIP).
- Don't "fix" the 5h bug by encoding time into the C-CV frame — the protocol has no such field.
- Don't add a StartModal time field (unrequested feature; API already accepts maxTimeMin).
