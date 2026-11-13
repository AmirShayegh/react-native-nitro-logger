'use strict';

const {
  classReceiverIdentity,
  contextKeyedMap,
  getOrCreateMap,
  identityWrappedValue,
  indirectBoundCallable,
  isBuiltinNamespaceReference,
  isBuiltinNamespaceUntampered,
  isPoisonedIdentityWrapper,
  isPoisonedReturnTargetWrapper,
  isUntamperedBuiltinReference,
  receiverCallIsDeferred,
  receiverPropertyCandidates,
  receiverPropertyChangePoints,
  receiverPropertyIsCallSensitive,
  receiverWriteReachesCall,
  reflectiveBuiltinCall,
  returnTargetWrappedValue,
  resolveVariable,
  singleDef,
  staticPropertyName,
  unwrap,
} = require('./shared');
const {
  IN_PROGRESS,
  bindingValues,
  contextWeakCache,
  incrementAnalysisStat,
} = require('./event-bindings');
const { trustedFactoryCall } = require('./event-factory');
const { planStrongComponents } = require('./strong-component-analysis');
const { analyticsNames } = require('./event-options');

const CONSTRUCTION_CLASSIFICATION = Object.freeze({
  CALL_SENSITIVE: 'call-sensitive',
  NOT_PROVEN: 'not-proven',
  PROVEN: 'proven',
});
const RECEIVER_CLASSIFICATION = Object.freeze({
  ANALYTICS: 'analytics',
  CALL_SENSITIVE: 'call-sensitive',
  NON_ANALYTICS: 'non-analytics',
});
const RECEIVER_CYCLE_INCOMPLETE = Symbol('receiver-cycle-incomplete');

const receiverBindingCache = new WeakMap();
const constructionBindingCache = new WeakMap();
const changePointBindingCache = new WeakMap();
const receiverResultCache = new WeakMap();
const memberReceiverResultCache = new WeakMap();
const classMemberSummaryCache = new WeakMap();
const proxyConstructorStateCache = new WeakMap();
const proxyRevocableStateCache = new WeakMap();

const PROXY_CALLABLE_OTHER = Object.freeze({
  args: Object.freeze([]),
  bound: false,
  state: 'other',
});
const PROXY_CALLABLE_POISONED = Object.freeze({
  args: Object.freeze([]),
  bound: false,
  state: 'poisoned',
});
const PROXY_CALLABLE_TRUSTED = Object.freeze({
  args: Object.freeze([]),
  bound: false,
  state: 'trusted',
});
const PROXY_ARGUMENT_LIMIT = 2;
const PROXY_CALLABLE_DEPTH_LIMIT = 64;

function joinConstructionParts(parts, resolveDependency, productive) {
  let result = CONSTRUCTION_CLASSIFICATION.PROVEN;
  let hasOrigin = productive;
  for (const part of parts) {
    const candidate = part.dependency
      ? resolveDependency(part.dependency)
      : part.classification;
    if (candidate === CONSTRUCTION_CLASSIFICATION.NOT_PROVEN) {
      return candidate;
    }
    hasOrigin = true;
    if (candidate === CONSTRUCTION_CLASSIFICATION.CALL_SENSITIVE) {
      result = candidate;
    }
  }
  return hasOrigin ? result : CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
}

function stableConstructionBinding(context, variable, seen) {
  const cache = contextWeakCache(constructionBindingCache, context);
  if (cache.has(variable)) {
    const cached = cache.get(variable);
    return cached === IN_PROGRESS
      ? CONSTRUCTION_CLASSIFICATION.NOT_PROVEN
      : cached;
  }

  const records = new Map();
  const pending = [variable];
  while (pending.length > 0) {
    const currentVariable = pending.pop();
    if (records.has(currentVariable)) continue;
    if (cache.has(currentVariable)) continue;
    incrementAnalysisStat(context, 'constructionBindingComputations');
    cache.set(currentVariable, IN_PROGRESS);
    const assigned = bindingValues(context, currentVariable);
    const parts = [];
    if (assigned.opaqueWrite || assigned.values.length === 0) {
      parts.push({
        classification: CONSTRUCTION_CLASSIFICATION.NOT_PROVEN,
      });
    } else {
      for (const value of assigned.values) {
        const current = unwrap(value);
        const dependency =
          current?.type === 'Identifier'
            ? resolveVariable(context, current)
            : null;
        if (dependency && singleDef(dependency)?.type === 'Variable') {
          parts.push({ dependency });
          if (!records.has(dependency) && !cache.has(dependency)) {
            pending.push(dependency);
          }
        } else {
          parts.push({
            classification: stableProvenConstruction(context, value, seen),
          });
        }
      }
    }
    records.set(currentVariable, {
      dependencies: [
        ...new Set(parts.map((part) => part.dependency).filter(Boolean)),
      ],
      parts,
    });
  }

  const { componentOf, components, cyclic, order } =
    planStrongComponents(records);

  const results = new Map();
  for (const componentIndex of order) {
    const component = components[componentIndex];
    const parts = [];
    let productive = false;
    const componentIsCyclic = cyclic[componentIndex];
    for (const member of component) {
      const record = records.get(member);
      for (const part of record.parts) {
        if (componentOf.get(part.dependency) === componentIndex) continue;
        parts.push(part);
        productive = true;
      }
    }
    const result = componentIsCyclic
      ? CONSTRUCTION_CLASSIFICATION.NOT_PROVEN
      : joinConstructionParts(
          parts,
          (dependency) => {
            const target = componentOf.get(dependency);
            if (target !== undefined) return results.get(target);
            if (!cache.has(dependency)) {
              return CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
            }
            const cached = cache.get(dependency);
            return cached === IN_PROGRESS
              ? CONSTRUCTION_CLASSIFICATION.NOT_PROVEN
              : cached;
          },
          productive
        );
    results.set(componentIndex, result);
    for (const member of component) cache.set(member, result);
  }
  return cache.get(variable) ?? CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
}

