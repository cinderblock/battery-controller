/**
 * Sequence step types and voltage simulation model.
 *
 * Used by both the visual timeline renderer and the server cycle runner.
 * The simulation produces approximate voltage curves for LiFePO4 cells
 * to give the user a visual preview of what will happen.
 */

import type { FieldBindings, SequenceVariable } from '../../shared/sequence-vars.ts';

export {
  BINDABLE_FIELDS,
  FIELD_UNIT,
  type FieldBindings,
  parseSequenceDoc,
  resolveSteps,
  type SequenceDoc,
  type SequenceVariable,
  serializeSequenceDoc,
  toSequenceDoc,
  VARIABLE_UNITS,
  type VariableUnit,
  variableMatchesField,
} from '../../shared/sequence-vars.ts';

// ── Step definitions ───────────────────────────────────────────────

/** Periodic in-run IR probe: dip the current to lowA for holdS every periodS (see server cycle-runner) */
export interface IrProbeConfig {
  /** Seconds between probes */
  periodS: number;
  /** Reduced current during the dip (A) — non-zero keeps the cell loaded */
  lowA: number;
  /** How long to hold the reduced current (s) */
  holdS: number;
}

/** Default probe when toggled on: 10 min period, dip to 10 A for 8 s */
export function defaultProbe(): IrProbeConfig {
  return { periodS: 600, lowA: 10, holdS: 8 };
}

export interface StepDCC {
  type: 'd-cc';
  currentA: number;
  cutoffV: number;
  maxTimeMin?: number;
  /** When true, currentA stores C-rate (e.g. 0.2 = 0.2C). Actual amps = currentA * capacityAh */
  useCRate?: boolean;
  /** When true, this step's measurements are excluded from cycle results (setup/teardown step) */
  excludeFromCount?: boolean;
  /** Fields bound to sequence variables (field name → variable key) */
  bind?: FieldBindings;
  /** Retry at half current (down to minA) when the cutoff trips instantly (IR sag) */
  backoff?: { minA: number };
  /** Periodic IR probe — measures internal resistance repeatedly during the discharge */
  probe?: IrProbeConfig;
}

export interface StepDCP {
  type: 'd-cp';
  powerW: number;
  cutoffV: number;
  maxTimeMin?: number;
  /** When true, this step's measurements are excluded from cycle results (setup/teardown step) */
  excludeFromCount?: boolean;
  /** Fields bound to sequence variables (field name → variable key) */
  bind?: FieldBindings;
}

export interface StepCCV {
  type: 'c-cv';
  currentA: number;
  targetV: number;
  cutoffCurrentA: number;
  maxTimeMin?: number;
  /** When true, currentA stores C-rate (e.g. 0.2 = 0.2C). Actual amps = currentA * capacityAh */
  useCRate?: boolean;
  /** When true, this step's measurements are excluded from cycle results (setup/teardown step) */
  excludeFromCount?: boolean;
  /** Fields bound to sequence variables (field name → variable key) */
  bind?: FieldBindings;
}

export interface StepWait {
  type: 'wait';
  durationS: number;
  /** When true, this step's measurements are excluded from cycle results (setup/teardown step) */
  excludeFromCount?: boolean;
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

// ── Duration parsing / formatting ────────────────────────────────

/** Parse a human-readable duration string into minutes.
 *  Accepts: "480" (plain number = minutes), "8h", "30m", "8h3m", "8h 30m", "8h 30" */
export function parseDurationInput(input: string): number | null {
  const s = input.trim();
  if (!s) return null;

  // Plain number → minutes
  if (/^\d+(\.\d+)?$/.test(s)) {
    const v = parseFloat(s);
    return isNaN(v) ? null : v;
  }

  // h/m pattern: optional hours, optional minutes (m suffix optional after h component)
  const match = s.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m?)?$/i);
  if (!match || (!match[1] && !match[2])) return null;

  const hours = match[1] ? parseFloat(match[1]) : 0;
  const minutes = match[2] ? parseFloat(match[2]) : 0;
  const total = hours * 60 + minutes;
  return isNaN(total) ? null : total;
}

/** Format minutes as a human-readable duration string for display and editing.
 *  Returns "" for 0/falsy, "30m" for < 60, "8h" or "8h 3m" for larger values. */
export function formatMinutes(minutes: number): string {
  if (!minutes || minutes <= 0) return '';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

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
    return steps.map((s, i) => (i === idx ? updated : s));
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
    const sameParent = fromPath.length === 1 || fromPath.slice(0, -1).every((v, i) => v === toPath[i]);
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

interface V1Loop {
  type: 'loop';
  count: number;
  startIndex: number;
  endIndex: number;
}

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

  return [...before, { type: 'loop', count: loop.count, children: inside }, ...after];
}

// ── LiFePO4 simulation parameters ──────────────────────────────────

