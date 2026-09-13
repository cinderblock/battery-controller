/**
 * CellTypesView — manage cell types and which cell is which type (route /cell-types).
 *
 * A cell type carries the numbers every test leans on: nominal capacity (what
 * "0.5C" multiplies by) and the per-cell charge / cutoff limits that seed the
 * manual-start form and the step palette. This page is the one place to add,
 * edit and delete types, and to put cells into them. Everything is validated
 * through src/shared/cell-types.ts, the same rules the server enforces, so the
 * form can't save what the API would refuse.
 *
 * REST-only; no live device session needed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type CellTypeField,
  type CellTypeInput,
  CHEMISTRIES,
  type Chemistry,
  hasErrors,
  suggestedVoltages,
  type ValidationIssue,
  validateCellType,
} from '../../shared/cell-types.ts';
import { api, apiPost, type Cell, type CellGroup } from '../api-client.ts';

// ── Form model ─────────────────────────────────────────────────────

/** Form fields are strings so a half-typed "3." doesn't get coerced away. */
interface FormState {
  name: string;
  chemistry: string;
  capacityAh: string;
  chargeVoltageV: string;
  dischargeCutoffV: string;
  chargeCutoffCurrentA: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  chemistry: '',
  capacityAh: '',
  chargeVoltageV: '',
  dischargeCutoffV: '',
  chargeCutoffCurrentA: '',
};

function formFromGroup(g: CellGroup): FormState {
  return {
    name: g.name,
    chemistry: g.chemistry,
    capacityAh: String(g.nominal_capacity_mah / 1000),
    chargeVoltageV: g.charge_voltage_v != null ? String(g.charge_voltage_v) : '',
    dischargeCutoffV: g.discharge_cutoff_v != null ? String(g.discharge_cutoff_v) : '',
    chargeCutoffCurrentA: g.charge_cutoff_current_a != null ? String(g.charge_cutoff_current_a) : '',
  };
}

function num(s: string): number {
  return s.trim() === '' ? Number.NaN : Number(s);
}

function toInput(f: FormState): CellTypeInput {
  return {
    name: f.name,
    chemistry: f.chemistry,
    nominalCapacityMah: Math.round(num(f.capacityAh) * 1000),
    chargeVoltageV: num(f.chargeVoltageV),
    dischargeCutoffV: num(f.dischargeCutoffV),
    chargeCutoffCurrentA: num(f.chargeCutoffCurrentA),
  };
}

/** A type saved before voltages were required — usable for capacity, but its defaults are missing. */
function isIncomplete(g: CellGroup): boolean {
  return g.charge_voltage_v == null || g.discharge_cutoff_v == null || g.charge_cutoff_current_a == null;
}

// ── Type form (create + edit) ─────────────────────────────────────

/** Validation messages for one field, shown under its input once the user has tried to save. */
function FieldIssues({ issues }: { issues: ValidationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="ct-issues">
      {issues.map(i => (
        <span key={i.message} className={`ct-issue ct-issue-${i.severity}`}>
          {i.message}
        </span>
      ))}
    </div>
  );
}

interface TypeFormProps {
  initial: FormState;
  /** Editing an existing type: chemistry taps don't overwrite typed voltages */
  editing: boolean;
  saving: boolean;
  serverError: string | null;
  onSave: (input: CellTypeInput) => void;
  onCancel: () => void;
}

