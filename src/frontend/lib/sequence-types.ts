/**
 * Sequence step types and voltage simulation model.
 *
 * Used by both the visual timeline renderer and the server cycle runner.
 * The simulation produces approximate voltage curves for LiFePO4 cells
 * to give the user a visual preview of what will happen.
 */

// ── Step definitions ───────────────────────────────────────────────

export interface StepDCC {
  type: 'd-cc';
  currentA: number;
  cutoffV: number;
  maxTimeMin?: number;
}

export interface StepDCP {
  type: 'd-cp';
  powerW: number;
  cutoffV: number;
  maxTimeMin?: number;
}

export interface StepCCV {
  type: 'c-cv';
  currentA: number;
  targetV: number;
  cutoffCurrentA: number;
  maxTimeMin?: number;
}

export interface StepWait {
  type: 'wait';
  durationS: number;
}

export interface StepLoop {
  type: 'loop';
  count: number;
  /** Indices of steps this loop wraps (inclusive range in the parent step list) */
  startIndex: number;
  endIndex: number;
}

export type SequenceStep = StepDCC | StepDCP | StepCCV | StepWait | StepLoop;

/** A step that actually runs on the device (not a loop) */
export type ExecutableStep = StepDCC | StepDCP | StepCCV | StepWait;

// ── LiFePO4 simulation parameters ──────────────────────────────────

const LFP_NOMINAL_V = 3.20;
const LFP_FULL_V = 3.35;     // OCV at ~100% SOC
const LFP_EMPTY_V = 2.80;    // OCV at ~10% SOC
const LFP_SETTLE_DELTA = 0.05; // OCV recovery during rest

// ── Duration estimation ────────────────────────────────────────────

/**
 * Estimate step duration in hours.
 * Uses cell capacity (Ah) for rough calculation.
 */
export function estimateDurationH(step: SequenceStep, capacityAh: number): number {
  switch (step.type) {
    case 'd-cc':
      // Time = capacity / current (rough; actual depends on cutoff)
      return step.currentA > 0 ? (capacityAh / step.currentA) * 0.95 : 0;
    case 'd-cp':
      // Time = (capacity * nominal_voltage) / power
      return step.powerW > 0 ? (capacityAh * LFP_NOMINAL_V / step.powerW) * 0.95 : 0;
    case 'c-cv':
      // CC phase + CV taper. Rough: 1.3× CC time to account for taper.
      return step.currentA > 0 ? (capacityAh / step.currentA) * 1.3 : 0;
    case 'wait':
      return step.durationS / 3600;
    case 'loop':
      return 0; // Loops don't have their own duration — they wrap other steps
  }
}

/**
 * Total estimated duration for a sequence including loops.
 */
export function totalEstimatedDurationH(steps: SequenceStep[], capacityAh: number): number {
  // First pass: compute base step durations (excluding loop steps themselves)
  const baseDurations = steps.map(s => s.type === 'loop' ? 0 : estimateDurationH(s, capacityAh));

  // Second pass: apply loop multipliers
  let total = 0;
  const multipliers = new Array<number>(steps.length).fill(1);

  // For each loop step, multiply the covered steps
  for (const step of steps) {
    if (step.type === 'loop') {
      for (let i = step.startIndex; i <= step.endIndex && i < steps.length; i++) {
        multipliers[i] *= step.count;
      }
    }
  }

  for (let i = 0; i < steps.length; i++) {
    total += baseDurations[i] * multipliers[i];
  }

  return total;
}

// ── Voltage simulation ─────────────────────────────────────────────

export interface SimPoint {
  /** Fraction through the step (0–1) */
  f: number;
  /** Simulated voltage */
  v: number;
  /** Simulated current (positive for both charge and discharge for display) */
  i: number;
}

/**
 * Simulate a voltage curve for a step.
 * Returns `numPoints` samples across the step's duration.
 * The startV parameter is the voltage at the beginning of this step
 * (end voltage of the previous step, or OCV).
 */
