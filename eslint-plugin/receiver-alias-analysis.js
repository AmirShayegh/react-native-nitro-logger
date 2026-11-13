'use strict';

const OPAQUE_GETTER_VALUE = Object.freeze({
  type: 'NitroOpaqueGetterValue',
});

const getterValueCache = new WeakMap();
const getterReturnValues = new WeakSet();

function appendGetterReturn(values, value) {
  values.push(value);
  getterReturnValues.add(value);
}

function isGetterReturnValue(value) {
  return !!value && getterReturnValues.has(value);
}

function markGetterReturnValue(value) {
  if (value) getterReturnValues.add(value);
  return value;
}

function getterChildNodes(context, node) {
  const children = [];
  const keys = context.sourceCode?.visitorKeys?.[node.type] ?? [];
  for (const key of keys) {
    const value = node[key];
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child.type === 'string') children.push(child);
    }
  }
  return children;
}

function getterReturnIsOpaque(unwrap, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current || seen.has(current)) return true;
  if (
    current.type === 'Literal' ||
    current.type === 'ObjectExpression' ||
    current.type === 'ArrayExpression' ||
    current.type === 'FunctionExpression' ||
    current.type === 'ArrowFunctionExpression' ||
    current.type === 'ClassExpression' ||
    current.type === 'NewExpression' ||
    current.type === 'ThisExpression' ||
    current.type === 'TemplateLiteral' ||
    current.type === 'BinaryExpression' ||
    current.type === 'UnaryExpression' ||
    current.type === 'AwaitExpression' ||
    current.type === 'Identifier' ||
    current.type === 'MemberExpression'
  ) {
    return false;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(current);
  if (
    current.type === 'ConditionalExpression' ||
    current.type === 'LogicalExpression'
  ) {
    const branches =
      current.type === 'ConditionalExpression'
        ? [current.consequent, current.alternate]
        : [current.left, current.right];
    return branches.some((branch) =>
      getterReturnIsOpaque(unwrap, branch, nextSeen)
    );
  }
  if (current.type !== 'CallExpression') return true;
  const callee = unwrap(current.callee);
  return !(
    callee?.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'bind' &&
    !getterReturnIsOpaque(unwrap, callee.object, nextSeen)
  );
}

