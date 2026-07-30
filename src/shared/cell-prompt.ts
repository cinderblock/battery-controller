/**
 * Decides whether a browser should be showing the "scan the connected cell"
 * prompt.
 *
 * Split out of ChartView because the rules interact in ways that are easy to
 * get subtly wrong — a prompt that reopens the instant you close it, or one
 * that yanks the wizard away from the person who just scanned into it. Pure
 * function so those cases can be pinned down in tests.
 *
 * Presence itself is decided by the server (src/server/cell-presence.ts): every
 * browser gets the same SSE stream, so a client watching for a voltage edge has
 * no way to know whether another browser already handled it.
 */

export interface CellPromptInputs {
  /** Server's presence state; null before the first snapshot arrives */
  presence: { insertionId: number; present: boolean; claimed: boolean } | null;
  /** Whether the start wizard is currently open, for any reason */
  modalOpen: boolean;
  /** Whether the open wizard was opened by the prompt rather than by a click */
  promptOpened: boolean;
  /** Insertion whose prompt the user dismissed in this browser, if any */
  dismissedInsertion: number | null;
  /** Whether this browser is the one that identified the current insertion */
  claimedHere: boolean;
}

export type CellPromptAction = 'open' | 'close' | 'none';

export function decideCellPrompt(input: CellPromptInputs): CellPromptAction {
  const { presence, modalOpen, promptOpened, dismissedInsertion, claimedHere } = input;

  // No cell on the clips — nothing to identify. Retract a prompt if one is up.
  if (!presence?.present) return promptOpened ? 'close' : 'none';

  if (presence.claimed) {
    // Someone said what this cell is. Clear the prompt here, unless it was this
    // browser that said so: that user is mid-wizard and about to choose a test,
    // and closing the wizard under them would drop their work.
    if (promptOpened && !claimedHere) return 'close';
    return 'none';
  }

  // Unidentified cell connected.
  // Don't fight a wizard that is already up, however it was opened.
  if (modalOpen) return 'none';
  // A dismissal sticks for that insertion — otherwise closing the prompt just
  // makes it spring back on the next reading. The next cell prompts again.
  if (dismissedInsertion === presence.insertionId) return 'none';

  return 'open';
}