export function simulateStep(
  step: ExecutableStep,
  startV: number,
  numPoints: number,
): SimPoint[] {
  const pts: SimPoint[] = [];

  for (let n = 0; n < numPoints; n++) {
    const f = n / (numPoints - 1);
    let v: number;
    let current: number;

    switch (step.type) {
      case 'd-cc': {
        current = step.currentA;
        // LiFePO4 discharge curve: flat middle with steep ends
        if (f < 0.05) {
          // Initial voltage drop (activation polarization)
          v = startV - (startV - (startV - 0.04)) * (f / 0.05);
        } else if (f < 0.85) {
          // Flat plateau (ohmic region)
          v = (startV - 0.04) - 0.04 * ((f - 0.05) / 0.8);
        } else {
          // Steep tail (concentration polarization)
          const flatEndV = startV - 0.08;
          v = flatEndV - (flatEndV - step.cutoffV) * Math.pow((f - 0.85) / 0.15, 2);
        }
        break;
      }

      case 'd-cp': {
        // Constant power: current increases as voltage drops
        const midV = (startV + step.cutoffV) / 2;
        // Voltage curve similar to D-CC but slightly faster tail
        if (f < 0.05) {
          v = startV - 0.04 * (f / 0.05);
        } else if (f < 0.80) {
          v = (startV - 0.04) - 0.06 * ((f - 0.05) / 0.75);
        } else {
          const flatEndV = startV - 0.10;
          v = flatEndV - (flatEndV - step.cutoffV) * Math.pow((f - 0.80) / 0.20, 1.8);
        }
        current = v > 0.1 ? step.powerW / v : 0;
        break;
      }

      case 'c-cv': {
        // CC phase: voltage rises linearly(ish)
        // CV phase: voltage at target, current tapers
        const ccFraction = 0.6; // ~60% of time in CC mode
        if (f < ccFraction) {
          // CC phase
          const ccProgress = f / ccFraction;
          v = startV + (step.targetV - 0.15 - startV) * ccProgress;
          current = step.currentA;
        } else {
          // CV phase — voltage settles to target, current drops
          const cvProgress = (f - ccFraction) / (1 - ccFraction);
          v = (step.targetV - 0.15) + 0.15 * (1 - Math.exp(-4 * cvProgress));
          current = step.currentA * Math.exp(-3 * cvProgress);
          current = Math.max(current, step.cutoffCurrentA);
        }
        break;
      }

      case 'wait': {
        // OCV recovery: exponential approach to resting voltage
        const restV = startV > LFP_NOMINAL_V
          ? startV - LFP_SETTLE_DELTA  // After charge: settles down
          : startV + LFP_SETTLE_DELTA; // After discharge: settles up
        v = startV + (restV - startV) * (1 - Math.exp(-3 * f));
        current = 0;
        break;
      }
    }

    pts.push({ f, v, i: current });
  }

  return pts;
}

/**
 * Get the end voltage of a simulated step.
 */
export function stepEndVoltage(step: ExecutableStep, startV: number): number {
  switch (step.type) {
    case 'd-cc': return step.cutoffV;
    case 'd-cp': return step.cutoffV;
    case 'c-cv': return step.targetV;
    case 'wait':
      return startV > LFP_NOMINAL_V
        ? startV - LFP_SETTLE_DELTA
        : startV + LFP_SETTLE_DELTA;
  }
}

// ── Defaults ───────────────────────────────────────────────────────

export function defaultDCC(): StepDCC {
  return { type: 'd-cc', currentA: 40, cutoffV: 2.50, maxTimeMin: 600 };
}

export function defaultDCP(): StepDCP {
  return { type: 'd-cp', powerW: 100, cutoffV: 2.50, maxTimeMin: 600 };
}

export function defaultCCV(): StepCCV {
  return { type: 'c-cv', currentA: 40, targetV: 3.65, cutoffCurrentA: 2.0, maxTimeMin: 600 };
}

export function defaultWait(): StepWait {
  return { type: 'wait', durationS: 1800 }; // 30 min
}

// ── Presets ─────────────────────────────────────────────────────────

export interface SequencePreset {
  name: string;
  steps: SequenceStep[];
}

export const PRESETS: SequencePreset[] = [
  {
    name: 'Standard Capacity Test',
    steps: [
      { type: 'c-cv', currentA: 40, targetV: 3.65, cutoffCurrentA: 2.0, maxTimeMin: 600 },
      { type: 'wait', durationS: 1800 },
      { type: 'd-cc', currentA: 40, cutoffV: 2.50, maxTimeMin: 600 },
    ],
  },
  {
    name: 'Quick Check',
    steps: [
      { type: 'd-cc', currentA: 20, cutoffV: 2.80, maxTimeMin: 720 },
    ],
  },
  {
    name: 'Gentle Cycle',
    steps: [
      { type: 'c-cv', currentA: 20, targetV: 3.65, cutoffCurrentA: 2.0, maxTimeMin: 720 },
      { type: 'wait', durationS: 1800 },
      { type: 'd-cc', currentA: 20, cutoffV: 2.80, maxTimeMin: 720 },
      { type: 'wait', durationS: 1800 },
    ],
  },
  {
    name: 'Full Characterization',
    steps: [
      { type: 'c-cv', currentA: 40, targetV: 3.65, cutoffCurrentA: 2.0, maxTimeMin: 600 },
      { type: 'wait', durationS: 1800 },
      { type: 'd-cc', currentA: 40, cutoffV: 2.50, maxTimeMin: 600 },
      { type: 'wait', durationS: 1800 },
      { type: 'loop', count: 3, startIndex: 0, endIndex: 3 },
    ],
  },
];
