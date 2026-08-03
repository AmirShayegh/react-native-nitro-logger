'use strict';

const {
  attachReceiverAnalysisStats,
  contextWeakCache,
  projectPatternBinding,
  projectReferenceWrite,
  singleDef,
} = require('./shared');

const IN_PROGRESS = Symbol('in-progress');
const bindingValueCache = new WeakMap();
const analysisStats = new WeakMap();

function enableAnalysisStats(context) {
  const stats = {
    bindingReplacementIndexComputations: 0,
    builtinMethodBindingComputations: 0,
    builtinMethodMergeVisits: 0,
    builtinNamespaceBindingComputations: 0,
    builtinNamespaceDirectVisits: 0,
    builtinNamespaceMergeVisits: 0,
    classAliasValueComputations: 0,
    classCandidateIndexComputations: 0,
    classIdentityComputations: 0,
    classMemberComputations: 0,
    constructionBindingComputations: 0,
    containerMethodComputations: 0,
    factoryBindingComputations: 0,
    forwarderBindingComputations: 0,
    memberReceiverComputations: 0,
    methodIntervalComputations: 0,
    identifierMethodComputations: 0,
    methodBindingEntryVisits: 0,
    methodCandidateMergeVisits: 0,
    memberExtractionIndexComputations: 0,
    memberSpreadJoinVisits: 0,
    arrayElementIndexComputations: 0,
    namespaceBindingComputations: 0,
    objectAssignFallbackVisits: 0,
    objectAssignSourceIndexVisits: 0,
    projectionContainerComputations: 0,
    proxyConstructorComputations: 0,
    receiverMutationReferenceVisits: 0,
    receiverWriteIndexComputations: 0,
    receiverComponentPropertyComputations: 0,
    receiverObjectIndexComputations: 0,
    receiverObjectResolutionComputations: 0,
    staticArrayAliasBindingVisits: 0,
    staticArrayAliasResolutionHops: 0,
    staticContainerSourceCacheHits: 0,
    staticContainerSourceDedupVisits: 0,
    staticContainerSourceReferenceVisits: 0,
    staticContainerSourceSummaryComputations: 0,
    receiverNamedIntervalComputations: 0,
    receiverNamedSummaryComputations: 0,
    receiverWildcardIntervalComputations: 0,
    receiverWildcardSummaryComputations: 0,
  };
  analysisStats.set(context, stats);
  attachReceiverAnalysisStats(context, stats);
  return stats;
}

function incrementAnalysisStat(context, name) {
  const stats = analysisStats.get(context);
  if (stats) stats[name] += 1;
}

const EMPTY_BINDING_SUMMARY = Object.freeze({
  entries: Object.freeze([]),
  opaqueWrite: true,
  values: Object.freeze([]),
});

function projectedEntries(projection, gate, initial) {
  return projection.values.map((value) =>
    Object.freeze({ gate, initial, value })
  );
}

function initialBindingProjection(context, def) {
  if (!def.node.init) return { entries: [], opaque: false };
  const projection = projectPatternBinding(
    def.node.id,
    def.name ?? def.node.id,
    def.node.init,
    context
  );
  return {
    entries: projectedEntries(projection, def.node, true),
    opaque: projection.opaque,
  };
}

function referenceBindingProjection(context, reference) {
  const projection = projectReferenceWrite(reference, context);
  const identifier = reference.identifier ?? reference.writeExpr;
  const gate =
    identifier?.parent?.type === 'AssignmentExpression'
      ? identifier.parent
      : identifier;
  return {
    entries: projectedEntries(projection, gate, false),
    opaque: projection.opaque,
  };
}

function bindingValues(context, variable) {
  const perContext = contextWeakCache(bindingValueCache, context);
  const cached = perContext.get(variable);
  if (cached) return cached;

  const def = singleDef(variable);
  if (!def || def.type !== 'Variable') {
    perContext.set(variable, EMPTY_BINDING_SUMMARY);
    return EMPTY_BINDING_SUMMARY;
  }

  const initial = initialBindingProjection(context, def);
  let opaqueWrite = initial.opaque;
  const entries = [...initial.entries];
  for (const reference of variable.references) {
    if (!reference.isWrite() || reference.init === true) continue;
    const projected = referenceBindingProjection(context, reference);
    if (projected.opaque) opaqueWrite = true;
    entries.push(...projected.entries);
  }
  const values = Object.freeze(entries.map((entry) => entry.value));
  const result = Object.freeze({
    entries: Object.freeze(entries),
    opaqueWrite,
    values,
  });
  perContext.set(variable, result);
  return result;
}

function immutableInit(variable) {
  const def = singleDef(variable);
  if (
    !def ||
    def.type !== 'Variable' ||
    def.parent?.kind !== 'const' ||
    def.node.id.type !== 'Identifier'
  ) {
    return null;
  }
  return def.node.init ?? null;
}

function importedName(def) {
  if (!def || def.type !== 'ImportBinding') return null;
  if (def.node.type !== 'ImportSpecifier') return null;
  return def.node.imported?.name ?? null;
}

function importSource(def) {
  const source = def?.parent?.source?.value;
  return typeof source === 'string' ? source : null;
}

module.exports = {
  IN_PROGRESS,
  bindingValues,
  contextWeakCache,
  enableAnalysisStats,
  immutableInit,
  importedName,
  importSource,
  incrementAnalysisStat,
};
