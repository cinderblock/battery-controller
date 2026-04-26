/**
 * SequenceEditor — visual sequence programming page.
 *
 * Users build multi-step test sequences by adding, reordering, and
 * editing discharge, charge, wait, and loop steps. A canvas timeline
 * shows the expected voltage curve. Sequences can be saved and run.
 *
 * Layout (top to bottom):
 * - Header (back, title, save)
 * - Name + cell group
 * - Presets / saved sequences
 * - Canvas timeline (voltage preview)
 * - Horizontal pill bar (step chips, drag-to-reorder)
 * - Properties panel (selected step's parameters)
 * - Step palette (add new steps)
 */

import { useState, useCallback, useEffect } from 'react';
import { api, apiPost, type CellGroup, type Sequence } from '../api-client.ts';
import type { SequenceStep, StepPath } from '../lib/sequence-types.ts';
import {
  defaultDCC,
  defaultCCV,
  defaultWait,
  totalEstimatedDurationH,
  getStepAtPath,
  updateStepAtPath,
  removeStepAtPath,
  insertStepAtPath,
  moveStep,
  migrateV1Steps,
  PRESETS,
} from '../lib/sequence-types.ts';
import { SequenceTimeline } from '../components/SequenceTimeline.tsx';
import { StepPillBar } from '../components/StepPillBar.tsx';
import { StepProperties } from '../components/StepProperties.tsx';
import { StepPalette } from '../components/StepPalette.tsx';
import { useDragReorder } from '../hooks/useDragReorder.ts';

// ── Component ──────────────────────────────────────────────────────

export function SequenceEditor() {
  // ── Sequence state ────────────────────────────────────────────
  const [steps, setSteps] = useState<SequenceStep[]>(PRESETS[0].steps);
  const [name, setName] = useState(PRESETS[0].name);
  const [selectedPath, setSelectedPath] = useState<StepPath | null>([0]);
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

  // ── Selected step ─────────────────────────────────────────────
  const selectedStep = selectedPath ? getStepAtPath(steps, selectedPath) : null;

  // ── Step management (path-based) ──────────────────────────────

  const addStep = useCallback((step: SequenceStep) => {
    setSteps(prev => [...prev, step]);
    const newPath: StepPath = [steps.length];
    setSelectedPath(newPath);
    setActivePreset('');
  }, [steps.length]);

  const handleUpdate = useCallback((path: StepPath, step: SequenceStep) => {
    setSteps(prev => updateStepAtPath(prev, path, step));
    setActivePreset('');
  }, []);

  const handleRemove = useCallback((path: StepPath) => {
    setSteps(prev => removeStepAtPath(prev, path));
    setSelectedPath(null);
    setActivePreset('');
  }, []);

  const handleDuplicate = useCallback((path: StepPath) => {
    const step = getStepAtPath(steps, path);
    if (!step) return;
    const clone = JSON.parse(JSON.stringify(step)) as SequenceStep;
    // Insert after the current step
    const insertPath = [...path];
    insertPath[insertPath.length - 1]++;
    setSteps(prev => insertStepAtPath(prev, insertPath, clone));
    setSelectedPath(insertPath);
    setActivePreset('');
  }, [steps]);

  const handleSelect = useCallback((path: StepPath) => {
    setSelectedPath(path);
  }, []);

  // For timeline click (uses flat index)
  const handleTimelineSelect = useCallback((index: number) => {
    // Timeline shows flattened executable steps — map index back to path
    // For now, use simple top-level indexing
    setSelectedPath([index]);
  }, []);

  // ── Drag-and-drop ─────────────────────────────────────────────

  const handleReorder = useCallback((fromPath: StepPath, toPath: StepPath) => {
    setSteps(prev => moveStep(prev, fromPath, toPath));
    setActivePreset('');
  }, []);

  const handleInsertNew = useCallback((step: SequenceStep, atPath: StepPath) => {
    setSteps(prev => insertStepAtPath(prev, atPath, step));
    setSelectedPath(atPath);
    setActivePreset('');
  }, []);

  const { dragState, dragPropsForPath, startPaletteDrag, barProps } =
    useDragReorder(steps, handleReorder, handleInsertNew);

  // ── Presets ───────────────────────────────────────────────────
  const loadPreset = useCallback((preset: typeof PRESETS[number]) => {
    setSteps([...preset.steps]);
    setName(preset.name);
    setSelectedPath([0]);
    setActivePreset(preset.name);
    setEditingId(null);
  }, []);

  // ── Load saved sequence ───────────────────────────────────────
  const loadSaved = useCallback((seq: Sequence) => {
    try {
      const raw = JSON.parse(seq.steps_json);
      const parsed = migrateV1Steps(raw);
      setSteps(parsed);
      setName(seq.name);
      setEditingId(seq.id);
      setSelectedPath([0]);
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
      const seqs = await api<Sequence[]>('/api/sequences');
      setSavedSequences(seqs);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [name, steps, editingId, selectedGroupId]);

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

      {/* Name + cell group */}
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
        selectedIndex={selectedPath?.[0] ?? null}
        capacityAh={capacityAh}
        onSelectStep={handleTimelineSelect}
      />

      {/* Estimated duration */}
      <div className="seq-est-bar">
        <span>Estimated duration</span>
        <span className="seq-est-time">{durationStr}</span>
      </div>

      {/* Horizontal pill bar */}
      <StepPillBar
        steps={steps}
        selectedPath={selectedPath}
        capacityAh={capacityAh}
        onSelect={handleSelect}
        dragState={dragState}
        dragPropsForPath={dragPropsForPath}
        barProps={barProps}
      />

      {/* Properties panel for selected step */}
      {selectedStep && selectedPath && (
        <StepProperties
          step={selectedStep}
          path={selectedPath}
          capacityAh={capacityAh}
          onUpdate={handleUpdate}
          onRemove={handleRemove}
          onDuplicate={handleDuplicate}
        />
      )}

      {error && <div className="seq-error">{error}</div>}

      {/* Step palette (add new steps) */}
      <StepPalette
        onAdd={addStep}
        startPaletteDrag={startPaletteDrag}
      />
    </div>
  );
}
