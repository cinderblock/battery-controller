/**
 * StepPalette — source of new step types.
 *
 * Each palette item can be tapped to append to the sequence. Charge and
 * discharge steps start from the selected cell type's limits when one is
 * known, so a new step for a non-LFP type doesn't inherit LFP voltages.
 */

import type { CellLimits, SequenceStep } from '../lib/sequence-types.ts';
import { defaultCCV, defaultDCC, defaultLoop, defaultWait } from '../lib/sequence-types.ts';

// ── Props ──────────────────────────────────────────────────────────

interface StepPaletteProps {
  onAdd: (step: SequenceStep) => void;
  /** Selected cell type's limits; null = no type selected (LFP fallbacks) */
  limits: CellLimits | null;
}

// ── Palette items ──────────────────────────────────────────────────

const PALETTE_ITEMS: { label: string; color: string; factory: (limits: CellLimits | null) => SequenceStep }[] = [
  { label: 'Discharge', color: '#fb923c', factory: defaultDCC },
  { label: 'Charge', color: '#60a5fa', factory: defaultCCV },
  { label: 'Wait', color: '#777', factory: () => defaultWait() },
  { label: 'Loop', color: '#a78bfa', factory: () => defaultLoop() },
];

// ── Component ──────────────────────────────────────────────────────

export function StepPalette({ onAdd, limits }: StepPaletteProps) {
  return (
    <div className="step-palette">
      {PALETTE_ITEMS.map(item => (
        <button key={item.label} type="button" className="palette-btn" onClick={() => onAdd(item.factory(limits))}>
          <span className="palette-dot" style={{ background: item.color }} />
          {item.label}
        </button>
      ))}
    </div>
  );
}
