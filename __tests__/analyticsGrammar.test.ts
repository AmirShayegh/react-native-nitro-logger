import {
  defineEvents,
  int,
  namedString,
  oneOf,
  optional,
  screenName,
} from '../src/analytics';

/* eslint-disable no-extend-native -- these tests prove inherited hooks cannot affect canonical grammar bytes */

type GrammarConstraint =
  | {
      readonly type: 'enum';
      readonly values: readonly string[];
    }
  | {
      readonly type: 'integer';
      readonly minimum: number;
      readonly maximum: number;
    }
  | {
      readonly type: 'named-string';
      readonly registry: string;
      readonly values: readonly string[];
    };

type Grammar = {
  readonly artifact: 'react-native-nitro-logger/analytics-grammar';
  readonly formatVersion: 1;
  readonly additionalEvents: false;
  readonly events: readonly {
    readonly name: string;
    readonly additionalProperties: false;
    readonly properties: readonly {
      readonly name: string;
      readonly required: boolean;
      readonly constraint: GrammarConstraint;
    }[];
  }[];
};

type GrammarArtifact = {
  readonly grammar: Grammar;
  readonly grammarJSON: string;
};

const defineUnknown = defineEvents as unknown as (
  definition: unknown
) => GrammarArtifact;

const grammarEvents = () =>
  defineEvents({
    appointment_booked: {
      via: oneOf('search', 'referral', 'rebook'),
      note_kind: optional(oneOf('none', 'staff-authored')),
      lead_time_days: int({ min: 0, max: 365 }),
      clinic_type: oneOf('gp', 'specialist', 'mental_health'),
    },
    screen_view: {
      name: screenName('Home', 'Appointments', 'Settings'),
    },
    care_path_entered: {
      path: namedString('care-path', 'intake', 'follow-up'),
    },
  }) as unknown as GrammarArtifact;

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) {
      expectDeepFrozen(descriptor.value);
    }
  }
}

function eventDefinition(count: number): Record<string, unknown> {
  const definition: Record<string, unknown> = {};
  const descriptor = oneOf('allowed');
  for (let index = 0; index < count; index += 1) {
    definition[`event_${String(index).padStart(3, '0')}`] = {
      value: descriptor,
    };
  }
  return definition;
}

function propertyDefinition(
  count: number,
  reverse = false
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const descriptor = oneOf('allowed');
  for (let offset = 0; offset < count; offset += 1) {
    const index = reverse ? count - offset - 1 : offset;
    properties[`property_${String(index).padStart(4, '0')}`] = descriptor;
  }
  return { event: properties };
}

function expectedGrammarForValues(values: readonly string[]): Grammar {
  return {
    artifact: 'react-native-nitro-logger/analytics-grammar',
    formatVersion: 1,
    additionalEvents: false,
    events: [
      {
        name: 'event',
        additionalProperties: false,
        properties: [
          {
            name: 'value',
            required: true,
            constraint: { type: 'enum', values },
          },
        ],
      },
    ],
  };
}

function membersForGrammarSize(targetBytes: number): string[] {
  const values = Array.from({ length: 4096 }, (_, index) => {
    const prefix = `v${String(index).padStart(4, '0')}-`;
    return prefix + 'x'.repeat(250 - prefix.length);
  });
  const initialBytes = JSON.stringify(expectedGrammarForValues(values)).length;
  let remaining = targetBytes - initialBytes;

  for (let index = 0; index < values.length && remaining > 0; index += 1) {
    const value = values[index]!;
    const available = 256 - value.length;
    const added = Math.min(available, remaining);
    values[index] = value + 'y'.repeat(added);
    remaining -= added;
  }

  expect(remaining).toBe(0);
  expect(JSON.stringify(expectedGrammarForValues(values)).length).toBe(
    targetBytes
  );
  return values;
}

