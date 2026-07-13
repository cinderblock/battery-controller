/**
 * StepPill — compact chip representing a single sequence step.
 *
 * Shows a colored dot, type abbreviation, and one key setpoint value.
 * Used inside StepPillBar for the horizontal sequence layout.
 */

import type { SequenceStep, StepPath } from '../lib/sequence-types.ts';
import { resolveCurrentA } from '../lib/sequence-types.ts';

// ── Props ──────────────────────────────────────────────────────────

interface StepPillProps {
  step: SequenceStep;
  path: StepPath;
  selected: boolean;
  capacityAh: number;
  onSelect: (path: StepPath) => void;
  dragProps?: Record<string, any>;
  isDragging?: boolean;
}

// ── Colors & labels ────────────────────────────────────────────────

const PILL_COLORS: Record<string, string> = {
  'd-cc': '#fb923c',
  'd-cp': '#ffb74d',
  'c-cv': '#60a5fa',
  wait: '#777',
  loop: '#a78bfa',
};

function pillLabel(step: SequenceStep, capacityAh: number): string {
  switch (step.type) {
    case 'd-cc': {
      const amps = resolveCurrentA(step, capacityAh);
      return step.useCRate ? `DCC ${step.currentA.toFixed(1)}C` : `DCC ${amps.toFixed(0)}A`;
    }
    case 'd-cp':
      return `DCP ${step.powerW}W`;
    case 'c-cv': {
      const amps = resolveCurrentA(step, capacityAh);
      return step.useCRate ? `CCV ${step.currentA.toFixed(1)}C` : `CCV ${amps.toFixed(0)}A`;
    }
    case 'wait':
      return `${Math.round(step.durationS / 60)}m`;
    case 'loop':
      return `\u00D7${step.count}`;
  }
}

// ── Component ──────────────────────────────────────────────────────

export function StepPill({ step, path, selected, capacityAh, onSelect, dragProps, isDragging }: StepPillProps) {
  const color = PILL_COLORS[step.type] ?? '#888';

  return (
    <div
      className={`step-pill ${selected ? 'step-pill-selected' : ''} ${isDragging ? 'step-pill-dragging' : ''}`}
      style={{ borderColor: selected ? color : undefined }}
      onClick={e => {
        e.stopPropagation();
        onSelect(path);
      }}
      {...dragProps}
    >
      <span className="step-pill-dot" style={{ background: color }} />
      <span className="step-pill-label">{pillLabel(step, capacityAh)}</span>
    </div>
  );
}
