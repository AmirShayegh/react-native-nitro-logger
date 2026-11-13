'use strict';

const { analyzeEventCall, prepareEventAnalysis } = require('./event-analysis');

function reportMessage(context, node, messageId) {
  if (messageId) context.report({ node, messageId });
}

/** Share the analysis walk while each rule owns only its reporting policy. */
function createEventRuleVisitor(context, policy) {
  prepareEventAnalysis(context);
  return {
    CallExpression(node) {
      const analysis = analyzeEventCall(context, node);
      if (!analysis) return;
      const { structure, privacy } = analysis;

      if (structure.error) {
        reportMessage(
          context,
          structure.error === 'opaqueProperties'
            ? structure.propertiesNode
            : structure.eventNode,
          policy.structureError(structure)
        );
        return;
      }

      for (const property of structure.properties) {
        if (property.error) {
          reportMessage(context, property.node, policy.propertyError(property));
        }
      }
      for (let index = 0; index < structure.missing.length; index += 1) {
        reportMessage(
          context,
          structure.propertiesNode,
          policy.missingProperty(structure.missing[index])
        );
      }
      for (const value of privacy) {
        reportMessage(context, value.value, policy.privacyValue(value));
      }
    },
  };
}

module.exports = { createEventRuleVisitor };
