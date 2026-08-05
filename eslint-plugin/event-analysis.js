'use strict';

const { compileLintArtifact } = require('./event-artifact');
const {
  RECEIVER_CLASSIFICATION,
  bindingValues,
  enableAnalysisStats,
  methodBindingCandidates,
  normalizeEventCall,
  receiverBindingSummary,
} = require('./event-call-analysis');
const {
  ANALYTICS_FACTORY_NAMES,
  DEFAULT_ANALYTICS_MODULES,
  DEFAULT_ANALYTICS_NAMES,
  DEFAULT_PRIVACY_MODULES,
  EVENT_METHODS,
  EVENT_OPTION_PROPERTIES,
  PRIVACY_WRAPPER_NAMES,
  eventRuleOptions,
} = require('./event-options');
const { classifyEventPrivacy, satisfies } = require('./event-privacy');
const { bindEventStructure } = require('./event-structure');

const preparedEventAnalyses = new WeakMap();

function prepareEventAnalysis(context) {
  const cached = preparedEventAnalyses.get(context);
  if (cached) return cached;
  const options = eventRuleOptions(context);
  const prepared = Object.freeze({
    compiled: compileLintArtifact(options.lintArtifact),
  });
  preparedEventAnalyses.set(context, prepared);
  return prepared;
}

function analyzeEventCall(context, node) {
  const { compiled } = prepareEventAnalysis(context);
  const call = normalizeEventCall(context, node);
  if (!call) return null;
  const structure = bindEventStructure(context, call, compiled);
  const privacy = classifyEventPrivacy(context, structure);
  return Object.freeze({ call, compiled, privacy, structure });
}

module.exports = {
  ANALYTICS_FACTORY_NAMES,
  DEFAULT_ANALYTICS_MODULES,
  DEFAULT_ANALYTICS_NAMES,
  DEFAULT_PRIVACY_MODULES,
  EVENT_METHODS,
  EVENT_OPTION_PROPERTIES,
  PRIVACY_WRAPPER_NAMES,
  RECEIVER_CLASSIFICATION,
  analyzeEventCall,
  bindingValues,
  bindEventStructure,
  classifyEventPrivacy,
  enableAnalysisStats,
  methodBindingCandidates,
  normalizeEventCall,
  prepareEventAnalysis,
  receiverBindingSummary,
  satisfies,
};
