/**
 * Sequence variables — named numbers a sequence's step fields can bind to.
 *
 * A step stores `bind: { cutoffV: 'Cutoff V' }` alongside its plain numeric
 * fields; resolveSteps() overwrites each bound field with the variable's
 * value. The numeric field keeps its last value as a fallback, so deleting
 * a variable degrades gracefully instead of breaking the sequence, and
 * every consumer (simulation, timeline, cycle runner) keeps working on
 * plain numbers.
 *
 * Shared between the frontend sequence editor and the server cycle runner.
 */

/** Units a variable can be locked to. Undefined unit = untyped (binds anywhere). */
export type VariableUnit = 'A' | 'V' | 'W';

export const VARIABLE_UNITS: VariableUnit[] = ['A', 'V', 'W'];

export interface SequenceVariable {
  key: string;
  value: number;
  /**
   * Optional unit. When set, the variable may only bind to step fields of the
   * same unit (a 'V' variable can't drive a current field). Undefined = any.
   */
  unit?: VariableUnit;
}

/** field name → variable key */
export type FieldBindings = Partial<Record<string, string>>;

/** Fields that may bind to a variable, per step type */
export const BINDABLE_FIELDS: Record<string, string[]> = {
  'd-cc': ['currentA', 'cutoffV'],
  'd-cp': ['powerW', 'cutoffV'],
  'c-cv': ['currentA', 'targetV', 'cutoffCurrentA'],
};

/** The physical unit each bindable field carries */
export const FIELD_UNIT: Record<string, VariableUnit> = {
  currentA: 'A',
  cutoffCurrentA: 'A',
  cutoffV: 'V',
  targetV: 'V',
  powerW: 'W',
};

/**
 * Whether a variable of the given unit may bind to `field`. Untyped variables
 * (no unit) bind anywhere; typed ones only to a field of the matching unit.
 */
export function variableMatchesField(unit: VariableUnit | undefined, field: string): boolean {
  return unit === undefined || FIELD_UNIT[field] === unit;
}

interface StepLike {
  type: string;
  bind?: FieldBindings;
  children?: StepLike[];
}

/**
 * Return a copy of the steps with every bound field overwritten by its
 * variable's value. Bindings to unknown variables are left at the field's
 * stored number. The `bind` markers are preserved (harmless downstream,
 * and they document where a value came from).
 */
export function resolveSteps<S extends StepLike>(steps: S[], variables: SequenceVariable[]): S[] {
  if (variables.length === 0) return steps;
  const values = new Map(variables.map(v => [v.key, v.value]));

  const walk = (step: StepLike): StepLike => {
    if (step.type === 'loop' && step.children) {
      return { ...step, children: step.children.map(walk) };
    }
    if (!step.bind) return step;

    const resolved: Record<string, unknown> = { ...(step as unknown as Record<string, unknown>) };
    for (const [field, key] of Object.entries(step.bind)) {
      if (key === undefined) continue;
      const value = values.get(key);
      if (typeof value === 'number' && Number.isFinite(value)) {
        resolved[field] = value;
      }
    }
    return resolved as unknown as StepLike;
  };

  return steps.map(walk) as S[];
}

// ── steps_json document format ──────────────────────────────────────

/**
 * A saved sequence document. Legacy sequences stored a bare step array;
 * sequences with variables store `{ variables, steps }`.
 */
export interface SequenceDoc<S = unknown> {
  variables: SequenceVariable[];
  steps: S[];
}

/** Accepts either format (already-parsed JSON) and normalizes to a doc */
export function toSequenceDoc<S = unknown>(raw: unknown): SequenceDoc<S> {
  if (Array.isArray(raw)) {
    return { variables: [], steps: raw as S[] };
  }
  if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { steps?: unknown }).steps)) {
    const doc = raw as { variables?: unknown; steps: S[] };
    const variables = Array.isArray(doc.variables)
      ? (doc.variables as SequenceVariable[])
          .filter(v => v && typeof v.key === 'string' && typeof v.value === 'number')
          .map(v =>
            v.unit && VARIABLE_UNITS.includes(v.unit)
              ? { key: v.key, value: v.value, unit: v.unit }
              : { key: v.key, value: v.value }
          )
      : [];
    return { variables, steps: doc.steps };
  }
  return { variables: [], steps: [] };
}

/** Parse a steps_json string into a doc (empty doc on parse failure) */
export function parseSequenceDoc<S = unknown>(json: string): SequenceDoc<S> {
  try {
    return toSequenceDoc<S>(JSON.parse(json));
  } catch {
    return { variables: [], steps: [] };
  }
}

/** Serialize a doc; emits the legacy bare array when there are no variables */
export function serializeSequenceDoc<S>(doc: SequenceDoc<S>): string {
  if (doc.variables.length === 0) return JSON.stringify(doc.steps);
  return JSON.stringify({ variables: doc.variables, steps: doc.steps });
}