function stableMemberConstruction(context, current, seen) {
  if (seen.has(current)) return CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
  const name = staticPropertyName(context, current);
  if (name === null) return CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
  const callSensitive = receiverPropertyIsCallSensitive(
    context,
    current.object,
    name,
    true
  );
  const nextSeen = new Set(seen);
  nextSeen.add(current);
  const candidates = receiverPropertyCandidates(
    context,
    current.object,
    name,
    null,
    true
  );
  if (candidates.length === 0) {
    return CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
  }
  let result = CONSTRUCTION_CLASSIFICATION.PROVEN;
  for (const value of candidates) {
    const candidate = stableProvenConstruction(context, value, nextSeen);
    if (candidate === CONSTRUCTION_CLASSIFICATION.NOT_PROVEN) {
      return callSensitive
        ? CONSTRUCTION_CLASSIFICATION.CALL_SENSITIVE
        : candidate;
    }
    if (candidate === CONSTRUCTION_CLASSIFICATION.CALL_SENSITIVE) {
      result = candidate;
    }
  }
  return result;
}

function constructionBranches(current) {
  if (current.type === 'ConditionalExpression') {
    return [current.consequent, current.alternate];
  }
  return current.type === 'LogicalExpression'
    ? [current.left, current.right]
    : null;
}

function proxyCallable(state, args = [], bound = false) {
  if (state === 'other') return PROXY_CALLABLE_OTHER;
  if (state === 'poisoned') return PROXY_CALLABLE_POISONED;
  return Object.freeze({ args: Object.freeze(args), bound, state });
}

function sameArguments(left, right) {
  return (
    left.length === right.length &&
    left.every((argument, index) => argument === right[index])
  );
}

function combineProxyCallables(results) {
  if (results.every((result) => result.state === 'other')) {
    return PROXY_CALLABLE_OTHER;
  }
  const first = results[0];
  if (
    first &&
    results.every(
      (result) =>
        result.state === 'trusted' &&
        result.bound === first.bound &&
        sameArguments(result.args, first.args)
    )
  ) {
    return first;
  }
  return PROXY_CALLABLE_POISONED;
}

function proxyCallableCache(kind) {
  return kind === 'constructor'
    ? proxyConstructorStateCache
    : proxyRevocableStateCache;
}

function directProxyCallable(context, current, kind, seen, depth) {
  if (kind === 'constructor') {
    if (isUntamperedBuiltinReference(context, current, 'Proxy')) {
      return PROXY_CALLABLE_TRUSTED;
    }
    return isBuiltinNamespaceReference(context, current, 'Proxy')
      ? PROXY_CALLABLE_POISONED
      : null;
  }
  if (
    current.type !== 'MemberExpression' ||
    staticPropertyName(context, current) !== 'revocable'
  ) {
    return null;
  }
  const owner = proxyCallableValue(
    context,
    current.object,
    'constructor',
    seen,
    depth + 1
  );
  if (owner.state === 'other') return null;
  return owner.state === 'trusted' && !owner.bound
    ? PROXY_CALLABLE_TRUSTED
    : PROXY_CALLABLE_POISONED;
}

function proxyArguments(...lists) {
  const prefix = [];
  for (const list of lists) {
    for (const argument of list) {
      if (argument?.type === 'SpreadElement') return null;
      if (prefix.length < PROXY_ARGUMENT_LIMIT) prefix.push(argument);
    }
  }
  return prefix;
}

function boundProxyCallable(target, args) {
  if (target.state !== 'trusted') return target;
  const prefix = proxyArguments(target.args, args);
  if (!prefix) return PROXY_CALLABLE_POISONED;
  return proxyCallable('trusted', prefix, true);
}

