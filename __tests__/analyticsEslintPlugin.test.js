'use strict';

const { TextEncoder: Utf8Encoder } = require('util');
const { Linter, RuleTester } = require('eslint');
const tsParser = require('@typescript-eslint/parser');
const plugin = require('../eslint-plugin');
const utf8Encoder = new Utf8Encoder();
const utf8Bytes = (value) => utf8Encoder.encode(value).length;

const LINT_ARTIFACT = Object.freeze({
  formatVersion: 1,
  grammar: Object.freeze({
    artifact: 'react-native-nitro-logger/analytics-grammar',
    formatVersion: 1,
    additionalEvents: false,
    events: Object.freeze([
      Object.freeze({
        name: 'appointment_booked',
        additionalProperties: false,
        properties: Object.freeze([
          Object.freeze({
            name: 'clinic_type',
            required: true,
            constraint: Object.freeze({
              type: 'enum',
              values: Object.freeze(['gp', 'specialist']),
            }),
          }),
          Object.freeze({
            name: 'lead_time_days',
            required: true,
            constraint: Object.freeze({
              type: 'integer',
              minimum: 0,
              maximum: 365,
            }),
          }),
          Object.freeze({
            name: 'note_kind',
            required: false,
            constraint: Object.freeze({
              type: 'enum',
              values: Object.freeze(['none', 'staff-authored']),
            }),
          }),
          Object.freeze({
            name: 'via',
            required: true,
            constraint: Object.freeze({
              type: 'enum',
              values: Object.freeze(['search', 'referral']),
            }),
          }),
        ]),
      }),
      Object.freeze({
        name: 'care_path_entered',
        additionalProperties: false,
        properties: Object.freeze([
          Object.freeze({
            name: 'path',
            required: true,
            constraint: Object.freeze({
              type: 'named-string',
              registry: 'care-path',
              values: Object.freeze(['intake', 'follow-up']),
            }),
          }),
        ]),
      }),
    ]),
  }),
});

const OPTIONS = [{ lintArtifact: LINT_ARTIFACT }];

const missingRule = (messages) => ({
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        additionalProperties: true,
      },
    ],
    messages,
  },
  create() {
    return {};
  },
});

const typedRule =
  plugin.rules['typed-event-schema'] ??
  missingRule({
    computedProperty: 'missing implementation',
    duplicateProperty: 'missing implementation',
    dynamicEvent: 'missing implementation',
    invalidValue: 'missing implementation',
    missingProperty: 'missing implementation',
    opaqueProperties: 'missing implementation',
    spreadProperty: 'missing implementation',
    unanalyzable: 'missing implementation',
    unknownEvent: 'missing implementation',
    unknownProperty: 'missing implementation',
  });

const privacyRule =
  plugin.rules['require-event-privacy'] ??
  missingRule({
    invalidWrapper: 'missing implementation',
    unanalyzable: 'missing implementation',
    unbound: 'missing implementation',
    unwrapped: 'missing implementation',
  });

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const tsRuleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

const tsxRuleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const COMPLETE = "{ clinic_type: 'gp', lead_time_days: 3, via: 'search' }";

describe('typed-event-schema', () => {
  ruleTester.run('typed-event-schema', typedRule, {
    valid: [
      {
        code: `analytics.track('appointment_booked', ${COMPLETE});`,
        options: OPTIONS,
      },
      {
        code:
          "const EVENT = 'appointment_booked'; " +
          "const properties = Object.freeze({ clinic_type: 'specialist', lead_time_days: 0, via: 'referral', note_kind: 'none' }); " +
          'analytics.track(EVENT, properties);',
        options: OPTIONS,
      },
      {
        code: "analytics.track('care_path_entered', { path: 'follow-up' });",
        options: OPTIONS,
      },
      {
        code:
          "import { priv } from 'react-native-nitro-logger'; " +
          "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: priv(days), via: 'search' });",
        options: OPTIONS,
      },
      {
        code:
          'function createAnalytics() { return new Widget(); } ' +
          "const sink = createAnalytics(); sink.track('appointment_booked', { clinic_type: 'walk-in' });",
        options: OPTIONS,
      },
      {
        code:
          "import { createAnalytics } from './untrusted'; " +
          "const sink = createAnalytics(); sink.track('appointment_booked', { clinic_type: 'walk-in' });",
        options: OPTIONS,
      },
      {
        code:
          "import * as analyticsApi from './untrusted'; " +
          'const make = analyticsApi.createAnalytics; const sink = make(); ' +
          "sink.track('appointment_booked', { clinic_type: 'walk-in' });",
        options: OPTIONS,
      },
      {
        code:
          'function makeWidget() { return new Widget(); } let make; make = makeWidget; ' +
          "const sink = make(); sink.track('appointment_booked', { clinic_type: 'walk-in' });",
        options: OPTIONS,
      },
      {
        code:
          'const analytics = new Widget(); ' +
          'analytics.track(patient.event, { [patient.id]: patient.name });',
        options: OPTIONS,
      },
      {
        code:
          'const services = { tracker: new Widget() }; const alias = services; ' +
          'alias.tracker = new OtherWidget(); ' +
          'services.tracker.track(patient.event, { [patient.id]: patient.name });',
        options: OPTIONS,
      },
      {
        code:
          'let services = { tracker: new Widget() }; ' +
          'services = { tracker: new OtherWidget() }; ' +
          'services.tracker.track(patient.event, { [patient.id]: patient.name });',
        options: OPTIONS,
      },
      {
        code:
          'let analytics = new Widget(); analytics = new OtherWidget(); ' +
          'analytics.track(patient.event, { [patient.id]: patient.name });',
        options: OPTIONS,
      },
      {
        code:
          'const services = { tracker: new Widget() }; services.tracker = new OtherWidget(); ' +
          'services.tracker.track(patient.event, { [patient.id]: patient.name });',
        options: OPTIONS,
      },
      {
        code: `telemetry.track('appointment_booked', ${COMPLETE});`,
        options: OPTIONS,
      },
      {
        code:
          "import { createAnalytics } from '@/analytics'; " +
          `const sink = createAnalytics(config); sink.track('appointment_booked', ${COMPLETE});`,
        options: OPTIONS,
      },
    ],
    invalid: [
      {
        code: `analytics.track('Jane-Doe-event', ${COMPLETE});`,
        options: OPTIONS,
        errors: [{ messageId: 'unknownEvent' }],
      },
      {
        code: `analytics.track(eventName, ${COMPLETE});`,
        options: OPTIONS,
        errors: [{ messageId: 'dynamicEvent' }],
      },
      {
        code: "analytics.track('appointment_booked', { clinic_type: 'gp', via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'missingProperty' }],
      },
      {
        code: "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 3, via: 'search', patient_name: 'Jane' });",
        options: OPTIONS,
        errors: [{ messageId: 'unknownProperty' }],
      },
      {
        code: "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 3, via: 'search', [patient.id]: patient.name });",
        options: OPTIONS,
        errors: [{ messageId: 'computedProperty' }],
      },
      {
        code: "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 3, via: 'search', ...patient });",
        options: OPTIONS,
        errors: [{ messageId: 'spreadProperty' }],
      },
      {
        code: "analytics.track('appointment_booked', buildProperties(patient));",
        options: OPTIONS,
        errors: [{ messageId: 'opaqueProperties' }],
      },
      {
        code:
          "const properties = { clinic_type: 'gp', lead_time_days: 3, via: 'search' }; " +
          "consume(properties); analytics.track('appointment_booked', properties);",
        options: OPTIONS,
        errors: [{ messageId: 'opaqueProperties' }],
      },
      {
        code: "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 3, via: 'search', note_kind: 'none', note_kind: 'staff-authored' });",
        options: OPTIONS,
        errors: [{ messageId: 'duplicateProperty' }],
      },
      {
        code: "analytics.track('appointment_booked', { clinic_type: 'walk-in', lead_time_days: 3, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code: "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 366, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code: "analytics.track('care_path_entered', { path: 'Jane-Doe-Chart' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code: "const emit = analytics.track; emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          'let emit = widget.send; emit = analytics.track; ' +
          "emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code: "const { track: emit } = analytics; emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code: "analytics.track.call(analytics, 'appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          'const emit = analytics.track; ' +
          "emit.call(analytics, 'appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          "const emit = analytics.track.bind(analytics, 'appointment_booked'); " +
          "emit({ clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code: 'analytics.track.apply(analytics, args);',
        options: OPTIONS,
        errors: [{ messageId: 'unanalyzable' }],
      },
      {
        code: 'analytics.track(...args);',
        options: OPTIONS,
        errors: [{ messageId: 'unanalyzable' }],
      },
      {
        code: "class Tracker { #analytics; send() { this.#analytics?.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' }); } }",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          "import { createAnalytics as make } from 'react-native-nitro-logger/analytics'; " +
          "const sink = make(config); sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'const make = createAnalytics; const sink = make(config); ' +
          "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'let make; make = createAnalytics; const sink = make(config); ' +
          "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          "import * as analyticsApi from 'react-native-nitro-logger/analytics'; " +
          'const api = analyticsApi; const make = api.createAnalytics; ' +
          'const sink = make(config); ' +
          "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          "import * as analyticsApi from 'react-native-nitro-logger/analytics'; " +
          'let api; api = analyticsApi; const sink = api.createAnalytics(config); ' +
          "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'let analytics = new Widget(); analytics = createAnalytics(config); ' +
          "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'const services = { tracker: new Widget() }; services.tracker = createAnalytics(config); ' +
          "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'const services = { tracker: new Widget() }; const alias = services; ' +
          'alias.tracker = createAnalytics(config); ' +
          "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'let services = { tracker: new Widget() }; ' +
          'services = { tracker: createAnalytics(config) }; ' +
          "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'const services = { tracker: new Widget() }; let a = services; let b = a; ' +
          'a = b; b.tracker = createAnalytics(config); ' +
          "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code: "telemetry.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: [
          { lintArtifact: LINT_ARTIFACT, analyticsNames: ['telemetry'] },
        ],
        errors: [{ messageId: 'invalidValue' }],
      },
      {
        code:
          "import { createAnalytics } from '@/analytics'; " +
          "const sink = createAnalytics(config); sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
        options: [
          {
            lintArtifact: LINT_ARTIFACT,
            analyticsModules: [
              'react-native-nitro-logger/analytics',
              '@/analytics',
            ],
          },
        ],
        errors: [{ messageId: 'invalidValue' }],
      },
    ],
  });
});

