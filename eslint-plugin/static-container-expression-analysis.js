'use strict';

const {
  createStaticContainerMemberWriteIndex,
  createStaticContainerSourceSummaryIndex,
} = require('./static-container-index-analysis');

function createStaticContainerExpressionTools({
  context,
  isWriteTarget,
  projectPatternBinding,
  projectReferenceWrite,
  receiverAnalysisStats,
  resolveVariable,
  singleDef,
  state,
  staticContainerMemberKey,
  staticContainerProjection,
  unwrap,
}) {
  const referenceStaticContainerPatternValues = (...args) =>
    state.pattern.referenceStaticContainerPatternValues(...args);
  const staticContainerPatternValues = (...args) =>
    state.pattern.staticContainerPatternValues(...args);
  const staticContainerMemberValues = (...args) =>
    state.member.staticContainerMemberValues(...args);

  const transparentReferenceParent = (parent, current) =>
    !!parent &&
    [
      'ChainExpression',
      'TSAsExpression',
      'TSInstantiationExpression',
      'TSNonNullExpression',
      'TSSatisfiesExpression',
      'TSTypeAssertion',
    ].includes(parent.type) &&
    parent.expression === current;

  const staticContainerMemberWriteValues =
    createStaticContainerMemberWriteIndex({
      analysisStats: (analysisContext) =>
        receiverAnalysisStats.get(analysisContext),
      context,
      isWriteTarget,
      memberKey: staticContainerMemberKey,
      projection: staticContainerProjection,
      resolveVariable,
      transparentParent: transparentReferenceParent,
      unwrap,
    });

  const staticContainerBindingOpacityCache = new WeakMap();

  const staticContainerBindingIsOpaque = (variable, permittedIdentifier) => {
    let indexed = staticContainerBindingOpacityCache.get(variable);
    if (indexed) {
      return (
        indexed.alwaysOpaque ||
        indexed.opaqueIdentifiers.some(
          (identifier) => identifier !== permittedIdentifier
        )
      );
    }
    if (!singleDef(variable)) return true;
    indexed = { alwaysOpaque: false, opaqueIdentifiers: [] };
    for (const reference of variable.references) {
      if (reference.init === true) continue;
      if (reference.isWrite()) {
        const replacement = referenceStaticContainerPatternValues(reference);
        // An exact whole-binding replacement is already one of the sources
        // joined by staticContainerBindingSources. It is not an unseen write
        // through the container and must not turn two identical Object (or
        // Reflect) alternatives into every builtin namespace.
        if (replacement.present && !replacement.opaque) continue;
        indexed.alwaysOpaque = true;
        break;
      }
      const identifier = reference.identifier;
      if (!identifier) continue;

      let current = identifier;
      let parent = current.parent;
      while (transparentReferenceParent(parent, current)) {
        current = parent;
        parent = current.parent;
      }
      if (parent?.type !== 'MemberExpression' || parent.object !== current) {
        // The container itself escaped (argument, return, alias, collection,
        // computed key, and so on), so code outside this projection can write
        // through it.
        indexed.opaqueIdentifiers.push(identifier);
        continue;
      }

      let member = parent;
      while (
        member.parent?.type === 'MemberExpression' &&
        member.parent.object === member
      ) {
        member = member.parent;
      }
      if (isWriteTarget(member)) {
        indexed.opaqueIdentifiers.push(identifier);
        continue;
      }
      if (
        (member.parent?.type === 'CallExpression' ||
          member.parent?.type === 'NewExpression') &&
        member.parent.callee === member
      ) {
        // A method call exposes the container as `this`.
        indexed.opaqueIdentifiers.push(identifier);
      }
    }
    staticContainerBindingOpacityCache.set(variable, indexed);
    return (
      indexed.alwaysOpaque ||
      indexed.opaqueIdentifiers.some(
        (identifier) => identifier !== permittedIdentifier
      )
    );
  };

  const staticContainerBindingSources = createStaticContainerSourceSummaryIndex(
    {
      analysisStats: (analysisContext) =>
        receiverAnalysisStats.get(analysisContext),
      context,
      projectInitial(variable) {
        const def = singleDef(variable);
        if (def?.type !== 'Variable' || !def.node.init) return null;
        return {
          projected: projectPatternBinding(
            def.node.id,
            def.name ?? def.node.id,
            def.node.init,
            context
          ),
          staticProjected: staticContainerPatternValues(
            def.node.id,
            def.name ?? def.node.id,
            def.node.init
          ),
        };
      },
      projectReference: (reference) => ({
        projected: projectReferenceWrite(reference, context),
        staticProjected: referenceStaticContainerPatternValues(reference),
      }),
      projection: staticContainerProjection,
    }
  );

  const staticContainerExpressionValues = (node, seen = new Set()) => {
    let current = unwrap(node);
    if (!current) return staticContainerProjection([], true, false);
    const chainSeen = new Set(seen);
    let chainNamespaceOpaque = false;
    let chainOpaque = false;
    let chainPresent = false;
    const includeChain = (projection) =>
      staticContainerProjection(
        projection.values,
        chainOpaque || projection.opaque,
        chainPresent || projection.present,
        chainNamespaceOpaque || projection.namespaceOpaque
      );

    // Named container aliases are overwhelmingly linear. Collapse that path
    // in one loop so a generated chain cannot overflow before reaching its
    // array/object (or the first genuinely branching binding).
    while (current?.type === 'Identifier') {
      const variable = resolveVariable(context, current);
      if (!variable || chainSeen.has(variable)) {
        return includeChain(staticContainerProjection([], true, false));
      }
      chainSeen.add(variable);
      const sources = staticContainerBindingSources(variable);
      chainOpaque ||=
        sources.opaque || staticContainerBindingIsOpaque(variable, current);
      chainNamespaceOpaque ||= sources.namespaceOpaque;
      chainPresent ||= sources.present;
      if (sources.values.length !== 1) {
        // The branching path below owns this variable. Leaving it in the
        // linear-chain guard made that path immediately diagnose its own
        // entry as a cycle, dropping every whole-binding object/array
        // replacement before it could be projected.
        chainSeen.delete(variable);
        break;
      }
      current = unwrap(sources.values[0]);
    }
    if (!current) {
      return includeChain(staticContainerProjection([], true, false));
    }
    if (
      current.type === 'ObjectExpression' ||
      current.type === 'ArrayExpression'
    ) {
      return includeChain(staticContainerProjection([current], false, true));
    }
    if (
      current.type === 'ConditionalExpression' ||
      current.type === 'LogicalExpression'
    ) {
      const left = staticContainerExpressionValues(
        current.type === 'ConditionalExpression'
          ? current.consequent
          : current.left,
        new Set(seen)
      );
      const right = staticContainerExpressionValues(
        current.type === 'ConditionalExpression'
          ? current.alternate
          : current.right,
        new Set(seen)
      );
      return includeChain(
        staticContainerProjection(
          [...left.values, ...right.values],
          left.opaque ||
            right.opaque ||
            (left.values.length === 0) !== (right.values.length === 0),
          left.present || right.present,
          left.namespaceOpaque || right.namespaceOpaque
        )
      );
    }
    if (current.type === 'MemberExpression') {
      if (chainSeen.has(current)) {
        return includeChain(staticContainerProjection([], true, false, true));
      }
      chainSeen.add(current);
      const selected = staticContainerMemberValues(current, chainSeen);
      const containers = [];
      let opaque = selected.opaque;
      let namespaceOpaque = selected.namespaceOpaque;
      let empty = false;
      for (const value of selected.values) {
        const projected = staticContainerExpressionValues(
          value,
          new Set(chainSeen)
        );
        containers.push(...projected.values);
        opaque ||= projected.opaque;
        namespaceOpaque ||= projected.namespaceOpaque;
        empty ||= projected.values.length === 0;
      }
      return includeChain(
        staticContainerProjection(
          containers,
          opaque || (containers.length > 0 && empty),
          selected.present,
          namespaceOpaque
        )
      );
    }
    if (current.type !== 'Identifier') {
      return includeChain(staticContainerProjection([], true, false));
    }
    const variable = resolveVariable(context, current);
    if (!variable || chainSeen.has(variable)) {
      return includeChain(staticContainerProjection([], true, false));
    }
    const nextSeen = new Set(chainSeen);
    nextSeen.add(variable);
    const sources = staticContainerBindingSources(variable);
    const containers = [];
    let opaque =
      sources.opaque || staticContainerBindingIsOpaque(variable, current);
    let namespaceOpaque = sources.namespaceOpaque;
    let empty = false;
    for (const source of sources.values) {
      const projected = staticContainerExpressionValues(source, nextSeen);
      containers.push(...projected.values);
      opaque ||= projected.opaque;
      namespaceOpaque ||= projected.namespaceOpaque;
      empty ||= projected.values.length === 0;
    }
    return includeChain(
      staticContainerProjection(
        containers,
        opaque || (containers.length > 0 && empty),
        sources.present,
        namespaceOpaque
      )
    );
  };

  return Object.freeze({
    staticContainerExpressionValues,
    staticContainerMemberWriteValues,
  });
}

module.exports = { createStaticContainerExpressionTools };
