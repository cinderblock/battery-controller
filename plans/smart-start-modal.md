# Smart Start Modal — Auto-Detect Cell, 2-Step Wizard

## Goal

Redesign the start flow so it's smarter and more mobile-friendly:

1. **Auto-detect new cell** — when voltage appears on idle device, auto-open the start modal
2. **Two-step mobile wizard**:
   - Step 1: Near-fullscreen barcode scanner (scan or skip)
   - Step 2: Sequence/mode selection with saved sequences prominent + visual preview
3. **Cell notes** — editable notes per cell, shown/editable in the start flow
4. **Sequence priority** — saved sequences shown first with step-type visualization

## Architecture

### Detection logic (ChartView)
- Track previous idle voltage via ref
- When idle, voltage transitions from <1.5V to >2.0V → auto-open modal
- Reset when voltage drops back below 1.5V (cell removed)
- Don't trigger on app load if voltage already present (only transitions)

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

## Progress
- [ ] Server: cell update endpoint
- [ ] StartModal: 2-step wizard rewrite
- [ ] Sequence preview visualization
- [ ] Cell detection auto-open
- [ ] Styling