function proxyIdentifierCallable(context, current, kind, seen, depth) {
  const variable = resolveVariable(context, current);
  if (!variable) return PROXY_CALLABLE_OTHER;
  const def = singleDef(variable);
  if (!def || def.type !== 'Variable') return PROXY_CALLABLE_OTHER;
  const cache = contextWeakCache(proxyCallableCache(kind), context);
  const cached = cache.get(variable);
  if (cached !== undefined) {
    return cached === IN_PROGRESS ? PROXY_CALLABLE_POISONED : cached;
  }
  if (seen.has(variable)) return PROXY_CALLABLE_POISONED;
  if (kind === 'constructor') {
    incrementAnalysisStat(context, 'proxyConstructorComputations');
  }
  cache.set(variable, IN_PROGRESS);
  const assigned = bindingValues(context, variable);
  if (assigned.opaqueWrite) {
    cache.set(variable, PROXY_CALLABLE_POISONED);
    return PROXY_CALLABLE_POISONED;
  }
  if (assigned.values.length === 0) {
    cache.set(variable, PROXY_CALLABLE_OTHER);
    return PROXY_CALLABLE_OTHER;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  const result = combineProxyCallables(
    assigned.values.map((value) =>
      proxyCallableValue(context, value, kind, nextSeen, depth + 1)
    )
  );
  cache.set(variable, result);
  return result;
}

function proxyCallExpressionCallable(context, current, kind, seen, depth) {
  const callee = unwrap(current.callee);
  if (
    callee?.type === 'MemberExpression' &&
    staticPropertyName(context, callee) === 'bind'
  ) {
    return isBuiltinNamespaceUntampered(context, 'Function')
      ? boundProxyCallable(
          proxyCallableValue(context, callee.object, kind, seen, depth + 1),
          current.arguments.slice(1)
        )
      : PROXY_CALLABLE_POISONED;
  }
  const indirect = indirectBoundCallable(context, current);
  if (!indirect) return PROXY_CALLABLE_OTHER;
  if (indirect.opaque || !indirect.target) return PROXY_CALLABLE_POISONED;
  return boundProxyCallable(
    proxyCallableValue(context, indirect.target, kind, seen, depth + 1),
    indirect.args
  );
}

function proxyCallableValue(context, node, kind, seen = new Set(), depth = 0) {
  if (depth > PROXY_CALLABLE_DEPTH_LIMIT) return PROXY_CALLABLE_POISONED;
  const current = unwrap(node);
  if (!current) return PROXY_CALLABLE_OTHER;
  if (isPoisonedReturnTargetWrapper(context, current)) {
    return PROXY_CALLABLE_POISONED;
  }
  const returned = returnTargetWrappedValue(context, current);
  if (returned) {
    return proxyCallableValue(context, returned, kind, seen, depth + 1);
  }
  if (isPoisonedIdentityWrapper(context, current)) {
    return PROXY_CALLABLE_POISONED;
  }
  const identity = identityWrappedValue(context, current);
  if (identity) {
    return proxyCallableValue(context, identity, kind, seen, depth + 1);
  }
  const direct = directProxyCallable(context, current, kind, seen, depth);
  if (direct) return direct;
  if (current.type === 'ConditionalExpression') {
    return combineProxyCallables([
      proxyCallableValue(context, current.consequent, kind, seen, depth + 1),
      proxyCallableValue(context, current.alternate, kind, seen, depth + 1),
    ]);
  }
  if (current.type === 'LogicalExpression') {
    return combineProxyCallables([
      proxyCallableValue(context, current.left, kind, seen, depth + 1),
      proxyCallableValue(context, current.right, kind, seen, depth + 1),
    ]);
  }
  if (current.type === 'CallExpression') {
    return proxyCallExpressionCallable(context, current, kind, seen, depth);
  }
  if (current.type !== 'Identifier') return PROXY_CALLABLE_OTHER;
  return proxyIdentifierCallable(context, current, kind, seen, depth);
}

function invokedProxyCallable(context, call, kind) {
  const direct = proxyCallableValue(context, call.callee, kind);
  if (direct.state !== 'other') {
    const args = proxyArguments(direct.args, call.arguments);
    return args
      ? { args, state: direct.state }
      : { args: [], state: 'poisoned' };
  }
  const normalized = reflectiveBuiltinCall(context, call);
  if (kind !== 'revocable' || !normalized) {
    return { args: [], state: 'other' };
  }
  const mayInvokeRevocable =
    normalized.methods.has('Proxy:revocable') ||
    normalized.methods.has('Reflect:apply') ||
    normalized.methods.has('Reflect:*');
  if (!mayInvokeRevocable) return { args: [], state: 'other' };
  if (
    normalized.unknown ||
    normalized.opaqueArgs ||
    normalized.methods.size !== 1 ||
    !normalized.methods.has('Proxy:revocable') ||
    !isBuiltinNamespaceUntampered(context, 'Proxy') ||
    !isBuiltinNamespaceUntampered(context, 'Function') ||
    !isBuiltinNamespaceUntampered(context, 'Reflect')
  ) {
    return { args: [], state: 'poisoned' };
  }
  const args = proxyArguments(normalized.args);
  return args ? { args, state: 'trusted' } : { args: [], state: 'poisoned' };
}

function reflectConstructProxy(context, call) {
  const normalized = reflectiveBuiltinCall(context, call);
  if (
    !normalized ||
    (!normalized.methods.has('Reflect:construct') &&
      !normalized.methods.has('Reflect:*'))
  ) {
    return null;
  }
  if (
    normalized.unknown ||
    normalized.opaqueArgs ||
    normalized.methods.size !== 1 ||
    !normalized.methods.has('Reflect:construct') ||
    !isBuiltinNamespaceUntampered(context, 'Reflect')
  ) {
    return { args: [], state: 'poisoned' };
  }
  const packed = unwrap(normalized.args[1]);
  const unpacked =
    packed?.type === 'ArrayExpression' ? proxyArguments(packed.elements) : null;
  const constructor = proxyCallableValue(
    context,
    normalized.args[0],
    'constructor'
  );
  if (constructor.state !== 'trusted') {
    return { args: [], state: constructor.state };
  }
  const args = unpacked && proxyArguments(constructor.args, unpacked);
  return args ? { args, state: 'trusted' } : { args: [], state: 'poisoned' };
}

function proxyConstruction(context, current) {
  let args = null;
  if (current.type === 'NewExpression') {
    const constructor = proxyCallableValue(
      context,
      current.callee,
      'constructor'
    );
    if (constructor.state === 'poisoned') {
      return { target: null, transparent: false };
    }
    if (constructor.state === 'trusted') {
      args = proxyArguments(constructor.args, current.arguments);
    }
  } else if (current.type === 'CallExpression') {
    const construction = reflectConstructProxy(context, current);
    if (construction?.state === 'poisoned') {
      return { target: null, transparent: false };
    }
    if (construction?.state === 'trusted') args = construction.args;
  } else if (
    current.type === 'MemberExpression' &&
    staticPropertyName(context, current) === 'proxy'
  ) {
    const call = unwrap(current.object);
    const factory =
      call?.type === 'CallExpression'
        ? invokedProxyCallable(context, call, 'revocable')
        : PROXY_CALLABLE_OTHER;
    if (factory.state === 'poisoned') {
      return { target: null, transparent: false };
    }
    if (factory.state === 'trusted') {
      args = factory.args;
    }
  }
  if (!args) return null;
  const handler = unwrap(args[1]);
  return {
    target: args[0] ?? null,
    transparent:
      handler?.type === 'ObjectExpression' && handler.properties.length === 0,
  };
}

function stableProvenConstruction(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
  const branches = constructionBranches(current);
  if (branches) {
    return joinConstructionClassifications(
      branches.map((branch) => stableProvenConstruction(context, branch, seen))
    );
  }
  if (current.type === 'AwaitExpression') {
    return CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
  }
  if (isPoisonedIdentityWrapper(context, current)) {
    return CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
  }
  const identityValue = identityWrappedValue(context, current);
  if (identityValue) {
    return stableProvenConstruction(context, identityValue, seen);
  }
  const proxy = proxyConstruction(context, current);
  if (proxy) {
    return proxy.transparent &&
      proxy.target &&
      stableReceiverValue(context, proxy.target, seen) ===
        RECEIVER_CLASSIFICATION.NON_ANALYTICS
      ? stableProvenConstruction(context, proxy.target, seen)
      : CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
  }
  if (current.type === 'NewExpression') {
    return CONSTRUCTION_CLASSIFICATION.PROVEN;
  }
  if (current.type === 'Identifier') {
    const variable = resolveVariable(context, current);
    return variable
      ? stableConstructionBinding(context, variable, seen)
      : CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
  }
  return current.type === 'MemberExpression'
    ? stableMemberConstruction(context, current, seen)
    : CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
}

function joinConstructionClassifications(classifications) {
  if (
    classifications.some(
      (value) => value === CONSTRUCTION_CLASSIFICATION.NOT_PROVEN
    )
  ) {
    return CONSTRUCTION_CLASSIFICATION.NOT_PROVEN;
  }
  return classifications.some(
    (value) => value === CONSTRUCTION_CLASSIFICATION.CALL_SENSITIVE
  )
    ? CONSTRUCTION_CLASSIFICATION.CALL_SENSITIVE
    : CONSTRUCTION_CLASSIFICATION.PROVEN;
}

function provenIdentifierConstruction(context, current, callNode, seen) {
  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  const assigned = bindingValues(context, variable);
  return (
    !assigned.opaqueWrite &&
    assigned.values.length > 0 &&
    assigned.values.every((value) =>
      provenConstruction(context, value, callNode, nextSeen)
    )
  );
}

function provenMemberConstruction(context, current, callNode, seen) {
  if (seen.has(current)) return false;
  const name = staticPropertyName(context, current);
  if (name === null) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(current);
  const candidates = receiverPropertyCandidates(
    context,
    current.object,
    name,
    callNode,
    true
  );
  return (
    candidates.length > 0 &&
    candidates.every((value) =>
      provenConstruction(context, value, callNode, nextSeen)
    )
  );
}

function provenConstruction(context, node, callNode, seen = new Set()) {
  const stable = stableProvenConstruction(context, node, seen);
  if (stable !== CONSTRUCTION_CLASSIFICATION.CALL_SENSITIVE) {
    return stable === CONSTRUCTION_CLASSIFICATION.PROVEN;
  }
  const current = unwrap(node);
  if (!current) return false;
  const branches = constructionBranches(current);
  if (branches) {
    return branches.every((branch) =>
      provenConstruction(context, branch, callNode, seen)
    );
  }
  if (current.type === 'Identifier') {
    return provenIdentifierConstruction(context, current, callNode, seen);
  }
  return current.type === 'MemberExpression'
    ? provenMemberConstruction(context, current, callNode, seen)
    : false;
}

function classifyStableMemberCandidates(
  context,
  candidates,
  callSensitive,
  seen
) {
  let allAnalytics = candidates.length > 0;
  let allConstructions = candidates.length > 0;
  let callSensitiveCandidate = false;
  let incomplete = false;
  for (const candidate of candidates) {
    const receiver = stableReceiverValue(context, candidate, seen);
    if (receiver === RECEIVER_CLASSIFICATION.ANALYTICS) {
      allConstructions = false;
      continue;
    }
    allAnalytics = false;
    if (receiver === RECEIVER_CLASSIFICATION.CALL_SENSITIVE) {
      allConstructions = false;
      callSensitiveCandidate = true;
      continue;
    }
    if (receiver === RECEIVER_CYCLE_INCOMPLETE) {
      allAnalytics = false;
      allConstructions = false;
      incomplete = true;
      continue;
    }
    const construction = stableProvenConstruction(context, candidate, seen);
    if (construction === CONSTRUCTION_CLASSIFICATION.PROVEN) continue;
    allConstructions = false;
    if (construction === CONSTRUCTION_CLASSIFICATION.CALL_SENSITIVE) {
      callSensitiveCandidate = true;
    } else if (!callSensitive) {
      return RECEIVER_CLASSIFICATION.ANALYTICS;
    }
  }
  if (incomplete) return RECEIVER_CYCLE_INCOMPLETE;
  if (allAnalytics) return RECEIVER_CLASSIFICATION.ANALYTICS;
  if (allConstructions) return RECEIVER_CLASSIFICATION.NON_ANALYTICS;
  return callSensitiveCandidate || callSensitive
    ? RECEIVER_CLASSIFICATION.CALL_SENSITIVE
    : RECEIVER_CLASSIFICATION.ANALYTICS;
}

function stableMemberReceiver(context, current, seen) {
  const name = staticPropertyName(context, current);
  if (name === null || seen.has(current)) {
    return RECEIVER_CLASSIFICATION.NON_ANALYTICS;
  }
  const callSensitive = receiverPropertyIsCallSensitive(
    context,
    current.object,
    name,
    true
  );
  const nextSeen = new Set(seen);
  nextSeen.add(current);
  const candidates = receiverPropertyCandidates(
    context,
    current.object,
    name,
    null,
    true
  );
  if (candidates.length === 0) {
    return analyticsNames(context).has(name)
      ? RECEIVER_CLASSIFICATION.ANALYTICS
      : RECEIVER_CLASSIFICATION.NON_ANALYTICS;
  }
  return classifyStableMemberCandidates(
    context,
    candidates,
    callSensitive,
    nextSeen
  );
}

function joinReceiverClassifications(classifications) {
  if (
    classifications.some((value) => value === RECEIVER_CLASSIFICATION.ANALYTICS)
  ) {
    return RECEIVER_CLASSIFICATION.ANALYTICS;
  }
  if (classifications.some((value) => value === RECEIVER_CYCLE_INCOMPLETE)) {
    return RECEIVER_CYCLE_INCOMPLETE;
  }
  return classifications.some(
    (value) => value === RECEIVER_CLASSIFICATION.CALL_SENSITIVE
  )
    ? RECEIVER_CLASSIFICATION.CALL_SENSITIVE
    : RECEIVER_CLASSIFICATION.NON_ANALYTICS;
}

function stableReceiverValue(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return RECEIVER_CLASSIFICATION.NON_ANALYTICS;
  if (current.type === 'ConditionalExpression') {
    return joinReceiverClassifications([
      stableReceiverValue(context, current.consequent, seen),
      stableReceiverValue(context, current.alternate, seen),
    ]);
  }
  if (current.type === 'LogicalExpression') {
    return joinReceiverClassifications([
      stableReceiverValue(context, current.left, seen),
      stableReceiverValue(context, current.right, seen),
    ]);
  }
  if (current.type === 'AwaitExpression') {
    return RECEIVER_CLASSIFICATION.ANALYTICS;
  }
  if (isPoisonedIdentityWrapper(context, current)) {
    return RECEIVER_CLASSIFICATION.ANALYTICS;
  }
  const identityValue = identityWrappedValue(context, current);
  if (identityValue) {
    return stableReceiverValue(context, identityValue, seen);
  }
  const proxy = proxyConstruction(context, current);
  if (proxy) {
    return proxy.transparent && proxy.target
      ? stableReceiverValue(context, proxy.target, seen)
      : RECEIVER_CLASSIFICATION.ANALYTICS;
  }
  if (current.type === 'MemberExpression') {
    return stableMemberReceiver(context, current, seen);
  }
  if (current.type === 'CallExpression') {
    return trustedFactoryCall(context, current)
      ? RECEIVER_CLASSIFICATION.ANALYTICS
      : RECEIVER_CLASSIFICATION.NON_ANALYTICS;
  }
  if (current.type === 'NewExpression') {
    return RECEIVER_CLASSIFICATION.NON_ANALYTICS;
  }
  if (current.type !== 'Identifier') {
    return RECEIVER_CLASSIFICATION.NON_ANALYTICS;
  }
  const variable = resolveVariable(context, current);
  if (!variable) {
    return analyticsNames(context).has(current.name)
      ? RECEIVER_CLASSIFICATION.ANALYTICS
      : RECEIVER_CLASSIFICATION.NON_ANALYTICS;
  }
  if (seen.has(variable)) return RECEIVER_CYCLE_INCOMPLETE;
  return receiverBindingSummary(context, variable, seen).result;
}

function gateChangePoint(entry) {
  return !entry.initial && Number.isFinite(entry.gate?.range?.[0])
    ? entry.gate.range[0]
    : null;
}

function valueChangePoints(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return Object.freeze([]);
  if (
    current.type === 'ConditionalExpression' ||
    current.type === 'LogicalExpression'
  ) {
    const branches =
      current.type === 'ConditionalExpression'
        ? [current.consequent, current.alternate]
        : [current.left, current.right];
    const points = branches.flatMap((branch) =>
      valueChangePoints(context, branch, seen)
    );
    points.sort((left, right) => left - right);
    return Object.freeze([...new Set(points)]);
  }
  if (current.type === 'MemberExpression') {
    const name = staticPropertyName(context, current);
    return name === null
      ? Object.freeze([])
      : receiverPropertyChangePoints(context, current.object, name, true);
  }
  if (current.type !== 'Identifier') return Object.freeze([]);
  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return Object.freeze([]);
  const cache = contextWeakCache(changePointBindingCache, context);
  const cached = cache.get(variable);
  if (cached !== undefined) {
    return cached === IN_PROGRESS ? Object.freeze([]) : cached;
  }

  cache.set(variable, IN_PROGRESS);
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  const points = [];
  for (const entry of bindingValues(context, variable).entries) {
    const point = gateChangePoint(entry);
    if (point !== null) points.push(point);
    points.push(...valueChangePoints(context, entry.value, nextSeen));
  }
  points.sort((left, right) => left - right);
  const result = Object.freeze([...new Set(points)]);
  cache.set(variable, result);
  return result;
}

function cycleSummary() {
  return Object.freeze({
    changePoints: Object.freeze([]),
    dynamicEntries: Object.freeze([]),
    dynamicValues: Object.freeze([]),
    fallback: RECEIVER_CLASSIFICATION.NON_ANALYTICS,
    incomplete: true,
    result: RECEIVER_CYCLE_INCOMPLETE,
  });
}

/**
 * Classify the leaf of a straight initial-binding alias chain without
 * re-entering receiver binding analysis.
 *
 * The common generated-code shape is `const next = previous`, ending at an
 * imported/global receiver, a construction, or a factory call. Keeping the
 * leaf classifier deliberately narrow lets `receiverBindingSummary` unwind
 * that shape iteratively while every expression that needs the richer member,
 * wrapper, Proxy, or temporal analysis continues through the established
 * recursive path below.
 */
function initialAliasLeafClassification(context, node) {
  const current = unwrap(node);
  if (!current) {
    return {
      construction: CONSTRUCTION_CLASSIFICATION.NOT_PROVEN,
      receiver: RECEIVER_CLASSIFICATION.NON_ANALYTICS,
    };
  }
  if (current.type === 'AwaitExpression') {
    return {
      construction: CONSTRUCTION_CLASSIFICATION.NOT_PROVEN,
      receiver: RECEIVER_CLASSIFICATION.ANALYTICS,
    };
  }
  if (isPoisonedIdentityWrapper(context, current)) {
    return {
      construction: CONSTRUCTION_CLASSIFICATION.NOT_PROVEN,
      receiver: RECEIVER_CLASSIFICATION.ANALYTICS,
    };
  }
  if (identityWrappedValue(context, current)) return null;

  if (current.type === 'Identifier') {
    const variable = resolveVariable(context, current);
    if (variable && singleDef(variable)?.type === 'Variable') return null;
    return {
      construction: CONSTRUCTION_CLASSIFICATION.NOT_PROVEN,
      receiver: variable
        ? RECEIVER_CLASSIFICATION.ANALYTICS
        : analyticsNames(context).has(current.name)
          ? RECEIVER_CLASSIFICATION.ANALYTICS
          : RECEIVER_CLASSIFICATION.NON_ANALYTICS,
    };
  }

  if (current.type === 'CallExpression') {
    const proxy = proxyConstruction(context, current);
    if (proxy) {
      if (proxy.transparent && proxy.target) return null;
      return {
        construction: CONSTRUCTION_CLASSIFICATION.NOT_PROVEN,
        receiver: RECEIVER_CLASSIFICATION.ANALYTICS,
      };
    }
    return {
      construction: CONSTRUCTION_CLASSIFICATION.NOT_PROVEN,
      receiver: trustedFactoryCall(context, current)
        ? RECEIVER_CLASSIFICATION.ANALYTICS
        : RECEIVER_CLASSIFICATION.NON_ANALYTICS,
    };
  }

  if (current.type === 'NewExpression') {
    const proxy = proxyConstruction(context, current);
    if (proxy) {
      if (proxy.transparent && proxy.target) return null;
      return {
        construction: CONSTRUCTION_CLASSIFICATION.NOT_PROVEN,
        receiver: RECEIVER_CLASSIFICATION.ANALYTICS,
      };
    }
    return {
      construction: CONSTRUCTION_CLASSIFICATION.PROVEN,
      receiver: RECEIVER_CLASSIFICATION.NON_ANALYTICS,
    };
  }

  if (
    current.type === 'MemberExpression' ||
    current.type === 'ConditionalExpression' ||
    current.type === 'LogicalExpression'
  ) {
    return null;
  }
  return {
    construction: CONSTRUCTION_CLASSIFICATION.NOT_PROVEN,
    receiver: RECEIVER_CLASSIFICATION.NON_ANALYTICS,
  };
}

/**
 * Publish a stable result for a direct-alias component whose values are all
 * analytics from initialization onward.
 *
 * Reverse reachability is intentionally limited to initial alias edges. That
 * prevents a later write from making a receiver look analytics before the
 * write, while still resolving large initialized cycles without recursion.
 */
function uniformAnalyticsAliasSummary(context, root) {
  const cache = contextWeakCache(receiverBindingCache, context);
  const constructionCache = contextWeakCache(constructionBindingCache, context);
  const pending = [root];
  const visited = new Set();
  const nodes = [];
  const reverseInitial = new Map();
  const initialAnalytics = [];

  while (pending.length > 0) {
    const variable = pending.pop();
    if (visited.has(variable)) continue;
    if (cache.has(variable)) return null;
    const knownConstruction = constructionCache.get(variable);
    if (knownConstruction === IN_PROGRESS) return null;

    const assigned = bindingValues(context, variable);
    if (
      assigned.opaqueWrite ||
      assigned.entries.length === 0 ||
      !assigned.entries.some((entry) => entry.initial)
    ) {
      return null;
    }

    visited.add(variable);
    for (const entry of assigned.entries) {
      const current = unwrap(entry.value);
      const target =
        current?.type === 'Identifier'
          ? resolveVariable(context, current)
          : null;
      if (target && singleDef(target)?.type === 'Variable') {
        pending.push(target);
        if (entry.initial) {
          let dependents = reverseInitial.get(target);
          if (!dependents) {
            dependents = [];
            reverseInitial.set(target, dependents);
          }
          dependents.push(variable);
        }
        continue;
      }

      const leaf = initialAliasLeafClassification(context, current);
      if (
        !leaf ||
        leaf.receiver !== RECEIVER_CLASSIFICATION.ANALYTICS ||
        leaf.construction === CONSTRUCTION_CLASSIFICATION.PROVEN
      ) {
        return null;
      }
      if (entry.initial) initialAnalytics.push(variable);
    }
    nodes.push({ assigned, knownConstruction, variable });
  }

  const initialized = new Set(initialAnalytics);
  const queue = [...initialAnalytics];
  for (let index = 0; index < queue.length; index += 1) {
    for (const dependent of reverseInitial.get(queue[index]) ?? []) {
      if (initialized.has(dependent)) continue;
      initialized.add(dependent);
      queue.push(dependent);
    }
  }
  if (initialized.size !== nodes.length) return null;

  for (const { assigned, knownConstruction, variable } of nodes) {
    const dynamicEntries = Object.freeze([...assigned.entries]);
    const result = Object.freeze({
      changePoints: Object.freeze([]),
      dynamicEntries,
      dynamicValues: Object.freeze(dynamicEntries.map((entry) => entry.value)),
      fallback: receiverFallback(context, variable, assigned, false),
      incomplete: false,
      result: RECEIVER_CLASSIFICATION.ANALYTICS,
    });
    if (knownConstruction === undefined) {
      incrementAnalysisStat(context, 'constructionBindingComputations');
    }
    constructionCache.set(variable, CONSTRUCTION_CLASSIFICATION.NOT_PROVEN);
    cache.set(variable, result);
  }
  return cache.get(root);
}

/**
 * Resolve a single-source initial alias chain with an explicit worklist.
 *
 * This avoids both recursive call-stack growth and `new Set(seen)` path copies
 * for chains emitted by generated modules. A one-source cycle has no external
 * receiver origin, so every member receives the same stable incomplete
 * summary; cycles with writes or additional sources intentionally fall back to
 * the full analysis.
 */
function initialAliasBindingSummary(context, root) {
  const cache = contextWeakCache(receiverBindingCache, context);
  const constructionCache = contextWeakCache(constructionBindingCache, context);
  const path = [];
  const positions = new Map();
  let variable = root;
  let leaf = null;

  while (true) {
    if (positions.has(variable)) {
      const result = cycleSummary();
      for (const step of path) {
        if (step.knownConstruction === undefined) {
          incrementAnalysisStat(context, 'constructionBindingComputations');
        }
        constructionCache.set(
          step.variable,
          CONSTRUCTION_CLASSIFICATION.NOT_PROVEN
        );
        cache.set(step.variable, result);
      }
      return cache.get(root);
    }
    if (cache.has(variable)) return null;
    const knownConstruction = constructionCache.get(variable);
    if (knownConstruction === IN_PROGRESS) return null;

    const assigned = bindingValues(context, variable);
    if (
      assigned.opaqueWrite ||
      assigned.entries.length !== 1 ||
      assigned.entries[0].initial !== true
    ) {
      return null;
    }

    const entry = assigned.entries[0];
    positions.set(variable, path.length);
    path.push({ assigned, entry, knownConstruction, variable });
    const current = unwrap(entry.value);
    if (current?.type !== 'Identifier') {
      leaf = initialAliasLeafClassification(context, current);
      break;
    }
    const target = resolveVariable(context, current);
    if (!target || singleDef(target)?.type !== 'Variable') {
      leaf = initialAliasLeafClassification(context, current);
      break;
    }
    variable = target;
  }

  if (!leaf) return null;
  let construction = leaf.construction;
  let receiver = leaf.receiver;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const {
      assigned,
      entry,
      knownConstruction,
      variable: currentVariable,
    } = path[index];
    if (knownConstruction !== undefined) construction = knownConstruction;
    const onlyConstructions =
      construction === CONSTRUCTION_CLASSIFICATION.PROVEN;
    const dynamicEntries =
      onlyConstructions ||
      receiver === RECEIVER_CLASSIFICATION.NON_ANALYTICS ||
      receiver === RECEIVER_CYCLE_INCOMPLETE
        ? []
        : [entry];
    const fallback = receiverFallback(
      context,
      currentVariable,
      assigned,
      onlyConstructions
    );
    const result = Object.freeze({
      changePoints: Object.freeze([]),
      dynamicEntries: Object.freeze(dynamicEntries),
      dynamicValues: Object.freeze(
        dynamicEntries.map((candidate) => candidate.value)
      ),
      fallback,
      incomplete: false,
      result: dynamicEntries.length > 0 ? receiver : fallback,
    });
    if (knownConstruction === undefined) {
      incrementAnalysisStat(context, 'constructionBindingComputations');
      constructionCache.set(currentVariable, construction);
    }
    cache.set(currentVariable, result);
    receiver = result.result;
  }
  return cache.get(root);
}

