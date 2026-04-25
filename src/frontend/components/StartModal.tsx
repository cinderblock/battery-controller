/**
 * StartModal — modal dialog to configure and start a new test.
 *
 * Inputs: cell barcode (camera scanner + manual entry), mode selector
 * (D-CC / D-CP / C-CV / Sequence), parameters with validation, Amps / C-rate toggle.
 * Sequence mode loads saved sequences and starts a cycle program.
 */

import { useState, useCallback, useEffect } from 'react';
import { useSession, type StartTestParams } from '../hooks/useDeviceSession.ts';
import { api, apiPost, type CellGroup } from '../api-client.ts';
import { BarcodeScanner } from './BarcodeScanner.tsx';

// ── Types ──────────────────────────────────────────────────────────

interface StartModalProps {
  open: boolean;
  onClose: () => void;
  cellGroups: CellGroup[];
  selectedGroupId: number | null;
}

type TestMode = 'd-cc' | 'd-cp' | 'c-cv' | 'sequence';

interface SavedSequence {
  id: number;
  name: string;
  steps_json: string;
}

// ── Defaults per mode ──────────────────────────────────────────────

const DEFAULTS = {
  'd-cc': { currentA: 40.0, voltageV: 0, powerW: 0, cutoffV: 2.50, cutoffCurrentA: 0, maxTimeMin: 600 },
  'd-cp': { currentA: 0, voltageV: 0, powerW: 100, cutoffV: 2.50, cutoffCurrentA: 0, maxTimeMin: 600 },
  'c-cv': { currentA: 40.0, voltageV: 3.65, powerW: 0, cutoffV: 0, cutoffCurrentA: 2.0, maxTimeMin: 600 },
};

// ── Component ──────────────────────────────────────────────────────

