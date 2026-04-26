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
  /** When true, currentA stores C-rate (e.g. 0.2 = 0.2C). Actual amps = currentA * capacityAh */
  useCRate?: boolean;
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
  /** When true, currentA stores C-rate (e.g. 0.2 = 0.2C). Actual amps = currentA * capacityAh */
  useCRate?: boolean;
}

export interface StepWait {
  type: 'wait';
  durationS: number;
}

export interface StepLoop {
  type: 'loop';
  count: number;
  /** Steps contained within this loop */
  children: SequenceStep[];
}

export type SequenceStep = StepDCC | StepDCP | StepCCV | StepWait | StepLoop;

/** A step that actually runs on the device (not a loop) */
export type ExecutableStep = StepDCC | StepDCP | StepCCV | StepWait;

// ── Path-based addressing ─────────────────────────────────────────

/** Path to a step in the tree: [2] = top-level index 2, [1, 0] = first child of loop at index 1 */
export type StepPath = number[];

/** Get a step by path */
export function getStepAtPath(steps: SequenceStep[], path: StepPath): SequenceStep | undefined {
  if (path.length === 0) return undefined;
  const step = steps[path[0]];
  if (path.length === 1) return step;
  if (step?.type === 'loop') return getStepAtPath(step.children, path.slice(1));
  return undefined;
}

/** Update a step at a path, returning a new array */
export function updateStepAtPath(steps: SequenceStep[], path: StepPath, updated: SequenceStep): SequenceStep[] {
  if (path.length === 0) return steps;
  const idx = path[0];
  if (path.length === 1) {
    return steps.map((s, i) => i === idx ? updated : s);
  }
  return steps.map((s, i) => {
    if (i !== idx || s.type !== 'loop') return s;
    return { ...s, children: updateStepAtPath(s.children, path.slice(1), updated) };
  });
}

/** Remove a step at a path, returning a new array */
export function removeStepAtPath(steps: SequenceStep[], path: StepPath): SequenceStep[] {
  if (path.length === 0) return steps;
  const idx = path[0];
  if (path.length === 1) {
    return steps.filter((_, i) => i !== idx);
  }
  return steps.map((s, i) => {
    if (i !== idx || s.type !== 'loop') return s;
    return { ...s, children: removeStepAtPath(s.children, path.slice(1)) };
  });
}

/** Insert a step at a path (before the element at that path), returning a new array */
export function insertStepAtPath(steps: SequenceStep[], path: StepPath, newStep: SequenceStep): SequenceStep[] {
  if (path.length === 0) return steps;
  const idx = path[0];
  if (path.length === 1) {
    const result = [...steps];
    result.splice(idx, 0, newStep);
    return result;
  }
  return steps.map((s, i) => {
    if (i !== idx || s.type !== 'loop') return s;
    return { ...s, children: insertStepAtPath(s.children, path.slice(1), newStep) };
  });
}

/** Move a step from one path to another */
export function moveStep(steps: SequenceStep[], fromPath: StepPath, toPath: StepPath): SequenceStep[] {
  const step = getStepAtPath(steps, fromPath);
  if (!step) return steps;
  // Remove first, then adjust toPath if needed
  let result = removeStepAtPath(steps, fromPath);

  // Adjust toPath after removal: if the removal was before the insertion point
  // at the same level, shift the insertion index down by 1
  const adjustedTo = [...toPath];
  if (fromPath.length === toPath.length) {
    const sameParent = fromPath.length === 1 ||
      fromPath.slice(0, -1).every((v, i) => v === toPath[i]);
    if (sameParent) {
      const fromIdx = fromPath[fromPath.length - 1];
      const toIdx = toPath[toPath.length - 1];
      if (fromIdx < toIdx) {
        adjustedTo[adjustedTo.length - 1] = toIdx - 1;
      }
    }
  }

  result = insertStepAtPath(result, adjustedTo, step);
  return result;
}

// ── V1 migration ──────────────────────────────────────────────────

interface V1Loop { type: 'loop'; count: number; startIndex: number; endIndex: number; }

function isV1Loop(step: any): step is V1Loop {
  return step?.type === 'loop' && 'startIndex' in step && !('children' in step);
}

/** Migrate V1 flat-index loops to V2 nested children */
export function migrateV1Steps(steps: any[]): SequenceStep[] {
  // Check if any step uses the old format
  const hasV1Loops = steps.some(isV1Loop);
  if (!hasV1Loops) return steps as SequenceStep[];

  // Separate executable steps from loop steps
  const execSteps: SequenceStep[] = [];
  const loops: V1Loop[] = [];

  for (const step of steps) {
    if (isV1Loop(step)) {
      loops.push(step);
    } else {
      execSteps.push(step as SequenceStep);
    }
  }

  if (loops.length === 0) return execSteps;

  // Handle the common single-loop case
  const loop = loops[0];
  const before = execSteps.slice(0, loop.startIndex);
  const inside = execSteps.slice(loop.startIndex, loop.endIndex + 1);
  const after = execSteps.slice(loop.endIndex + 1);

  return [
    ...before,
    { type: 'loop', count: loop.count, children: inside },
    ...after,
  ];
}

