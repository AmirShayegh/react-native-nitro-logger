'use strict';

const { receiverGetterValues } = require('./receiver-alias-analysis');
const { planStrongComponents } = require('./strong-component-analysis');

const {
  identityWrappedValue,
  indirectBoundCallable,
  isBuiltinNamespaceReference,
  isBuiltinNamespaceUntampered,
  isPoisonedIdentityWrapper,
  isPoisonedReturnTargetWrapper,
  isNamespaceMethod,
  receiverPropertyCandidates,
  reflectiveBuiltinCall,
  returnTargetWrappedValue,
  resolveVariable,
  singleDef,
  staticPropertyName,
  unwrap,
} = require('./shared');
const {
  bindingValues,
  contextWeakCache,
  importedName,
  importSource,
  incrementAnalysisStat,
} = require('./event-bindings');
const {
  ANALYTICS_FACTORY_NAMES,
  analyticsModules,
} = require('./event-options');

const factoryBindingCache = new WeakMap();
const namespaceBindingCache = new WeakMap();
const CYCLE_INCOMPLETE = Symbol('cycle-incomplete');
const CALLABLE_DEPTH_LIMIT = 64;
const FORWARDER_KINDS = new Set(['apply', 'bind', 'call']);

function opaqueForwarder() {
  return Object.freeze({
    boundArgs: Object.freeze([]),
    boundThis: null,
    hasBoundThis: false,
    kind: 'opaque',
  });
}

function forwarder(
  kind,
  boundArgs = [],
  boundThis = null,
  hasBoundThis = false
) {
  return Object.freeze({
    boundArgs: Object.freeze(boundArgs),
    boundThis,
    hasBoundThis,
    kind,
  });
}

function sameNodes(left, right) {
  return (
    left.length === right.length &&
    left.every((candidate, index) => candidate === right[index])
  );
}

function sameForwarder(left, right) {
  return (
    left.kind === right.kind &&
    left.hasBoundThis === right.hasBoundThis &&
    left.boundThis === right.boundThis &&
    sameNodes(left.boundArgs, right.boundArgs)
  );
}

function joinedForwarder(candidates, incomplete = false) {
  const found = candidates.filter(Boolean);
  if (found.length === 0) return null;
  const first = found[0];
  return !incomplete &&
    found.length === candidates.length &&
    found.every((candidate) => sameForwarder(first, candidate))
    ? first
    : opaqueForwarder();
}

function staticArgumentList(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return null;
  if (current.type === 'ArrayExpression') {
    return current.elements.every(
      (element) => !!element && element.type !== 'SpreadElement'
    )
      ? current.elements
      : null;
  }
  if (current.type !== 'Identifier') return null;
  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return null;
  const def = singleDef(variable);
  if (
    !def ||
    def.type !== 'Variable' ||
    def.parent?.kind !== 'const' ||
    def.node.id.type !== 'Identifier'
  ) {
    return null;
  }
  for (const reference of variable.references) {
    if (reference.isWrite() && reference.init !== true) return null;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  return staticArgumentList(context, def.node.init, nextSeen);
}

function staticContainerKey(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return null;
  if (current.type === 'Literal') {
    return ['string', 'number'].includes(typeof current.value)
      ? String(current.value)
      : null;
  }
  if (current.type === 'TemplateLiteral' && current.expressions.length === 0) {
    return current.quasis[0]?.value?.cooked ?? null;
  }
  if (current.type !== 'Identifier') return null;
  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return null;
  const assigned = bindingValues(context, variable);
  if (assigned.opaqueWrite || assigned.values.length !== 1) return null;
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  return staticContainerKey(context, assigned.values[0], nextSeen);
}

function containerMemberName(context, member) {
  if (!member.computed) return staticPropertyName(context, member);
  return staticContainerKey(context, member.property);
}

function patternBindingPath(context, pattern, target, path = []) {
  if (!pattern) return null;
  if (pattern === target) return path;
  if (pattern.type === 'AssignmentPattern') {
    return patternBindingPath(context, pattern.left, target, path);
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      if (property.type !== 'Property') continue;
      const name = property.computed
        ? staticContainerKey(context, property.key)
        : property.key.type === 'Identifier'
          ? property.key.name
          : String(property.key.value);
      if (name === null) continue;
      const found = patternBindingPath(context, property.value, target, [
        ...path,
        name,
      ]);
      if (found) return found;
    }
  }
  if (pattern.type === 'ArrayPattern') {
    for (let index = 0; index < pattern.elements.length; index += 1) {
      const found = patternBindingPath(
        context,
        pattern.elements[index],
        target,
        [...path, String(index)]
      );
      if (found) return found;
    }
  }
  return null;
}

