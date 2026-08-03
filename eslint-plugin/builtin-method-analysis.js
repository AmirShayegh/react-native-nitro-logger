'use strict';

function createBuiltinMethodAnalysisUnit(
  dependencies,
  {
    context,
    namespacePatternMethods,
    poisoned,
    possibleBuiltinNamespaceValues,
    referenceNamespacePatternMethods,
    referenceStaticContainerPatternValues,
    resolveReturnTargetCall,
    state,
    staticContainerMemberValues,
    staticContainerPatternValues,
    staticMemberKey,
  }
) {
  const {
    ALL_NAMESPACES_POISONED,
    identityWrapper,
    projectPatternBinding,
    projectReferenceWrite,
    receiverAnalysisStats,
    resolveBindingSetComponents,
    resolveVariable,
    singleDef,
    unwrap,
  } = dependencies;
  const opaqueBuiltinMethods = () => new Set(['Object:*', 'Reflect:*']);
  const incompleteBuiltinMethods = () => {
    const methods = new Set();
    state.incompleteBuiltinMethodSets.add(methods);
    return methods;
  };

  const builtinCallableBindingSources = (variable) => {
    const methods = new Set();
    const sources = [];
    const seenSources = new Set();
    let opaque = false;
    const append = (patternMethods, staticProjection, projection) => {
      for (const method of patternMethods) methods.add(method);
      for (const source of [...staticProjection.values, ...projection.values]) {
        if (!seenSources.has(source)) {
          seenSources.add(source);
          sources.push(source);
        }
      }
      // A direct `{ assign } = Object` pattern is exact provenance supplied
      // by `namespacePatternMethods`; container projection is inapplicable,
      // not uncertain. For actual containers, prefer its richer mutation and
      // escape state over the projection helper's alias-hop marker.
      if (patternMethods.size === 0) {
        opaque ||=
          staticProjection.values.length > 0
            ? staticProjection.opaque
            : staticProjection.opaque || projection.opaque;
      }
    };
    const def = singleDef(variable);
    if (def?.type === 'Variable' && def.node.init) {
      append(
        namespacePatternMethods(
          def.node.id,
          def.name ?? def.node.id,
          def.node.init
        ),
        staticContainerPatternValues(
          def.node.id,
          def.name ?? def.node.id,
          def.node.init
        ),
        projectPatternBinding(
          def.node.id,
          def.name ?? def.node.id,
          def.node.init,
          context
        )
      );
    }
    for (const reference of variable.references) {
      if (!reference.isWrite() || reference.init === true) continue;
      append(
        referenceNamespacePatternMethods(reference),
        referenceStaticContainerPatternValues(reference),
        projectReferenceWrite(reference, context)
      );
    }
    return { methods, opaque, sources };
  };

  const directCallableBindingDependencies = (node) => {
    let current = unwrap(node);
    if (current?.type === 'CallExpression') {
      const callee = unwrap(current.callee);
      if (
        callee?.type === 'MemberExpression' &&
        staticMemberKey(callee) === 'bind'
      ) {
        current = unwrap(callee.object);
      }
    }
    if (current?.type !== 'Identifier') return [];
    const variable = resolveVariable(context, current);
    return variable ? [variable] : [];
  };

  const combinedBuiltinMethods = (nodes, seen) => {
    const candidates = nodes.map((node) => possibleBuiltinMethods(node, seen));
    const methods = new Set(candidates.flatMap((candidate) => [...candidate]));
    const incomplete = candidates.some((candidate) =>
      state.incompleteBuiltinMethodSets.has(candidate)
    );
    if (
      methods.size > 0 &&
      (incomplete || candidates.some((candidate) => candidate.size === 0))
    ) {
      for (const method of opaqueBuiltinMethods()) methods.add(method);
    } else if (incomplete) {
      state.incompleteBuiltinMethodSets.add(methods);
    }
    return methods;
  };

  const possibleBuiltinMethods = (node, seen = new Set()) => {
    const current = unwrap(node);
    if (!current) return new Set();
    const returned = resolveReturnTargetCall(current, false);
    if (returned) {
      if (
        returned.opaque ||
        poisoned.has(ALL_NAMESPACES_POISONED) ||
        poisoned.has('Object')
      ) {
        const inner = returned.opaque
          ? new Set()
          : possibleBuiltinMethods(returned.arguments[0], seen);
        const methods = new Set(inner);
        for (const method of opaqueBuiltinMethods()) methods.add(method);
        return methods;
      }
      return possibleBuiltinMethods(returned.arguments[0], seen);
    }
    const identity = identityWrapper(context, current);
    if (identity) {
      const inner = possibleBuiltinMethods(identity.arguments[0], seen);
      if (poisoned.has(ALL_NAMESPACES_POISONED) || poisoned.has('Object')) {
        const methods = new Set(inner);
        for (const method of opaqueBuiltinMethods()) methods.add(method);
        return methods;
      }
      return inner;
    }
    if (current.type === 'ConditionalExpression') {
      return combinedBuiltinMethods(
        [current.consequent, current.alternate],
        seen
      );
    }
    if (current.type === 'LogicalExpression') {
      return combinedBuiltinMethods([current.left, current.right], seen);
    }
    if (current.type === 'CallExpression') {
      const callee = unwrap(current.callee);
      if (
        callee?.type === 'MemberExpression' &&
        staticMemberKey(callee) === 'bind'
      ) {
        return possibleBuiltinMethods(callee.object, seen);
      }
      const indirect = state.indirectBindResult?.(current);
      if (!indirect) return new Set();
      return indirect.opaque || !indirect.target
        ? opaqueBuiltinMethods()
        : possibleBuiltinMethods(indirect.target, seen);
    }
    if (current.type === 'MemberExpression') {
      if (seen.has(current)) return incompleteBuiltinMethods();
      const nextSeen = new Set(seen);
      nextSeen.add(current);
      const method = staticMemberKey(current);
      const methods = new Set();
      for (const namespace of possibleBuiltinNamespaceValues(
        current.object,
        nextSeen
      )) {
        methods.add(`${namespace}:${method ?? '*'}`);
      }
      if (methods.size > 0) return methods;

      const projection = staticContainerMemberValues(current, nextSeen);
      const candidates = projection.values.map((value) =>
        possibleBuiltinMethods(value, nextSeen)
      );
      const incomplete = candidates.some((candidate) =>
        state.incompleteBuiltinMethodSets.has(candidate)
      );
      for (const candidate of candidates) {
        for (const builtin of candidate) methods.add(builtin);
      }
      if (
        methods.size > 0 &&
        (projection.opaque ||
          incomplete ||
          candidates.some((candidate) => candidate.size === 0))
      ) {
        for (const builtin of opaqueBuiltinMethods()) methods.add(builtin);
      } else if (incomplete) {
        state.incompleteBuiltinMethodSets.add(methods);
      }
      return methods;
    }
    if (current.type !== 'Identifier') return new Set();
    const variable = resolveVariable(context, current);
    if (!variable) return new Set();
    if (seen.has(variable)) {
      return incompleteBuiltinMethods();
    }
    return resolveBindingSetComponents({
      analysisStats: receiverAnalysisStats.get(context),
      cache: state.builtinMethodCache,
      dependenciesOf: directCallableBindingDependencies,
      evaluate: (source) => possibleBuiltinMethods(source),
      incompleteSets: state.incompleteBuiltinMethodSets,
      merge(descriptor, sourceMethodSets) {
        const stats = receiverAnalysisStats.get(context);
        const methods = new Set(descriptor.methods);
        const ownMethods = methods.size > 0;
        const incomplete = sourceMethodSets.some((sourceMethods) =>
          state.incompleteBuiltinMethodSets.has(sourceMethods)
        );
        if (
          incomplete &&
          methods.size === 0 &&
          sourceMethodSets.every((sourceMethods) => sourceMethods.size === 0)
        ) {
          return { cache: false, incomplete: true, values: methods };
        }
        const mixed =
          sourceMethodSets.some((candidate) => candidate.size > 0) &&
          sourceMethodSets.some((candidate) => candidate.size === 0);
        if (incomplete || ((descriptor.opaque || mixed) && methods.size > 0)) {
          for (const method of opaqueBuiltinMethods()) methods.add(method);
        }
        if (
          !incomplete &&
          !descriptor.opaque &&
          !ownMethods &&
          sourceMethodSets.length > 0 &&
          sourceMethodSets.every(
            (candidate) => candidate === sourceMethodSets[0]
          )
        ) {
          return { values: sourceMethodSets[0] };
        }
        for (const sourceMethods of sourceMethodSets) {
          if (stats) stats.builtinMethodMergeVisits += sourceMethods.size;
          for (const method of sourceMethods) methods.add(method);
        }
        if ((descriptor.opaque || mixed) && methods.size > 0) {
          for (const method of opaqueBuiltinMethods()) methods.add(method);
        }
        return { values: methods };
      },
      onDiscover() {
        const stats = receiverAnalysisStats.get(context);
        if (stats) stats.builtinMethodBindingComputations += 1;
      },
      read: builtinCallableBindingSources,
      rootVariable: variable,
    });
  };

  return Object.freeze({
    builtinCallableBindingSources,
    directCallableBindingDependencies,
    possibleBuiltinMethods,
  });
}

module.exports = { createBuiltinMethodAnalysisUnit };
