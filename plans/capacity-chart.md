# Voltage vs Capacity Chart on Main Page

## Goal

Add a voltage-vs-capacity chart to the main page that shows:
1. **Measured data** — actual test runs plotted as voltage vs capacity (Ah or %)
2. **Computed reference curve** — the simulated LFP voltage model (from `sequence-types.ts`)
3. **Datasheet reference curve** — digitized from TS-LFP200AHA datasheet (room temp, 0.5C)
4. **Hysteresis view** — charge and discharge curves overlaid on same axes

X-axis = capacity % (of nominal), with estimated offset for runs that didn't start at 0% or 100%.
Y-axis = voltage.

## Decisions

- **Use uPlot** for the capacity chart — it's already canvas-based (satisfies performance requirement), handles zoom/pan/resize, and is already a dependency. The user mentioned "canvas for performance" and uPlot IS canvas.
- **View toggle** in the bottom bar: switch between Time view and V-Ah view (not side-by-side; the chart is full-viewport and splitting it would be too small on mobile).
- **X-axis = capacity %** of nominal capacity (0–100%), matching the datasheet format. Both charge and discharge runs go 0→100%.
- **SOC estimation** from initial OCV for partial runs, with visual indication (dashed line segment or annotation) that the offset is estimated.
- **Reference curves as dashed series** in uPlot — the datasheet curve in a muted color, computed curve slightly brighter.
- **Downsample runs** to a fixed capacity% grid (0, 0.5, 1.0, ..., 100%) for alignment. This keeps the merged X array manageable even with many runs.

## Architecture

### New files
- `src/frontend/lib/lfp-reference-curves.ts` — Datasheet curves, OCV-SoC table, computed curve generator
- `src/frontend/components/CapacityChart.tsx` — uPlot wrapper for voltage vs capacity

### Modified files
- `src/frontend/lib/chart-data.ts` — capacity-domain conversion, downsampling, merging
- `src/frontend/views/ChartView.tsx` — view toggle, capacity chart integration
- `src/frontend/styles/main.css` — view toggle styling

## Data model

### Reference curves (static)
```ts
interface ReferenceCurve {
  label: string;
  capacityPct: number[];  // 0–100
  voltage: number[];
  style: 'datasheet' | 'computed';
}
```

### Run → capacity domain conversion
For each run:
1. `capacity_pct[i] = capacity_mah[i] / nominal_capacity_mah * 100`
2. Estimate initial SoC from first voltage reading via OCV-SoC lookup
3. If discharge & initial SoC < 95%: offset = (100 - initial_SoC), shift all capacity_pct by offset
4. If charge & initial SoC > 5%: offset = initial_SoC, shift all capacity_pct by offset
5. Downsample to fixed grid via linear interpolation

### OCV-SoC lookup
LFP OCV is very flat in the 20–80% SoC range (~3.22–3.30V), so estimation there is inherently imprecise. We'll use a piecewise-linear interpolation through ~15 known points.

## Progress

- [x] Create reference curves data — `src/frontend/lib/lfp-reference-curves.ts`
- [x] Create capacity chart data utilities — added to `src/frontend/lib/chart-data.ts`
- [x] Create CapacityChart component — `src/frontend/components/CapacityChart.tsx`
- [x] Integrate into ChartView — view toggle (Time / V-Ah) in bottom bar
- [x] Styling — `.chart-mode-toggle` in `main.css`
- [ ] Test with real data on device
