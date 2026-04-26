/**
 * StepPalette — draggable source of new step types.
 *
 * Each palette item can be tapped (append to end) or dragged
 * into the pill bar to insert at a specific position.
 */

import type { SequenceStep } from '../lib/sequence-types.ts';
import { defaultDCC, defaultDCP, defaultCCV, defaultWait, defaultLoop } from '../lib/sequence-types.ts';

// ── Props ──────────────────────────────────────────────────────────

interface StepPaletteProps {
  onAdd: (step: SequenceStep) => void;
  startPaletteDrag: (
    step: SequenceStep,
    label: string,
    color: string,
    e: React.PointerEvent,
  ) => void;
}

// ── Palette items ──────────────────────────────────────────────────

const PALETTE_ITEMS: { label: string; color: string; factory: () => SequenceStep }[] = [
  { label: 'Discharge', color: '#fb923c', factory: defaultDCC },
  { label: 'Charge', color: '#60a5fa', factory: defaultCCV },
  { label: 'Wait', color: '#777', factory: defaultWait },
  { label: 'Loop', color: '#a78bfa', factory: defaultLoop },
];

// ── Component ──────────────────────────────────────────────────────

export function StepPalette({ onAdd, startPaletteDrag }: StepPaletteProps) {
  return (
    <div className="step-palette">
      {PALETTE_ITEMS.map(item => (
        <button
          key={item.label}
          className="palette-btn"
          onClick={() => onAdd(item.factory())}
          onPointerDown={e => {
            if (e.pointerType === 'touch' || e.pointerType === 'pen') {
              // On touch, start drag tracking (tap still works via onClick)
              startPaletteDrag(item.factory(), item.label, item.color, e);
            }
          }}
          style={{ touchAction: 'none' }}
        >
          <span className="palette-dot" style={{ background: item.color }} />
          {item.label}
        </button>
      ))}
    </div>
  );
}
