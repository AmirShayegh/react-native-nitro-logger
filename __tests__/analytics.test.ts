import packageManifest from '../package.json';
import {
  defineEvents,
  int,
  namedString,
  oneOf,
  optional,
  screenName,
} from '../src/analytics';
import { priv, pub } from '../src/privacy';
import type { LogPrimitive } from '../src/types';
import typescriptConfig from '../tsconfig.json';

const makeEvents = () =>
  defineEvents({
    appointment_booked: {
      clinic_type: oneOf('gp', 'specialist', 'mental_health'),
      lead_time_days: int({ min: 0, max: 365 }),
      via: oneOf('search', 'referral', 'rebook'),
      note_kind: optional(oneOf('none', 'staff-authored')),
    },
    screen_view: {
      name: screenName('Home', 'Appointments', 'Settings'),
    },
    care_path_entered: {
      path: namedString('care-path', 'intake', 'follow-up'),
    },
  });

const failure = (result: unknown): Readonly<Record<string, unknown>> => {
  expect(result).toMatchObject({ ok: false });
  return result as Readonly<Record<string, unknown>>;
};

const defineUnknown = defineEvents as unknown as (
  definition: unknown
) => unknown;
const namedStringUnknown = namedString as unknown as (
  registry: unknown,
  ...values: unknown[]
) => unknown;
const oneOfUnknown = oneOf as unknown as (...values: unknown[]) => unknown;
const optionalUnknown = optional as unknown as (value: unknown) => unknown;
const screenNameUnknown = screenName as unknown as (
  ...values: unknown[]
) => unknown;