function receiverBindingSummary(context, variable, seen = new Set()) {
  const cache = contextWeakCache(receiverBindingCache, context);
  const cached = cache.get(variable);
  if (cached && cached !== IN_PROGRESS) return cached;
  if (cached === IN_PROGRESS || seen.has(variable)) return cycleSummary();

  if (seen.size === 0) {
    const uniformAnalytics = uniformAnalyticsAliasSummary(context, variable);
    if (uniformAnalytics) return uniformAnalytics;
    const initialAlias = initialAliasBindingSummary(context, variable);
    if (initialAlias) return initialAlias;
  }

  cache.set(variable, IN_PROGRESS);
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  const assigned = bindingValues(context, variable);
  const { dynamicEntries, incomplete, onlyConstructions } =
    classifyBindingEntries(context, assigned, nextSeen);

  const fallback = receiverFallback(
    context,
    variable,
    assigned,
    onlyConstructions
  );
  const points = bindingChangePoints(context, dynamicEntries, nextSeen);
  const dynamicValues = Object.freeze(
    dynamicEntries.map((entry) => entry.value)
  );
  const result = Object.freeze({
    changePoints: points,
    dynamicEntries: Object.freeze(dynamicEntries),
    dynamicValues,
    fallback,
    incomplete,
    result:
      dynamicEntries.length > 0
        ? RECEIVER_CLASSIFICATION.CALL_SENSITIVE
        : incomplete
          ? RECEIVER_CYCLE_INCOMPLETE
          : fallback,
  });
  // A nested incomplete summary can still depend on its active ancestor and
  // must not escape (the Round 32 warm-order case). At the top level there is
  // no missing ancestor: the traversal has observed every external origin,
  // and a back-edge contributes no new one, so the root result is stable.
  if (!incomplete || seen.size === 0) cache.set(variable, result);
  else cache.delete(variable);
  return result;
}