export function StartModal({ open, onClose, cellGroups, selectedGroupId }: StartModalProps) {
  const { startTest } = useSession();

  const [barcode, setBarcode] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [mode, setMode] = useState<TestMode>('d-cc');
  const [currentA, setCurrentA] = useState(DEFAULTS['d-cc'].currentA);
  const [voltageV, setVoltageV] = useState(DEFAULTS['c-cv'].voltageV);
  const [powerW, setPowerW] = useState(DEFAULTS['d-cp'].powerW);
  const [cutoffV, setCutoffV] = useState(DEFAULTS['d-cc'].cutoffV);
  const [cutoffCurrentA, setCutoffCurrentA] = useState(DEFAULTS['c-cv'].cutoffCurrentA);
  const [useCRate, setUseCRate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Sequence mode state
  const [sequences, setSequences] = useState<SavedSequence[]>([]);
  const [selectedSequenceId, setSelectedSequenceId] = useState<number | null>(null);
  const [sequencesLoaded, setSequencesLoaded] = useState(false);

  // Get capacity from selected cell group for C-rate conversion
  const selectedGroup = cellGroups.find(g => g.id === selectedGroupId) ?? cellGroups[0];
  const capacityAh = selectedGroup ? selectedGroup.nominal_capacity_mah / 1000 : 200;

  // Load saved sequences when modal opens
  useEffect(() => {
    if (!open || sequencesLoaded) return;
    api<SavedSequence[]>('/api/sequences')
      .then(seqs => {
        setSequences(seqs);
        if (seqs.length > 0 && !selectedSequenceId) setSelectedSequenceId(seqs[0].id);
      })
      .catch(() => {})
      .finally(() => setSequencesLoaded(true));
  }, [open, sequencesLoaded, selectedSequenceId]);

  // Reset loaded flag when modal closes so it refreshes next open
  useEffect(() => {
    if (!open) setSequencesLoaded(false);
  }, [open]);

  const handleModeChange = useCallback((newMode: TestMode) => {
    setMode(newMode);
    if (newMode !== 'sequence') {
      const d = DEFAULTS[newMode];
      setCurrentA(d.currentA);
      setVoltageV(d.voltageV);
      setPowerW(d.powerW);
      setCutoffV(d.cutoffV);
      setCutoffCurrentA(d.cutoffCurrentA);
    }
    setError(null);
  }, []);

  const handleScan = useCallback((scannedBarcode: string) => {
    setBarcode(scannedBarcode);
    setScannerOpen(false);
  }, []);

  const handleSubmit = useCallback(async () => {
    setError(null);
    setSubmitting(true);

    try {
      if (mode === 'sequence') {
        // Start a cycle program from a saved sequence
        const seq = sequences.find(s => s.id === selectedSequenceId);
        if (!seq) { setError('No sequence selected'); setSubmitting(false); return; }

        const steps = JSON.parse(seq.steps_json);

        // Associate cell if barcode provided
        let cellId: number | undefined;
        if (barcode.trim()) {
          const cell = await apiPost<{ id: number }>('/api/cells', { barcode: barcode.trim() });
          cellId = cell.id;
        }

        await apiPost('/api/cycle/start', { name: seq.name, steps, cellId });
        onClose();
      } else {
        // Start a single-mode test
        const actualCurrentA = useCRate ? currentA * capacityAh : currentA;
        const params: StartTestParams = { mode };

        if (barcode.trim()) {
          params.barcode = barcode.trim();
        }

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
  }, [mode, barcode, currentA, voltageV, powerW, cutoffV, cutoffCurrentA, useCRate, capacityAh, startTest, onClose, sequences, selectedSequenceId]);

  if (!open) return null;

  const selectedSequence = sequences.find(s => s.id === selectedSequenceId);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <h2>New Test Run</h2>

        {/* Cell barcode with scanner */}
        <div className="form-group">
          <label>Cell Barcode</label>
          {scannerOpen ? (
            <BarcodeScanner
              onScan={handleScan}
              onClose={() => setScannerOpen(false)}
            />
          ) : (
            <div className="barcode-input-row">
              <input
                type="text"
                value={barcode}
                onChange={e => setBarcode(e.target.value)}
                placeholder="Scan or type barcode..."
                className="barcode-text-input"
              />
              <button
                className="btn btn-scan"
                onClick={() => setScannerOpen(true)}
                type="button"
                title="Scan with camera"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </button>
            </div>
          )}
          {barcode && !scannerOpen && (
            <span className="barcode-confirmed">{barcode}</span>
          )}
        </div>

        {/* Cell group (read-only for now) */}
        {selectedGroup && (
          <div className="form-group">
            <label>Cell Group</label>
            <span className="form-static">{selectedGroup.name} ({capacityAh} Ah)</span>
          </div>
        )}

        {/* Mode selector */}
        <div className="form-group">
          <label>Mode</label>
          <div className="mode-selector">
            <button
              className={`mode-btn ${mode === 'd-cc' ? 'active' : ''}`}
              onClick={() => handleModeChange('d-cc')}
            >D-CC</button>
            <button
              className={`mode-btn ${mode === 'd-cp' ? 'active' : ''}`}
              onClick={() => handleModeChange('d-cp')}
            >D-CP</button>
            <button
              className={`mode-btn ${mode === 'c-cv' ? 'active' : ''}`}
              onClick={() => handleModeChange('c-cv')}
            >C-CV</button>
            {sequences.length > 0 && (
              <button
                className={`mode-btn ${mode === 'sequence' ? 'active' : ''}`}
                onClick={() => handleModeChange('sequence')}
              >Sequence</button>
            )}
          </div>
        </div>

        {/* Sequence selector (when mode = sequence) */}
        {mode === 'sequence' && (
          <div className="form-group">
            <label>Sequence</label>
            <select
              value={selectedSequenceId ?? ''}
              onChange={e => setSelectedSequenceId(Number(e.target.value))}
              className="sequence-select"
            >
              {sequences.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            {selectedSequence && (
              <span className="form-hint">
                {JSON.parse(selectedSequence.steps_json).length} steps
              </span>
            )}
          </div>
        )}

        {/* Parameters (single-mode only) */}
        {mode !== 'sequence' && (
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
                  step={useCRate ? 0.01 : 0.01}
                  min={0}
                  max={useCRate ? 1 : 40}
                />
                {useCRate && (
                  <span className="form-hint">{(currentA * capacityAh).toFixed(2)} A</span>
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
                  max={350}
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
                  max={5.0}
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
                  max={5.0}
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
                  max={40}
                />
              </div>
            )}
          </div>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn btn-cancel" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="btn btn-start" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Starting...' : mode === 'sequence' ? 'Run Sequence' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