function destructuredBindingCandidates(context, def, seen) {
  if (def?.type !== 'Variable' || def.node.id.type === 'Identifier') return [];
  const path = patternBindingPath(context, def.node.id, def.name);
  if (!path || path.length === 0) return [];
  let values = [def.node.init];
  for (const name of path) {
    values = values.flatMap((value) =>
      callablePropertyCandidates(context, value, name, def.node, seen)
    );
  }
  return values;
}

function destructuredBuiltinForwarder(context, def) {
  if (def?.type !== 'Variable' || def.node.id.type === 'Identifier')
    return null;
  const path = patternBindingPath(context, def.node.id, def.name);
  if (!path || path.length === 0) return null;
  const source = unwrap(def.node.init);
  if (
    path.length === 1 &&
    path[0] === 'apply' &&
    isBuiltinNamespaceReference(context, source, 'Reflect')
  ) {
    return isBuiltinNamespaceUntampered(context, 'Reflect')
      ? forwarder('reflect-apply')
      : opaqueForwarder();
  }
  const method = path[path.length - 1];
  if (!FORWARDER_KINDS.has(method)) return null;
  const functionPrototype =
    (path.length === 1 &&
      source?.type === 'MemberExpression' &&
      staticPropertyName(context, source) === 'prototype' &&
      isBuiltinNamespaceReference(context, source.object, 'Function')) ||
    (path.length === 2 &&
      path[0] === 'prototype' &&
      isBuiltinNamespaceReference(context, source, 'Function'));
  if (!functionPrototype) return null;
  return isBuiltinNamespaceUntampered(context, 'Function')
    ? forwarder(method)
    : opaqueForwarder();
}

function literalPropertyCandidates(context, node, name, gate, seen) {
  const current = unwrap(node);
  if (current?.type === 'Identifier') {
    const variable = resolveVariable(context, current);
    if (!variable || seen.has(variable)) {
      return receiverPropertyCandidates(context, current, name, gate, true);
    }
    const nextSeen = new Set(seen);
    nextSeen.add(variable);
    return callablePropertyCandidates(context, current, name, gate, nextSeen);
  }
  if (current?.type === 'ObjectExpression') {
    const values = [];
    for (const property of current.properties) {
      if (property.type === 'SpreadElement') {
        values.push(
          ...callablePropertyCandidates(
            context,
            property.argument,
            name,
            gate,
            seen
          )
        );
        continue;
      }
      const key = property.computed
        ? staticContainerKey(context, property.key)
        : property.key.type === 'Identifier'
          ? property.key.name
          : String(property.key.value);
      if (key === name) {
        values.push(
          ...(property.kind === 'get'
            ? receiverGetterValues(context, property.value, unwrap)
            : [property.value])
        );
      }
    }
    return values;
  }
  if (current?.type !== 'ArrayExpression' || !/^\d+$/.test(name)) return [];
  const index = Number(name);
  for (let position = 0; position < current.elements.length; position += 1) {
    const element = current.elements[position];
    if (element?.type === 'SpreadElement') return [];
    if (position === index) return element ? [element] : [];
  }
  return [];
}