describe('analytics schema definition', () => {
  test('defines the descriptor language from one immutable source', () => {
    const events = makeEvents();

    expect(Object.keys(events.schema)).toEqual([
      'appointment_booked',
      'screen_view',
      'care_path_entered',
    ]);
    expect(events.schema.appointment_booked.lead_time_days).toMatchObject({
      kind: 'integer',
      min: 0,
      max: 365,
    });
    expect(events.schema.screen_view.name).toMatchObject({
      kind: 'named-string',
      registry: 'screen',
      values: ['Home', 'Appointments', 'Settings'],
    });
  });

  test('rejects an empty event definition', () => {
    expect(() => defineEvents({})).toThrow();
  });

  test('rejects empty enums', () => {
    expect(() => oneOf()).toThrow();
  });

  test('rejects duplicate enum members', () => {
    expect(() => oneOf('search', 'search')).toThrow();
  });

  test('rejects empty and non-string members without coercion', () => {
    let coercions = 0;
    const hostileMember = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return 'coerced';
      },
    };
    const calls = [
      () => oneOfUnknown(''),
      () => oneOfUnknown(hostileMember),
      () => namedStringUnknown('care-path', ''),
      () => namedStringUnknown('care-path', hostileMember),
      () => screenNameUnknown(''),
      () => screenNameUnknown(hostileMember),
    ];

    for (const call of calls) {
      expect(call).toThrow('INVALID_CONSTRAINT_MEMBER');
    }
    expect(coercions).toBe(0);
  });

  test.each([
    { min: 2, max: 1 },
    { min: 0.5, max: 1 },
    { min: 0, max: 1.5 },
    { min: Number.NaN, max: 1 },
    { min: 0, max: Number.POSITIVE_INFINITY },
    { min: Number.NEGATIVE_INFINITY, max: 0 },
  ])('rejects invalid integer bounds %#', (bounds) => {
    expect(() => int(bounds)).toThrow();
  });

  test('accepts an equal integer bound as one exact value', () => {
    expect(int({ min: 7, max: 7 })).toMatchObject({
      kind: 'integer',
      min: 7,
      max: 7,
    });
  });

  test('captures each integer bound from one own data descriptor', () => {
    let descriptorReads = 0;
    const bounds = new Proxy(
      { min: 0, max: 1 },
      {
        getOwnPropertyDescriptor(target, key) {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }
    );

    expect(int(bounds)).toMatchObject({ min: 0, max: 1 });
    expect(descriptorReads).toBe(2);
  });

  test('rejects integer accessors without invoking them', () => {
    let getterCalls = 0;
    const bounds = { max: 1 } as { min: number; max: number };
    Object.defineProperty(bounds, 'min', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 0;
      },
    });

    expect(() => int(bounds)).toThrow('INVALID_INTEGER_BOUNDS');
    expect(getterCalls).toBe(0);
  });

  test('contains hostile integer-bound reflection errors', () => {
    const bounds = new Proxy(
      { min: 0, max: 1 },
      {
        getOwnPropertyDescriptor() {
          throw new TypeError('JANE_DOE_DIAGNOSIS');
        },
      }
    );

    expect(() => int(bounds)).toThrow('INVALID_INTEGER_BOUNDS');
    expect(() => int(bounds)).not.toThrow('JANE_DOE_DIAGNOSIS');
  });

  test('rejects an empty named registry', () => {
    expect(() => namedString('', 'intake')).toThrow();
  });

  test('rejects a named registry with no values', () => {
    expect(() => namedString('care-path')).toThrow();
  });

  test('rejects duplicate values in a named registry', () => {
    expect(() => namedString('care-path', 'intake', 'intake')).toThrow();
  });

  test('rejects non-string registry names without coercing them', () => {
    let coercions = 0;
    const coercible = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        return 'care-path';
      },
    };
    const throwing = {
      [Symbol.toPrimitive]() {
        coercions += 1;
        throw new TypeError('JANE_DOE_DIAGNOSIS');
      },
    };

    for (const registry of [Symbol('care-path'), coercible, throwing]) {
      expect(() => namedStringUnknown(registry, 'intake')).toThrow(
        'INVALID_REGISTRY_NAME'
      );
      expect(() => namedStringUnknown(registry, 'intake')).not.toThrow(
        'JANE_DOE_DIAGNOSIS'
      );
    }
    expect(coercions).toBe(0);
  });

  test('accepts the registry size limit and rejects one member beyond it', () => {
    const atLimit = Array.from(
      { length: 4096 },
      (_, index) => `value-${index}`
    );
    const descriptor = oneOf(...atLimit);
    const events = defineEvents({ event: { value: descriptor } });

    expect(events.validate('event', { value: 'value-4095' })).toMatchObject({
      ok: true,
    });
    expect(() => oneOf(...atLimit, 'value-4096')).toThrow(
      'CONSTRAINT_TOO_LARGE'
    );
  });

  test('rejects forged descriptors passed around the constructors', () => {
    expect(() =>
      defineUnknown({
        event: { value: { kind: 'integer', min: 0, max: Infinity } },
      })
    ).toThrow('INVALID_DESCRIPTOR');
  });

  test('rejects forged and nested optional descriptors', () => {
    const forged = [
      { kind: 'integer', min: 0, max: Infinity },
      { kind: 'enum', values: ['', 42] },
    ];

    for (const descriptor of forged) {
      expect(() => optionalUnknown(descriptor)).toThrow('INVALID_DESCRIPTOR');
    }
    expect(() => optionalUnknown(optional(oneOf('safe')))).toThrow(
      'INVALID_DESCRIPTOR'
    );
  });

  test.each([
    ['event name', { 'patient Jane': { value: oneOf('safe') } }],
    ['property name', { event: { 'patient Jane': oneOf('safe') } }],
  ])('rejects an invalid structural %s', (_kind, definition) => {
    expect(() => defineUnknown(definition)).toThrow();
  });

  test('rejects symbol definition keys', () => {
    const properties: Record<PropertyKey, unknown> = { value: oneOf('safe') };
    properties[Symbol('patient Jane')] = oneOf('unsafe');

    expect(() => defineUnknown({ event: properties })).toThrow(
      'INVALID_PROPERTY_NAME'
    );
  });

  test('rejects definition accessors without invoking them', () => {
    let getterCalls = 0;
    const properties = {};
    Object.defineProperty(properties, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return oneOf('safe');
      },
    });

    expect(() => defineUnknown({ event: properties })).toThrow(
      'INVALID_PROPERTY_DEFINITION'
    );
    expect(getterCalls).toBe(0);
  });

  test('translates hostile definition errors without reading their messages', () => {
    const definition = new Proxy(
      {},
      {
        ownKeys() {
          throw new TypeError('JANE_DOE_DIAGNOSIS');
        },
      }
    );

    expect(() => defineUnknown(definition)).toThrow('INVALID_EVENT_DEFINITION');
    expect(() => defineUnknown(definition)).not.toThrow('JANE_DOE_DIAGNOSIS');
  });

  test('does not trust an exposed schema error when a proxy replays it', () => {
    let exposed: unknown;
    try {
      defineEvents({});
    } catch (error) {
      exposed = error;
    }
    if (!(exposed instanceof TypeError)) throw new Error('expected TypeError');
    exposed.message = 'JANE_DOE_DIAGNOSIS';

    const definition = new Proxy(
      {},
      {
        ownKeys() {
          throw exposed;
        },
      }
    );

    expect(() => defineUnknown(definition)).toThrow('INVALID_EVENT_DEFINITION');
    expect(() => defineUnknown(definition)).not.toThrow('JANE_DOE_DIAGNOSIS');
  });

  test('shares normalized copies when a descriptor is reused', () => {
    const shared = oneOf('safe', 'ready');
    const sharedOptional = optional(shared);
    const events = defineEvents({
      first: {
        first_value: shared,
        second_value: shared,
        first_optional: sharedOptional,
        second_optional: sharedOptional,
      },
      second: { value: shared },
    });

    expect(events.schema.first.first_value).toBe(
      events.schema.first.second_value
    );
    expect(events.schema.first.first_value).toBe(events.schema.second.value);
    expect(events.schema.first.first_optional).toBe(
      events.schema.first.second_optional
    );
    expect(events.schema.first.first_optional.value).toBe(
      events.schema.first.first_value
    );
  });

  test('copies and recursively freezes caller-owned definition data', () => {
    const channels = ['search', 'referral'];
    const descriptor = oneOf(...channels);
    const source = {
      appointment_booked: { via: descriptor },
    };
    const events = defineEvents(source);

    channels[0] = 'PHI-mutated-channel';
    const replacementMembers = ['PHI-replacement'];
    source.appointment_booked.via = oneOf(...replacementMembers);

    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(events.schema)).toBe(true);
    expect(Object.isFrozen(events.schema.appointment_booked)).toBe(true);
    expect(Object.isFrozen(events.schema.appointment_booked.via)).toBe(true);
    expect(Object.isFrozen(events.schema.appointment_booked.via.values)).toBe(
      true
    );
    expect(
      events.validate('appointment_booked', { via: 'search' })
    ).toMatchObject({ ok: true });
    expect(
      events.validate('appointment_booked', { via: 'PHI-mutated-channel' })
    ).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
      property: 'via',
    });
  });

  test('cannot be mutated through the returned artifact', () => {
    const events = makeEvents();
    const writable = events.schema.screen_view.name
      .values as unknown as string[];

    expect(() => writable.push('PHI-injected-screen')).toThrow();
    expect(
      events.validate('screen_view', { name: 'PHI-injected-screen' })
    ).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
      property: 'name',
    });
  });
});