function classifyBindingEntries(context, assigned, seen) {
  let onlyConstructions = assigned.entries.length > 0 && !assigned.opaqueWrite;
  const dynamicEntries = [];
  let incomplete = false;
  for (const entry of assigned.entries) {
    const value = entry.value;
    if (
      stableProvenConstruction(context, value, seen) ===
      CONSTRUCTION_CLASSIFICATION.PROVEN
    ) {
      continue;
    }
    onlyConstructions = false;
    const stable = trustedFactoryCall(context, value)
      ? RECEIVER_CLASSIFICATION.ANALYTICS
      : stableReceiverValue(context, value, seen);
    if (stable === RECEIVER_CYCLE_INCOMPLETE) {
      incomplete = true;
      continue;
    }
    if (stable !== RECEIVER_CLASSIFICATION.NON_ANALYTICS) {
      dynamicEntries.push(entry);
    }
  }
  return { dynamicEntries, incomplete, onlyConstructions };
}

function receiverFallback(context, variable, assigned, onlyConstructions) {
  return assigned.opaqueWrite
    ? RECEIVER_CLASSIFICATION.ANALYTICS
    : onlyConstructions
      ? RECEIVER_CLASSIFICATION.NON_ANALYTICS
      : analyticsNames(context).has(variable.name)
        ? RECEIVER_CLASSIFICATION.ANALYTICS
        : RECEIVER_CLASSIFICATION.NON_ANALYTICS;
}