function containerExpressionCandidates(context, node, gate, seen) {
  const candidates = [];
  const visitedNodes = new Set();
  const visitedVariables = new Set();
  const pending = [node];
  while (pending.length > 0) {
    const source = pending.pop();
    const current = unwrap(source);
    if (!current || seen.has(current) || visitedNodes.has(current)) continue;
    visitedNodes.add(current);
    if (current.type === 'ConditionalExpression') {
      pending.push(current.alternate, current.consequent);
      continue;
    }
    if (current.type === 'LogicalExpression') {
      pending.push(current.right, current.left);
      continue;
    }
    if (current.type === 'MemberExpression') {
      const name = containerMemberName(context, current);
      if (name !== null) {
        const nextSeen = new Set(seen);
        nextSeen.add(current);
        candidates.push(
          ...callablePropertyCandidates(
            context,
            current.object,
            name,
            gate,
            nextSeen
          )
        );
      }
      continue;
    }
    if (current.type !== 'Identifier') {
      candidates.push(current);
      continue;
    }
    const variable = resolveVariable(context, current);
    if (!variable || seen.has(variable) || visitedVariables.has(variable)) {
      candidates.push(current);
      continue;
    }
    visitedVariables.add(variable);
    const assigned = bindingValues(context, variable);
    if (assigned.values.length === 0) {
      candidates.push(current);
      continue;
    }
    for (let index = assigned.values.length - 1; index >= 0; index -= 1) {
      pending.push(assigned.values[index]);
    }
  }
  return candidates;
}

function callablePropertyCandidates(
  context,
  node,
  name,
  gate = null,
  seen = new Set()
) {
  if (name === null || seen.size > CALLABLE_DEPTH_LIMIT) return [];
  const values = receiverPropertyCandidates(context, node, name, gate, true);
  for (const owner of containerExpressionCandidates(
    context,
    node,
    gate,
    seen
  )) {
    values.push(...literalPropertyCandidates(context, owner, name, gate, seen));
  }
  return [...new Set(values)];
}

function functionPrototypeForwarder(context, node) {
  const current = unwrap(node);
  const method =
    current?.type === 'MemberExpression'
      ? staticPropertyName(context, current)
      : null;
  if (!FORWARDER_KINDS.has(method)) return null;
  const prototype = unwrap(current.object);
  if (
    prototype?.type !== 'MemberExpression' ||
    staticPropertyName(context, prototype) !== 'prototype' ||
    !isBuiltinNamespaceReference(context, prototype.object, 'Function')
  ) {
    return null;
  }
  return isBuiltinNamespaceUntampered(context, 'Function')
    ? forwarder(method)
    : opaqueForwarder();
}

function directForwarder(context, node) {
  const current = unwrap(node);
  if (current?.type !== 'MemberExpression') return null;
  if (
    staticPropertyName(context, current) === 'apply' &&
    isBuiltinNamespaceReference(context, current.object, 'Reflect')
  ) {
    return isBuiltinNamespaceUntampered(context, 'Reflect')
      ? forwarder('reflect-apply')
      : opaqueForwarder();
  }
  return functionPrototypeForwarder(context, current);
}