describe('analytics strict grammar emission', () => {
  test('emits the exact closed v1 grammar and authoritative JSON', () => {
    const artifact = grammarEvents();

    expect(artifact.grammar).toEqual({
      artifact: 'react-native-nitro-logger/analytics-grammar',
      formatVersion: 1,
      additionalEvents: false,
      events: [
        {
          name: 'appointment_booked',
          additionalProperties: false,
          properties: [
            {
              name: 'clinic_type',
              required: true,
              constraint: {
                type: 'enum',
                values: ['gp', 'specialist', 'mental_health'],
              },
            },
            {
              name: 'lead_time_days',
              required: true,
              constraint: { type: 'integer', minimum: 0, maximum: 365 },
            },
            {
              name: 'note_kind',
              required: false,
              constraint: {
                type: 'enum',
                values: ['none', 'staff-authored'],
              },
            },
            {
              name: 'via',
              required: true,
              constraint: {
                type: 'enum',
                values: ['search', 'referral', 'rebook'],
              },
            },
          ],
        },
        {
          name: 'care_path_entered',
          additionalProperties: false,
          properties: [
            {
              name: 'path',
              required: true,
              constraint: {
                type: 'named-string',
                registry: 'care-path',
                values: ['intake', 'follow-up'],
              },
            },
          ],
        },
        {
          name: 'screen_view',
          additionalProperties: false,
          properties: [
            {
              name: 'name',
              required: true,
              constraint: {
                type: 'named-string',
                registry: 'screen',
                values: ['Home', 'Appointments', 'Settings'],
              },
            },
          ],
        },
      ],
    });
    expect(JSON.parse(artifact.grammarJSON)).toEqual(artifact.grammar);
    expect(JSON.stringify(artifact.grammar)).toBe(artifact.grammarJSON);
    expect(artifact.grammarJSON).not.toContain('optional');
    expect(artifact.grammarJSON).not.toContain('schemaVersion');
  });

  test('sorts structural names while preserving authored member order', () => {
    const first = defineEvents({
      zebra: { second: oneOf('z', 'a'), first: oneOf('two', 'one') },
      alpha: { value: oneOf('right', 'left') },
    }) as unknown as GrammarArtifact;
    const second = defineEvents({
      alpha: { value: oneOf('right', 'left') },
      zebra: { first: oneOf('two', 'one'), second: oneOf('z', 'a') },
    }) as unknown as GrammarArtifact;

    expect(first.grammarJSON).toBe(second.grammarJSON);
    expect(first.grammar.events.map((event) => event.name)).toEqual([
      'alpha',
      'zebra',
    ]);
    expect(
      first.grammar.events[1]!.properties.map((property) => property.name)
    ).toEqual(['first', 'second']);
    expect(first.grammar.events[1]!.properties[0]!.constraint).toMatchObject({
      values: ['two', 'one'],
    });
  });

  test('returns a protected JSON-only graph detached from caller data', () => {
    const members = ['first', 'second'];
    const source: Record<string, Record<string, unknown>> = {
      event: { value: oneOf(...members) },
    };
    const artifact = defineUnknown(source);
    const bytes = artifact.grammarJSON;

    members[0] = 'caller-mutated';
    source.event!.value = oneOf('replacement');

    expectDeepFrozen(artifact.grammar);
    expect(Object.getPrototypeOf(artifact.grammar)).toBeNull();
    expect(Object.getPrototypeOf(artifact.grammar.events[0]!)).toBeNull();
    expect(
      Object.getPrototypeOf(artifact.grammar.events[0]!.properties[0]!)
    ).toBeNull();
    expect(
      Object.getPrototypeOf(
        artifact.grammar.events[0]!.properties[0]!.constraint
      )
    ).toBeNull();
    expect(
      Object.getOwnPropertyDescriptor(artifact.grammar.events, 'toJSON')
    ).toMatchObject({
      value: null,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(artifact.grammarJSON).toBe(bytes);
    expect(JSON.parse(bytes)).toEqual(
      expectedGrammarForValues(['first', 'second'])
    );
  });

  test('never dispatches inherited serialization hooks or reentrant code', () => {
    const objectHook = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'toJSON'
    );
    const arrayHook = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'toJSON'
    );
    let hookCalls = 0;
    let artifact: GrammarArtifact | undefined;
    let serialized: string | undefined;

    const hostileToJSON = () => {
      hookCalls += 1;
      defineEvents({ reentered: { secret: oneOf('alternate') } });
      return { attackerControlled: true };
    };

    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: hostileToJSON,
      });
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: hostileToJSON,
      });
      artifact = grammarEvents();
      serialized = JSON.stringify(artifact.grammar);
    } finally {
      restoreProperty(Object.prototype, 'toJSON', objectHook);
      restoreProperty(Array.prototype, 'toJSON', arrayHook);
    }

    expect(hookCalls).toBe(0);
    expect(serialized).toBe(artifact?.grammarJSON);
    expect(serialized).not.toContain('attackerControlled');
  });

  test('later prototype mutation cannot change the authoritative bytes', () => {
    const artifact = grammarEvents();
    const bytes = artifact.grammarJSON;
    expect(typeof bytes).toBe('string');
    const objectHook = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'toJSON'
    );
    const arrayHook = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'toJSON'
    );
    let serialized: string | undefined;

    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: () => {
          throw new Error('inherited object hook ran');
        },
      });
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: () => {
          throw new Error('inherited array hook ran');
        },
      });
      serialized = JSON.stringify(artifact.grammar);
    } finally {
      restoreProperty(Object.prototype, 'toJSON', objectHook);
      restoreProperty(Array.prototype, 'toJSON', arrayHook);
    }

    expect(artifact.grammarJSON).toBe(bytes);
    expect(serialized).toBe(bytes);
  });

  test('reuses one frozen constraint node for a shared descriptor', () => {
    const shared = oneOf('one', 'two');
    const artifact = defineEvents({
      event: { first: shared, second: shared, maybe: optional(shared) },
    }) as unknown as GrammarArtifact;
    const properties = artifact.grammar.events[0]!.properties;

    expect(properties[0]!.constraint).toBe(properties[2]!.constraint);
    expect(properties[0]!.constraint).toBe(properties[1]!.constraint);
    expect(Object.isFrozen(properties[0]!.constraint)).toBe(true);
  });
});

