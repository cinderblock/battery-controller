/**
 * JSONL Recording Parser
 *
 * Reads recorded JSONL files containing decoded packets, notes,
 * and screenshot references. Each packet record already contains
 * decoded base-240 fields — no frame reassembly needed.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { FrameDirection } from '../protocol/types.ts';
import type { RxPacketRecord, TrafficRecord, TxPacketRecord } from '../proxy/recorder.ts';

/** A packet event in the timeline */
export interface TimestampedPacket {
  time: string;
  mono: number;
  direction: FrameDirection;
  record: TxPacketRecord | RxPacketRecord;
}

/** A user annotation from the recording */
export interface TimestampedNote {
  time: string;
  mono: number;
  text: string;
}

/** A screenshot capture from an RTSP camera */
export interface TimestampedScreenshot {
  time: string;
  mono: number;
  filename: string;
  sizeBytes: number;
}

/** Union type for all events in a recording timeline */
export type TimelineEvent =
  | { type: 'packet'; data: TimestampedPacket }
  | { type: 'note'; data: TimestampedNote }
  | { type: 'screenshot'; data: TimestampedScreenshot };

/** Summary statistics for a recording */
export interface RecordingSummary {
  totalRecords: number;
  txPackets: number;
  rxPackets: number;
  notes: number;
  screenshots: number;
  checksumErrors: number;
  durationMs: number;
  firstTimestamp: string;
  lastTimestamp: string;
}

/**
 * Parse a JSONL recording file into a timeline of events.
 */
export async function parseRecording(filePath: string): Promise<{
  timeline: TimelineEvent[];
  summary: RecordingSummary;
}> {
  const timeline: TimelineEvent[] = [];

  let totalRecords = 0;
  let txPackets = 0;
  let rxPackets = 0;
  let noteCount = 0;
  let screenshotCount = 0;
  let checksumErrors = 0;
  let firstTimestamp = '';
  let lastTimestamp = '';

  const fileStream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let record: TrafficRecord;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    totalRecords++;
    if (!firstTimestamp) firstTimestamp = record.t;
    lastTimestamp = record.t;

    switch (record.dir) {
      case 'tx': {
        const tx = record as TxPacketRecord;
        txPackets++;
        if (!tx.checksumValid) checksumErrors++;
        timeline.push({
          type: 'packet',
          data: { time: tx.t, mono: tx.mono, direction: 'tx', record: tx },
        });
        break;
      }

      case 'rx': {
        const rx = record as RxPacketRecord;
        rxPackets++;
        if (!rx.checksumValid) checksumErrors++;
        timeline.push({
          type: 'packet',
          data: { time: rx.t, mono: rx.mono, direction: 'rx', record: rx },
        });
        break;
      }

      case 'note':
        noteCount++;
        timeline.push({
          type: 'note',
          data: { time: record.t, mono: record.mono, text: record.raw },
        });
        break;

      case 'screenshot':
        screenshotCount++;
        timeline.push({
          type: 'screenshot',
          data: { time: record.t, mono: record.mono, filename: record.raw, sizeBytes: record.len },
        });
        break;
    }
  }

  let durationMs = 0;
  if (firstTimestamp && lastTimestamp) {
    durationMs = new Date(lastTimestamp).getTime() - new Date(firstTimestamp).getTime();
  }

  return {
    timeline,
    summary: {
      totalRecords,
      txPackets,
      rxPackets,
      notes: noteCount,
      screenshots: screenshotCount,
      checksumErrors,
      durationMs,
      firstTimestamp,
      lastTimestamp,
    },
  };
}
