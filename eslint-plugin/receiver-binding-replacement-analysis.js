'use strict';

function createReceiverBindingReplacementTools(dependencies) {
  const {
    aliasTools,
    analysisStats,
    contextWeakCache,
    indexTools,
    resolveReceiverObject,
  } = dependencies;
  const { OPAQUE_GETTER_VALUE, cachedObjectValueIndex } = aliasTools;
  const { appendReceiverWrite, receiverWrite, replacementPropertyValues } =
    indexTools;

  const bindingReplacementReferenceCache = new WeakMap();
  const bindingReplacementWriteIndexCache = new WeakMap();

  function bindingReplacementReferences(context, variable) {
    const perContext = contextWeakCache(
      bindingReplacementReferenceCache,
      context
    );
    const cached = perContext.get(variable);
    if (cached) return cached;
    const references = Object.freeze(
      variable.references.filter(
        (reference) => reference.init !== true && reference.isWrite()
      )
    );
    perContext.set(variable, references);
    return references;
  }

  function bindingReplacementWriteIndex(context, variable) {
    const perContext = contextWeakCache(
      bindingReplacementWriteIndexCache,
      context
    );
    const cached = perContext.get(variable);
    if (cached) return cached;
    const stats = analysisStats(context);
    if (stats) stats.bindingReplacementIndexComputations += 1;
    const index = { byName: new Map(), wildcard: [] };
    for (const reference of bindingReplacementReferences(context, variable)) {
      const identifier = reference.identifier;
      const source = reference.writeExpr ?? identifier;
      const parent = identifier.parent;
      const gate =
        parent?.type === 'AssignmentExpression' && parent.left === identifier
          ? parent
          : identifier;
      const object = resolveReceiverObject(context, source);
      if (!object) {
        index.wildcard.push(receiverWrite(gate, [OPAQUE_GETTER_VALUE]));
        continue;
      }
      const values = cachedObjectValueIndex(object, context);
      if (values.opaqueVersion > 0) {
        index.wildcard.push(receiverWrite(gate, [OPAQUE_GETTER_VALUE]));
      }
      for (const [name, selected] of values.values) {
        if (selected.opaqueVersion !== values.opaqueVersion) continue;
        appendReceiverWrite(
          index.byName,
          name,
          receiverWrite(gate, replacementPropertyValues(context, source, name))
        );
      }
    }
    perContext.set(variable, index);
    return index;
  }

  function bindingReplacementWrites(context, variable, name) {
    const index = bindingReplacementWriteIndex(context, variable);
    return Object.freeze([...(index.byName.get(name) ?? [])]);
  }

  return Object.freeze({
    bindingReplacementReferences,
    bindingReplacementWriteIndex,
    bindingReplacementWrites,
  });
}

module.exports = { createReceiverBindingReplacementTools };
