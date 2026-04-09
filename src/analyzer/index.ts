#!/usr/bin/env bun

/**
 * Offline Traffic Analyzer
 *
 * Reads recorded JSONL files from the proxy, reconstructs and decodes
 * all frames, and produces annotated output for protocol analysis.
 *
 * Usage:
 *   bun run analyze <file.jsonl>                    # decode all frames
 *   bun run analyze --filter tx <file.jsonl>        # only host->device
 *   bun run analyze --filter rx <file.jsonl>        # only device->host
 *   bun run analyze --raw <file.jsonl>              # show raw hex only
 *   bun run analyze --unknown <file.jsonl>          # highlight unknown fields
 *   bun run analyze --summary <file.jsonl>          # frame counts, timing stats
 */

import type { FrameDirection } from '../protocol/types.ts';
import { formatSummary, formatTimeline, type OutputMode } from './formatter.ts';
import { parseRecording } from './parser.ts';

// ── CLI Argument Parsing ──────────────────────────────────────────────

interface AnalyzerConfig {
  filePath: string;
  mode: OutputMode;
  filter: FrameDirection | null;
}

function parseArgs(): AnalyzerConfig {
  const argv = process.argv.slice(2);
  const config: AnalyzerConfig = {
    filePath: '',
    mode: 'decode',
    filter: null,
  };

  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--filter':
        config.filter = argv[++i] as FrameDirection;
        if (config.filter !== 'tx' && config.filter !== 'rx') {
          console.error(`Error: --filter must be "tx" or "rx", got "${config.filter}"`);
          process.exit(1);
        }
        break;
      case '--raw':
        config.mode = 'raw';
        break;
      case '--unknown':
        config.mode = 'unknown';
        break;
      case '--summary':
        config.mode = 'summary';
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (!argv[i].startsWith('--')) {
          positional.push(argv[i]);
        }
    }
  }

  config.filePath = positional[0] ?? '';

  if (!config.filePath) {
    console.error('Error: no input file specified');
    printUsage();
    process.exit(1);
  }

  return config;
}

function printUsage(): void {
  console.log(`
Usage: bun run analyze [options] <file.jsonl>

Options:
  --filter <tx|rx>   Show only frames in the given direction
  --raw              Show raw hex bytes only (no field decoding)
  --unknown          Highlight model-dependent/unknown fields in yellow
  --summary          Show recording summary statistics only
  -h, --help         Show this help message

Examples:
  bun run analyze recordings/2026-04-08T14-30-00.jsonl
  bun run analyze --filter rx --unknown recordings/latest.jsonl
  bun run analyze --summary recordings/latest.jsonl
`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs();

  // Parse the recording
  const { timeline, summary } = await parseRecording(config.filePath);

  // Summary-only mode
  if (config.mode === 'summary') {
    console.log(formatSummary(summary));
    return;
  }

  // Always print summary header
  console.log(formatSummary(summary));
  console.log();

  // Apply direction filter (notes always pass through)
  let filteredTimeline = timeline;
  if (config.filter) {
    filteredTimeline = timeline.filter(e => e.type === 'note' || e.data.direction === config.filter);
  }

  if (filteredTimeline.length === 0) {
    console.log('No frames found.');
    return;
  }

  // Format and print
  const lines = formatTimeline(filteredTimeline, config.mode);
  for (const line of lines) {
    console.log(line);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