function receiverGetterValues(context, getter, unwrapNode) {
  const current = unwrapNode(getter);
  if (!current) return Object.freeze([OPAQUE_GETTER_VALUE]);
  const cached = getterValueCache.get(current);
  if (cached) return cached;

  const values = [];
  let opaque = false;
  if (
    current.type === 'ArrowFunctionExpression' &&
    current.body.type !== 'BlockStatement'
  ) {
    appendGetterReturn(values, current.body);
    opaque = getterReturnIsOpaque(unwrapNode, current.body);
  } else if (
    (current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression') &&
    current.body.type === 'BlockStatement'
  ) {
    const pending = [...current.body.body];
    while (pending.length > 0) {
      const statement = pending.pop();
      if (!statement) continue;
      if (statement.type === 'ReturnStatement') {
        if (statement.argument) {
          appendGetterReturn(values, statement.argument);
          opaque ||= getterReturnIsOpaque(unwrapNode, statement.argument);
        } else {
          opaque = true;
        }
        continue;
      }
      if (
        statement.type === 'FunctionDeclaration' ||
        statement.type === 'FunctionExpression' ||
        statement.type === 'ArrowFunctionExpression' ||
        statement.type === 'ClassDeclaration' ||
        statement.type === 'ClassExpression'
      ) {
        continue;
      }
      pending.push(...getterChildNodes(context, statement));
    }
    if (values.length === 0) opaque = true;
  } else {
    opaque = true;
  }
  if (opaque) values.push(OPAQUE_GETTER_VALUE);
  const result = Object.freeze([...new Set(values)]);
  getterValueCache.set(current, result);
  return result;
}

function createReceiverAliasTools(dependencies) {
  const {
    analysisStats,
    bindingInit,
    contextWeakCache,
    expandedArrayElements,
    expandedObjectProperties,
    projectPatternBinding,
    projectReferenceWrite,
    propertyKeyName,
    resolveReceiverObject,
    resolveVariable,
    singleDef,
    staticPropertyName,
    unwrap,
  } = dependencies;
  const receiverAnalysisStats = Object.freeze({ get: analysisStats });
  const receiverAliasComponentCache = new WeakMap();
  const memberExtractionIndexCache = new WeakMap();
  const arrayElementIndexCache = new WeakMap();

  const aliasProjectionCache = new WeakMap();
  const objectValueIndexCache = new WeakMap();

  function addAliasProjection(projection, source, target) {
    const current = unwrap(source);
    if (!current) return;
    let targets = projection.get(current);
    if (!targets) {
      targets = [];
      projection.set(current, targets);
    }
    targets.push(target);
  }

  function indexObjectValues(object, context = null) {
    const values = new Map();
    let opaqueVersion = 0;
    for (const property of expandedObjectProperties(object, context)) {
      if (property.type === 'SpreadElement' || property.computed) {
        opaqueVersion += 1;
        continue;
      }
      const name = propertyKeyName(property);
      if (name === null) continue;
      const selectedValues =
        property.kind === 'get'
          ? receiverGetterValues(context, property.value, unwrap, property)
          : [property.value];
      values.set(name, {
        opaqueVersion,
        value:
          selectedValues.length === 1 &&
          (property.kind === 'get' || !property.method)
            ? selectedValues[0]
            : null,
        values: Object.freeze(selectedValues),
      });
    }
    return { opaqueVersion, values };
  }

  function cachedObjectValueIndex(object, context = null) {
    let index = objectValueIndexCache.get(object);
    if (!index) {
      const stats = context ? receiverAnalysisStats.get(context) : null;
      if (stats) stats.receiverObjectIndexComputations += 1;
      index = indexObjectValues(object, context);
      objectValueIndexCache.set(object, index);
    }
    return index;
  }

  function indexedObjectValue(index, name) {
    const selected = index.values.get(name);
    return selected?.opaqueVersion === index.opaqueVersion && selected.value
      ? selected.value
      : null;
  }

  function mapAliasProjection(context, pattern, source, projection) {
    if (!pattern || !source) return;
    if (pattern.type === 'Identifier') {
      addAliasProjection(projection, source, pattern);
      const current = unwrap(source);
      if (current?.type === 'ConditionalExpression') {
        mapAliasProjection(context, pattern, current.consequent, projection);
        mapAliasProjection(context, pattern, current.alternate, projection);
      } else if (current?.type === 'LogicalExpression') {
        mapAliasProjection(context, pattern, current.left, projection);
        mapAliasProjection(context, pattern, current.right, projection);
      }
      return;
    }
    if (pattern.type === 'AssignmentPattern') {
      mapAliasProjection(context, pattern.left, source, projection);
      return;
    }
    const current = unwrap(source);
    if (
      pattern.type === 'ArrayPattern' &&
      current?.type === 'ArrayExpression'
    ) {
      const expanded = expandedArrayElements(current, context);
      for (let index = 0; index < pattern.elements.length; index += 1) {
        if (expanded.opaqueAt !== null && expanded.opaqueAt <= index) break;
        const value = expanded.elements[index];
        mapAliasProjection(context, pattern.elements[index], value, projection);
      }
      return;
    }
    if (
      pattern.type !== 'ObjectPattern' ||
      current?.type !== 'ObjectExpression'
    ) {
      return;
    }
    const index = cachedObjectValueIndex(current, context);
    for (const property of pattern.properties) {
      if (property.type !== 'Property' || property.computed) continue;
      const name = propertyKeyName(property);
      if (name === null) continue;
      const value = indexedObjectValue(index, name);
      if (value) mapAliasProjection(context, property.value, value, projection);
    }
  }

  function projectedAliasTargets(context, pattern, source, identifier) {
    const current = unwrap(source);
    if (!current) return [];
    let perPattern = aliasProjectionCache.get(current);
    if (!perPattern) {
      perPattern = new WeakMap();
      aliasProjectionCache.set(current, perPattern);
    }
    let projection = perPattern.get(pattern);
    if (!projection) {
      projection = new WeakMap();
      mapAliasProjection(context, pattern, source, projection);
      perPattern.set(pattern, projection);
    }
    return projection.get(unwrap(identifier)) ?? [];
  }

  function receiverAliasTargetsFromExpression(
    context,
    expression,
    projectedNode
  ) {
    for (;;) {
      const parent = expression.parent;
      if (!parent) return [];
      if (parent.type === 'VariableDeclarator' && parent.init === expression) {
        return projectedAliasTargets(
          context,
          parent.id,
          parent.init,
          projectedNode
        );
      }
      if (
        parent.type === 'AssignmentExpression' &&
        ['=', '&&=', '||=', '??='].includes(parent.operator) &&
        parent.right === expression
      ) {
        return projectedAliasTargets(
          context,
          parent.left,
          parent.right,
          projectedNode
        );
      }
      const container =
        parent.type === 'ArrayExpression' ||
        parent.type === 'ObjectExpression' ||
        parent.type === 'ConditionalExpression' ||
        parent.type === 'LogicalExpression' ||
        (parent.type === 'SpreadElement' && parent.argument === expression) ||
        (parent.type === 'Property' && parent.value === expression) ||
        unwrap(parent) === expression;
      if (!container) return [];
      expression = parent;
    }
  }

  function arrayElementIndex(context, array, value) {
    let indexes = arrayElementIndexCache.get(array);
    if (!indexes) {
      const stats = receiverAnalysisStats.get(context);
      if (stats) stats.arrayElementIndexComputations += 1;
      indexes = new WeakMap();
      array.elements.forEach((element, index) => {
        if (element) indexes.set(element, index);
      });
      arrayElementIndexCache.set(array, indexes);
    }
    return indexes.get(value) ?? -1;
  }

  function extractionPath(context, identifier) {
    const path = [];
    let value = identifier;
    for (;;) {
      const parent = value?.parent;
      const object = parent?.parent;
      if (
        parent?.type === 'Property' &&
        parent.value === value &&
        !parent.computed &&
        object?.type === 'ObjectExpression'
      ) {
        const name = propertyKeyName(parent);
        if (name === null) return null;
        path.unshift(name);
        value = object;
        continue;
      }
      if (parent?.type === 'ArrayExpression') {
        const index = arrayElementIndex(context, parent, value);
        if (index < 0) return null;
        path.unshift(String(index));
        value = parent;
        continue;
      }
      break;
    }
    const declarator = value?.parent;
    return path.length > 0 &&
      declarator?.type === 'VariableDeclarator' &&
      declarator.init === value &&
      declarator.id.type === 'Identifier'
      ? { declarator, path }
      : null;
  }

  function memberAssignmentExtraction(context, identifier) {
    const assignment = identifier.parent;
    if (
      assignment?.type !== 'AssignmentExpression' ||
      assignment.operator !== '=' ||
      assignment.right !== identifier
    ) {
      return null;
    }
    const path = [];
    let current = unwrap(assignment.left);
    while (current?.type === 'MemberExpression') {
      const name = staticPropertyName(context, current);
      if (name === null) return null;
      path.unshift(name);
      current = unwrap(current.object);
    }
    if (current?.type !== 'Identifier' || path.length === 0) return null;
    const holder = resolveVariable(context, current);
    return holder ? { holder, path } : null;
  }

  function appendExtraction(index, path, value) {
    const key = JSON.stringify(path);
    let values = index.get(key);
    if (!values) {
      values = [];
      index.set(key, values);
    }
    values.push(value);
  }

  function patternTargets(pattern, path = [], targets = []) {
    let current = pattern;
    if (current?.type === 'AssignmentPattern') current = current.left;
    if (current?.type === 'Identifier') {
      targets.push({ path, target: current });
      return targets;
    }
    if (current?.type === 'ObjectPattern') {
      for (const property of current.properties) {
        if (property.type !== 'Property' || property.computed) continue;
        const name = propertyKeyName(property);
        if (name !== null) {
          patternTargets(property.value, [...path, name], targets);
        }
      }
    } else if (current?.type === 'ArrayPattern') {
      current.elements.forEach((element, index) => {
        if (element) {
          patternTargets(element, [...path, String(index)], targets);
        }
      });
    }
    return targets;
  }

  function indexNamedSpreadTargets(context, identifier, targets) {
    const spread = identifier.parent;
    const container = spread?.type === 'SpreadElement' ? spread.parent : null;
    const declarator = container?.parent;
    if (
      !container ||
      declarator?.type !== 'VariableDeclarator' ||
      declarator.init !== container
    ) {
      return;
    }
    if (container.type === 'ObjectExpression') {
      for (const entry of patternTargets(declarator.id)) {
        appendExtraction(targets, entry.path, entry.target);
      }
      return;
    }
    if (container.type !== 'ArrayExpression') return;
    const variable = resolveVariable(context, identifier);
    const source = unwrap(variable ? bindingInit(variable) : null);
    if (source?.type !== 'ArrayExpression') return;
    const inner = expandedArrayElements(source, context).elements;
    const outer = expandedArrayElements(container, context).elements;
    const pattern = patternTargets(declarator.id);
    const stats = receiverAnalysisStats.get(context);
    const outerIndexes = new Map();
    outer.forEach((value, index) => {
      if (stats) stats.memberSpreadJoinVisits += 1;
      if (!outerIndexes.has(value)) outerIndexes.set(value, index);
    });
    const patternByOuterIndex = new Map();
    for (const entry of pattern) {
      if (stats) stats.memberSpreadJoinVisits += 1;
      const index = entry.path[0];
      let entries = patternByOuterIndex.get(index);
      if (!entries) {
        entries = [];
        patternByOuterIndex.set(index, entries);
      }
      entries.push(entry);
    }
    inner.forEach((value, innerIndex) => {
      if (stats) stats.memberSpreadJoinVisits += 1;
      const outerIndex = outerIndexes.get(value);
      if (outerIndex === undefined) return;
      for (const entry of patternByOuterIndex.get(String(outerIndex)) ?? []) {
        if (stats) stats.memberSpreadJoinVisits += 1;
        appendExtraction(
          targets,
          [String(innerIndex), ...entry.path.slice(1)],
          entry.target
        );
      }
    });
  }

  function indexDestructuredTargets(context, identifier, targets) {
    const parent = identifier.parent;
    if (parent?.type === 'VariableDeclarator' && parent.init === identifier) {
      for (const entry of patternTargets(parent.id)) {
        appendExtraction(targets, entry.path, entry.target);
      }
      return;
    }
    if (
      parent?.type === 'AssignmentExpression' &&
      parent.operator === '=' &&
      parent.right === identifier
    ) {
      for (const entry of patternTargets(parent.left)) {
        appendExtraction(targets, entry.path, entry.target);
      }
      return;
    }
    indexNamedSpreadTargets(context, identifier, targets);
  }

  function receiverMemberPaths(context, identifier) {
    const members = [];
    const path = [];
    let expression = identifier;
    for (;;) {
      const member = expression.parent;
      if (member?.type !== 'MemberExpression' || member.object !== expression) {
        return members;
      }
      const name = staticPropertyName(context, member);
      if (name === null) return members;
      path.push(name);
      members.push({ member, path: [...path] });
      expression = member;
    }
  }

  function memberExtractionIndex(context, holder) {
    const perContext = contextWeakCache(memberExtractionIndexCache, context);
    const cached = perContext.get(holder);
    if (cached) return cached;
    const stats = receiverAnalysisStats.get(context);
    if (stats) stats.memberExtractionIndexComputations += 1;
    const members = new Map();
    const targets = new Map();
    for (const reference of holder.references) {
      indexDestructuredTargets(context, reference.identifier, targets);
      for (const entry of receiverMemberPaths(context, reference.identifier)) {
        appendExtraction(members, entry.path, entry.member);
        for (const target of receiverAliasTargetsFromExpression(
          context,
          entry.member,
          entry.member
        )) {
          appendExtraction(targets, entry.path, target);
        }
      }
    }
    for (const values of members.values()) Object.freeze(values);
    for (const values of targets.values()) Object.freeze(values);
    const result = Object.freeze({ members, targets });
    perContext.set(holder, result);
    return result;
  }

  function cachedExtractionTargets(context, holder, path) {
    return (
      memberExtractionIndex(context, holder).targets.get(
        JSON.stringify(path)
      ) ?? []
    );
  }

  function cachedExtractionMembers(context, holder, path) {
    return (
      memberExtractionIndex(context, holder).members.get(
        JSON.stringify(path)
      ) ?? []
    );
  }

  function memberExtractionReferences(context, identifier) {
    const extraction = extractionPath(context, identifier);
    const assigned = extraction
      ? null
      : memberAssignmentExtraction(context, identifier);
    const holder = extraction
      ? resolveVariable(context, extraction.declarator.id)
      : assigned?.holder;
    const path = extraction?.path ?? assigned?.path;
    return holder ? cachedExtractionMembers(context, holder, path) : [];
  }

  function memberExtractionAliasTargets(context, identifier) {
    const extraction = extractionPath(context, identifier);
    if (!extraction) return [];
    const holder = resolveVariable(context, extraction.declarator.id);
    return holder
      ? cachedExtractionTargets(context, holder, extraction.path)
      : [];
  }

  function receiverAliasTargets(context, identifier) {
    if (!identifier) return [];
    return [
      ...receiverAliasTargetsFromExpression(context, identifier, identifier),
      ...memberExtractionAliasTargets(context, identifier),
    ];
  }

  function graphClosure(root, adjacent) {
    const visited = new Set();
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of adjacent(current)) pending.push(next);
    }
    return Object.freeze([...visited]);
  }

  function receiverAliasVariablesFromValue(context, node, seen = new Set()) {
    const current = unwrap(node);
    if (!current || seen.has(current)) return [];
    if (current.type === 'Identifier') {
      const variable = resolveVariable(context, current);
      return variable ? [variable] : [];
    }
    if (current.type === 'ConditionalExpression') {
      return [
        ...receiverAliasVariablesFromValue(context, current.consequent, seen),
        ...receiverAliasVariablesFromValue(context, current.alternate, seen),
      ];
    }
    if (current.type === 'LogicalExpression') {
      return [
        ...receiverAliasVariablesFromValue(context, current.left, seen),
        ...receiverAliasVariablesFromValue(context, current.right, seen),
      ];
    }
    if (current.type !== 'MemberExpression') return [];
    const values = receiverAliasMemberValues(context, current, seen);
    return values.flatMap((value) =>
      receiverAliasVariablesFromValue(
        context,
        value,
        new Set([...seen, current])
      )
    );
  }

  function receiverAliasObjects(context, node, seen) {
    const object = resolveReceiverObject(context, node);
    if (object) return [object];
    const current = unwrap(node);
    if (current?.type !== 'MemberExpression') return [];
    return receiverAliasMemberValues(context, current, seen).flatMap(
      (value) => {
        const candidate = resolveReceiverObject(context, value);
        return candidate ? [candidate] : [];
      }
    );
  }

  function receiverAliasMemberValues(context, current, seen = new Set()) {
    if (seen.has(current)) return [];
    const name = staticPropertyName(context, current);
    if (name === null) return [];
    const nextSeen = new Set(seen);
    nextSeen.add(current);
    return receiverAliasObjects(context, current.object, nextSeen).flatMap(
      (object) =>
        receiverObjectPropertyValues(object, current, name, true, context)
    );
  }

  function receiverAliasSources(context, variable) {
    const sources = [];
    const def = singleDef(variable);
    if (def?.type === 'Variable' && def.node.init) {
      const projection = projectPatternBinding(
        def.node.id,
        def.name,
        def.node.init,
        context
      );
      for (const value of projection.values) {
        sources.push(...receiverAliasVariablesFromValue(context, value));
      }
    }
    for (const reference of variable.references) {
      if (reference.init === true || !reference.isWrite()) continue;
      const projection = projectReferenceWrite(reference, context);
      for (const projected of projection.values) {
        sources.push(...receiverAliasVariablesFromValue(context, projected));
      }
    }
    return sources;
  }

  function receiverAliasNeighbors(context, variable) {
    const neighbors = receiverAliasSources(context, variable);
    for (const reference of variable.references) {
      for (const target of receiverAliasTargets(
        context,
        reference.identifier
      )) {
        const alias = resolveVariable(context, target);
        if (alias) neighbors.push(alias);
      }
    }
    return neighbors;
  }

  function receiverAliasComponent(context, variable) {
    const perContext = contextWeakCache(receiverAliasComponentCache, context);
    const cached = perContext.get(variable);
    if (cached) return cached;
    const component = graphClosure(variable, (current) =>
      receiverAliasNeighbors(context, current)
    );
    for (const member of component) perContext.set(member, component);
    return component;
  }

  function receiverObjectPropertyValues(
    object,
    opaqueNode,
    name,
    opaqueWhenMissing = true,
    context = null
  ) {
    if (!object) return opaqueWhenMissing ? [opaqueNode] : [];
    const index = cachedObjectValueIndex(object, context);
    const selected = index.values.get(name);
    if (selected?.opaqueVersion === index.opaqueVersion) {
      return selected.values?.length > 0
        ? [...selected.values]
        : selected.value
          ? [selected.value]
          : [opaqueNode];
    }
    return index.opaqueVersion > (selected?.opaqueVersion ?? 0)
      ? [opaqueNode]
      : [];
  }

  return Object.freeze({
    OPAQUE_GETTER_VALUE,
    cachedObjectValueIndex,
    graphClosure,
    memberExtractionReferences,
    receiverAliasComponent,
    receiverGetterValues: (context, getter) =>
      receiverGetterValues(context, getter, unwrap),
    receiverObjectPropertyValues,
  });
}

module.exports = {
  OPAQUE_GETTER_VALUE,
  createReceiverAliasTools,
  isGetterReturnValue,
  markGetterReturnValue,
  receiverGetterValues,
};
