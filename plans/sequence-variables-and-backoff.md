# Sequence Variables + Discharge Auto-Backoff

## Goal

Make the cycle tool fit for analyzing the high-IR cells (see
`plans/internal-resistance-estimate.md`):

1. **Sequence variables** — a sequence defines named numbers (e.g. "Discharge A",
   "Cutoff V"); step fields bind to them, so one number adjusts every bound field.
   Values are also adjustable per-launch in the Start modal.
2. **Discharge auto-backoff** — when a d-cc step trips its voltage cutoff essentially
   instantly (IR sag, not real emptiness), automatically retry the step at half the
   current, repeating down to a floor (default 10 A). Tripped micro-runs get
   `exclude_from_capacity` so they don't pollute stats.
3. Mark the existing sub-second junk discharges (runs 97, 101, 105, 109, 125)
   `exclude_from_capacity` on the live DB, and add a PATCH API for the flag.

## Design decisions (don't re-ask)

- **Bindings, not expressions**: each executable step gets `bind?: { [field]: varKey }`.
  The numeric field keeps its last value (fallback when a variable is deleted), and
  `resolveSteps(steps, variables)` overwrites bound fields. This keeps every consumer
  (simulation, timeline, runner, labels) working on plain numbers — no type churn.
- Bindable fields: currentA, cutoffV, targetV, cutoffCurrentA, powerW. Times stay plain.
- steps_json format: legacy plain array, or `{ variables: [{key, value}], steps: [...] }`.
  `parseSequenceDoc()` accepts both; serializer emits the plain array when there are no
  variables (back-compat).
- Server resolves variables in `startSequence(name, steps, cellId, variables)` and
  stores RESOLVED steps in cycle_programs.steps_json → resume/timeline code unchanged.
- Backoff is per-step on d-cc: `backoff?: { minA: number }`. New d-cc steps default to
  `{ minA: 10 }` (user: "backoff to 10A").
- Trip detection: finalized run has `duration_s < 30 && final_capacity_mah < 100` and
  `end_reason` in ('manual_stop', 'complete'). Device-initiated voltage cutoff records
  'manual_stop' (confirmed from runs 118/125), so it must be in the allow-list.
  Excluded reasons (no backoff): temp_alert, time_limit, step_ended_early, fault,
  service_restart/shutdown, null.
- Backoff halves the resolved current, floored at minA; stops when current ≤ minA.
  Exec-plan entry is replaced with a plain-amps clone for that iteration only —
  each loop iteration starts fresh at the programmed current (costs seconds/iteration).
- CycleRunner listener order: runner subscribes BEFORE the recorder, so the run row is
  NOT finalized inside onSessionEvent. The advance already happens in a 2 s deferred
  callback — move execIndex++ and the backoff decision there, where the finalized run
  is readable via getCycleStepRun(). Guard with an advancePending flag and a status
  check (also fixes a pre-existing double-advance/abort-race hazard).

## Known accepted quirks

- User pressing device-stop within 30 s of a backoff-enabled discharge looks like a
  trip and retries at lower current instead of advancing (indistinguishable from a
  device cutoff — both record 'manual_stop'). Cycle UI "end step" uses
  step_ended_early and is unaffected.
- Service restart mid-step rebuilds the exec plan from stored steps, reverting a
  backed-off current; it re-trips and backs off again within seconds. Self-healing.

## Follow-up feedback applied (2026-07-12)

- **No dropdowns**: the variable-binding `<select>` in StepProperties became visible
  chips (one per variable, active highlighted, tap to bind/unbind). User: "dropdowns
  hide the options that are there" — see memory `avoid-dropdowns-in-ui`.
- **Temp limits are system-level only**: removed the per-run temperature alert
  override layer entirely (StartModal section, `tempAlertOverrides` in
  /api/test/start, `setRunAlertOverrides`/`clearRunAlertOverrides`/
  `getEffectiveAlertMax` in TemperatureManager). Channel `alertMaxC`, edited in
  Temperature Settings, is the single source of truth.

## Progress

- [x] Plan
- [x] src/shared/sequence-vars.ts (+ tests)
- [x] Frontend types + presets (bind, backoff, Parametric Cycle preset)
- [x] CycleRunner: variables param, deferred advance, backoff (+ shouldBackOff tests)
- [x] db.ts setRunExcludeFromCapacity + PATCH /api/runs/:id route
- [x] SequenceEditor variables panel + resolved preview + bind-preserving timeline updates
- [x] StepProperties bind dropdowns + backoff controls
- [x] StartModal variable inputs at launch
- [x] Mark runs 97/101/105/109/125 excluded on live DB (done 2026-07-12, sqlite over ssh)
- [x] Commit
- [x] Deployed 2026-07-12 mid-charge — recovery reopened run 127 with a 9s gap, cycle
      program 19 resumed at step 5/15, IR backfill estimated 54/70 historical runs.
      NOTE: program 19's remaining d-cc steps are pre-backoff 40A/2.8V (steps baked at
      program creation) — they will 0Ah-trip until the program is restarted with the
      Parametric Cycle preset.
