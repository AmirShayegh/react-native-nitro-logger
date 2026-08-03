import {
  defineEvents,
  int,
  namedString,
  oneOf,
  optional,
} from '../../src/analytics';
import type { EventName, EventProperties } from '../../src/analytics';

export const goldenArtifact = defineEvents({
  appointment_booked: {
    clinic_type: oneOf('gp', 'specialist'),
    lead_time_days: int({ min: 0, max: 365 }),
    note_kind: optional(oneOf('none', 'staff-authored')),
  },
  care_path_entered: {
    path: namedString('care-path', 'intake', 'follow-up'),
  },
  screen_view: {
    name: namedString('screen', 'Home', 'Appointments'),
  },
});

type Artifact = typeof goldenArtifact;
type RejectionCode =
  | 'UNKNOWN_EVENT'
  | 'INVALID_CONTAINER'
  | 'EXTRA_PROPERTY'
  | 'MISSING_PROPERTY'
  | 'INVALID_VALUE';

type JSONValue =
  | null
  | boolean
  | number
  | string
  | readonly JSONValue[]
  | { readonly [key: string]: JSONValue };

interface GoldenVector {
  readonly id: string;
  readonly family: string;
  readonly positiveControl: string | null;
  readonly eventName: string;
  readonly properties: JSONValue;
  readonly expected:
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly code: RejectionCode;
        readonly property?: string;
      };
}

type ExactProperties<Expected, Actual> = Actual &
  Record<Exclude<keyof Actual, keyof Expected>, never>;

const acceptTyped = <
  Name extends EventName<Artifact>,
  const Properties extends EventProperties<Artifact, Name>,
>(
  _eventName: Name,
  _properties: ExactProperties<EventProperties<Artifact, Name>, Properties>
): void => undefined;

const appointment = {
  clinic_type: 'gp',
  lead_time_days: 30,
} as const;
const appointmentWithNote = {
  ...appointment,
  note_kind: 'staff-authored',
} as const;
const screen = { name: 'Home' } as const;
const carePath = { path: 'follow-up' } as const;
const unknownEvent = 'appointment_cancelled' as const;
const invalidContainer = null;
const appointmentMissingRequired = { clinic_type: 'gp' } as const;
const appointmentWithExtra = {
  ...appointment,
  patient_name: 'Jane Doe',
} as const;
const appointmentWithInvalidEnum = {
  ...appointment,
  clinic_type: 'walk-in',
} as const;
const appointmentWithInvalidIntegerPrimitive = {
  ...appointment,
  lead_time_days: '30',
} as const;
const appointmentBelowLowerBound = {
  ...appointment,
  lead_time_days: -1,
} as const;
const appointmentAtLowerBound = {
  ...appointment,
  lead_time_days: 0,
} as const;
const appointmentAtUpperBound = {
  ...appointment,
  lead_time_days: 365,
} as const;
const appointmentAboveUpperBound = {
  ...appointment,
  lead_time_days: 366,
} as const;
const appointmentWithFraction = {
  ...appointment,
  lead_time_days: 1.5,
} as const;
const invalidCarePath = { path: 'patient-123' } as const;
const appointmentWithInvalidNote = {
  ...appointment,
  note_kind: 'patient-entered',
} as const;

acceptTyped('appointment_booked', appointment);
acceptTyped('appointment_booked', appointmentWithNote);
acceptTyped('screen_view', screen);
acceptTyped('care_path_entered', carePath);

// Each structural rejection below is a compile-time failure as well as a
// runtime/grammar vector. Keep the directives local so a widened public type
// makes `tsc` fail with an unused directive instead of silently weakening the
// golden gate.
// @ts-expect-error unknown event names are outside the closed event union
acceptTyped(unknownEvent, screen);
// @ts-expect-error event properties must be an object of the inferred shape
acceptTyped('screen_view', invalidContainer);
// @ts-expect-error required properties remain required
acceptTyped('appointment_booked', appointmentMissingRequired);
// @ts-expect-error free-form properties are outside the closed object type
acceptTyped('appointment_booked', appointmentWithExtra);
// @ts-expect-error enum members remain exact string literals
acceptTyped('appointment_booked', appointmentWithInvalidEnum);
// @ts-expect-error integer properties reject the wrong primitive type
acceptTyped('appointment_booked', appointmentWithInvalidIntegerPrimitive);
// @ts-expect-error named registries remain exact string literals
acceptTyped('care_path_entered', invalidCarePath);
// @ts-expect-error optional properties retain their exact member type
acceptTyped('appointment_booked', appointmentWithInvalidNote);

// TypeScript intentionally models bounded integers as `number`; the emitted
// runtime validator and grammar independently enforce range and integrality.
acceptTyped('appointment_booked', appointmentBelowLowerBound);
acceptTyped('appointment_booked', appointmentAboveUpperBound);
acceptTyped('appointment_booked', appointmentWithFraction);

