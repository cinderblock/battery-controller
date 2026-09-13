/**
 * StartModal — two-step wizard to identify a cell and start a test.
 *
 * Step 1 ("Scan"): Near-fullscreen barcode camera scanner with manual entry fallback.
 * Step 2 ("Configure"): Saved sequences (with visual preview) shown prominently,
 *   simple modes (D-CC / D-CP / C-CV) as secondary option, cell notes field.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiPost, type Cell, type CellGroup, type TestRun } from '../api-client.ts';
import { type StartTestParams, useSession } from '../hooks/useDeviceSession.ts';
import type { SequenceStep } from '../lib/sequence-types.ts';
import { parseSequenceDoc } from '../lib/sequence-types.ts';
import { BarcodeScanner } from './BarcodeScanner.tsx';

// ── Types ──────────────────────────────────────────────────────────

interface StartModalProps {
  open: boolean;
  onClose: () => void;
  cellGroups: CellGroup[];
  /** Opened by the "cell connected but unidentified" prompt rather than by click */
  newCellPrompt?: boolean;
}

type TestMode = 'd-cc' | 'd-cp' | 'c-cv';

interface SavedSequence {
  id: number;
  name: string;
  steps_json: string;
}

type WizardStep = 'scan' | 'configure';
type ConfigTab = 'sequence' | 'manual';

// ── Defaults per mode ──────────────────────────────────────────────

interface ModeDefaults {
  currentA: number;
  voltageV: number;
  powerW: number;
  cutoffV: number;
  cutoffCurrentA: number;
}

// Fallbacks for a cell with no type (TS-LFP200AHA numbers). With a type, its
// own limits win — see defaultsFor().
const DEFAULTS: Record<TestMode, ModeDefaults> = {
  'd-cc': { currentA: 40.0, voltageV: 0, powerW: 0, cutoffV: 2.5, cutoffCurrentA: 0 },
  'd-cp': { currentA: 0, voltageV: 0, powerW: 100, cutoffV: 2.5, cutoffCurrentA: 0 },
  'c-cv': { currentA: 40.0, voltageV: 3.65, powerW: 0, cutoffV: 0, cutoffCurrentA: 2.0 },
};

/** Mode defaults seeded from the cell's type, so a Li-ion cell doesn't start from LFP voltages. */
function defaultsFor(mode: TestMode, type: CellGroup | null): ModeDefaults {
  const d = { ...DEFAULTS[mode] };
  if (!type) return d;
  if (mode !== 'c-cv' && type.discharge_cutoff_v != null) d.cutoffV = type.discharge_cutoff_v;
  if (mode === 'c-cv') {
    if (type.charge_voltage_v != null) d.voltageV = type.charge_voltage_v;
    if (type.charge_cutoff_current_a != null) d.cutoffCurrentA = type.charge_cutoff_current_a;
  }
  return d;
}

/** Does a saved sequence contain any C-rate step (including inside loops)? */
function sequenceNeedsCapacity(steps: SequenceStep[]): boolean {
  return steps.some(s => {
    if (s.type === 'loop') return sequenceNeedsCapacity(s.children);
    return (s.type === 'd-cc' || s.type === 'c-cv') && !!s.useCRate;
  });
}

// ── Step colors for sequence preview ──────────────────────────────

const STEP_COLORS: Record<string, string> = {
  'c-cv': 'var(--charge-color)',
  'd-cc': 'var(--discharge-color)',
  'd-cp': '#ff7043',
  wait: '#666',
};

const STEP_LABELS: Record<string, string> = {
  'c-cv': 'Charge',
  'd-cc': 'Disch',
  'd-cp': 'D-CP',
  wait: 'Wait',
};

// ── Sequence step preview ─────────────────────────────────────────