function bindingChangePoints(context, entries, seen) {
  const points = [];
  for (const entry of entries) {
    const point = gateChangePoint(entry);
    if (point !== null) points.push(point);
    points.push(...valueChangePoints(context, entry.value, seen));
  }
  points.sort((left, right) => left - right);
  return Object.freeze([...new Set(points)]);
}

function intervalIndex(points, offset) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle] < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function intervalKey(points, callNode) {
  if (receiverCallIsDeferred(callNode)) return 'deferred';
  const offset = callNode?.range?.[0];
  return Number.isFinite(offset) ? intervalIndex(points, offset) : 'unknown';
}

function receiverResults(context, variable) {
  return contextKeyedMap(receiverResultCache, context, variable);
}

function classifyIdentifierReceiver(context, current, callNode, seen) {
  const variable = resolveVariable(context, current);
  if (!variable) return analyticsNames(context).has(current.name);
  if (seen.has(variable)) return false;
  const cacheable = seen.size === 0;
  const nextSeen = new Set(seen);
  nextSeen.add(variable);

  const summary = receiverBindingSummary(context, variable);
  if (summary.result === RECEIVER_CYCLE_INCOMPLETE) return true;
  if (summary.result !== RECEIVER_CLASSIFICATION.CALL_SENSITIVE) {
    return summary.result === RECEIVER_CLASSIFICATION.ANALYTICS;
  }
  const key = intervalKey(summary.changePoints, callNode);
  const results = receiverResults(context, variable);
  if (cacheable && results.has(key)) return results.get(key);

  let result = summary.fallback === RECEIVER_CLASSIFICATION.ANALYTICS;
  for (const entry of summary.dynamicEntries) {
    if (!entry.initial && !receiverWriteReachesCall(entry.gate, callNode)) {
      continue;
    }
    if (classifyReceiver(context, entry.value, callNode, nextSeen)) {
      result = true;
      break;
    }
  }
  if (cacheable) results.set(key, result);
  return result;
}

