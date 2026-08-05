'use strict';

function createReceiverPropertyTools(dependencies) {
  const {
    aliasTools,
    classReceiverCandidates,
    classReceiverIdentity,
    contextKeyedMap,
    isDeferred,
    reachesCall,
    receiverProperty,
    resolveReceiverObject,
    resolveVariable,
    unwrap,
    writeTools,
  } = dependencies;
  const { graphClosure, receiverObjectPropertyValues } = aliasTools;
  const {
    receiverNamedWrites,
    receiverWildcardChangePoints,
    receiverWildcardCount,
    receiverWildcardWrites,
    receiverWrites,
  } = writeTools;
  const receiverChangePointCache = new WeakMap();

  function receiverPropertyCandidates(
    context,
    node,
    name,
    callNode,
    includeBindingReplacements = false
  ) {
    const candidates = [];
    const receiverObject = resolveReceiverObject(context, node);
    if (includeBindingReplacements) {
      candidates.push(
        ...receiverObjectPropertyValues(
          receiverObject,
          node,
          name,
          false,
          context
        )
      );
    } else {
      const property = receiverProperty(receiverObject, name);
      if (property) candidates.push(property.value);
    }

    const current = unwrap(node);
    if (includeBindingReplacements && classReceiverIdentity(context, current)) {
      candidates.push(...classReceiverCandidates(context, current, name));
    }
    if (!current || current.type !== 'Identifier') return candidates;
    const variable = resolveVariable(context, current);
    if (!variable) return candidates;

    const namedWrites = includeBindingReplacements
      ? receiverNamedWrites(context, variable, name, callNode)
      : receiverWrites(context, variable, name, false);
    for (const write of namedWrites) {
      if (!reachesCall(write.gate, callNode)) continue;
      for (const value of write.values) candidates.push(value);
    }
    if (includeBindingReplacements) {
      for (const write of receiverWildcardWrites(context, variable, callNode)) {
        for (const value of write.values) candidates.push(value);
      }
    }
    return candidates;
  }

  function receiverPropertyIsCallSensitive(
    context,
    node,
    name,
    includeBindingReplacements = false
  ) {
    const current = unwrap(node);
    if (!current || current.type !== 'Identifier') return false;
    const variable = resolveVariable(context, current);
    if (!variable) return false;
    if (
      receiverWrites(context, variable, name, includeBindingReplacements)
        .length > 0
    ) {
      return true;
    }
    return (
      includeBindingReplacements && receiverWildcardCount(context, variable) > 0
    );
  }

  function receiverPropertyChangePoints(
    context,
    node,
    name,
    includeBindingReplacements = false
  ) {
    const current = unwrap(node);
    if (!current || current.type !== 'Identifier') return Object.freeze([]);
    const variable = resolveVariable(context, current);
    if (!variable) return Object.freeze([]);
    const perVariable = contextKeyedMap(
      receiverChangePointCache,
      context,
      variable
    );
    const cacheKey = `${name}\u0000${includeBindingReplacements ? '1' : '0'}`;
    const cached = perVariable.get(cacheKey);
    if (cached) return cached;
    const points = [];
    for (const write of receiverWrites(
      context,
      variable,
      name,
      includeBindingReplacements
    )) {
      if (!isDeferred(write.gate)) points.push(write.gate.range[0]);
    }
    if (includeBindingReplacements) {
      points.push(...receiverWildcardChangePoints(context, variable));
    }
    points.sort((left, right) => left - right);
    const result = Object.freeze([...new Set(points)]);
    perVariable.set(cacheKey, result);
    return result;
  }

  return Object.freeze({
    graphClosure,
    receiverCallIsDeferred: (node) => !!node && isDeferred(node),
    receiverPropertyCandidates,
    receiverPropertyChangePoints,
    receiverPropertyIsCallSensitive,
    receiverWriteReachesCall: (write, callNode) => reachesCall(write, callNode),
  });
}

module.exports = { createReceiverPropertyTools };
