# Cycle Runner — stuck on step 5, skipped charge, broken resume

## Goal

Fix the CycleRunner so a lost/ignored step-start command can no longer hang the
sequence forever, and so restart-recovery re-runs an un-run step instead of
skipping it. Then get cell 10 (100104-F02737) back onto the "Increasing
Sequence" test starting at step 5 (the charge that was skipped).

## Environment

- Pi: `pi@coulomb`, service `battery-controller` (systemd), app `/opt/battery-controller`.
- DB: `/opt/battery-controller/data/battery.db` (SQLite, WAL). `sqlite3` present on Pi.
- Deploy from this repo: `.env.local` sets `DEPLOY_HOST=coulomb`; run `bun start --once`
  (builds in memory, rsync-over-SSH, `systemctl restart battery-controller`).
- Key code: `src/server/cycle-runner.ts`, `src/server/device-session.ts`.
- Journald for the service is volatile — only retains since the last service
  start (11:45:49 PDT 2026-07-22). Older logs are gone; DB is ground truth.

## What happened (investigation, 2026-07-22)

Program #31 "Increasing Sequence", cell 10, started 2026-07-21 19:27Z.
Step list (0-indexed exec plan, 15 steps):
`c-cv, wait, d-cc, wait, c-cv, wait, d-cc, wait, c-cv, wait, d-cc, wait, c-cv, wait, d-cc`

test_runs for program 31:
- idx0 c-cv (run 200) done → idx1 wait (201) → idx2 d-cc discharge (202, ended 05:06Z)
  → idx3 wait (203, ended **2026-07-22 05:36:53Z**).
- **idx4 c-cv "10A 3.7V 2A" charge — NO RUN ROW. Never executed.** ~13 h gap.
- Service restarted **11:45:49 PDT** (18:45Z). Resume logged
  `Cycle resuming from step 6/15` — i.e. it took the "device idle, non-wait step"
  branch, did `execIndex++` (4→5) and **skipped the charge**, then marched on:
  idx5 wait (204), idx6 d-cc 20A discharge on the now-empty cell (205: 84 s,
  220 mAh, Vpk 2.84 V — instant IR trip), idx7 wait (206)...

Net: the charge that should have refilled the cell after the idx2 discharge was
skipped, so the cell sat near-empty ~13 h and the later discharges run on empty
→ garbage data. Cell is fine (LiFePO4 tolerates low SoC), just needs charging.

### Root cause — two bugs

1. **No step-start confirmation (the hang).** `executeCurrentStep()` sends
   `startCCV`/`startDCC`/... and then relies solely on `onSessionEvent` seeing a
   later `stateChange → idle` to advance. If the device never *enters* the
   running mode (start frame lost / ignored / transient serial error — the
   `await session.startX()` is called from a `setTimeout` callback with no
   `.catch`), the runner sits in `status='running'` forever. `endCurrentStep()`
   then throws ("No step is currently running") because `session.isRunning()`
   is false → the "End Step does nothing, System Idle, stuck on step 5" symptom.
   DeviceSession already emits a `commandTimeout` event after 5 s, but
   CycleRunner ignores it.

2. **Resume skips an un-run step.** `resumeProgram()`'s final branch (device
   idle, non-wait step) unconditionally does `execIndex++`. It assumes an idle
   device on a non-wait step means that step *finished*. If the step never ran
   (no finalized run for this `cycle_step_index`), it should **re-run** it, not
   skip it. This turned bug 1 (a recoverable hang) into silent data loss.

## Plan / steps

- [ ] Fix 1: after sending a running-step start, confirm the device enters the
      expected mode within a timeout; re-send on failure (a few attempts), and
      surface a hard failure instead of hanging silently. Restart-safe.
- [ ] Fix 2: in `resumeProgram()` idle/non-wait branch, if the current step has
      no finalized run, re-execute it instead of `execIndex++`.
- [ ] Fix 3: `.catch` the fire-and-forget `executeCurrentStep()` calls
      (wait-timer, resume timers, advance) so a throw logs + sets error state.
- [ ] Typecheck / lint / tests.
- [ ] Deploy to coulomb.
- [ ] Operational recovery: stop the current mis-run of #31, decide data
      handling (see Open questions), get cell 10 back on the test at step 5.
- [ ] Verify the cell actually starts charging (c-cv, current > 0, V rising).

## Open questions for the user

1. Recovery approach for program #31 (see AskUserQuestion):
   - **A (recommended): resume #31 in place at step 5.** Delete the garbage runs
     204/205/206 (idx5–7, on the skipped-charge empty cell), set
     `current_step=4, status='running'`, restart → fixed resume re-runs the
     charge and continues 5→15. Keeps steps 1–4 linked in one program.
   - B: abort #31, start a fresh program of just steps 5→15.

## Things not to do

- Don't touch Cloudflare/servers/infra beyond this app + its DB (authorized).
- Don't `git checkout/restore/reset --hard` — shared working tree.
