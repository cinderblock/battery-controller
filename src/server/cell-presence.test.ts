import { describe, expect, test } from 'bun:test';
import { CellPresenceTracker } from './cell-presence.ts';

/**
 * The EBC-A40L reads ~0 V with nothing on the clips and cell voltage (~2.5-3.6 V
 * for LiFePO4) with a cell connected. The tracker turns that into "is there a
 * cell nobody has identified yet", which drives the scan prompt in the web UI.
 */

/** Feed a run of readings, simulating the ~1 Hz reading stream */
function feed(tracker: CellPresenceTracker, ...voltages: number[]): void {
  for (const v of voltages) tracker.update(v);
}

describe('CellPresenceTracker', () => {
  test('no cell connected at startup means nothing to prompt about', () => {
    const tracker = new CellPresenceTracker();
    feed(tracker, 0, 0, 0);

    expect(tracker.getState()).toMatchObject({ present: false, claimed: false, insertionId: 0 });
  });

  test('connecting a cell raises an unclaimed insertion', () => {
    const tracker = new CellPresenceTracker();
    feed(tracker, 0, 0);
    feed(tracker, 3.3);

    expect(tracker.getState()).toMatchObject({ present: true, claimed: false, barcode: null });
    expect(tracker.getState().insertionId).toBe(1);
  });

  test('claiming with a serial clears the prompt and records the barcode', () => {
    const tracker = new CellPresenceTracker();
    feed(tracker, 0, 3.3);

    expect(tracker.claim('TS-LFP200-007')).toBe(true);
    expect(tracker.getState()).toMatchObject({ claimed: true, barcode: 'TS-LFP200-007' });
  });

  test('claiming without a serial still clears the prompt', () => {
    // "Skip — no barcode", or a run started via the API
    const tracker = new CellPresenceTracker();
    feed(tracker, 0, 3.3);

    expect(tracker.claim(null)).toBe(true);
    expect(tracker.getState()).toMatchObject({ claimed: true, barcode: null });
  });

  test('a claim while nothing is connected is refused', () => {
    // Otherwise it would attach to an insertion that is about to be superseded
    const tracker = new CellPresenceTracker();
    feed(tracker, 0, 0);

    expect(tracker.claim('TS-LFP200-007')).toBe(false);
    expect(tracker.getState().claimed).toBe(false);
  });

  test('swapping cells prompts again with a fresh insertion id', () => {
    const tracker = new CellPresenceTracker();
    feed(tracker, 0, 3.3);
    tracker.claim('CELL-A');
    expect(tracker.getState()).toMatchObject({ claimed: true, insertionId: 1 });

    feed(tracker, 0); // cell removed
    expect(tracker.getState()).toMatchObject({ present: false, claimed: false, barcode: null });

    feed(tracker, 3.2); // next cell on the clips
    expect(tracker.getState()).toMatchObject({ present: true, claimed: false, barcode: null });
    expect(tracker.getState().insertionId).toBe(2);
  });

  test('voltage hovering in the hysteresis band does not re-prompt', () => {
    // A cell resting near the boundary must not flap the prompt on and off
    const tracker = new CellPresenceTracker();
    feed(tracker, 0, 3.3);
    tracker.claim('CELL-A');

    feed(tracker, 1.9, 1.6, 1.8, 1.7, 2.5);

    expect(tracker.getState()).toMatchObject({ claimed: true, insertionId: 1 });
  });

  test('a cell already connected at startup is adopted, not announced', () => {
    // The frontend reloads every browser when the server build id changes, so
    // treating a restart as an insertion would pop the scan modal in every open
    // tab on each deploy — the fan-out this whole feature exists to avoid.
    const tracker = new CellPresenceTracker();
    feed(tracker, 3.3);

    expect(tracker.getState()).toMatchObject({ present: true, claimed: true });
  });

  test('after startup adoption, a genuine swap still prompts', () => {
    const tracker = new CellPresenceTracker();
    feed(tracker, 3.3); // adopted
    feed(tracker, 0); // removed
    feed(tracker, 3.3); // new cell

    expect(tracker.getState()).toMatchObject({ present: true, claimed: false });
  });

  test('listeners fire on insertion, claim and removal', () => {
    const tracker = new CellPresenceTracker();
    feed(tracker, 0); // establishes the "no cell at startup" baseline

    const seen: Array<{ present: boolean; claimed: boolean }> = [];
    tracker.on(s => seen.push({ present: s.present, claimed: s.claimed }));

    feed(tracker, 3.3);
    tracker.claim('CELL-A');
    feed(tracker, 0);

    expect(seen).toEqual([
      { present: true, claimed: false },
      { present: true, claimed: true },
      { present: false, claimed: false },
    ]);
  });

  test('a steady connected cell does not re-emit on every reading', () => {
    const tracker = new CellPresenceTracker();
    feed(tracker, 0);

    let emissions = 0;
    tracker.on(() => emissions++);

    feed(tracker, 3.3, 3.3, 3.29, 3.31, 3.3);

    expect(emissions).toBe(1);
  });
});