describe('analytics runtime validator', () => {
  test('accepts a complete event and returns correlated validated data', () => {
    const properties = {
      clinic_type: 'gp',
      lead_time_days: 30,
      via: 'search',
    };

    expect(makeEvents().validate('appointment_booked', properties)).toEqual({
      ok: true,
      eventName: 'appointment_booked',
      properties,
    });
  });

  test('returns a frozen snapshot that cannot change after validation', () => {
    const source = { name: 'Home' };
    const result = makeEvents().validate('screen_view', source);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('expected validation success');

    source.name = 'Jane-Doe-Chart';
    expect(Object.getPrototypeOf(result.properties)).toBeNull();
    expect(Object.isFrozen(result.properties)).toBe(true);
    expect(result.properties).toEqual({ name: 'Home' });

    const writable = result.properties as unknown as { name: string };
    expect(() => {
      writable.name = 'patient@example.com';
    }).toThrow();
    expect(result.properties).toEqual({ name: 'Home' });
  });

  test('validates omission, presence, and the value of an optional property', () => {
    const events = makeEvents();
    const required = {
      clinic_type: 'gp',
      lead_time_days: 30,
      via: 'search',
    };

    expect(events.validate('appointment_booked', required)).toMatchObject({
      ok: true,
    });
    expect(
      events.validate('appointment_booked', {
        ...required,
        note_kind: 'staff-authored',
      })
    ).toEqual({
      ok: true,
      eventName: 'appointment_booked',
      properties: { ...required, note_kind: 'staff-authored' },
    });
    expect(
      events.validate('appointment_booked', {
        ...required,
        note_kind: 'patient-entered',
      })
    ).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
      property: 'note_kind',
    });
  });

  test('rejects an unknown event with a non-reflective failure', () => {
    expect(makeEvents().validate('patient-Jane-Doe-diagnosis', {})).toEqual({
      ok: false,
      code: 'UNKNOWN_EVENT',
    });
  });

  test('rejects a missing property using only the schema-owned name', () => {
    expect(
      makeEvents().validate('appointment_booked', {
        clinic_type: 'gp',
        via: 'search',
      })
    ).toEqual({
      ok: false,
      code: 'MISSING_PROPERTY',
      property: 'lead_time_days',
    });
  });

  test('rejects an extra property without reflecting its name', () => {
    expect(
      makeEvents().validate('appointment_booked', {
        'clinic_type': 'gp',
        'lead_time_days': 30,
        'via': 'search',
        'patient@example.com': 'diagnosis-sentinel',
      })
    ).toEqual({ ok: false, code: 'EXTRA_PROPERTY' });
  });

  test('rejects symbol and non-enumerable extra properties', () => {
    const symbolExtra: Record<PropertyKey, unknown> = {
      clinic_type: 'gp',
      lead_time_days: 30,
      via: 'search',
    };
    symbolExtra[Symbol('patient Jane')] = 'diagnosis-sentinel';

    const hiddenExtra = {
      clinic_type: 'gp',
      lead_time_days: 30,
      via: 'search',
    };
    Object.defineProperty(hiddenExtra, 'patient Jane', {
      value: 'diagnosis-sentinel',
      enumerable: false,
    });

    for (const properties of [symbolExtra, hiddenExtra]) {
      expect(makeEvents().validate('appointment_booked', properties)).toEqual({
        ok: false,
        code: 'EXTRA_PROPERTY',
      });
    }
  });

  test.each([
    [-1, false],
    [0, true],
    [1, true],
    [364, true],
    [365, true],
    [366, false],
    [1.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [Number.NEGATIVE_INFINITY, false],
    ['30', false],
    [true, false],
  ])('enforces the complete integer boundary matrix for %p', (value, valid) => {
    const result = makeEvents().validate('appointment_booked', {
      clinic_type: 'gp',
      lead_time_days: value,
      via: 'search',
    });

    if (valid) expect(result).toMatchObject({ ok: true });
    else
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_VALUE',
        property: 'lead_time_days',
      });
  });

  test('enforces enum membership', () => {
    expect(
      makeEvents().validate('appointment_booked', {
        clinic_type: 'gp',
        lead_time_days: 30,
        via: 'patient-referral-PHI',
      })
    ).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
      property: 'via',
    });
  });

  test('enforces screen registry membership', () => {
    expect(
      makeEvents().validate('screen_view', { name: 'Settings' })
    ).toMatchObject({ ok: true });
    expect(
      makeEvents().validate('screen_view', { name: 'Jane-Doe-Chart' })
    ).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
      property: 'name',
    });
  });

  test('enforces arbitrary named registry membership', () => {
    expect(
      makeEvents().validate('care_path_entered', { path: 'follow-up' })
    ).toMatchObject({ ok: true });
    expect(
      makeEvents().validate('care_path_entered', { path: 'patient-123' })
    ).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
      property: 'path',
    });
  });

  test.each([null, [], new Date(), 'not-an-object'])(
    'rejects malformed property containers %#',
    (properties) => {
      expect(makeEvents().validate('screen_view', properties)).toEqual({
        ok: false,
        code: 'INVALID_CONTAINER',
      });
    }
  );

  test('accepts a null-prototype own-property data record', () => {
    const properties = Object.create(null) as Record<string, unknown>;
    properties.name = 'Home';

    expect(makeEvents().validate('screen_view', properties)).toMatchObject({
      ok: true,
    });
  });

  test('rejects an accessor without invoking its getter', () => {
    let getterCalls = 0;
    const properties = {};
    Object.defineProperty(properties, 'name', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'Jane-Doe-Chart';
      },
    });

    expect(makeEvents().validate('screen_view', properties)).toEqual({
      ok: false,
      code: 'INVALID_CONTAINER',
    });
    expect(getterCalls).toBe(0);
  });

  test('uses property descriptors without invoking a proxy value-read trap', () => {
    let valueReads = 0;
    const properties = new Proxy(
      { name: 'Home' },
      {
        get(target, key, receiver) {
          valueReads += 1;
          return Reflect.get(target, key, receiver);
        },
      }
    );

    const result = makeEvents().validate('screen_view', properties);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('expected validation success');
    expect(result.properties).toEqual({ name: 'Home' });
    expect(Object.isFrozen(result.properties)).toBe(true);
    expect(valueReads).toBe(0);
  });

  test('contains thrown reflection failures without copying their messages', () => {
    const properties = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('Jane Doe diagnosis sentinel');
        },
      }
    );
    const result = makeEvents().validate('screen_view', properties);

    expect(result).toEqual({ ok: false, code: 'INVALID_CONTAINER' });
    expect(JSON.stringify(result)).not.toContain('Jane Doe');
    expect(JSON.stringify(result)).not.toContain('diagnosis sentinel');
  });
});

