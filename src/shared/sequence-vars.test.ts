import { describe, expect, test } from 'bun:test';
import {
  parseSequenceDoc,
  resolveSteps,
  serializeSequenceDoc,
  toSequenceDoc,
  variableMatchesField,
} from './sequence-vars.ts';

const VARS = [
  { key: 'Discharge A', value: 10 },
  { key: 'Cutoff V', value: 2.5 },
];

describe('resolveSteps', () => {
  test('overwrites bound fields with variable values', () => {
    const steps = [
      { type: 'd-cc', currentA: 40, cutoffV: 2.8, bind: { currentA: 'Discharge A', cutoffV: 'Cutoff V' } },
    ];
    const [resolved] = resolveSteps(steps, VARS) as typeof steps;
    expect(resolved.currentA).toBe(10);
    expect(resolved.cutoffV).toBe(2.5);
  });

  test('leaves unbound fields and unbound steps alone', () => {
    const steps = [
      { type: 'c-cv', currentA: 40, targetV: 3.65 },
      { type: 'd-cc', currentA: 40, cutoffV: 2.8, bind: { cutoffV: 'Cutoff V' } },
    ];
    const resolved = resolveSteps(steps, VARS) as typeof steps;
    expect(resolved[0]).toBe(steps[0]); // untouched reference
    expect(resolved[1].currentA).toBe(40);
    expect(resolved[1].cutoffV).toBe(2.5);
  });

  test('binding to a deleted variable falls back to the stored number', () => {
    const steps = [{ type: 'd-cc', currentA: 40, cutoffV: 2.8, bind: { cutoffV: 'Gone' } }];
    const [resolved] = resolveSteps(steps, VARS) as typeof steps;
    expect(resolved.cutoffV).toBe(2.8);
  });

  test('resolves inside loop children', () => {
    const steps = [
      {
        type: 'loop',
        count: 3,
        children: [{ type: 'd-cc', currentA: 40, cutoffV: 2.8, bind: { currentA: 'Discharge A' } }],
      },
    ];
    const resolved = resolveSteps(steps, VARS) as any[];
    expect(resolved[0].children[0].currentA).toBe(10);
  });

  test('no variables → same array back', () => {
    const steps = [{ type: 'd-cc', currentA: 40, cutoffV: 2.8, bind: { currentA: 'Discharge A' } }];
    expect(resolveSteps(steps, [])).toBe(steps);
  });
});

describe('sequence doc parse/serialize', () => {
  test('legacy bare array round-trips without a wrapper', () => {
    const doc = toSequenceDoc(JSON.parse('[{"type":"wait","durationS":60}]'));
    expect(doc.variables).toEqual([]);
    expect(doc.steps).toHaveLength(1);
    expect(serializeSequenceDoc(doc)).toBe('[{"type":"wait","durationS":60}]');
  });

  test('doc format with variables round-trips', () => {
    const json = serializeSequenceDoc({ variables: VARS, steps: [{ type: 'wait', durationS: 60 }] });
    const doc = parseSequenceDoc(json);
    expect(doc.variables).toEqual(VARS);
    expect(doc.steps).toHaveLength(1);
  });

  test('malformed input yields an empty doc', () => {
    expect(parseSequenceDoc('not json').steps).toEqual([]);
    expect(toSequenceDoc({ nonsense: true }).steps).toEqual([]);
    expect(toSequenceDoc(null).steps).toEqual([]);
  });

  test('non-numeric variable values are dropped', () => {
    const doc = toSequenceDoc({
      variables: [
        { key: 'A', value: 'x' },
        { key: 'B', value: 5 },
      ],
      steps: [],
    });
    expect(doc.variables).toEqual([{ key: 'B', value: 5 }]);
  });

  test('valid units are preserved, invalid ones dropped', () => {
    const doc = toSequenceDoc({
      variables: [
        { key: 'I', value: 10, unit: 'A' },
        { key: 'bad', value: 1, unit: 'kg' },
      ],
      steps: [],
    });
    expect(doc.variables).toEqual([
      { key: 'I', value: 10, unit: 'A' },
      { key: 'bad', value: 1 },
    ]);
  });
});

describe('variableMatchesField', () => {
  test('untyped variables bind to any field', () => {
    expect(variableMatchesField(undefined, 'currentA')).toBe(true);
    expect(variableMatchesField(undefined, 'cutoffV')).toBe(true);
    expect(variableMatchesField(undefined, 'powerW')).toBe(true);
  });

  test('typed variables bind only to matching-unit fields', () => {
    expect(variableMatchesField('A', 'currentA')).toBe(true);
    expect(variableMatchesField('A', 'cutoffCurrentA')).toBe(true);
    expect(variableMatchesField('A', 'cutoffV')).toBe(false);
    expect(variableMatchesField('V', 'targetV')).toBe(true);
    expect(variableMatchesField('V', 'currentA')).toBe(false);
    expect(variableMatchesField('W', 'powerW')).toBe(true);
    expect(variableMatchesField('W', 'cutoffV')).toBe(false);
  });
});
