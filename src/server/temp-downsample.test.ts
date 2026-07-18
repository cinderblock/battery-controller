import { describe, expect, test } from 'bun:test';
import { downsampleTempReadings } from './db.ts';

function row(channel_id: number, elapsed_s: number, temp_c: number) {
  return { channel_id, elapsed_s, temp_c, channel_key: `ch${channel_id}`, channel_name: null };
}

describe('downsampleTempReadings', () => {
  test('passes small series through untouched (elapsed-then-channel order)', () => {
    const rows = [row(1, 0, 25), row(2, 0, 30), row(1, 2, 26)];
    expect(downsampleTempReadings(rows, 400)).toEqual(rows);
  });

  test('buckets each channel independently to the cap', () => {
    const rows = [];
    for (let i = 0; i < 1000; i++) {
      rows.push(row(1, i * 2, 25 + (i % 10)));
      rows.push(row(2, i * 2, 30));
    }
    const out = downsampleTempReadings(rows, 100);
    const ch1 = out.filter(r => r.channel_id === 1);
    const ch2 = out.filter(r => r.channel_id === 2);
    expect(ch1.length).toBeLessThanOrEqual(100);
    expect(ch2.length).toBeLessThanOrEqual(100);
    // Bucket means stay within the source range
    for (const r of ch1) {
      expect(r.temp_c).toBeGreaterThanOrEqual(25);
      expect(r.temp_c).toBeLessThanOrEqual(34);
    }
    // Constant channel stays constant
    for (const r of ch2) expect(r.temp_c).toBe(30);
  });

  test('output is sorted by elapsed_s across channels', () => {
    const rows = [];
    for (let i = 0; i < 900; i++) {
      rows.push(row(1, i, 25));
      rows.push(row(2, i, 30));
    }
    const out = downsampleTempReadings(rows, 50);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].elapsed_s).toBeGreaterThanOrEqual(out[i - 1].elapsed_s);
    }
  });
});
