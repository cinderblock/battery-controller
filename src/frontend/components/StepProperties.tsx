/**
 * StepProperties — parameter editor panel for the selected sequence step.
 *
 * Shows full parameter inputs with visual setpoint indicators.
 * Each current-bearing step has a per-step Amps/C-rate toggle.
 */

import { useCallback } from 'react';
import type { SequenceStep, StepPath } from '../lib/sequence-types.ts';
import { estimateDurationH, resolveCurrentA } from '../lib/sequence-types.ts';

// ── Props ──────────────────────────────────────────────────────────

interface StepPropertiesProps {
  step: SequenceStep;
  path: StepPath;
  capacityAh: number;
  onUpdate: (path: StepPath, step: SequenceStep) => void;
  onRemove: (path: StepPath) => void;
  onDuplicate: (path: StepPath) => void;
}

// ── Helpers ─────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  'd-cc': 'Discharge (D-CC)',
  'd-cp': 'Discharge (D-CP)',
  'c-cv': 'Charge (C-CV)',
  'wait': 'Wait / Rest',
  'loop': 'Loop',
};

const TYPE_COLORS: Record<string, string> = {
  'd-cc': '#fb923c',
  'd-cp': '#ffb74d',
  'c-cv': '#60a5fa',
  'wait': '#777',
  'loop': '#a78bfa',
};

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

function ParamRow({
  label,
  value,
  unit,
  step,
  min,
  max,
  color,
  onChange,
  toggle,
}: {
  label: string;
  value: number;
  unit: string;
  step: number;
  min: number;
  max: number;
  color?: string;
  onChange: (value: number) => void;
  toggle?: React.ReactNode;
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
        {toggle}
      </div>
      {color && min !== max && (
        <SetpointBar value={value} min={min} max={max} color={color} />
      )}
    </div>
  );
}

// ── C-rate toggle ──────────────────────────────────────────────────

function CRateToggle({ useCRate, onToggle }: { useCRate: boolean; onToggle: () => void }) {
  return (
    <button
      className={`crate-step-toggle ${useCRate ? 'crate-active' : ''}`}
      onClick={onToggle}
      type="button"
      title={useCRate ? 'Switch to Amps' : 'Switch to C-rate'}
    >
      {useCRate ? 'C' : 'A'}
    </button>
  );
}

// ── Component ──────────────────────────────────────────────────────

export function StepProperties({
  step,
  path,
  capacityAh,
  onUpdate,
  onRemove,
  onDuplicate,
}: StepPropertiesProps) {
  const color = TYPE_COLORS[step.type] ?? '#888';
  const duration = estimateDurationH(step, capacityAh);

  const handleFieldChange = useCallback((field: string, value: number | boolean) => {
    const updated = { ...step, [field]: value } as SequenceStep;
    onUpdate(path, updated);
  }, [step, path, onUpdate]);

  const toggleCRate = useCallback(() => {
    if (step.type !== 'd-cc' && step.type !== 'c-cv') return;
    const wasCRate = step.useCRate ?? false;
    if (wasCRate) {
      // Switching to amps: currentA (C-rate value) * capacityAh → actual amps
      onUpdate(path, { ...step, useCRate: false, currentA: step.currentA * capacityAh });
    } else {
      // Switching to C-rate: currentA (amps) / capacityAh → C-rate value
      onUpdate(path, { ...step, useCRate: true, currentA: step.currentA / capacityAh });
    }
  }, [step, path, capacityAh, onUpdate]);

  // Display values for current field
  const currentDisplay = (step.type === 'd-cc' || step.type === 'c-cv')
    ? { value: step.currentA, unit: step.useCRate ? 'C' : 'A', max: step.useCRate ? 2 : 40 }
    : null;

  return (
    <div className="step-properties">
      {/* Header */}
      <div className="step-properties-header">
        <div className="step-properties-dot" style={{ background: color }} />
        <span className="step-properties-type">{TYPE_LABELS[step.type]}</span>
        <span className="step-properties-duration">
          {step.type === 'loop' ? `\u00D7${step.count}` : `~${formatDuration(duration)}`}
        </span>
        <div className="step-properties-actions">
          <button
            className="step-prop-btn"
            onClick={() => onDuplicate(path)}
            title="Duplicate step"
          >
            {'\u2398'}
          </button>
          <button
            className="step-prop-btn step-prop-btn-danger"
            onClick={() => onRemove(path)}
            title="Delete step"
          >
            {'\u2715'}
          </button>
        </div>
      </div>

      {/* Parameters */}
      <div className="step-properties-params">
        {step.type === 'd-cc' && currentDisplay && (
          <>
            <ParamRow
              label="Current"
              value={currentDisplay.value}
              unit={currentDisplay.unit}
              step={0.01}
              min={0}
              max={currentDisplay.max}
              color={color}
              onChange={v => handleFieldChange('currentA', v)}
              toggle={<CRateToggle useCRate={step.useCRate ?? false} onToggle={toggleCRate} />}
            />
            {step.useCRate && (
              <div className="sp-hint">{resolveCurrentA(step, capacityAh).toFixed(2)} A</div>
            )}
            <ParamRow
              label="Cutoff V"
              value={step.cutoffV}
              unit="V"
              step={0.01}
              min={2.0}
              max={5.0}
              color={color}
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
              color={color}
              onChange={v => handleFieldChange('powerW', v)}
            />
            <ParamRow
              label="Cutoff V"
              value={step.cutoffV}
              unit="V"
              step={0.01}
              min={2.0}
              max={5.0}
              color={color}
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

        {step.type === 'c-cv' && currentDisplay && (
          <>
            <ParamRow
              label="Current"
              value={currentDisplay.value}
              unit={currentDisplay.unit}
              step={0.01}
              min={0}
              max={currentDisplay.max}
              color={color}
              onChange={v => handleFieldChange('currentA', v)}
              toggle={<CRateToggle useCRate={step.useCRate ?? false} onToggle={toggleCRate} />}
            />
            {step.useCRate && (
              <div className="sp-hint">{resolveCurrentA(step, capacityAh).toFixed(2)} A</div>
            )}
            <ParamRow
              label="Target V"
              value={step.targetV}
              unit="V"
              step={0.001}
              min={2.0}
              max={5.0}
              color={color}
              onChange={v => handleFieldChange('targetV', v)}
            />
            <ParamRow
              label="Cutoff I"
              value={step.cutoffCurrentA}
              unit="A"
              step={0.01}
              min={0}
              max={40}
              color={color}
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
          <ParamRow
            label="Repeat"
            value={step.count}
            unit="times"
            step={1}
            min={2}
            max={100}
            color={color}
            onChange={v => handleFieldChange('count', v)}
          />
        )}
      </div>
    </div>
  );
}
