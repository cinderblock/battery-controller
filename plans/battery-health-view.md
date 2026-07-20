# Battery Health View

A dedicated top-level view for comparing/ranking/culling tested cells, matching
cells into a pack, comparing discharge curves, and tracking degradation.

## Goal

Give a clear way to:

1. **Rank & cull** — sortable list of all cells by capacity / IR / health%, spot the
   best and the junk at a glance, mark weak cells to retire.
2. **Match into a pack** — select N cells and see how well-matched they are (capacity
   spread, IR spread); help pick a balanced pack.
3. **Compare curves** — overlay discharge/charge curves of selected cells (shape, sag,
   capacity).
4. **Track degradation** — per-cell capacity/IR trend over cycles.

All four confirmed wanted by the user (2026-07-20). Reached via a **new top-level
view/tab** (user's choice), not an expanded modal.

## Environment / context

- React 18 + TS SPA, bundled by Bun server. No router lib — hand-rolled path switch in
  `src/frontend/App.tsx` (`if (path === '/x') return <X/>`). Add a branch + a nav link.
- Views live in `src/frontend/views/`. Nav is plain `<a href="/...">` (full nav) using
  `.btn .btn-link`; back links use `.btn .btn-back`.
- Shared session via `SessionContext` / `useSession()` (only needed for live data — the
  health view is mostly static REST, so it may not need the session at all).
- Styling: plain CSS in `src/frontend/styles/main.css` with `:root` design tokens
  (`--bg`, `--surface`, `--accent`, `--charge-color`, `--discharge-color`, health colors
  via `healthColor()` in LegendPanel). No CSS modules / Tailwind. Reuse `.btn`,
  `.filter-chip`, `.modal-*` classes.
- Charts: `Chart.tsx` (uPlot, time-domain, multi-run, multi-axis) and `CapacityChart.tsx`
  (V-vs-SoC% capacity domain w/ reference curves). Data-shaping in `lib/chart-data.ts`
  (`mergeRunsForChart`, `runToCapacityDomain`, `compactDataToChartRun`, color maps).

### Backend is (almost) already done — key finding

`src/server/capacity-estimation.ts` already computes everything for ranking/degradation:

- `GET /api/capacity/all` → `CellCapacityStats[]` (all cells with discharge data).
- `GET /api/cell-groups/:id/summary` → `GroupFleetSummary` (weakest/strongest, avg health).
- `GET /api/cells/:id/capacity` → one cell's `CellCapacityStats`.
- `CellCapacityStats`: `latestAh, mean/median/stddev/min/maxAh, trendAhPerCycle,
trendPctPerCycle, healthPct, nominalAh, latestIrMohm, medianIrMohm, irRunCount`, and
  `runs: RunSummary[]` where each run = `{ id, date, capacityAh, currentA, durationS,
normalizedAh }`. `normalizedAh` = Peukert-normalized to 40 A (C/5).
- "Capacity @ different rates" is derivable client-side by bucketing `runs` on `currentA`.

For curve compare: `GET /api/runs/recent?cellId=N` (metadata) + `GET /api/runs/:id/data?compact=1`
(compact `d[]` array) → `compactDataToChartRun` → feed `Chart`/`CapacityChart`.

Caveat: capacity stats include **only completed d-cc discharge runs** (not charge). IR
spans charge+discharge. That's fine for ranking; note it in the UI ("discharge runs").

## Decisions already made (don't re-ask)

- New top-level route `/health`, added to the `App.tsx` router + a `Health` nav link in
  ChartView's bottom bar (next to Sequences).
- All four capabilities in scope, built in phases (below).
- Reuse `CellCapacityStats` / existing endpoints; avoid new heavy backend where possible.
- Reuse `healthColor()`/`trendArrow()` presentation from LegendPanel (lift to a shared
  `lib/health-format.ts` so both the panel and the new view share them).
- **Culling = a soft `retired` flag on the cell**, NOT delete (deleting loses run
  history). Needs a small backend addition (see Phase 1 / open question 1).
- No dropdowns for sort/filter — use inline chips/toggle buttons (user pref).
- No `title=` tooltips anywhere — inline hints / tap-to-expand only (user pref).

## Plan / steps (phased)

### Phase 0 — Scaffold ← current

- [ ] `src/frontend/views/HealthView.tsx` — new view; back link + nav; fetch
      `/api/capacity/all` and `/api/cell-groups`. Empty-state when no data.
- [ ] `App.tsx`: route `/health` → `HealthView`.
- [ ] ChartView bottom bar: `<a href="/health" className="btn btn-link">Health</a>`.
- [ ] `lib/health-format.ts`: lift `healthColor`, `trendArrow`, `formatIr`, `formatAh`;
      refactor LegendPanel to import them (no behavior change).
- [ ] Styles: `.health-*` section in `main.css`.

### Phase 1 — Rank & cull table

- [ ] Sortable cell table: name, latest Ah, health%, latest IR, median IR, trend,
      #runs, capacity@rate buckets (e.g. ~10 A / ~20 A / ~40 A columns from `runs`).
      Sort via chip buttons (capacity / health / IR / name), asc/desc toggle.
- [ ] Health bar per row (reuse fleet-cell-bar visual).
- [ ] Retire/cull affordance: mark a cell retired (soft flag), row dims + moves to a
      "Retired" section; unretire. (Backend flag — open question 1.)
- [ ] Row → link/expand to that cell's detail (Phase 4).

### Phase 2 — Pack matching

- [ ] Multi-select cells (checkbox per row). Selected-set panel shows: count, capacity
      spread (min/max/Δ/σ, and % spread), IR spread, mean capacity, total pack Ah (series
      pack = weakest cell × N; note that).
- [ ] "Best match" helper: given a target pack size N, suggest the N cells with the
      tightest capacity cluster (simple sliding window over capacity-sorted cells).
- [ ] Match-quality indicator (green/amber/red by capacity spread threshold).

### Phase 3 — Compare curves

- [ ] For selected cells, fetch their latest (or a chosen) discharge run and overlay.
- [ ] Reuse `CapacityChart` (V vs SoC%) as primary — best for shape/sag comparison —
      with a toggle to time-domain `Chart`. Color by cell.
- [ ] Lazy-load run data only for selected cells (per-cell fetch, small pool).

### Phase 4 — Degradation detail

- [ ] Per-cell expand/panel: capacity-over-cycles + IR-over-cycles mini charts (sparkline
      or small uPlot), the run list, trend numbers, notes (editable via `PATCH
    /api/cells/:id`), retire toggle.

## Open questions for the user

1. **Culling model.** Recommend a soft `retired_at`/`status` flag on `cells` (migration
   v8) so retiring keeps history and just hides/greys the cell — vs. reusing the existing
   hard delete. Recommend soft flag. (Proceeding with soft flag unless told otherwise.)
2. **"Charge rate" wording.** The metric we have per run is the **discharge** rate
   (`setpoint_current_a` on d-cc runs). Assuming "capacity @ different charge rates" means
   discharge C-rates (10/20/40 A). Confirm if charge-rate capacity is also wanted.

## Things not to do

- Don't add `title=` tooltips; no dropdowns for sort/filter.
- Don't hard-delete cells for "cull" — soft-retire (unless user overrides).
- Don't rebuild chart plumbing — reuse `Chart`/`CapacityChart` + `chart-data.ts`.
- Don't block on the session context; this view is REST-driven.
- Don't deploy/restart the server while a cycle is running (standing project rule).

## Progress log

- 2026-07-20: Surveyed frontend (router, views, chart stack, styling) and backend
  (SQLite schema, capacity-estimation stats, endpoints). Confirmed the analytics backend
  already exists. User chose: all four capabilities, new top-level view. Wrote this plan.
