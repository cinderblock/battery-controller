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

### Phase 0 — Scaffold ✓ (commit 527bc09)

- [x] `src/frontend/views/HealthView.tsx` — new view; back link + nav; fetch
      `/api/capacity/all` and `/api/cells`. Empty-state when no data.
- [x] `App.tsx`: route `/health` → `HealthView`.
- [x] ChartView bottom bar: `<a href="/health" className="btn btn-link">Health</a>`.
- [x] `lib/health-format.ts`: lift `healthColor`, `trendArrow`, `formatIr`, `formatAh`,
      `formatPct`; refactored LegendPanel to import them (no behavior change).
- [x] Styles: `.health-*` section in `main.css`.

### Phase 1 — Rank & cull table ✓ (commit 23df117)

- [x] Sortable cell table: name, latest Ah, health%, latest IR, trend, #runs, and
      capacity@rate chips (median Ah per ~5 A discharge bucket). Sort chips (capacity /
      health / resistance / trend / name) with asc/desc toggle; default capacity high→low.
- [x] Health bar per row.
- [x] Untested cells listed in a separate section (from `/api/cells`).
- [x] Retire/cull: soft-retire flag; retired cells drop to a dimmed "Retired" section with
      a Restore button. Backend = migration v8 + PATCH `retired`.
- [x] Row expands to its detail (Phase 4).

### Phase 2 — Pack matching ✓ (commit 23df117)

- [x] Multi-select cells (checkbox per row). Docked match bar shows: count, capacity
      spread (min/max/Δ + % spread, color-coded), IR range, mean capacity, series pack Ah
      (weakest × N).
- [x] "Best match" helper: pack-size stepper + "Pick tightest" → sliding window over
      capacity-sorted active cells selects the tightest cluster.
- [x] Match-quality color (green <2% / amber <5% / red spread).

### Phase 3 — Compare curves ✓ (commit 23df117)

- [x] "Compare curves" button in the match bar; fetches each selected cell's latest
      discharge run (`/api/runs/:id` + `?compact=1`), converts to capacity domain, overlays
      voltage-only in a `CapacityChart` with one distinct color per cell + a legend.
- [ ] Future: time-domain toggle; pick which run per cell (currently always the latest).

### Phase 4 — Degradation detail ✓ (commit 23df117)

- [x] Per-cell expand: median/range/trend-per-cycle/median-IR stats, a capacity-over-cycles
      SVG sparkline, the run list (date / rate / capacity), an editable notes field
      (`PATCH /api/cells/:id`), and a Retire button.
- [ ] Future: IR-over-cycles trace (needs per-run IR history endpoint or reuse ir-samples).

## Resolved questions

1. **Culling model** → soft-retire flag (user chose). Implemented as `cells.retired_at`
   (migration v8) + PATCH `retired`. History preserved.
2. **"Charge rate" wording** → treated as **discharge** C-rate (`setpoint_current_a` on
   d-cc runs); rate chips bucket by ~5 A. Charge-rate capacity not built (not the metric we
   store per completed-capacity run). Revisit if charge-rate breakdown is wanted.

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
- 2026-07-20: Shipped all four phases (commits 527bc09, 23df117). User chose soft-retire
  and "keep building". Backend path verified against a temp DB (migration v1→v8 applies,
  `getAllCellStats` shape correct, retire round-trip sets/clears `retired_at`). Builds,
  bundles, lints/typechecks clean (my files). STILL NOT rendered against live data — no
  local dev DB (lives on coulomb). To verify: run against a copy of the live DB or deploy
  to the Pi (respect the "no restart during a cycle" rule). Follow-ups noted per phase
  (time-domain compare toggle, per-run selection, IR-over-cycles trace).
