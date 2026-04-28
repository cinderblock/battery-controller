/**
 * StartModal — two-step wizard to identify a cell and start a test.
 *
 * Step 1 ("Scan"): Near-fullscreen barcode camera scanner with manual entry fallback.
 * Step 2 ("Configure"): Saved sequences (with visual preview) shown prominently,
 *   simple modes (D-CC / D-CP / C-CV) as secondary option, cell notes field.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useSession, type StartTestParams } from '../hooks/useDeviceSession.ts';
import { api, apiPost, type CellGroup, type Cell, type TestRun } from '../api-client.ts';
import { BarcodeScanner } from './BarcodeScanner.tsx';
import type { SequenceStep } from '../lib/sequence-types.ts';

// ── Types ──────────────────────────────────────────────────────────

interface StartModalProps {
  open: boolean;
  onClose: () => void;
  cellGroups: CellGroup[];
  selectedGroupId: number | null;
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

const DEFAULTS: Record<TestMode, {
  currentA: number; voltageV: number; powerW: number;
  cutoffV: number; cutoffCurrentA: number;
}> = {
  'd-cc': { currentA: 40.0, voltageV: 0, powerW: 0, cutoffV: 2.50, cutoffCurrentA: 0 },
  'd-cp': { currentA: 0, voltageV: 0, powerW: 100, cutoffV: 2.50, cutoffCurrentA: 0 },
  'c-cv': { currentA: 40.0, voltageV: 3.65, powerW: 0, cutoffV: 0, cutoffCurrentA: 2.0 },
};

// ── Step colors for sequence preview ──────────────────────────────

const STEP_COLORS: Record<string, string> = {
  'c-cv': 'var(--charge-color)',
  'd-cc': 'var(--discharge-color)',
  'd-cp': '#ff7043',
  'wait': '#666',
};

const STEP_LABELS: Record<string, string> = {
  'c-cv': 'Charge',
  'd-cc': 'Disch',
  'd-cp': 'D-CP',
  'wait': 'Wait',
};

// ── Sequence step preview ─────────────────────────────────────────

function SequencePreview({ stepsJson }: { stepsJson: string }) {
  const steps: SequenceStep[] = useMemo(() => {
    try { return JSON.parse(stepsJson); }
    catch { return []; }
  }, [stepsJson]);

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
          return <span key={i} className="seq-preview-loop-badge">{s.label}</span>;
        }
        if (s.type === 'loop-end') return null;
        return (
          <span
            key={i}
            className="seq-preview-block"
            style={{ background: s.color }}
            title={s.label}
          >
            {s.label}
          </span>
        );
      })}
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────

export function StartModal({ open, onClose, cellGroups, selectedGroupId }: StartModalProps) {
  const { startTest } = useSession();

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

  const selectedGroup = cellGroups.find(g => g.id === selectedGroupId) ?? cellGroups[0];
  const capacityAh = selectedGroup ? selectedGroup.nominal_capacity_mah / 1000 : 200;

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
        .then(cells => { if (cells[0]) setLastCell(cells[0]); })
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
  }, [wizardStep, sequencesLoaded, selectedSequenceId]);

  // ── Look up cell info when barcode changes ───────────────────
  const lookupCell = useCallback(async (bc: string) => {
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
    } catch {
      setCellInfo(null);
    }
  }, []);

  // ── Handlers ─────────────────────────────────────────────────

  const handleScan = useCallback((scannedBarcode: string) => {
    setBarcode(scannedBarcode);
    lookupCell(scannedBarcode).then(() => setWizardStep('configure'));
  }, [lookupCell]);

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
    setWizardStep('configure');
  }, [lastCell]);

  const handleManualBarcodeSubmit = useCallback(() => {
    if (barcode.trim()) {
      lookupCell(barcode).then(() => setWizardStep('configure'));
    }
  }, [barcode, lookupCell]);

  const handleModeChange = useCallback((newMode: TestMode) => {
    setMode(newMode);
    const d = DEFAULTS[newMode];
    setCurrentA(d.currentA);
    setVoltageV(d.voltageV);
    setPowerW(d.powerW);
    setCutoffV(d.cutoffV);
    setCutoffCurrentA(d.cutoffCurrentA);
    setError(null);
  }, []);

  const saveNotesIfDirty = useCallback(async () => {
    if (cellInfo && notesDirty) {
      try {
        await api(`/api/cells/${cellInfo.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ notes: cellNotes }),
        });
      } catch { /* best-effort */ }
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
        if (!seq) { setError('No sequence selected'); setSubmitting(false); return; }

        const steps = JSON.parse(seq.steps_json);
        let cellId: number | undefined;
        if (barcode.trim()) {
          const cell = await apiPost<{ id: number }>('/api/cells', { barcode: barcode.trim() });
          cellId = cell.id;
        }

        await apiPost('/api/cycle/start', { name: seq.name, steps, cellId });
        onClose();
      } else {
        const actualCurrentA = useCRate ? currentA * capacityAh : currentA;
        const params: StartTestParams = { mode };

        if (barcode.trim()) params.barcode = barcode.trim();

        switch (mode) {
          case 'd-cc':
            params.currentA = actualCurrentA;
            params.cutoffV = cutoffV;
            break;
          case 'd-cp':
            params.powerW = powerW;
            params.cutoffV = cutoffV;
            break;
          case 'c-cv':
            params.currentA = actualCurrentA;
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
  }, [configTab, barcode, currentA, voltageV, powerW, cutoffV, cutoffCurrentA, useCRate, capacityAh, startTest, onClose, sequences, selectedSequenceId, mode, saveNotesIfDirty]);

  if (!open) return null;

  // ── Render Step 1: Scan ──────────────────────────────────────

  if (wizardStep === 'scan') {
    return (
      <div className="modal-overlay wizard-overlay" onClick={onClose}>
        <div className="wizard-panel wizard-scan" onClick={e => e.stopPropagation()}>
          <div className="wizard-scan-header">
            <h2>Scan Cell</h2>
            <button className="scanner-close" onClick={onClose}>&times;</button>
          </div>

          <div className="wizard-scan-camera">
            <BarcodeScanner
              onScan={handleScan}
              onClose={onClose}
            />
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
          <button className="scanner-close" onClick={onClose}>&times;</button>
        </div>

        <div className="wizard-config-body">
          {/* Cell info bar */}
          {barcode && (
            <div className="wizard-cell-info">
              <div className="wizard-cell-barcode">{barcode}</div>
              {selectedGroup && (
                <span className="wizard-cell-group">{selectedGroup.name} ({capacityAh} Ah)</span>
              )}
              <textarea
                className="wizard-cell-notes"
                value={cellNotes}
                onChange={e => { setCellNotes(e.target.value); setNotesDirty(true); }}
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

          {/* Manual mode */}
          {configTab === 'manual' && (
            <div className="wizard-manual">
              <div className="mode-selector">
                <button className={`mode-btn ${mode === 'd-cc' ? 'active' : ''}`} onClick={() => handleModeChange('d-cc')}>D-CC</button>
                <button className={`mode-btn ${mode === 'd-cp' ? 'active' : ''}`} onClick={() => handleModeChange('d-cp')}>D-CP</button>
                <button className={`mode-btn ${mode === 'c-cv' ? 'active' : ''}`} onClick={() => handleModeChange('c-cv')}>C-CV</button>
              </div>

              <div className="form-params">
                {(mode === 'd-cc' || mode === 'c-cv') && (
                  <div className="form-group">
                    <label>
                      {mode === 'c-cv' ? 'Charge Current' : 'Discharge Current'}
                      <button className={`crate-toggle ${useCRate ? 'active' : ''}`} onClick={() => setUseCRate(!useCRate)}>
                        {useCRate ? 'C' : 'A'}
                      </button>
                    </label>
                    <input type="number" value={currentA} onChange={e => setCurrentA(parseFloat(e.target.value) || 0)} step={0.01} min={0} />
                    {useCRate && <span className="form-hint">{(currentA * capacityAh).toFixed(2)} A</span>}
                  </div>
                )}
                {mode === 'd-cp' && (
                  <div className="form-group">
                    <label>Power (W)</label>
                    <input type="number" value={powerW} onChange={e => setPowerW(parseFloat(e.target.value) || 0)} step={1} min={0} />
                  </div>
                )}
                {mode === 'c-cv' && (
                  <div className="form-group">
                    <label>Target Voltage (V)</label>
                    <input type="number" value={voltageV} onChange={e => setVoltageV(parseFloat(e.target.value) || 0)} step={0.01} min={0} />
                  </div>
                )}
                {(mode === 'd-cc' || mode === 'd-cp') && (
                  <div className="form-group">
                    <label>Cutoff Voltage (V)</label>
                    <input type="number" value={cutoffV} onChange={e => setCutoffV(parseFloat(e.target.value) || 0)} step={0.01} min={0} />
                  </div>
                )}
                {mode === 'c-cv' && (
                  <div className="form-group">
                    <label>Cutoff Current (A)</label>
                    <input type="number" value={cutoffCurrentA} onChange={e => setCutoffCurrentA(parseFloat(e.target.value) || 0)} step={0.01} min={0} />
                  </div>
                )}
              </div>
            </div>
          )}

          {error && <div className="form-error">{error}</div>}
        </div>

        {/* Footer */}
        <div className="wizard-config-footer">
          <button className="btn btn-cancel" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-start" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Starting...' : configTab === 'sequence' ? 'Run Sequence' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
