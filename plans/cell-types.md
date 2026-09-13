# Cell types: obvious to add, safe to configure

## Goal

Make adding a new kind of cell an obvious, first-class action in the web UI, and
make its settings (capacity, voltages, cutoff current) the thing the app actually
uses — so a cell that isn't a TS-LFP200AHA can't be driven at TS-LFP200AHA
currents by accident.

Asked for on 2026-09-13: "add a more obvious way to add more cells in the UI and
set settings safely".

## Environment / context

- Repo: `C:\Users\camer\git\Personal Projects\battery-controller` (Bun, React 19,
  bun:sqlite). Deploys to the Pi `coulomb` (`/opt/battery-controller`, DB at
  `/opt/battery-controller/data/battery.db`) via `bun start`.
- Lint: `bun run lint` (biome, `--write`). No typecheck script; use `bunx tsc --noEmit`.
- Tests: `bun test` (`src/server/*.test.ts`, `src/shared/*.test.ts`).
- Schema was at **v8** before this work; this adds **v9**.
- Live DB on 2026-09-13 (read-only query): `cell_groups` = `TS-LFP200AHA`
  (200000 mAh, LiFePO4, 3.8 V / 2.8 V / 2.0 A) and a leftover `asdf` (100000 mAh,
  no voltages). 13 cells, **all with `cell_group_id = NULL`**, all with the column
  defaults `nominal_capacity_mah = 200000`, `chemistry = 'LiFePO4'`.
- "Cell group" in code == "cell type" in the UI. Kept the internal name
  (`cell_groups`, `/api/cell-groups`) — renaming DB/API is churn with no
  functional gain. UI text says "cell type".

## What was wrong (findings from the 2026-09-13 read-through)

1. **C-rate used a hardcoded 200 Ah for every cell.** New cells got the column
   default `nominal_capacity_mah = 200000`; `CycleRunner.resolveCapacity()` used
   the cell's own value first and only consulted the group if it was falsy — which
   it never was. A 0.5C step on a 100 Ah cell would run at 100 A. The manual-start
   path had the same hole from the other side: `StartModal` multiplied by the
   *chart's selected group* capacity (falling back to 200), not the scanned cell's.
2. **No cell was in any group** and nothing in the UI could put one there. The
   server route `PUT /api/cells/:id/group` existed with zero callers.
3. **The only "add" UI** was a `+` button in the Sequence Editor that collected
   name/capacity/chemistry and silently dropped the three voltage fields.
4. **No edit, no delete** for groups (hence the stranded `asdf`).
5. Presets, manual defaults, reference curves and the timeline's voltage axis
   are LFP-hardcoded.

## Decisions (don't re-ask)

1. **Cell type is the single source of truth for nominal capacity and chemistry.**
   The per-cell `nominal_capacity_mah` / `chemistry` columns are retired: no
   longer read anywhere, nulled by migration v9, and `upsertCell` inserts NULL
   explicitly so the lingering column DEFAULT can't reintroduce 200000. The
   columns stay (dropping them needs a table rebuild with FK gymnastics on a
   production Pi DB — not worth the risk for a schema nicety).
2. **Migration v9 moves existing capacity facts into type assignments, it does
   not guess.** An ungrouped cell is assigned to a type only when its stored
   `nominal_capacity_mah` equals *exactly one* type's capacity. On the live DB that
   maps all 13 cells → TS-LFP200AHA (the `asdf` type is 100 Ah, so no ambiguity).
   Anything unmatched stays typeless and the UI prompts.
3. **The runner refuses, it does not fall back.** A sequence with any C-rate step
   fails to start with a clear message if the cell has no type (or no cell is
   scanned). Same for manual start: C-rate is now resolved **server-side** from
   the cell's type (`useCRate: true` in the body), so the client can't bypass it.
4. **Capacity is baked into the cycle program at start** (`cycle_programs.
   capacity_ah`, migration v9). Resume reads it back; re-typing a cell mid-run
   can't change a running sequence's currents.
5. **Auto-assign only when unambiguous.** A newly created cell gets a type
   automatically only if exactly one type exists. Otherwise it's typeless and the
   Start wizard shows type chips right under the barcode — one tap to assign.
6. **Type limits are defaults + validation, not run-time enforcement.** Charge
   V / discharge cutoff V / cutoff A seed the manual-start form, the step
   palette and the chart's voltage range. They are validated on entry (server +
   client, chemistry-aware ranges in `src/shared/cell-types.ts`) but a step
   *outside* the type's limits is not blocked at start. Reason: the live
   TS-LFP200AHA type says cutoff 2.8 V while every saved sequence discharges to
   2.5 V — hard enforcement would break the existing workflow on deploy. See
   Open questions.
7. **All three voltage/current fields are required** on create and edit. The
   pre-existing `asdf` row (no voltages) is left as-is by the migration; the UI
   flags it as incomplete until edited or deleted.