function forwarderReference(context, node, seen = new Set(), depth = 0) {
  if (depth > CALLABLE_DEPTH_LIMIT) return null;
  const current = unwrap(node);
  if (!current) return null;
  if (
    isPoisonedIdentityWrapper(context, current) ||
    isPoisonedReturnTargetWrapper(context, current)
  ) {
    return opaqueForwarder();
  }
  const wrapped =
    identityWrappedValue(context, current) ??
    returnTargetWrappedValue(context, current);
  if (wrapped) {
    return forwarderReference(context, wrapped, seen, depth + 1);
  }
  const direct = directForwarder(context, current);
  if (direct) return direct;
  if (
    current.type === 'ConditionalExpression' ||
    current.type === 'LogicalExpression'
  ) {
    const branches =
      current.type === 'ConditionalExpression'
        ? [current.consequent, current.alternate]
        : [current.left, current.right];
    return joinedForwarder(
      branches.map((branch) =>
        forwarderReference(context, branch, seen, depth + 1)
      )
    );
  }
  if (current.type === 'CallExpression') {
    const indirect = indirectBoundCallable(context, current);
    if (!indirect) return null;
    if (indirect.opaque || !indirect.target) return opaqueForwarder();
    const target = forwarderReference(
      context,
      indirect.target,
      seen,
      depth + 1
    );
    if (!target || target.kind === 'opaque') return target;
    return forwarder(
      target.kind,
      [...target.boundArgs, ...indirect.args],
      target.hasBoundThis ? target.boundThis : indirect.thisArg,
      target.hasBoundThis || !!indirect.thisArg
    );
  }
  if (current.type === 'MemberExpression') {
    if (seen.has(current)) return null;
    const name = containerMemberName(context, current);
    if (name === null) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(current);
    const candidates = callablePropertyCandidates(
      context,
      current.object,
      name,
      null,
      nextSeen
    );
    return joinedForwarder(
      candidates.map((candidate) =>
        forwarderReference(context, candidate, nextSeen, depth + 1)
      )
    );
  }
  if (current.type !== 'Identifier') return null;
  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return null;
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  const def = singleDef(variable);
  const builtin = destructuredBuiltinForwarder(context, def);
  if (builtin) return builtin;
  const destructured = destructuredBindingCandidates(context, def, nextSeen);
  if (destructured.length > 0) {
    return joinedForwarder(
      destructured.map((value) =>
        forwarderReference(context, value, nextSeen, depth + 1)
      )
    );
  }
  const assigned = bindingValues(context, variable);
  return joinedForwarder(
    assigned.values.map((value) =>
      forwarderReference(context, value, nextSeen, depth + 1)
    ),
    assigned.opaqueWrite
  );
}

function forwardedCallableInvocation(context, node, allowBind = false) {
  const call = unwrap(node);
  if (call?.type !== 'CallExpression') return null;
  let target = call.callee;
  let args = call.arguments;
  let thisArg = null;
  let opaque = false;
  let forwarded = false;
  const callee = unwrap(call.callee);
  if (callee?.type === 'MemberExpression') {
    const method = staticPropertyName(context, callee);
    if (method === 'call' || method === 'apply') {
      forwarded = true;
      target = callee.object;
      thisArg = call.arguments[0] ?? null;
      if (method === 'call') {
        args = call.arguments.slice(1);
      } else {
        const unpacked = staticArgumentList(context, call.arguments[1]);
        args = unpacked ?? [];
        opaque = !unpacked;
      }
      if (!isBuiltinNamespaceUntampered(context, 'Function')) opaque = true;
    }
  }

  const evidence = [target].filter(Boolean);
  const seen = new Set();
  for (let depth = 0; depth <= 32; depth += 1) {
    const callable = unwrap(target);
    if (!callable || seen.has(callable)) {
      return forwarded
        ? { args: [], evidence, opaque: true, target: null, thisArg: null }
        : null;
    }
    seen.add(callable);
    const resolved = forwarderReference(context, callable);
    if (!resolved) {
      return forwarded ? { args, evidence, opaque, target, thisArg } : null;
    }
    forwarded = true;
    evidence.push(target, thisArg, ...args);
    if (resolved.kind === 'opaque') {
      return { args: [], evidence, opaque: true, target: null, thisArg: null };
    }
    const forwardedArgs = [...resolved.boundArgs, ...args];
    const effectiveThis = resolved.hasBoundThis ? resolved.boundThis : thisArg;
    if (resolved.kind === 'reflect-apply') {
      const unpacked = staticArgumentList(context, forwardedArgs[2]);
      target = forwardedArgs[0];
      thisArg = forwardedArgs[1] ?? null;
      args = unpacked ?? [];
      opaque = true;
      continue;
    }
    if (resolved.kind === 'bind') {
      if (!allowBind) return null;
      if (!effectiveThis) {
        return {
          args: [],
          evidence,
          opaque: true,
          target: null,
          thisArg: null,
        };
      }
      return {
        args: forwardedArgs.slice(1),
        evidence,
        opaque,
        target: effectiveThis,
        thisArg: forwardedArgs[0] ?? null,
      };
    }
    if (!effectiveThis) {
      return { args: [], evidence, opaque: true, target: null, thisArg: null };
    }
    target = effectiveThis;
    thisArg = forwardedArgs[0] ?? null;
    if (resolved.kind === 'call') {
      args = forwardedArgs.slice(1);
    } else {
      const unpacked = staticArgumentList(context, forwardedArgs[1]);
      args = unpacked ?? [];
      opaque = true;
    }
  }
  return forwarded
    ? { args: [], evidence, opaque: true, target: null, thisArg: null }
    : null;
}

