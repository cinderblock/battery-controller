/**
 * StepProperties — parameter editor panel for the selected sequence step.
 *
 * Shows full parameter inputs with visual setpoint indicators.
 * Each current-bearing step has a per-step Amps/C-rate toggle.
 */

import { useCallback, useRef } from 'react';
import type { SequenceStep, SequenceVariable, StepPath } from '../lib/sequence-types.ts';
import { estimateDurationH, formatMinutes, parseDurationInput, resolveCurrentA } from '../lib/sequence-types.ts';

// ── Props ──────────────────────────────────────────────────────────

interface StepPropertiesProps {
  step: SequenceStep;
  path: StepPath;
  capacityAh: number;
  variables: SequenceVariable[];
  onUpdate: (path: StepPath, step: SequenceStep) => void;
  onRemove: (path: StepPath) => void;
  onDuplicate: (path: StepPath) => void;
}

// ── Helpers ─────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  'd-cc': 'Discharge (D-CC)',
  'd-cp': 'Discharge (D-CP)',
  'c-cv': 'Charge (C-CV)',
  wait: 'Wait / Rest',
  loop: 'Loop',
};

const TYPE_COLORS: Record<string, string> = {
  'd-cc': '#fb923c',
  'd-cp': '#ffb74d',
  'c-cv': '#60a5fa',
  wait: '#777',
  loop: '#a78bfa',
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
  bindControl,
  disabled,
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
  /** Variable-binding dropdown, rendered after the unit */
  bindControl?: React.ReactNode;
  /** Disable the number input (field is variable-bound) */
  disabled?: boolean;
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
          disabled={disabled}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
        />
        <span className="sp-unit">{unit}</span>
        {toggle}
        {bindControl}
      </div>
      {color && min !== max && <SetpointBar value={value} min={min} max={max} color={color} />}
    </div>
  );
}

// ── Variable binding dropdown ──────────────────────────────────────

function BindSelect({
  bound,
  variables,
  onBind,
}: {
  bound: string | undefined;
  variables: SequenceVariable[];
  onBind: (key: string | null) => void;
}) {
  if (variables.length === 0 && !bound) return null;
  return (
    <select
      className={`sp-bind-select ${bound ? 'sp-bind-active' : ''}`}
      value={bound ?? ''}
      onChange={e => onBind(e.target.value || null)}
      title={bound ? `Bound to variable "${bound}"` : 'Bind to a sequence variable'}
    >
      <option value="">{'—'}</option>
      {variables.map(v => (
        <option key={v.key} value={v.key}>
          {v.key}
        </option>
      ))}
      {bound && !variables.some(v => v.key === bound) && <option value={bound}>{bound} (missing)</option>}
    </select>
  );
}

/** Time input row — accepts human-readable durations like "8h", "30m", "8h 30m" */
function TimeRow({ label, minutes, onChange }: { label: string; minutes: number; onChange: (min: number) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = useCallback(
    (raw: string) => {
      const parsed = parseDurationInput(raw);
      if (parsed !== null) {
        onChange(parsed);
        if (inputRef.current) inputRef.current.value = formatMinutes(parsed);
      } else {
        // Reset to current value on invalid input
        if (inputRef.current) inputRef.current.value = formatMinutes(minutes);
      }
    },
    [minutes, onChange]
  );

  return (
    <div className="sp-row">
      <span className="sp-label">{label}</span>
      <div className="sp-input-group">
        <input
          ref={inputRef}
          className="sp-input"
          type="text"
          defaultValue={formatMinutes(minutes)}
          key={minutes}
          placeholder="e.g. 8h 30m"
          onBlur={e => commit(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit((e.target as HTMLInputElement).value);
            }
          }}
        />
      </div>
    </div>
  );
}