describe('analytics privacy markers', () => {
  test.each([
    ['gp', true],
    ['patient-diagnosis', false],
  ])('checks authentic public enum markers for %p', (value, valid) => {
    const result = makeEvents().validate('appointment_booked', {
      clinic_type: pub(value),
      lead_time_days: 30,
      via: 'search',
    });

    if (valid) expect(result).toMatchObject({ ok: true });
    else
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_VALUE',
        property: 'clinic_type',
      });
  });

  test.each([
    [pub(0), true],
    [pub(365), true],
    [pub(-1), false],
    [pub(366), false],
  ])('checks authentic public integer markers %#', (value, valid) => {
    const result = makeEvents().validate('appointment_booked', {
      clinic_type: 'gp',
      lead_time_days: value,
      via: 'search',
    });

    if (valid) expect(result).toMatchObject({ ok: true });
    else
      expect(result).toEqual({
        ok: false,
        code: 'INVALID_VALUE',
        property: 'lead_time_days',
      });
  });

  test.each([
    [
      'enum',
      () =>
        makeEvents().validate('appointment_booked', {
          clinic_type: pub(42),
          lead_time_days: 30,
          via: 'search',
        }),
      'clinic_type',
    ],
    [
      'integer',
      () =>
        makeEvents().validate('appointment_booked', {
          clinic_type: 'gp',
          lead_time_days: pub('30'),
          via: 'search',
        }),
      'lead_time_days',
    ],
    [
      'named string',
      () => makeEvents().validate('screen_view', { name: pub(true) }),
      'name',
    ],
  ])(
    'rejects wrong-kind public markers for %s constraints',
    (_kind, run, property) => {
      expect(run()).toEqual({ ok: false, code: 'INVALID_VALUE', property });
    }
  );

  test('makes private enum payloads observationally indistinguishable', () => {
    const results = ['gp', 'mental_health', 'Jane Doe diagnosis'].map((value) =>
      makeEvents().validate('appointment_booked', {
        clinic_type: priv(value),
        lead_time_days: 30,
        via: 'search',
      })
    );

    expect(results.map((result) => JSON.stringify(result))).toEqual([
      JSON.stringify(results[0]),
      JSON.stringify(results[0]),
      JSON.stringify(results[0]),
    ]);
    expect(results).toEqual(
      results.map(() =>
        expect.objectContaining({ ok: true, eventName: 'appointment_booked' })
      )
    );
  });

  test('makes private numeric payloads resistant to range probing', () => {
    const results = [-10_000, 0, 180, 365, 10_000].map((value) =>
      makeEvents().validate('appointment_booked', {
        clinic_type: 'gp',
        lead_time_days: priv(value),
        via: 'search',
      })
    );

    expect(results.map((result) => result.ok)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(
      1
    );
  });

  test('makes private primitive kinds indistinguishable across constraints', () => {
    const results = [
      makeEvents().validate('appointment_booked', {
        clinic_type: priv(42),
        lead_time_days: 30,
        via: 'search',
      }),
      makeEvents().validate('appointment_booked', {
        clinic_type: priv(true),
        lead_time_days: 30,
        via: 'search',
      }),
      makeEvents().validate('appointment_booked', {
        clinic_type: 'gp',
        lead_time_days: priv('not-a-number'),
        via: 'search',
      }),
      makeEvents().validate('appointment_booked', {
        clinic_type: 'gp',
        lead_time_days: priv(true),
        via: 'search',
      }),
      makeEvents().validate('screen_view', { name: priv(42) }),
      makeEvents().validate('screen_view', { name: priv(true) }),
    ];

    expect(results.map((result) => result.ok)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  test('rejects a forged privacy marker', () => {
    expect(
      makeEvents().validate('screen_view', {
        name: Object.freeze({ toString: () => '<redacted>' }),
      })
    ).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
      property: 'name',
    });
  });

  test('rejects authentic markers created from inadmissible primitives', () => {
    const invalid = priv({ patient: 'Jane Doe' } as unknown as LogPrimitive);

    expect(makeEvents().validate('screen_view', { name: invalid })).toEqual({
      ok: false,
      code: 'INVALID_VALUE',
      property: 'name',
    });
  });

  test.each([
    ['unknown event', () => makeEvents().validate('Jane-Doe-event', {})],
    [
      'extra property',
      () =>
        makeEvents().validate('screen_view', {
          'name': 'Home',
          'patient@example.com': 'bipolar-diagnosis',
        }),
    ],
    [
      'invalid value',
      () => makeEvents().validate('screen_view', { name: 'Jane-Doe-Chart' }),
    ],
  ])('never serializes PHI from a %s failure', (_family, run) => {
    const serialized = JSON.stringify(failure(run()));

    expect(serialized).not.toMatch(
      /Jane|patient@example\.com|bipolar|diagnosis|Chart/
    );
  });
});

describe('analytics package surface', () => {
  test('publishes source, CommonJS, ESM, and declaration conditions', () => {
    const manifest = packageManifest as unknown as {
      exports: Record<string, unknown>;
    };

    expect(manifest.exports['./analytics']).toEqual({
      'react-native-nitro-logger-source': './src/analytics.ts',
      'require': {
        types: './lib/typescript/commonjs/src/analytics.d.ts',
        default: './lib/commonjs/analytics.js',
      },
      'import': {
        types: './lib/typescript/module/src/analytics.d.ts',
        default: './lib/module/analytics.js',
      },
      'default': './lib/module/analytics.js',
    });
  });

  test('publishes the source path alias used by local consumers', () => {
    const config = typescriptConfig as unknown as {
      compilerOptions: { paths: Record<string, string[]> };
    };

    expect(
      config.compilerOptions.paths['react-native-nitro-logger/analytics']
    ).toEqual(['./src/analytics']);
  });
});
