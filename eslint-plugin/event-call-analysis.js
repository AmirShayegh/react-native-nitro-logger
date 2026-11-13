'use strict';

const {
  bindingValues,
  enableAnalysisStats,
  immutableInit,
  importedName,
  importSource,
} = require('./event-bindings');
const {
  trustedAnalyticsNamespace,
  trustedFactoryCall,
  trustedFactoryReference,
} = require('./event-factory');
const {
  hasSpread,
  methodBindingCandidates,
  normalizeEventCall,
} = require('./event-method');
const {
  CONSTRUCTION_CLASSIFICATION,
  RECEIVER_CLASSIFICATION,
  classifyReceiver,
  receiverBindingSummary,
  stableProvenConstruction,
} = require('./event-receiver');

module.exports = {
  CONSTRUCTION_CLASSIFICATION,
  RECEIVER_CLASSIFICATION,
  bindingValues,
  classifyReceiver,
  enableAnalysisStats,
  immutableInit,
  importedName,
  importSource,
  hasSpread,
  methodBindingCandidates,
  normalizeEventCall,
  receiverBindingSummary,
  stableProvenConstruction,
  trustedAnalyticsNamespace,
  trustedFactoryCall,
  trustedFactoryReference,
};
