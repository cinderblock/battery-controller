/**
 * CellPresenceTracker — "is there a cell connected that nobody has identified?"
 *
 * Drives the scan prompt in the web UI. The prompt has to be server state
 * rather than a client-side heuristic: every browser receives the same SSE
 * stream, so a client watching for a voltage edge has no way to know whether
 * another browser already dealt with it. Holding the state here means a late-
 * joining browser sees the same answer as one that was open the whole time,
 * and a claim from any browser clears the prompt on all of them.
 *
 * Presence is read from the idle voltage: the EBC-A40L reads ~0 V with nothing
 * connected and cell voltage with a cell on the clips.
 */

import { logger } from '../utils/logger.ts';

// ── Types ──────────────────────────────────────────────────────────

export interface CellPresenceState {
  /** Monotonic id for the current insertion. 0 before any cell is seen. */
  insertionId: number;
  /** Whether a cell is currently connected */
  present: boolean;
  /** Serial claimed for this insertion, if one was given */
  barcode: string | null;
  /** True once this insertion has been identified, or a run was started on it */
  claimed: boolean;
}

type PresenceListener = (state: CellPresenceState) => void;

// ── Thresholds ─────────────────────────────────────────────────────

/** Above this, a cell is definitely connected */
const PRESENT_ABOVE_V = 2.0;
/** Below this, the clips are definitely empty */
const ABSENT_BELOW_V = 1.5;

// ── Tracker ────────────────────────────────────────────────────────

export class CellPresenceTracker {
  private listeners = new Set<PresenceListener>();

  private insertionId = 0;
  private present = false;
  private barcode: string | null = null;
  private claimed = false;

  /**
   * Whether we've seen any reading yet. The first one is adopted rather than
   * treated as an insertion — see update().
   */
  private seenFirstReading = false;

  // ── Subscription ─────────────────────────────────────────────────

  on(listener: PresenceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (e) {
        logger.error('Cell presence listener failed:', e);
      }
    }
  }

  getState(): CellPresenceState {
    return {
      insertionId: this.insertionId,
      present: this.present,
      barcode: this.barcode,
      claimed: this.claimed,
    };
  }

  // ── Feed ─────────────────────────────────────────────────────────

  /**
   * Feed a voltage reading. Hysteresis between the two thresholds keeps a cell
   * resting near the boundary from flapping the prompt on and off.
   */
  update(voltageV: number): void {
    const wasPresent = this.present;

    if (voltageV > PRESENT_ABOVE_V) this.present = true;
    else if (voltageV < ABSENT_BELOW_V) this.present = false;

    // The first reading after startup tells us nothing about *when* the cell
    // arrived. Adopt it as already-claimed instead of announcing an insertion:
    // the frontend reloads every browser when the server build id changes, so
    // treating a restart as an insertion would pop the scan modal in every open
    // tab on each deploy — the very fan-out this feature exists to avoid.
    if (!this.seenFirstReading) {
      this.seenFirstReading = true;
      if (this.present) {
        this.insertionId++;
        this.claimed = true;
        logger.info('Cell present at startup — adopting as already identified (no scan prompt)');
        this.emit();
      }
      return;
    }

    if (this.present === wasPresent) return;

    if (this.present) {
      this.insertionId++;
      this.barcode = null;
      this.claimed = false;
      logger.info(
        `Cell connected (${voltageV.toFixed(2)} V) — insertion #${this.insertionId}, awaiting identification`
      );
    } else {
      this.barcode = null;
      this.claimed = false;
      logger.info('Cell disconnected');
    }

    this.emit();
  }

  // ── Claim ────────────────────────────────────────────────────────

  /**
   * Mark the current insertion as identified, clearing the prompt everywhere.
   * `barcode` is null when a run was started without one ("Skip — no barcode"):
   * the cell is in use either way, so the prompt has served its purpose.
   *
   * Returns true if this changed anything.
   */
  claim(barcode: string | null): boolean {
    // Nothing connected — a claim would be recorded against an insertion that
    // is about to be superseded, so it would be wrong to keep it.
    if (!this.present) return false;
    if (this.claimed && this.barcode === (barcode ?? this.barcode)) return false;

    this.claimed = true;
    if (barcode) this.barcode = barcode;
    logger.info(`Cell insertion #${this.insertionId} identified${barcode ? ` as ${barcode}` : ' (no barcode)'}`);
    this.emit();
    return true;
  }
}
