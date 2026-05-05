/**
 * Capacity tracking with high-capacity encoding correction.
 *
 * The EBC-A40L changes its capacity encoding at ~10 Ah:
 * - Below ~10 Ah: bytes 5-6 are base-240 encoded mAh (1 mAh/unit)
 * - Above ~10 Ah: the hi byte gets +99 added and each unit = 10 mAh
 *
 * This class detects the transition and returns corrected mAh values.
 */

/** Jump threshold (mAh) to detect the +99 hi-byte encoding transition */
const HIGH_CAP_JUMP = 20_000;

export interface CapacityState {
  highCapMode: boolean;
  transitionRaw: number;
  transitionTrue: number;
}

export class CapacityTracker {
  private prevRawCapMah = 0;
  private _highCapMode = false;
  private transitionRaw = 0;
  private transitionTrue = 0;
  private _correctedMah = 0;

  /** Current corrected capacity in mAh */
  get capacityMah(): number { return this._correctedMah; }
  /** Whether we're in the post-10Ah high-capacity encoding mode */
  get highCapMode(): boolean { return this._highCapMode; }

  /**
   * Update with a new raw decoded capacity value (from base-240 decode of bytes 5-6).
   * @param rawCapMah  The raw decoded capacity (no correction applied)
   * @param isRunning  Whether the device is in a running test state
   * @returns The corrected capacity in mAh
   */
  update(rawCapMah: number, isRunning: boolean): number {
    if (isRunning && !this._highCapMode &&
        rawCapMah > this.prevRawCapMah + HIGH_CAP_JUMP) {
      this._highCapMode = true;
      this.transitionRaw = rawCapMah;
      this.transitionTrue = this.prevRawCapMah;
    }

    this.prevRawCapMah = rawCapMah;

    if (this._highCapMode) {
      this._correctedMah = this.transitionTrue +
        (rawCapMah - this.transitionRaw) * 10;
    } else {
      this._correctedMah = rawCapMah;
    }

    return this._correctedMah;
  }

  /** Reset for a new test */
  reset(): void {
    this.prevRawCapMah = 0;
    this._highCapMode = false;
    this.transitionRaw = 0;
    this.transitionTrue = 0;
    this._correctedMah = 0;
  }

  /** Get serializable state for recovery persistence */
  getState(): CapacityState {
    return {
      highCapMode: this._highCapMode,
      transitionRaw: this.transitionRaw,
      transitionTrue: this.transitionTrue,
    };
  }

  /**
   * Restore from recovery state.
   * @param state  Saved state from a previous session
   * @param currentRawCapMah  The current raw device reading
   */
  restore(state: CapacityState, currentRawCapMah: number): void {
    this._highCapMode = state.highCapMode;
    this.transitionRaw = state.transitionRaw;
    this.transitionTrue = state.transitionTrue;
    this.prevRawCapMah = currentRawCapMah;

    // Compute initial corrected value
    if (this._highCapMode) {
      this._correctedMah = this.transitionTrue +
        (currentRawCapMah - this.transitionRaw) * 10;
    } else {
      this._correctedMah = currentRawCapMah;
    }
  }
}
