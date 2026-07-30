# Cell Presence Prompt — "New cell detected, scan serial"

## Goal

When a cell is physically connected to an idle device and nobody has said what
cell it is, every browser that is open (or that opens later) should offer the
scan wizard. As soon as **any** browser specifies the serial, the prompt goes
away **everywhere**.

This replaces the earlier voltage-transition auto-open, which was removed in
commit `6c0f0e6` because it fanned out to every tab with no way to clear it.
See [smart-start-modal.md](smart-start-modal.md) for that history.

## Environment / context

- Server: Bun, `src/server/index.ts`, deployed to `pi@coulomb` via `bun start`.
- Frontend: React SPA, state pushed over SSE (`/api/events`).
- Device: EBC-A40L. Idle with no cell reads ~0 V; a connected LiFePO4 cell
  reads ~2.5–3.6 V.

## Decisions already made (don't re-ask)

- **Server tracks unclaimed insertions.** Not a pure client-side heuristic —
  the client can't tell "cell just inserted" from "cell has been sitting here
  since yesterday and I already ran it".
- **Auto-open the wizard**, at the scan step, with a "new cell detected" note.
  Not an inline banner.
- **Auto-close everywhere** once the serial is specified on any browser.
- **Closing is allowed** — a manual dismiss must stick for that insertion.
- The earlier voltage-transition auto-open stays deleted; this is a different
  mechanism (durable server state, not a client-side edge detector).

## Design

### Server: `src/server/cell-presence.ts`

Tracks one piece of state, fed from every non-info reading:

```ts
interface CellPresenceState {
  insertionId: number; // monotonic; increments on each insertion
  present: boolean; // a cell is physically connected
  barcode: string | null; // serial claimed for this insertion
  claimed: boolean; // identified, or a run was started
}
```

- Presence uses hysteresis: **> 2.0 V ⇒ present**, **< 1.5 V ⇒ absent**.
  Between the two, presence is unchanged. Avoids chatter at the boundary.
- absent → present increments `insertionId`, clears `barcode`/`claimed`.
- present → absent clears everything.
- `claim(barcode | null)` sets `claimed = true`.

### Claim triggers

| Trigger                                   | Where                                      |
| ----------------------------------------- | ------------------------------------------ |
| Serial typed or scanned in the wizard     | frontend → `POST /api/cell-presence/claim` |
| "Continue — <barcode>" quick button       | same                                       |
| A run starts (covers "Skip — no barcode") | server-side, on test/cycle start           |

### Startup adoption (important)

On the **first** reading after server start, presence is adopted **as already
claimed** rather than counted as a fresh insertion.

Reason: `useDeviceSession.ts` reloads every browser when the server build id
changes. Without adoption, every deploy would pop the scan modal in every open
tab — reintroducing the exact bug this replaces. Cost: if you connect a cell
and _then_ deploy, you lose that one prompt. Acceptable.

### Frontend

- `SessionState.cellPresence` carries the state; delivered in the `snapshot`
  and via a `cellPresence` SSE event.
- ChartView auto-opens the wizard when
  `present && !claimed && dismissedInsertionId !== insertionId`.
- Manual dismiss records `insertionId` in **sessionStorage** (survives the
  build reload, clears when the tab closes).
- Auto-close fires only for prompts that were **auto-opened**, and only on
  browsers that did **not** do the claiming — the browser where you scanned
  advances to the configure step instead of having the wizard yanked away.

## Plan / steps

1. [x] `src/server/cell-presence.ts` — tracker + unit-testable pure logic
2. [x] Wire into `src/server/index.ts` — feed readings, broadcast, snapshot
3. [x] `POST /api/cell-presence/claim` endpoint
4. [x] Auto-claim on test/cycle start
5. [x] `useDeviceSession.ts` — state field, SSE handler, `claimCell()`
6. [x] `ChartView.tsx` — auto-open / auto-close / dismissal
7. [x] `StartModal.tsx` — "new cell detected" banner, claim on serial entry
8. [x] Styling for the banner
9. [x] Unit tests — `cell-presence.test.ts` (11), `cell-prompt.test.ts` (12)
10. [ ] **Not done: end-to-end on real hardware.** See "What is NOT verified".

## What is NOT verified

Unit tests cover both decision layers, and typecheck/build/full-suite (97 tests)
pass. **Nothing has been exercised against a device.** Specifically untested:

- That a real cell going on the clips actually crosses 2.0 V in the reading
  stream and raises an insertion.
- The SSE round trip: `cellPresence` event → `SessionState` → wizard opens.
- Two browsers at once: scan on one, prompt clears on the other.
- The startup-adoption path on a real restart with a cell connected.

**Why not:** the server is Pi-only — `SerialManager` defaults to `/dev/serial0`
and shells out to `stty`, so `bun run src/server/index.ts` on Windows dies with
`stty exited with code 1` before the HTTP server binds. The fake device needs a
com0com virtual COM port, which isn't set up on this machine. Real verification
means deploying to `coulomb` and clipping a cell on.

### Frontend decision logic lives in `src/shared/cell-prompt.ts`

`decideCellPrompt()` is pure and returns `'open' | 'close' | 'none'`. Extracted
from ChartView because the repo has no React test infrastructure (no
testing-library), and the rules interact in ways worth pinning down:

- Closing the wizard while the cell is _still_ unidentified must record a
  dismissal **whether the wizard was opened by the prompt or by hand** — the
  first cut only did it for prompts, so hand-opening the wizard and closing it
  made it spring straight back open and look impossible to close.
- The browser that did the scanning must **not** have its wizard auto-closed by
  its own claim, or the user gets dropped before choosing a test.
- Unplugging the cell retracts an open prompt.

## Findings / gotchas

### Camera needs a secure context — satisfied by the Caddy front end

`BarcodeScanner` gates on `hasCameraAccess()` → `navigator.mediaDevices?.getUserMedia`,
which browsers expose **only in a secure context**. Nothing in this repo's deploy
config mentions TLS, which is misleading: **there is a Caddy reverse proxy with a
real cert in front of the app** (user-confirmed 2026-07-30), so browsers reach it
over HTTPS and the camera works normally, including on iOS.

Don't "fix" the missing TLS in the app config — termination is Caddy's job and
lives in the ops repo, not here.

### Info packets never reach the reading stream

`device-session.ts` returns early for info packets (line ~383) and does not emit
a `reading`. So presence can be fed from the reading stream without filtering.
Info packets _do_ still update `this.voltage`, but that is not broadcast.

### Idle capacity registers are stale

`device-session.ts` only updates capacity while running, because idle packets
carry stale device register values. Voltage is valid at idle — that is what
presence keys off.

## Things not to do

- **Don't derive the prompt from a client-side edge detector on the SSE stream.**
  Every client sees the same stream, and none of them knows whether another
  client already handled it. That was the removed bug.
- **Don't auto-close a manually-opened wizard.** Only prompts this client
  auto-opened get closed by a remote claim.
- Don't count the first post-restart reading as an insertion (see adoption).