// ── LiFePO4 simulation parameters ──────────────────────────────────

const LFP_NOMINAL_V = 3.20;
const LFP_FULL_V = 3.35;     // OCV at ~100% SOC
const LFP_EMPTY_V = 2.80;    // OCV at ~10% SOC
const LFP_SETTLE_DELTA = 0.05; // OCV recovery during rest

// ── Resolve current ───────────────────────────────────────────────

/** Resolve a step's currentA to actual amps, handling C-rate if needed */
export function resolveCurrentA(step: StepDCC | StepCCV, capacityAh: number): number {
  return step.useCRate ? step.currentA * capacityAh : step.currentA;
}

// ── Duration estimation ────────────────────────────────────────────

/**
 * Estimate step duration in hours.
 * Uses cell capacity (Ah) for rough calculation.
 */
export function estimateDurationH(step: SequenceStep, capacityAh: number): number {
  switch (step.type) {
    case 'd-cc': {
      const amps = resolveCurrentA(step, capacityAh);
      return amps > 0 ? (capacityAh / amps) * 0.95 : 0;
    }
    case 'd-cp':
      return step.powerW > 0 ? (capacityAh * LFP_NOMINAL_V / step.powerW) * 0.95 : 0;
    case 'c-cv': {
      const amps = resolveCurrentA(step, capacityAh);
      return amps > 0 ? (capacityAh / amps) * 1.3 : 0;
    }
    case 'wait':
      return step.durationS / 3600;
    case 'loop':
      // Loop duration = children duration * count
      return step.children.reduce((sum, child) => sum + estimateDurationH(child, capacityAh), 0) * step.count;
  }
}

/**
 * Total estimated duration for a sequence.
 */
export function totalEstimatedDurationH(steps: SequenceStep[], capacityAh: number): number {
  return steps.reduce((sum, step) => sum + estimateDurationH(step, capacityAh), 0);
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
  capacityAh: number = 200,
): SimPoint[] {
  const pts: SimPoint[] = [];

  for (let n = 0; n < numPoints; n++) {
    const f = n / (numPoints - 1);
    let v: number;
    let current: number;

    switch (step.type) {
      case 'd-cc': {
        current = resolveCurrentA(step, capacityAh);
        if (f < 0.05) {
          v = startV - (startV - (startV - 0.04)) * (f / 0.05);
        } else if (f < 0.85) {
          v = (startV - 0.04) - 0.04 * ((f - 0.05) / 0.8);
        } else {
          const flatEndV = startV - 0.08;
          v = flatEndV - (flatEndV - step.cutoffV) * Math.pow((f - 0.85) / 0.15, 2);
        }
        break;
      }

      case 'd-cp': {
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
        const ccFraction = 0.6;
        const maxCurrent = resolveCurrentA(step, capacityAh);
        if (f < ccFraction) {
          const ccProgress = f / ccFraction;
          v = startV + (step.targetV - 0.15 - startV) * ccProgress;
          current = maxCurrent;
        } else {
          const cvProgress = (f - ccFraction) / (1 - ccFraction);
          v = (step.targetV - 0.15) + 0.15 * (1 - Math.exp(-4 * cvProgress));
          current = maxCurrent * Math.exp(-3 * cvProgress);
          current = Math.max(current, step.cutoffCurrentA);
        }
        break;
      }

      case 'wait': {
        const restV = startV > LFP_NOMINAL_V
          ? startV - LFP_SETTLE_DELTA
          : startV + LFP_SETTLE_DELTA;
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

/**
 * Flatten a step tree into a list of executable steps (for timeline rendering).
 * Loops are expanded once (not repeated) — the timeline shows one iteration.
 */
export function flattenForTimeline(steps: SequenceStep[]): { step: ExecutableStep; path: StepPath }[] {
  const result: { step: ExecutableStep; path: StepPath }[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === 'loop') {
      for (let j = 0; j < s.children.length; j++) {
        const child = s.children[j];
        if (child.type !== 'loop') {
          result.push({ step: child, path: [i, j] });
        }
      }
    } else {
      result.push({ step: s, path: [i] });
    }
  }
  return result;
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

export function defaultLoop(): StepLoop {
  return { type: 'loop', count: 3, children: [] };
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
      {
        type: 'loop',
        count: 3,
        children: [
          { type: 'c-cv', currentA: 40, targetV: 3.65, cutoffCurrentA: 2.0, maxTimeMin: 600 },
          { type: 'wait', durationS: 1800 },
          { type: 'd-cc', currentA: 40, cutoffV: 2.50, maxTimeMin: 600 },
          { type: 'wait', durationS: 1800 },
        ],
      },
    ],
  },
];
