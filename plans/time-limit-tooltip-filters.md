# Battery Controller: Time Limit, Tooltip, and Chart Filtering Fixes

> **⚠️ SUPERSEDED (2026-07-09 21:35 PT)** by `plans/time-limit-and-chart-fixes.md`
> (session 614286b2). That session took over all three items plus live-temp
> plotting and dT/dt. Specifically:
> - The `timeLimitTimer` added here to cycle-runner.ts was **removed** in favor of
>   host-side enforcement inside DeviceSession (survives restarts via recovery,
>   retries lost stop frames, covers single tests, records end_reason='time_limit').
> - The Chart.tsx closest-series tooltip from this session had two bugs (all
>   distances computed on the V scale; CSS-px cursor compared to canvas-px
>   positions) and was rewritten.
> - The daysPast filter and .filter-select CSS from this session were kept.
> If you are the session that owns this plan: read the other plan before doing
> anything further; do not re-add the cycle-runner timer.

## Goal
Fix three issues:
1. **Time limit bug**: Charge steps with 5h time limit don't stop after 5h (device protocol doesn't support C-CV time limits)
2. **Tooltip/series highlight**: Chart tooltip and closest-series highlighting not working well
3. **Chart filters**: Need more granular filtering and color/grouping controls for comparing battery runs

## Environment
- Project: C:\Users\camer\git\Personal Projects\battery-controller
- Live charging in progress (don't touch live system)
- User will manually stop after current sequence step; deploy fixes after

## Decisions Made
- Implement host-side timeout for ALL step types (C-CV, C-NiMH, etc.) since device doesn't support time limits for most
- Fix tooltip positioning and series highlighting in uPlot chart
- Add filter controls: by step type, by date range, by specific series colors/metadata

## Issues Identified

### 1. Time Limit Bug
**Root cause**: C-CV (charge) command doesn't support maxTimeMin in the device protocol (only D-CC/D-CP do).
- Device ignores C-CV time limit requests
- Need host-side enforcement: stop test after maxTimeMin has elapsed

**What needs fixing**:
- cycle-runner.ts: detect when a step has been running longer than maxTimeMin
- Emit early stop when timeout occurs
- Log the timeout event

### 2. Tooltip & Series Highlighting
**Issues**:
- Tooltip not showing closest series to cursor (showing all series values)
- Tooltip positioning unclear
- No visual highlight of which series the cursor is closest to

**What needs fixing**:
- Improve series-finding algorithm: calculate distance from cursor Y to each series
- Highlight only the closest N series in tooltip
- Better visual hierarchy

### 3. Chart Filtering
**Current state**: 
- Basic filters exist (charge/discharge, complete/partial)
- No per-step-type filter
- No date range picker
- No color/grouping controls

**What needs adding**:
- Filter by step type (D-CC, D-CP, C-CV, wait, etc.)
- Filter by date range (last 24h, last week, custom)
- Color by metadata (cell ID, temperature range, capacity loss, etc.)
- "Save filter" / "Load filter" presets

## Progress

- [x] Identified time limit bug in cycle-runner
- [ ] Implement host-side timeout enforcement for C-CV and other modes
- [ ] Fix tooltip series highlighting and positioning
- [ ] Add date range filter
- [ ] Add color-by-metadata controls
- [ ] Test fixes locally before deploy

## Next Step
Implement host-side time limit timeout in cycle-runner.ts
