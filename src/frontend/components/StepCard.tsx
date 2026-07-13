/**
 * StepCard — expandable card for editing a single sequence step.
 *
 * Shows a compact summary when collapsed, and full parameter inputs
 * with visual setpoint indicators when expanded. Each parameter has
 * a small bar showing where the value sits in its valid range.
 */

import { useCallback } from 'react';
import type { SequenceStep } from '../lib/sequence-types.ts';
import { estimateDurationH } from '../lib/sequence-types.ts';

// ── Props ──────────────────────────────────────────────────────────

interface StepCardProps {
  step: SequenceStep;
  index: number;
  selected: boolean;
  expanded: boolean;
  capacityAh: number;
  useCRate: boolean;
  totalSteps: number;
  onSelect: (index: number) => void;
  onToggleExpand: (index: number) => void;
  onUpdate: (index: number, step: SequenceStep) => void;
  onRemove: (index: number) => void;
}

// ── Helpers ─────────────────────────────────────────────────────────

function formatDuration(hours: number): string {
  if (hours < 1 / 60) return '<1m';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Visual bar showing a value's position in a range */
function SetpointBar({ value, min, max, color }: { value: number; min: number; max: number; color: string }) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div className="sp-bar">
      <div className="sp-bar-fill" style={{ width: `${pct}%`, background: color }} />
      <div className="sp-bar-marker" style={{ left: `${pct}%`, borderColor: color }} />
    </div>
  );
}

// ── Step type labels ───────────────────────────────────────────────

const TYPE_CONFIG = {
  'd-cc': { label: 'Discharge (D-CC)', icon: 'D', iconClass: 'step-icon-discharge', color: '#fb923c' },
  'd-cp': { label: 'Discharge (D-CP)', icon: 'D', iconClass: 'step-icon-discharge', color: '#ffb74d' },
  'c-cv': { label: 'Charge (C-CV)', icon: 'C', iconClass: 'step-icon-charge', color: '#60a5fa' },
  wait: { label: 'Wait', icon: '\u23F8', iconClass: 'step-icon-wait', color: '#777' },
  loop: { label: 'Loop', icon: '\u27F3', iconClass: 'step-icon-loop', color: '#a78bfa' },
} as const;

// ── Component ──────────────────────────────────────────────────────