// ── C-rate toggle ─────────────���────────────────────────────────────

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
  variables,
  onUpdate,
  onRemove,
  onDuplicate,
}: StepPropertiesProps) {
  const color = TYPE_COLORS[step.type] ?? '#888';
  const duration = estimateDurationH(step, capacityAh);

  const handleFieldChange = useCallback(
    (field: string, value: number | boolean) => {
      const updated = { ...step, [field]: value } as SequenceStep;
      onUpdate(path, updated);
    },
    [step, path, onUpdate]
  );

  // ── Variable bindings ─────────────────────────────────────────
  const bind = step.type !== 'loop' && step.type !== 'wait' ? (step.bind ?? {}) : {};

  /** Displayed value: the bound variable's value, else the stored number */
  const fieldValue = useCallback(
    (field: string, stored: number): number => {
      const key = bind[field];
      const v = variables.find(x => x.key === key)?.value;
      return typeof v === 'number' ? v : stored;
    },
    [bind, variables]
  );

  const handleBind = useCallback(
    (field: string, key: string | null) => {
      if (step.type === 'loop' || step.type === 'wait') return;
      const newBind = { ...(step.bind ?? {}) };
      if (key === null) {
        delete newBind[field];
      } else {
        newBind[field] = key;
      }
      const updated: Record<string, unknown> = {
        ...(step as unknown as Record<string, unknown>),
        bind: Object.keys(newBind).length > 0 ? newBind : undefined,
      };
      // Snap the stored number to the variable so unbinding later keeps the value
      const v = variables.find(x => x.key === key)?.value;
      if (key !== null && typeof v === 'number') {
        updated[field] = v;
      }
      onUpdate(path, updated as unknown as SequenceStep);
    },
    [step, path, onUpdate, variables]
  );

  const bindSelect = (field: string) => (
    <BindSelect bound={bind[field]} variables={variables} onBind={key => handleBind(field, key)} />
  );

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
  const currentDisplay =
    step.type === 'd-cc' || step.type === 'c-cv'
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
          <button className="step-prop-btn" onClick={() => onDuplicate(path)} title="Duplicate step">
            {'\u2398'}
          </button>
          <button className="step-prop-btn step-prop-btn-danger" onClick={() => onRemove(path)} title="Delete step">
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
              value={fieldValue('currentA', currentDisplay.value)}
              unit={currentDisplay.unit}
              step={0.01}
              min={0}
              max={currentDisplay.max}
              color={color}
              disabled={!!bind.currentA}
              onChange={v => handleFieldChange('currentA', v)}
              toggle={
                bind.currentA ? undefined : <CRateToggle useCRate={step.useCRate ?? false} onToggle={toggleCRate} />
              }
              bindControl={bindSelect('currentA')}
            />
            {step.useCRate && <div className="sp-hint">{resolveCurrentA(step, capacityAh).toFixed(2)} A</div>}
            <ParamRow
              label="Cutoff V"
              value={fieldValue('cutoffV', step.cutoffV)}
              unit="V"
              step={0.01}
              min={2.0}
              max={5.0}
              color={color}
              disabled={!!bind.cutoffV}
              onChange={v => handleFieldChange('cutoffV', v)}
              bindControl={bindSelect('cutoffV')}
            />
            <TimeRow
              label="Max time"
              minutes={step.maxTimeMin ?? 0}
              onChange={v => handleFieldChange('maxTimeMin', v || (undefined as any))}
            />
            <label className="sp-exclude">
              <input
                type="checkbox"
                checked={!!step.backoff}
                onChange={e => onUpdate(path, { ...step, backoff: e.target.checked ? { minA: 10 } : undefined })}
              />
              <span>Auto-backoff: retry at half current when the cutoff trips instantly</span>
            </label>
            {step.backoff && (
              <ParamRow
                label="Backoff floor"
                value={step.backoff.minA}
                unit="A"
                step={1}
                min={1}
                max={40}
                onChange={v => onUpdate(path, { ...step, backoff: { minA: v } })}
              />
            )}
          </>
        )}

        {step.type === 'd-cp' && (
          <>
            <ParamRow
              label="Power"
              value={fieldValue('powerW', step.powerW)}
              unit="W"
              step={1}
              min={0}
              max={350}
              color={color}
              disabled={!!bind.powerW}
              onChange={v => handleFieldChange('powerW', v)}
              bindControl={bindSelect('powerW')}
            />
            <ParamRow
              label="Cutoff V"
              value={fieldValue('cutoffV', step.cutoffV)}
              unit="V"
              step={0.01}
              min={2.0}
              max={5.0}
              color={color}
              disabled={!!bind.cutoffV}
              onChange={v => handleFieldChange('cutoffV', v)}
              bindControl={bindSelect('cutoffV')}
            />
            <TimeRow
              label="Max time"
              minutes={step.maxTimeMin ?? 0}
              onChange={v => handleFieldChange('maxTimeMin', v || (undefined as any))}
            />
          </>
        )}

        {step.type === 'c-cv' && currentDisplay && (
          <>
            <ParamRow
              label="Current"
              value={fieldValue('currentA', currentDisplay.value)}
              unit={currentDisplay.unit}
              step={0.01}
              min={0}
              max={currentDisplay.max}
              color={color}
              disabled={!!bind.currentA}
              onChange={v => handleFieldChange('currentA', v)}
              toggle={
                bind.currentA ? undefined : <CRateToggle useCRate={step.useCRate ?? false} onToggle={toggleCRate} />
              }
              bindControl={bindSelect('currentA')}
            />
            {step.useCRate && <div className="sp-hint">{resolveCurrentA(step, capacityAh).toFixed(2)} A</div>}
            <ParamRow
              label="Target V"
              value={fieldValue('targetV', step.targetV)}
              unit="V"
              step={0.001}
              min={2.0}
              max={5.0}
              color={color}
              disabled={!!bind.targetV}
              onChange={v => handleFieldChange('targetV', v)}
              bindControl={bindSelect('targetV')}
            />
            <ParamRow
              label="Cutoff I"
              value={fieldValue('cutoffCurrentA', step.cutoffCurrentA)}
              unit="A"
              step={0.01}
              min={0}
              max={40}
              color={color}
              disabled={!!bind.cutoffCurrentA}
              onChange={v => handleFieldChange('cutoffCurrentA', v)}
              bindControl={bindSelect('cutoffCurrentA')}
            />
            <TimeRow
              label="Max time"
              minutes={step.maxTimeMin ?? 0}
              onChange={v => handleFieldChange('maxTimeMin', v || (undefined as any))}
            />
          </>
        )}

        {step.type === 'wait' && (
          <TimeRow
            label="Duration"
            minutes={Math.round(step.durationS / 60)}
            onChange={v => handleFieldChange('durationS', Math.max(1, v) * 60)}
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

        {step.type !== 'loop' && (
          <label className="sp-exclude">
            <input
              type="checkbox"
              checked={!!('excludeFromCount' in step && step.excludeFromCount)}
              onChange={e => handleFieldChange('excludeFromCount', e.target.checked)}
            />
            <span>Don't count this step</span>
          </label>
        )}
      </div>
    </div>
  );
}
