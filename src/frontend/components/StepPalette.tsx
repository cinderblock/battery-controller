/**
 * StepPalette — source of new step types.
 *
 * Each palette item can be tapped to append to the sequence.
 */

import type { SequenceStep } from '../lib/sequence-types.ts';
import { defaultCCV, defaultDCC, defaultLoop, defaultWait } from '../lib/sequence-types.ts';

// ── Props ──────────────────────────────────────────────────────────

interface StepPaletteProps {
  onAdd: (step: SequenceStep) => void;
}

// ── Palette items ──────────────────────────────────────────────────

const PALETTE_ITEMS: { label: string; color: string; factory: () => SequenceStep }[] = [
  { label: 'Discharge', color: '#fb923c', factory: defaultDCC },
  { label: 'Charge', color: '#60a5fa', factory: defaultCCV },
  { label: 'Wait', color: '#777', factory: defaultWait },
  { label: 'Loop', color: '#a78bfa', factory: defaultLoop },
];

// ── Component ──────────────────────────────────────────────────────

export function StepPalette({ onAdd }: StepPaletteProps) {
  return (
    <div className="step-palette">
      {PALETTE_ITEMS.map(item => (
        <button key={item.label} className="palette-btn" onClick={() => onAdd(item.factory())}>
          <span className="palette-dot" style={{ background: item.color }} />
          {item.label}
        </button>
      ))}
    </div>
  );
}