export function StepCard({
  step,
  index,
  selected,
  expanded,
  capacityAh,
  useCRate,
  totalSteps,
  onSelect,
  onToggleExpand,
  onUpdate,
  onRemove,
}: StepCardProps) {
  const config = TYPE_CONFIG[step.type];
  const duration = estimateDurationH(step, capacityAh);

  const subtitle = getSubtitle(step, capacityAh, useCRate);

  const handleFieldChange = useCallback(
    (field: string, value: number) => {
      const updated = { ...step, [field]: value } as SequenceStep;
      onUpdate(index, updated);
    },
    [step, index, onUpdate]
  );

  const handleClick = useCallback(() => {
    onSelect(index);
    onToggleExpand(index);
  }, [index, onSelect, onToggleExpand]);

  return (
    <div className={`step-card ${selected ? 'step-selected' : ''} ${expanded ? 'step-expanded' : ''}`}>
      {/* Header */}
      <div className="step-header" onClick={handleClick}>
        <span className="step-drag">{'\u2807'}</span>
        <div className={`step-icon ${config.iconClass}`}>{config.icon}</div>
        <div className="step-info">
          <div className="step-title">{config.label}</div>
          <div className="step-subtitle">{subtitle}</div>
        </div>
        <span className="step-duration">
          {step.type === 'loop' ? `\u00D7${step.count}` : `~${formatDuration(duration)}`}
        </span>
        <span
          className="step-remove"
          onClick={e => {
            e.stopPropagation();
            onRemove(index);
          }}
        >
          {'\u00D7'}
        </span>
      </div>

      {/* Expanded parameters */}
      {expanded && (
        <div className="step-params">
          {step.type === 'd-cc' && (
            <>
              <ParamRow
                label={useCRate ? 'C-rate' : 'Current'}
                value={useCRate ? step.currentA / capacityAh : step.currentA}
                unit={useCRate ? 'C' : 'A'}
                step={0.01}
                min={0}
                max={useCRate ? 1 : 40}
                color={config.color}
                onChange={v => handleFieldChange('currentA', useCRate ? v * capacityAh : v)}
              />
              <ParamRow
                label="Cutoff V"
                value={step.cutoffV}
                unit="V"
                step={0.01}
                min={2.0}
                max={5.0}
                color={config.color}
                onChange={v => handleFieldChange('cutoffV', v)}
              />
              <ParamRow
                label="Max time"
                value={step.maxTimeMin ?? 0}
                unit="min"
                step={1}
                min={0}
                max={9999}
                onChange={v => handleFieldChange('maxTimeMin', v)}
              />
            </>
          )}

          {step.type === 'd-cp' && (
            <>
              <ParamRow
                label="Power"
                value={step.powerW}
                unit="W"
                step={1}
                min={0}
                max={350}
                color={config.color}
                onChange={v => handleFieldChange('powerW', v)}
              />
              <ParamRow
                label="Cutoff V"
                value={step.cutoffV}
                unit="V"
                step={0.01}
                min={2.0}
                max={5.0}
                color={config.color}
                onChange={v => handleFieldChange('cutoffV', v)}
              />
              <ParamRow
                label="Max time"
                value={step.maxTimeMin ?? 0}
                unit="min"
                step={1}
                min={0}
                max={9999}
                onChange={v => handleFieldChange('maxTimeMin', v)}
              />
            </>
          )}

          {step.type === 'c-cv' && (
            <>
              <ParamRow
                label={useCRate ? 'C-rate' : 'Current'}
                value={useCRate ? step.currentA / capacityAh : step.currentA}
                unit={useCRate ? 'C' : 'A'}
                step={0.01}
                min={0}
                max={useCRate ? 1 : 40}
                color={config.color}
                onChange={v => handleFieldChange('currentA', useCRate ? v * capacityAh : v)}
              />
              <ParamRow
                label="Target V"
                value={step.targetV}
                unit="V"
                step={0.001}
                min={2.0}
                max={5.0}
                color={config.color}
                onChange={v => handleFieldChange('targetV', v)}
              />
              <ParamRow
                label="Cutoff I"
                value={step.cutoffCurrentA}
                unit="A"
                step={0.01}
                min={0}
                max={40}
                color={config.color}
                onChange={v => handleFieldChange('cutoffCurrentA', v)}
              />
              <ParamRow
                label="Max time"
                value={step.maxTimeMin ?? 0}
                unit="min"
                step={1}
                min={0}
                max={9999}
                onChange={v => handleFieldChange('maxTimeMin', v)}
              />
            </>
          )}

          {step.type === 'wait' && (
            <ParamRow
              label="Duration"
              value={Math.round(step.durationS / 60)}
              unit="min"
              step={1}
              min={1}
              max={9999}
              onChange={v => handleFieldChange('durationS', v * 60)}
            />
          )}

          {step.type === 'loop' && (
            <>
              <ParamRow
                label="Repeat"
                value={step.count}
                unit="times"
                step={1}
                min={2}
                max={100}
                color={config.color}
                onChange={v => handleFieldChange('count', v)}
              />
              <div className="sp-row">
                <span className="sp-label">Steps</span>
                <select
                  className="sp-input sp-select"
                  value={`${step.startIndex}-${step.endIndex}`}
                  onChange={e => {
                    const [s, en] = e.target.value.split('-').map(Number);
                    onUpdate(index, { ...step, startIndex: s, endIndex: en });
                  }}
                >
                  <option value={`0-${totalSteps - 2}`}>All steps (1–{totalSteps - 1})</option>
                  {/* Allow selecting sub-ranges if there are enough steps */}
                  {totalSteps > 3 &&
                    Array.from({ length: totalSteps - 1 }, (_, i) => (
                      <option key={i} value={`${i}-${i}`}>
                        Step {i + 1} only
                      </option>
                    ))}
                </select>
              </div>
              <div className="sp-note">
                Steps {step.startIndex + 1}–{step.endIndex + 1} will repeat {step.count} times total.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── ParamRow ───────────────────────────────────────────────────────

function ParamRow({
  label,
  value,
  unit,
  step,
  min,
  max,
  color,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  step: number;
  min: number;
  max: number;
  color?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="sp-row">
      <span className="sp-label">{label}</span>
      <div className="sp-input-group">
        <input
          className="sp-input"
          type="number"
          value={value}
          step={step}
          min={min}
          max={max}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
        />
        <span className="sp-unit">{unit}</span>
      </div>
      {color && min !== max && <SetpointBar value={value} min={min} max={max} color={color} />}
    </div>
  );
}

// ── Subtitle generator ─────────────────────────────────────────────

function getSubtitle(step: SequenceStep, capacityAh: number, useCRate: boolean): string {
  switch (step.type) {
    case 'd-cc': {
      const current = useCRate ? `${(step.currentA / capacityAh).toFixed(2)}C` : `${step.currentA.toFixed(2)} A`;
      return `${current} \u2192 ${step.cutoffV.toFixed(2)} V cutoff`;
    }
    case 'd-cp':
      return `${step.powerW} W \u2192 ${step.cutoffV.toFixed(2)} V cutoff`;
    case 'c-cv': {
      const current = useCRate ? `${(step.currentA / capacityAh).toFixed(2)}C` : `${step.currentA.toFixed(2)} A`;
      return `${current} \u2192 ${step.targetV.toFixed(3)} V, cutoff ${step.cutoffCurrentA.toFixed(2)} A`;
    }
    case 'wait':
      return `${Math.round(step.durationS / 60)} minutes rest`;
    case 'loop':
      return `Loop steps ${step.startIndex + 1}\u2013${step.endIndex + 1}`;
  }
}