function memberResults(context, variable, name) {
  const perVariable = contextKeyedMap(
    memberReceiverResultCache,
    context,
    variable
  );
  return getOrCreateMap(perVariable, name);
}

function classMemberSummary(context, identity, name, object) {
  const perBody = contextKeyedMap(
    classMemberSummaryCache,
    context,
    identity.body
  );
  const cacheKey = `${identity.isStatic ? '1' : '0'}\u0000${name}`;
  let summary = perBody.get(cacheKey);
  if (summary) return summary;
  const candidates = Object.freeze(
    receiverPropertyCandidates(context, object, name, null, true)
  );
  const points = candidates.flatMap((candidate) =>
    valueChangePoints(context, candidate)
  );
  points.sort((left, right) => left - right);
  summary = Object.freeze({
    candidates,
    changePoints: Object.freeze([...new Set(points)]),
    results: new Map(),
  });
  perBody.set(cacheKey, summary);
  return summary;
}

function classifyMemberReceiver(context, current, callNode, seen) {
  const name = staticPropertyName(context, current);
  if (name === null || seen.has(current)) return false;
  const object = unwrap(current.object);
  const classIdentity =
    seen.size === 0 ? classReceiverIdentity(context, current.object) : null;
  const variable =
    !classIdentity && seen.size === 0 && object?.type === 'Identifier'
      ? resolveVariable(context, object)
      : null;
  const classSummary = classIdentity
    ? classMemberSummary(context, classIdentity, name, current.object)
    : null;
  const results =
    classSummary?.results ??
    (variable ? memberResults(context, variable, name) : null);
  const key = results
    ? intervalKey(
        classSummary?.changePoints ??
          receiverPropertyChangePoints(context, current.object, name, true),
        callNode
      )
    : null;
  if (results?.has(key)) return results.get(key);

  incrementAnalysisStat(
    context,
    classSummary ? 'classMemberComputations' : 'memberReceiverComputations'
  );
  const nextSeen = new Set(seen);
  nextSeen.add(current);
  const candidates =
    classSummary?.candidates ??
    receiverPropertyCandidates(context, current.object, name, callNode, true);
  for (const candidate of candidates) {
    if (
      classifyReceiver(context, candidate, callNode, nextSeen) ||
      !provenConstruction(context, candidate, callNode, nextSeen)
    ) {
      if (results) results.set(key, true);
      return true;
    }
  }
  const result =
    candidates.length === 0 ? analyticsNames(context).has(name) : false;
  if (results) results.set(key, result);
  return result;
}