function forwardedBoundCallable(context, node) {
  return forwardedCallableInvocation(context, node, true);
}

function callableProxyProjection(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current || seen.has(current)) return null;
  const nextSeen = new Set(seen);
  nextSeen.add(current);
  let args = null;
  let revocableAlias = false;
  let reflectedConstruction = false;
  if (
    current.type === 'NewExpression' &&
    isBuiltinNamespaceReference(context, current.callee, 'Proxy')
  ) {
    args = current.arguments;
  } else if (current.type === 'CallExpression') {
    const reflected = reflectiveBuiltinCall(context, current);
    if (
      reflected &&
      reflected.methods.size === 1 &&
      reflected.methods.has('Reflect:construct') &&
      !reflected.unknown &&
      !reflected.opaqueArgs &&
      isBuiltinNamespaceReference(context, reflected.args[0], 'Proxy')
    ) {
      args = staticArgumentList(context, reflected.args[1]);
      reflectedConstruction = true;
    }
  } else if (
    current.type === 'MemberExpression' &&
    staticPropertyName(context, current) === 'proxy'
  ) {
    let owner = unwrap(current.object);
    if (owner?.type === 'Identifier') {
      const variable = resolveVariable(context, owner);
      if (!variable || nextSeen.has(variable)) return null;
      const assigned = bindingValues(context, variable);
      if (assigned.opaqueWrite || assigned.values.length !== 1) {
        return { opaque: true, target: null };
      }
      owner = unwrap(assigned.values[0]);
      revocableAlias = true;
    }
    if (owner?.type !== 'CallExpression') return null;
    const reflected = reflectiveBuiltinCall(context, owner);
    if (
      !reflected ||
      !reflected.methods.has('Proxy:revocable') ||
      reflected.methods.size !== 1
    ) {
      return null;
    }
    if (reflected.unknown || reflected.opaqueArgs) {
      return { opaque: true, target: reflected.args[0] ?? null };
    }
    args = reflected.args;
  }
  if (!args) return null;
  const handler = unwrap(args[1]);
  return {
    opaque:
      revocableAlias ||
      (!reflectedConstruction &&
        !isBuiltinNamespaceUntampered(context, 'Proxy')) ||
      handler?.type !== 'ObjectExpression' ||
      handler.properties.length !== 0,
    target: args[0] ?? null,
  };
}

