import {
  defineEvents,
  int,
  namedString,
  oneOf,
  optional,
} from '../src/analytics';

const makeEvents = () =>
  defineEvents({
    appointment_booked: {
      clinic_type: oneOf('gp', 'specialist'),
      lead_time_days: int({ min: 0, max: 365 }),
      via: oneOf('search', 'referral'),
      note_kind: optional(oneOf('none', 'staff-authored')),
    },
    care_path_entered: {
      path: namedString('care-path', 'intake', 'follow-up'),
    },
  });

describe('defineEvents lint artifact', () => {
  test('emits a distinct versioned artifact over the authoritative grammar', () => {
    const events = makeEvents();

    expect(events.lint).toEqual({
      formatVersion: 1,
      grammar: events.grammar,
    });
    expect(events.lint.grammar).toBe(events.grammar);
    expect(Object.isFrozen(events.lint)).toBe(true);
    expect(Object.isFrozen(events.lint.grammar)).toBe(true);
  });

  test('is recursively immutable through the shared grammar', () => {
    const events = makeEvents();
    const writableEvents = events.lint.grammar.events as unknown as unknown[];
    const writableProperties = events.lint.grammar.events[0]!
      .properties as unknown as unknown[];

    expect(() => writableEvents.push({})).toThrow();
    expect(() => writableProperties.push({})).toThrow();
    expect(
      (events.lint as unknown as Record<string, unknown>).grammarJSON
    ).toBeUndefined();
    expect(events.grammarJSON).toBe(JSON.stringify(events.lint.grammar));
  });

  test('contains schema-authored names and constraints but no caller data', () => {
    const events = makeEvents();
    const serialized = JSON.stringify(events.lint);

    events.validate('appointment_booked', {
      clinic_type: 'gp',
      lead_time_days: 3,
      via: 'search',
      patient_name: 'Jane',
      email: 'patient@example.com',
      note: 'diagnosis',
    });
    const afterValidation = JSON.stringify(events.lint);

    expect(serialized).toContain('appointment_booked');
    expect(serialized).toContain('lead_time_days');
    expect(afterValidation).toBe(serialized);
    expect(afterValidation).not.toMatch(/Jane|patient@example\.com|diagnosis/);
  });

  test('is deterministic when authored event and property order differs', () => {
    const first = defineEvents({
      beta: { second: oneOf('y', 'x'), first: int({ min: 0, max: 1 }) },
      alpha: { value: oneOf('ready') },
    });
    const second = defineEvents({
      alpha: { value: oneOf('ready') },
      beta: { first: int({ min: 0, max: 1 }), second: oneOf('y', 'x') },
    });

    expect(first.lint).toMatchObject({ formatVersion: 1 });
    expect(second.lint).toMatchObject({ formatVersion: 1 });
    expect(first.lint).toEqual(second.lint);
    expect(JSON.stringify(first.lint)).toBe(JSON.stringify(second.lint));
  });
});
