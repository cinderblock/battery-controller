/**
 * SequenceEditor — visual sequence programming page.
 *
 * Users build multi-step test sequences by adding discharge, charge,
 * wait, and loop steps. A canvas timeline shows the expected voltage
 * curve. Sequences can be saved to the DB and run on the device.
 */

import { useState, useCallback, useEffect } from 'react';
import { api, apiPost, type CellGroup, type Sequence } from '../api-client.ts';
import type { SequenceStep } from '../lib/sequence-types.ts';
import {
  defaultDCC,
  defaultDCP,
  defaultCCV,
  defaultWait,
  totalEstimatedDurationH,
  PRESETS,
} from '../lib/sequence-types.ts';
import { SequenceTimeline } from '../components/SequenceTimeline.tsx';
import { StepCard } from '../components/StepCard.tsx';

// ── Component ──────────────────────────────────────────────────────

export function SequenceEditor() {
  // ── Sequence state ────────────────────────────────────────────
  const [steps, setSteps] = useState<SequenceStep[]>(PRESETS[0].steps);
  const [name, setName] = useState(PRESETS[0].name);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(0);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);
  const [useCRate, setUseCRate] = useState(false);
  const [activePreset, setActivePreset] = useState<string>(PRESETS[0].name);

  // ── Cell groups + sequences ───────────────────────────────────
  const [cellGroups, setCellGroups] = useState<CellGroup[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [savedSequences, setSavedSequences] = useState<Sequence[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedGroup = cellGroups.find(g => g.id === selectedGroupId) ?? cellGroups[0];
  const capacityAh = selectedGroup ? selectedGroup.nominal_capacity_mah / 1000 : 200;

  // ── Load data ─────────────────────────────────────────────────
  useEffect(() => {
    api<CellGroup[]>('/api/cell-groups').then(groups => {
      setCellGroups(groups);
      if (groups.length > 0) setSelectedGroupId(groups[0].id);
    }).catch(() => {});

    api<Sequence[]>('/api/sequences').then(setSavedSequences).catch(() => {});
  }, []);

  // ── Duration estimate ─────────────────────────────────────────
  const totalH = totalEstimatedDurationH(steps, capacityAh);
  const durationStr = totalH < 1
    ? `~${Math.round(totalH * 60)}m`
    : `~${Math.floor(totalH)}h ${Math.round((totalH % 1) * 60)}m`;

  // ── Step management ───────────────────────────────────────────
  const addStep = useCallback((step: SequenceStep) => {
    setSteps(prev => [...prev, step]);
    setSelectedIndex(steps.length);
    setExpandedIndex(steps.length);
    setActivePreset('');
  }, [steps.length]);

  const updateStep = useCallback((index: number, step: SequenceStep) => {
    setSteps(prev => prev.map((s, i) => i === index ? step : s));
    setActivePreset('');
  }, []);

  const removeStep = useCallback((index: number) => {
    setSteps(prev => {
      const next = prev.filter((_, i) => i !== index);
      // Fix loop indices after removal
      return next.map(s => {
        if (s.type !== 'loop') return s;
        let { startIndex, endIndex } = s;
        if (index <= startIndex) startIndex = Math.max(0, startIndex - 1);
        if (index <= endIndex) endIndex = Math.max(0, endIndex - 1);
        if (endIndex >= next.length) endIndex = next.length - 1;
        return { ...s, startIndex, endIndex };
      });
    });
    if (selectedIndex === index) {
      setSelectedIndex(null);
      setExpandedIndex(null);
    }
    setActivePreset('');
  }, [selectedIndex]);

  const handleSelect = useCallback((index: number) => {
    setSelectedIndex(index);
  }, []);

  const handleToggleExpand = useCallback((index: number) => {
    setExpandedIndex(prev => prev === index ? null : index);
  }, []);

  // ── Presets ───────────────────────────────────────────────────
  const loadPreset = useCallback((preset: typeof PRESETS[number]) => {
    setSteps([...preset.steps]);
    setName(preset.name);
    setSelectedIndex(0);
    setExpandedIndex(0);
    setActivePreset(preset.name);
    setEditingId(null);
  }, []);

  // ── Load saved sequence ───────────────────────────────────────
  const loadSaved = useCallback((seq: Sequence) => {
    try {
      const parsed = JSON.parse(seq.steps_json) as SequenceStep[];
      setSteps(parsed);
      setName(seq.name);
      setEditingId(seq.id);
      setSelectedIndex(0);
      setExpandedIndex(0);
      setActivePreset('');
    } catch {
      setError('Failed to parse saved sequence');
    }
  }, []);

  // ── Save ──────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!name.trim()) { setError('Enter a sequence name'); return; }
    setSaving(true);
    setError(null);
    try {
      const stepsJson = JSON.stringify(steps);
      if (editingId) {
        await api(`/api/sequences/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify({ name, stepsJson }),
        });
      } else {
        const seq = await apiPost<Sequence>('/api/sequences', {
          name,
          stepsJson,
          cellGroupId: selectedGroupId,
        });
        setEditingId(seq.id);
      }
      // Reload saved sequences
      const seqs = await api<Sequence[]>('/api/sequences');
      setSavedSequences(seqs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [name, steps, editingId, selectedGroupId]);

  // ── Add loop step ─────────────────────────────────────────────
  const addLoop = useCallback(() => {
    const execStepCount = steps.filter(s => s.type !== 'loop').length;
    if (execStepCount === 0) return;
    const lastExecIndex = steps.reduce((last, s, i) => s.type !== 'loop' ? i : last, 0);
    addStep({ type: 'loop', count: 3, startIndex: 0, endIndex: lastExecIndex });
  }, [steps, addStep]);

  return (
    <div className="seq-editor">
      {/* Header */}
      <div className="seq-header">
        <a className="btn btn-back" href="/">{'\u2190'} Back</a>
        <span className="seq-header-title">Sequence Editor</span>
        <button className="btn btn-save" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      {/* Name + cell group + unit toggle */}
      <div className="seq-info">
        <input
          className="seq-name-input"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Sequence name..."
        />
        <div className="seq-meta">
          {cellGroups.length > 0 && (
            <>
              <span className="seq-meta-label">Cell:</span>
              <select
                className="seq-meta-select"
                value={selectedGroupId ?? ''}
                onChange={e => setSelectedGroupId(parseInt(e.target.value, 10) || null)}
              >
                {cellGroups.map(g => (
                  <option key={g.id} value={g.id}>{g.name} — {g.nominal_capacity_mah / 1000} Ah</option>
                ))}
              </select>
            </>
          )}
          <div className="unit-toggle">
            <button
              className={`unit-btn ${!useCRate ? 'active' : ''}`}
              onClick={() => setUseCRate(false)}
            >Amps</button>
            <button
              className={`unit-btn ${useCRate ? 'active' : ''}`}
              onClick={() => setUseCRate(true)}
            >C-rate</button>
          </div>
        </div>
      </div>

      {/* Presets + saved sequences */}
      <div className="seq-presets">
        {PRESETS.map(p => (
          <button
            key={p.name}
            className={`preset-btn ${activePreset === p.name ? 'preset-active' : ''}`}
            onClick={() => loadPreset(p)}
          >
            {p.name}
          </button>
        ))}
        {savedSequences.map(s => (
          <button
            key={s.id}
            className={`preset-btn preset-saved ${editingId === s.id ? 'preset-active' : ''}`}
            onClick={() => loadSaved(s)}
          >
            {s.name}
          </button>
        ))}
      </div>

      {/* Visual timeline */}
      <SequenceTimeline
        steps={steps}
        selectedIndex={selectedIndex}
        capacityAh={capacityAh}
        onSelectStep={handleSelect}
      />

      {/* Estimated duration */}
      <div className="seq-est-bar">
        <span>Estimated duration</span>
        <span className="seq-est-time">{durationStr}</span>
      </div>

      {/* Step list */}
      <div className="seq-step-list">
        {steps.map((step, i) => (
          <StepCard
            key={i}
            step={step}
            index={i}
            selected={selectedIndex === i}
            expanded={expandedIndex === i}
            capacityAh={capacityAh}
            useCRate={useCRate}
            totalSteps={steps.length}
            onSelect={handleSelect}
            onToggleExpand={handleToggleExpand}
            onUpdate={updateStep}
            onRemove={removeStep}
          />
        ))}
      </div>

      {error && <div className="seq-error">{error}</div>}

      {/* Add step buttons */}
      <div className="seq-add-panel">
        <button className="add-step-btn" onClick={() => addStep(defaultDCC())}>
          <span className="add-dot" style={{ background: '#fb923c' }} />
          Discharge
        </button>
        <button className="add-step-btn" onClick={() => addStep(defaultCCV())}>
          <span className="add-dot" style={{ background: '#60a5fa' }} />
          Charge
        </button>
        <button className="add-step-btn" onClick={() => addStep(defaultWait())}>
          <span className="add-dot" style={{ background: '#777' }} />
          Wait
        </button>
        <button className="add-step-btn" onClick={addLoop}>
          <span className="add-dot" style={{ background: '#a78bfa' }} />
          Loop
        </button>
      </div>
    </div>
  );
}