function SequencePreview({ stepsJson }: { stepsJson: string }) {
  const steps: SequenceStep[] = useMemo(() => parseSequenceDoc<SequenceStep>(stepsJson).steps, [stepsJson]);

  // Flatten for display (expand loops once)
  const flat: { type: string; label: string; color: string; loopCount?: number }[] = [];
  for (const step of steps) {
    if (step.type === 'loop') {
      flat.push({ type: 'loop-start', label: `${step.count}×`, color: 'transparent', loopCount: step.count });
      for (const child of step.children) {
        flat.push({
          type: child.type,
          label: STEP_LABELS[child.type] ?? child.type,
          color: STEP_COLORS[child.type] ?? '#555',
        });
      }
      flat.push({ type: 'loop-end', label: '', color: 'transparent' });
    } else {
      flat.push({
        type: step.type,
        label: STEP_LABELS[step.type] ?? step.type,
        color: STEP_COLORS[step.type] ?? '#555',
      });
    }
  }

  return (
    <div className="seq-preview">
      {flat.map((s, i) => {
        if (s.type === 'loop-start') {
          return (
            <span key={i} className="seq-preview-loop-badge">
              {s.label}
            </span>
          );
        }
        if (s.type === 'loop-end') return null;
        return (
          <span key={i} className="seq-preview-block" style={{ background: s.color }}>
            {s.label}
          </span>
        );
      })}
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────

export function StartModal({ open, onClose, cellGroups, newCellPrompt }: StartModalProps) {
  const { startTest, claimCell } = useSession();

  // Wizard step
  const [wizardStep, setWizardStep] = useState<WizardStep>('scan');

  // Cell identification
  const [barcode, setBarcode] = useState('');
  const [cellInfo, setCellInfo] = useState<Cell | null>(null);
  const [cellNotes, setCellNotes] = useState('');
  const [notesDirty, setNotesDirty] = useState(false);

  // Config step
  const [configTab, setConfigTab] = useState<ConfigTab>('sequence');
  const [sequences, setSequences] = useState<SavedSequence[]>([]);
  const [selectedSequenceId, setSelectedSequenceId] = useState<number | null>(null);
  const [sequencesLoaded, setSequencesLoaded] = useState(false);

  // Manual mode params
  const [mode, setMode] = useState<TestMode>('d-cc');
  const [currentA, setCurrentA] = useState(DEFAULTS['d-cc'].currentA);
  const [voltageV, setVoltageV] = useState(DEFAULTS['c-cv'].voltageV);
  const [powerW, setPowerW] = useState(DEFAULTS['d-cp'].powerW);
  const [cutoffV, setCutoffV] = useState(DEFAULTS['d-cc'].cutoffV);
  const [cutoffCurrentA, setCutoffCurrentA] = useState(DEFAULTS['c-cv'].cutoffCurrentA);
  const [useCRate, setUseCRate] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lastCell, setLastCell] = useState<Cell | null>(null);

  // Sequence variable overrides for this launch (variable key → value string)
  const [seqVarValues, setSeqVarValues] = useState<Record<string, string>>({});

  // The scanned cell's own type — never a page-level selection. null = untyped,
  // and C-rate (manual or in a sequence) refuses to start until one is assigned.
  const cellType = useMemo(
    () => (cellInfo?.cell_group_id != null ? (cellGroups.find(g => g.id === cellInfo.cell_group_id) ?? null) : null),
    [cellInfo, cellGroups]
  );
  const capacityAh = cellType ? cellType.nominal_capacity_mah / 1000 : null;
  const [assigningType, setAssigningType] = useState(false);

  const assignType = useCallback(
    async (groupId: number) => {
      if (!cellInfo) return;
      setAssigningType(true);
      setError(null);
      try {
        await api(`/api/cells/${cellInfo.id}/group`, { method: 'PUT', body: JSON.stringify({ groupId }) });
        setCellInfo({ ...cellInfo, cell_group_id: groupId });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to assign cell type');
      } finally {
        setAssigningType(false);
      }
    },
    [cellInfo]
  );

  // Re-seed the manual form's voltages from the cell's type once it is known
  useEffect(() => {
    const d = defaultsFor(mode, cellType);
    setVoltageV(d.voltageV);
    setCutoffV(d.cutoffV);
    setCutoffCurrentA(d.cutoffCurrentA);
    // Only when the type changes — mode changes go through handleModeChange
  }, [cellType]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reset state when modal opens/closes ──────────────────────
  useEffect(() => {
    if (open) {
      setWizardStep('scan');
      setBarcode('');
      setCellInfo(null);
      setCellNotes('');
      setNotesDirty(false);
      setError(null);
      setSubmitting(false);
      setSequencesLoaded(false);
      setLastCell(null);

      // Fetch most recently used cell for quick-continue
      api<Cell[]>('/api/cells/recent')
        .then(cells => {
          if (cells[0]) setLastCell(cells[0]);
        })
        .catch(() => {});
    }
  }, [open]);

  // ── Load sequences when reaching configure step ──────────────
  useEffect(() => {
    if (wizardStep !== 'configure' || sequencesLoaded) return;
    api<SavedSequence[]>('/api/sequences')
      .then(seqs => {
        setSequences(seqs);
        if (seqs.length > 0 && !selectedSequenceId) setSelectedSequenceId(seqs[0].id);
        // Default to sequence tab if sequences exist, manual otherwise
        setConfigTab(seqs.length > 0 ? 'sequence' : 'manual');
      })
      .catch(() => {})
      .finally(() => setSequencesLoaded(true));
  }, [wizardStep, sequencesLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Seed variable inputs when the selected sequence changes ───
  const selectedSeqVariables = useMemo(() => {
    const seq = sequences.find(s => s.id === selectedSequenceId);
    return seq ? parseSequenceDoc(seq.steps_json).variables : [];
  }, [sequences, selectedSequenceId]);

  useEffect(() => {
    const init: Record<string, string> = {};
    for (const v of selectedSeqVariables) init[v.key] = String(v.value);
    setSeqVarValues(init);
  }, [selectedSeqVariables]);

  // ── Look up cell info when barcode changes ───────────────────
  const lookupCell = useCallback(
    async (bc: string) => {
      if (!bc.trim()) {
        setCellInfo(null);
        setCellNotes('');
        return;
      }
      try {
        // Upsert cell to get/create it
        const cell = await apiPost<Cell>('/api/cells', { barcode: bc.trim() });
        setCellInfo(cell);
        setCellNotes(cell.notes ?? '');
        setNotesDirty(false);
        // The connected cell now has a name — clear the scan prompt everywhere
        claimCell(cell.barcode);
      } catch {
        setCellInfo(null);
      }
    },
    [claimCell]
  );

  // ── Handlers ─────────────────────────────────────────────────

  const handleScan = useCallback(
    (scannedBarcode: string) => {
      setBarcode(scannedBarcode);
      lookupCell(scannedBarcode).then(() => setWizardStep('configure'));
    },
    [lookupCell]
  );

  const handleSkipScan = useCallback(() => {
    if (barcode.trim()) {
      lookupCell(barcode).then(() => setWizardStep('configure'));
    } else {
      setWizardStep('configure');
    }
  }, [barcode, lookupCell]);

  const handleContinueLastCell = useCallback(() => {
    if (!lastCell) return;
    setBarcode(lastCell.barcode);
    setCellInfo(lastCell);
    setCellNotes(lastCell.notes ?? '');
    setNotesDirty(false);
    // Skips lookupCell, so claim here too
    claimCell(lastCell.barcode);
    setWizardStep('configure');
  }, [lastCell, claimCell]);

  const handleManualBarcodeSubmit = useCallback(() => {
    if (barcode.trim()) {
      lookupCell(barcode).then(() => setWizardStep('configure'));
    }
  }, [barcode, lookupCell]);

  const handleModeChange = useCallback(
    (newMode: TestMode) => {
      setMode(newMode);
      const d = defaultsFor(newMode, cellType);
      setCurrentA(d.currentA);
      setVoltageV(d.voltageV);
      setPowerW(d.powerW);
      setCutoffV(d.cutoffV);
      setCutoffCurrentA(d.cutoffCurrentA);
      setError(null);
    },
    [cellType]
  );

  const saveNotesIfDirty = useCallback(async () => {
    if (cellInfo && notesDirty) {
      try {
        await api(`/api/cells/${cellInfo.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ notes: cellNotes }),
        });
      } catch {
        /* best-effort */
      }
    }
  }, [cellInfo, cellNotes, notesDirty]);

  const handleSubmit = useCallback(async () => {
    setError(null);
    setSubmitting(true);

    try {
      // Save notes before starting
      await saveNotesIfDirty();

      if (configTab === 'sequence') {
        const seq = sequences.find(s => s.id === selectedSequenceId);
        if (!seq) {
          setError('No sequence selected');
          setSubmitting(false);
          return;
        }

        const doc = parseSequenceDoc<SequenceStep>(seq.steps_json);
        // The server refuses this too; catching it here gives a pointed message
        // next to the chips that fix it instead of a generic start failure.
        if (sequenceNeedsCapacity(doc.steps) && capacityAh === null) {
          setError(
            barcode.trim()
              ? 'This sequence has C-rate steps — assign the cell a type first'
              : 'This sequence has C-rate steps, so it needs a scanned cell with a type'
          );
          setSubmitting(false);
          return;
        }
        let cellId: number | undefined;
        if (barcode.trim()) {
          const cell = await apiPost<{ id: number }>('/api/cells', { barcode: barcode.trim() });
          cellId = cell.id;
        }

        // Variable values for this launch: edited value, or the saved default
        const variables = doc.variables.map(v => {
          const parsed = parseFloat(seqVarValues[v.key] ?? '');
          return { key: v.key, value: Number.isFinite(parsed) ? parsed : v.value };
        });

        await apiPost('/api/cycle/start', { name: seq.name, steps: doc.steps, cellId, variables });
        onClose();
      } else {
        if (useCRate && capacityAh === null) {
          setError(barcode.trim() ? 'Assign the cell a type to use C-rate' : 'C-rate needs a scanned cell with a type');
          setSubmitting(false);
          return;
        }
        // C-rate is sent as the multiplier; the server converts it against the
        // cell's type so the amps on the clips never depend on browser state.
        const params: StartTestParams = { mode };

        if (barcode.trim()) params.barcode = barcode.trim();

        switch (mode) {
          case 'd-cc':
            params.currentA = currentA;
            params.useCRate = useCRate;
            params.cutoffV = cutoffV;
            break;
          case 'd-cp':
            params.powerW = powerW;
            params.cutoffV = cutoffV;
            break;
          case 'c-cv':
            params.currentA = currentA;
            params.useCRate = useCRate;
            params.voltageV = voltageV;
            params.cutoffCurrentA = cutoffCurrentA;
            break;
        }

        await startTest(params);
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start test');
    } finally {
      setSubmitting(false);
    }
  }, [
    configTab,
    barcode,
    currentA,
    voltageV,
    powerW,
    cutoffV,
    cutoffCurrentA,
    useCRate,
    capacityAh,
    startTest,
    onClose,
    sequences,
    selectedSequenceId,
    seqVarValues,
    mode,
    saveNotesIfDirty,
  ]);

  if (!open) return null;

  // ── Render Step 1: Scan ──────────────────────────────────────

  if (wizardStep === 'scan') {
    return (
      <div className="modal-overlay wizard-overlay" onClick={onClose}>
        <div className="wizard-panel wizard-scan" onClick={e => e.stopPropagation()}>
          <div className="wizard-scan-header">
            <h2>{newCellPrompt ? 'New Cell Detected' : 'Scan Cell'}</h2>
            <button className="scanner-close" onClick={onClose}>
              &times;
            </button>
          </div>

          {newCellPrompt && (
            <p className="wizard-scan-prompt">A cell was connected. Scan or enter its serial number.</p>
          )}

          <div className="wizard-scan-camera">
            <BarcodeScanner onScan={handleScan} onClose={onClose} />
          </div>

          <div className="wizard-scan-footer">
            <div className="wizard-scan-manual">
              <input
                type="text"
                value={barcode}
                onChange={e => setBarcode(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleManualBarcodeSubmit()}
                placeholder="Or type barcode..."
                className="wizard-barcode-input"
              />
              {barcode.trim() && (
                <button className="btn btn-start" onClick={handleManualBarcodeSubmit}>
                  Next
                </button>
              )}
            </div>
            {lastCell && (
              <button className="btn btn-start wizard-continue-btn" onClick={handleContinueLastCell}>
                Continue — {lastCell.barcode}
              </button>
            )}
            <button className="btn wizard-skip-btn" onClick={handleSkipScan}>
              Skip — no barcode
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Render Step 2: Configure ─────────────────────────────────

  const selectedSequence = sequences.find(s => s.id === selectedSequenceId);

  return (
    <div className="modal-overlay wizard-overlay" onClick={onClose}>
      <div className="wizard-panel wizard-configure" onClick={e => e.stopPropagation()}>
        {/* Header with back button */}
        <div className="wizard-config-header">
          <button className="btn wizard-back-btn" onClick={() => setWizardStep('scan')}>
            &larr;
          </button>
          <h2>Start Test</h2>
          <button className="scanner-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="wizard-config-body">
          {/* Cell info bar */}
          {barcode && (
            <div className="wizard-cell-info">
              <div className="wizard-cell-barcode">{barcode}</div>
              {cellInfo && (
                <div className="wizard-cell-type">
                  <span className={`wizard-cell-group${cellType ? '' : ' wizard-cell-untyped'}`}>
                    {cellType ? `${cellType.name} · ${capacityAh} Ah` : 'No cell type — tap one:'}
                  </span>
                  {(cellGroups.length > 1 || !cellType) && (
                    <div className="wizard-type-chips">
                      {cellGroups.map(g => (
                        <button
                          key={g.id}
                          type="button"
                          className={`filter-chip${cellType?.id === g.id ? ' active' : ''}`}
                          disabled={assigningType}
                          onClick={() => cellType?.id !== g.id && assignType(g.id)}
                        >
                          {g.name} · {g.nominal_capacity_mah / 1000} Ah
                        </button>
                      ))}
                      {cellGroups.length === 0 && (
                        <a href="/cell-types" className="wizard-type-link">
                          Add a cell type
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )}
              <textarea
                className="wizard-cell-notes"
                value={cellNotes}
                onChange={e => {
                  setCellNotes(e.target.value);
                  setNotesDirty(true);
                }}
                placeholder="Cell notes..."
                rows={2}
              />
            </div>
          )}

          {/* Config tabs */}
          <div className="wizard-tabs">
            {sequences.length > 0 && (
              <button
                className={`wizard-tab ${configTab === 'sequence' ? 'active' : ''}`}
                onClick={() => setConfigTab('sequence')}
              >
                Sequences
              </button>
            )}
            <button
              className={`wizard-tab ${configTab === 'manual' ? 'active' : ''}`}
              onClick={() => setConfigTab('manual')}
            >
              Manual
            </button>
          </div>

          {/* Sequence selection */}
          {configTab === 'sequence' && (
            <div className="wizard-sequences">
              {sequences.map(seq => (
                <button
                  key={seq.id}
                  className={`wizard-seq-card ${selectedSequenceId === seq.id ? 'selected' : ''}`}
                  onClick={() => setSelectedSequenceId(seq.id)}
                >
                  <span className="wizard-seq-name">{seq.name}</span>
                  <SequencePreview stepsJson={seq.steps_json} />
                </button>
              ))}
            </div>
          )}

          {/* Sequence variables — adjust for this launch */}
          {configTab === 'sequence' && selectedSeqVariables.length > 0 && (
            <div className="wizard-seq-vars">
              <label className="wizard-section-label">Variables</label>
              <div className="wizard-seq-var-list">
                {selectedSeqVariables.map(v => (
                  <div key={v.key} className="wizard-seq-var-row">
                    <span className="wizard-seq-var-name">{v.key}</span>
                    <input
                      type="number"
                      value={seqVarValues[v.key] ?? String(v.value)}
                      onChange={e => setSeqVarValues(prev => ({ ...prev, [v.key]: e.target.value }))}
                      step={0.1}
                    />
                    {v.unit && <span className="wizard-seq-var-unit">{v.unit}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Manual mode */}
          {configTab === 'manual' && (
            <div className="wizard-manual">
              <div className="mode-selector">
                <button
                  className={`mode-btn ${mode === 'd-cc' ? 'active' : ''}`}
                  onClick={() => handleModeChange('d-cc')}
                >
                  D-CC
                </button>
                <button
                  className={`mode-btn ${mode === 'd-cp' ? 'active' : ''}`}
                  onClick={() => handleModeChange('d-cp')}
                >
                  D-CP
                </button>
                <button
                  className={`mode-btn ${mode === 'c-cv' ? 'active' : ''}`}
                  onClick={() => handleModeChange('c-cv')}
                >
                  C-CV
                </button>
              </div>

              <div className="form-params">
                {(mode === 'd-cc' || mode === 'c-cv') && (
                  <div className="form-group">
                    <label>
                      {mode === 'c-cv' ? 'Charge Current' : 'Discharge Current'}
                      <button
                        className={`crate-toggle ${useCRate ? 'active' : ''}`}
                        onClick={() => setUseCRate(!useCRate)}
                      >
                        {useCRate ? 'C' : 'A'}
                      </button>
                    </label>
                    <input
                      type="number"
                      value={currentA}
                      onChange={e => setCurrentA(parseFloat(e.target.value) || 0)}
                      step={0.01}
                      min={0}
                    />
                    {useCRate && (
                      <span className={`form-hint${capacityAh === null ? ' form-hint-warn' : ''}`}>
                        {capacityAh === null
                          ? 'needs a cell type'
                          : `${(currentA * capacityAh).toFixed(2)} A (${capacityAh} Ah × ${currentA})`}
                      </span>
                    )}
                  </div>
                )}
                {mode === 'd-cp' && (
                  <div className="form-group">
                    <label>Power (W)</label>
                    <input
                      type="number"
                      value={powerW}
                      onChange={e => setPowerW(parseFloat(e.target.value) || 0)}
                      step={1}
                      min={0}
                    />
                  </div>
                )}
                {mode === 'c-cv' && (
                  <div className="form-group">
                    <label>Target Voltage (V)</label>
                    <input
                      type="number"
                      value={voltageV}
                      onChange={e => setVoltageV(parseFloat(e.target.value) || 0)}
                      step={0.01}
                      min={0}
                    />
                  </div>
                )}
                {(mode === 'd-cc' || mode === 'd-cp') && (
                  <div className="form-group">
                    <label>Cutoff Voltage (V)</label>
                    <input
                      type="number"
                      value={cutoffV}
                      onChange={e => setCutoffV(parseFloat(e.target.value) || 0)}
                      step={0.01}
                      min={0}
                    />
                  </div>
                )}
                {mode === 'c-cv' && (
                  <div className="form-group">
                    <label>Cutoff Current (A)</label>
                    <input
                      type="number"
                      value={cutoffCurrentA}
                      onChange={e => setCutoffCurrentA(parseFloat(e.target.value) || 0)}
                      step={0.01}
                      min={0}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {error && <div className="form-error">{error}</div>}
        </div>

        {/* Footer */}
        <div className="wizard-config-footer">
          <button className="btn btn-cancel" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="btn btn-start" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Starting...' : configTab === 'sequence' ? 'Run Sequence' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