describe('require-event-privacy', () => {
  ruleTester.run('require-event-privacy', privacyRule, {
    valid: [
      {
        code: `analytics.track('appointment_booked', ${COMPLETE});`,
        options: OPTIONS,
      },
      {
        code:
          'const THREE = 3; const VIA = `search`; ' +
          "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: THREE, via: VIA });",
        options: OPTIONS,
      },
      {
        code:
          "import { priv, pub as publicValue } from 'react-native-nitro-logger'; " +
          "analytics.track('appointment_booked', { clinic_type: publicValue(clinic), lead_time_days: priv(days), via: priv(channel) });",
        options: OPTIONS,
      },
      {
        code:
          "import { priv } from '@/privacy'; " +
          "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: priv(days), via: 'search' });",
        options: [
          {
            lintArtifact: LINT_ARTIFACT,
            privacyModules: ['react-native-nitro-logger', '@/privacy'],
          },
        ],
      },
      {
        code: "telemetry.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
      },
      {
        code:
          "import { createAnalytics } from '@/analytics'; " +
          "const sink = createAnalytics(config); sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
      },
      {
        code:
          "import * as analyticsApi from './untrusted'; " +
          'const make = analyticsApi.createAnalytics; const sink = make(config); ' +
          "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
      },
      {
        code:
          'const services = { tracker: new Widget() }; const alias = services; ' +
          'alias.tracker = new OtherWidget(); ' +
          "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
      },
      {
        code:
          'let services = { tracker: new Widget() }; ' +
          'services = { tracker: new OtherWidget() }; ' +
          "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
      },
      {
        code:
          'let make; let other = make; make = other; const sink = other(config); ' +
          "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
      },
      {
        code:
          'let api; let other = api; api = other; ' +
          'const sink = other.createAnalytics(config); ' +
          "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
      },
    ],
    invalid: [
      {
        code: "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code: "analytics.track('appointment_booked', { clinic_type: selectClinic(patient), lead_time_days: 3, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'let analytics = new Widget(); analytics = createAnalytics(config); ' +
          "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'const make = createAnalytics; const sink = make(config); ' +
          "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'let make; make = createAnalytics; const sink = make(config); ' +
          "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code:
          "import * as analyticsApi from 'react-native-nitro-logger/analytics'; " +
          'const api = analyticsApi; const make = api.createAnalytics; ' +
          'const sink = make(config); ' +
          "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code:
          "import * as analyticsApi from 'react-native-nitro-logger/analytics'; " +
          'let api; api = analyticsApi; const sink = api.createAnalytics(config); ' +
          "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'const services = { tracker: new Widget() }; services.tracker = createAnalytics(config); ' +
          "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'const services = { tracker: new Widget() }; const alias = services; ' +
          'function install() { alias.tracker = createAnalytics(config); } ' +
          'function send() { ' +
          "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' }); }",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code:
          "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
          'let services = { tracker: new Widget() }; ' +
          'function install() { services = { tracker: createAnalytics(config) }; } ' +
          'function send() { ' +
          "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' }); }",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code: "telemetry.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: [
          { lintArtifact: LINT_ARTIFACT, analyticsNames: ['telemetry'] },
        ],
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code:
          "import { createAnalytics } from '@/analytics'; " +
          "const sink = createAnalytics(config); sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
        options: [
          {
            lintArtifact: LINT_ARTIFACT,
            analyticsModules: [
              'react-native-nitro-logger/analytics',
              '@/analytics',
            ],
          },
        ],
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code: "function priv(value) { return value; } analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: priv(patient.days), via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code: "import { priv } from './untrusted'; analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: priv(patient.days), via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code: "import { priv } from 'react-native-nitro-logger'; function send(priv) { analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: priv(patient.days), via: 'search' }); }",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
      {
        code: "import { priv } from 'react-native-nitro-logger'; analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: priv(patient.days, extra), via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidWrapper' }],
      },
      {
        code: "import { priv } from 'react-native-nitro-logger'; analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: priv(...patient.days), via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidWrapper' }],
      },
      {
        code: "import { pub } from 'react-native-nitro-logger'; analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: pub(...patient.days), via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'invalidWrapper' }],
      },
      {
        code: "analytics.track('Jane-Doe-event', { clinic_type: 'gp', lead_time_days: 3, via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'unbound' }],
      },
      {
        code: "analytics.track('appointment_booked', buildProperties(patient));",
        options: OPTIONS,
        errors: [{ messageId: 'unanalyzable' }],
      },
      {
        code: 'analytics.track(...args);',
        options: OPTIONS,
        errors: [{ messageId: 'unanalyzable' }],
      },
      {
        code:
          "import { priv } from 'react-native-nitro-logger'; " +
          "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: priv(999), via: 'search' });",
        options: OPTIONS,
        errors: [{ messageId: 'unbound' }],
      },
    ],
  });
});

describe('typed event rules under TypeScript parsers', () => {
  tsRuleTester.run('typed-event-schema TypeScript', typedRule, {
    valid: [
      {
        code:
          "const event = 'appointment_booked' as const; " +
          "const properties = { clinic_type: 'gp', lead_time_days: 3, via: 'search' } satisfies Record<string, unknown>; " +
          'analytics.track(event, properties);',
        options: OPTIONS,
      },
      {
        code: "class Tracker { private analytics: any; send() { this.analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 3, via: 'search' }); } }",
        options: OPTIONS,
      },
    ],
    invalid: [
      {
        code: "class Tracker { private analytics: any; send() { this.analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' }); } }",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
    ],
  });

  tsRuleTester.run('require-event-privacy TypeScript', privacyRule, {
    valid: [
      {
        code: "class Tracker { private analytics!: any; send() { this.analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 3, via: 'search' }); } }",
        options: OPTIONS,
      },
    ],
    invalid: [
      {
        code: "class Tracker { private analytics!: any; send(patient: { days: number }) { this.analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' }); } }",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
    ],
  });

  tsxRuleTester.run('typed-event-schema TSX', typedRule, {
    valid: [
      {
        code: "const View = () => <Button onPress={() => analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 3, via: 'search' })} />;",
        options: OPTIONS,
      },
    ],
    invalid: [
      {
        code: "const View = () => <Button onPress={() => analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' })} />;",
        options: OPTIONS,
        errors: [{ messageId: 'invalidValue' }],
      },
    ],
  });

  tsxRuleTester.run('require-event-privacy TSX', privacyRule, {
    valid: [
      {
        code: "const View = () => <Button onPress={() => analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 3, via: 'search' })} />;",
        options: OPTIONS,
      },
    ],
    invalid: [
      {
        code: "const View = ({ patient }: Props) => <Button onPress={() => analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' })} />;",
        options: OPTIONS,
        errors: [{ messageId: 'unwrapped' }],
      },
    ],
  });
});

const verify = (code, rules) =>
  new Linter().verify(code, {
    plugins: { 'nitro-logger': plugin },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules,
  });

const verifyTypeScript = (code, rules) =>
  new Linter().verify(code, {
    plugins: { 'nitro-logger': plugin },
    languageOptions: {
      ecmaVersion: 2022,
      parser: tsParser,
      sourceType: 'module',
    },
    rules,
  });

const verifyScript = (code, rules) =>
  new Linter().verify(code, {
    plugins: { 'nitro-logger': plugin },
    languageOptions: { ecmaVersion: 2022, sourceType: 'script' },
    rules,
  });

const verifyWithAnalysisStats = (code) => {
  const { enableAnalysisStats } = require('../eslint-plugin/event-analysis');
  const stats = [];
  const instrumented = {
    ...plugin,
    rules: { ...plugin.rules },
  };
  for (const name of ['typed-event-schema', 'require-event-privacy']) {
    const rule = plugin.rules[name];
    instrumented.rules[name] = {
      ...rule,
      create(context) {
        stats.push(enableAnalysisStats(context));
        return rule.create(context);
      },
    };
  }
  const messages = new Linter().verify(code, {
    plugins: { 'nitro-logger': instrumented },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: plugin.eventRules(LINT_ARTIFACT),
  });
  return { messages, stats };
};

const mutableLintArtifact = () => JSON.parse(JSON.stringify(LINT_ARTIFACT));

const lintArtifactWith = (events) => ({
  formatVersion: 1,
  grammar: {
    artifact: 'react-native-nitro-logger/analytics-grammar',
    formatVersion: 1,
    additionalEvents: false,
    events,
  },
});

describe('event receiver provenance hardening', () => {
  const expected = ['invalidValue', 'unbound'];
  const invalidCall = (receiver = 'sink') =>
    `${receiver}.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });`;
  const dynamicCall = (receiver = 'sink') =>
    `${receiver}.track(patient.event, { [patient.id]: patient.name });`;
  const factoryImport =
    "import { createAnalytics } from 'react-native-nitro-logger/analytics'; ";

  const invalidMethodCall = (method) =>
    `${method}('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });`;
  const cyclicWarmOrders = [
    ['left then right', ['left', 'right']],
    ['right then left', ['right', 'left']],
  ];
  const cyclicProvenanceCases = [
    [
      'receiver aliases',
      (order) =>
        [
          'let left = analytics;',
          'let right = left;',
          'left = right;',
          ...order.map((name) => invalidCall(name)),
        ].join('\n'),
    ],
    [
      'method aliases',
      (order) =>
        [
          'let left = analytics.track;',
          'let right = left;',
          'left = right;',
          ...order.map((name) => invalidMethodCall(name)),
        ].join('\n'),
    ],
    [
      'named factory aliases',
      (order) =>
        [
          factoryImport,
          'let left = {};',
          'let right = left;',
          'left = right;',
          'left = createAnalytics;',
          'right = left;',
          ...order.map((name) => invalidCall(`${name}(config)`)),
        ].join('\n'),
    ],
    [
      'namespace aliases',
      (order) =>
        [
          "import * as analyticsApi from 'react-native-nitro-logger/analytics';",
          'let left = {};',
          'let right = left;',
          'left = right;',
          'left = analyticsApi;',
          'right = left;',
          ...order.map((name) =>
            invalidCall(`${name}.createAnalytics(config)`)
          ),
        ].join('\n'),
    ],
  ];

  test.each(
    cyclicProvenanceCases.flatMap(([kind, source]) =>
      cyclicWarmOrders.map(([orderName, order]) => [
        kind,
        orderName,
        source(order),
      ])
    )
  )(
    'fails closed for cyclic %s after warming %s',
    (_kind, _orderName, code) => {
      const diagnosticsByLine = new Map();
      for (const message of verify(code, plugin.eventRules(LINT_ARTIFACT))) {
        let diagnostics = diagnosticsByLine.get(message.line);
        if (!diagnostics) {
          diagnostics = [];
          diagnosticsByLine.set(message.line, diagnostics);
        }
        diagnostics.push(message.messageId);
      }
      expect([...diagnosticsByLine.values()]).toEqual([expected, expected]);
    }
  );

  test.each([
    [
      'receiver aliases',
      `const left = new Widget(); const right = left; ${invalidCall('right')}`,
    ],
    [
      'method aliases',
      `const left = widget.track; const right = left; ${invalidMethodCall('right')}`,
    ],
    [
      'named factory aliases',
      `const left = buildWidget; const right = left; ${invalidCall('right(config)')}`,
    ],
    [
      'namespace aliases',
      `const ordinary = { createAnalytics: buildWidget }; const left = ordinary; const right = left; ${invalidCall('right.createAnalytics(config)')}`,
    ],
  ])('keeps ordinary %s exempt', (_kind, code) => {
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test.each([
    ['literal computed', "analytics['track']", expected],
    [
      'concatenated computed',
      "analytics['tr' + 'ack']",
      ['unanalyzable', 'unanalyzable'],
    ],
    ['dynamic computed', 'analytics[method]', ['unanalyzable', 'unanalyzable']],
  ])('fails closed for a %s event method', (_name, callee, messages) => {
    const code = `${callee}('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });`;
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(messages);
  });

  test.each([
    ['constant computed', "services['tra' + 'cker']"],
    ['runtime computed', 'services[key]'],
  ])('fails closed for a %s receiver write', (_name, target) => {
    const code =
      factoryImport +
      'const services = { tracker: new Widget() }; ' +
      `${target} = createAnalytics(config); ` +
      invalidCall('services.tracker');
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['array spread', 'const [alias] = [...[services]];'],
    ['object spread', 'const { alias } = { ...{ alias: services } };'],
    [
      'named array spread',
      'const values = [services]; const [alias] = [...values];',
    ],
    [
      'named object spread',
      'const base = { alias: services }; const { alias } = { ...base };',
    ],
  ])('connects an alias through a statically known %s', (_name, alias) => {
    const code =
      factoryImport +
      'const services = { tracker: new Widget() }; ' +
      alias +
      'alias.tracker = createAnalytics(config); ' +
      invalidCall('services.tracker');
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each(['||=', '??='])(
    'connects a receiver alias installed with %s',
    (operator) => {
      const code =
        factoryImport +
        'const services = { tracker: new Widget() }; let alias; ' +
        `alias ${operator} services; ` +
        'alias.tracker = createAnalytics(config); ' +
        invalidCall('services.tracker');
      expect(
        verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
          (message) => message.messageId
        )
      ).toEqual(expected);
    }
  );

  test('connects a deferred logical-assignment receiver alias', () => {
    const code =
      factoryImport +
      'const services = { tracker: new Widget() }; let alias; ' +
      'function install() { alias ??= services; alias.tracker = createAnalytics(config); } ' +
      'install(); ' +
      invalidCall('services.tracker');
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'Object.defineProperty',
      "Object.defineProperty(services, 'tracker', { value: createAnalytics(config) });",
    ],
    [
      'Reflect.set',
      "Reflect.set(services, 'tracker', createAnalytics(config));",
    ],
    [
      'dynamic Object.defineProperty',
      'Object.defineProperty(services, key, { value: createAnalytics(config) });',
    ],
    [
      'dynamic Reflect.set',
      'Reflect.set(services, key, createAnalytics(config));',
    ],
    [
      'Reflect.set receiver argument',
      "Reflect.set({}, 'tracker', createAnalytics(config), services);",
    ],
    [
      'Reflect.defineProperty',
      "Reflect.defineProperty(services, 'tracker', { value: createAnalytics(config) });",
    ],
    [
      'Object.defineProperties',
      'Object.defineProperties(services, { tracker: { value: createAnalytics(config) } });',
    ],
    [
      'Object.setPrototypeOf',
      'Object.setPrototypeOf(services, { tracker: createAnalytics(config) });',
    ],
  ])('indexes a receiver installed through %s', (_name, install) => {
    const code =
      factoryImport +
      'const services = { tracker: new Widget() }; ' +
      install +
      invalidCall('services.tracker');
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    "Object.defineProperty(services, 'tracker', { value: new Widget() });",
    "Reflect.set(services, 'tracker', new Widget());",
    "Reflect.set({}, 'tracker', new Widget(), services);",
    "Reflect.defineProperty(services, 'tracker', { value: new Widget() });",
    'Object.defineProperties(services, { tracker: { value: new Widget() } });',
    'Object.setPrototypeOf(services, { tracker: new Widget() });',
  ])('keeps an ordinary built-in receiver install exempt', (install) => {
    const code =
      'const services = { tracker: new Widget() }; ' +
      install +
      dynamicCall('services.tracker');
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test.each([
    [
      'literal argument array',
      "Reflect.apply(analytics.track, analytics, ['appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' }]);",
    ],
    [
      'opaque argument array',
      'Reflect.apply(analytics.track, analytics, args);',
    ],
  ])('fails closed for Reflect.apply with a %s', (_name, code) => {
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['unanalyzable', 'unanalyzable']);
  });

  test('does not trust a shadowed Reflect.apply', () => {
    const code =
      'const Reflect = { apply: ordinary }; ' +
      'Reflect.apply(analytics.track, analytics, args);';
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test.each([
    [
      'asserted member assignment',
      '(services as any).tracker = createAnalytics(config);',
    ],
    [
      'non-null member assignment',
      'services!.tracker = createAnalytics(config);',
    ],
    [
      'asserted Object.assign target',
      'Object.assign(services as any, { tracker: createAnalytics(config) });',
    ],
  ])('normalizes a TypeScript %s', (_name, write) => {
    const code =
      factoryImport +
      'const services = { tracker: new Widget() }; ' +
      write +
      ' ' +
      invalidCall('services.tracker');
    expect(
      verifyTypeScript(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['array', 'const [sink] = [createAnalytics(config)];'],
    ['object', 'const { sink } = { sink: createAnalytics(config) };'],
    ['nested', 'const [{ sink }] = [{ sink: createAnalytics(config) }];'],
    ['default', 'const [sink = createAnalytics(config)] = values;'],
  ])('projects a %s-destructured receiver initializer', (_name, setup) => {
    const code = factoryImport + setup + ' ' + invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('projects an array-destructured event method', () => {
    const code =
      'const [emit] = [analytics.track]; ' +
      "emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });";
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('connects destructured receiver aliases to the same component', () => {
    const code =
      factoryImport +
      'const services = { tracker: new Widget() }; ' +
      'const [alias] = [services]; ' +
      'alias.tracker = createAnalytics(config); ' +
      invalidCall('services.tracker');
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'named object container',
      'const holder = { alias: services }; const { alias } = holder;',
    ],
    [
      'spread-produced object container',
      'const holder = { alias: services, ...unknown }; const { alias } = holder;',
    ],
    [
      'named array container',
      'const holder = [services]; const [alias] = holder;',
    ],
    [
      'named assignment container',
      'const holder = { alias: services }; let alias; ({ alias } = holder);',
    ],
  ])('connects a receiver alias from a %s', (_name, alias) => {
    const code =
      factoryImport +
      'const services = { tracker: new Widget() }; ' +
      alias +
      ' alias.tracker = createAnalytics(config); ' +
      invalidCall('services.tracker');
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('connects a member-extracted receiver alias to its source component', () => {
    const code =
      factoryImport +
      'const services = { tracker: new Widget() }; ' +
      'const holder = { service: services }; const alias = holder.service; ' +
      'alias.tracker = createAnalytics(config); ' +
      invalidCall('services.tracker');
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['direct member path', 'holder.alias.tracker = createAnalytics(config);'],
    [
      'Object.assign member path',
      'Object.assign(holder.alias, { tracker: createAnalytics(config) });',
    ],
  ])('connects a write through a %s', (_name, write) => {
    const code =
      factoryImport +
      'const services = { tracker: new Widget() }; ' +
      'const holder = { alias: services }; ' +
      write +
      invalidCall('services.tracker');
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('connects a write through a reassigned member path', () => {
    const code =
      factoryImport +
      'const services = { tracker: new Widget() }; ' +
      'const holder = { alias: new Widget() }; holder.alias = services; ' +
      'holder.alias.tracker = createAnalytics(config); ' +
      invalidCall('services.tracker');
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('resolves an event method held in a statically named container property', () => {
    const code =
      factoryImport +
      'const sink = createAnalytics(config); ' +
      'const handlers = { emit: sink.track.bind(sink) }; ' +
      "handlers.emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });";
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('fails closed when a container-held method is hidden by a spread', () => {
    const code =
      'const handlers = { emit: ordinary, ...unknown }; ' +
      "handlers.emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });";
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('does not classify a container-held method from a constructed receiver', () => {
    const code =
      'const widget = new Widget(); ' +
      'const handlers = { emit: widget.track.bind(widget) }; ' +
      'handlers.emit(patient.event, { [patient.id]: patient.name });';
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test.each([
    [
      'conditional initializer',
      'const emit = flag ? analytics.track : ordinary;',
    ],
    ['logical initializer', 'const emit = flag && analytics.track;'],
    [
      'conditional reassignment',
      'let emit; emit = flag ? analytics.track : ordinary;',
    ],
    [
      'bound conditional initializer',
      'const emit = flag ? analytics.track.bind(analytics) : ordinary;',
    ],
  ])('resolves a %s method alias', (_name, setup) => {
    const code =
      setup +
      " emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });";
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'direct captured method',
      'let sink = createAnalytics(config); const emit = sink.track; sink = new Widget();',
      'emit',
    ],
    [
      'container captured method',
      'let sink = createAnalytics(config); const handlers = { emit: sink.track }; sink = new Widget();',
      'handlers.emit',
    ],
  ])('classifies a %s at capture time', (_name, setup, callee) => {
    const code =
      factoryImport +
      setup +
      ` ${callee}('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });`;
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('does not reclassify an ordinary captured method after receiver replacement', () => {
    const code =
      factoryImport +
      'let sink = new Widget(); const emit = sink.track; sink = createAnalytics(config); ' +
      'emit(patient.event, { [patient.id]: patient.name });';
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test.each([
    [
      'named track property',
      'const handlers = { track: analytics.track }; const { track: emit } = handlers;',
    ],
    [
      'renamed bound property',
      'const handlers = { emit: analytics.track.bind(analytics) }; const { emit: send } = handlers; const emit = send;',
    ],
    [
      'named assignment property',
      'const handlers = { track: analytics.track }; let emit; ({ track: emit } = handlers);',
    ],
  ])('resolves a method destructured from a %s', (_name, setup) => {
    const code =
      setup +
      " emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });";
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'nested object declaration',
      'const { client: { track: emit } } = { client: analytics };',
    ],
    [
      'nested object assignment',
      'let emit; ({ client: { track: emit } } = { client: analytics });',
    ],
  ])('resolves a method from a %s', (_name, setup) => {
    const code =
      setup +
      " emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });";
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'named array spread',
      'const methods = [analytics.track]; const [emit] = [...methods];',
    ],
    [
      'named object spread',
      'const methods = { emit: analytics.track }; const { emit } = { ...methods };',
    ],
  ])('resolves an event method through a %s', (_name, setup) => {
    const code =
      setup +
      " emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });";
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('does not trust a method destructured from a constructed container', () => {
    const code =
      'const widget = new Widget(); const handlers = { track: widget.track }; ' +
      'const { track: emit } = handlers; ' +
      'emit(patient.event, { [patient.id]: patient.name });';
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test.each([
    [
      'private field initializer',
      'class C { #tracker = createAnalytics(config); send() { ' +
        invalidCall('this.#tracker') +
        ' } }',
      false,
    ],
    [
      'constructor assignment',
      'class C { #tracker; constructor() { this.#tracker = createAnalytics(config); } send() { ' +
        invalidCall('this.#tracker') +
        ' } }',
      false,
    ],
    [
      'TypeScript private field initializer',
      'class C { private tracker = createAnalytics(config); send() { ' +
        invalidCall('this.tracker') +
        ' } }',
      true,
    ],
  ])('resolves a trusted class %s', (_name, body, typescript) => {
    const lint = typescript ? verifyTypeScript : verify;
    expect(
      lint(factoryImport + body, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'JavaScript static private field',
      'class C { static #tracker = createAnalytics(config); static send() { ' +
        invalidCall('this.#tracker') +
        ' } }',
      false,
    ],
    [
      'JavaScript static private field through the class name',
      'class C { static #tracker = createAnalytics(config); static send() { ' +
        invalidCall('C.#tracker') +
        ' } }',
      false,
    ],
    [
      'TypeScript static private field',
      'class C { private static tracker = createAnalytics(config); static send() { ' +
        invalidCall('this.tracker') +
        ' } }',
      true,
    ],
    [
      'TypeScript static private field through the class name',
      'class C { private static tracker = createAnalytics(config); static send() { ' +
        invalidCall('C.tracker') +
        ' } }',
      true,
    ],
  ])('resolves a trusted %s', (_name, body, typescript) => {
    const lint = typescript ? verifyTypeScript : verify;
    expect(
      lint(factoryImport + body, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'conditional this alias',
      'const self = flag ? this : this;',
      'self.#tracker',
    ],
    ['destructured this alias', 'const [self] = [this];', 'self.#tracker'],
    [
      'mutable this alias',
      'let self = new Widget(); self = this;',
      'self.#tracker',
    ],
  ])('resolves a class field through a %s', (_name, alias, receiver) => {
    const code =
      factoryImport +
      `class C { #tracker = createAnalytics(config); send() { ${alias} ` +
      invalidCall(receiver) +
      ' } }';
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['receiver', 'const sink = await analytics;', 'sink'],
    ['factory result', 'const sink = await createAnalytics(config);', 'sink'],
  ])('preserves an awaited %s', (_name, setup, receiver) => {
    const code =
      factoryImport +
      `async function send() { ${setup} ${invalidCall(receiver)} }`;
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('preserves an awaited event method', () => {
    const code =
      "async function send() { const emit = await analytics.track; emit('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' }); }";
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['unanalyzable', 'unanalyzable']);
  });

  test('fails closed when await assimilates a thenable receiver', () => {
    const code =
      'async function send() { ' +
      'class Widget { then(resolve) { resolve(analytics); } } ' +
      'const sink = await new Widget(); ' +
      "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' }); " +
      '}';
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['unwrapped']);
  });

  test.each(['freeze', 'seal', 'preventExtensions'])(
    'preserves a trusted receiver through Object.%s',
    (method) => {
      const code =
        factoryImport +
        `const sink = Object.${method}(createAnalytics(config)); ` +
        invalidCall();
      expect(
        verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
          (message) => message.messageId
        )
      ).toEqual(expected);
    }
  );

  test('preserves a trusted event method through Object.freeze', () => {
    const code =
      'const emit = Object.freeze(analytics.track); ' +
      "emit('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });";
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['unwrapped']);
  });

  test.each([
    [
      'literal track property',
      'const methods = { track: analytics.track.bind(analytics) };',
      'methods',
    ],
    [
      'installed track property',
      'const methods = new Widget(); methods.track = analytics.track.bind(analytics);',
      'methods',
    ],
  ])('resolves a protected method from a %s', (_name, setup, receiver) => {
    const code = setup + ' ' + invalidCall(receiver);
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each(['freeze', 'seal', 'preventExtensions'])(
    'fails closed for a poisoned Object.%s receiver wrapper',
    (method) => {
      const code =
        `Object.${method} = () => analytics; ` +
        `const sink = Object.${method}(new Widget()); ` +
        invalidCall();
      expect(
        verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
          (message) => message.messageId
        )
      ).toEqual(expected);
    }
  );

  test('fails closed for a poisoned Object.freeze event method wrapper', () => {
    const code =
      'Object.freeze = () => analytics.track; ' +
      'const emit = Object.freeze(ordinary); ' +
      "emit('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });";
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['unanalyzable', 'unanalyzable']);
  });

  test('fails closed for a poisoned Object.freeze property object', () => {
    const code =
      "Object.freeze = () => ({ clinic_type: 'gp', lead_time_days: patient.days, via: 'search' }); " +
      "analytics.track('appointment_booked', Object.freeze({}));";
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['opaqueProperties', 'unanalyzable']);
  });

  test('fails closed for a poisoned Object.freeze class alias', () => {
    const code =
      factoryImport +
      'Object.freeze = (value) => value; ' +
      'class C { #tracker = new Widget(); send() { ' +
      'const self = Object.freeze(this); ' +
      'self.#tracker = createAnalytics(config); ' +
      invalidCall('this.#tracker') +
      ' } }';
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('keeps an ordinary class alias through untampered Object.freeze exempt', () => {
    const code =
      'class C { #tracker = new Widget(); send() { ' +
      'const self = Object.freeze(this); ' +
      dynamicCall('self.#tracker') +
      ' } }';
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test('fails closed for an Object identity wrapper poisoned through a mutable alias', () => {
    const code =
      'let O = Object; O.freeze = () => analytics; ' +
      'const sink = Object.freeze(new Widget()); ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['instance', 'const self = Object.freeze(this);', 'self.#tracker'],
    [
      'static',
      'const self = Object.freeze(this);',
      'self.#tracker',
      'static ',
      'static ',
    ],
  ])(
    'preserves an Object.freeze(this) %s class alias',
    (_name, alias, receiver, field = '', method = '') => {
      const code =
        factoryImport +
        `class C { ${field}#tracker = createAnalytics(config); ${method}send() { ${alias} ` +
        invalidCall(receiver) +
        ' } }';
      expect(
        verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
          (message) => message.messageId
        )
      ).toEqual(expected);
    }
  );

  test('does not trust a shadowed Object.freeze class alias', () => {
    const code =
      'const Object = { freeze() { return new Widget(); } }; ' +
      'class C { send() { const self = Object.freeze(this); ' +
      dynamicCall('self') +
      ' } }';
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['unanalyzable', 'unanalyzable']);
  });

  test.each([
    ['transparent', '{}'],
    ['trapping', '{ get() { return analytics.track; } }'],
  ])('fails closed for a %s Proxy receiver', (_name, handler) => {
    const code =
      factoryImport +
      `const sink = new Proxy(createAnalytics(config), ${handler}); ` +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('keeps an ordinary transparent Proxy exempt', () => {
    const code = 'const sink = new Proxy(new Widget(), {}); ' + dynamicCall();
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test('does not trust a shadowed Proxy constructor', () => {
    const code =
      'class Proxy { constructor() { return new Widget(); } } ' +
      'const sink = new Proxy(analytics, {}); ' +
      dynamicCall();
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test('fails closed for a replaced global Proxy constructor', () => {
    const code =
      'globalThis.Proxy = function () { return analytics; }; ' +
      'const sink = new Proxy(new Widget(), {}); ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('fails closed for a bound replaced global Proxy constructor', () => {
    const code =
      'globalThis.Proxy = function () { return analytics; }; ' +
      'const P = Proxy.bind(null); const sink = new P(new Widget(), {}); ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'Function.prototype.bind.call',
      'const P = Function.prototype.bind.call(Proxy, null);',
    ],
    ['Proxy.bind.call', 'const P = Proxy.bind.call(Proxy, null);'],
    [
      'Function.prototype.bind.apply',
      'const P = Function.prototype.bind.apply(Proxy, [null]);',
    ],
    [
      'Function call forwarding',
      'const P = Function.prototype.call.call(Function.prototype.bind, Proxy, null);',
    ],
    [
      'Reflect.apply forwarding',
      'const P = Reflect.apply(Function.prototype.bind, Proxy, [null]);',
    ],
    ['Object.freeze', 'const P = Object.freeze(Proxy);'],
    ['Object.seal', 'const P = Object.seal(Proxy);'],
    [
      'bound constructor arguments',
      'const P = Function.prototype.bind.call(Proxy, null, analytics, {});',
      '',
    ],
  ])(
    'recognizes a Proxy constructor through %s',
    (_name, setup, constructorArgs = 'analytics, {}') => {
      const code =
        `${setup} const sink = new P(${constructorArgs}); ` + invalidCall();
      expect(
        verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
          (message) => message.messageId
        )
      ).toEqual(expected);
    }
  );

  test('fails closed for a replaced Proxy.revocable factory', () => {
    const code =
      'Proxy.revocable = function () { return { proxy: analytics }; }; ' +
      'const sink = Proxy.revocable(new Widget(), {}).proxy; ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['an extracted alias', 'const rev = Proxy.revocable;', 'analytics, {}'],
    [
      'a destructured alias',
      'const { revocable: rev } = Proxy;',
      'analytics, {}',
    ],
    [
      'a bound alias',
      'const rev = Proxy.revocable.bind(Proxy);',
      'analytics, {}',
    ],
    [
      'an indirectly bound alias',
      'const rev = Function.prototype.bind.call(Proxy.revocable, Proxy);',
      'analytics, {}',
    ],
    [
      'an identity-wrapped alias',
      'const rev = Object.preventExtensions(Proxy.revocable);',
      'analytics, {}',
    ],
    [
      'bound factory arguments',
      'const rev = Proxy.revocable.bind(Proxy, analytics, {});',
      '',
    ],
  ])('recognizes Proxy.revocable through %s', (_name, setup, factoryArgs) => {
    const code =
      `${setup} const sink = rev(${factoryArgs}).proxy; ` + invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'Proxy.revocable.call',
      'Proxy.revocable.call(Proxy, analytics, {}).proxy',
    ],
    [
      'Proxy.revocable.apply',
      'Proxy.revocable.apply(Proxy, [analytics, {}]).proxy',
    ],
    [
      'Reflect.apply',
      'Reflect.apply(Proxy.revocable, Proxy, [analytics, {}]).proxy',
    ],
    [
      'Function call forwarding',
      'Function.prototype.call.call(Proxy.revocable, Proxy, analytics, {}).proxy',
    ],
    ['Reflect.construct', 'Reflect.construct(Proxy, [analytics, {}])'],
  ])('recognizes Proxy creation through %s', (_name, expression) => {
    const code = `const sink = ${expression}; ` + invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'an aliased identity-wrapped Reflect.construct',
      'const make = Object.freeze(Reflect.construct); const sink = make(Proxy, [analytics, {}]);',
    ],
    [
      'an inline identity-wrapped Reflect.apply',
      'const sink = Object.preventExtensions(Reflect.apply)(Proxy.revocable, Proxy, [analytics, {}]).proxy;',
    ],
    [
      'an identity-wrapped Proxy.revocable forwarder',
      'const sink = Object.seal(Proxy.revocable).call(Proxy, analytics, {}).proxy;',
    ],
    [
      'an identity-wrapped Function call forwarder',
      'const invoke = Object.freeze(Function.prototype.call); const sink = invoke.call(Proxy.revocable, Proxy, analytics, {}).proxy;',
    ],
    [
      'conditional identity-wrapped helper provenance',
      'const make = choose ? Object.freeze(Reflect.construct) : Reflect.construct; const sink = make(Proxy, [analytics, {}]);',
    ],
    [
      'logical identity-wrapped helper provenance',
      'const make = Object.preventExtensions(Reflect.apply) || Reflect.apply; const sink = make(Proxy.revocable, Proxy, [analytics, {}]).proxy;',
    ],
  ])('recognizes Proxy creation through %s', (_name, setup) => {
    expect(
      verify(`${setup} ${invalidCall()}`, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'a conditional Reflect.construct helper',
      'const ordinary = () => new Widget(); const make = choose ? Reflect.construct : ordinary; const sink = make(Proxy, [new Widget(), {}]);',
    ],
    [
      'a logical Reflect.apply helper',
      'const ordinary = () => new Widget(); const make = ordinary || Reflect.apply; const sink = make(Proxy.revocable, Proxy, [new Widget(), {}]).proxy;',
    ],
  ])('fails closed for mixed builtin provenance through %s', (_name, setup) => {
    expect(
      verify(`${setup} ${invalidCall()}`, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'Object.freeze and Reflect.construct',
      'Object.freeze = function (value) { return value; }; const sink = Object.freeze(Reflect.construct)(Proxy, [new Widget(), {}]);',
    ],
    [
      'Object.preventExtensions and Reflect.apply',
      'Object.preventExtensions = function (value) { return value; }; const sink = Object.preventExtensions(Reflect.apply)(Proxy.revocable, Proxy, [new Widget(), {}]).proxy;',
    ],
    [
      'Object.seal and Proxy.revocable.call',
      'Object.seal = function (value) { return value; }; const sink = Object.seal(Proxy.revocable).call(Proxy, new Widget(), {}).proxy;',
    ],
  ])('fails closed when %s is replaced', (_name, setup) => {
    expect(
      verify(`${setup} ${invalidCall()}`, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['unanalyzable', 'unanalyzable', ...expected]);
  });

  test.each([
    [
      'Object.assign returning Proxy',
      'const P = Object.assign(Proxy, {}); const sink = new P(analytics, {});',
    ],
    [
      'Object.defineProperty returning Proxy',
      "const P = Object.defineProperty(Proxy, 'x', { value: 1 }); const sink = new P(analytics, {});",
    ],
    [
      'Object.defineProperties returning Proxy',
      'const P = Object.defineProperties(Proxy, {}); const sink = new P(analytics, {});',
    ],
    [
      'Object.setPrototypeOf returning Proxy',
      'const P = Object.setPrototypeOf(Proxy, Function.prototype); const sink = new P(analytics, {});',
    ],
    [
      'Object.assign returning Proxy.revocable',
      'const rev = Object.assign(Proxy.revocable, {}); const sink = rev(analytics, {}).proxy;',
    ],
    [
      'Object.assign returning Reflect.construct',
      'const make = Object.assign(Reflect.construct, {}); const sink = make(Proxy, [analytics, {}]);',
    ],
  ])('fails closed for %s', (_name, setup) => {
    expect(
      verify(`${setup} ${invalidCall()}`, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  const returnTargetMethods = [
    ['Object.assign', 'Proxy, {}', 'Widget, {}'],
    ['Object.defineProperties', 'Proxy, {}', 'Widget, {}'],
    [
      'Object.defineProperty',
      "Proxy, 'x', { value: 1 }",
      "Widget, 'x', { value: 1 }",
    ],
    [
      'Object.setPrototypeOf',
      'Proxy, Function.prototype',
      'Widget, Function.prototype',
    ],
  ];
  const returnTargetForwardingForms = [
    ['direct', (method, args) => `const P = ${method}(${args});`],
    [
      'bind',
      (method, args) =>
        `const invoke = ${method}.bind(null, ${args}); const P = invoke();`,
    ],
    ['call', (method, args) => `const P = ${method}.call(null, ${args});`],
    ['apply', (method, args) => `const P = ${method}.apply(null, [${args}]);`],
    [
      'Reflect.apply',
      (method, args) => `const P = Reflect.apply(${method}, null, [${args}]);`,
    ],
    [
      'Function.prototype.call.call',
      (method, args) =>
        `const P = Function.prototype.call.call(${method}, null, ${args});`,
    ],
    [
      'Function.prototype.apply.call',
      (method, args) =>
        `const P = Function.prototype.apply.call(${method}, null, [${args}]);`,
    ],
  ];
  const forwardedReturnTargetCases = returnTargetMethods.flatMap(
    ([method, proxyArgs, ordinaryArgs]) =>
      returnTargetForwardingForms.flatMap(([form, setup]) => [
        [form, method, 'Proxy', setup(method, proxyArgs), true],
        [form, method, 'Widget', setup(method, ordinaryArgs), false],
      ])
  );

  test.each(forwardedReturnTargetCases)(
    '%s forwards %s with a %s return target',
    (_form, _method, _target, setup, proxyTarget) => {
      const receiver = proxyTarget
        ? 'const sink = new P(analytics, {});'
        : 'const sink = new P();';
      const call = proxyTarget ? invalidCall() : dynamicCall();
      const messages = verify(
        `${setup} ${receiver} ${call}`,
        plugin.eventRules(LINT_ARTIFACT)
      ).map((message) => message.messageId);
      expect(messages).toEqual(proxyTarget ? expected : []);
    }
  );

  const returnTargetContainerForms = [
    [
      'object',
      (method, args) =>
        `const methods = { invoke: ${method} }; const P = methods.invoke(${args});`,
    ],
    [
      'array',
      (method, args) =>
        `const methods = [${method}]; const P = methods[0](${args});`,
    ],
    [
      'nested object',
      (method, args) =>
        `const methods = { nested: { invoke: ${method} } }; const P = methods.nested.invoke(${args});`,
    ],
    [
      'container alias',
      (method, args) =>
        `const methods = { invoke: ${method} }; const alias = methods; const P = alias.invoke(${args});`,
    ],
    [
      'destructured member',
      (method, args) =>
        `const methods = { invoke: ${method} }; const { invoke } = methods; const P = invoke(${args});`,
    ],
    [
      'static computed member',
      (method, args) =>
        `const key = 'invoke'; const methods = { invoke: ${method} }; const P = methods[key](${args});`,
    ],
  ];
  const containedReturnTargetCases = returnTargetMethods.flatMap(
    ([method, proxyArgs, ordinaryArgs]) =>
      returnTargetContainerForms.flatMap(([container, setup]) => [
        [container, method, 'Proxy', setup(method, proxyArgs), true],
        [container, method, 'Widget', setup(method, ordinaryArgs), false],
      ])
  );

  test.each(containedReturnTargetCases)(
    'resolves %s-held %s with a %s return target',
    (_container, _method, _target, setup, proxyTarget) => {
      const receiver = proxyTarget
        ? 'const sink = new P(analytics, {});'
        : 'const sink = new P();';
      const call = proxyTarget ? invalidCall() : dynamicCall();
      const messages = verify(
        `${setup} ${receiver} ${call}`,
        plugin.eventRules(LINT_ARTIFACT)
      ).map((message) => message.messageId);
      expect(messages).toEqual(proxyTarget ? expected : []);
    }
  );

  const escapedObjectNamespaceCases = [
    [
      'object',
      (target) =>
        `const namespaces = { object: Object }; const P = namespaces.object.assign(${target}, {});`,
    ],
    [
      'array',
      (target) =>
        `const namespaces = [Object]; const P = namespaces[0].assign(${target}, {});`,
    ],
    [
      'nested object',
      (target) =>
        `const namespaces = { nested: { object: Object } }; const P = namespaces.nested.object.assign(${target}, {});`,
    ],
    [
      'static computed member',
      (target) =>
        `const key = 'object'; const namespaces = { object: Object }; const P = namespaces[key].assign(${target}, {});`,
    ],
  ];
  const escapedObjectNamespaceTargets = escapedObjectNamespaceCases.flatMap(
    ([container, setup]) => [
      [container, 'Proxy', setup('Proxy'), true],
      [container, 'Widget', setup('Widget'), false],
    ]
  );

  test.each(escapedObjectNamespaceTargets)(
    'resolves an Object namespace escaped through a %s with a %s target',
    (_container, _target, setup, proxyTarget) => {
      const receiver = proxyTarget
        ? 'const sink = new P(analytics, {});'
        : 'const sink = new P();';
      const call = proxyTarget ? invalidCall() : dynamicCall();
      const messages = verify(
        `${setup} ${receiver} ${call}`,
        plugin.eventRules(LINT_ARTIFACT)
      ).map((message) => message.messageId);
      expect(messages).toEqual(proxyTarget ? expected : []);
    }
  );

  test.each([
    [
      'mixed',
      'const ordinaryNamespace = { assign: ordinary }; const namespaces = choose ? { object: Object } : { object: ordinaryNamespace }; const P = namespaces.object.assign(Proxy, {});',
    ],
    [
      'opaque computed',
      'const namespaces = { object: Object }; const P = namespaces[key].assign(Proxy, {});',
    ],
    [
      'cyclic',
      'const namespaces = { object: Object }; namespaces.self = namespaces; const P = namespaces.object.assign(Proxy, {});',
    ],
    [
      'mutated',
      'const ordinaryNamespace = { assign: ordinary }; const namespaces = { object: ordinaryNamespace }; namespaces.object = Object; const P = namespaces.object.assign(Proxy, {});',
    ],
    [
      'escaped',
      'const namespaces = { object: Object }; mutate(namespaces); const P = namespaces.object.assign(Proxy, {});',
    ],
  ])('fails closed for a %s Object namespace escape', (_name, setup) => {
    const code = `${setup} const sink = new P(analytics, {}); ${invalidCall()}`;
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('fails closed for mixed return-target method provenance', () => {
    const code =
      'const invoke = choose ? Object.assign : ordinary; ' +
      'const P = invoke(Proxy, {}); const sink = new P(analytics, {}); ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'Object.assign returning Proxy',
      'const P = Object.assign(...[Proxy, {}]); const sink = new P(analytics, {});',
    ],
    [
      'Object.defineProperty returning Proxy',
      "const P = Object.defineProperty(...[Proxy, 'x', { value: 1 }]); const sink = new P(analytics, {});",
    ],
    [
      'Object.defineProperties returning Proxy',
      'const P = Object.defineProperties(...[Proxy, {}]); const sink = new P(analytics, {});',
    ],
    [
      'Object.setPrototypeOf returning Proxy',
      'const P = Object.setPrototypeOf(...[Proxy, Function.prototype]); const sink = new P(analytics, {});',
    ],
    [
      'Object.assign returning Proxy.revocable',
      'const rev = Object.assign(...[Proxy.revocable, {}]); const sink = rev(analytics, {}).proxy;',
    ],
    [
      'Object.defineProperty returning Reflect.construct',
      "const make = Object.defineProperty(...[Reflect.construct, 'x', { value: 1 }]); const sink = make(Proxy, [analytics, {}]);",
    ],
  ])('fails closed for a literal spread through %s', (_name, setup) => {
    expect(
      verify(`${setup} ${invalidCall()}`, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['nested literals', 'const P = Object.assign(...[...[Proxy, {}]]);'],
    [
      'nested named arrays',
      'const inner = [Proxy, {}]; const outer = [...inner]; const P = Object.assign(...outer);',
    ],
  ])('fails closed for %s returning Proxy', (_name, setup) => {
    const code = `${setup} const sink = new P(analytics, {}); ${invalidCall()}`;
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['nested literals', 'const P = Object.assign(...[...[Widget, {}]]);'],
    [
      'nested named arrays',
      'const inner = [Widget, {}]; const outer = [...inner]; const P = Object.assign(...outer);',
    ],
  ])('preserves an ordinary constructor through %s', (_name, setup) => {
    const code = `${setup} const sink = new P(); ${dynamicCall()}`;
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test.each([
    ['Object.assign', 'Proxy, {}'],
    ['Object.defineProperties', 'Proxy, {}'],
    ['Object.defineProperty', "Proxy, 'x', { value: 1 }"],
    ['Object.setPrototypeOf', 'Proxy, Function.prototype'],
  ])('fails closed for an aliased spread through %s', (method, elements) => {
    const code =
      `const args = [${elements}]; const P = ${method}(...args); ` +
      `const sink = new P(analytics, {}); ${invalidCall()}`;
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    'Object.assign',
    'Object.defineProperties',
    'Object.defineProperty',
    'Object.setPrototypeOf',
  ])('fails closed for an opaque spread through %s', (method) => {
    const code =
      `const args = getArguments(); const P = ${method}(...args); ` +
      `const sink = new P(analytics, {}); ${invalidCall()}`;
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['a mutated alias', 'const args = [Widget, {}]; args[0] = Proxy;'],
    ['an escaped alias', 'const args = [Widget, {}]; mutate(args);'],
  ])('fails closed for %s used as spread arguments', (_name, setup) => {
    const code =
      `${setup} const P = Object.assign(...args); ` +
      `const sink = new P(analytics, {}); ${invalidCall()}`;
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['Object.assign', 'function () {}, {}'],
    ['Object.defineProperties', 'function () {}, {}'],
    ['Object.defineProperty', "function () {}, 'x', {}"],
    ['Object.setPrototypeOf', 'function () {}, Function.prototype'],
  ])('fails closed when %s is replaced', (method, argumentsList) => {
    const code =
      `${method} = function () { return Proxy; }; ` +
      `const P = ${method}(...[${argumentsList}]); ` +
      'const sink = new P(new Widget(), {}); ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['Object.assign', 'Widget, {}'],
    ['Object.defineProperties', 'Widget, {}'],
    ['Object.defineProperty', "Widget, 'x', { value: 1 }"],
    ['Object.setPrototypeOf', 'Widget, Function.prototype'],
  ])(
    'preserves an ordinary constructor through a %s spread',
    (method, args) => {
      const code =
        `const P = ${method}(...[${args}]); const sink = new P(); ` +
        dynamicCall();
      expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
    }
  );

  test('preserves an ordinary Object.assign constructor target', () => {
    const code =
      'const P = Object.assign(Widget, {}); const sink = new P(); ' +
      dynamicCall();
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test.each([63, 64])(
    'fails closed at reflective helper alias depth %i',
    (depth) => {
      const bindings = ['const make0 = Reflect.construct;'];
      for (let index = 1; index <= depth; index += 1) {
        bindings.push(`const make${index} = make${index - 1};`);
      }
      const code =
        `${bindings.join('\n')} ` +
        `const sink = make${depth}(Proxy, [analytics, {}]); ` +
        invalidCall();

      expect(
        verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
          (message) => message.messageId
        )
      ).toEqual(expected);
    }
  );

  test.each(['direct', 'identity-wrapped'])(
    'memoizes a reconverging %s reflective helper diamond',
    (kind) => {
      const depth = 20;
      const leaf =
        kind === 'direct'
          ? 'Reflect.construct'
          : 'Object.freeze(Reflect.construct)';
      const bindings = [`const left0 = ${leaf};`, `const right0 = ${leaf};`];
      for (let index = 1; index <= depth; index += 1) {
        bindings.push(
          `const left${index} = choose${index} ? left${index - 1} : right${index - 1};`,
          `const right${index} = choose${index} ? right${index - 1} : left${index - 1};`
        );
      }
      const code =
        `${bindings.join('\n')} ` +
        `const sink = left${depth}(Proxy, [analytics, {}]); ` +
        invalidCall();
      const { messages, stats } = verifyWithAnalysisStats(code);

      expect(messages.map((message) => message.messageId)).toEqual(expected);
      expect(
        stats.reduce(
          (total, counters) =>
            total + counters.builtinMethodBindingComputations,
          0
        )
      ).toBeLessThanOrEqual(4 * depth + 7);
    }
  );

  test.each([
    ['a', 'b'],
    ['b', 'a'],
  ])(
    'resolves a cyclic Reflect namespace after warming %s before %s',
    (firstNamespace, secondNamespace) => {
      const code =
        'let a = Reflect; let b = a; a = b; ' +
        `const first = ${firstNamespace}.construct(Proxy, [analytics, {}]); ` +
        "first.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 3, via: 'search' }); " +
        `const sink = ${secondNamespace}.construct(Proxy, [analytics, {}]); ` +
        invalidCall();

      expect(
        verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
          (message) => message.messageId
        )
      ).toEqual(expected);
    }
  );

  test('scales deep static-array aliases across repeated Proxy consumers', () => {
    const depth = 128;
    const consumers = 64;
    const bindings = ['const args0 = [Proxy, {}];'];
    for (let index = 1; index <= depth; index += 1) {
      bindings.push(`const args${index} = args${index - 1};`);
    }
    const calls = Array.from({ length: consumers }, (_unused, index) => {
      return (
        `const P${index} = Object.assign(...args${depth}); ` +
        `const sink${index} = new P${index}(analytics, {}); ` +
        invalidCall(`sink${index}`)
      );
    });
    const { messages, stats } = verifyWithAnalysisStats(
      `${bindings.join('\n')} ${calls.join('\n')}`
    );
    const total = (name) =>
      stats.reduce((sum, counters) => sum + counters[name], 0);

    expect(messages).toHaveLength(2 * consumers);
    expect(
      messages.filter((message) => message.messageId === 'invalidValue')
    ).toHaveLength(consumers);
    expect(
      messages.filter((message) => message.messageId === 'unbound')
    ).toHaveLength(consumers);
    expect(total('staticArrayAliasBindingVisits')).toBeGreaterThan(0);
    expect(total('staticArrayAliasBindingVisits')).toBeLessThanOrEqual(
      2 * (depth + 1)
    );
    expect(total('staticArrayAliasResolutionHops')).toBeGreaterThan(0);
    expect(total('staticArrayAliasResolutionHops')).toBeLessThanOrEqual(
      2 * (depth + 1)
    );
  });

  test.each([
    ['mutated', `args${128}[0] = Proxy;`],
    ['escaped', `mutate(args${128});`],
  ])('fails closed for a deep %s static-array alias', (_name, change) => {
    const depth = 128;
    const bindings = ['const args0 = [Widget, {}];'];
    for (let index = 1; index <= depth; index += 1) {
      bindings.push(`const args${index} = args${index - 1};`);
    }
    const code =
      `${bindings.join('\n')} ${change} ` +
      `const P = Object.assign(...args${depth}); ` +
      `const sink = new P(analytics, {}); ${invalidCall()}`;

    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('shares wide builtin method and namespace provenance', () => {
    const width = 200;
    const bindings = ['let callable = Object.method0;'];
    for (let index = 1; index < width; index += 1) {
      bindings.push(`callable = Object.method${index};`);
    }
    bindings.push('callable = Reflect.construct;');
    for (let index = 0; index < width; index += 1) {
      bindings.push(`const alias${index} = callable;`);
    }
    bindings.push('let invoke = alias0;');
    for (let index = 1; index < width; index += 1) {
      bindings.push(`invoke = alias${index};`);
    }
    const code =
      `${bindings.join('\n')} ` +
      'const sink = invoke(Proxy, [analytics, {}]); ' +
      invalidCall();
    const { messages, stats } = verifyWithAnalysisStats(code);
    const total = (name) =>
      stats.reduce((sum, counters) => sum + counters[name], 0);

    expect(messages.map((message) => message.messageId)).toEqual(expected);
    expect(total('builtinMethodMergeVisits')).toBeLessThanOrEqual(3 * width);
    expect(total('builtinNamespaceBindingComputations')).toBeLessThanOrEqual(
      2 * width + 2
    );
    expect(total('builtinNamespaceMergeVisits')).toBeLessThanOrEqual(
      2 * width + 1
    );
  });

  test('caches a deep builtin namespace alias before repeated writes', () => {
    const depth = 128;
    const bindings = ['const namespace0 = Object;'];
    for (let index = 1; index <= depth; index += 1) {
      bindings.push(`const namespace${index} = namespace${index - 1};`);
    }
    const writes = Array.from(
      { length: depth },
      (_value, index) => `namespace${depth}.method${index} = ordinary;`
    );
    const code =
      `${bindings.join('\n')} ${writes.join('\n')} ` +
      `const sink = new Widget(); ${dynamicCall()}`;
    const { messages, stats } = verifyWithAnalysisStats(code);
    const total = (name) =>
      stats.reduce((sum, counters) => sum + counters[name], 0);

    expect(messages).toEqual([]);
    expect(total('builtinNamespaceDirectVisits')).toBeLessThanOrEqual(
      6 * depth
    );
    expect(total('builtinNamespaceBindingComputations')).toBeLessThanOrEqual(
      2 * (depth + 1)
    );
  });

  test('caches a deep builtin namespace alias before repeated calls', () => {
    const depth = 128;
    const bindings = ['const namespace0 = Object;'];
    for (let index = 1; index <= depth; index += 1) {
      bindings.push(`const namespace${index} = namespace${index - 1};`);
    }
    const calls = Array.from(
      { length: depth },
      () => `namespace${depth}.apply();`
    );
    const code =
      `${bindings.join('\n')} ${calls.join('\n')} ` +
      `const sink = new Widget(); ${dynamicCall()}`;
    const { messages, stats } = verifyWithAnalysisStats(code);
    const total = (name) =>
      stats.reduce((sum, counters) => sum + counters[name], 0);

    expect(messages).toEqual([]);
    expect(total('builtinNamespaceDirectVisits')).toBeLessThanOrEqual(
      8 * depth
    );
    expect(total('builtinNamespaceBindingComputations')).toBeLessThanOrEqual(
      2 * (depth + 1)
    );
  });

  test('fails closed when a Proxy invocation forwarder is replaced', () => {
    const code =
      'Reflect.apply = function () { return { proxy: analytics }; }; ' +
      'const sink = Reflect.apply(Proxy.revocable, Proxy, [new Widget(), {}]).proxy; ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'constructor',
      'const P = Proxy.bind(null, new Widget(), {}); const sink = new P();',
    ],
    [
      'revocable factory',
      'const rev = Proxy.revocable.bind(null, new Widget(), {}); const sink = rev().proxy;',
    ],
  ])('preserves ordinary pre-bound %s arguments', (_name, setup) => {
    expect(
      verify(`${setup} ${dynamicCall()}`, plugin.eventRules(LINT_ARTIFACT))
    ).toEqual([]);
  });

  test.each(['constructor', 'revocable'])(
    'bounds a long serial Proxy %s bind chain',
    (kind) => {
      const depth = 1200;
      const bindings = [
        kind === 'constructor'
          ? 'const callable0 = Proxy.bind(null, analytics, {});'
          : 'const callable0 = Proxy.revocable.bind(Proxy, analytics, {});',
      ];
      for (let index = 1; index <= depth; index += 1) {
        bindings.push(
          `const callable${index} = callable${index - 1}.bind(null);`
        );
      }
      const receiver =
        kind === 'constructor'
          ? `new callable${depth}()`
          : `callable${depth}().proxy`;
      const code =
        `${bindings.join('\n')} const sink = ${receiver}; ` + invalidCall();
      const { messages, stats } = verifyWithAnalysisStats(code);

      const messageIds = messages.map((message) => message.messageId);
      expect(messages.every((message) => message.fatal !== true)).toBe(true);
      expect(
        messageIds.filter((messageId) => expected.includes(messageId))
      ).toEqual(expected);
      for (const counters of stats) {
        expect(counters.proxyConstructorComputations).toBeLessThanOrEqual(65);
      }
    }
  );

  test.each([
    [
      'Reflect.set',
      "Reflect.set(globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'Object.defineProperty',
      "Object.defineProperty(globalThis, 'Proxy', { value: function () { return analytics; } });",
    ],
    [
      'Object.defineProperties',
      'Object.defineProperties(globalThis, { Proxy: { value: function () { return analytics; } } });',
    ],
    [
      'Object.assign',
      'Object.assign(globalThis, { Proxy: function () { return analytics; } });',
    ],
    [
      'an extracted Reflect.set',
      "const set = Reflect.set; set(globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'a destructured Reflect.set alias',
      "let set; ({ set } = Reflect); set(globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'Object.defineProperty.call',
      "const define = Object.defineProperty; define.call(null, globalThis, 'Proxy', { value: function () { return analytics; } });",
    ],
    [
      'Object.defineProperty.apply',
      "const define = Object.defineProperty; define.apply(null, [globalThis, 'Proxy', { value: function () { return analytics; } }]);",
    ],
    [
      'Reflect.apply forwarding',
      "const define = Object.defineProperty; Reflect.apply(define, null, [globalThis, 'Proxy', { value: function () { return analytics; } }]);",
    ],
    [
      'Function.prototype.call.call forwarding',
      "const define = Object.defineProperty; Function.prototype.call.call(define, null, globalThis, 'Proxy', { value: function () { return analytics; } });",
    ],
    [
      'Function.prototype.apply.call forwarding',
      "const define = Object.defineProperty; Function.prototype.apply.call(define, null, [globalThis, 'Proxy', { value: function () { return analytics; } }]);",
    ],
    [
      'a bound Reflect.set alias',
      "const set = Reflect.set.bind(Reflect); set(globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'an extracted Function.prototype.call forwarder',
      "const define = Object.defineProperty; const invoke = Function.prototype.call; invoke.call(define, null, globalThis, 'Proxy', { value: function () { return analytics; } });",
    ],
    [
      'Reflect.apply.call forwarding',
      "const define = Object.defineProperty; Reflect.apply.call(null, define, null, [globalThis, 'Proxy', { value: function () { return analytics; } }]);",
    ],
    [
      'recursive Reflect.apply forwarding',
      "const descriptor = { value: function () { return analytics; } }; Reflect.apply(Reflect.apply, null, [Object.defineProperty, null, [globalThis, 'Proxy', descriptor]]);",
    ],
    [
      'recursive Function.prototype.call forwarding',
      "const descriptor = { value: function () { return analytics; } }; Function.prototype.call.call(Function.prototype.call, Object.defineProperty, null, globalThis, 'Proxy', descriptor);",
    ],
    [
      'a chained bound Reflect.set alias',
      "const set = Reflect.set.bind(Reflect, globalThis).bind(null, 'Proxy'); set(function () { return analytics; });",
    ],
    [
      'direct spread arguments',
      "const xs = [globalThis, 'Proxy', { value: function () { return analytics; } }]; Object.defineProperty(...xs);",
    ],
    [
      'call-forwarded spread arguments',
      "const define = Object.defineProperty; const xs = [globalThis, 'Proxy', { value: function () { return analytics; } }]; define.call(null, ...xs);",
    ],
    [
      'bound spread arguments',
      "const xs = [globalThis, 'Proxy']; const set = Reflect.set.bind(Reflect, ...xs); set(function () { return analytics; });",
    ],
    [
      'Function.prototype.call.apply forwarding',
      "const descriptor = { value: function () { return analytics; } }; Function.prototype.call.apply(Object.defineProperty, [null, globalThis, 'Proxy', descriptor]);",
    ],
    [
      'Function.prototype.apply.apply forwarding',
      "const descriptor = { value: function () { return analytics; } }; Function.prototype.apply.apply(Object.defineProperty, [null, [globalThis, 'Proxy', descriptor]]);",
    ],
    [
      'opaque outer apply arguments',
      "const descriptor = { value: function () { return analytics; } }; const xs = [null, globalThis, 'Proxy', descriptor]; Function.prototype.call.apply(Object.defineProperty, xs);",
    ],
    [
      'an ambiguous Function forwarder alias',
      "const descriptor = { value: function () { return analytics; } }; let invoke = Function.prototype.call; if (condition) invoke = Function.prototype.apply; invoke.call(Object.defineProperty, null, globalThis, 'Proxy', descriptor);",
    ],
    [
      'Function.prototype.bind.call construction',
      "const set = Function.prototype.bind.call(Reflect.set, Reflect, globalThis, 'Proxy'); set(function () { return analytics; });",
    ],
    [
      'Function.prototype.bind.apply construction',
      "const set = Function.prototype.bind.apply(Reflect.set, [Reflect, globalThis, 'Proxy']); set(function () { return analytics; });",
    ],
    [
      'an extracted Function.prototype.bind constructor',
      "const bind = Function.prototype.bind; const set = bind.call(Reflect.set, Reflect, globalThis, 'Proxy'); set(function () { return analytics; });",
    ],
    [
      'Reflect.apply Function.prototype.bind construction',
      "const set = Reflect.apply(Function.prototype.bind, Reflect.set, [Reflect, globalThis, 'Proxy']); set(function () { return analytics; });",
    ],
    [
      'Function call-forwarded bind construction',
      "const set = Function.prototype.call.call(Function.prototype.bind, Reflect.set, Reflect, globalThis, 'Proxy'); set(function () { return analytics; });",
    ],
    [
      'an array-destructured bound mutator',
      "const [set] = [Reflect.set.bind(Reflect, globalThis, 'Proxy')]; set(function () { return analytics; });",
    ],
    [
      'an object-destructured bound mutator',
      "const { set } = { set: Reflect.set.bind(Reflect, globalThis, 'Proxy') }; set(function () { return analytics; });",
    ],
    [
      'a nested-destructured bound mutator',
      "const { nested: { set } } = { nested: { set: Reflect.set.bind(Reflect, globalThis, 'Proxy') } }; set(function () { return analytics; });",
    ],
    [
      'inherited Reflect.set.call.call forwarding',
      "Reflect.set.call.call(Reflect.set, Reflect, globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'inherited Object.defineProperty.apply.call forwarding',
      "const descriptor = { value: function () { return analytics; } }; Object.defineProperty.apply.call(Object.defineProperty, null, [globalThis, 'Proxy', descriptor]);",
    ],
    [
      'an extracted inherited Reflect.set.call forwarder',
      "const invoke = Reflect.set.call; invoke.call(Reflect.set, Reflect, globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'inherited Reflect.set.bind.call construction',
      "const set = Reflect.set.bind.call(Reflect.set, Reflect, globalThis, 'Proxy'); set(function () { return analytics; });",
    ],
    [
      'a rest-destructured bound mutator',
      "const [...[set]] = [Reflect.set.bind(Reflect, globalThis, 'Proxy')]; set(function () { return analytics; });",
    ],
    [
      'a two-stage rest-destructured bound mutator',
      "const [head, ...rest] = [null, Reflect.set.bind(Reflect, globalThis, 'Proxy')]; const [set] = rest; set(function () { return analytics; });",
    ],
    [
      'immutable computed inherited call forwarding',
      "const key = 'call'; Reflect.set[key][key](Reflect.set, Reflect, globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'immutable computed inherited apply forwarding',
      "const key = 'apply'; const descriptor = { value: function () { return analytics; } }; Object.defineProperty[key].call(Object.defineProperty, null, [globalThis, 'Proxy', descriptor]);",
    ],
    [
      'immutable computed inherited bind construction',
      "const key = 'bind'; const set = Reflect.set[key].call(Reflect.set, Reflect, globalThis, 'Proxy'); set(function () { return analytics; });",
    ],
    [
      'concatenated computed inherited call forwarding',
      "const key = 'ca' + 'll'; Reflect.set[key][key](Reflect.set, Reflect, globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'interpolated computed inherited call forwarding',
      "const part = 'ca'; const key = `${part}ll`; Reflect.set[key][key](Reflect.set, Reflect, globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'an opaque computed inherited forwarder',
      "Reflect.set[key][key](Reflect.set, Reflect, globalThis, 'Proxy', function () { return analytics; });",
    ],
  ])('fails closed for a Proxy replaced through %s', (_name, replacement) => {
    const code =
      replacement +
      ' const sink = new Proxy(new Widget(), {}); ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['destructuring', '({ P } = providers);'],
    ['loop write', 'for (P of providers) {}'],
  ])('fails closed when a Proxy alias has an opaque %s', (_name, write) => {
    const code =
      `let P = Proxy; ${write} ` +
      'const sink = new P(new Widget(), {}); ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'ordinary initializer then object destructuring',
      'let P = Widget; ({ P } = providers);',
    ],
    ['unset binding then object destructuring', 'let P; ({ P } = providers);'],
    ['unset binding then array destructuring', 'let P; [P] = providers;'],
    ['unset binding then loop write', 'let P; for (P of providers) {}'],
  ])('fails closed for an opaque constructor after %s', (_name, setup) => {
    const code =
      `${setup} const sink = new P(new Widget(), {}); ` + invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['immutable', "const key = 'toString';"],
    ['concatenated', "const key = 'to' + 'String';"],
    ['interpolated', "const part = 'to'; const key = `${part}String`;"],
  ])(
    'does not treat a statically known non-forwarder %s key as opaque',
    (_name, setup) => {
      const code =
        `${setup} Reflect.set[key](); ` +
        'const sink = new Proxy(new Widget(), {}); ' +
        dynamicCall();
      expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
    }
  );

  test('fails closed when Function.prototype.bind is replaced', () => {
    const code =
      'Function.prototype.bind = function () { ' +
      'return function () { return analytics; }; }; ' +
      'const P = Proxy.bind(null); const sink = new P(new Widget(), {}); ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  const dynamicCodeConsumers = [
    [
      'Object.assign',
      'const sink = Object.assign(new Widget(), {});',
      ['unanalyzable', 'unanalyzable'],
    ],
    [
      'Reflect.construct',
      'const sink = Reflect.construct(Widget, []);',
      expected,
    ],
    ['Proxy', 'const sink = new Proxy(new Widget(), {});', expected],
  ];

  test.each(
    [
      ['direct eval', 'eval(source);'],
      ['an unshadowed eval alias', 'const execute = eval; execute(source);'],
      [
        'a conditional eval alias',
        'const execute = choose ? eval : ordinary; execute(source);',
      ],
      [
        'a logical eval alias',
        'const execute = choose && eval; execute(source);',
      ],
      ['a computed global eval', "globalThis['eval'](source);"],
      [
        'a computed-key global eval',
        "const executeKey = 'ev' + 'al'; globalThis[executeKey](source);",
        ['unanalyzable', 'unanalyzable'],
      ],
      [
        'a container-held eval alias',
        'const runtime = { execute: eval }; runtime.execute(source);',
      ],
      [
        'a computed container-held eval alias',
        "const executeKey = 'execute'; const runtime = { execute: eval }; runtime[executeKey](source);",
      ],
      [
        'an array-held eval alias',
        'const runtime = [eval]; runtime[0](source);',
      ],
      ['eval.call', 'eval.call(null, source);'],
      ['eval.apply', 'eval.apply(null, [source]);'],
      ['Reflect.apply of eval', 'Reflect.apply(eval, null, [source]);'],
      ['Function call', 'Function(source)();'],
      ['Function construction', 'new Function(source)();'],
      ['Function.call', 'Function.call(null, source)();'],
      ['Function.apply', 'Function.apply(null, [source])();'],
      [
        'Function.bind',
        'const compile = Function.bind(null, source); compile()();',
      ],
      [
        'Reflect.apply of Function',
        'Reflect.apply(Function, null, [source])();',
      ],
    ].flatMap(([executorName, execute, executorMessageIds]) =>
      dynamicCodeConsumers.map(([consumerName, consume, messageIds]) => [
        executorName,
        consumerName,
        execute,
        consume,
        executorMessageIds ?? messageIds,
      ])
    )
  )(
    'fails closed for %s before %s provenance',
    (_executorName, _consumerName, execute, consume, messageIds) => {
      const code = `${execute} ${consume} ${invalidCall()}`;
      expect(
        verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
          (message) => message.messageId
        )
      ).toEqual(messageIds);
    }
  );

  test.each(
    [
      ['a shadowed eval', 'const eval = ordinary; eval(source);', verifyScript],
      [
        'a shadowed Function',
        'const Function = ordinary; Function(source);',
        verify,
      ],
      ['an ordinary callable', 'ordinary(source);', verify],
      [
        'a conditional shadowed eval',
        'const eval = ordinary; const execute = choose ? eval : ordinary; execute(source);',
        verifyScript,
      ],
      [
        'a logical shadowed eval',
        'const eval = ordinary; const execute = choose && eval; execute(source);',
        verifyScript,
      ],
      [
        'an ordinary container-held callable',
        'const runtime = { execute: ordinary }; runtime.execute(source);',
        verify,
      ],
      [
        'an ordinary computed container-held callable',
        "const executeKey = 'execute'; const runtime = { execute: ordinary }; runtime[executeKey](source);",
        verify,
      ],
      [
        'shadowed eval.call',
        'const eval = ordinary; eval.call(null, source);',
        verifyScript,
      ],
      [
        'shadowed eval.apply',
        'const eval = ordinary; eval.apply(null, [source]);',
        verifyScript,
      ],
      [
        'shadowed Function.call',
        'const Function = ordinary; Function.call(null, source);',
        verify,
      ],
      [
        'shadowed Function.apply',
        'const Function = ordinary; Function.apply(null, [source]);',
        verify,
      ],
      [
        'shadowed Function.bind',
        'const Function = ordinary; const compile = Function.bind(null, source); compile();',
        verify,
      ],
      [
        'Reflect.apply of an ordinary callable',
        'Reflect.apply(ordinary, null, [source]);',
        verify,
      ],
    ].flatMap(([executorName, execute, verifier]) =>
      dynamicCodeConsumers.map(([consumerName, consume]) => [
        executorName,
        consumerName,
        execute,
        consume,
        verifier,
      ])
    )
  )(
    'preserves %s before ordinary %s provenance',
    (_executorName, _consumerName, execute, consume, verifier) => {
      const code = `${execute} ${consume} ${dynamicCall()}`;
      expect(verifier(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
    }
  );

  test('fails closed for a 1,200-deep eval alias before Object.assign provenance', () => {
    const aliases = ['const execute0 = eval;'];
    for (let index = 1; index <= 1200; index += 1) {
      aliases.push(`const execute${index} = execute${index - 1};`);
    }
    const code =
      `${aliases.join('\n')} execute1200(source); ` +
      'const sink = Object.assign(new Widget(), {}); ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['unanalyzable', 'unanalyzable']);
  });

  test('fails closed for a cyclic eval alias before Object.assign provenance', () => {
    const code =
      'let execute = eval; let alias = execute; execute = alias; ' +
      'alias(source); const sink = Object.assign(new Widget(), {}); ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['unanalyzable', 'unanalyzable']);
  });

  test('preserves a 1,200-deep ordinary alias before Object.assign provenance', () => {
    const aliases = ['const execute0 = ordinary;'];
    for (let index = 1; index <= 1200; index += 1) {
      aliases.push(`const execute${index} = execute${index - 1};`);
    }
    const code =
      `${aliases.join('\n')} execute1200(source); ` +
      'const sink = Object.assign(new Widget(), {}); ' +
      dynamicCall();
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test('preserves a cyclic ordinary alias before Object.assign provenance', () => {
    const code =
      'let execute = ordinary; let alias = execute; execute = alias; ' +
      'alias(source); const sink = Object.assign(new Widget(), {}); ' +
      dynamicCall();
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test.each([
    ['globalThis.Proxy', 'new globalThis.Proxy(createAnalytics(config), {})'],
    [
      'bound Proxy alias',
      'new P(createAnalytics(config), {})',
      'const P = Proxy.bind(null);',
    ],
  ])('fails closed for a %s receiver', (_name, expression, setup = '') => {
    const code =
      factoryImport + setup + ` const sink = ${expression}; ` + invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each(
    [
      ['direct', (args) => `analytics.track(${args});`],
      [
        'normalized .call',
        (args) =>
          `analytics.track.call(analytics${args.length > 0 ? `, ${args}` : ''});`,
      ],
      [
        'normalized bound method',
        (args) =>
          `const emit = analytics.track.bind(analytics); emit(${args});`,
      ],
    ].flatMap(([form, call]) =>
      [
        ['zero', ''],
        ['one', "'appointment_booked'"],
        ['three', `'appointment_booked', ${COMPLETE}, extra`],
      ].map(([arity, args]) => [form, arity, call(args)])
    )
  )(
    'fails closed for a %s event call with %s target arguments',
    (_form, _arity, code) => {
      expect(
        verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
          (message) => message.messageId
        )
      ).toEqual(['unanalyzable', 'unanalyzable']);
    }
  );

  test.each([
    [
      'Reflect.apply.call',
      "Reflect.apply.call(null, analytics.track, analytics, ['appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' }]);",
      ['unanalyzable', 'unanalyzable'],
    ],
    [
      'Function.prototype.call.call',
      "Function.prototype.call.call(analytics.track, analytics, 'appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
      ['unwrapped'],
    ],
    [
      'Function.prototype.apply.call',
      "Function.prototype.apply.call(analytics.track, analytics, ['appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' }]);",
      ['unanalyzable', 'unanalyzable'],
    ],
  ])('fails closed for %s event forwarding', (_name, code, messages) => {
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(messages);
  });

  test.each([
    ['transparent', '{}'],
    ['trapping', '{ get() { return analytics.track; } }'],
  ])('fails closed for a %s Proxy.revocable receiver', (_name, handler) => {
    const code =
      factoryImport +
      `const sink = Proxy.revocable(createAnalytics(config), ${handler}).proxy; ` +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('keeps an ordinary transparent Proxy.revocable receiver exempt', () => {
    const code =
      'const sink = Proxy.revocable(new Widget(), {}).proxy; ' + dynamicCall();
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test('does not trust a shadowed Proxy.revocable receiver', () => {
    const code =
      'const Proxy = { revocable() { return { proxy: new Widget() }; } }; ' +
      'const sink = Proxy.revocable(analytics, {}).proxy; ' +
      dynamicCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['dynamicEvent', 'unbound']);
  });

  test.each([
    [
      'JavaScript private field through a this alias',
      'class C { #tracker = createAnalytics(config); send() { const self = this; ' +
        invalidCall('self.#tracker') +
        ' } }',
      false,
    ],
    [
      'TypeScript private field through a this alias',
      'class C { private tracker = createAnalytics(config); send() { const self = this; ' +
        invalidCall('self.tracker') +
        ' } }',
      true,
    ],
  ])('resolves a trusted %s', (_name, body, typescript) => {
    const lint = typescript ? verifyTypeScript : verify;
    expect(
      lint(factoryImport + body, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each(['private', 'public', 'private readonly'])(
    'resolves a TypeScript %s constructor parameter property',
    (modifier) => {
      const code =
        factoryImport +
        `class C { constructor(${modifier} tracker = createAnalytics(config)) {} send() { ` +
        invalidCall('this.tracker') +
        ' } }';
      expect(
        verifyTypeScript(code, plugin.eventRules(LINT_ARTIFACT)).map(
          (message) => message.messageId
        )
      ).toEqual(expected);
    }
  );

  test('does not trust an ordinary TypeScript parameter property', () => {
    const code =
      'class C { constructor(private tracker = new Widget()) {} send() { ' +
      dynamicCall('this.tracker') +
      ' } }';
    expect(verifyTypeScript(code, plugin.eventRules(LINT_ARTIFACT))).toEqual(
      []
    );
  });

  test('does not mix instance fields into a static receiver', () => {
    const code =
      factoryImport +
      'class C { tracker = createAnalytics(config); static send() { ' +
      dynamicCall('this.tracker') +
      ' } }';
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test.each([
    ['conditional', 'flag ? createAnalytics(config) : new Widget()'],
    ['logical', 'flag && createAnalytics(config)'],
  ])('checks an analytics branch in a %s receiver', (_name, expression) => {
    const code = factoryImport + `const sink = ${expression}; ` + invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('exempts a branch receiver only when every branch is constructed', () => {
    const code =
      'const sink = flag ? new Widget() : new OtherWidget(); ' + dynamicCall();
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test.each([
    [
      'same-source conditional alias',
      'const alias = flag ? services : services;',
    ],
    [
      'possible-source conditional alias',
      'const alias = flag ? services : other;',
    ],
    [
      'nested member alias',
      'const root = { nested: { service: services } }; const alias = root.nested.service;',
    ],
  ])('connects a %s to receiver writes', (_name, alias) => {
    const code =
      factoryImport +
      'const services = { tracker: new Widget() }; const other = { tracker: new Widget() }; ' +
      alias +
      ' alias.tracker = createAnalytics(config); ' +
      invalidCall('services.tracker');
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([0, 365])('accepts integer boundary %i', (value) => {
    const code = `analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: ${value}, via: 'search' });`;
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test.each([-1, 366, 3.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects integer boundary %s',
    (value) => {
      const code = `analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: ${value}, via: 'search' });`;
      expect(
        verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
          (message) => message.messageId
        )
      ).toEqual(expected);
    }
  );

  test.each([
    ['boolean enum', 'clinic_type: true, lead_time_days: 3'],
    ['boolean integer', "clinic_type: 'gp', lead_time_days: false"],
    ['null integer', "clinic_type: 'gp', lead_time_days: null"],
  ])('rejects a %s literal', (_name, properties) => {
    const code = `analytics.track('appointment_booked', { ${properties}, via: 'search' });`;
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'leading array spread',
      'const [, sink] = [...values, createAnalytics(config)];',
    ],
    [
      'computed object-pattern key',
      'const { [key]: sink } = { [key]: createAnalytics(config) };',
    ],
    [
      'object rest target',
      'const { ...sink } = { tracker: createAnalytics(config) };',
    ],
    [
      'trailing object spread',
      'const { sink } = { sink: new Widget(), ...unknown };',
    ],
  ])('fails closed for a %s projection', (_name, setup) => {
    const code = factoryImport + setup + ' ' + invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'explicit property after an object spread',
      'const { sink } = { ...unknown, sink: new Widget() };',
    ],
    [
      'selected element before an array spread',
      'const [sink] = [new Widget(), ...unknown];',
    ],
  ])('keeps a %s precise', (_name, setup) => {
    expect(
      verify(setup + ' ' + dynamicCall(), plugin.eventRules(LINT_ARTIFACT))
    ).toEqual([]);
  });

  test.each([
    ['conditional', 'flag ? createAnalytics : createAnalytics'],
    ['mixed conditional', 'flag ? createAnalytics : makeUnknown'],
    ['logical', 'createAnalytics || makeUnknown'],
  ])('preserves %s factory provenance', (_name, expression) => {
    const code =
      factoryImport +
      `const make = ${expression}; const sink = make(config); ` +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    ['call', 'createAnalytics.call(null, config)'],
    ['apply', 'createAnalytics.apply(null, [config])'],
    ['Reflect.apply', 'Reflect.apply(createAnalytics, null, [config])'],
    ['bind', 'createAnalytics.bind(null)(config)'],
    [
      'aliased bind',
      'make(config)',
      'const make = createAnalytics.bind(null);',
    ],
  ])(
    'does not trust an unowned factory through %s',
    (_name, call, setup = '') => {
      const code =
        "import { createAnalytics } from './untrusted'; " +
        `${setup} const sink = ${call}; ` +
        dynamicCall();
      expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
    }
  );

  test('does not trust a destructured method from an unowned receiver', () => {
    const code =
      'const widget = new Widget(); let emit; ({ track: emit } = widget); ' +
      "emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });";
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test('distinguishes receiver calls on both sides of a replacement', () => {
    const code =
      factoryImport +
      'let sink = new Widget(); ' +
      dynamicCall() +
      ' sink = createAnalytics(config); ' +
      invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test('distinguishes method aliases on both sides of an assignment', () => {
    const code =
      'let emit; ' +
      "emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' }); " +
      "emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' }); " +
      '({ track: emit } = analytics); ' +
      "emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' }); " +
      "emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });";
    const { messages, stats } = verifyWithAnalysisStats(code);
    expect(messages.map((message) => message.messageId)).toEqual([
      ...expected,
      ...expected,
    ]);
    for (const counters of stats) {
      expect(counters.methodIntervalComputations).toBe(2);
    }
  });

  test('computes each provenance cache once per binding or interval', () => {
    const calls = Array.from({ length: 32 }, () =>
      invalidCall('services.tracker')
    ).join('\n');
    const code =
      factoryImport +
      'const make = createAnalytics; const source = new Widget(); ' +
      'const services = { tracker: source }; ' +
      'services.tracker = make(config); ' +
      calls;
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toHaveLength(64);
    expect(stats).toHaveLength(2);
    for (const counters of stats) {
      expect(counters.factoryBindingComputations).toBe(1);
      expect(counters.memberReceiverComputations).toBe(1);
      expect(counters.constructionBindingComputations).toBeGreaterThan(0);
      expect(counters.constructionBindingComputations).toBeLessThanOrEqual(2);
    }
  });

  test('summarizes computed receiver writes once across distinct names', () => {
    const size = 32;
    const properties = Array.from(
      { length: size },
      (_, index) => `method${index}: new Widget()`
    ).join(', ');
    const writes = Array.from(
      { length: size },
      (_, index) => `client[key${index}] = createAnalytics(config);`
    ).join('\n');
    const calls = Array.from({ length: size }, (_, index) =>
      invalidCall(`client.method${index}`)
    ).join('\n');
    const code =
      factoryImport + `const client = { ${properties} };\n${writes}\n${calls}`;
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toHaveLength(size * 2);
    for (const counters of stats) {
      expect(counters.receiverWriteIndexComputations).toBe(1);
      expect(counters.receiverWildcardSummaryComputations).toBe(2);
      expect(counters.receiverWildcardIntervalComputations).toBe(2);
    }
  });

  test('summarizes named receiver writes by change interval', () => {
    const size = 32;
    const body = Array.from(
      { length: size },
      () =>
        'services.tracker = createAnalytics(config);\n' +
        invalidCall('services.tracker')
    ).join('\n');
    const code =
      factoryImport + 'const services = { tracker: new Widget() };\n' + body;
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toHaveLength(size * 2);
    for (const counters of stats) {
      expect(counters.receiverWriteIndexComputations).toBe(1);
      expect(counters.receiverNamedSummaryComputations).toBe(1);
      expect(counters.receiverNamedIntervalComputations).toBe(size);
    }
  });

  test('resolves a shared receiver alias chain once across method names', () => {
    const size = 32;
    const properties = Array.from(
      { length: size },
      (_, index) => `method${index}: createAnalytics(config)`
    ).join(', ');
    const aliases = Array.from(
      { length: size },
      (_, index) => `const alias${index + 1} = alias${index};`
    ).join('\n');
    const calls = Array.from({ length: size }, (_, index) =>
      invalidCall(`alias${size}.method${index}`)
    ).join('\n');
    const code =
      factoryImport + `const alias0 = { ${properties} };\n${aliases}\n${calls}`;
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toHaveLength(size * 2);
    for (const counters of stats) {
      expect(counters.receiverObjectResolutionComputations).toBeLessThanOrEqual(
        size + 1
      );
    }
  });

  test('indexes one member-extraction holder across distinct paths', () => {
    const size = 32;
    const properties = Array.from(
      { length: size },
      (_, index) => `alias${index}: services`
    ).join(', ');
    const writes = Array.from(
      { length: size },
      (_, index) =>
        `const extracted${index} = holder.alias${index}; ` +
        `extracted${index}.tracker = createAnalytics(config);`
    ).join('\n');
    const code =
      factoryImport +
      `const services = { tracker: new Widget() }; ` +
      `const holder = { ${properties} };\n${writes}\n` +
      invalidCall('services.tracker');
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toHaveLength(2);
    for (const counters of stats) {
      expect(counters.memberExtractionIndexComputations).toBe(1);
    }
  });

  test('projects every sibling destructuring binding in linear work', () => {
    const {
      createProjectionTools,
    } = require('../eslint-plugin/event-projection');
    let keyReads = 0;
    let unwraps = 0;
    const tools = createProjectionTools({
      bindingInit: () => null,
      propertyKeyName(property) {
        keyReads += 1;
        return property.key.name;
      },
      resolveVariable: () => null,
      unwrap(node) {
        unwraps += 1;
        return node;
      },
    });
    const size = 2048;
    const targets = Array.from({ length: size }, (_, index) => ({
      type: 'Identifier',
      name: `value${index}`,
    }));
    const arrayPattern = { type: 'ArrayPattern', elements: targets };
    const array = {
      type: 'ArrayExpression',
      elements: targets.map((_target, index) => ({
        type: 'Literal',
        value: index,
      })),
    };
    for (const target of targets) {
      expect(
        tools.projectPatternBinding(arrayPattern, target, array).opaque
      ).toBe(false);
    }

    const objectPattern = {
      type: 'ObjectPattern',
      properties: targets.map((target, index) => ({
        type: 'Property',
        computed: false,
        key: { type: 'Identifier', name: `key${index}` },
        value: target,
      })),
    };
    const object = {
      type: 'ObjectExpression',
      properties: targets.map((_target, index) => ({
        type: 'Property',
        computed: false,
        kind: 'init',
        method: false,
        key: { type: 'Identifier', name: `key${index}` },
        value: { type: 'Literal', value: index },
      })),
    };
    for (const target of targets) {
      expect(
        tools.projectPatternBinding(objectPattern, target, object).opaque
      ).toBe(false);
    }

    expect(unwraps).toBeLessThan(size * 6);
    expect(keyReads).toBeLessThan(size * 4);
  });

  test('flattens deeply nested literal spreads without recursive copying', () => {
    const {
      createProjectionTools,
    } = require('../eslint-plugin/event-projection');
    let unwraps = 0;
    const tools = createProjectionTools({
      bindingInit: () => null,
      propertyKeyName: () => null,
      resolveVariable: () => null,
      unwrap(node) {
        unwraps += 1;
        return node;
      },
    });
    const depth = 4096;
    let object = {
      type: 'ObjectExpression',
      properties: [{ type: 'Property' }],
    };
    let array = {
      type: 'ArrayExpression',
      elements: [{ type: 'Literal', value: 1 }],
    };
    for (let index = 0; index < depth; index += 1) {
      object = {
        type: 'ObjectExpression',
        properties: [{ type: 'SpreadElement', argument: object }],
      };
      array = {
        type: 'ArrayExpression',
        elements: [{ type: 'SpreadElement', argument: array }],
      };
    }

    expect(tools.expandedObjectProperties(object)).toHaveLength(1);
    expect(tools.expandedArrayElements(array).elements).toHaveLength(1);
    expect(unwraps).toBe(depth * 2);
  });

  test('computes a shared factory binding once across distinct receivers', () => {
    const code =
      factoryImport +
      'const make = createAnalytics; ' +
      'const sink0 = make(config); const sink1 = make(config); const sink2 = make(config); ' +
      invalidCall('sink0') +
      invalidCall('sink1') +
      invalidCall('sink2');
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toHaveLength(6);
    for (const counters of stats) {
      expect(counters.factoryBindingComputations).toBe(1);
    }
  });

  test('computes a shared construction binding once across distinct members', () => {
    const code =
      'const source = new Widget(); ' +
      'const h0 = { tracker: source }; const h1 = { tracker: source }; const h2 = { tracker: source }; ' +
      dynamicCall('h0.tracker') +
      dynamicCall('h1.tracker') +
      dynamicCall('h2.tracker');
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toEqual([]);
    for (const counters of stats) {
      expect(counters.constructionBindingComputations).toBe(1);
    }
  });

  test('classifies one class property once across distinct call nodes', () => {
    const calls = Array.from({ length: 32 }, () =>
      invalidCall('this.tracker')
    ).join('\n');
    const code =
      factoryImport +
      `class C { tracker = createAnalytics(config); send() { ${calls} } }`;
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toHaveLength(64);
    for (const counters of stats) {
      expect(counters.classMemberComputations).toBe(1);
    }
  });

  test('classifies one container-method interval once across calls', () => {
    const calls = Array.from(
      { length: 32 },
      () =>
        "handlers.emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });"
    ).join('\n');
    const code =
      factoryImport +
      'const sink = createAnalytics(config); ' +
      'const handlers = { emit: sink.track }; ' +
      calls;
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toHaveLength(64);
    for (const counters of stats) {
      expect(counters.containerMethodComputations).toBe(1);
    }
  });

  test('indexes one receiver component once across distinct property names', () => {
    const calls = Array.from(
      { length: 256 },
      (_value, index) => `client.method${index}();`
    ).join('\n');
    const { messages, stats } = verifyWithAnalysisStats(
      `const client = new Widget(); ${calls}`
    );

    expect(messages).toEqual([]);
    for (const counters of stats) {
      expect(counters.receiverWriteIndexComputations).toBe(1);
    }
  });

  test('indexes one receiver literal across distinct property names', () => {
    const properties = Array.from(
      { length: 128 },
      (_value, index) => `method${index}: ordinary`
    ).join(',');
    const calls = Array.from(
      { length: 128 },
      (_value, index) => `handlers.method${index}();`
    ).join('\n');
    const { messages, stats } = verifyWithAnalysisStats(
      `const handlers = { ${properties} }; ${calls}`
    );

    expect(messages).toEqual([]);
    expect(
      stats.reduce(
        (sum, counters) => sum + counters.receiverObjectIndexComputations,
        0
      )
    ).toBe(1);
  });

  test('indexes distinct Object.assign property writes once', () => {
    const writes = Array.from(
      { length: 128 },
      (_value, index) => `Object.assign(client, { method${index}: ordinary });`
    ).join('\n');
    const calls = Array.from(
      { length: 128 },
      (_value, index) => `client.method${index}();`
    ).join('\n');
    const { messages, stats } = verifyWithAnalysisStats(
      `const client = new Widget(); ${writes} ${calls}`
    );

    expect(messages).toEqual([]);
    for (const counters of stats) {
      expect(counters.receiverWriteIndexComputations).toBeLessThanOrEqual(2);
      expect(counters.objectAssignFallbackVisits).toBe(0);
    }
  });

  test('indexes named Object.assign sources once across property names', () => {
    const size = 64;
    const sources = Array.from(
      { length: size },
      (_value, index) => `const source${index} = { method${index}: ordinary };`
    ).join('\n');
    const writes = Array.from(
      { length: size },
      (_value, index) => `Object.assign(client, source${index});`
    ).join('\n');
    const calls = Array.from(
      { length: size },
      (_value, index) => `client.method${index}();`
    ).join('\n');
    const { messages, stats } = verifyWithAnalysisStats(
      `const client = new Widget(); ${sources} ${writes} ${calls}`
    );

    expect(messages).toEqual([]);
    for (const counters of stats) {
      expect(counters.receiverWriteIndexComputations).toBeLessThanOrEqual(2);
      expect(counters.objectAssignFallbackVisits).toBe(0);
      expect(counters.objectAssignSourceIndexVisits).toBeLessThanOrEqual(size);
    }
    expect(
      stats.reduce(
        (sum, counters) => sum + counters.objectAssignSourceIndexVisits,
        0
      )
    ).toBe(size * 2);
  });

  test('indexes one Object.assign source component across its properties', () => {
    const size = 8;
    const properties = Array.from(
      { length: size },
      (_value, index) => `method${index}: ordinary`
    ).join(',');
    const aliases = Array.from(
      { length: size },
      (_value, index) => `const source${index} = source;`
    ).join('\n');
    const calls = Array.from(
      { length: size },
      (_value, index) => `client.method${index}();`
    ).join('\n');
    const writes = Array.from(
      { length: size },
      (_value, index) => `Object.assign(client, source${index});`
    ).join('\n');
    const { messages, stats } = verifyWithAnalysisStats(
      `const source = { ${properties} }; ${aliases} ` +
        `const client = new Widget(); ${writes} ${calls}`
    );

    expect(messages).toEqual([]);
    expect(
      stats.reduce(
        (sum, counters) => sum + counters.receiverMutationReferenceVisits,
        0
      )
    ).toBeGreaterThan(0);
    for (const counters of stats) {
      expect(counters.receiverMutationReferenceVisits).toBeLessThanOrEqual(
        size * 4
      );
    }
  });

  test('memoizes reconverging Function forwarder provenance by binding', () => {
    const depth = 12;
    const bindings = [
      'let left0 = Function.prototype.call;',
      'let right0 = Function.prototype.call;',
    ];
    for (let index = 1; index <= depth; index += 1) {
      bindings.push(
        `let left${index} = left${index - 1}; left${index} = right${index - 1};`,
        `let right${index} = right${index - 1}; right${index} = left${index - 1};`
      );
    }
    const code =
      `${bindings.join('\n')} ` +
      'const descriptor = { value: function () { return analytics; } }; ' +
      `left${depth}.call(Object.defineProperty, null, globalThis, 'Proxy', descriptor); ` +
      'const sink = new Proxy(new Widget(), {}); ' +
      invalidCall();
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages.map((message) => message.messageId)).toEqual(expected);
    expect(
      stats.reduce(
        (sum, counters) => sum + counters.forwarderBindingComputations,
        0
      )
    ).toBeLessThanOrEqual((depth + 1) * 2 + 1);
  });

  test('memoizes reconverging Proxy constructor provenance by binding', () => {
    const depth = 20;
    const bindings = ['const left0 = Proxy;', 'const right0 = Proxy;'];
    for (let index = 1; index <= depth; index += 1) {
      bindings.push(
        `const left${index} = condition ? left${index - 1} : right${index - 1};`,
        `const right${index} = condition ? right${index - 1} : left${index - 1};`
      );
    }
    const code =
      `${bindings.join('\n')} ` +
      `const sink = new left${depth}(analytics, {}); ` +
      invalidCall();
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages.map((message) => message.messageId)).toEqual(expected);
    for (const counters of stats) {
      expect(counters.proxyConstructorComputations).toBeLessThanOrEqual(
        (depth + 1) * 2
      );
    }
  });

  test('indexes one class body across distinct property names', () => {
    const fields = Array.from(
      { length: 128 },
      (_value, index) => `service${index} = new Widget();`
    ).join('\n');
    const calls = Array.from({ length: 128 }, (_value, index) =>
      dynamicCall(`this.service${index}`)
    ).join('\n');
    const { messages, stats } = verifyWithAnalysisStats(
      `class C { ${fields} send() { ${calls} } }`
    );

    expect(messages).toEqual([]);
    for (const counters of stats) {
      expect(counters.classCandidateIndexComputations).toBe(1);
    }
  });

  test('indexes distinct whole-binding replacements once', () => {
    const replacements = Array.from(
      { length: 128 },
      (_value, index) => `handlers = { method${index}: ordinary };`
    ).join('\n');
    const calls = Array.from(
      { length: 128 },
      (_value, index) => `handlers.method${index}();`
    ).join('\n');
    const { messages, stats } = verifyWithAnalysisStats(
      `let handlers = {}; ${replacements} ${calls}`
    );

    expect(messages).toEqual([]);
    for (const counters of stats) {
      expect(counters.bindingReplacementIndexComputations).toBe(1);
    }
  });

  test('caches eval reachability across 600 and 1200 calls through one alias', () => {
    const runs = [];
    for (const size of [600, 1200]) {
      const calls = Array.from({ length: size }, () => 'execute(source);').join(
        '\n'
      );
      const code =
        `const execute = eval; ${calls} ` +
        'const sink = Object.assign(new Widget(), {}); ' +
        invalidCall();
      const { messages, stats } = verifyWithAnalysisStats(code);
      const total = (name) =>
        stats.reduce((sum, counters) => sum + counters[name], 0);
      const counters = {
        cacheHits: total('evalBindingCacheHits'),
        computations: total('evalBindingComputations'),
        sourceScans: total('evalSourceScans'),
      };

      expect(messages.map((message) => message.messageId)).toEqual([
        'unanalyzable',
        'unanalyzable',
      ]);
      expect(counters.computations).toBeGreaterThan(0);
      expect(counters.computations).toBeLessThanOrEqual(size * 3 + 3);
      expect(counters.cacheHits).toBeGreaterThan(0);
      expect(counters.cacheHits).toBeLessThanOrEqual(size * 3 + 3);
      expect(counters.sourceScans).toBeGreaterThan(0);
      expect(counters.sourceScans).toBeLessThanOrEqual(size * 3 + 3);
      runs.push(counters);
    }

    expect(runs[1].computations).toBeLessThanOrEqual(
      runs[0].computations * 2 + 3
    );
    expect(runs[1].cacheHits).toBeLessThanOrEqual(runs[0].cacheHits * 2 + 3);
    expect(runs[1].sourceScans).toBeLessThanOrEqual(
      runs[0].sourceScans * 2 + 3
    );
  });

  test('indexes exact and wildcard static-container properties at 600 and 1200 lookups', () => {
    const runs = [];
    for (const size of [600, 1200]) {
      const properties = Array.from(
        { length: size },
        (_value, index) => `method${index}: Object.assign`
      ).join(',\n');
      const calls = Array.from(
        { length: size },
        (_value, index) => `operations.method${index}({}, {});`
      ).join('\n');
      const code =
        `const operations = { ${properties}, [patient.operation]: Object.assign }; ` +
        `${calls} const sink = operations.method${size - 1}(new Widget(), {}); ` +
        `${dynamicCall()} ${invalidCall('analytics')}`;
      const { messages, stats } = verifyWithAnalysisStats(code);
      const total = (name) =>
        stats.reduce((sum, counters) => sum + counters[name], 0);
      const counters = {
        cacheHits: total('staticContainerPropertyIndexCacheHits'),
        computations: total('staticContainerPropertyIndexComputations'),
        exactVisits: total('staticContainerPropertyIndexExactCandidateVisits'),
        propertyVisits: total('staticContainerPropertyIndexPropertyVisits'),
        wildcardVisits: total(
          'staticContainerPropertyIndexWildcardCandidateVisits'
        ),
      };

      expect(messages.map((message) => message.messageId)).toEqual([
        'dynamicEvent',
        'unbound',
        ...expected,
      ]);
      expect(counters.computations).toBeGreaterThan(0);
      expect(counters.computations).toBeLessThanOrEqual(3);
      expect(counters.cacheHits).toBeGreaterThan(0);
      expect(counters.cacheHits).toBeLessThanOrEqual(size * 10 + 10);
      expect(counters.propertyVisits).toBeGreaterThan(0);
      expect(counters.propertyVisits).toBeLessThanOrEqual(size * 3 + 3);
      expect(counters.exactVisits).toBeGreaterThan(0);
      expect(counters.exactVisits).toBeLessThanOrEqual(size * 10 + 10);
      expect(counters.wildcardVisits).toBeGreaterThan(0);
      expect(counters.wildcardVisits).toBeLessThanOrEqual(size * 10 + 10);
      runs.push(counters);
    }

    for (const name of [
      'cacheHits',
      'exactVisits',
      'propertyVisits',
      'wildcardVisits',
    ]) {
      expect(runs[1][name]).toBeLessThanOrEqual(runs[0][name] * 2 + 3);
    }
  });

  test('caches whole-binding static-container sources at 600 and 1200 member uses', () => {
    const runs = [];
    for (const size of [600, 1200]) {
      const replacements = Array.from(
        { length: size },
        (_value, index) => `operations = { method${index}: Object.assign };`
      ).join('\n');
      const uses = Array.from(
        { length: size },
        (_value, index) => `operations.method${index}({}, {});`
      ).join('\n');
      const code =
        `let operations = {}; ${replacements} ${uses} ` +
        `new Proxy(new Widget(), {}).track(patient.event, { [patient.id]: patient.name });`;
      const { messages, stats } = verifyWithAnalysisStats(code);
      const total = (name) =>
        stats.reduce((sum, counters) => sum + counters[name], 0);
      const counters = {
        cacheHits: total('staticContainerSourceCacheHits'),
        dedupVisits: total('staticContainerSourceDedupVisits'),
        referenceVisits: total('staticContainerSourceReferenceVisits'),
        summaryComputations: total('staticContainerSourceSummaryComputations'),
      };

      expect(messages).toEqual([]);
      expect(counters.summaryComputations).toBe(2);
      expect(counters.referenceVisits).toBeGreaterThan(0);
      expect(counters.referenceVisits).toBeLessThanOrEqual(size * 3 + 1);
      expect(counters.dedupVisits).toBeGreaterThan(0);
      expect(counters.dedupVisits).toBeLessThanOrEqual(size * 2 + 2);
      expect(counters.cacheHits).toBeGreaterThan(0);
      expect(counters.cacheHits).toBeLessThanOrEqual(size * 12);
      runs.push(counters);
    }

    expect(runs[1].referenceVisits).toBeLessThanOrEqual(
      runs[0].referenceVisits * 2 + 1
    );
    expect(runs[1].dedupVisits).toBeLessThanOrEqual(runs[0].dedupVisits * 2);
    expect(runs[1].cacheHits).toBeLessThanOrEqual(runs[0].cacheHits * 2 + 2);
  });

  test('resolves one class alias once across distinct assignments', () => {
    const assignments = Array.from(
      { length: 128 },
      (_value, index) => `self.service${index} = new Widget();`
    ).join('\n');
    const calls = Array.from({ length: 128 }, (_value, index) =>
      dynamicCall(`self.service${index}`)
    ).join('\n');
    const code = `class C { send() { const self = this; ${assignments} ${calls} } }`;
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toEqual([]);
    for (const counters of stats) {
      expect(counters.classAliasValueComputations).toBe(1);
    }
  });

  test('reuses class alias values across distinct enclosing class bodies', () => {
    const size = 16;
    const nested = Array.from(
      { length: size },
      (_value, index) =>
        `class Nested${index} { send() { ${dynamicCall(`self.service${index}`)} } }`
    ).join('\n');
    const code = `class Outer { send() { const self = this; ${nested} } }`;
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toEqual([]);
    for (const counters of stats) {
      expect(counters.classAliasValueComputations).toBe(1);
    }
  });

  test('reuses one analytics namespace alias across factory bindings', () => {
    const size = 32;
    const factories = Array.from(
      { length: size },
      (_value, index) =>
        `const make${index} = ns.createAnalytics; ` +
        `const sink${index} = make${index}(config); ${invalidCall(`sink${index}`)}`
    ).join('\n');
    const code =
      "import * as api from 'react-native-nitro-logger/analytics'; " +
      `const ns = api; ${factories}`;
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toHaveLength(size * 2);
    for (const counters of stats) {
      expect(counters.namespaceBindingComputations).toBe(1);
    }
  });

  test('memoizes a class receiver identity across a long alias chain', () => {
    const size = 32;
    const aliases = Array.from(
      { length: size },
      (_, index) =>
        `const self${index + 1} = self${index}; self${index + 1}.service${index} = new Widget();`
    ).join('\n');
    const calls = Array.from({ length: size }, (_value, index) =>
      dynamicCall(`self${size}.service${index}`)
    ).join('\n');
    const code = `class C { send() { const self0 = this; ${aliases} ${calls} } }`;
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toEqual([]);
    for (const counters of stats) {
      expect(counters.classIdentityComputations).toBeLessThanOrEqual(size + 1);
    }
  });

  test('joins a named array spread to its targets in linear work', () => {
    const size = 64;
    const values = Array.from({ length: size }, () => 'services').join(', ');
    const aliases = Array.from(
      { length: size },
      (_value, index) => `alias${index}`
    ).join(', ');
    const writes = Array.from(
      { length: size },
      (_value, index) => `alias${index}.tracker = createAnalytics(config);`
    ).join('\n');
    const code =
      factoryImport +
      `const services = { tracker: new Widget() }; const values = [${values}]; ` +
      `const [${aliases}] = [...values]; ${writes} ` +
      invalidCall('services.tracker');
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toHaveLength(2);
    for (const counters of stats) {
      expect(counters.memberSpreadJoinVisits).toBeLessThanOrEqual(size * 4);
    }
    expect(
      stats.reduce(
        (sum, counters) => sum + counters.arrayElementIndexComputations,
        0
      )
    ).toBe(1);
  });

  test('resolves one immutable projection container once across bindings', () => {
    const size = 64;
    const uses = Array.from(
      { length: size },
      (_value, index) =>
        `const [sink${index}] = values; ${invalidCall(`sink${index}`)}`
    ).join('\n');
    const code =
      factoryImport + `const values = [createAnalytics(config)]; ${uses}`;
    const { messages, stats } = verifyWithAnalysisStats(code);

    expect(messages).toHaveLength(size * 2);
    for (const counters of stats) {
      expect(counters.projectionContainerComputations).toBe(1);
    }
  });

  // TQ33-01: opacity belongs to the namespace path, not merely to an
  // obviously dangerous Proxy target. Widget targets discriminate that
  // invariant from a detector that only searches the argument list.
  test.each([
    [
      'mixed',
      'const ordinaryNamespace = { assign: ordinary }; const namespaces = choose ? { object: Object } : { object: ordinaryNamespace };',
      'namespaces.object',
    ],
    [
      'opaque computed',
      'const namespaces = { object: Object };',
      'namespaces[key]',
    ],
    [
      'cyclic',
      'const namespaces = { object: Object }; namespaces.self = namespaces;',
      'namespaces.object',
    ],
    [
      'mutated',
      'const ordinaryNamespace = { assign: ordinary }; const namespaces = { object: ordinaryNamespace }; namespaces.object = Object;',
      'namespaces.object',
    ],
    [
      'escaped',
      'const namespaces = { object: Object }; mutate(namespaces);',
      'namespaces.object',
    ],
  ])(
    'fails closed for a %s Object namespace escape with a Widget target',
    (_name, setup, namespace) => {
      const code =
        `${setup} const P = ${namespace}.assign(Widget, {}); ` +
        `const sink = new P(analytics, {}); ${invalidCall()}`;
      expect(
        verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
          (message) => message.messageId
        )
      ).toEqual(expected);
    }
  );

  test('scales a deep ordinary static-array alias across repeated Widget consumers', () => {
    const depth = 128;
    const consumers = 64;
    const bindings = ['const args0 = [Widget, {}];'];
    for (let index = 1; index <= depth; index += 1) {
      bindings.push(`const args${index} = args${index - 1};`);
    }
    const calls = Array.from({ length: consumers }, (_unused, index) => {
      return (
        `const P${index} = Object.assign(...args${depth}); ` +
        `const sink${index} = new P${index}(); ` +
        dynamicCall(`sink${index}`)
      );
    });
    const { messages, stats } = verifyWithAnalysisStats(
      `${bindings.join('\n')} ${calls.join('\n')}`
    );
    const total = (name) =>
      stats.reduce((sum, counters) => sum + counters[name], 0);

    expect(messages).toEqual([]);
    expect(total('staticArrayAliasBindingVisits')).toBeGreaterThan(0);
    expect(total('staticArrayAliasBindingVisits')).toBeLessThanOrEqual(
      2 * (depth + 1)
    );
    expect(total('staticArrayAliasResolutionHops')).toBeGreaterThan(0);
    expect(total('staticArrayAliasResolutionHops')).toBeLessThanOrEqual(
      2 * (depth + 1)
    );
  });

  // SEC007: inherited Function forwarders must retain the mutator they invoke
  // through every supported extraction/container/computed form.
  test.each([
    [
      'direct inherited call',
      "Reflect.set.call(Reflect, globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'aliased inherited call',
      "const inherited = Reflect.set.call; inherited.call(Reflect.set, Reflect, globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'container-held inherited call',
      "const ops = { inherited: Reflect.set.call }; ops.inherited.call(Reflect.set, Reflect, globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'static computed inherited call',
      "const key = 'call'; Reflect.set[key](Reflect, globalThis, 'Proxy', function () { return analytics; });",
    ],
    [
      'dynamic computed inherited call',
      "Reflect.set[key](Reflect, globalThis, 'Proxy', function () { return analytics; });",
    ],
  ])('fails closed for a Proxy replaced through %s', (_name, mutation) => {
    const code =
      `${mutation} const sink = new Proxy(new Widget(), {}); ` + invalidCall();
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'a safe mutation target',
      "Reflect.set.call(Reflect, holder, 'Proxy', function () { return analytics; });",
    ],
    [
      'a shadowed mutator namespace',
      "const Reflect = { set() {} }; Reflect.set.call(Reflect, holder, 'Proxy', function () { return analytics; });",
    ],
    [
      'an ordinary inherited callable',
      'const ops = { inherited: ordinary.call }; ops.inherited.call(ordinary, null);',
    ],
  ])('keeps %s silent', (_name, setup) => {
    const code =
      `${setup} const sink = new Proxy(new Widget(), {}); ` + dynamicCall();
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  // SEC008: getter-backed namespace containers participate in the same exact,
  // opaque and cycle-safe provenance lattice as data properties.
  test.each([
    [
      'an exact accessor',
      'const namespaces = { get object() { return Object; } };',
      'namespaces.object',
      'Proxy',
    ],
    [
      'a mixed accessor',
      'const ordinaryNamespace = { assign() { return Widget; } }; const namespaces = { get object() { return choose ? Object : ordinaryNamespace; } };',
      'namespaces.object',
      'Widget',
    ],
    [
      'an opaque accessor',
      'const namespaces = { get object() { return loadNamespace(); } };',
      'namespaces.object',
      'Widget',
    ],
    [
      'a cyclic accessor graph',
      'const namespaces = { get object() { return choose ? Object : alias.object; } }; const alias = { get object() { return namespaces.object; } };',
      'alias.object',
      'Widget',
    ],
  ])(
    'fails closed for %s escaping Object',
    (_name, setup, namespace, target) => {
      const code =
        `${setup} const P = ${namespace}.assign(${target}, {}); ` +
        `const sink = new P(analytics, {}); ${invalidCall()}`;
      const messages = verify(code, plugin.eventRules(LINT_ARTIFACT));
      expect(messages.every((message) => message.fatal !== true)).toBe(true);
      expect(messages.map((message) => message.messageId)).toEqual(expected);
    }
  );

  test.each([
    [
      'an exact safe accessor',
      'const namespaces = { get object() { return Object; } }; const P = namespaces.object.assign(Widget, {});',
    ],
    [
      'an ordinary accessor',
      'const ordinaryNamespace = { assign() { return Widget; } }; const namespaces = { get object() { return ordinaryNamespace; } }; const P = namespaces.object.assign(Widget, {});',
    ],
    [
      'a shadowed Object accessor',
      'const Object = { assign() { return Widget; } }; const namespaces = { get object() { return Object; } }; const P = namespaces.object.assign(Widget, {});',
    ],
  ])('keeps %s silent', (_name, setup) => {
    const code = `${setup} const sink = new P(); ${dynamicCall()}`;
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  // SEC009: getters can expose either the analytics receiver or its callable
  // method, through public/private and instance/static class surfaces.
  test.each([
    [
      'an instance public analytics getter',
      `class C { get tracker() { return analytics; } send() { ${invalidCall('this.tracker')} } }`,
    ],
    [
      'a static public analytics getter',
      `class C { static get tracker() { return analytics; } static send() { ${invalidCall('this.tracker')} } }`,
    ],
    [
      'an instance private analytics getter',
      `class C { get #tracker() { return analytics; } send() { ${invalidCall('this.#tracker')} } }`,
    ],
    [
      'a static private analytics getter',
      `class C { static get #tracker() { return analytics; } static send() { ${invalidCall('this.#tracker')} } }`,
    ],
    [
      'a public event-method getter',
      `class C { get emit() { return analytics.track; } send() { ${invalidMethodCall('this.emit')} } }`,
    ],
    [
      'a private event-method getter',
      `class C { get #emit() { return analytics.track; } send() { ${invalidMethodCall('this.#emit')} } }`,
    ],
    [
      'a branched analytics getter',
      `class C { get tracker() { return flag ? analytics : new Widget(); } send() { ${invalidCall('this.tracker')} } }`,
    ],
    [
      'an opaque analytics getter',
      `class C { get tracker() { return loadTracker(); } send() { ${invalidCall('this.tracker')} } }`,
    ],
  ])('resolves %s', (_name, code) => {
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(expected);
  });

  test.each([
    [
      'an instance ordinary getter',
      `class C { get tracker() { return new Widget(); } send() { ${dynamicCall('this.tracker')} } }`,
    ],
    [
      'a static ordinary getter',
      `class C { static get tracker() { return new Widget(); } static send() { ${dynamicCall('this.tracker')} } }`,
    ],
    [
      'a private ordinary getter',
      `class C { get #tracker() { return new Widget(); } send() { ${dynamicCall('this.#tracker')} } }`,
    ],
    [
      'an ordinary method getter',
      `class C { get emit() { return widget.track; } send() { this.emit(patient.event, { [patient.id]: patient.name }); } }`,
    ],
    [
      'an ordinary branched getter',
      `class C { get tracker() { return flag ? new Widget() : new OtherWidget(); } send() { ${dynamicCall('this.tracker')} } }`,
    ],
  ])('keeps %s silent', (_name, code) => {
    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  const deepCycleDepth = 4000;
  const deepChainCases = [
    [
      'receiver',
      () => {
        const lines = ['const value0 = new Widget();'];
        for (let index = 1; index <= deepCycleDepth; index += 1) {
          lines.push(`const value${index} = value${index - 1};`);
        }
        lines.push(
          `let left = value${deepCycleDepth};`,
          'let right = left;',
          'left = right;',
          dynamicCall('right')
        );
        return lines.join('\n');
      },
      ['dynamicEvent', 'unbound'],
      'constructionBindingComputations',
    ],
    [
      'method',
      () => {
        const lines = ['const value0 = analytics.track;'];
        for (let index = 1; index <= deepCycleDepth; index += 1) {
          lines.push(`const value${index} = value${index - 1};`);
        }
        lines.push(
          `let left = value${deepCycleDepth};`,
          'let right = left;',
          'left = right;',
          invalidMethodCall('right')
        );
        return lines.join('\n');
      },
      expected,
      'methodIntervalComputations',
    ],
    [
      'factory',
      () => {
        const lines = [factoryImport, 'const value0 = createAnalytics;'];
        for (let index = 1; index <= deepCycleDepth; index += 1) {
          lines.push(`const value${index} = value${index - 1};`);
        }
        lines.push(
          `let left = value${deepCycleDepth};`,
          'let right = left;',
          'left = right;',
          'const sink = right(config);',
          invalidCall()
        );
        return lines.join('\n');
      },
      expected,
      'factoryBindingComputations',
    ],
    [
      'shared namespace',
      () => {
        const lines = ['const value0 = Object;'];
        for (let index = 1; index <= deepCycleDepth; index += 1) {
          lines.push(`const value${index} = value${index - 1};`);
        }
        lines.push(
          `let left = value${deepCycleDepth};`,
          'let right = left;',
          'left = right;',
          'const P = right.assign(Widget, {});',
          'const sink = new P();',
          dynamicCall()
        );
        return lines.join('\n');
      },
      ['dynamicEvent', 'unbound'],
      'builtinNamespaceBindingComputations',
    ],
  ];

  test.each(deepChainCases)(
    'handles a 4,000-hop %s chain and terminal cycle without overflowing',
    (_name, build, outcome, counter) => {
      const { messages, stats } = verifyWithAnalysisStats(build());
      expect(messages.every((message) => message.fatal !== true)).toBe(true);
      expect(messages.map((message) => message.messageId)).toEqual(outcome);
      for (const counters of stats) {
        expect(Number.isFinite(counters[counter])).toBe(true);
        expect(counters[counter]).toBeLessThanOrEqual(deepCycleDepth + 8);
      }
    }
  );
});

describe('eventRules configuration helper', () => {
  test('pins the exact event method, factory, and privacy-wrapper trust lists', () => {
    const analysis = require('../eslint-plugin/event-analysis');

    expect([...analysis.EVENT_METHODS]).toEqual(['track']);
    expect([...analysis.ANALYTICS_FACTORY_NAMES]).toEqual(['createAnalytics']);
    expect([...analysis.PRIVACY_WRAPPER_NAMES]).toEqual(['priv', 'pub']);
  });

  test('memoizes each binding reference summary once per rule context', () => {
    const { bindingValues } = require('../eslint-plugin/event-analysis');
    let scans = 0;
    const stored = [
      { init: true, isWrite: () => true, writeExpr: null },
      { init: false, isWrite: () => true, writeExpr: { type: 'Identifier' } },
    ];
    const references = {
      [Symbol.iterator]() {
        scans += 1;
        return stored[Symbol.iterator]();
      },
    };
    const variable = {
      defs: [
        {
          type: 'Variable',
          node: {
            id: { type: 'Identifier' },
            init: { type: 'NewExpression' },
          },
        },
      ],
      references,
    };
    const context = {};

    const first = bindingValues(context, variable);
    expect(bindingValues(context, variable)).toBe(first);
    expect(scans).toBe(1);
    expect(bindingValues({}, variable)).not.toBe(first);
    expect(scans).toBe(2);
  });

  test('memoizes derived receiver and method summaries across call sites', () => {
    const {
      RECEIVER_CLASSIFICATION,
      methodBindingCandidates,
      receiverBindingSummary,
    } = require('../eslint-plugin/event-analysis');
    const values = Array.from({ length: 4096 }, () => ({
      type: 'MemberExpression',
      computed: false,
      object: {
        type: 'ObjectExpression',
        properties: [
          {
            type: 'Property',
            computed: false,
            kind: 'init',
            method: false,
            key: { type: 'Identifier', name: 'tracker' },
            value: { type: 'NewExpression' },
          },
        ],
      },
      property: { type: 'Identifier', name: 'tracker' },
    }));
    const variable = {
      name: 'sink',
      defs: [
        {
          type: 'Variable',
          node: { id: { type: 'Identifier' }, init: values[0] },
        },
      ],
      references: values.slice(1).map((writeExpr) => ({
        init: false,
        isWrite: () => true,
        writeExpr,
      })),
    };
    const context = {};

    const receiver = receiverBindingSummary(context, variable);
    expect(receiver.result).toBe(RECEIVER_CLASSIFICATION.NON_ANALYTICS);
    expect(receiver.dynamicValues).toEqual([]);
    expect(receiverBindingSummary(context, variable)).toBe(receiver);
    const methods = methodBindingCandidates(context, variable);
    expect(methods).toEqual([]);
    expect(methodBindingCandidates(context, variable)).toBe(methods);
  });

  test('compiles string constraints into constant-time membership indexes', () => {
    const { compileLintArtifact } = require('../eslint-plugin/event-artifact');
    const { satisfies } = require('../eslint-plugin/event-analysis');
    const compiled = compileLintArtifact(LINT_ARTIFACT);
    const constraint =
      compiled.events.appointment_booked.propertiesByName.clinic_type
        .constraint;

    expect(constraint).not.toHaveProperty('values');
    expect(Object.getPrototypeOf(constraint.members)).toBeNull();
    expect(Object.isFrozen(constraint.members)).toBe(true);
    expect(satisfies(constraint, 'specialist')).toBe(true);
    expect(satisfies(constraint, 'walk-in')).toBe(false);
  });

  test('deduplicates reconverging receiver-alias graphs', () => {
    const lines = [
      "import { createAnalytics } from 'react-native-nitro-logger/analytics';",
      'const services = { tracker: new Widget() };',
      'let left0 = services; let right0 = services;',
    ];
    for (let index = 1; index <= 16; index += 1) {
      lines.push(
        `let left${index} = left${index - 1}; left${index} = right${index - 1};`,
        `let right${index} = left${index - 1}; right${index} = right${index - 1};`
      );
    }
    lines.push(
      'right16.tracker = createAnalytics(config);',
      "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });"
    );

    expect(
      verify(lines.join('\n'), plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['invalidValue', 'unbound']);
  });

  test('visits each node once when receiver alias graphs reconverge', () => {
    const { graphClosure } = require('../eslint-plugin/shared');
    const root = {};
    const left = {};
    const right = {};
    const shared = {};
    const edges = new Map([
      [root, [left, right]],
      [left, [shared]],
      [right, [shared]],
      [shared, []],
    ]);
    const scans = new Map();

    const closure = graphClosure(root, (node) => {
      scans.set(node, (scans.get(node) ?? 0) + 1);
      return edges.get(node);
    });

    expect(new Set(closure)).toEqual(new Set([root, left, right, shared]));
    expect([...scans.values()]).toEqual([1, 1, 1, 1]);
  });

  test.each([
    [
      'nested destructuring member writes',
      'const services = { tracker: new Widget() }; ' +
        '({ tracker: services.tracker } = { tracker: createAnalytics(config) }); ' +
        "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
    ],
    [
      'nested destructuring binding writes',
      'let sink = new Widget(); ' +
        '({ tracker: sink } = { tracker: createAnalytics(config) }); ' +
        "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
    ],
    [
      'mutable replacement sources',
      'let source = { tracker: new Widget() }; source = loadServices(); ' +
        'let services = { tracker: new Widget() }; services = source; ' +
        "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
    ],
    [
      'Object.assign sources with a leading spread',
      'const services = { tracker: new Widget() }; ' +
        'Object.assign(services, { ...extras, tracker: createAnalytics(config) }); ' +
        "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
    ],
    [
      'Object.assign sources with a trailing ambiguous spread',
      'const services = { tracker: new Widget() }; ' +
        'Object.assign(services, { tracker: createAnalytics(config), ...extras }); ' +
        "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
    ],
  ])('fails closed for %s', (_name, body) => {
    const code =
      "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
      body;

    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['invalidValue', 'unbound']);
  });

  test.each([
    ['call', 'createAnalytics.call(null, config)'],
    ['apply', 'createAnalytics.apply(null, [config])'],
    ['inline bind', 'createAnalytics.bind(null)(config)'],
    [
      'aliased bind',
      'make(config)',
      'const make = createAnalytics.bind(null);',
    ],
  ])('recognizes trusted factory %s wrappers', (_name, factory, setup = '') => {
    const code =
      "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
      `${setup} const sink = ${factory}; ` +
      "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });";

    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['invalidValue', 'unbound']);
  });

  test('does not trust a factory call through a shadowed Reflect.apply', () => {
    const code =
      "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
      'const Reflect = { apply() { return new Widget(); } }; ' +
      'const sink = Reflect.apply(createAnalytics, null, [config]); ' +
      'sink.track(patient.event, { [patient.id]: patient.name });';
    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['unanalyzable', 'unanalyzable']);
  });

  test('normalizes post-declaration destructured method aliases', () => {
    const code =
      'let emit; ({ track: emit } = analytics); ' +
      "emit('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });";

    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['invalidValue', 'unbound']);
  });

  test.each([
    [
      'opaque replacement',
      'let services = { tracker: new Widget() }; services = loadServices(); ' +
        "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
    ],
    [
      'computed replacement',
      'let services = { tracker: new Widget() }; ' +
        'services = { tracker: createAnalytics(config), [key]: other }; ' +
        "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
    ],
  ])('fails closed for an %s', (_name, body) => {
    const code =
      "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
      body;

    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['invalidValue', 'unbound']);
  });

  test('ignores a later straight-line receiver replacement', () => {
    const code =
      "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
      'let sink = new Widget(); ' +
      'sink.track(patient.event, { [patient.id]: patient.name }); ' +
      'sink = createAnalytics(config);';

    expect(verify(code, plugin.eventRules(LINT_ARTIFACT))).toEqual([]);
  });

  test('includes a later replacement for an earlier deferred call', () => {
    const code =
      "import { createAnalytics } from 'react-native-nitro-logger/analytics'; " +
      'let sink = new Widget(); ' +
      'function send() { ' +
      "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' }); " +
      '} sink = createAnalytics(config); send();';

    expect(
      verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['invalidValue', 'unbound']);
  });

  test('memoizes reconverging trusted-factory alias graphs', () => {
    const lines = [
      "import { createAnalytics } from 'react-native-nitro-logger/analytics';",
      'let left0 = createAnalytics; let right0 = createAnalytics;',
    ];
    for (let index = 1; index <= 16; index += 1) {
      lines.push(
        `let left${index} = left${index - 1}; left${index} = right${index - 1};`,
        `let right${index} = left${index - 1}; right${index} = right${index - 1};`
      );
    }
    lines.push(
      'const sink = left16(config);',
      "sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });"
    );

    expect(
      verify(lines.join('\n'), plugin.eventRules(LINT_ARTIFACT)).map(
        (message) => message.messageId
      )
    ).toEqual(['invalidValue', 'unbound']);
  });

  test('memoizes reconverging construction-provenance graphs', () => {
    const lines = ['let left0 = new Widget(); let right0 = new Widget();'];
    for (let index = 1; index <= 16; index += 1) {
      lines.push(
        `let left${index} = left${index - 1}; left${index} = right${index - 1};`,
        `let right${index} = left${index - 1}; right${index} = right${index - 1};`
      );
    }
    lines.push(
      'const sink = left16;',
      'sink.track(patient.event, { [patient.id]: patient.name });'
    );

    expect(verify(lines.join('\n'), plugin.eventRules(LINT_ARTIFACT))).toEqual(
      []
    );
  });

  test('reuses call-sensitive receiver results within one change interval', () => {
    const lines = [
      "import { createAnalytics } from 'react-native-nitro-logger/analytics';",
      'const services = { tracker: new Widget() };',
    ];
    for (let index = 0; index < 64; index += 1) {
      lines.push(
        index === 63
          ? 'services.tracker = createAnalytics(config);'
          : 'services.tracker = new Widget();'
      );
    }
    for (let index = 0; index < 64; index += 1) {
      lines.push(
        "services.tracker.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });"
      );
    }

    const messageIds = verify(
      lines.join('\n'),
      plugin.eventRules(LINT_ARTIFACT)
    ).map((message) => message.messageId);
    expect(messageIds).toHaveLength(128);
    expect(new Set(messageIds)).toEqual(new Set(['invalidValue', 'unbound']));
  });

  test('registers both schema-dependent rules without changing the presets', () => {
    expect(typeof plugin.eventRules).toBe('function');
    const rules = plugin.eventRules(LINT_ARTIFACT);

    expect(Object.keys(rules).sort()).toEqual([
      'nitro-logger/require-event-privacy',
      'nitro-logger/typed-event-schema',
    ]);
    for (const value of Object.values(rules)) {
      expect(value[0]).toBe('error');
    }
    expect(plugin.configs.recommended.rules).not.toHaveProperty(
      'nitro-logger/typed-event-schema'
    );
    expect(plugin.configs.strict.rules).not.toHaveProperty(
      'nitro-logger/require-event-privacy'
    );
  });

  test('keeps both direct-rule schemas identical and rejects empty list members', () => {
    const typed = plugin.rules['typed-event-schema'].meta.schema;
    const privacy = plugin.rules['require-event-privacy'].meta.schema;

    expect(typed).toEqual(privacy);
    for (const name of [
      'analyticsNames',
      'analyticsModules',
      'privacyModules',
    ]) {
      expect(typed[0].properties[name].items).toEqual({
        type: 'string',
        minLength: 1,
      });
    }
  });

  test.each([
    'recommended',
    'strict',
    'recommendedTypeScript',
    'strictTypeScript',
  ])('composes with %s without replacing its rules', (name) => {
    const base = plugin.configs[name];
    const eventRules = plugin.eventRules(LINT_ARTIFACT);
    const composed = {
      ...base,
      rules: { ...base.rules, ...eventRules },
    };

    expect(composed.rules).toMatchObject(base.rules);
    expect(composed.rules).toMatchObject(eventRules);
    if (name.endsWith('TypeScript')) {
      expect(
        Object.getOwnPropertyDescriptor(composed.languageOptions, 'parser').get
      ).toBeDefined();
    }
  });

  test('rejects every invalid option shape with one non-sensitive error', () => {
    let accessorReads = 0;
    const accessor = {};
    Object.defineProperty(accessor, 'privacyModules', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return ['JANE_DOE_DIAGNOSIS'];
      },
    });
    const invalid = [
      null,
      7,
      [],
      { privacyModulez: ['@/privacy'] },
      { [Symbol('privacy')]: ['@/privacy'] },
      accessor,
      { privacyModules: [] },
      { privacyModules: [7] },
      { privacyModules: [''] },
      { privacyModules: ['@/privacy', '@/privacy'] },
      Object.assign(Object.create({ inherited: true }), {
        privacyModules: ['@/privacy'],
      }),
      Object.assign(Object.create(null), {
        privacyModules: Object.assign(['@/privacy'], { extra: true }),
      }),
      { privacyModules: Array(1) },
      {
        privacyModules: Object.setPrototypeOf(['@/privacy'], null),
      },
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('JANE_DOE_DIAGNOSIS');
          },
        }
      ),
      new Proxy(
        { privacyModules: ['@/privacy'] },
        {
          getOwnPropertyDescriptor() {
            throw new Error('JANE_DOE_DIAGNOSIS');
          },
        }
      ),
      {
        privacyModules: new Proxy(['@/privacy'], {
          get() {
            throw new Error('JANE_DOE_DIAGNOSIS');
          },
        }),
      },
    ];

    for (const options of invalid) {
      let error;
      try {
        plugin.eventRules(LINT_ARTIFACT, options);
      } catch (caught) {
        error = caught;
      }
      expect(error).toEqual(new TypeError('INVALID_EVENT_LINT_OPTIONS'));
      expect(String(error)).not.toContain('JANE_DOE_DIAGNOSIS');
    }
    expect(accessorReads).toBe(0);
  });

  test('rejects proxy-backed option data without invoking proxy traps', () => {
    let reads = 0;
    const options = new Proxy(
      {},
      {
        ownKeys: () => ['privacyModules'],
        getOwnPropertyDescriptor: () => ({
          configurable: true,
          enumerable: true,
          value: ['@/privacy'],
          writable: true,
        }),
        get() {
          reads += 1;
          throw new Error('JANE_DOE_DIAGNOSIS');
        },
      }
    );

    expect(() => plugin.eventRules(LINT_ARTIFACT, options)).toThrow(
      new TypeError('INVALID_EVENT_LINT_OPTIONS')
    );
    expect(reads).toBe(0);
  });

  test.each(['typed-event-schema', 'require-event-privacy'])(
    'validates and compiles %s options when the rule is created',
    (name) => {
      const invalidOptions = {
        options: [
          {
            lintArtifact: { formatVersion: 999 },
            privacyModules: ['@/privacy'],
          },
        ],
        report() {},
      };
      expect(() => plugin.rules[name].create(invalidOptions)).toThrow(
        new TypeError('INVALID_EVENT_LINT_ARTIFACT')
      );

      const invalidList = {
        options: [
          {
            lintArtifact: LINT_ARTIFACT,
            privacyModules: [''],
          },
        ],
        report() {},
      };
      expect(() => plugin.rules[name].create(invalidList)).toThrow(
        new TypeError('INVALID_EVENT_LINT_OPTIONS')
      );
    }
  );

  test.each(['typed-event-schema', 'require-event-privacy'])(
    'snapshots direct %s options before caller mutation',
    (name) => {
      const {
        analyticsModules,
        analyticsNames,
        eventRuleOptions,
        privacyModules,
      } = require('../eslint-plugin/event-options');
      const {
        prepareEventAnalysis,
      } = require('../eslint-plugin/event-analysis');
      const names = ['telemetry'];
      const modules = ['@/analytics'];
      const wrappers = ['@/privacy'];
      const context = {
        options: [
          {
            lintArtifact: LINT_ARTIFACT,
            analyticsNames: names,
            analyticsModules: modules,
            privacyModules: wrappers,
          },
        ],
        report() {},
      };

      plugin.rules[name].create(context);
      const prepared = prepareEventAnalysis(context);
      names[0] = 'other';
      modules[0] = './untrusted';
      wrappers[0] = './untrusted';
      context.options[0] = { lintArtifact: { formatVersion: 999 } };

      expect(eventRuleOptions(context)).toMatchObject({
        analyticsNames: ['telemetry'],
        analyticsModules: ['@/analytics'],
        privacyModules: ['@/privacy'],
      });
      expect([...analyticsNames(context)]).toEqual(['telemetry']);
      expect([...analyticsModules(context)]).toEqual(['@/analytics']);
      expect([...privacyModules(context)]).toEqual(['@/privacy']);
      expect(prepareEventAnalysis(context)).toBe(prepared);
    }
  );

  test.each(['typed-event-schema', 'require-event-privacy'])(
    'rejects exotic direct %s options without invoking accessors or traps',
    (name) => {
      let reads = 0;
      const accessor = { lintArtifact: LINT_ARTIFACT };
      Object.defineProperty(accessor, 'privacyModules', {
        enumerable: true,
        get() {
          reads += 1;
          return ['JANE_DOE_DIAGNOSIS'];
        },
      });
      const trapped = new Proxy(
        { lintArtifact: LINT_ARTIFACT },
        {
          ownKeys() {
            reads += 1;
            throw new Error('JANE_DOE_DIAGNOSIS');
          },
        }
      );
      const sparse = Array(1);
      const cases = [
        [accessor],
        [trapped],
        [{ lintArtifact: LINT_ARTIFACT, privacyModules: sparse }],
        new Proxy([{ lintArtifact: LINT_ARTIFACT }], {
          get() {
            reads += 1;
            throw new Error('JANE_DOE_DIAGNOSIS');
          },
        }),
      ];

      for (const options of cases) {
        let error;
        try {
          plugin.rules[name].create({ options, report() {} });
        } catch (caught) {
          error = caught;
        }
        expect(error).toEqual(new TypeError('INVALID_EVENT_LINT_OPTIONS'));
        expect(String(error)).not.toContain('JANE_DOE_DIAGNOSIS');
      }
      expect(reads).toBe(0);
    }
  );

  test('snapshots option arrays before caller aliases mutate', () => {
    const analyticsNames = ['telemetry'];
    const analyticsModules = ['@/analytics'];
    const privacyModules = ['@/privacy'];
    const options = { analyticsNames, analyticsModules, privacyModules };
    const rules = plugin.eventRules(LINT_ARTIFACT, options);
    const cases = [
      "telemetry.track('appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' });",
      "import { createAnalytics } from '@/analytics'; const sink = createAnalytics(config); sink.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });",
      "import { priv } from '@/privacy'; analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: priv(patient.days), via: 'search' });",
    ];
    const before = cases.map((code) => verify(code, rules));
    expect(before.map((messages) => messages.length)).toEqual([2, 1, 0]);

    analyticsNames[0] = 'other';
    analyticsModules[0] = './untrusted';
    privacyModules[0] = './untrusted';
    options.analyticsNames = ['other'];
    options.analyticsModules = ['./untrusted'];
    options.privacyModules = ['./untrusted'];

    expect(cases.map((code) => verify(code, rules))).toEqual(before);
  });

  test('rejects an unsupported artifact without echoing its content', () => {
    const forged = {
      formatVersion: 999,
      grammar: { patient: 'JANE_DOE_DIAGNOSIS' },
    };

    expect(() => plugin.eventRules(forged)).toThrow(
      'INVALID_EVENT_LINT_ARTIFACT'
    );
    expect(() => plugin.eventRules(forged)).not.toThrow('JANE_DOE_DIAGNOSIS');
  });

  test('rejects malformed artifacts across every structural boundary', () => {
    const cases = [
      () => null,
      () => true,
      () => 'artifact',
      () => [],
      () => {
        const artifact = mutableLintArtifact();
        artifact.formatVersion = 2;
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.artifact = 'other-grammar';
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.formatVersion = 2;
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.additionalEvents = true;
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[0].additionalProperties = true;
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[0].properties[0].required = 'yes';
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[0].name = '';
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[0].properties[0].name = '';
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[0].properties[0].constraint.values = [];
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[1].properties[0].constraint.values = [];
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[0].properties[1].constraint.minimum = 0.5;
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[0].properties[1].constraint.maximum =
          Number.MAX_SAFE_INTEGER + 1;
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.extra = true;
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact[Symbol('extra')] = true;
        return artifact;
      },
      () =>
        Object.assign(
          Object.create({ inherited: true }),
          mutableLintArtifact()
        ),
      () => lintArtifactWith([]),
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events.length += 1;
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events.extra = true;
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        Object.setPrototypeOf(artifact.grammar.events, {});
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events.push(artifact.grammar.events[0]);
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        const properties = artifact.grammar.events[0].properties;
        properties.push(properties[0]);
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[0].properties[0].constraint.values.push('gp');
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[0].properties[0].constraint = {
          type: 'string',
        };
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[1].properties[0].constraint.registry =
          'not valid';
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[0].properties[1].constraint.minimum = 366;
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[0].properties[0].constraint.values[0] =
          '\ud800';
        return artifact;
      },
      () => {
        const artifact = mutableLintArtifact();
        artifact.grammar.events[0].properties[0].constraint.values[0] =
          'x'.repeat(257);
        return artifact;
      },
    ];

    for (const build of cases) {
      expect(() => plugin.eventRules(build())).toThrow(
        'INVALID_EVENT_LINT_ARTIFACT'
      );
    }
  });

  test('rejects artifact accessors and proxy traps without revealing content', () => {
    let accessorReads = 0;
    const accessor = mutableLintArtifact();
    Object.defineProperty(accessor.grammar, 'events', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return 'JANE_DOE_DIAGNOSIS';
      },
    });
    const trapped = new Proxy(mutableLintArtifact(), {
      ownKeys() {
        throw new Error('JANE_DOE_DIAGNOSIS');
      },
    });

    for (const artifact of [accessor, trapped]) {
      let error;
      try {
        plugin.eventRules(artifact);
      } catch (caught) {
        error = caught;
      }
      expect(error).toEqual(new TypeError('INVALID_EVENT_LINT_ARTIFACT'));
      expect(String(error)).not.toContain('JANE_DOE_DIAGNOSIS');
    }
    expect(accessorReads).toBe(0);
  });

  test('accepts exact collection limits and rejects each limit plus one', () => {
    const { LIMITS } = require('../eslint-plugin/event-artifact');
    expect(LIMITS).toEqual({
      maxEvents: 256,
      maxProperties: 2048,
      maxMemberReferences: 16_384,
      maxJSONBytes: 1024 * 1024,
      maxMemberBytes: 256,
    });
    const event = (index, properties = []) => ({
      name: `event-${index}`,
      additionalProperties: false,
      properties,
    });
    const property = (
      index,
      constraint = { type: 'integer', minimum: 0, maximum: 1 }
    ) => ({
      name: `property-${index}`,
      required: true,
      constraint,
    });

    const exactEvents = Array.from({ length: LIMITS.maxEvents }, (_, index) =>
      event(index)
    );
    expect(() =>
      plugin.eventRules(lintArtifactWith(exactEvents))
    ).not.toThrow();
    expect(() =>
      plugin.eventRules(
        lintArtifactWith([...exactEvents, event(LIMITS.maxEvents)])
      )
    ).toThrow('INVALID_EVENT_LINT_ARTIFACT');

    const exactProperties = Array.from(
      { length: LIMITS.maxProperties },
      (_, index) => property(index)
    );
    expect(() =>
      plugin.eventRules(lintArtifactWith([event(0, exactProperties)]))
    ).not.toThrow();
    expect(() =>
      plugin.eventRules(
        lintArtifactWith([
          event(0, [...exactProperties, property(LIMITS.maxProperties)]),
        ])
      )
    ).toThrow('INVALID_EVENT_LINT_ARTIFACT');

    const exactMembers = Array.from(
      { length: LIMITS.maxMemberReferences },
      (_, index) => `value-${index}`
    );
    expect(() =>
      plugin.eventRules(
        lintArtifactWith([
          event(0, [property(0, { type: 'enum', values: exactMembers })]),
        ])
      )
    ).not.toThrow();
    expect(() =>
      plugin.eventRules(
        lintArtifactWith([
          event(0, [
            property(0, {
              type: 'enum',
              values: [...exactMembers, 'one-too-many'],
            }),
          ]),
        ])
      )
    ).toThrow('INVALID_EVENT_LINT_ARTIFACT');

    const splitProperties = [
      event(0, exactProperties.slice(0, LIMITS.maxProperties / 2)),
      event(1, exactProperties.slice(LIMITS.maxProperties / 2)),
    ];
    expect(() =>
      plugin.eventRules(lintArtifactWith(splitProperties))
    ).not.toThrow();
    splitProperties[1].properties.push(property(LIMITS.maxProperties));
    expect(() => plugin.eventRules(lintArtifactWith(splitProperties))).toThrow(
      'INVALID_EVENT_LINT_ARTIFACT'
    );

    const splitMembers = [
      event(0, [
        property(0, {
          type: 'enum',
          values: exactMembers.slice(0, LIMITS.maxMemberReferences / 2),
        }),
      ]),
      event(1, [
        property(0, {
          type: 'enum',
          values: exactMembers.slice(LIMITS.maxMemberReferences / 2),
        }),
      ]),
    ];
    expect(() =>
      plugin.eventRules(lintArtifactWith(splitMembers))
    ).not.toThrow();
    splitMembers[1].properties[0].constraint.values.push('one-too-many');
    expect(() => plugin.eventRules(lintArtifactWith(splitMembers))).toThrow(
      'INVALID_EVENT_LINT_ARTIFACT'
    );

    const exactByteMember = 'é'.repeat(128);
    const oversizedMember = `${'é'.repeat(127)}abc`;
    expect(utf8Bytes(exactByteMember)).toBe(LIMITS.maxMemberBytes);
    expect(utf8Bytes(oversizedMember)).toBe(LIMITS.maxMemberBytes + 1);
    expect(() =>
      plugin.eventRules(
        lintArtifactWith([
          event(0, [property(0, { type: 'enum', values: [exactByteMember] })]),
        ])
      )
    ).not.toThrow();
    expect(() =>
      plugin.eventRules(
        lintArtifactWith([
          event(0, [property(0, { type: 'enum', values: [oversizedMember] })]),
        ])
      )
    ).toThrow('INVALID_EVENT_LINT_ARTIFACT');

    const emptyValues = lintArtifactWith([
      event(0, [property(0, { type: 'enum', values: [] })]),
    ]);
    const emptyBytes = utf8Bytes(JSON.stringify(emptyValues.grammar));
    const memberContribution = LIMITS.maxMemberBytes + 3;
    const fullMembers =
      Math.ceil((LIMITS.maxJSONBytes - emptyBytes + 1) / memberContribution) +
      1;
    const lengths = Array(fullMembers).fill(LIMITS.maxMemberBytes);
    let reduction =
      fullMembers * memberContribution - 1 - (LIMITS.maxJSONBytes - emptyBytes);
    const prefix = (index) => `${index}:`;
    for (let index = lengths.length - 1; reduction > 0; index -= 1) {
      const reducible = lengths[index] - prefix(index).length;
      const amount = Math.min(reducible, reduction);
      lengths[index] -= amount;
      reduction -= amount;
    }
    expect(reduction).toBe(0);
    const sizedMembers = lengths.map((length, index) => {
      const start = prefix(index);
      return start + 'x'.repeat(length - start.length);
    });
    const exactJSONArtifact = lintArtifactWith([
      event(0, [property(0, { type: 'enum', values: sizedMembers })]),
    ]);
    expect(utf8Bytes(JSON.stringify(exactJSONArtifact.grammar))).toBe(
      LIMITS.maxJSONBytes
    );
    expect(() => plugin.eventRules(exactJSONArtifact)).not.toThrow();

    const oversizedJSONArtifact = JSON.parse(JSON.stringify(exactJSONArtifact));
    const adjustable =
      oversizedJSONArtifact.grammar.events[0].properties[0].constraint.values.findIndex(
        (value) => utf8Bytes(value) < LIMITS.maxMemberBytes
      );
    oversizedJSONArtifact.grammar.events[0].properties[0].constraint.values[
      adjustable
    ] += 'x';
    expect(utf8Bytes(JSON.stringify(oversizedJSONArtifact.grammar))).toBe(
      LIMITS.maxJSONBytes + 1
    );
    expect(() => plugin.eventRules(oversizedJSONArtifact)).toThrow(
      'INVALID_EVENT_LINT_ARTIFACT'
    );
  });

  test('snapshots a valid forged artifact before consumer aliases mutate', () => {
    const values = ['safe'];
    const constraint = { type: 'enum', values };
    const property = { name: 'value', required: true, constraint };
    const event = {
      name: 'event',
      additionalProperties: false,
      properties: [property],
    };
    const artifact = {
      formatVersion: 1,
      grammar: {
        artifact: 'react-native-nitro-logger/analytics-grammar',
        formatVersion: 1,
        additionalEvents: false,
        events: [event],
      },
    };
    const rules = plugin.eventRules(artifact);
    const code = "analytics.track('event', { value: 'safe' });";
    const before = verify(code, rules);

    values[0] = 'PHI-mutated';
    constraint.type = 'integer';
    constraint.minimum = -Infinity;
    constraint.maximum = Infinity;
    property.name = 'patient';
    event.name = 'patient-event';
    artifact.grammar.events.push({
      name: 'extra',
      additionalProperties: false,
      properties: [],
    });

    expect(before).toEqual([]);
    expect(verify(code, rules)).toEqual(before);
  });

  test('uses own keys for prototype-like schema names', () => {
    const artifact = {
      formatVersion: 1,
      grammar: {
        artifact: 'react-native-nitro-logger/analytics-grammar',
        formatVersion: 1,
        additionalEvents: false,
        events: [
          {
            name: 'constructor',
            additionalProperties: false,
            properties: [
              {
                name: 'toString',
                required: true,
                constraint: { type: 'enum', values: ['safe'] },
              },
            ],
          },
        ],
      },
    };

    expect(
      verify(
        "analytics.track('constructor', { toString: 'safe' });",
        plugin.eventRules(artifact)
      )
    ).toEqual([]);
  });
});

describe('event-callable security normalization', () => {
  const invalid =
    "'appointment_booked', { clinic_type: 'gp', lead_time_days: 999, via: 'search' }";
  const dynamic = 'patient.event, { [patient.id]: patient.name }';
  const factoryImport =
    "import { createAnalytics } from 'react-native-nitro-logger/analytics'; ";
  const diagnostics = (code) =>
    verify(code, plugin.eventRules(LINT_ARTIFACT)).map(
      (message) => message.messageId
    );
  const configuredEventRules = plugin.eventRules(LINT_ARTIFACT);
  const typedOnly = {
    'nitro-logger/typed-event-schema':
      configuredEventRules['nitro-logger/typed-event-schema'],
  };
  const privacyOnly = {
    'nitro-logger/require-event-privacy':
      configuredEventRules['nitro-logger/require-event-privacy'],
  };
  const diagnosticsFor = (code, rules) =>
    verify(code, rules).map((message) => message.messageId);

  test.each([
    [
      'nested object and array containers',
      'const box = { nested: [{ emit: analytics.track }] }; box.nested[0].emit',
    ],
    [
      'a static computed container key',
      "const key = 'emit'; const box = { [key]: analytics.track }; box[key]",
    ],
    [
      'an aliased cyclic container',
      'const box = { emit: analytics.track }; const alias = box; box.self = alias; box.self.self.emit',
    ],
  ])('resolves an event method through %s', (_name, setupAndMethod) => {
    const separator = setupAndMethod.lastIndexOf(';');
    const setup = setupAndMethod.slice(0, separator + 1);
    const method = setupAndMethod.slice(separator + 1).trim();
    expect(diagnostics(`${setup} ${method}(${invalid});`)).toEqual([
      'invalidValue',
      'unbound',
    ]);
  });

  test.each([
    [
      'nested object and array containers',
      'const box = { nested: [{ emit: widget.track }] }; box.nested[0].emit',
    ],
    [
      'a static computed container key',
      "const key = 'emit'; const box = { [key]: widget.track }; box[key]",
    ],
    [
      'an aliased cyclic container',
      'const box = { emit: widget.track }; const alias = box; box.self = alias; box.self.self.emit',
    ],
  ])('keeps an ordinary method through %s exempt', (_name, setupAndMethod) => {
    const separator = setupAndMethod.lastIndexOf(';');
    const setup = setupAndMethod.slice(0, separator + 1);
    const method = setupAndMethod.slice(separator + 1).trim();
    expect(diagnostics(`${setup} ${method}(${dynamic});`)).toEqual([]);
  });

  test.each([
    [
      'an aliased Reflect.apply',
      `const invoke = Reflect.apply; invoke(analytics.track, analytics, [${invalid}]);`,
      ['unanalyzable', 'unanalyzable'],
    ],
    [
      'a destructured Reflect.apply',
      `const { apply: invoke } = Reflect; invoke(analytics.track, analytics, [${invalid}]);`,
      ['unanalyzable', 'unanalyzable'],
    ],
    [
      'a container-held Reflect.apply',
      `const ops = { invoke: Reflect.apply }; ops.invoke(analytics.track, analytics, [${invalid}]);`,
      ['unanalyzable', 'unanalyzable'],
    ],
    [
      'a destructured Function.prototype.call',
      `const { call: invoke } = Function.prototype; invoke.call(analytics.track, analytics, ${invalid});`,
      ['invalidValue', 'unbound'],
    ],
    [
      'a destructured Function.prototype.apply',
      `const { apply: invoke } = Function.prototype; invoke.call(analytics.track, analytics, [${invalid}]);`,
      ['unanalyzable', 'unanalyzable'],
    ],
    [
      'a destructured Function.prototype.bind',
      `const { bind } = Function.prototype; const emit = bind.call(analytics.track, analytics); emit(${invalid});`,
      ['invalidValue', 'unbound'],
    ],
  ])('normalizes event forwarding through %s', (_name, code, expected) => {
    expect(diagnostics(code)).toEqual(expected);
  });

  test.each([
    `const { apply: invoke } = Reflect; invoke(widget.track, widget, [${dynamic}]);`,
    `const { call: invoke } = Function.prototype; invoke.call(widget.track, widget, ${dynamic});`,
    `const { bind } = Function.prototype; const emit = bind.call(widget.track, widget); emit(${dynamic});`,
  ])('keeps an ordinary forwarded callable exempt', (code) => {
    expect(diagnostics(code)).toEqual([]);
  });

  test.each([
    [
      'an aliased Reflect.apply',
      'const invoke = Reflect.apply;',
      'invoke(createAnalytics, null, [config])',
    ],
    [
      'a destructured Reflect.apply',
      'const { apply: invoke } = Reflect;',
      'invoke(createAnalytics, null, [config])',
    ],
    [
      'a container-held Reflect.apply',
      'const ops = { invoke: Reflect.apply };',
      'ops.invoke(createAnalytics, null, [config])',
    ],
    [
      'a destructured Function.prototype.call',
      'const { call: invoke } = Function.prototype;',
      'invoke.call(createAnalytics, null, config)',
    ],
    [
      'a destructured Function.prototype.bind',
      'const { bind } = Function.prototype; const make = bind.call(createAnalytics, null);',
      'make(config)',
    ],
    [
      'nested containers',
      'const box = { nested: [createAnalytics] };',
      'box.nested[0](config)',
    ],
  ])('preserves factory provenance through %s', (_name, setup, factory) => {
    const code =
      factoryImport +
      `${setup} const sink = ${factory}; sink.track(${invalid});`;
    expect(diagnostics(code)).toEqual(['invalidValue', 'unbound']);
  });

  test.each([
    'Object.assign(analytics.track, {})',
    "Object.defineProperty(analytics.track, 'tag', { value: true })",
  ])('unwraps an exact return-target event method wrapper', (method) => {
    expect(diagnostics(`const emit = ${method}; emit(${invalid});`)).toEqual([
      'invalidValue',
      'unbound',
    ]);
  });

  test('fails closed for a poisoned return-target method wrapper', () => {
    const code =
      'Object.assign = ordinary; const emit = Object.assign(widget.track, {}); ' +
      `emit(${invalid});`;
    expect(diagnostics(code)).toEqual(['unanalyzable', 'unanalyzable']);
  });

  test('keeps an ordinary exact return-target wrapper exempt', () => {
    expect(
      diagnostics(
        `const emit = Object.assign(widget.track, {}); emit(${dynamic});`
      )
    ).toEqual([]);
  });

  test('unwraps an exact return-target factory wrapper', () => {
    const code =
      factoryImport +
      `const make = Object.assign(createAnalytics, {}); const sink = make(config); sink.track(${invalid});`;
    expect(diagnostics(code)).toEqual(['invalidValue', 'unbound']);
  });

  test.each([
    [
      'a transparent Proxy',
      'new Proxy(analytics.track, {})',
      ['invalidValue', 'unbound'],
    ],
    [
      'Reflect.construct',
      'Reflect.construct(Proxy, [analytics.track, {}])',
      ['invalidValue', 'unbound'],
    ],
    [
      'an inline revocable Proxy',
      'Proxy.revocable(analytics.track, {}).proxy',
      ['invalidValue', 'unbound'],
    ],
    [
      'an apply trap',
      'new Proxy(widget.track, { apply() { return null; } })',
      ['unanalyzable', 'unanalyzable'],
    ],
  ])('normalizes an event callable through %s', (_name, method, expected) => {
    expect(diagnostics(`const emit = ${method}; emit(${invalid});`)).toEqual(
      expected
    );
  });

  test('fails closed for a revocable Proxy callable alias', () => {
    const code =
      'const pair = Proxy.revocable(analytics.track, {}); const emit = pair.proxy; ' +
      `emit(${invalid});`;
    expect(diagnostics(code)).toEqual(['unanalyzable', 'unanalyzable']);
  });

  test('keeps an ordinary transparent callable Proxy exempt', () => {
    expect(
      diagnostics(`const emit = new Proxy(widget.track, {}); emit(${dynamic});`)
    ).toEqual([]);
  });

  test('preserves factory provenance through a callable Proxy', () => {
    const code =
      factoryImport +
      `const make = new Proxy(createAnalytics, {}); const sink = make(config); sink.track(${invalid});`;
    expect(diagnostics(code)).toEqual(['invalidValue', 'unbound']);
  });

  test.each([
    ['conditional forward', 'flag ? analytics.track : ordinary'],
    ['conditional reverse', 'flag ? ordinary : analytics.track'],
    ['logical forward', 'analytics.track || ordinary'],
    ['logical reverse', 'ordinary || analytics.track'],
  ])('joins %s method candidates independently of order', (_name, value) => {
    expect(diagnostics(`const emit = ${value}; emit(${invalid});`)).toEqual([
      'invalidValue',
      'unbound',
    ]);
  });

  test.each([
    ['trusted then ordinary', 'analytics.track', 'ordinary'],
    ['ordinary then trusted', 'ordinary', 'analytics.track'],
  ])('joins container writes %s', (_name, initial, replacement) => {
    const code =
      `const methods = { emit: ${initial} }; methods.emit = ${replacement}; ` +
      `methods.emit(${invalid});`;
    expect(diagnostics(code)).toEqual(['invalidValue', 'unbound']);
  });

  test.each([
    [
      'bound then unbound',
      "flag ? analytics.track.bind(analytics, 'appointment_booked') : analytics.track",
    ],
    [
      'unbound then bound',
      "flag ? analytics.track : analytics.track.bind(analytics, 'appointment_booked')",
    ],
  ])('widens unequal %s method candidates', (_name, value) => {
    expect(
      diagnostics(
        `const emit = ${value}; emit({ clinic_type: 'gp', lead_time_days: 999, via: 'search' });`
      )
    ).toEqual(['unanalyzable', 'unanalyzable']);
  });

  test('publishes every member of a mixed Object and Reflect namespace SCC', () => {
    const setup =
      'let left = Object; let right = Reflect; ' +
      'if (flag) { left = right; } else { right = left; }';
    const calls = {
      reflect:
        `const reflected = left.construct(Proxy, [analytics, {}]); ` +
        `reflected.track(${invalid});`,
      object:
        `const P = right.assign(Proxy, {}); ` +
        `const assigned = new P(analytics, {}); assigned.track(${invalid});`,
    };
    for (const order of [
      ['reflect', 'object'],
      ['object', 'reflect'],
    ]) {
      expect(
        diagnostics(`${setup} ${order.map((name) => calls[name]).join(' ')}`)
      ).toEqual(['invalidValue', 'unbound', 'invalidValue', 'unbound']);
    }

    const methodSetup =
      'let left = Object.assign; let right = Reflect.construct; ' +
      'if (flag) { left = right; } else { right = left; }';
    const methodCalls = {
      reflect:
        `const reflected = left(Proxy, [analytics, {}]); ` +
        `reflected.track(${invalid});`,
      object:
        `const P = right(Proxy, {}); const assigned = new P(analytics, {}); ` +
        `assigned.track(${invalid});`,
    };
    for (const order of [
      ['reflect', 'object'],
      ['object', 'reflect'],
    ]) {
      expect(
        diagnostics(
          `${methodSetup} ${order.map((name) => methodCalls[name]).join(' ')}`
        )
      ).toEqual(['invalidValue', 'unbound', 'invalidValue', 'unbound']);
    }
  });

  test('keeps mixed namespace SCC publication linear and releases ephemeral state', () => {
    const size = 64;
    const lines = ['let value0 = Object;'];
    for (let index = 1; index < size; index += 1) {
      lines.push(`let value${index} = value${index - 1};`);
    }
    lines.push(
      `if (flag) { value0 = value${size - 1}; } else { value${
        size - 1
      } = Reflect; }`
    );
    lines.push(
      `const reflected = value0.construct(Proxy, [analytics, {}]); reflected.track(${invalid});`
    );
    lines.push(
      `const P = value${
        size - 1
      }.assign(Proxy, {}); const assigned = new P(analytics, {}); assigned.track(${invalid});`
    );

    const { messages, stats } = verifyWithAnalysisStats(lines.join('\n'));
    expect(messages.map((message) => message.messageId)).toEqual([
      'invalidValue',
      'unbound',
      'invalidValue',
      'unbound',
    ]);
    const total = (name) =>
      stats.reduce((sum, counters) => sum + counters[name], 0);
    expect(total('bindingSetSccVariables')).toBeGreaterThanOrEqual(size);
    expect(total('bindingSetSccVariables')).toBeLessThanOrEqual(20 * size);
    expect(total('bindingSetSccSolveVisits')).toBeGreaterThan(0);
    expect(total('bindingSetSccSolveVisits')).toBeLessThanOrEqual(45 * size);
    expect(total('bindingSetSccEdgeVisits')).toBeGreaterThan(0);
    expect(total('bindingSetSccEdgeVisits')).toBeLessThanOrEqual(8 * size);
    expect(total('bindingSetEphemeralPeak')).toBeGreaterThan(0);
    expect(total('bindingSetEphemeralPeak')).toBeLessThanOrEqual(size + 2);
    expect(total('bindingSetEphemeralRemaining')).toBe(0);
  });

  test('keeps overlapping SCC work near-linear from 600 to 1,200 bindings', () => {
    const measure = (size) => {
      const lines = ['let value0 = Object;'];
      for (let index = 1; index < size; index += 1) {
        lines.push(`let value${index} = value${index - 1};`);
      }
      lines.push(
        `if (flag) { value0 = value${size - 1}; } else { value${
          size - 1
        } = Reflect; }`,
        `const reflected = value0.construct(Proxy, [analytics, {}]); reflected.track(${invalid});`,
        `const P = value${
          size - 1
        }.assign(Proxy, {}); const assigned = new P(analytics, {}); assigned.track(${invalid});`
      );
      const { messages, stats } = verifyWithAnalysisStats(lines.join('\n'));
      expect(messages.map((message) => message.messageId)).toEqual([
        'invalidValue',
        'unbound',
        'invalidValue',
        'unbound',
      ]);
      const total = (name) =>
        stats.reduce((sum, counters) => sum + counters[name], 0);
      return {
        edges: total('bindingSetSccEdgeVisits'),
        solves: total('bindingSetSccSolveVisits'),
        variables: total('bindingSetSccVariables'),
      };
    };

    const small = measure(600);
    const large = measure(1200);
    for (const name of ['edges', 'solves', 'variables']) {
      expect(small[name]).toBeGreaterThan(0);
      expect(large[name]).toBeGreaterThanOrEqual(small[name]);
      expect(large[name]).toBeLessThanOrEqual(small[name] * 2.25 + 32);
    }
  });

  test('joins whole-binding object and array container replacements', () => {
    const positive = [
      'let box = { ns: Object }; if (flag) box = { ns: Reflect }; ' +
        `const sink = box.ns.construct(Proxy, [analytics, {}]); sink.track(${invalid});`,
      'let box = { ns: Reflect }; if (flag) box = { ns: Reflect }; ' +
        `const sink = box.ns.construct(Proxy, [analytics, {}]); sink.track(${invalid});`,
      'let box = [Reflect]; if (flag) box = [Object]; ' +
        'const P = box[0].assign(Proxy, {}); ' +
        `const sink = new P(analytics, {}); sink.track(${invalid});`,
      'let box = [Object]; if (flag) box = [Object]; ' +
        'const P = box[0].assign(Proxy, {}); ' +
        `const sink = new P(analytics, {}); sink.track(${invalid});`,
    ];
    for (const code of positive) {
      expect(diagnostics(code)).toEqual(['invalidValue', 'unbound']);
    }

    const ordinary = [
      'let box = { ns: Object }; if (flag) box = { ns: Object }; ' +
        'const P = box.ns.assign(Widget, {}); const sink = new P(); ' +
        `sink.track(${dynamic});`,
      'let box = [Reflect]; if (flag) box = [Reflect]; ' +
        'const sink = box[0].construct(Widget, []); ' +
        `sink.track(${dynamic});`,
    ];
    for (const code of ordinary) expect(diagnostics(code)).toEqual([]);
  });

  test('resolves object-literal getters that return analytics methods and receivers', () => {
    const analyticsCases = [
      `const box = { get emit() { return analytics.track; } }; box.emit(${invalid});`,
      `const box = { get emit() { return flag ? analytics.track : widget.track; } }; box.emit(${invalid});`,
      `const box = { get tracker() { return analytics; } }; box.tracker.track(${invalid});`,
      `const box = { get tracker() { return flag ? analytics : new Widget(); } }; box.tracker.track(${invalid});`,
    ];
    for (const code of analyticsCases) {
      expect(diagnostics(code)).toEqual(['invalidValue', 'unbound']);
    }

    expect(
      diagnostics(
        `const box = { get emit() { return widget.track; } }; box.emit(${dynamic});`
      )
    ).toEqual([]);
    expect(
      diagnostics(
        `const box = { get tracker() { return new Widget(); } }; box.tracker.track(${dynamic});`
      )
    ).toEqual([]);
  });

  test('resolves descriptor getters that return analytics methods and receivers', () => {
    const analyticsCases = [
      `const box = {}; Object.defineProperty(box, 'emit', { get() { return analytics.track; } }); box.emit(${invalid});`,
      `const box = {}; Object.defineProperty(box, 'emit', { get() { return flag ? analytics.track : widget.track; } }); box.emit(${invalid});`,
      `const box = {}; Object.defineProperty(box, 'tracker', { get() { return analytics; } }); box.tracker.track(${invalid});`,
      `const box = {}; Object.defineProperty(box, 'tracker', { get() { return flag ? analytics : new Widget(); } }); box.tracker.track(${invalid});`,
    ];
    for (const code of analyticsCases) {
      expect(diagnostics(code)).toEqual(['invalidValue', 'unbound']);
    }

    expect(
      diagnostics(
        `const box = {}; Object.defineProperty(box, 'emit', { get() { return widget.track; } }); box.emit(${dynamic});`
      )
    ).toEqual([]);
    expect(
      diagnostics(
        `const box = {}; Object.defineProperty(box, 'tracker', { get() { return new Widget(); } }); box.tracker.track(${dynamic});`
      )
    ).toEqual([]);
  });

  test('resolves analytics properties on returned containers', () => {
    const methodContainers = [
      (method) => `Object.assign({}, { emit: ${method} })`,
      (method) => `Object.defineProperty({}, 'emit', { value: ${method} })`,
      (method) => `Object.defineProperties({}, { emit: { value: ${method} } })`,
      (method) => `Object.setPrototypeOf({}, { emit: ${method} })`,
    ];
    const receiverContainers = [
      (receiver) => `Object.assign({}, { tracker: ${receiver} })`,
      (receiver) =>
        `Object.defineProperty({}, 'tracker', { value: ${receiver} })`,
      (receiver) =>
        `Object.defineProperties({}, { tracker: { value: ${receiver} } })`,
      (receiver) => `Object.setPrototypeOf({}, { tracker: ${receiver} })`,
    ];
    for (const build of methodContainers) {
      expect(
        diagnostics(
          `const box = ${build('analytics.track')}; box.emit(${invalid});`
        )
      ).toEqual(['invalidValue', 'unbound']);
      expect(
        diagnostics(
          `const box = ${build('widget.track')}; box.emit(${dynamic});`
        )
      ).toEqual([]);
    }
    for (const build of receiverContainers) {
      expect(
        diagnostics(
          `const box = ${build('analytics')}; box.tracker.track(${invalid});`
        )
      ).toEqual(['invalidValue', 'unbound']);
      expect(
        diagnostics(
          `const box = ${build('new Widget()')}; box.tracker.track(${dynamic});`
        )
      ).toEqual([]);
    }
  });

  const nestedMemberGetterSurfaces = [
    [
      'object-literal getters',
      (value) =>
        `const box = { get emit() { return ${value}; } }; box.emit(${invalid});`,
    ],
    [
      'Object.defineProperty getters',
      (value) =>
        `const box = {}; Object.defineProperty(box, 'emit', { get() { return ${value}; } }); box.emit(${invalid});`,
    ],
    [
      'Object.defineProperties getters',
      (value) =>
        `const box = {}; Object.defineProperties(box, { emit: { get() { return ${value}; } } }); box.emit(${invalid});`,
    ],
    [
      'public class getters',
      (value) =>
        `class C { get emit() { return ${value}; } send() { this.emit(${invalid}); } }`,
    ],
    [
      'private class getters',
      (value) =>
        `class C { get #emit() { return ${value}; } send() { this.#emit(${invalid}); } }`,
    ],
    [
      'public static class getters',
      (value) =>
        `class C { static get emit() { return ${value}; } static send() { this.emit(${invalid}); } }`,
    ],
    [
      'private static class getters',
      (value) =>
        `class C { static get #emit() { return ${value}; } static send() { this.#emit(${invalid}); } }`,
    ],
  ];

  test.each(nestedMemberGetterSurfaces)(
    'fails closed for nested member uncertainty in %s',
    (_name, build) => {
      expect(diagnostics(build('load().emit'))).toEqual([
        'unanalyzable',
        'unanalyzable',
      ]);
      expect(
        diagnostics(
          `const registry = { emit: widget.track }; ${build('registry.emit')}`
        )
      ).toEqual([]);
    }
  );

  const replacementContainerBuilders = [
    [
      'Object.assign',
      (name, value) => `Object.assign({}, { ${name}: ${value} })`,
    ],
    [
      'Object.defineProperty',
      (name, value) =>
        `Object.defineProperty({}, '${name}', { value: ${value} })`,
    ],
    [
      'Object.defineProperties',
      (name, value) =>
        `Object.defineProperties({}, { ${name}: { value: ${value} } })`,
    ],
    [
      'Object.setPrototypeOf',
      (name, value) => `Object.setPrototypeOf({}, { ${name}: ${value} })`,
    ],
    ['Object.freeze', (name, value) => `Object.freeze({ ${name}: ${value} })`],
    ['Object.seal', (name, value) => `Object.seal({ ${name}: ${value} })`],
    [
      'Object.preventExtensions',
      (name, value) => `Object.preventExtensions({ ${name}: ${value} })`,
    ],
  ];
  const wholeReplacementCases = replacementContainerBuilders.flatMap(
    ([wrapper, build]) =>
      ['direct', 'alias'].flatMap((form) =>
        ['method', 'receiver'].map((kind) => [wrapper, form, kind, build])
      )
  );

  test.each(wholeReplacementCases)(
    'preserves %s %s whole-binding replacement for an analytics %s',
    (_wrapper, form, kind, build) => {
      const name = kind === 'method' ? 'emit' : 'tracker';
      const value = kind === 'method' ? 'analytics.track' : 'analytics';
      const expression = build(name, value);
      const before =
        kind === 'method'
          ? `box.emit(${dynamic});`
          : `box.tracker.track(${dynamic});`;
      const after =
        kind === 'method'
          ? `box.emit(${invalid});`
          : `box.tracker.track(${invalid});`;
      const replacement =
        form === 'alias'
          ? `const replacement = ${expression}; box = replacement;`
          : `box = ${expression};`;
      const code =
        'let box = { emit: widget.track, tracker: new Widget() }; ' +
        `${before} ${replacement} ${after}`;

      expect(diagnostics(code)).toEqual(['invalidValue', 'unbound']);
      expect(diagnosticsFor(code, typedOnly)).toEqual(['invalidValue']);
      expect(diagnosticsFor(code, privacyOnly)).toEqual(['unbound']);
    }
  );

  test.each([
    [
      'an analytics method',
      'emit',
      'analytics.track',
      `box.emit(${invalid});`,
      ['invalidValue', 'unbound'],
    ],
    [
      'an analytics receiver',
      'tracker',
      'analytics',
      `box.tracker.track(${invalid});`,
      ['invalidValue', 'unbound'],
    ],
    [
      'a mixed method',
      'emit',
      'flag ? analytics.track : widget.track',
      `box.emit(${invalid});`,
      ['invalidValue', 'unbound'],
    ],
    [
      'a mixed receiver',
      'tracker',
      'flag ? analytics : new Widget()',
      `box.tracker.track(${invalid});`,
      ['invalidValue', 'unbound'],
    ],
    ['an ordinary method', 'emit', 'widget.track', `box.emit(${dynamic});`, []],
    [
      'an ordinary receiver',
      'tracker',
      'new Widget()',
      `box.tracker.track(${dynamic});`,
      [],
    ],
    [
      'an opaque method',
      'emit',
      'load().emit',
      `box.emit(${invalid});`,
      ['unanalyzable', 'unanalyzable'],
    ],
    [
      'an opaque receiver',
      'tracker',
      'load().tracker',
      `box.tracker.track(${invalid});`,
      ['invalidValue', 'unbound'],
    ],
  ])(
    'copies %s from an Object.assign accessor source',
    (_name, property, value, call, outcome) => {
      const code =
        `const box = Object.assign({}, { get ${property}() { return ${value}; } }); ` +
        call;
      expect(diagnostics(code)).toEqual(outcome);
    }
  );

  const returnedDescriptorGetterCases = [
    ['Object.defineProperty', 'method shorthand', 'method'],
    ['Object.defineProperty', 'method shorthand', 'receiver'],
    ['Object.defineProperty', 'function value', 'method'],
    ['Object.defineProperty', 'function value', 'receiver'],
    ['Object.defineProperties', 'method shorthand', 'method'],
    ['Object.defineProperties', 'method shorthand', 'receiver'],
    ['Object.defineProperties', 'function value', 'method'],
    ['Object.defineProperties', 'function value', 'receiver'],
  ];

  test.each(returnedDescriptorGetterCases)(
    'resolves a returned %s %s getter for an analytics %s',
    (api, spelling, kind) => {
      const name = kind === 'method' ? 'emit' : 'tracker';
      const getter = (value) =>
        spelling === 'method shorthand'
          ? `get() { return ${value}; }`
          : `get: function () { return ${value}; }`;
      const build = (value) =>
        api === 'Object.defineProperty'
          ? `${api}({}, '${name}', { ${getter(value)} })`
          : `${api}({}, { ${name}: { ${getter(value)} } })`;
      const analyticsValue =
        kind === 'method' ? 'analytics.track' : 'analytics';
      const analyticsCall =
        kind === 'method'
          ? `box.emit(${invalid});`
          : `box.tracker.track(${invalid});`;
      const ordinaryValue = kind === 'method' ? 'widget.track' : 'new Widget()';
      const ordinaryCall =
        kind === 'method'
          ? `box.emit(${dynamic});`
          : `box.tracker.track(${dynamic});`;

      expect(
        diagnostics(`const box = ${build(analyticsValue)}; ${analyticsCall}`)
      ).toEqual(['invalidValue', 'unbound']);
      expect(
        diagnostics(`const box = ${build(ordinaryValue)}; ${ordinaryCall}`)
      ).toEqual([]);
      if (kind === 'method') {
        expect(
          diagnostics(`const box = ${build('load().emit')}; ${analyticsCall}`)
        ).toEqual(['unanalyzable', 'unanalyzable']);
      }
    }
  );

  const suspiciousReturnedContainerBuilders = [
    ['assign', (name, value) => `Object.assign({}, { ${name}: ${value} })`],
    [
      'defineProperty',
      (name, value) =>
        `Object.defineProperty({}, '${name}', { value: ${value} })`,
    ],
    [
      'defineProperties',
      (name, value) =>
        `Object.defineProperties({}, { ${name}: { value: ${value} } })`,
    ],
    [
      'setPrototypeOf',
      (name, value) => `Object.setPrototypeOf({}, { ${name}: ${value} })`,
    ],
  ];
  const suspiciousReturnedContainerCases =
    suspiciousReturnedContainerBuilders.flatMap(([method, build]) =>
      ['poisoned', 'shadowed'].flatMap((form) =>
        ['method', 'receiver'].map((kind) => [form, method, kind, build])
      )
    );

  test.each(suspiciousReturnedContainerCases)(
    'fails closed for a %s Object.%s returned container holding an analytics %s',
    (form, method, kind, build) => {
      const name = kind === 'method' ? 'emit' : 'tracker';
      const value = kind === 'method' ? 'analytics.track' : 'analytics';
      const call =
        kind === 'method'
          ? `box.emit(${invalid});`
          : `box.tracker.track(${invalid});`;
      const body = `const box = ${build(name, value)}; ${call}`;
      const code =
        form === 'poisoned'
          ? `Object.${method} = ordinary; ${body}`
          : `function run(Object) { ${body} }`;

      expect(diagnostics(code)).toEqual(['unanalyzable', 'unanalyzable']);
      expect(diagnosticsFor(code, typedOnly)).toEqual(['unanalyzable']);
      expect(diagnosticsFor(code, privacyOnly)).toEqual(['unanalyzable']);
    }
  );

  test('keeps an ordinary custom returned container silent', () => {
    const code =
      'const Utilities = { assign() { return { emit: widget.track }; } }; ' +
      `const box = Utilities.assign(); box.emit(${dynamic});`;
    expect(diagnostics(code)).toEqual([]);
  });
});

describe('event rule independence and diagnostics', () => {
  const code =
    "analytics.track('appointment_booked', { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' });";

  test('the privacy rule fails closed when the schema rule is disabled', () => {
    const configured = plugin.eventRules(LINT_ARTIFACT);
    const privacyOnly = {
      ...configured,
      'nitro-logger/typed-event-schema': 'off',
    };
    const messages = verify(code, privacyOnly);

    expect(messages.map((message) => message.ruleId)).toEqual([
      'nitro-logger/require-event-privacy',
    ]);
    expect(messages.map((message) => message.messageId)).toEqual(['unwrapped']);
  });

  test('rule declaration order does not change privacy findings', () => {
    const configured = plugin.eventRules(LINT_ARTIFACT);
    const entries = Object.entries(configured);
    const forward = verify(code, Object.fromEntries(entries));
    const reverse = verify(code, Object.fromEntries(entries.reverse()));

    expect(reverse).toEqual(forward);
  });

  test('pins diagnostic nodes and locations for every report family', () => {
    const cases = [
      [
        `analytics.track(\n  'unknown',\n  { clinic_type: 'gp', lead_time_days: 3, via: 'search' }\n);`,
        [
          ['unknownEvent', 'Literal', 2, 3, 2, 12],
          ['unbound', 'Literal', 2, 3, 2, 12],
        ],
      ],
      [
        `analytics.track(\n  'appointment_booked',\n  buildProperties(patient)\n);`,
        [
          ['opaqueProperties', 'CallExpression', 3, 3, 3, 27],
          ['unanalyzable', 'CallExpression', 3, 3, 3, 27],
        ],
      ],
      [
        `analytics.track(\n  'appointment_booked',\n  { clinic_type: 'gp', lead_time_days: 3, via: 'search', patient: value }\n);`,
        [
          ['unknownProperty', 'Identifier', 3, 58, 3, 65],
          ['unbound', 'Identifier', 3, 58, 3, 65],
        ],
      ],
      [
        `analytics.track(\n  'appointment_booked',\n  { clinic_type: 'gp', via: 'search' }\n);`,
        [
          ['missingProperty', 'ObjectExpression', 3, 3, 3, 39],
          ['unbound', 'ObjectExpression', 3, 3, 3, 39],
        ],
      ],
      [
        `analytics.track(\n  'appointment_booked',\n  { clinic_type: 'gp', lead_time_days: 999, via: 'search' }\n);`,
        [
          ['invalidValue', 'Literal', 3, 40, 3, 43],
          ['unbound', 'Literal', 3, 40, 3, 43],
        ],
      ],
      [
        `analytics.track(\n  'appointment_booked',\n  { clinic_type: 'gp', lead_time_days: patient.days, via: 'search' }\n);`,
        [['unwrapped', 'MemberExpression', 3, 40, 3, 52]],
      ],
    ];

    for (const [source, expected] of cases) {
      expect(
        verify(source, plugin.eventRules(LINT_ARTIFACT)).map((message) => [
          message.messageId,
          message.nodeType,
          message.line,
          message.column,
          message.endLine,
          message.endColumn,
        ])
      ).toEqual(expected);
    }
  });

  test('never echoes caller-controlled event, property, or value text', () => {
    const messages = verify(
      "analytics.track('Jane-Doe-diagnosis', { ['patient@example.com']: 'bipolar' });",
      plugin.eventRules(LINT_ARTIFACT)
    );
    const serialized = JSON.stringify(messages);

    expect(messages.length).toBeGreaterThan(0);
    expect(serialized).not.toMatch(
      /Jane|diagnosis|patient@example\.com|bipolar/
    );
  });
});
