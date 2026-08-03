import {
  defineEvents,
  int,
  namedString,
  oneOf,
  optional,
  screenName,
} from '../../src/analytics';
import type {
  AnalyticsGrammar,
  AnalyticsGrammarConstraint,
  AnalyticsGrammarEvent,
  AnalyticsGrammarProperty,
  AnalyticsGrammarV1,
  AnalyticsLintArtifactV1,
  EventName,
  EventProperties,
  ValidationResult,
} from '../../src/analytics';
import { priv, pub } from '../../src/privacy';
import type { PrivateValue, PublicValue } from '../../src/privacy';

const consume = (...values: readonly unknown[]): number => values.length;

const events = defineEvents({
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

const grammar: AnalyticsGrammar = events.grammar;
const grammarV1: AnalyticsGrammarV1 = events.grammar;
const grammarEvent: AnalyticsGrammarEvent = grammar.events[0]!;
const grammarProperty: AnalyticsGrammarProperty = grammarEvent.properties[0]!;
const grammarConstraint: AnalyticsGrammarConstraint =
  grammarProperty.constraint;
const grammarJSON: string = events.grammarJSON;
const lint: AnalyticsLintArtifactV1 = events.lint;
consume(
  grammar,
  grammarV1,
  grammarEvent,
  grammarProperty,
  grammarConstraint,
  grammarJSON,
  lint
);

// @ts-expect-error the format version is immutable
events.grammar.formatVersion = 2;
// @ts-expect-error the closed-world flag is immutable
events.grammar.additionalEvents = true;
// @ts-expect-error grammar event arrays are immutable
events.grammar.events.push(grammarEvent);
// @ts-expect-error grammar event records are immutable
grammarEvent.name = 'replacement';
// @ts-expect-error grammar property records are immutable
grammarProperty.required = false;
if (grammarConstraint.type === 'enum') {
  // @ts-expect-error constraint member arrays are immutable
  grammarConstraint.values.push('replacement');
}
// @ts-expect-error the authoritative grammar bytes are immutable
events.grammarJSON = '{}';
// @ts-expect-error the lint artifact format is immutable
events.lint.formatVersion = 2;
// @ts-expect-error the lint artifact grammar is immutable
events.lint.grammar = grammar;

type Events = typeof events;
type Names = EventName<Events>;

const name: Names = 'appointment_booked';
consume(name);

// @ts-expect-error unknown event names are not part of the inferred union
const unknownName: Names = 'appointment_cancelled';
consume(unknownName);

const accept = <Name extends EventName<Events>>(
  _name: Name,
  _properties: EventProperties<Events, Name>
): void => undefined;

accept('appointment_booked', {
  clinic_type: 'gp',
  lead_time_days: 30,
  via: 'search',
});

accept('appointment_booked', {
  clinic_type: pub('specialist'),
  lead_time_days: priv(90),
  via: priv('rebook'),
  note_kind: pub('staff-authored'),
});

accept('screen_view', { name: pub('Settings') });
accept('screen_view', { name: priv('Home') });
accept('care_path_entered', { path: 'follow-up' });

// @ts-expect-error an unknown event is rejected
accept('appointment_cancelled', {});

// @ts-expect-error a required property is missing
accept('appointment_booked', {
  clinic_type: 'gp',
  via: 'search',
});

accept('appointment_booked', {
  clinic_type: 'gp',
  lead_time_days: 30,
  via: 'search',
  // @ts-expect-error extra properties are rejected
  patient_name: 'Jane Doe',
});

accept('appointment_booked', {
  // @ts-expect-error enum members remain exact
  clinic_type: 'walk-in',
  lead_time_days: 30,
  via: 'search',
});

accept('appointment_booked', {
  // @ts-expect-error public wrappers preserve their primitive member
  clinic_type: pub('walk-in'),
  lead_time_days: 30,
  via: 'search',
});

accept('appointment_booked', {
  // @ts-expect-error private wrappers preserve their primitive member
  clinic_type: priv('walk-in'),
  lead_time_days: 30,
  via: 'search',
});

accept('appointment_booked', {
  clinic_type: 'gp',
  // @ts-expect-error wrong primitive kinds are rejected
  lead_time_days: '30',
  via: 'search',
});

accept('appointment_booked', {
  clinic_type: 'gp',
  // @ts-expect-error wrapper primitive kinds must match the descriptor
  lead_time_days: pub('30'),
  via: 'search',
});

accept('screen_view', {
  // @ts-expect-error named string registries infer their exact members
  name: 'PatientChart',
});

accept('care_path_entered', {
  // @ts-expect-error each named registry retains its own exact members
  path: 'Home',
});

const unknownEvent: unknown = 'appointment_booked';
const unknownProperties: unknown = {
  clinic_type: 'gp',
  lead_time_days: 30,
  via: 'search',
};
const validation = events.validate(unknownEvent, unknownProperties);
type IsTopType<Value> = 0 extends 1 & Value ? true : false;
const validationIsTopType: IsTopType<typeof validation> = false;
const exactValidation: ValidationResult<Events> = validation;
consume(validationIsTopType, exactValidation);

if (validation.ok) {
  if (validation.eventName === 'appointment_booked') {
    const days: number | PublicValue<number> | PrivateValue<number> =
      validation.properties.lead_time_days;
    const clinic:
      | 'gp'
      | 'specialist'
      | 'mental_health'
      | PublicValue<'gp' | 'specialist' | 'mental_health'>
      | PrivateValue<'gp' | 'specialist' | 'mental_health'> =
      validation.properties.clinic_type;
    consume(days, clinic);

    // @ts-expect-error correlated success excludes another event's fields
    validation.properties.name;
  }

  if (validation.eventName === 'screen_view') {
    const screen = validation.properties.name;
    consume(screen);

    // @ts-expect-error event-name correlation excludes appointment fields
    validation.properties.lead_time_days;
  }
} else {
  const code:
    | 'UNKNOWN_EVENT'
    | 'INVALID_CONTAINER'
    | 'EXTRA_PROPERTY'
    | 'MISSING_PROPERTY'
    | 'INVALID_VALUE' = validation.code;
  consume(code);

  // @ts-expect-error failures never expose rejected caller-controlled values
  validation.value;
}

// @ts-expect-error unknown input stays unknown outside the validated result
unknownProperties.lead_time_days;
