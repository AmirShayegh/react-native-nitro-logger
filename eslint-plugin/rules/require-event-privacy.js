'use strict';

const { EVENT_OPTION_PROPERTIES } = require('../event-analysis');
const { createEventRuleVisitor } = require('../event-rule-visitor');

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'require dynamic event values to use a proven pub() or priv() wrapper',
    },
    schema: [
      {
        type: 'object',
        properties: EVENT_OPTION_PROPERTIES,
        required: ['lintArtifact'],
        additionalProperties: false,
      },
    ],
    messages: {
      invalidWrapper:
        'Event privacy wrappers must be a proven one-argument pub() or priv() call.',
      unanalyzable:
        'This event call hides the schema or property positions, so privacy cannot be proven.',
      unbound:
        'This event value cannot be bound to a declared schema constraint.',
      unwrapped:
        'Dynamic event values must use pub() or priv() imported from a trusted privacy module.',
    },
  },

  create(context) {
    return createEventRuleVisitor(context, {
      missingProperty: () => 'unbound',
      privacyValue(value) {
        if (value.error) return null;
        if (value.privacy === 'invalid-wrapper') return 'invalidWrapper';
        if (value.privacy === 'unwrapped') return 'unwrapped';
        return value.valid ? null : 'unbound';
      },
      propertyError: () => 'unbound',
      structureError: (structure) =>
        structure.error === 'unanalyzable' ||
        structure.error === 'opaqueProperties'
          ? 'unanalyzable'
          : 'unbound',
    });
  },
};
