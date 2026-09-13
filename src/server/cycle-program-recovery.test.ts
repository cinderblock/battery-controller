import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  abortStaleCyclePrograms,
  closeDb,
  createCycleProgram,
  getActiveCycleProgram,
  getCycleProgram,
  initDb,
  updateCycleProgram,
} from './db.ts';

/**
 * Which program a restart resumes. A step that fails to start leaves its
 * program 'running' in the DB on purpose (so a restart can retry it), but the
 * runner then accepts a new sequence on top of it — so several programs can be
 * marked running at once. On 2026-08-13 the resume picked the oldest of them
 * (#32) instead of the live one; these tests pin the newest-wins rule and the
 * cleanup of the leftovers.
 */

function running(name: string): number {
  const p = createCycleProgram(null, name, '[]');
  updateCycleProgram(p.id, { status: 'running', started_at: new Date().toISOString() });
  return p.id;
}

describe('cycle program recovery', () => {
  beforeEach(() => {
    initDb(':memory:');
  });
  afterEach(() => {
    closeDb();
  });

  test('the newest running program is the one to resume', () => {
    running('old leftover');
    running('older leftover');
    const live = running('live');

    expect(getActiveCycleProgram()?.id).toBe(live);
  });

  test('aborting stale programs keeps the live one and stamps the rest', () => {
    const a = running('old leftover');
    const b = running('older leftover');
    const live = running('live');
    const pending = createCycleProgram(null, 'never started', '[]').id;

    expect(abortStaleCyclePrograms(live)).toBe(3);

    expect(getCycleProgram(live)?.status).toBe('running');
    for (const id of [a, b, pending]) {
      const p = getCycleProgram(id);
      expect(p?.status).toBe('aborted');
      expect(p?.ended_at).not.toBeNull();
    }
    expect(getActiveCycleProgram()?.id).toBe(live);
  });

  test('starting a new sequence closes out every leftover', () => {
    running('errored last week');
    running('errored yesterday');

    expect(abortStaleCyclePrograms(null)).toBe(2);
    expect(getActiveCycleProgram()).toBeNull();
    expect(abortStaleCyclePrograms(null)).toBe(0);
  });

  test('completed and aborted programs are never touched', () => {
    const done = createCycleProgram(null, 'done', '[]').id;
    updateCycleProgram(done, { status: 'completed', ended_at: '2026-09-01T00:00:00Z' });

    expect(abortStaleCyclePrograms(null)).toBe(0);
    expect(getCycleProgram(done)?.ended_at).toBe('2026-09-01T00:00:00Z');
  });
});
