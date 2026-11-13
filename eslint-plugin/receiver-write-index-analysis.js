'use strict';

function createReceiverWriteIndexTools(dependencies) {
  const {
    aliasTools,
    analysisStats,
    bindingReplacementReferences,
    builtinTools,
    contextKeyedMap,
    contextWeakCache,
    isNamespaceMethod,
    resolveReceiverObject,
    resolveVariable,
    staticPropertyName,
    unwrap,
  } = dependencies;
  const {
    OPAQUE_GETTER_VALUE,
    memberExtractionReferences,
    receiverAliasComponent,
    receiverObjectPropertyValues,
  } = aliasTools;
  const { builtinReceiverPropertyWrites, objectAssignReceiverPropertyWrites } =
    builtinTools;

  const receiverWriteIndexCache = new WeakMap();
  const receiverMutableSourceCache = new WeakMap();
  const receiverMutationIndexCache = new WeakMap();

  function receiverWrite(gate, values) {
    return Object.freeze({ gate, values: Object.freeze(values) });
  }

  function appendReceiverWrite(index, name, write) {
    let writes = index.get(name);
    if (!writes) {
      writes = [];
      index.set(name, writes);
    }
    writes.push(write);
  }

  function receiverReferenceExpression(identifier) {
    let expression = identifier;
    while (expression.parent && unwrap(expression.parent) === identifier) {
      expression = expression.parent;
    }
    return expression;
  }

  function writeTargetGate(node) {
    let current = node;
    for (let parent = current.parent; parent; parent = current.parent) {
      if (parent.type === 'AssignmentExpression') {
        return parent.left === current ? parent : null;
      }
      if (
        parent.type === 'ForOfStatement' ||
        parent.type === 'ForInStatement'
      ) {
        return parent.left === current ? parent : null;
      }
      if (parent.type === 'UpdateExpression') {
        return parent.argument === current ? parent : null;
      }
      if (parent.type === 'UnaryExpression') {
        return parent.operator === 'delete' && parent.argument === current
          ? parent
          : null;
      }
      const transparent =
        parent.type === 'AssignmentPattern'
          ? parent.left === current
          : parent.type === 'Property'
            ? parent.value === current
            : parent.type === 'ObjectPattern' ||
              parent.type === 'ArrayPattern' ||
              parent.type === 'RestElement' ||
              unwrap(parent) === current;
      if (!transparent) return null;
      current = parent;
    }
    return null;
  }

  function directReceiverWrite(context, identifier, name, includeComplex) {
    const expression = receiverReferenceExpression(identifier);
    const member = expression.parent;
    if (
      member?.type !== 'MemberExpression' ||
      member.object !== expression ||
      staticPropertyName(context, member) !== name
    ) {
      return null;
    }
    const assignment = member.parent;
    if (
      assignment?.type === 'AssignmentExpression' &&
      assignment.left === member
    ) {
      return receiverWrite(assignment, [assignment.right]);
    }
    if (!includeComplex) return null;
    const gate = writeTargetGate(member);
    return gate ? receiverWrite(gate, [member]) : null;
  }

  function indexObjectAssignCall(context, index, call) {
    const extracted = objectAssignReceiverPropertyWrites(
      context,
      call,
      replacementPropertyValues
    );
    for (const write of extracted.writes) {
      appendReceiverWrite(
        index.base,
        write.name,
        receiverWrite(call, write.baseValues)
      );
      appendReceiverWrite(
        index.complex,
        write.name,
        receiverWrite(call, write.complexValues)
      );
    }
    if (extracted.opaque) {
      const write = receiverWrite(call, [call]);
      index.baseWildcard.push(write);
      index.complexWildcard.push(write);
    }
    return true;
  }

  function indexBuiltinReceiverWrite(context, index, expression) {
    const builtins = builtinReceiverPropertyWrites(context, expression);
    for (const builtin of builtins) {
      const write = receiverWrite(builtin.call, builtin.values);
      if (builtin.name === null) {
        index.baseWildcard.push(write);
        index.complexWildcard.push(write);
      } else {
        appendReceiverWrite(index.base, builtin.name, write);
        appendReceiverWrite(index.complex, builtin.name, write);
      }
    }
    return builtins.length > 0;
  }

  function indexReceiverReference(context, index, identifier) {
    const expression = receiverReferenceExpression(identifier);
    const call = expression.parent;
    if (
      call?.type === 'CallExpression' &&
      call.arguments[0] === expression &&
      isNamespaceMethod(context, call, 'Object', 'assign')
    ) {
      indexObjectAssignCall(context, index, call);
    }
    indexBuiltinReceiverWrite(context, index, expression);
    const member = expression.parent;
    if (member?.type !== 'MemberExpression' || member.object !== expression) {
      return;
    }
    const name = staticPropertyName(context, member);
    if (name === null) {
      const assignment = member.parent;
      if (
        assignment?.type === 'AssignmentExpression' &&
        assignment.left === member
      ) {
        const write = receiverWrite(assignment, [assignment.right]);
        index.baseWildcard.push(write);
        index.complexWildcard.push(write);
        return;
      }
      const gate = writeTargetGate(member);
      if (gate) index.complexWildcard.push(receiverWrite(gate, [member]));
      return;
    }
    const base = directReceiverWrite(context, identifier, name, false);
    if (base) appendReceiverWrite(index.base, name, base);
    const complex = directReceiverWrite(context, identifier, name, true);
    if (complex) appendReceiverWrite(index.complex, name, complex);
  }

  function receiverWriteIndex(context, component) {
    const perContext = contextWeakCache(receiverWriteIndexCache, context);
    const cached = perContext.get(component[0]);
    if (cached) return cached;
    const stats = analysisStats(context);
    if (stats) stats.receiverWriteIndexComputations += 1;
    const index = {
      base: new Map(),
      baseWildcard: [],
      complex: new Map(),
      complexWildcard: [],
    };
    for (const variable of component) {
      for (const reference of variable.references) {
        indexReceiverReference(context, index, reference.identifier);
        for (const member of memberExtractionReferences(
          context,
          reference.identifier
        )) {
          indexReceiverReference(context, index, member);
        }
      }
    }
    for (const member of component) perContext.set(member, index);
    return index;
  }

  function indexedReceiverWrites(context, component, name, includeComplex) {
    const index = receiverWriteIndex(context, component);
    const writes = [
      ...((includeComplex ? index.complex : index.base).get(name) ?? []),
      ...(includeComplex ? [] : index.baseWildcard),
    ];
    return Object.freeze(writes);
  }

  function indexReceiverMutationReference(context, index, reference) {
    const stats = analysisStats(context);
    if (stats) stats.receiverMutationReferenceVisits += 1;
    const identifier = reference.identifier;
    const expression = receiverReferenceExpression(identifier);
    const call = expression.parent;
    if (
      call?.type === 'CallExpression' &&
      call.arguments[0] === expression &&
      (isNamespaceMethod(context, call, 'Object', 'assign') ||
        builtinReceiverPropertyWrites(context, expression).length > 0)
    ) {
      index.wildcard = true;
      return;
    }
    const member = expression.parent;
    if (member?.type !== 'MemberExpression' || member.object !== expression) {
      return;
    }
    const name = staticPropertyName(context, member);
    if (name === null) {
      if (writeTargetGate(member)) index.wildcard = true;
    } else if (directReceiverWrite(context, identifier, name, true)) {
      index.names.add(name);
    }
  }

  function receiverMutationIndex(context, component) {
    const perContext = contextWeakCache(receiverMutationIndexCache, context);
    const cached = perContext.get(component[0]);
    if (cached) return cached;
    const index = { names: new Set(), wildcard: false };
    for (const member of component) {
      for (const reference of member.references) {
        indexReceiverMutationReference(context, index, reference);
      }
    }
    for (const member of component) perContext.set(member, index);
    return index;
  }

  function componentMutatesReceiver(context, component, name) {
    const index = receiverMutationIndex(context, component);
    return index.wildcard || index.names.has(name);
  }

  function mutableReceiverSource(context, node, name) {
    const current = unwrap(node);
    if (current?.type !== 'Identifier') return false;
    const variable = resolveVariable(context, current);
    if (!variable) return false;
    const perVariable = contextKeyedMap(
      receiverMutableSourceCache,
      context,
      variable
    );
    if (perVariable.has(name)) return perVariable.get(name);

    const rebound = bindingReplacementReferences(context, variable).length > 0;
    const mutable =
      rebound ||
      componentMutatesReceiver(
        context,
        receiverAliasComponent(context, variable),
        name
      );
    perVariable.set(name, mutable);
    return mutable;
  }

  function replacementPropertyValues(context, node, name) {
    if (mutableReceiverSource(context, node, name)) {
      return [OPAQUE_GETTER_VALUE];
    }
    const object = resolveReceiverObject(context, node);
    return receiverObjectPropertyValues(object, node, name, true, context);
  }

  return Object.freeze({
    appendReceiverWrite,
    indexedReceiverWrites,
    receiverWrite,
    receiverWriteIndex,
    replacementPropertyValues,
  });
}

module.exports = { createReceiverWriteIndexTools };