function TypeForm({ initial, editing, saving, serverError, onSave, onCancel }: TypeFormProps) {
  const [form, setForm] = useState<FormState>(initial);
  // Once the user has typed a voltage, chemistry taps stop overwriting it.
  const [voltagesTouched, setVoltagesTouched] = useState(editing);
  const [showIssues, setShowIssues] = useState(false);

  const issues = useMemo(() => validateCellType(toInput(form)), [form]);
  const blocked = hasErrors(issues);

  const set = (field: keyof FormState, value: string) => setForm(f => ({ ...f, [field]: value }));

  const pickChemistry = (chem: Chemistry) => {
    setForm(f => {
      const next = { ...f, chemistry: chem };
      if (!voltagesTouched) {
        const v = suggestedVoltages(chem);
        next.chargeVoltageV = String(v.chargeVoltageV);
        next.dischargeCutoffV = String(v.dischargeCutoffV);
      }
      return next;
    });
  };

  const issuesFor = (field: CellTypeField): ValidationIssue[] =>
    showIssues ? issues.filter(i => i.field === field) : [];

  const submit = () => {
    setShowIssues(true);
    if (blocked) return;
    onSave(toInput(form));
  };

  return (
    <div className="ct-form">
      <label className="ct-field">
        <span className="ct-label">Name</span>
        <input
          className="ct-input"
          value={form.name}
          onChange={e => set('name', e.target.value)}
          placeholder="e.g. EVE LF280K"
        />
        <FieldIssues issues={issuesFor('name')} />
      </label>

      <div className="ct-field">
        <span className="ct-label">Chemistry</span>
        <div className="ct-chips">
          {CHEMISTRIES.map(chem => (
            <button
              key={chem}
              type="button"
              className={`filter-chip${form.chemistry === chem ? ' active' : ''}`}
              onClick={() => pickChemistry(chem)}
            >
              {chem}
            </button>
          ))}
        </div>
        <span className="ct-hint">
          Picking a chemistry fills in its usual per-cell voltages. Use Other for a multi-cell pack.
        </span>
        <FieldIssues issues={issuesFor('chemistry')} />
      </div>

      <div className="ct-row">
        <label className="ct-field">
          <span className="ct-label">Capacity (Ah)</span>
          <input
            className="ct-input"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={form.capacityAh}
            onChange={e => set('capacityAh', e.target.value)}
          />
          <FieldIssues issues={issuesFor('nominalCapacityMah')} />
        </label>
        <label className="ct-field">
          <span className="ct-label">Charge cutoff (A)</span>
          <input
            className="ct-input"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={form.chargeCutoffCurrentA}
            onChange={e => set('chargeCutoffCurrentA', e.target.value)}
          />
          <FieldIssues issues={issuesFor('chargeCutoffCurrentA')} />
        </label>
      </div>

      <div className="ct-row">
        <label className="ct-field">
          <span className="ct-label">Charge voltage (V)</span>
          <input
            className="ct-input"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={form.chargeVoltageV}
            onChange={e => {
              setVoltagesTouched(true);
              set('chargeVoltageV', e.target.value);
            }}
          />
          <FieldIssues issues={issuesFor('chargeVoltageV')} />
        </label>
        <label className="ct-field">
          <span className="ct-label">Discharge cutoff (V)</span>
          <input
            className="ct-input"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={form.dischargeCutoffV}
            onChange={e => {
              setVoltagesTouched(true);
              set('dischargeCutoffV', e.target.value);
            }}
          />
          <FieldIssues issues={issuesFor('dischargeCutoffV')} />
        </label>
      </div>

      <span className="ct-hint">
        Capacity is what C-rate steps multiply by. The voltages and cutoff current are the defaults a new manual test
        and new sequence steps start from for cells of this type.
      </span>

      {serverError && <div className="ct-error">{serverError}</div>}

      <div className="ct-form-actions">
        <button type="button" className="btn btn-confirm-group" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Add cell type'}
        </button>
        <button type="button" className="btn btn-cancel-group" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Type row ──────────────────────────────────────────────────────

interface TypeRowProps {
  group: CellGroup;
  onEdit: () => void;
  onDelete: () => Promise<string | null>;
}

function TypeRow({ group, onEdit, onDelete }: TypeRowProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const cells = group.cell_count ?? 0;
  const seqs = group.sequence_count ?? 0;

  const del = async () => {
    const err = await onDelete();
    setConfirming(false);
    setDeleteError(err);
  };

  return (
    <div className="ct-type-row">
      <div className="ct-type-main">
        <span className="ct-type-name">{group.name}</span>
        <span className="filter-chip active ct-chem-chip">{group.chemistry}</span>
        {isIncomplete(group) && <span className="ct-badge-incomplete">incomplete — add voltages</span>}
      </div>
      <div className="ct-type-specs">
        <span>
          <b>{group.nominal_capacity_mah / 1000}</b> Ah
        </span>
        <span>
          charge to <b>{group.charge_voltage_v ?? '—'}</b> V
        </span>
        <span>
          cutoff <b>{group.discharge_cutoff_v ?? '—'}</b> V
        </span>
        <span>
          end charge at <b>{group.charge_cutoff_current_a ?? '—'}</b> A
        </span>
      </div>
      <div className="ct-type-meta">
        {cells} cell{cells === 1 ? '' : 's'} · {seqs} sequence{seqs === 1 ? '' : 's'}
      </div>
      <div className="ct-type-actions">
        <button type="button" className="btn btn-link" onClick={onEdit}>
          Edit
        </button>
        {confirming ? (
          <>
            <button type="button" className="btn btn-link ct-danger" onClick={del}>
              Really delete?
            </button>
            <button type="button" className="btn btn-link" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-link ct-danger"
            onClick={() => {
              setDeleteError(null);
              setConfirming(true);
            }}
            disabled={cells > 0 || seqs > 0}
          >
            Delete
          </button>
        )}
      </div>
      {(cells > 0 || seqs > 0) && !confirming && (
        <span className="ct-hint">Reassign its cells and sequences before deleting.</span>
      )}
      {deleteError && <div className="ct-error">{deleteError}</div>}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export function CellTypesView() {
  const [groups, setGroups] = useState<CellGroup[] | null>(null);
  const [cells, setCells] = useState<Cell[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 'new' | group id being edited | null
  const [editing, setEditing] = useState<'new' | number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedWarnings, setSavedWarnings] = useState<string[]>([]);
  const [assigning, setAssigning] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [g, c] = await Promise.all([api<CellGroup[]>('/api/cell-groups'), api<Cell[]>('/api/cells')]);
      setGroups(g);
      setCells(c);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (input: CellTypeInput) => {
    setSaving(true);
    setSaveError(null);
    try {
      const saved =
        editing === 'new'
          ? await apiPost<CellGroup & { warnings?: string[] }>('/api/cell-groups', input)
          : await api<CellGroup & { warnings?: string[] }>(`/api/cell-groups/${editing}`, {
              method: 'PATCH',
              body: JSON.stringify(input),
            });
      setSavedWarnings(saved.warnings ?? []);
      setEditing(null);
      await load();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number): Promise<string | null> => {
    try {
      await api(`/api/cell-groups/${id}`, { method: 'DELETE' });
      await load();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'Delete failed';
    }
  };

  const assign = async (cellId: number, groupId: number | null) => {
    setAssigning(cellId);
    try {
      await api(`/api/cells/${cellId}/group`, { method: 'PUT', body: JSON.stringify({ groupId }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Assign failed');
    } finally {
      setAssigning(null);
    }
  };

  const byId = useMemo(() => new Map((groups ?? []).map(g => [g.id, g])), [groups]);
  const activeCells = cells.filter(c => !c.retired_at);
  const untyped = activeCells.filter(c => c.cell_group_id === null || !byId.has(c.cell_group_id));
  const typed = activeCells.filter(c => c.cell_group_id !== null && byId.has(c.cell_group_id));
  const editingGroup = typeof editing === 'number' ? byId.get(editing) : undefined;

  return (
    <div className="temp-settings ct-page">
      <header className="temp-settings-header">
        <a href="/">&larr; Back</a>
        <h1>Cell Types</h1>
      </header>

      {error && <div className="ct-error">{error}</div>}

      <section className="temp-section">
        <div className="ct-section-head">
          <h2>Types</h2>
          {editing === null && (
            <button
              type="button"
              className="btn btn-confirm-group"
              onClick={() => {
                setSaveError(null);
                setSavedWarnings([]);
                setEditing('new');
              }}
            >
              + Add cell type
            </button>
          )}
        </div>
        <p className="temp-section-hint">
          A cell type is the source of truth for a cell's capacity and voltage limits. A cell must have a type before
          any C-rate test will start on it.
        </p>

        {savedWarnings.length > 0 && (
          <div className="ct-warnings">
            Saved, with notes:
            {savedWarnings.map(w => (
              <span key={w} className="ct-issue ct-issue-warning">
                {w}
              </span>
            ))}
          </div>
        )}

        {editing === 'new' && (
          <TypeForm
            initial={EMPTY_FORM}
            editing={false}
            saving={saving}
            serverError={saveError}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        )}

        {groups === null && !error && <p className="temp-empty">Loading…</p>}
        {groups?.length === 0 && editing !== 'new' && <p className="temp-empty">No cell types yet. Add one above.</p>}

        <div className="ct-type-list">
          {groups?.map(g =>
            editing === g.id && editingGroup ? (
              <TypeForm
                key={g.id}
                initial={formFromGroup(editingGroup)}
                editing
                saving={saving}
                serverError={saveError}
                onSave={save}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <TypeRow
                key={g.id}
                group={g}
                onEdit={() => {
                  setSaveError(null);
                  setSavedWarnings([]);
                  setEditing(g.id);
                }}
                onDelete={() => remove(g.id)}
              />
            )
          )}
        </div>
      </section>

      <section className="temp-section">
        <h2>Cells</h2>
        <p className="temp-section-hint">Tap a type to assign it. Cells without a type are listed first.</p>

        {activeCells.length === 0 && <p className="temp-empty">No cells yet — they appear here once scanned.</p>}

        {untyped.length > 0 && (
          <>
            <h3 className="ct-needs-type">Needs a type ({untyped.length})</h3>
            {untyped.map(c => (
              <CellAssignRow
                key={c.id}
                cell={c}
                groups={groups ?? []}
                busy={assigning === c.id}
                onAssign={gid => assign(c.id, gid)}
              />
            ))}
          </>
        )}

        {typed.length > 0 && (
          <>
            {untyped.length > 0 && <h3>Typed ({typed.length})</h3>}
            {typed.map(c => (
              <CellAssignRow
                key={c.id}
                cell={c}
                groups={groups ?? []}
                busy={assigning === c.id}
                onAssign={gid => assign(c.id, gid)}
              />
            ))}
          </>
        )}
      </section>
    </div>
  );
}

// ── Cell assignment row ───────────────────────────────────────────

interface CellAssignRowProps {
  cell: Cell;
  groups: CellGroup[];
  busy: boolean;
  onAssign: (groupId: number | null) => void;
}

function CellAssignRow({ cell, groups, busy, onAssign }: CellAssignRowProps) {
  const current = cell.cell_group_id;
  return (
    <div className={`ct-cell-row${current === null ? ' ct-cell-untyped' : ''}`}>
      <span className="ct-cell-name">{cell.label || cell.barcode}</span>
      {cell.label && <span className="ct-cell-barcode">{cell.barcode}</span>}
      <div className="ct-chips">
        {groups.map(g => (
          <button
            key={g.id}
            type="button"
            className={`filter-chip${current === g.id ? ' active' : ''}`}
            disabled={busy}
            onClick={() => current !== g.id && onAssign(g.id)}
          >
            {g.name} · {g.nominal_capacity_mah / 1000} Ah
          </button>
        ))}
        {groups.length === 0 && <span className="ct-hint">Add a cell type first.</span>}
      </div>
    </div>
  );
}
