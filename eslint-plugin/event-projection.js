'use strict';

const patternIdentifiersCache = new WeakMap();
const patternPropertiesCache = new WeakMap();
const patternElementsCache = new WeakMap();
const arrayExpansionCache = new WeakMap();
const objectExpansionCache = new WeakMap();
const objectSelectionCache = new WeakMap();
const immutableProjectionCache = new WeakMap();
const IN_PROGRESS = Symbol('in-progress');
const MUTABLE = Symbol('mutable');

function projectedValues(values, opaque = false) {
  return Object.freeze({ opaque, values: Object.freeze(values) });
}

function collectPatternIdentifiers(pattern, identifiers) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') {
    identifiers.add(pattern);
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    collectPatternIdentifiers(pattern.left, identifiers);
    return;
  }
  if (pattern.type === 'RestElement') {
    collectPatternIdentifiers(pattern.argument, identifiers);
    return;
  }
  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements) {
      collectPatternIdentifiers(element, identifiers);
    }
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      collectPatternIdentifiers(
        property.type === 'RestElement' ? property.argument : property.value,
        identifiers
      );
    }
  }
}

function patternIdentifiers(pattern) {
  let identifiers = patternIdentifiersCache.get(pattern);
  if (!identifiers) {
    identifiers = new Set();
    collectPatternIdentifiers(pattern, identifiers);
    patternIdentifiersCache.set(pattern, identifiers);
  }
  return identifiers;
}

function patternContainsIdentifier(pattern, target) {
  return !!pattern && patternIdentifiers(pattern).has(target);
}

function selectedPatternProperties(pattern) {
  let selected = patternPropertiesCache.get(pattern);
  if (selected) return selected;
  selected = new WeakMap();
  for (const property of pattern.properties) {
    if (property.type !== 'Property') continue;
    for (const identifier of patternIdentifiers(property.value)) {
      selected.set(identifier, property);
    }
  }
  patternPropertiesCache.set(pattern, selected);
  return selected;
}

function selectedPatternElements(pattern) {
  let selected = patternElementsCache.get(pattern);
  if (selected) return selected;
  selected = new WeakMap();
  for (let index = 0; index < pattern.elements.length; index += 1) {
    const element = pattern.elements[index];
    if (!element) continue;
    for (const identifier of patternIdentifiers(element)) {
      selected.set(identifier, { element, index });
    }
  }
  patternElementsCache.set(pattern, selected);
  return selected;
}

function immutableProjectionContainer(tools, context, source) {
  const current = tools.unwrap(source);
  if (!context || current?.type !== 'Identifier') return current;
  const variable = tools.resolveVariable(context, current);
  if (!variable) return current;
  let perContext = immutableProjectionCache.get(context);
  if (!perContext) {
    perContext = new WeakMap();
    immutableProjectionCache.set(context, perContext);
  }
  if (perContext.has(variable)) {
    const cached = perContext.get(variable);
    return cached === IN_PROGRESS || cached === MUTABLE ? current : cached;
  }
  const stats = tools.analysisStats?.(context);
  if (stats) stats.projectionContainerComputations += 1;
  if (
    variable.references.some(
      (reference) => reference.init !== true && reference.isWrite()
    )
  ) {
    perContext.set(variable, MUTABLE);
    return current;
  }
  perContext.set(variable, IN_PROGRESS);
  const resolved = immutableProjectionContainer(
    tools,
    context,
    tools.bindingInit(variable)
  );
  perContext.set(variable, resolved);
  return resolved;
}

function appendArrayElements(tools, context, array, state) {
  const active = new WeakSet([array]);
  const pending = [{ array, index: 0 }];
  while (pending.length > 0) {
    const frame = pending[pending.length - 1];
    if (frame.index >= frame.array.elements.length) {
      active.delete(frame.array);
      pending.pop();
      continue;
    }
    const element = frame.array.elements[frame.index];
    frame.index += 1;
    if (element?.type !== 'SpreadElement') {
      state.elements.push(element);
      continue;
    }
    const argument = immutableProjectionContainer(
      tools,
      context,
      element.argument
    );
    if (argument?.type !== 'ArrayExpression' || active.has(argument)) {
      if (state.opaqueAt === null) state.opaqueAt = state.elements.length;
      continue;
    }
    active.add(argument);
    pending.push({ array: argument, index: 0 });
  }
}

function expandedArrayElements(tools, array, context = null) {
  let expanded = arrayExpansionCache.get(array);
  if (expanded) return expanded;
  const state = { elements: [], opaqueAt: null };
  appendArrayElements(tools, context, array, state);
  expanded = Object.freeze({
    elements: Object.freeze(state.elements),
    opaqueAt: state.opaqueAt,
  });
  arrayExpansionCache.set(array, expanded);
  return expanded;
}

function appendObjectProperties(tools, context, object, properties) {
  const active = new WeakSet([object]);
  const pending = [{ index: 0, object }];
  while (pending.length > 0) {
    const frame = pending[pending.length - 1];
    if (frame.index >= frame.object.properties.length) {
      active.delete(frame.object);
      pending.pop();
      continue;
    }
    const property = frame.object.properties[frame.index];
    frame.index += 1;
    if (property.type !== 'SpreadElement') {
      properties.push(property);
      continue;
    }
    const argument = immutableProjectionContainer(
      tools,
      context,
      property.argument
    );
    if (argument?.type === 'ObjectExpression' && !active.has(argument)) {
      active.add(argument);
      pending.push({ index: 0, object: argument });
    } else {
      properties.push(property);
    }
  }
}