export const goldenVectors = [
  {
    id: 'event-known',
    family: 'event-name',
    positiveControl: null,
    eventName: 'screen_view',
    properties: screen,
    expected: { ok: true },
  },
  {
    id: 'event-unknown',
    family: 'event-name',
    positiveControl: 'event-known',
    eventName: unknownEvent,
    properties: screen,
    expected: { ok: false, code: 'UNKNOWN_EVENT' },
  },
  {
    id: 'container-record',
    family: 'container',
    positiveControl: null,
    eventName: 'screen_view',
    properties: screen,
    expected: { ok: true },
  },
  {
    id: 'container-null',
    family: 'container',
    positiveControl: 'container-record',
    eventName: 'screen_view',
    properties: invalidContainer,
    expected: { ok: false, code: 'INVALID_CONTAINER' },
  },
  {
    id: 'properties-exact',
    family: 'closed-properties',
    positiveControl: null,
    eventName: 'appointment_booked',
    properties: appointment,
    expected: { ok: true },
  },
  {
    id: 'properties-extra',
    family: 'closed-properties',
    positiveControl: 'properties-exact',
    eventName: 'appointment_booked',
    properties: appointmentWithExtra,
    expected: { ok: false, code: 'EXTRA_PROPERTY' },
  },
  {
    id: 'required-present',
    family: 'required-property',
    positiveControl: null,
    eventName: 'appointment_booked',
    properties: appointment,
    expected: { ok: true },
  },
  {
    id: 'required-missing',
    family: 'required-property',
    positiveControl: 'required-present',
    eventName: 'appointment_booked',
    properties: appointmentMissingRequired,
    expected: {
      ok: false,
      code: 'MISSING_PROPERTY',
      property: 'lead_time_days',
    },
  },
  {
    id: 'enum-member',
    family: 'enum',
    positiveControl: null,
    eventName: 'appointment_booked',
    properties: appointment,
    expected: { ok: true },
  },
  {
    id: 'enum-nonmember',
    family: 'enum',
    positiveControl: 'enum-member',
    eventName: 'appointment_booked',
    properties: appointmentWithInvalidEnum,
    expected: {
      ok: false,
      code: 'INVALID_VALUE',
      property: 'clinic_type',
    },
  },
  {
    id: 'integer-primitive-number',
    family: 'integer-primitive',
    positiveControl: null,
    eventName: 'appointment_booked',
    properties: appointment,
    expected: { ok: true },
  },
  {
    id: 'integer-primitive-string',
    family: 'integer-primitive',
    positiveControl: 'integer-primitive-number',
    eventName: 'appointment_booked',
    properties: appointmentWithInvalidIntegerPrimitive,
    expected: {
      ok: false,
      code: 'INVALID_VALUE',
      property: 'lead_time_days',
    },
  },
  {
    id: 'integer-at-lower-bound',
    family: 'integer-lower-bound',
    positiveControl: null,
    eventName: 'appointment_booked',
    properties: appointmentAtLowerBound,
    expected: { ok: true },
  },
  {
    id: 'integer-below-lower-bound',
    family: 'integer-lower-bound',
    positiveControl: 'integer-at-lower-bound',
    eventName: 'appointment_booked',
    properties: appointmentBelowLowerBound,
    expected: {
      ok: false,
      code: 'INVALID_VALUE',
      property: 'lead_time_days',
    },
  },
  {
    id: 'integer-at-upper-bound',
    family: 'integer-upper-bound',
    positiveControl: null,
    eventName: 'appointment_booked',
    properties: appointmentAtUpperBound,
    expected: { ok: true },
  },
  {
    id: 'integer-above-upper-bound',
    family: 'integer-upper-bound',
    positiveControl: 'integer-at-upper-bound',
    eventName: 'appointment_booked',
    properties: appointmentAboveUpperBound,
    expected: {
      ok: false,
      code: 'INVALID_VALUE',
      property: 'lead_time_days',
    },
  },
  {
    id: 'integer-integral',
    family: 'integer-integrality',
    positiveControl: null,
    eventName: 'appointment_booked',
    properties: appointment,
    expected: { ok: true },
  },
  {
    id: 'integer-fractional',
    family: 'integer-integrality',
    positiveControl: 'integer-integral',
    eventName: 'appointment_booked',
    properties: appointmentWithFraction,
    expected: {
      ok: false,
      code: 'INVALID_VALUE',
      property: 'lead_time_days',
    },
  },
  {
    id: 'named-string-member',
    family: 'named-string',
    positiveControl: null,
    eventName: 'care_path_entered',
    properties: carePath,
    expected: { ok: true },
  },
  {
    id: 'named-string-nonmember',
    family: 'named-string',
    positiveControl: 'named-string-member',
    eventName: 'care_path_entered',
    properties: invalidCarePath,
    expected: { ok: false, code: 'INVALID_VALUE', property: 'path' },
  },
  {
    id: 'optional-omitted',
    family: 'optional-omission',
    positiveControl: null,
    eventName: 'appointment_booked',
    properties: appointment,
    expected: { ok: true },
  },
  {
    id: 'optional-member',
    family: 'optional-value',
    positiveControl: null,
    eventName: 'appointment_booked',
    properties: appointmentWithNote,
    expected: { ok: true },
  },
  {
    id: 'optional-nonmember',
    family: 'optional-value',
    positiveControl: 'optional-member',
    eventName: 'appointment_booked',
    properties: appointmentWithInvalidNote,
    expected: {
      ok: false,
      code: 'INVALID_VALUE',
      property: 'note_kind',
    },
  },
] as const satisfies readonly GoldenVector[];
