'use strict';

const { createTemporalWriteTools } = require('./receiver-temporal-analysis');

function createReceiverWriteTemporalQueries(dependencies) {
  const {
    aliasTools,
    analysisStats,
    bindingTools,
    contextKeyedMap,
    contextWeakCache,
    getOrCreateMap,
    indexTools,
    isDeferred,
  } = dependencies;
  const { receiverAliasComponent } = aliasTools;
  const { bindingReplacementWriteIndex, bindingReplacementWrites } =
    bindingTools;
  const { indexedReceiverWrites, receiverWrite, receiverWriteIndex } =
    indexTools;
  const temporal = createTemporalWriteTools({
    analysisStats,
    isDeferred,
    receiverWrite,
  });

  const receiverWriteCache = new WeakMap();
  const receiverReplacementWriteCache = new WeakMap();

  function receiverWriteEntry(context, component, name) {
    const perContext = contextWeakCache(receiverWriteCache, context);
    const perComponent = getOrCreateMap(perContext, component[0]);
    let entry = perComponent.get(name);
    if (entry) return entry;

    const stats = analysisStats(context);
    if (stats) stats.receiverComponentPropertyComputations += 1;
    const base = indexedReceiverWrites(context, component, name, false);
    entry = { base, eventBase: null };
    perComponent.set(name, entry);
    return entry;
  }

  function receiverWrites(
    context,
    variable,
    name,
    includeBindingReplacements = false
  ) {
    const component = receiverAliasComponent(context, variable);
    const cached = receiverWriteEntry(context, component, name);
    if (!includeBindingReplacements) return cached.base;
    if (!cached.eventBase) {
      cached.eventBase = indexedReceiverWrites(context, component, name, true);
    }
    const replacements = contextKeyedMap(
      receiverReplacementWriteCache,
      context,
      variable
    );
    if (!replacements.has(name)) {
      replacements.set(
        name,
        Object.freeze([
          ...cached.eventBase,
          ...bindingReplacementWrites(context, variable, name),
        ])
      );
    }
    return replacements.get(name);
  }

  function receiverWildcardIndexes(context, variable) {
    const component = receiverAliasComponent(context, variable);
    return [
      receiverWriteIndex(context, component).complexWildcard,
      bindingReplacementWriteIndex(context, variable).wildcard,
    ];
  }

  function receiverWildcardWrites(context, variable, callNode) {
    return receiverWildcardIndexes(context, variable)
      .map((writes) =>
        temporal.summarizedTemporalWrite(context, writes, callNode, true)
      )
      .filter(Boolean);
  }

  function receiverNamedWrites(context, variable, name, callNode) {
    const writes = receiverWrites(context, variable, name, true);
    const write = temporal.summarizedTemporalWrite(
      context,
      writes,
      callNode,
      false
    );
    return write ? [write] : [];
  }

  function receiverWildcardCount(context, variable) {
    return receiverWildcardIndexes(context, variable).reduce(
      (count, writes) => count + writes.length,
      0
    );
  }

  function receiverWildcardChangePoints(context, variable) {
    return receiverWildcardIndexes(context, variable).flatMap((writes) =>
      temporal.changePoints(context, writes, true)
    );
  }

  return Object.freeze({
    receiverNamedWrites,
    receiverWildcardChangePoints,
    receiverWildcardCount,
    receiverWildcardWrites,
    receiverWrites,
  });
}

module.exports = { createReceiverWriteTemporalQueries };