function expandedObjectProperties(tools, object, context = null) {
  let properties = objectExpansionCache.get(object);
  if (properties) return properties;
  const result = [];
  appendObjectProperties(tools, context, object, result);
  properties = Object.freeze(result);
  objectExpansionCache.set(object, properties);
  return properties;
}

function objectSelections(tools, context, object) {
  let selection = objectSelectionCache.get(object);
  if (selection) return selection;
  const values = new Map();
  let opaqueVersion = 0;
  for (const candidate of expandedObjectProperties(tools, object, context)) {
    if (candidate.type === 'SpreadElement' || candidate.computed) {
      opaqueVersion += 1;
      continue;
    }
    const name = tools.propertyKeyName(candidate);
    if (name === null) continue;
    if (candidate.kind !== 'init' || candidate.method) {
      values.set(name, { opaqueVersion: opaqueVersion + 1, values: [] });
      opaqueVersion += 1;
      continue;
    }
    values.set(name, { opaqueVersion, values: [candidate.value] });
  }
  selection = { opaqueVersion, values };
  objectSelectionCache.set(object, selection);
  return selection;
}

function selectedObjectValue(tools, context, object, name) {
  const selection = objectSelections(tools, context, object);
  const selected = selection.values.get(name);
  return {
    opaque: !selected || selected.opaqueVersion !== selection.opaqueVersion,
    values:
      selected?.opaqueVersion === selection.opaqueVersion
        ? selected.values
        : [],
  };
}

function projectAssignmentPattern(tools, context, pattern, target, source) {
  const primary = projectPatternBinding(
    tools,
    pattern.left,
    target,
    source,
    context
  );
  const fallback = projectPatternBinding(
    tools,
    pattern.left,
    target,
    pattern.right,
    context
  );
  return projectedValues(
    [...primary.values, ...fallback.values],
    primary.opaque || fallback.opaque
  );
}

function projectArrayPattern(tools, context, pattern, target, source) {
  const original = tools.unwrap(source);
  const current = immutableProjectionContainer(tools, context, source);
  if (current?.type !== 'ArrayExpression') return projectedValues([], true);
  const selected = selectedPatternElements(pattern).get(target);
  const index = selected?.index ?? -1;
  const expanded = expandedArrayElements(tools, current, context);
  if (
    index < 0 ||
    (expanded.opaqueAt !== null && expanded.opaqueAt <= index) ||
    index >= expanded.elements.length
  ) {
    return projectedValues([], true);
  }
  const nested = projectPatternBinding(
    tools,
    selected.element,
    target,
    expanded.elements[index],
    context
  );
  return projectedValues(nested.values, original !== current || nested.opaque);
}

function projectObjectPattern(tools, context, pattern, target, source) {
  const original = tools.unwrap(source);
  const current = immutableProjectionContainer(tools, context, source);
  if (current?.type !== 'ObjectExpression') return projectedValues([], true);
  const property = selectedPatternProperties(pattern).get(target);
  if (!property || property.computed) return projectedValues([], true);
  const name = tools.propertyKeyName(property);
  if (name === null) return projectedValues([], true);
  const selected = selectedObjectValue(tools, context, current, name);
  const nested = selected.values.map((value) =>
    projectPatternBinding(tools, property.value, target, value, context)
  );
  return projectedValues(
    nested.flatMap((projection) => projection.values),
    original !== current ||
      selected.opaque ||
      nested.length === 0 ||
      nested.some((projection) => projection.opaque)
  );
}

function projectPatternBinding(tools, pattern, target, source, context = null) {
  if (!pattern || !patternContainsIdentifier(pattern, target)) {
    return projectedValues([], true);
  }
  if (pattern === target) {
    return source ? projectedValues([source]) : projectedValues([], true);
  }
  if (pattern.type === 'AssignmentPattern') {
    return projectAssignmentPattern(tools, context, pattern, target, source);
  }
  if (pattern.type === 'ArrayPattern') {
    return projectArrayPattern(tools, context, pattern, target, source);
  }
  if (pattern.type === 'ObjectPattern') {
    return projectObjectPattern(tools, context, pattern, target, source);
  }
  return projectedValues([], true);
}

function projectReferenceWrite(tools, reference, context = null) {
  const identifier = reference.identifier;
  if (!identifier) {
    return reference.writeExpr
      ? projectedValues([reference.writeExpr])
      : projectedValues([], true);
  }

  let current = identifier;
  for (let parent = current.parent; parent; parent = current.parent) {
    const transparent =
      parent.type === 'AssignmentPattern'
        ? parent.left === current
        : parent.type === 'Property'
          ? parent.value === current
          : parent.type === 'ObjectPattern' ||
            parent.type === 'ArrayPattern' ||
            parent.type === 'RestElement';
    if (transparent) {
      current = parent;
      continue;
    }
    if (
      parent.type === 'AssignmentExpression' &&
      parent.left === current &&
      ['=', '&&=', '||=', '??='].includes(parent.operator)
    ) {
      return projectPatternBinding(
        tools,
        current,
        identifier,
        parent.right,
        context
      );
    }
    break;
  }
  return projectedValues([], true);
}

function createProjectionTools(dependencies) {
  const tools = { ...dependencies };
  return Object.freeze({
    expandedArrayElements: (array, context = null) =>
      expandedArrayElements(tools, array, context),
    expandedObjectProperties: (object, context = null) =>
      expandedObjectProperties(tools, object, context),
    projectPatternBinding: (pattern, target, source, context = null) =>
      projectPatternBinding(tools, pattern, target, source, context),
    projectReferenceWrite: (reference, context = null) =>
      projectReferenceWrite(tools, reference, context),
  });
}

module.exports = { createProjectionTools };
