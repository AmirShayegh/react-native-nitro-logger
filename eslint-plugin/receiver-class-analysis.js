'use strict';

const { markGetterReturnValue } = require('./receiver-alias-analysis');

const classReceiverCandidateCache = new WeakMap();
const classAliasValueCache = new WeakMap();
const classReceiverIdentityCache = new WeakMap();
const CLASS_IDENTITY_IN_PROGRESS = Symbol('in-progress');
const OPAQUE_CLASS_GETTER = Symbol('opaque-class-getter');

function classElementName(element) {
  if (element.computed) return null;
  const key = element.key;
  if (key?.type === 'Identifier' || key?.type === 'PrivateIdentifier') {
    return key.name;
  }
  return key?.type === 'Literal' ? String(key.value) : null;
}

function enclosingClassBody(node) {
  for (let current = node; current; current = current.parent) {
    if (current.type === 'ClassBody') return current;
  }
  return null;
}

function enclosingClassElement(node, body) {
  let current = node;
  while (current?.parent && current.parent !== body) current = current.parent;
  return current?.parent === body ? current : null;
}

function classElementIsStatic(element) {
  return element?.type === 'StaticBlock' || element?.static === true;
}

function classElementChildren(context, node) {
  const children = [];
  const keys = context.sourceCode?.visitorKeys?.[node.type] ?? [];
  for (const key of keys) {
    const value = node[key];
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (candidate) children.push(candidate);
    }
  }
  return children;
}

function walkClassElement(context, root, visit) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    visit(current);
    if (current !== root && current.type === 'ClassBody') continue;
    pending.push(...classElementChildren(context, current));
  }
}

function addClassCandidate(index, isStatic, name, value) {
  if (name === null || !value) return;
  const key = `${isStatic ? '1' : '0'}\u0000${name}`;
  let candidates = index.get(key);
  if (!candidates) {
    candidates = [];
    index.set(key, candidates);
  }
  candidates.push(value);
}

function indexParameterProperties(index, element) {
  if (element.type !== 'MethodDefinition' || element.kind !== 'constructor') {
    return;
  }
  for (const parameter of element.value.params) {
    if (parameter.type !== 'TSParameterProperty') continue;
    const value = parameter.parameter;
    const target = value.type === 'AssignmentPattern' ? value.left : value;
    if (target.type === 'Identifier' && value.type === 'AssignmentPattern') {
      addClassCandidate(index, false, target.name, value.right);
    }
  }
}

function getterReturnIsOpaque(tools, context, node, seen = new Set()) {
  const current = tools.unwrap(node);
  if (!current || seen.has(current)) return true;
  const nextSeen = new Set(seen);
  nextSeen.add(current);
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
  if (
    current.type === 'ConditionalExpression' ||
    current.type === 'LogicalExpression'
  ) {
    const branches =
      current.type === 'ConditionalExpression'
        ? [current.consequent, current.alternate]
        : [current.left, current.right];
    return branches.some((branch) =>
      getterReturnIsOpaque(tools, context, branch, nextSeen)
    );
  }
  if (current.type !== 'CallExpression') return true;
  if (tools.isPoisonedIdentityWrapper(context, current)) return true;
  const identity = tools.identityWrappedValue(context, current);
  if (identity) {
    return getterReturnIsOpaque(tools, context, identity, nextSeen);
  }
  const callee = tools.unwrap(current.callee);
  return !(
    callee?.type === 'MemberExpression' &&
    tools.staticPropertyName(context, callee) === 'bind' &&
    !getterReturnIsOpaque(tools, context, callee.object, nextSeen)
  );
}

function getterCandidates(tools, context, element) {
  const getter = element.value;
  if (getter?.body?.type !== 'BlockStatement') {
    return { opaque: true, values: [] };
  }
  const values = [];
  let opaque = false;
  const pending = [...getter.body.body];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    if (current.type === 'ReturnStatement') {
      if (current.argument) {
        values.push(markGetterReturnValue(current.argument));
        opaque ||= getterReturnIsOpaque(tools, context, current.argument);
      }
      continue;
    }
    if (
      current.type === 'FunctionDeclaration' ||
      current.type === 'FunctionExpression' ||
      current.type === 'ArrowFunctionExpression' ||
      current.type === 'ClassDeclaration' ||
      current.type === 'ClassExpression'
    ) {
      continue;
    }
    for (const child of classElementChildren(context, current)) {
      pending.push(child);
    }
  }
  return { opaque, values };
}

function collectClassReceiverCandidates(tools, context, body) {
  const index = new Map();
  for (const element of body.body) {
    const elementStatic = classElementIsStatic(element);
    indexParameterProperties(index, element);
    if (element.type === 'MethodDefinition' && element.kind === 'get') {
      const name = classElementName(element);
      const getter = getterCandidates(tools, context, element);
      for (const value of getter.values) {
        addClassCandidate(index, elementStatic, name, value);
      }
      if (getter.opaque) {
        addClassCandidate(index, elementStatic, name, OPAQUE_CLASS_GETTER);
      }
    }
    if (
      (element.type === 'PropertyDefinition' ||
        element.type === 'FieldDefinition' ||
        element.type === 'AccessorProperty') &&
      element.value
    ) {
      addClassCandidate(
        index,
        elementStatic,
        classElementName(element),
        element.value
      );
    }
    walkClassElement(context, element, (candidate) => {
      if (candidate.type !== 'AssignmentExpression') return;
      const left = tools.unwrap(candidate.left);
      if (left?.type !== 'MemberExpression') return;
      const identity = classReceiverIdentity(tools, context, left.object);
      if (identity?.body !== body) return;
      addClassCandidate(
        index,
        identity.isStatic,
        tools.staticPropertyName(context, left),
        candidate.right
      );
    });
  }
  for (const [key, candidates] of index) {
    index.set(key, Object.freeze(candidates));
  }
  return index;
}

