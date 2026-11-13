import type {
  AnalyticsGrammarConstraint,
  AnalyticsGrammarV1,
} from '../src/analytics';
import {
  goldenArtifact,
  goldenVectors,
} from './fixtures/analyticsGoldenVectors';

type RejectionCode =
  | 'UNKNOWN_EVENT'
  | 'INVALID_CONTAINER'
  | 'EXTRA_PROPERTY'
  | 'MISSING_PROPERTY'
  | 'INVALID_VALUE';

type Decision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: RejectionCode;
      readonly property?: string;
    };

const REQUIRED_REJECTION_CODES = [
  'EXTRA_PROPERTY',
  'INVALID_CONTAINER',
  'INVALID_VALUE',
  'MISSING_PROPERTY',
  'UNKNOWN_EVENT',
] as const;

const REQUIRED_REJECTION_FAMILIES = [
  'closed-properties',
  'container',
  'enum',
  'event-name',
  'integer-integrality',
  'integer-lower-bound',
  'integer-primitive',
  'integer-upper-bound',
  'named-string',
  'optional-value',
  'required-property',
] as const;

const REQUIRED_FAMILIES = [
  ...REQUIRED_REJECTION_FAMILIES,
  'optional-omission',
].sort();

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function constraintAccepts(
  constraint: AnalyticsGrammarConstraint,
  value: unknown
): boolean {
  switch (constraint.type) {
    case 'enum':
    case 'named-string':
      return typeof value === 'string' && constraint.values.includes(value);
    case 'integer':
      return (
        Number.isSafeInteger(value) &&
        (value as number) >= constraint.minimum &&
        (value as number) <= constraint.maximum
      );
  }
}

function validateGrammar(
  grammarJSON: string,
  eventName: unknown,
  properties: unknown
): Decision {
  const grammar = JSON.parse(grammarJSON) as AnalyticsGrammarV1;
  if (
    grammar.artifact !== 'react-native-nitro-logger/analytics-grammar' ||
    grammar.formatVersion !== 1 ||
    grammar.additionalEvents !== false
  ) {
    throw new Error('INVALID_GRAMMAR_ENVELOPE');
  }
  const event =
    typeof eventName === 'string'
      ? grammar.events.find((candidate) => candidate.name === eventName)
      : undefined;
  if (!event) return { ok: false, code: 'UNKNOWN_EVENT' };
  if (event.additionalProperties !== false) {
    throw new Error('OPEN_EVENT_GRAMMAR');
  }
  if (!plainRecord(properties)) {
    return { ok: false, code: 'INVALID_CONTAINER' };
  }

  const grammarProperties = new Map(
    event.properties.map((property) => [property.name, property] as const)
  );
  for (const property of Object.keys(properties)) {
    if (!grammarProperties.has(property)) {
      return { ok: false, code: 'EXTRA_PROPERTY' };
    }
  }

  for (const property of event.properties) {
    if (!Object.prototype.hasOwnProperty.call(properties, property.name)) {
      if (property.required) {
        return {
          ok: false,
          code: 'MISSING_PROPERTY',
          property: property.name,
        };
      }
      continue;
    }
    if (!constraintAccepts(property.constraint, properties[property.name])) {
      return {
        ok: false,
        code: 'INVALID_VALUE',
        property: property.name,
      };
    }
  }
  return { ok: true };
}

describe('analytics schema golden-vector agreement', () => {
  test('gives every rejection a separately executed positive control', () => {
    expect(goldenVectors.length).toBeGreaterThan(0);
    const byId = new Map(goldenVectors.map((vector) => [vector.id, vector]));
    expect(byId.size).toBe(goldenVectors.length);
    expect(
      [
        ...new Set(
          goldenVectors.flatMap((vector) =>
            vector.expected.ok ? [] : [vector.expected.code]
          )
        ),
      ].sort()
    ).toEqual(REQUIRED_REJECTION_CODES);
    expect(
      [
        ...new Set(
          goldenVectors
            .filter((vector) => !vector.expected.ok)
            .map((vector) => vector.family)
        ),
      ].sort()
    ).toEqual(REQUIRED_REJECTION_FAMILIES);
    expect(
      [...new Set(goldenVectors.map((vector) => vector.family))].sort()
    ).toEqual(REQUIRED_FAMILIES);
    expect(JSON.parse(JSON.stringify(goldenVectors))).toEqual(goldenVectors);

    for (const vector of goldenVectors) {
      if (vector.expected.ok) continue;
      expect(vector.positiveControl).not.toBeNull();
      const control = byId.get(vector.positiveControl!);
      expect(control).toBeDefined();
      expect(control?.expected).toEqual({ ok: true });
      expect(control?.family).toBe(vector.family);
    }
  });

  test('accepts every positive vector in the runtime and emitted grammar', () => {
    const positives = goldenVectors.filter((vector) => vector.expected.ok);
    expect(positives.length).toBeGreaterThan(0);

    for (const vector of positives) {
      expect({
        id: vector.id,
        decision: goldenArtifact.validate(vector.eventName, vector.properties),
      }).toMatchObject({ id: vector.id, decision: { ok: true } });
      expect({
        id: vector.id,
        decision: validateGrammar(
          goldenArtifact.grammarJSON,
          vector.eventName,
          vector.properties
        ),
      }).toEqual({ id: vector.id, decision: { ok: true } });
    }
  });

  test('rejects every negative vector identically at runtime and grammar', () => {
    const negatives = goldenVectors.filter((vector) => !vector.expected.ok);
    expect(negatives.length).toBeGreaterThan(0);

    for (const vector of negatives) {
      expect({
        id: vector.id,
        decision: goldenArtifact.validate(vector.eventName, vector.properties),
      }).toEqual({ id: vector.id, decision: vector.expected });
      expect({
        id: vector.id,
        decision: validateGrammar(
          goldenArtifact.grammarJSON,
          vector.eventName,
          vector.properties
        ),
      }).toEqual({ id: vector.id, decision: vector.expected });
    }
  });

  test('binds the lint artifact to the grammar bytes used by the vectors', () => {
    expect(goldenArtifact.lint.grammar).toBe(goldenArtifact.grammar);
    expect(JSON.stringify(goldenArtifact.lint.grammar)).toBe(
      goldenArtifact.grammarJSON
    );
  });
});
