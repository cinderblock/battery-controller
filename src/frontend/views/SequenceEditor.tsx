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
 * - Canvas timeline (interactive — click blocks to select, pill badges for setpoints)
 * - Estimated duration bar
 * - Properties panel (selected step's parameters)
 * - Step palette (add new steps)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, apiPost, type CellGroup, type Sequence } from '../api-client.ts';
import { SequenceTimeline } from '../components/SequenceTimeline.tsx';
import { StepPalette } from '../components/StepPalette.tsx';
import { StepProperties } from '../components/StepProperties.tsx';
import type { FieldBindings, SequenceStep, SequenceVariable, StepPath } from '../lib/sequence-types.ts';
import {
  getStepAtPath,
  insertStepAtPath,
  migrateV1Steps,
  moveStep,
  PRESETS,
  parseSequenceDoc,
  removeStepAtPath,
  resolveSteps,
  serializeSequenceDoc,
  totalEstimatedDurationH,
  updateStepAtPath,
} from '../lib/sequence-types.ts';

// ── Component ──────────────────────────────────────────────────────

export function SequenceEditor() {
  // ── Sequence state ────────────────────────────────────────────
  const [steps, setSteps] = useState<SequenceStep[]>(PRESETS[0].steps);
  const [variables, setVariables] = useState<SequenceVariable[]>(PRESETS[0].variables ?? []);
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

  // ── Cell group creation ──────────────────────────────────────
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupCapacity, setNewGroupCapacity] = useState('200');
  const [newGroupChemistry, setNewGroupChemistry] = useState('LiFePO4');
  const newGroupNameRef = useRef<HTMLInputElement>(null);

  const selectedGroup = cellGroups.find(g => g.id === selectedGroupId) ?? cellGroups[0];
  const capacityAh = selectedGroup ? selectedGroup.nominal_capacity_mah / 1000 : 200;

  // ── Load data ─────────────────────────────────────────────────
  useEffect(() => {
    api<CellGroup[]>('/api/cell-groups')
      .then(groups => {
        setCellGroups(groups);
        if (groups.length > 0) setSelectedGroupId(groups[0].id);
      })
      .catch(() => {});

    api<Sequence[]>('/api/sequences')
      .then(setSavedSequences)
      .catch(() => {});
  }, []);

  // ── Resolved steps (variables baked in) for preview/estimation ──
  const resolvedSteps = useMemo(() => resolveSteps(steps, variables), [steps, variables]);

  // ── Duration estimate ─────────────────────────────────────────
  const totalH = totalEstimatedDurationH(resolvedSteps, capacityAh);
  const durationStr =
    totalH < 1 ? `~${Math.round(totalH * 60)}m` : `~${Math.floor(totalH)}h ${Math.round((totalH % 1) * 60)}m`;

  // ── Selected step ─────────────────────────────────────────────
  const selectedStep = selectedPath ? getStepAtPath(steps, selectedPath) : null;

  // ── Step management (path-based) ──────────────────────────────

  const addStep = useCallback(
    (step: SequenceStep) => {
      setSteps(prev => [...prev, step]);
      const newPath: StepPath = [steps.length];
      setSelectedPath(newPath);
      setActivePreset('');
    },
    [steps.length]
  );

  const handleUpdate = useCallback((path: StepPath, step: SequenceStep) => {
    setSteps(prev => updateStepAtPath(prev, path, step));
    setActivePreset('');
  }, []);

  /**
   * Updates coming from the timeline carry RESOLVED steps (variables baked
   * in). Restore the raw stored value and bind marker for bound fields so
   * a pill-drag on a bound field doesn't bake the variable's value into
   * the sequence — bound fields are governed by their variable.
   */
  const handleTimelineUpdate = useCallback((path: StepPath, updated: SequenceStep) => {
    setSteps(prev => {
      const raw = getStepAtPath(prev, path);
      let merged = updated;
      if (raw && raw.type !== 'loop' && raw.type !== 'wait' && raw.bind) {
        const rawRec = raw as unknown as Record<string, unknown>;
        const mergedRec: Record<string, unknown> = {
          ...(updated as unknown as Record<string, unknown>),
          bind: raw.bind,
        };
        for (const field of Object.keys(raw.bind)) {
          mergedRec[field] = rawRec[field];
        }
        merged = mergedRec as unknown as SequenceStep;
      }
      return updateStepAtPath(prev, path, merged);
    });
    setActivePreset('');
  }, []);

  // ── Variables ─────────────────────────────────────────────────

  const addVariable = useCallback(() => {
    setVariables(prev => {
      let n = prev.length + 1;
      while (prev.some(v => v.key === `Var ${n}`)) n++;
      return [...prev, { key: `Var ${n}`, value: 10 }];
    });
    setActivePreset('');
  }, []);

  /** Rename a variable and rewrite every step binding that references it */
  const renameVariable = useCallback(
    (index: number, newKey: string) => {
      const oldKey = variables[index]?.key;
      if (oldKey === undefined || oldKey === newKey) return;
      const renameBinds = (list: SequenceStep[]): SequenceStep[] =>
        list.map(s => {
          if (s.type === 'loop') return { ...s, children: renameBinds(s.children) };
          if (s.type === 'wait' || !s.bind) return s;
          const bind = Object.fromEntries(
            Object.entries(s.bind).map(([field, key]) => [field, key === oldKey ? newKey : key])
          ) as FieldBindings;
          return { ...s, bind };
        });
      setVariables(prev => prev.map((v, i) => (i === index ? { ...v, key: newKey } : v)));
      setSteps(prev => renameBinds(prev));
      setActivePreset('');
    },
    [variables]
  );

  const setVariableValue = useCallback((index: number, value: number) => {
    setVariables(prev => prev.map((v, i) => (i === index ? { ...v, value } : v)));
    setActivePreset('');
  }, []);

  const removeVariable = useCallback((index: number) => {
    setVariables(prev => prev.filter((_, i) => i !== index));
    setActivePreset('');
  }, []);

  const handleRemove = useCallback((path: StepPath) => {
    setSteps(prev => removeStepAtPath(prev, path));
    setSelectedPath(null);
    setActivePreset('');
  }, []);

  const handleDuplicate = useCallback(
    (path: StepPath) => {
      const step = getStepAtPath(steps, path);
      if (!step) return;
      const clone = JSON.parse(JSON.stringify(step)) as SequenceStep;
      // Insert after the current step
      const insertPath = [...path];
      insertPath[insertPath.length - 1]++;
      setSteps(prev => insertStepAtPath(prev, insertPath, clone));
      setSelectedPath(insertPath);
      setActivePreset('');
    },
    [steps]
  );

  const handleTimelineSelect = useCallback((path: number[]) => {
    setSelectedPath(path);
  }, []);

  const handleReorder = useCallback((fromPath: number[], toPath: number[]) => {
    setSteps(prev => moveStep(prev, fromPath, toPath));
    setSelectedPath(null);
    setActivePreset('');
  }, []);

  // ── Presets ───────────────────────────────────────────────────
  const loadPreset = useCallback((preset: (typeof PRESETS)[number]) => {
    setSteps([...preset.steps]);
    setVariables(preset.variables ? [...preset.variables] : []);
    setName(preset.name);
    setSelectedPath([0]);
    setActivePreset(preset.name);
    setEditingId(null);
  }, []);

  // ── Load saved sequence ───────────────────────────────────────
  const loadSaved = useCallback(
    (seq: Sequence) => {
      // Skip reload if already editing this sequence (avoids resetting name edits)
      if (editingId === seq.id) return;
      try {
        const doc = parseSequenceDoc(seq.steps_json);
        const parsed = migrateV1Steps(doc.steps);
        setSteps(parsed);
        setVariables(doc.variables);
        setName(seq.name);
        setEditingId(seq.id);
        setSelectedPath([0]);
        setActivePreset('');
      } catch {
        setError('Failed to parse saved sequence');
      }
    },
    [editingId]
  );

  // ── Save ──────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      setError('Enter a sequence name');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const stepsJson = serializeSequenceDoc({ variables, steps });
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
  }, [name, steps, variables, editingId, selectedGroupId]);

  // ── Create cell group ────────────────────────────────────────
  const handleCreateGroup = useCallback(async () => {
    const trimmed = newGroupName.trim();
    if (!trimmed) {
      setError('Enter a cell group name');
      return;
    }
    const capAh = parseFloat(newGroupCapacity);
    if (!capAh || capAh <= 0) {
      setError('Enter a valid capacity');
      return;
    }
    setError(null);
    try {
      const group = await apiPost<CellGroup>('/api/cell-groups', {
        name: trimmed,
        nominalCapacityMah: Math.round(capAh * 1000),
        chemistry: newGroupChemistry,
      });
      setCellGroups(prev => [...prev, group]);
      setSelectedGroupId(group.id);
      setShowNewGroup(false);
      setNewGroupName('');
      setNewGroupCapacity('200');
      setNewGroupChemistry('LiFePO4');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create cell group');
    }
  }, [newGroupName, newGroupCapacity, newGroupChemistry]);

  // ── Delete sequence ──────────────────────────────────────────
  const handleDeleteSequence = useCallback(
    async (seqId: number) => {
      try {
        await api(`/api/sequences/${seqId}`, { method: 'DELETE' });
        setSavedSequences(prev => prev.filter(s => s.id !== seqId));
        if (editingId === seqId) {
          setEditingId(null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Delete failed');
      }
    },
    [editingId]
  );

  // ── Duplicate sequence ──────────────────────────────────────
  const handleDuplicateSequence = useCallback((seq: Sequence) => {
    try {
      const doc = parseSequenceDoc(seq.steps_json);
      const parsed = migrateV1Steps(doc.steps);
      setSteps(parsed);
      setVariables(doc.variables);
      setName(`${seq.name} (copy)`);
      setEditingId(null); // Save will create a new sequence
      setSelectedPath([0]);
      setActivePreset('');
    } catch {
      setError('Failed to duplicate sequence');
    }
  }, []);

  return (
    <div className="seq-editor">
      {/* Header */}
      <div className="seq-header">
        <a className="btn btn-back" href="/">
          {'\u2190'} Back
        </a>
        <input
          className="seq-header-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Sequence name..."
        />
        <button className="btn btn-save" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      {/* Cell group selector */}
      <div className="seq-info">
        <div className="seq-meta">
          <span className="seq-meta-label">Cell:</span>
          <select
            className="seq-meta-select"
            value={selectedGroupId ?? ''}
            onChange={e => setSelectedGroupId(parseInt(e.target.value, 10) || null)}
          >
            {cellGroups.map(g => (
              <option key={g.id} value={g.id}>
                {g.name} — {g.nominal_capacity_mah / 1000} Ah
              </option>
            ))}
          </select>
          <button
            className="btn btn-add-group"
            onClick={() => {
              setShowNewGroup(v => !v);
              setTimeout(() => newGroupNameRef.current?.focus(), 50);
            }}
          >
            +
          </button>
        </div>
        {showNewGroup && (
          <div className="new-group-form">
            <input
              ref={newGroupNameRef}
              className="new-group-input"
              value={newGroupName}
              onChange={e => setNewGroupName(e.target.value)}
              placeholder="Name (e.g. EVE LF280K)"
              onKeyDown={e => e.key === 'Enter' && handleCreateGroup()}
            />
            <input
              className="new-group-input new-group-capacity"
              type="number"
              value={newGroupCapacity}
              onChange={e => setNewGroupCapacity(e.target.value)}
              placeholder="Ah"
              min="0.1"
              step="0.1"
              onKeyDown={e => e.key === 'Enter' && handleCreateGroup()}
            />
            <span className="new-group-unit">Ah</span>
            <select
              className="new-group-input new-group-chem"
              value={newGroupChemistry}
              onChange={e => setNewGroupChemistry(e.target.value)}
            >
              <option value="LiFePO4">LiFePO4</option>
              <option value="Li-ion">Li-ion</option>
              <option value="LiPo">LiPo</option>
              <option value="NiMH">NiMH</option>
              <option value="Lead-acid">Lead-acid</option>
            </select>
            <button className="btn btn-confirm-group" onClick={handleCreateGroup}>
              Add
            </button>
            <button className="btn btn-cancel-group" onClick={() => setShowNewGroup(false)}>
              Cancel
            </button>
          </div>
        )}
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
          <span key={s.id} className="saved-seq-pill">
            <button
              className={`preset-btn preset-saved ${editingId === s.id ? 'preset-active' : ''}`}
              onClick={() => loadSaved(s)}
            >
              {s.name}
            </button>
            <button
              className="saved-seq-dup"
              onClick={e => {
                e.stopPropagation();
                handleDuplicateSequence(s);
              }}
            >
              {'\u2398'}
            </button>
            <button
              className="saved-seq-delete"
              onClick={e => {
                e.stopPropagation();
                handleDeleteSequence(s.id);
              }}
            >
              {'\u00D7'}
            </button>
          </span>
        ))}
      </div>

      {/* Variables — one number that every bound step field follows */}
      <div className="seq-variables">
        <span className="seq-variables-label">Variables</span>
        {variables.map((v, i) => (
          <span key={i} className="seq-var-row">
            <input
              className="seq-var-name"
              value={v.key}
              onChange={e => renameVariable(i, e.target.value)}
              placeholder="Name"
            />
            <input
              className="seq-var-value"
              type="number"
              value={v.value}
              step={0.1}
              onChange={e => setVariableValue(i, parseFloat(e.target.value) || 0)}
            />
            <button type="button" className="seq-var-delete" onClick={() => removeVariable(i)}>
              {'×'}
            </button>
          </span>
        ))}
        <button type="button" className="btn seq-var-add" onClick={addVariable}>
          + Variable
        </button>
      </div>

      {/* Visual timeline */}
      <SequenceTimeline
        steps={resolvedSteps}
        selectedPath={selectedPath}
        capacityAh={capacityAh}
        onSelectStep={handleTimelineSelect}
        onReorder={handleReorder}
        onUpdate={handleTimelineUpdate}
      />

      {/* Estimated duration */}
      <div className="seq-est-bar">
        <span>Estimated duration</span>
        <span className="seq-est-time">{durationStr}</span>
      </div>

      {/* Properties panel for selected step */}
      {selectedStep && selectedPath && (
        <StepProperties
          step={selectedStep}
          path={selectedPath}
          capacityAh={capacityAh}
          variables={variables}
          onUpdate={handleUpdate}
          onRemove={handleRemove}
          onDuplicate={handleDuplicate}
        />
      )}

      {error && <div className="seq-error">{error}</div>}

      {/* Step palette (add new steps) */}
      <StepPalette onAdd={addStep} />
    </div>
  );
}