function classificationParts(context, node, seen, kind) {
  const parts = [];
  const pending = [node];
  const visited = new Set();
  while (pending.length > 0) {
    const source = pending.pop();
    const current = unwrap(source);
    if (!current) continue;
    if (seen.has(current)) {
      parts.push({ incomplete: true });
      continue;
    }
    if (visited.has(current)) continue;
    visited.add(current);
    if (
      isPoisonedIdentityWrapper(context, current) ||
      isPoisonedReturnTargetWrapper(context, current)
    ) {
      parts.push({ trusted: true });
      continue;
    }
    const wrapped =
      identityWrappedValue(context, current) ??
      returnTargetWrappedValue(context, current);
    if (wrapped) {
      pending.push(wrapped);
      continue;
    }
    if (
      current.type === 'ConditionalExpression' ||
      current.type === 'LogicalExpression'
    ) {
      const branches =
        current.type === 'ConditionalExpression'
          ? [current.consequent, current.alternate]
          : [current.left, current.right];
      pending.push(branches[1], branches[0]);
      continue;
    }
    if (kind === 'factory') {
      const proxy = callableProxyProjection(context, current, seen);
      if (proxy) {
        if (proxy.opaque || !proxy.target) parts.push({ trusted: true });
        else pending.push(proxy.target);
        continue;
      }
      if (current.type === 'CallExpression') {
        const indirect = indirectBoundCallable(context, current);
        if (indirect) {
          if (indirect.opaque || !indirect.target) {
            parts.push({ trusted: true });
          } else {
            pending.push(indirect.target);
          }
          continue;
        }
        const forwarded = forwardedBoundCallable(context, current);
        if (forwarded) {
          if (forwarded.target) pending.push(forwarded.target);
          else if (forwarded.opaque) pending.push(...forwarded.evidence);
          continue;
        }
        const callee = unwrap(current.callee);
        if (
          callee?.type === 'MemberExpression' &&
          staticPropertyName(context, callee) === 'bind'
        ) {
          pending.push(callee.object);
        }
        continue;
      }
      if (current.type === 'MemberExpression') {
        const name = containerMemberName(context, current);
        if (name === null) continue;
        if (
          ANALYTICS_FACTORY_NAMES.has(name) &&
          classifyAnalyticsNamespace(context, current.object, seen) === true
        ) {
          parts.push({ trusted: true });
          continue;
        }
        const nextSeen = new Set(seen);
        nextSeen.add(current);
        for (const candidate of callablePropertyCandidates(
          context,
          current.object,
          name,
          null,
          nextSeen
        )) {
          if (unwrap(candidate) === current) parts.push({ incomplete: true });
          else pending.push(candidate);
        }
        continue;
      }
    }
    if (current.type !== 'Identifier') continue;
    const variable = resolveVariable(context, current);
    if (!variable) continue;
    const def = singleDef(variable);
    if (kind === 'namespace') {
      if (
        def?.type === 'ImportBinding' &&
        def.node.type === 'ImportNamespaceSpecifier' &&
        analyticsModules(context).has(importSource(def))
      ) {
        parts.push({ trusted: true });
        continue;
      }
    } else if (
      ANALYTICS_FACTORY_NAMES.has(importedName(def)) &&
      analyticsModules(context).has(importSource(def))
    ) {
      parts.push({ trusted: true });
      continue;
    }
    if (def?.type !== 'Variable') continue;
    if (seen.has(variable)) parts.push({ incomplete: true });
    else parts.push({ dependency: variable });
  }
  return parts;
}

function joinClassificationParts(parts, resolveDependency) {
  let incomplete = false;
  for (const part of parts) {
    if (part.trusted) return true;
    if (part.incomplete) {
      incomplete = true;
      continue;
    }
    if (!part.dependency) continue;
    const result = resolveDependency(part.dependency);
    if (result === true) return true;
    if (result === CYCLE_INCOMPLETE) incomplete = true;
  }
  return incomplete ? CYCLE_INCOMPLETE : false;
}

