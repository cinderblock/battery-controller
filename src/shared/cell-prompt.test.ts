import { describe, expect, test } from 'bun:test';
import { type CellPromptInputs, decideCellPrompt } from './cell-prompt.ts';

const base: CellPromptInputs = {
  presence: { insertionId: 1, present: true, claimed: false },
  modalOpen: false,
  promptOpened: false,
  dismissedInsertion: null,
  claimedHere: false,
};

/** Override fields on the default "unidentified cell just connected" case */
function at(overrides: Partial<CellPromptInputs>): CellPromptInputs {
  return { ...base, ...overrides };
}

describe('decideCellPrompt', () => {
  test('prompts when an unidentified cell is connected', () => {
    expect(decideCellPrompt(base)).toBe('open');
  });

  test('stays quiet before the first snapshot arrives', () => {
    expect(decideCellPrompt(at({ presence: null }))).toBe('none');
  });

  test('stays quiet with nothing on the clips', () => {
    expect(decideCellPrompt(at({ presence: { insertionId: 0, present: false, claimed: false } }))).toBe('none');
  });

  test('retracts the prompt if the cell is unplugged while it is up', () => {
    const input = at({
      presence: { insertionId: 1, present: false, claimed: false },
      modalOpen: true,
      promptOpened: true,
    });
    expect(decideCellPrompt(input)).toBe('close');
  });

  test('closes when another browser identifies the cell', () => {
    const input = at({
      presence: { insertionId: 1, present: true, claimed: true },
      modalOpen: true,
      promptOpened: true,
      claimedHere: false,
    });
    expect(decideCellPrompt(input)).toBe('close');
  });

  test('does NOT close on the browser that did the scanning', () => {
    // That user is on the configure step choosing a test — closing the wizard
    // under them would throw away what they just did.
    const input = at({
      presence: { insertionId: 1, present: true, claimed: true },
      modalOpen: true,
      promptOpened: true,
      claimedHere: true,
    });
    expect(decideCellPrompt(input)).toBe('none');
  });

  test('leaves a hand-opened wizard alone when a remote claim lands', () => {
    const input = at({
      presence: { insertionId: 1, present: true, claimed: true },
      modalOpen: true,
      promptOpened: false, // opened via the New Run button
    });
    expect(decideCellPrompt(input)).toBe('none');
  });

  test('does not open a second time over an already-open wizard', () => {
    expect(decideCellPrompt(at({ modalOpen: true }))).toBe('none');
  });

  test('a dismissal sticks for that insertion', () => {
    expect(decideCellPrompt(at({ dismissedInsertion: 1 }))).toBe('none');
  });

  test('a dismissal does not carry over to the next cell', () => {
    const input = at({
      presence: { insertionId: 2, present: true, claimed: false },
      dismissedInsertion: 1,
    });
    expect(decideCellPrompt(input)).toBe('open');
  });

  test('an identified cell sitting connected does not prompt', () => {
    const input = at({ presence: { insertionId: 1, present: true, claimed: true } });
    expect(decideCellPrompt(input)).toBe('none');
  });

  test('closing then reopening is stable — no flap', () => {
    // The failure this guards against: dismiss sets state, the effect re-runs on
    // the next reading, and the prompt springs straight back open.
    const dismissed = at({ dismissedInsertion: 1, modalOpen: false, promptOpened: false });
    expect(decideCellPrompt(dismissed)).toBe('none');
    expect(decideCellPrompt(dismissed)).toBe('none');
  });
});