function classifyReceiver(context, node, callNode, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return false;
  if (current.type === 'ConditionalExpression') {
    return (
      classifyReceiver(context, current.consequent, callNode, seen) ||
      classifyReceiver(context, current.alternate, callNode, seen)
    );
  }
  if (current.type === 'LogicalExpression') {
    return (
      classifyReceiver(context, current.left, callNode, seen) ||
      classifyReceiver(context, current.right, callNode, seen)
    );
  }
  if (current.type === 'AwaitExpression') return true;
  if (isPoisonedIdentityWrapper(context, current)) return true;
  const identityValue = identityWrappedValue(context, current);
  if (identityValue) {
    return classifyReceiver(context, identityValue, callNode, seen);
  }
  const proxy = proxyConstruction(context, current);
  if (proxy) {
    return (
      !proxy.transparent ||
      !proxy.target ||
      classifyReceiver(context, proxy.target, callNode, seen)
    );
  }
  if (current.type === 'Identifier') {
    return classifyIdentifierReceiver(context, current, callNode, seen);
  }
  if (current.type === 'MemberExpression') {
    return classifyMemberReceiver(context, current, callNode, seen);
  }
  if (current.type === 'NewExpression') return false;
  return current.type === 'CallExpression'
    ? trustedFactoryCall(context, current)
    : false;
}

module.exports = {
  CONSTRUCTION_CLASSIFICATION,
  RECEIVER_CLASSIFICATION,
  classifyReceiver,
  intervalKey,
  receiverBindingSummary,
  stableProvenConstruction,
  stableReceiverValue,
};