function classCandidateCache(tools, context, body) {
  const perContext = tools.contextWeakCache(
    classReceiverCandidateCache,
    context
  );
  let index = perContext.get(body);
  if (!index) {
    const stats = tools.analysisStats(context);
    if (stats) stats.classCandidateIndexComputations += 1;
    index = collectClassReceiverCandidates(tools, context, body);
    perContext.set(body, index);
  }
  return index;
}

function classAliasValues(tools, context, variable) {
  const cache = tools.contextWeakCache(classAliasValueCache, context);
  const cached = cache.get(variable);
  if (cached) return cached;
  const stats = tools.analysisStats(context);
  if (stats) stats.classAliasValueComputations += 1;
  const def = tools.singleDef(variable);
  if (!def || def.type !== 'Variable') return [];
  const values = [];
  if (def.node.init) {
    values.push(
      ...tools.projectPatternBinding(
        def.node.id,
        def.name ?? def.node.id,
        def.node.init,
        context
      ).values
    );
  }
  for (const reference of variable.references) {
    if (reference.init === true || !reference.isWrite()) continue;
    values.push(...tools.projectReferenceWrite(reference, context).values);
  }
  const result = Object.freeze(values);
  cache.set(variable, result);
  return result;
}

function branchedClassReceiverIdentity(tools, context, current, body, seen) {
  const branches =
    current.type === 'ConditionalExpression'
      ? [current.consequent, current.alternate]
      : current.type === 'LogicalExpression'
        ? [current.left, current.right]
        : [];
  for (const branch of branches) {
    const identity = classReceiverIdentity(tools, context, branch, seen);
    if (identity?.body === body) return identity;
  }
  return null;
}

function classReceiverIdentity(tools, context, node, seen = new Set()) {
  const current = tools.unwrap(node);
  if (!current) return null;
  const body = enclosingClassBody(current);
  if (!body) return null;
  if (tools.isPoisonedIdentityWrapper(context, current)) {
    return {
      body,
      isStatic: classElementIsStatic(enclosingClassElement(current, body)),
    };
  }
  const identityValue = tools.identityWrappedValue(context, current);
  if (identityValue) {
    return classReceiverIdentity(tools, context, identityValue, seen);
  }
  const branched = branchedClassReceiverIdentity(
    tools,
    context,
    current,
    body,
    seen
  );
  if (branched) return branched;
  if (current.type === 'Identifier') {
    const classNode = body.parent;
    if (classNode?.id?.type === 'Identifier') {
      const receiver = tools.resolveVariable(context, current);
      const classBinding = tools.resolveVariable(context, classNode.id);
      if (receiver && receiver === classBinding) {
        return { body, isStatic: true };
      }
    }
    const variable = tools.resolveVariable(context, current);
    if (!variable || seen.has(variable)) return null;
    const perContext = tools.contextWeakCache(
      classReceiverIdentityCache,
      context
    );
    let perBody = perContext.get(variable);
    if (!perBody) {
      perBody = new WeakMap();
      perContext.set(variable, perBody);
    }
    if (perBody.has(body)) {
      const cached = perBody.get(body);
      return cached === CLASS_IDENTITY_IN_PROGRESS ? null : cached;
    }
    const stats = tools.analysisStats(context);
    if (stats) stats.classIdentityComputations += 1;
    perBody.set(body, CLASS_IDENTITY_IN_PROGRESS);
    seen.add(variable);
    let result = null;
    try {
      for (const value of classAliasValues(tools, context, variable)) {
        const identity = classReceiverIdentity(tools, context, value, seen);
        if (identity?.body === body) {
          result = identity;
          break;
        }
      }
    } finally {
      seen.delete(variable);
    }
    perBody.set(body, result);
    return result;
  }
  if (current.type !== 'ThisExpression') return null;
  const element = enclosingClassElement(current, body);
  return { body, isStatic: classElementIsStatic(element) };
}

function classReceiverCandidates(tools, context, node, name) {
  const identity = classReceiverIdentity(tools, context, node);
  if (!identity) return [];
  const cache = classCandidateCache(tools, context, identity.body);
  const key = `${identity.isStatic ? '1' : '0'}\u0000${name}`;
  const candidates = cache.get(key) ?? Object.freeze([]);
  return candidates.includes(OPAQUE_CLASS_GETTER)
    ? Object.freeze(
        candidates.map((candidate) =>
          candidate === OPAQUE_CLASS_GETTER ? tools.unwrap(node) : candidate
        )
      )
    : candidates;
}

function createClassReceiverTools(dependencies) {
  const tools = { ...dependencies };
  return Object.freeze({
    classReceiverCandidates: (context, node, name) =>
      classReceiverCandidates(tools, context, node, name),
    classReceiverIdentity: (context, node, seen = new Set()) =>
      classReceiverIdentity(tools, context, node, seen),
  });
}

module.exports = { createClassReceiverTools };
