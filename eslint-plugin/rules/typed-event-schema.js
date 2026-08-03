'use strict';

const { EVENT_OPTION_PROPERTIES } = require('../event-analysis');
const { createEventRuleVisitor } = require('../event-rule-visitor');

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'require analytics.track calls to match the closed defineEvents schema',
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
      computedProperty:
        'Event property names must be literal so the closed schema can be checked.',
      duplicateProperty:
        'Event properties must be listed once so the value being validated is unambiguous.',
      dynamicEvent:
        'Event names must resolve to a schema-authored string constant.',
      invalidValue:
        'This statically known event value is outside its schema constraint.',
      missingProperty:
        'This event is missing a required schema-authored property.',
      opaqueProperties:
        'Event properties must be an analyzable object literal with a closed key set.',
      spreadProperty:
        'Spreading event properties hides keys from the closed schema.',
      unanalyzable:
        'This event call passes arguments indirectly, so its schema cannot be checked.',
      unknownEvent: 'This event name is not declared by the lint artifact.',
      unknownProperty: 'This property is not declared for the selected event.',
    },
  },

  create(context) {
    return createEventRuleVisitor(context, {
      missingProperty: () => 'missingProperty',
      privacyValue: (value) =>
        value.descriptor && !value.error && value.staticKnown && !value.valid
          ? 'invalidValue'
          : null,
      propertyError: (property) => property.error,
      structureError: (structure) => structure.error,
    });
  },
};