function classifyBindingExpression(context, node, seen, kind) {
  const root =
    kind === 'namespace' ? namespaceBindingCache : factoryBindingCache;
  const counter =
    kind === 'namespace'
      ? 'namespaceBindingComputations'
      : 'factoryBindingComputations';
  const cache = contextWeakCache(root, context);
  const rootParts = classificationParts(context, node, seen, kind);
  const records = new Map();
  const pending = rootParts
    .map((part) => part.dependency)
    .filter((dependency) => dependency && !cache.has(dependency));
  while (pending.length > 0) {
    const variable = pending.pop();
    if (records.has(variable) || cache.has(variable) || seen.has(variable)) {
      continue;
    }
    incrementAnalysisStat(context, counter);
    const assigned = bindingValues(context, variable);
    const parts = assigned.opaqueWrite ? [{ trusted: true }] : [];
    for (const value of assigned.values) {
      parts.push(...classificationParts(context, value, seen, kind));
    }
    const dependencies = [
      ...new Set(parts.map((part) => part.dependency).filter(Boolean)),
    ];
    records.set(variable, { dependencies, parts });
    for (const dependency of dependencies) {
      if (
        !records.has(dependency) &&
        !cache.has(dependency) &&
        !seen.has(dependency)
      ) {
        pending.push(dependency);
      }
    }
  }

  const { componentOf, components, cyclic, order } =
    planStrongComponents(records);
  const results = new Map();
  for (const componentIndex of order) {
    const component = components[componentIndex];
    const parts = [];
    for (const member of component) {
      const record = records.get(member);
      parts.push(
        ...record.parts.filter(
          (part) => componentOf.get(part.dependency) !== componentIndex
        )
      );
    }
    if (cyclic[componentIndex]) parts.push({ incomplete: true });
    const result = joinClassificationParts(parts, (dependency) => {
      const target = componentOf.get(dependency);
      return target === undefined
        ? cache.has(dependency)
          ? cache.get(dependency)
          : CYCLE_INCOMPLETE
        : results.get(target);
    });
    results.set(componentIndex, result);
    if (seen.size === 0) {
      for (const member of component) cache.set(member, result);
    }
  }
  return joinClassificationParts(rootParts, (dependency) => {
    if (cache.has(dependency)) return cache.get(dependency);
    const component = componentOf.get(dependency);
    return component === undefined ? CYCLE_INCOMPLETE : results.get(component);
  });
}

function classifyAnalyticsNamespace(context, node, seen = new Set()) {
  return classifyBindingExpression(context, node, seen, 'namespace');
}

function trustedAnalyticsNamespace(context, node, seen = new Set()) {
  return classifyAnalyticsNamespace(context, node, seen) === true;
}

function classifyFactoryReference(context, node, seen = new Set()) {
  return classifyBindingExpression(context, node, seen, 'factory');
}

function trustedFactoryReference(context, node, seen = new Set()) {
  return classifyFactoryReference(context, node, seen) === true;
}

function trustedFactoryCall(context, node) {
  const current = unwrap(node);
  if (!current || current.type !== 'CallExpression') return false;
  if (trustedFactoryReference(context, current.callee)) return true;
  const forwarded = forwardedCallableInvocation(context, current);
  if (forwarded) {
    if (
      forwarded.target &&
      trustedFactoryReference(context, forwarded.target)
    ) {
      return true;
    }
    if (
      forwarded.opaque &&
      forwarded.evidence.some((candidate) =>
        trustedFactoryReference(context, candidate)
      )
    ) {
      return true;
    }
  }
  if (
    isNamespaceMethod(context, current, 'Reflect', 'apply') &&
    trustedFactoryReference(context, current.arguments[0])
  ) {
    return true;
  }
  const callee = unwrap(current.callee);
  if (callee?.type !== 'MemberExpression') return false;
  const method = staticPropertyName(context, callee);
  return (
    (method === 'call' || method === 'apply') &&
    trustedFactoryReference(context, callee.object)
  );
}

module.exports = {
  callablePropertyCandidates,
  callableProxyProjection,
  containerMemberName,
  forwardedBoundCallable,
  forwardedCallableInvocation,
  trustedAnalyticsNamespace,
  trustedFactoryCall,
  trustedFactoryReference,
};
