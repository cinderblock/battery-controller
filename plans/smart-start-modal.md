# Smart Start Modal — Auto-Detect Cell, 2-Step Wizard

## Goal

Redesign the start flow so it's smarter and more mobile-friendly:

1. ~~**Auto-detect new cell** — when voltage appears on idle device, auto-open the start modal~~
   **Removed 2026-07-30.** See "Auto-open removed" below.
2. **Two-step mobile wizard**:
   - Step 1: Near-fullscreen barcode scanner (scan or skip)
   - Step 2: Sequence/mode selection with saved sequences prominent + visual preview
3. **Cell notes** — editable notes per cell, shown/editable in the start flow
4. **Sequence priority** — saved sequences shown first with step-type visualization

## Architecture

### ~~Detection logic (ChartView)~~ — removed

Originally: track previous idle voltage via a ref; when idle and voltage
transitions from <1.5 V to >2.0 V, auto-open the modal.

See "Auto-open removed" under Findings.

### Two-step modal

- **Step 1 — Identify Cell**:
  - Camera scanner takes most of the screen (nearly fullscreen)
  - Small manual barcode input at bottom
  - "Skip" button to proceed without barcode
  - On scan → auto-advance to step 2
- **Step 2 — Choose Test**:
  - Cell info bar at top (barcode, existing notes, note input)
  - **Sequences section** (primary): saved sequences as cards with colored step blocks
  - **Simple modes section** (secondary): D-CC / D-CP / C-CV with parameter inputs
  - Start button

### Sequence preview cards

Simple CSS blocks showing step types:

- Blue block = C-CV (charge)
- Orange block = D-CC (discharge)
- Orange striped = D-CP (constant power discharge)
- Grey block = Wait
- Loop bracket beneath

### Server changes

- `PATCH /api/cells/:id` — update label, notes
- `updateCell(id, updates)` DB function

## Files to modify

- `src/server/db.ts` — add `updateCell()`
- `src/server/index.ts` — add `PATCH /api/cells/:id`
- `src/frontend/components/StartModal.tsx` — rewrite as 2-step wizard
- `src/frontend/views/ChartView.tsx` — add voltage-based cell detection
- `src/frontend/styles/main.css` — wizard modal styles
- `src/frontend/api-client.ts` — add Cell type for update

## Findings / gotchas

### Auto-open removed (2026-07-30)

The voltage-transition auto-open was driven entirely by the SSE device-state
broadcast, which every connected browser receives identically. There is no
notion of "the browser the user is standing at", so clipping a cell onto the
idle device popped the scan wizard in **every** open tab at once — phone,
desktop, and the tab already showing the wizard.

Worse, the guard was `!startModalOpen`, so the one tab where the modal was
wanted (the one you'd just opened by hand) was the one tab that suppressed it.

Considered and rejected:

- **Foreground + recently-interacted tab** — narrows it but doesn't fix it;
  two visible tabs still both fire.
- **Server picks one claimant** — needs a new endpoint and an ACK race, and
  can still hand the modal to a background tab.
- **Per-browser opt-in toggle** — predictable, but you have to remember to
  arm it on each device.

Decision: drop it. Starting a run is an explicit "New Run" click. A comment
in `ChartView.tsx` records why, so it doesn't get reintroduced.

## Things not to do

- **Don't reintroduce a modal auto-open keyed off broadcast device state.**
  Any signal derived from the SSE stream is seen by all clients; without a
  server-side notion of an active client it will always fan out to every tab.

## Progress

- [x] Server: cell update endpoint
- [x] StartModal: 2-step wizard rewrite
- [x] Sequence preview visualization
- [x] ~~Cell detection auto-open~~ — built, then removed (see Findings)
- [x] Styling
