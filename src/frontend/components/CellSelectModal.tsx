/**
 * CellSelectModal — pick which cells' runs are plotted, and manage cells.
 *
 * Lists every cell from the database (not just those with recently loaded
 * runs, so a cell last tested a month ago still appears). Unchecking a cell
 * hides its runs; checking a cell whose runs aren't loaded yet asks the
 * parent to fetch them. Cells can be deleted with a two-step confirm; a
 * cell with recorded runs requires an explicit second confirmation that
 * also deletes its runs.
 */

import { useState } from 'react';
import type { Cell } from '../api-client.ts';

interface CellSelectModalProps {
  open: boolean;
  onClose: () => void;
  cells: Cell[];
  /** Currently loaded run count per cell id (-1 = runs with no cell) */
  loadedRunCounts: Map<number, number>;
  hiddenCellIds: Set<number>;
  /** Toggle a cell's visibility; parent loads runs when showing an unloaded cell */
  onToggleCell: (cellId: number) => void;
  /** Explicitly load a visible cell's runs (older than the recent window) */
  onLoadCell: (cellId: number) => void;
  /** Cell id whose runs are currently being fetched (spinner) */
  loadingCellId: number | null;
  /** Called after a cell was deleted server-side */
  onCellDeleted: (cellId: number) => void;
}

/** Show sub-mΩ readings with enough digits to stay meaningful (healthy cells are <1 mΩ) */
function formatIr(mohm: number): string {
  return `${mohm < 10 ? mohm.toFixed(1) : Math.round(mohm)} mΩ`;
}

interface DeleteState {
  cellId: number;
  /** 'confirm' = first tap; 'force' = cell has runs, confirm deleting those too */
  stage: 'confirm' | 'force';
  runCount?: number;
  busy?: boolean;
  error?: string;
}

export function CellSelectModal({
  open,
  onClose,
  cells,
  loadedRunCounts,
  hiddenCellIds,
  onToggleCell,
  onLoadCell,
  loadingCellId,
  onCellDeleted,
}: CellSelectModalProps) {
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);

  if (!open) return null;

  async function doDelete(cellId: number, force: boolean) {
    setDeleteState(s => (s && s.cellId === cellId ? { ...s, busy: true, error: undefined } : s));
    try {
      const res = await fetch(`/api/cells/${cellId}${force ? '?force=1' : ''}`, { method: 'DELETE' });
      if (res.status === 409) {
        const body = (await res.json()) as { runCount?: number };
        setDeleteState({ cellId, stage: 'force', runCount: body.runCount ?? 0 });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setDeleteState({ cellId, stage: 'confirm', error: body.error ?? `HTTP ${res.status}` });
        return;
      }
      setDeleteState(null);
      onCellDeleted(cellId);
    } catch (err) {
      setDeleteState({ cellId, stage: 'confirm', error: err instanceof Error ? err.message : 'Delete failed' });
    }
  }

  const noCellCount = loadedRunCounts.get(-1) ?? 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content cell-select-modal" onClick={e => e.stopPropagation()}>
        <h2>Cells</h2>

        <div className="cell-select-list">
          {cells.map(cell => {
            const visible = !hiddenCellIds.has(cell.id);
            const loaded = loadedRunCounts.get(cell.id) ?? 0;
            const del = deleteState?.cellId === cell.id ? deleteState : null;
            const name = cell.label || cell.barcode;

            return (
              <div key={cell.id} className="cell-select-row">
                <label className="cell-select-main">
                  <input type="checkbox" checked={visible} onChange={() => onToggleCell(cell.id)} />
                  <span className="cell-select-name">{name}</span>
                  {cell.latest_ir_mohm != null && (
                    <span className="cell-select-ir">{formatIr(cell.latest_ir_mohm)}</span>
                  )}
                  <span className="cell-select-detail">
                    {loadingCellId === cell.id
                      ? 'loading runs…'
                      : loaded > 0
                        ? `${loaded} run${loaded === 1 ? '' : 's'} loaded`
                        : 'no runs loaded'}
                  </span>
                </label>
                {loaded === 0 && loadingCellId !== cell.id && !del && (
                  <button className="btn-cell-load" onClick={() => onLoadCell(cell.id)}>
                    Load runs
                  </button>
                )}

                {del ? (
                  <span className="cell-delete-confirm">
                    {del.error ? (
                      <span className="cell-delete-error">{del.error}</span>
                    ) : del.stage === 'force' ? (
                      <span>Has {del.runCount} run(s) — delete them too?</span>
                    ) : (
                      <span>Delete “{name}”?</span>
                    )}
                    <button
                      className="btn-cell-delete-yes"
                      disabled={del.busy}
                      onClick={() => doDelete(cell.id, del.stage === 'force')}
                    >
                      {del.busy ? '…' : del.stage === 'force' ? 'Delete all' : 'Delete'}
                    </button>
                    <button disabled={del.busy} onClick={() => setDeleteState(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn-cell-delete"
                    onClick={() => setDeleteState({ cellId: cell.id, stage: 'confirm' })}
                  >
                    ✕
                  </button>
                )}
              </div>
            );
          })}

          {noCellCount > 0 && (
            <div className="cell-select-row">
              <label className="cell-select-main">
                <input type="checkbox" checked={!hiddenCellIds.has(-1)} onChange={() => onToggleCell(-1)} />
                <span className="cell-select-name">No cell</span>
                <span className="cell-select-detail">
                  {noCellCount} run{noCellCount === 1 ? '' : 's'} loaded
                </span>
              </label>
            </div>
          )}

          {cells.length === 0 && <div className="cell-select-empty">No cells recorded yet</div>}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