8. **Delete is refused, never forced,** while any cell or sequence references
   the type. The error says how many of each; reassign first.
9. **No dropdowns in new UI** (existing memory rule). Chemistry and type
   selection are chips. The pre-existing `<select>`s in ChartView / SequenceEditor
   are left alone; the SequenceEditor's inline `+` mini-form is removed in favour
   of a link to the new page.
10. New page is **`/cell-types`**. Registered in BOTH `App.tsx` and the server
    `routes` map (memory: missing either → "[object Object]" on refresh).

## Plan / steps

1. [x] `src/shared/cell-types.ts` — chemistry table (typical + hard ranges per
       cell), `validateCellType()` shared by server and UI, `suggestedVoltages()`.
       Tests in `cell-types.test.ts`.
2. [x] `db.ts` — migration v9 (match-and-assign, null per-cell columns,
       `cycle_programs.capacity_ah`); `upsertCell` inserts NULL + auto-assigns
       when exactly one type; `resolveCellCapacityAh()`; `createCycleProgram`
       takes capacity; `updateCellGroup`, `deleteCellGroup` (refcounts),
       `getCellGroupsWithUsage`; `createCellGroup` takes required voltages;
       `runMigrations` exported with `upTo` for tests.
3. [x] `cycle-runner.ts` — `resolveCapacity` → type only (baked value wins on
       resume); `startSequence` refuses when C-rate steps present and capacity
       unknown, before writing anything; `resolveCurrentA` throws as backstop;
       step labels show `0.5C→100.0A`.
4. [x] `index.ts` — GET list with usage counts; POST/PATCH/DELETE
       `/api/cell-groups[/:id]` unlock-gated and validated via shared module
       (errors 400 with `issues`, name clash 409, in-use delete 409 with counts);
       `/api/test/start` resolves `useCRate` server-side; `/cell-types` route.
5. [x] `capacity-estimation.ts` — nominal from type (0 → healthPct null; UI
       already guards on `> 0`).
6. [x] Frontend: `CellTypesView` (add/edit/delete with live chemistry-aware
       validation, chips not dropdowns, cells-needing-a-type first with tap-to-
       assign); "Cell Types" link in ChartView bottom bar; SequenceEditor `+`
       mini-form removed → "Manage types" link, palette seeds from type;
       StartModal: type chips under the barcode, manual defaults from the cell's
       type, C-rate sent as multiplier, pointed errors before the server's.
7. [x] CSS (`.ct-*`, wizard chips), README feature bullet. `bun test`: 115 pass.
       `bunx tsc --noEmit`: only pre-existing errors (correlator, proxy, StepCard,
       deploy, Bun `Response` typings) — none in changed lines. Biome: new files
       clean; remaining errors in StartModal/SequenceEditor are pre-existing a11y
       on untouched lines. Frontend bundles (`bun build src/frontend/index.html`).
8. [ ] **← CURRENT:** Commit — only my files. `bun run lint` (`biome --write`)
       reformatted ~25 unrelated files (`src/ocr/*`, `src/proxy/*`, `scripts/*`,
       …); those are NOT staged and were left in the tree untouched.

## Findings / gotchas

- `initDb(path)` takes a path, so tests can use `:memory:`.
- Server already imports shared code from `src/shared/` (`sequence-vars.ts`,
  `ir-estimate.ts`) — that's where cross-cutting validation belongs, not
  `src/frontend/lib`.
- `requireUnlocked()` gates start/stop/delete; type create/edit/delete now sit
  behind it too since they change what a test will do.
- The chemistry windows never overlap charge/cutoff for named chemistries, so the
  "charge must be above cutoff" rule only ever fires for `Other` — test it there.
- Windows `git status` prints `warning: could not open directory 'nul/'` — noise.
- **Don't `sed -n ... -i` a file.** `-n` with `-i` and no `p` truncates it to zero
  bytes. That's how this plan got wiped once and had to be rewritten.
- Large heredocs through the Bash tool can fail with "unexpected EOF while
  looking for matching `'`" — use the Write tool for new source files.

## Open questions for the user

1. **Enforce type limits at start?** i.e. refuse a step whose target V exceeds
   the type's charge voltage or whose cutoff is below the type's discharge cutoff.
   Recommendation: yes, but only after you set TS-LFP200AHA's cutoff to the value
   you actually consider the floor (sequences use 2.5 V; the type says 2.8 V).
   Not built.
2. Chemistry-specific reference curves / timeline axis — cosmetic, not built.

## Things not to do

- Don't reintroduce a capacity fallback (200, "default group", etc.) anywhere in
  the start path. Refusing is the feature.
- Don't `DELETE FROM cell_groups` without the reference check.
- Don't add a route to `App.tsx` without the server `routes` map (and vice versa).