const LFP_NOMINAL_V = 3.2;
const LFP_FULL_V = 3.35; // OCV at ~100% SOC
const LFP_EMPTY_V = 2.8; // OCV at ~10% SOC
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
      return step.powerW > 0 ? ((capacityAh * LFP_NOMINAL_V) / step.powerW) * 0.95 : 0;
    case 'c-cv': {
      // CC phase: bulk charge at constant current
      const amps = resolveCurrentA(step, capacityAh);
      if (amps <= 0) return 0;
      const ccHours = (capacityAh / amps) * 0.8; // CC fills ~80% of capacity
      // CV phase: current tapers exponentially from amps to cutoffCurrentA.
      // Model as exponential decay with time constant tau.
      // Duration ≈ tau * ln(amps / cutoff), tau ≈ capacityAh / amps.
      const cutoff = Math.max(step.cutoffCurrentA, 0.01);
      const tau = (capacityAh / amps) * 0.3; // empirical time constant
      const cvHours = tau * Math.log(amps / cutoff);
      return ccHours + Math.max(0, cvHours);
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
  capacityAh: number = 200
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
          v = startV - 0.04 - 0.04 * ((f - 0.05) / 0.8);
        } else {
          const flatEndV = startV - 0.08;
          v = flatEndV - (flatEndV - step.cutoffV) * ((f - 0.85) / 0.15) ** 2;
        }
        break;
      }

      case 'd-cp': {
        if (f < 0.05) {
          v = startV - 0.04 * (f / 0.05);
        } else if (f < 0.8) {
          v = startV - 0.04 - 0.06 * ((f - 0.05) / 0.75);
        } else {
          const flatEndV = startV - 0.1;
          v = flatEndV - (flatEndV - step.cutoffV) * ((f - 0.8) / 0.2) ** 1.8;
        }
        current = v > 0.1 ? step.powerW / v : 0;
        break;
      }

      case 'c-cv': {
        // CC-CV charge: CC phase raises voltage to target, CV phase holds
        // voltage flat while current tapers to cutoff.
        // Derive CC/CV split from the same model as estimateDurationH so
        // the visual curve matches the estimated time.
        const maxCurrent = resolveCurrentA(step, capacityAh);
        const cutoff = Math.max(step.cutoffCurrentA, 0.01);
        const ccTime = 0.8; // CC fills ~80% of capacity → relative time units
        const tau = 0.3; // CV time constant (same as estimateDurationH)
        const cvTime = tau * Math.log(maxCurrent / cutoff);
        const totalTime = ccTime + Math.max(0, cvTime);
        const ccFraction = ccTime / totalTime;

        if (f < ccFraction) {
          // CC phase: constant current, voltage rises to targetV.
          // Concave-up curve (x^1.3): voltage accelerates toward target and
          // has nonzero slope at the CC→CV boundary — no visual lag between
          // voltage flattening and current starting to drop.
          const ccProgress = f / ccFraction;
          v = startV + (step.targetV - startV) * ccProgress ** 1.3;
          current = maxCurrent;
        } else {
          // CV phase: voltage flat at targetV, current decays to cutoff
          v = step.targetV;
          const cvProgress = (f - ccFraction) / (1 - ccFraction);
          // Decay rate = ln(max/cutoff) so current reaches cutoff at cvProgress=1
          const decayRate = Math.log(maxCurrent / cutoff);
          current = maxCurrent * Math.exp(-decayRate * cvProgress);
          current = Math.max(current, step.cutoffCurrentA);
        }
        break;
      }

      case 'wait': {
        const restV = startV > LFP_NOMINAL_V ? startV - LFP_SETTLE_DELTA : startV + LFP_SETTLE_DELTA;
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
    case 'd-cc':
      return step.cutoffV;
    case 'd-cp':
      return step.cutoffV;
    case 'c-cv':
      return step.targetV;
    case 'wait':
      return startV > LFP_NOMINAL_V ? startV - LFP_SETTLE_DELTA : startV + LFP_SETTLE_DELTA;
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
  return { type: 'd-cc', currentA: 40, cutoffV: 2.5, maxTimeMin: 600, backoff: { minA: 10 } };
}

export function defaultDCP(): StepDCP {
  return { type: 'd-cp', powerW: 100, cutoffV: 2.5, maxTimeMin: 600 };
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
  variables?: SequenceVariable[];
}

export const PRESETS: SequencePreset[] = [
  {
    name: 'Standard Capacity Test',
    steps: [
      { type: 'c-cv', currentA: 40, targetV: 3.65, cutoffCurrentA: 2.0, maxTimeMin: 600 },
      { type: 'wait', durationS: 1800 },
      { type: 'd-cc', currentA: 40, cutoffV: 2.5, maxTimeMin: 600 },
    ],
  },
  {
    // One knob per setpoint: adjust "Discharge A" / "Cutoff V" once and every
    // bound step follows. High-IR cells that trip the cutoff instantly at the
    // programmed current auto-retry at half current down to 5 A.
    name: 'Parametric Cycle',
    variables: [
      { key: 'Discharge A', value: 10, unit: 'A' },
      { key: 'Cutoff V', value: 2.5, unit: 'V' },
    ],
    steps: [
      {
        type: 'loop',
        count: 3,
        children: [
          { type: 'c-cv', currentA: 40, targetV: 3.65, cutoffCurrentA: 2.0, maxTimeMin: 720 },
          { type: 'wait', durationS: 1800 },
          {
            type: 'd-cc',
            currentA: 10,
            cutoffV: 2.5,
            maxTimeMin: 1440,
            bind: { currentA: 'Discharge A', cutoffV: 'Cutoff V' },
            backoff: { minA: 5 },
          },
          { type: 'wait', durationS: 1800 },
        ],
      },
    ],
  },
  {
    name: 'Quick Check',
    steps: [{ type: 'd-cc', currentA: 20, cutoffV: 2.8, maxTimeMin: 720 }],
  },
  {
    name: 'Gentle Cycle',
    steps: [
      { type: 'c-cv', currentA: 20, targetV: 3.65, cutoffCurrentA: 2.0, maxTimeMin: 720 },
      { type: 'wait', durationS: 1800 },
      { type: 'd-cc', currentA: 20, cutoffV: 2.8, maxTimeMin: 720 },
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
          { type: 'd-cc', currentA: 40, cutoffV: 2.5, maxTimeMin: 600 },
          { type: 'wait', durationS: 1800 },
        ],
      },
    ],
  },
];