describe('analytics grammar cross-language constraints', () => {
  test('accepts safe integer edges and rejects unsafe integer bounds', () => {
    expect(() =>
      defineEvents({
        event: {
          value: int({
            min: Number.MIN_SAFE_INTEGER,
            max: Number.MAX_SAFE_INTEGER,
          }),
        },
      })
    ).not.toThrow();

    expect(() => int({ min: Number.MIN_SAFE_INTEGER - 1, max: 0 })).toThrow(
      'INVALID_INTEGER_BOUNDS'
    );
    expect(() => int({ min: 0, max: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      'INVALID_INTEGER_BOUNDS'
    );
  });

  test.each(['\ud800', '\udfff', 'prefix\ud800suffix', '\ud800\ud800'])(
    'rejects an unpaired UTF-16 surrogate %#',
    (member) => {
      expect(() => oneOf(member)).toThrow('INVALID_CONSTRAINT_MEMBER');
    }
  );

  test('preserves astral, combining, replacement, and BMP members distinctly', () => {
    const members = ['plain', '🚀', 'e\u0301', '\ufffd'];
    const artifact = defineEvents({
      event: { value: oneOf(...members) },
    }) as unknown as GrammarArtifact;
    const constraint = artifact.grammar.events[0]!.properties[0]!.constraint;

    expect(constraint).toEqual({ type: 'enum', values: members });
    expect(
      JSON.parse(artifact.grammarJSON).events[0].properties[0].constraint
    ).toEqual({ type: 'enum', values: members });
  });

  test('enforces the 256-byte member boundary using UTF-8 bytes', () => {
    expect(() => oneOf('a'.repeat(256))).not.toThrow();
    expect(() => oneOf('a'.repeat(257))).toThrow('CONSTRAINT_MEMBER_TOO_LARGE');
    expect(() => oneOf('🚀'.repeat(64))).not.toThrow();
    expect(() => oneOf('🚀'.repeat(65))).toThrow('CONSTRAINT_MEMBER_TOO_LARGE');
  });
});

describe('analytics grammar resource ceilings', () => {
  test('accepts 256 events and rejects the 257th before descriptor copying', () => {
    expect(defineUnknown(eventDefinition(256)).grammar.events).toHaveLength(
      256
    );

    const descriptor = oneOf('target');
    const definition = eventDefinition(256);
    definition.event_256 = { value: descriptor };
    const originalIterator = Array.prototype[Symbol.iterator];
    let copiedTarget = false;

    try {
      Array.prototype[Symbol.iterator] = function iterator() {
        if (this === (descriptor.values as unknown)) copiedTarget = true;
        return originalIterator.call(this);
      };
      expect(() => defineUnknown(definition)).toThrow('GRAMMAR_EVENT_LIMIT');
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }
    expect(copiedTarget).toBe(false);
  });

  test('accepts 2,048 properties and rejects the next before copying it', () => {
    expect(
      defineUnknown(propertyDefinition(2048)).grammar.events[0]!.properties
    ).toHaveLength(2048);
    const reverseOrdered = defineUnknown(propertyDefinition(2048, true));
    expect(
      reverseOrdered.grammar.events[0]!.properties.map(
        (property) => property.name
      )
    ).toEqual(
      Array.from(
        { length: 2048 },
        (_, index) => `property_${String(index).padStart(4, '0')}`
      )
    );

    const definition = propertyDefinition(2048);
    const properties = definition.event as Record<string, unknown>;
    const descriptor = oneOf('target');
    properties.property_2048 = descriptor;
    const originalIterator = Array.prototype[Symbol.iterator];
    let copiedTarget = false;

    try {
      Array.prototype[Symbol.iterator] = function iterator() {
        if (this === (descriptor.values as unknown)) copiedTarget = true;
        return originalIterator.call(this);
      };
      expect(() => defineUnknown(definition)).toThrow('GRAMMAR_PROPERTY_LIMIT');
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }
    expect(copiedTarget).toBe(false);
  });

  test('counts 16,384 serialized member references before normalized copies', () => {
    const members = Array.from(
      { length: 4096 },
      (_, index) => `member-${index}`
    );
    const shared = oneOf(...members);
    const atLimit = defineEvents({
      event: { first: shared, second: shared, third: shared, fourth: shared },
    }) as unknown as GrammarArtifact;
    const constraints = atLimit.grammar.events[0]!.properties.map(
      (property) => property.constraint
    );

    expect(constraints).toHaveLength(4);
    expect(constraints[0]).toBe(constraints[3]);

    const overLimit = {
      event: {
        first: shared,
        second: shared,
        third: shared,
        fourth: shared,
        fifth: oneOf('target'),
      },
    };
    const target = overLimit.event.fifth;
    const originalIterator = Array.prototype[Symbol.iterator];
    let copiedTarget = false;

    try {
      Array.prototype[Symbol.iterator] = function iterator() {
        if (this === (target.values as unknown)) copiedTarget = true;
        return originalIterator.call(this);
      };
      expect(() => defineEvents(overLimit)).toThrow(
        'GRAMMAR_MEMBER_REFERENCE_LIMIT'
      );
    } finally {
      Array.prototype[Symbol.iterator] = originalIterator;
    }
    expect(copiedTarget).toBe(false);
  });

  test('accepts exactly 1 MiB of JSON and rejects one byte more', () => {
    const oneMiB = 1024 * 1024;
    const values = membersForGrammarSize(oneMiB);
    const atLimit = defineEvents({
      event: { value: oneOf(...values) },
    }) as unknown as GrammarArtifact;
    expect(new TextEncoder().encode(atLimit.grammarJSON)).toHaveLength(oneMiB);

    const overValues = [...values];
    const expandable = overValues.findIndex((value) => value.length < 256);
    expect(expandable).toBeGreaterThanOrEqual(0);
    overValues[expandable] = overValues[expandable]! + 'z';
    expect(() =>
      defineEvents({ event: { value: oneOf(...overValues) } })
    ).toThrow('GRAMMAR_SIZE_LIMIT');
  });
});
