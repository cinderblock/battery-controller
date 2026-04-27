# Chart UX Fixes

## Goal
Fix the chart experience so that: realtime data is clearly visible, historical/live/reference curves are visually distinct, and tooltips + crosshairs work in both Time and V-Ah modes.

## Issues (user-reported)

1. **Realtime data not visible** — "don't see new realtime data coming in"
2. **Can't distinguish run types** — historical vs live vs reference all look the same
3. **Tooltips don't work** — in either mode
4. **Nearest datapoint** — "kinda works in Time mode, not at all in V-Ah"

## Root Causes

### Realtime data
- Data flow is actually wired correctly: WS → livePoints → mergeRunsForChart → Chart.setData
- Live runs are white (`#ffffff`) with alpha, drawn on top of historical runs
- Historical runs desaturate to 35% alpha during active test
- **Problem is visual, not data**: live line gets lost among historical runs, especially when many runs are loaded

### Tooltips
- **Chart.tsx (Time mode)**: Has ZERO tooltip implementation. No setCursor hook, no tooltip element.
- **CapacityChart.tsx (V-Ah mode)**: Has a setCursor hook + tooltip, but it skips reference curves and may have positioning issues.

### Crosshairs
- Both charts have `cursor.points.show: false` — no datapoint markers
- uPlot's default cursor (vertical line) does show, which is the "kinda works" in Time mode
- V-Ah mode has `cursor.points.show: false` explicitly in the cursor config

### Visual distinction
- Historical runs: palette colors at 35% alpha during active test, 100% otherwise
- Live run: white, width 2 vs width 1 for historical — not enough contrast
- Reference curves: very faint (30% alpha) dashed lines — indistinguishable from noise

## Plan

### Phase 1: Add tooltip to Time mode (Chart.tsx)
- [ ] Create tooltip element (same pattern as CapacityChart)
- [ ] Add setCursor hook that shows values at cursor position
- [ ] Show time, and values for all series at that index
- [ ] Match the cap-chart-tooltip CSS classes for consistency

### Phase 2: Fix CapacityChart tooltip
- [ ] Verify tooltip element lifecycle (it should be fine)
- [ ] Test that tooltip actually appears on hover
- [ ] Include reference curves in tooltip (currently skipped)

### Phase 3: Visual distinction
- [ ] Live run: use a distinct bright color (not just white), maybe a glow or thicker line
- [ ] Historical runs: ensure they fade enough when live test active (35% might be too much—try 25%)
- [ ] Reference curves: make dash pattern more pronounced, slightly higher alpha

### Phase 4: Crosshair improvements
- [ ] Enable cursor focus (show which series is nearest)
- [ ] Show point marker at nearest datapoint on hover

## Decisions
- Using same tooltip approach as CapacityChart (DOM element positioned by setCursor hook)
- Not adding a chart library — sticking with uPlot
- Keeping canvas-based rendering for performance

## Progress
- [x] Phase 1 — Chart.tsx: added tooltip element + setCursor hook + formatElapsedShort header
- [x] Phase 2 — CapacityChart.tsx: reference curves now included in tooltip (dimmed), measured first
- [x] Phase 3 — Live color: #00e676 (bright green), historical desatAlpha: 0.20, reference alpha: 0.50/0.65, live width: 2.5
- [x] Phase 4 — Both charts: cursor.points enabled (size 6, white fill)
