'use strict';

const {
  OPAQUE_GETTER_VALUE,
  isGetterReturnValue,
} = require('./receiver-alias-analysis');

const {
  contextKeyedMap,
  identityWrappedValue,
  indirectBoundCallable,
  isBuiltinNamespaceReference,
  isPoisonedIdentityWrapper,
  isPoisonedReturnTargetWrapper,
  receiverPropertyChangePoints,
  receiverWriteReachesCall,
  returnTargetWrappedValue,
  resolveVariable,
  singleDef,
  staticPropertyName,
  unwrap,
} = require('./shared');
const {
  bindingValues,
  contextWeakCache,
  incrementAnalysisStat,
} = require('./event-bindings');
const { EVENT_METHODS } = require('./event-options');
const { planStrongComponents } = require('./strong-component-analysis');
const {
  callablePropertyCandidates,
  callableProxyProjection,
  containerMemberName,
  forwardedBoundCallable,
} = require('./event-factory');
const { createEventCallNormalizer } = require('./event-call-normalization');
const {
  RECEIVER_CLASSIFICATION,
  classifyReceiver,
  intervalKey,
  stableReceiverValue,
} = require('./event-receiver');

const methodBindingCache = new WeakMap();
const methodAssignmentResultCache = new WeakMap();
const containerMethodResultCache = new WeakMap();
const identifierMethodResultCache = new WeakMap();
const METHOD_REFERENCE_DEPTH_LIMIT = 64;
const OBJECT_CALLABLE_WRAPPERS = new Set([
  'assign',
  'defineProperties',
  'defineProperty',
  'freeze',
  'preventExtensions',
  'seal',
  'setPrototypeOf',
]);
const OBJECT_RETURN_TARGET_WRAPPERS = new Set([
  'assign',
  'defineProperties',
  'defineProperty',
  'setPrototypeOf',
]);
const OBJECT_IDENTITY_WRAPPERS = new Set([
  'freeze',
  'preventExtensions',
  'seal',
]);
const EMPTY_METHOD_CANDIDATES = Object.freeze([]);
const EMPTY_METHOD_UNION = Object.freeze({
  cache: { value: EMPTY_METHOD_CANDIDATES },
  parts: EMPTY_METHOD_CANDIDATES,
});
const methodSummaryCache = new WeakMap();

function methodUnion(parts) {
  const compact = parts.filter(
    (part) => !part.union || part.union !== EMPTY_METHOD_UNION
  );
  if (compact.length === 0) return EMPTY_METHOD_UNION;
  if (compact.length === 1 && compact[0].union) return compact[0].union;
  return Object.freeze({
    cache: { value: null },
    parts: Object.freeze(compact),
  });
}

function flattenedMethodUnion(root) {
  if (root.cache.value) return root.cache.value;
  const values = [];
  const uniqueValues = new Set();
  const visitedUnions = new Set([root]);
  const stack = [{ at: 0, union: root }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.at >= frame.union.parts.length) {
      stack.pop();
      continue;
    }
    const part = frame.union.parts[frame.at++];
    if (part.union) {
      if (visitedUnions.has(part.union)) continue;
      visitedUnions.add(part.union);
      stack.push({ at: 0, union: part.union });
      continue;
    }
    if (uniqueValues.has(part.candidate)) continue;
    uniqueValues.add(part.candidate);
    values.push(part.candidate);
  }
  const result = Object.freeze(values);
  root.cache.value = result;
  return result;
}

function methodSummary(candidateUnion, changePointUnion, incomplete) {
  let perPoints = methodSummaryCache.get(candidateUnion);
  if (!perPoints) {
    perPoints = new WeakMap();
    methodSummaryCache.set(candidateUnion, perPoints);
  }
  let summaries = perPoints.get(changePointUnion);
  if (!summaries) {
    summaries = [];
    perPoints.set(changePointUnion, summaries);
  }
  const index = incomplete ? 1 : 0;
  if (summaries[index]) return summaries[index];
  const derived = { assignments: null, changePoints: null, values: null };
  const summary = Object.freeze({
    candidateUnion,
    changePointUnion,
    get assignments() {
      if (!derived.assignments) {
        derived.assignments = Object.freeze(
          flattenedMethodUnion(candidateUnion).filter(
            (candidate) => candidate.eventMethodAssignment
          )
        );
      }
      return derived.assignments;
    },
    get candidates() {
      return flattenedMethodUnion(candidateUnion);
    },
    get changePoints() {
      if (!derived.changePoints) {
        const assignmentPoints = flattenedMethodUnion(candidateUnion)
          .filter((candidate) => candidate.eventMethodAssignment)
          .map((candidate) => candidate.gate.range?.[0])
          .filter(Number.isFinite);
        derived.changePoints = Object.freeze(
          [
            ...new Set([
              ...flattenedMethodUnion(changePointUnion),
              ...assignmentPoints,
            ]),
          ].sort((left, right) => left - right)
        );
      }
      return derived.changePoints;
    },
    incomplete,
    get values() {
      if (!derived.values) {
        derived.values = Object.freeze(
          flattenedMethodUnion(candidateUnion).filter(
            (candidate) => !candidate.eventMethodAssignment
          )
        );
      }
      return derived.values;
    },
  });
  summaries[index] = summary;
  return summary;
}

const INCOMPLETE_METHOD_SUMMARY = methodSummary(
  EMPTY_METHOD_UNION,
  EMPTY_METHOD_UNION,
  true
);

function hasSpread(args) {
  return args.some((argument) => argument.type === 'SpreadElement');
}

function eventReference(context, node) {
  let current = unwrap(node);
  for (;;) {
    const wrapped =
      identityWrappedValue(context, current) ??
      returnTargetWrappedValue(context, current);
    if (!wrapped) return current;
    current = unwrap(wrapped);
  }
}

function unshadowedGlobal(context, node, name) {
  const current = unwrap(node);
  if (current?.type !== 'Identifier' || current.name !== name) return false;
  const variable = resolveVariable(context, current);
  return !variable || variable.defs.length === 0;
}

function shadowedObjectNamespace(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (current?.type !== 'Identifier') return false;
  const variable = resolveVariable(context, current);
  if (current.name === 'Object') return true;
  if (!variable || seen.has(variable)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  return bindingValues(context, variable).values.some((value) =>
    shadowedObjectNamespace(context, value, nextSeen)
  );
}

function suspiciousObjectWrapper(context, node) {
  const current = unwrap(node);
  if (current?.type !== 'CallExpression') return false;
  if (
    identityWrappedValue(context, current) ||
    returnTargetWrappedValue(context, current)
  ) {
    return false;
  }
  const callee = unwrap(current.callee);
  return (
    callee?.type === 'MemberExpression' &&
    OBJECT_CALLABLE_WRAPPERS.has(staticPropertyName(context, callee)) &&
    shadowedObjectNamespace(context, callee.object)
  );
}

function suspiciousReturnTargetWrapper(context, node) {
  const current = unwrap(node);
  if (
    current?.type !== 'CallExpression' ||
    !suspiciousObjectWrapper(context, current)
  ) {
    return false;
  }
  const callee = unwrap(current.callee);
  return (
    callee?.type === 'MemberExpression' &&
    OBJECT_RETURN_TARGET_WRAPPERS.has(staticPropertyName(context, callee))
  );
}

function lexicallyShadowedObjectNamespace(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (current?.type !== 'Identifier') return false;
  const variable = resolveVariable(context, current);
  if (current.name === 'Object') {
    return !!variable && variable.defs.length > 0;
  }
  if (!variable || seen.has(variable)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  return bindingValues(context, variable).values.some((value) =>
    lexicallyShadowedObjectNamespace(context, value, nextSeen)
  );
}

function suspiciousShadowedIdentityWrapper(context, node) {
  const current = unwrap(node);
  if (current?.type !== 'CallExpression') return false;
  const callee = unwrap(current.callee);
  return (
    callee?.type === 'MemberExpression' &&
    OBJECT_IDENTITY_WRAPPERS.has(staticPropertyName(context, callee)) &&
    lexicallyShadowedObjectNamespace(context, callee.object)
  );
}

function shadowedRevocableProxy(context, node, seen = new Set()) {
  if (seen.size > METHOD_REFERENCE_DEPTH_LIMIT) return false;
  const current = eventReference(context, node);
  if (!current) return false;
  if (
    current.type === 'MemberExpression' &&
    staticPropertyName(context, current) === 'proxy'
  ) {
    const owner = unwrap(current.object);
    const callee =
      owner?.type === 'CallExpression' ? unwrap(owner.callee) : null;
    return (
      callee?.type === 'MemberExpression' &&
      staticPropertyName(context, callee) === 'revocable' &&
      unwrap(callee.object)?.type === 'Identifier' &&
      unwrap(callee.object).name === 'Proxy' &&
      !isBuiltinNamespaceReference(context, callee.object, 'Proxy')
    );
  }
  if (current.type !== 'Identifier') return false;
  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  return bindingValues(context, variable).values.some((value) =>
    shadowedRevocableProxy(context, value, nextSeen)
  );
}

function suspiciousWrappedReceiver(context, node, seen = new Set()) {
  if (seen.size > METHOD_REFERENCE_DEPTH_LIMIT) return false;
  if (
    suspiciousReturnTargetWrapper(context, node) ||
    suspiciousShadowedIdentityWrapper(context, node)
  ) {
    return true;
  }
  const current = eventReference(context, node);
  if (current?.type === 'MemberExpression') {
    if (seen.has(current)) return false;
    const nextSeen = new Set(seen);
    nextSeen.add(current);
    return suspiciousWrappedReceiver(context, current.object, nextSeen);
  }
  if (current?.type !== 'Identifier') return false;
  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  return bindingValues(context, variable).values.some((value) =>
    suspiciousWrappedReceiver(context, value, nextSeen)
  );
}

function functionPrototypeMethod(context, node, method) {
  const current = eventReference(context, node);
  if (
    current?.type !== 'MemberExpression' ||
    staticPropertyName(context, current) !== method
  ) {
    return false;
  }
  const prototype = unwrap(current.object);
  return (
    prototype?.type === 'MemberExpression' &&
    staticPropertyName(context, prototype) === 'prototype' &&
    unshadowedGlobal(context, prototype.object, 'Function')
  );
}

function normalizedMethod(args, node, spreadArgs = hasSpread(args)) {
  return Object.freeze({ args, node, spreadArgs });
}

function sameMethod(left, right) {
  return (
    left.spreadArgs === right.spreadArgs &&
    left.args.length === right.args.length &&
    left.args.every((argument, index) => argument === right.args[index])
  );
}

function joinMethods(candidates, args, node, incomplete = false) {
  const found = candidates.filter(Boolean);
  if (found.length === 0) return null;
  const first = found[0];
  if (incomplete || !found.every((candidate) => sameMethod(first, candidate))) {
    return normalizedMethod(args, node, true);
  }
  return normalizedMethod(
    [...first.args, ...args],
    node,
    first.spreadArgs || hasSpread(args)
  );
}

function directMethodReference(context, node, args) {
  if (node.type !== 'MemberExpression') return null;
  const method = staticPropertyName(context, node);
  if (method === null || !EVENT_METHODS.has(method)) return null;
  return classifyReceiver(context, node.object, node)
    ? normalizedMethod(args, node)
    : null;
}

function boundMethodReference(context, node, args, callNode, seen) {
  if (node.type !== 'CallExpression') return null;
  const indirect = indirectBoundCallable(context, node);
  if (indirect) {
    if (indirect.opaque || !indirect.target) {
      return node.arguments.some((argument) =>
        methodReference(context, argument, [], callNode, seen)
      )
        ? normalizedMethod(args, node, true)
        : null;
    }
    const inner = methodReference(
      context,
      indirect.target,
      indirect.args,
      callNode,
      seen
    );
    return inner ? extendMethodReference(inner, args, node) : null;
  }
  const forwarded = forwardedBoundCallable(context, node);
  if (forwarded) {
    if (!forwarded.target) {
      return forwarded.opaque &&
        forwarded.evidence.some((candidate) =>
          methodReference(context, candidate, [], callNode, seen)
        )
        ? normalizedMethod(args, node, true)
        : null;
    }
    const inner = methodReference(
      context,
      forwarded.target,
      forwarded.args,
      callNode,
      seen
    );
    return inner ? extendMethodReference(inner, args, node) : null;
  }
  const callee = eventReference(context, node.callee);
  if (
    callee?.type !== 'MemberExpression' ||
    staticPropertyName(context, callee) !== 'bind'
  ) {
    return null;
  }
  const inner = methodReference(context, callee.object, [], callNode, seen);
  if (!inner) return null;
  const bound = node.arguments.slice(1);
  return normalizedMethod(
    [...inner.args, ...bound, ...args],
    node,
    inner.spreadArgs || hasSpread(node.arguments) || hasSpread(args)
  );
}

function patternPropertyName(property) {
  if (property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  return property.key.type === 'Literal' ? String(property.key.value) : null;
}

function trailingSpreadMayReplace(context, node, name, seen = new Set()) {
  if (seen.size > METHOD_REFERENCE_DEPTH_LIMIT) return false;
  const current = eventReference(context, node);
  if (!current) return false;
  if (current.type === 'ConditionalExpression') {
    return (
      trailingSpreadMayReplace(context, current.consequent, name, seen) ||
      trailingSpreadMayReplace(context, current.alternate, name, seen)
    );
  }
  if (current.type === 'LogicalExpression') {
    return (
      trailingSpreadMayReplace(context, current.left, name, seen) ||
      trailingSpreadMayReplace(context, current.right, name, seen)
    );
  }
  if (current.type === 'ObjectExpression') {
    let opaque = false;
    for (const property of current.properties) {
      if (property.type === 'SpreadElement') {
        opaque = true;
      } else if (patternPropertyName(property) === name) {
        opaque = false;
      }
    }
    return opaque;
  }
  if (current.type !== 'Identifier') return false;
  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  return bindingValues(context, variable).values.some((value) =>
    trailingSpreadMayReplace(context, value, name, nextSeen)
  );
}

function destructuringPath(pattern, target, path = []) {
  if (!pattern) return null;
  if (pattern === target) return path;
  if (pattern.type === 'AssignmentPattern') {
    return destructuringPath(pattern.left, target, path);
  }
  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      if (property.type !== 'Property') continue;
      const name = patternPropertyName(property);
      if (name === null) continue;
      const found = destructuringPath(property.value, target, [...path, name]);
      if (found) return found;
    }
  }
  if (pattern.type === 'ArrayPattern') {
    for (let index = 0; index < pattern.elements.length; index += 1) {
      const found = destructuringPath(pattern.elements[index], target, [
        ...path,
        String(index),
      ]);
      if (found) return found;
    }
  }
  return null;
}

function nestedReceiverCandidates(context, receiver, path, gate) {
  let candidates = [receiver];
  for (const name of path) {
    candidates = candidates.flatMap((candidate) =>
      callablePropertyCandidates(context, candidate, name, gate)
    );
  }
  return candidates;
}

function methodAtDestructuringPath(context, receiver, path, gate) {
  if (path.length === 0) return { candidates: [receiver], direct: false };
  const propertyName = path[path.length - 1];
  const candidates = nestedReceiverCandidates(
    context,
    receiver,
    path.slice(0, -1),
    gate
  );
  return {
    candidates: candidates.flatMap((candidate) =>
      callablePropertyCandidates(context, candidate, propertyName, gate)
    ),
    direct:
      EVENT_METHODS.has(propertyName) &&
      candidates.some((candidate) =>
        classifyReceiver(context, candidate, gate)
      ),
  };
}

function destructuredMethodReference(context, def, node, args, callNode, seen) {
  const path = destructuringPath(def.node.id, def.name);
  if (!path || path.length === 0) return null;
  const resolved = methodAtDestructuringPath(
    context,
    def.node.init,
    path,
    def.node
  );
  if (resolved.direct && resolved.candidates.length === 0) {
    return normalizedMethod(args, node);
  }
  const methods = [];
  if (resolved.direct) methods.push(normalizedMethod([], node));
  for (const candidate of resolved.candidates) {
    if (
      eventReference(context, candidate) ===
      eventReference(context, def.node.init)
    ) {
      methods.push(normalizedMethod([], node));
      continue;
    }
    methods.push(methodReference(context, candidate, [], callNode, seen));
  }
  return joinMethods(methods, args, node);
}

function destructuredAssignmentCandidate(reference) {
  const identifier = reference.identifier;
  if (!identifier) return null;
  let pattern = identifier;
  while (
    pattern.parent?.type === 'AssignmentPattern' ||
    pattern.parent?.type === 'Property' ||
    pattern.parent?.type === 'ObjectPattern' ||
    pattern.parent?.type === 'ArrayPattern'
  ) {
    pattern = pattern.parent;
  }
  const assignment = pattern.parent;
  if (
    assignment?.type !== 'AssignmentExpression' ||
    assignment.left !== pattern
  ) {
    return null;
  }
  const path = destructuringPath(pattern, identifier);
  if (!path || path.length === 0) return null;
  return Object.freeze({
    eventMethodAssignment: true,
    gate: assignment,
    propertyPath: Object.freeze(path),
    receiver: assignment.right,
  });
}

function collectMethodValueParts(context, node, blocked, parts) {
  const stack = [node];
  while (stack.length > 0) {
    const source = stack.pop();
    if (isPoisonedIdentityWrapper(context, source)) {
      parts.push({ candidate: source });
      continue;
    }
    const current = eventReference(context, source);
    if (!current) continue;
    if (current.type === 'AwaitExpression') {
      parts.push({ candidate: source });
      continue;
    }
    if (current.type === 'ConditionalExpression') {
      stack.push(current.alternate, current.consequent);
      continue;
    }
    if (current.type === 'LogicalExpression') {
      stack.push(current.right, current.left);
      continue;
    }
    if (current.type === 'MemberExpression') {
      const method = staticPropertyName(context, current);
      if (
        method !== null &&
        EVENT_METHODS.has(method) &&
        stableReceiverValue(context, current.object) !==
          RECEIVER_CLASSIFICATION.NON_ANALYTICS
      ) {
        parts.push({ candidate: source });
      }
      continue;
    }
    if (current.type === 'CallExpression') {
      const callee = eventReference(context, current.callee);
      if (
        callee?.type === 'MemberExpression' &&
        staticPropertyName(context, callee) === 'bind'
      ) {
        parts.push({ candidate: source });
      }
      continue;
    }
    if (current.type !== 'Identifier') continue;
    const dependency = resolveVariable(context, current);
    if (!dependency) continue;
    if (blocked.has(dependency)) {
      parts.push({ incomplete: true });
      continue;
    }
    const def = singleDef(dependency);
    if (def?.type === 'Variable' && def.node.id.type === 'ObjectPattern') {
      parts.push({ candidate: source });
      continue;
    }
    parts.push({ dependency });
  }
}

function methodBindingRecord(context, variable, blocked) {
  const parts = [];
  const binding = bindingValues(context, variable);
  for (const value of binding.values) {
    collectMethodValueParts(context, value, blocked, parts);
  }
  for (const reference of variable.references) {
    if (!reference.isWrite() || reference.init === true) continue;
    const candidate = destructuredAssignmentCandidate(reference);
    if (candidate) parts.push({ candidate });
  }
  return {
    changePoints: binding.entries
      .filter(
        (entry) => !entry.initial && Number.isFinite(entry.gate?.range?.[0])
      )
      .map((entry) => entry.gate.range[0]),
    dependencies: [
      ...new Set(parts.map((part) => part.dependency).filter(Boolean)),
    ],
    parts,
  };
}

function methodBindingSummary(context, variable, seen = new Set()) {
  const cache = contextWeakCache(methodBindingCache, context);
  const cached = cache.get(variable);
  if (cached) return cached;
  if (seen.has(variable)) return INCOMPLETE_METHOD_SUMMARY;

  const records = new Map();
  const pending = [variable];
  while (pending.length > 0) {
    const current = pending.pop();
    if (records.has(current) || cache.has(current) || seen.has(current)) {
      continue;
    }
    const record = methodBindingRecord(context, current, seen);
    records.set(current, record);
    for (let index = record.dependencies.length - 1; index >= 0; index -= 1) {
      const dependency = record.dependencies[index];
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

  const summaries = new Map();
  for (const componentIndex of order) {
    const component = components[componentIndex];
    const candidateParts = [];
    const changePointParts = [];
    let incomplete = cyclic[componentIndex];
    for (const member of component) {
      const record = records.get(member);
      for (const point of record.changePoints) {
        changePointParts.push({ candidate: point });
      }
      for (const part of record.parts) {
        if (part.incomplete) {
          incomplete = true;
          continue;
        }
        if (part.candidate) {
          incrementAnalysisStat(context, 'methodCandidateMergeVisits');
          candidateParts.push({ candidate: part.candidate });
          continue;
        }
        const target = componentOf.get(part.dependency);
        if (target === componentIndex) continue;
        const dependency =
          target === undefined
            ? (cache.get(part.dependency) ?? INCOMPLETE_METHOD_SUMMARY)
            : summaries.get(target);
        incomplete ||= dependency.incomplete;
        incrementAnalysisStat(context, 'methodCandidateMergeVisits');
        candidateParts.push({ union: dependency.candidateUnion });
        changePointParts.push({ union: dependency.changePointUnion });
      }
    }
    const summary = methodSummary(
      methodUnion(candidateParts),
      methodUnion(changePointParts),
      incomplete
    );
    summaries.set(componentIndex, summary);
    if (seen.size === 0) {
      for (const member of component) cache.set(member, summary);
    }
  }
  return summaries.get(componentOf.get(variable)) ?? INCOMPLETE_METHOD_SUMMARY;
}

function methodBindingCandidates(context, variable, seen = new Set()) {
  return methodBindingSummary(context, variable, seen).candidates;
}

function assignmentResults(context, variable) {
  return contextKeyedMap(methodAssignmentResultCache, context, variable);
}

function classifiedAssignmentMethod(context, variable, summary, callNode) {
  if (summary.assignments.length === 0) return null;
  const key = intervalKey(summary.changePoints, callNode);
  const results = assignmentResults(context, variable);
  if (results.has(key)) return results.get(key);

  incrementAnalysisStat(context, 'methodIntervalComputations');
  const candidates = [];
  let resultNode = callNode;
  for (const candidate of summary.assignments) {
    if (!receiverWriteReachesCall(candidate.gate, callNode)) continue;
    resultNode = candidate.gate;
    const resolved = methodAtDestructuringPath(
      context,
      candidate.receiver,
      candidate.propertyPath,
      candidate.gate
    );
    if (resolved.direct) {
      candidates.push(normalizedMethod([], candidate.gate));
    }
    if (!resolved.direct && resolved.candidates.length === 0) {
      candidates.push(null);
    }
    for (const value of resolved.candidates) {
      candidates.push(methodReference(context, value, [], candidate.gate));
    }
  }
  const result = joinMethods(candidates, [], resultNode);
  results.set(key, result);
  return result;
}

function containerMethodResults(context, variable, name) {
  const perVariable = contextKeyedMap(
    containerMethodResultCache,
    context,
    variable
  );
  let results = perVariable.get(name);
  if (!results) {
    results = new Map();
    perVariable.set(name, results);
  }
  return results;
}

function cacheableContainerCandidate(context, candidate, opaqueNode) {
  const current = eventReference(context, candidate);
  if (current === opaqueNode) return true;
  if (current?.type === 'MemberExpression') return true;
  if (current?.type !== 'CallExpression') return false;
  const callee = eventReference(context, current.callee);
  return (
    callee?.type === 'MemberExpression' &&
    staticPropertyName(context, callee) === 'bind' &&
    cacheableContainerCandidate(context, callee.object, opaqueNode)
  );
}

function extendMethodReference(method, args, node) {
  return normalizedMethod(
    [...method.args, ...args],
    node,
    method.spreadArgs || hasSpread(args)
  );
}

function getterMethodValueIsOpaque(
  context,
  node,
  callNode,
  seen,
  resolved = null
) {
  const current = eventReference(context, node);
  if (!current || current === OPAQUE_GETTER_VALUE) return true;
  if (
    current.type === 'ConditionalExpression' ||
    current.type === 'LogicalExpression'
  ) {
    const branches =
      current.type === 'ConditionalExpression'
        ? [current.consequent, current.alternate]
        : [current.left, current.right];
    return branches.some((branch) => {
      const method = methodReference(context, branch, [], callNode, seen);
      return getterMethodValueIsOpaque(context, branch, callNode, seen, method);
    });
  }
  if (current.type === 'MemberExpression') {
    const name = containerMemberName(context, current);
    if (name !== null && !seen.has(current)) {
      const nextSeen = new Set(seen);
      nextSeen.add(current);
      const candidates = callablePropertyCandidates(
        context,
        current.object,
        name,
        callNode,
        nextSeen
      );
      if (candidates.length > 0) {
        return candidates.some((candidate) => {
          const method = methodReference(
            context,
            candidate,
            [],
            callNode,
            nextSeen
          );
          return (
            method?.spreadArgs === true ||
            (!method &&
              !getterMethodCandidateIsProvenOrdinary(
                context,
                candidate,
                callNode,
                nextSeen
              ))
          );
        });
      }
    }
    if (resolved) return false;
    return !getterMethodCandidateIsProvenOrdinary(
      context,
      current,
      callNode,
      seen
    );
  }
  if (resolved) return false;
  if (current.type !== 'Identifier') return false;
  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return true;
  const binding = bindingValues(context, variable);
  if (binding.opaqueWrite || binding.values.length === 0) return true;
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  return binding.values.some((value) => {
    const method = methodReference(context, value, [], callNode, nextSeen);
    return getterMethodValueIsOpaque(
      context,
      value,
      callNode,
      nextSeen,
      method
    );
  });
}

function getterMethodCandidateIsProvenOrdinary(context, node, callNode, seen) {
  const current = eventReference(context, node);
  if (!current || current === OPAQUE_GETTER_VALUE) return false;
  if (
    current.type === 'ConditionalExpression' ||
    current.type === 'LogicalExpression'
  ) {
    const branches =
      current.type === 'ConditionalExpression'
        ? [current.consequent, current.alternate]
        : [current.left, current.right];
    return branches.every((branch) =>
      getterMethodCandidateIsProvenOrdinary(context, branch, callNode, seen)
    );
  }
  if (current.type === 'MemberExpression') {
    return (
      staticPropertyName(context, current) === 'track' &&
      getterMethodReceiverIsProvenOrdinary(context, current.object, seen)
    );
  }
  if (current.type !== 'Identifier') {
    return ![
      'AwaitExpression',
      'CallExpression',
      'TaggedTemplateExpression',
    ].includes(current.type);
  }
  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return false;
  const binding = bindingValues(context, variable);
  if (binding.opaqueWrite || binding.values.length === 0) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  return binding.values.every((value) =>
    getterMethodCandidateIsProvenOrdinary(context, value, callNode, nextSeen)
  );
}

function getterMethodReceiverIsProvenOrdinary(context, node, seen) {
  const current = eventReference(context, node);
  if (!current) return false;
  if (
    current.type === 'ConditionalExpression' ||
    current.type === 'LogicalExpression'
  ) {
    const branches =
      current.type === 'ConditionalExpression'
        ? [current.consequent, current.alternate]
        : [current.left, current.right];
    return branches.every((branch) =>
      getterMethodReceiverIsProvenOrdinary(context, branch, seen)
    );
  }
  if (current.type === 'CallExpression' || current.type === 'AwaitExpression') {
    return false;
  }
  if (current.type === 'MemberExpression') {
    return (
      stableReceiverValue(context, current) ===
        RECEIVER_CLASSIFICATION.NON_ANALYTICS &&
      getterMethodReceiverIsProvenOrdinary(context, current.object, seen)
    );
  }
  if (current.type !== 'Identifier') {
    return (
      stableReceiverValue(context, current) ===
      RECEIVER_CLASSIFICATION.NON_ANALYTICS
    );
  }
  const variable = resolveVariable(context, current);
  if (!variable) {
    return (
      stableReceiverValue(context, current) ===
      RECEIVER_CLASSIFICATION.NON_ANALYTICS
    );
  }
  if (seen.has(variable)) return false;
  const binding = bindingValues(context, variable);
  if (binding.opaqueWrite || binding.values.length === 0) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(variable);
  return binding.values.every((value) =>
    getterMethodReceiverIsProvenOrdinary(context, value, nextSeen)
  );
}

function resolveContainerMethod(context, current, callNode, seen) {
  const candidates = callablePropertyCandidates(
    context,
    current.object,
    containerMemberName(context, current),
    callNode,
    seen
  );
  const opaqueNode = eventReference(context, current.object);
  const unresolved = candidates.some(
    (candidate) => eventReference(context, candidate) === opaqueNode
  );
  const methods = [];
  for (const candidate of candidates) {
    if (eventReference(context, candidate) === opaqueNode) continue;
    const method = methodReference(context, candidate, [], callNode, seen);
    if (method) methods.push(method);
    if (
      isGetterReturnValue(candidate) &&
      getterMethodValueIsOpaque(context, candidate, callNode, seen, method)
    ) {
      methods.push(normalizedMethod([], current, true));
    }
  }
  if (unresolved) {
    const owner = methodReference(context, current.object, [], callNode, seen);
    if (owner?.spreadArgs || methods.some((method) => method?.spreadArgs)) {
      methods.push(normalizedMethod([], current, true));
    } else if (
      methods.some(Boolean) ||
      trailingSpreadMayReplace(
        context,
        current.object,
        staticPropertyName(context, current),
        seen
      )
    ) {
      methods.push(normalizedMethod([], current));
    }
  }
  if (
    candidates.length === 0 &&
    suspiciousWrappedReceiver(context, current.object)
  ) {
    methods.push(normalizedMethod([], current, true));
  }
  const cacheable = candidates.every((candidate) =>
    cacheableContainerCandidate(context, candidate, opaqueNode)
  );
  return {
    cacheable,
    method: joinMethods(methods, [], current),
  };
}

function containerMethodReference(context, current, args, callNode, seen) {
  if (current.type !== 'MemberExpression') return null;
  const name = containerMemberName(context, current);
  if (name === null || seen.has(current)) {
    return null;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(current);
  const object = eventReference(context, current.object);
  const variable =
    seen.size === 0 && object?.type === 'Identifier'
      ? resolveVariable(context, object)
      : null;
  const results = variable
    ? containerMethodResults(context, variable, name)
    : null;
  const key = results
    ? intervalKey(
        receiverPropertyChangePoints(context, current.object, name, true),
        callNode
      )
    : null;
  if (results?.has(key)) {
    const cached = results.get(key);
    return cached ? extendMethodReference(cached, args, current) : null;
  }

  incrementAnalysisStat(context, 'containerMethodComputations');
  const resolved = resolveContainerMethod(context, current, callNode, nextSeen);
  if (results && resolved.cacheable) results.set(key, resolved.method);
  return resolved.method
    ? extendMethodReference(resolved.method, args, current)
    : null;
}

function branchedMethodReference(context, current, args, callNode, seen) {
  const branches =
    current.type === 'ConditionalExpression'
      ? [current.consequent, current.alternate]
      : current.type === 'LogicalExpression'
        ? [current.left, current.right]
        : null;
  return branches
    ? joinMethods(
        branches.map((branch) =>
          methodReference(context, branch, [], callNode, seen)
        ),
        args,
        current
      )
    : null;
}

function identifierMethodReference(context, current, args, callNode, seen) {
  const root = resolveVariable(context, current);
  if (!root || seen.has(root)) return null;
  const cacheable = seen.size === 0;
  const summary = methodBindingSummary(context, root);
  const key = intervalKey(summary.changePoints, callNode);
  const results = contextKeyedMap(identifierMethodResultCache, context, root);
  if (cacheable && results.has(key)) {
    const cached = results.get(key);
    return cached ? extendMethodReference(cached, args, current) : null;
  }

  incrementAnalysisStat(context, 'identifierMethodComputations');
  const methods = [];
  const visited = new Set(seen);
  const pending = [{ node: current }];
  let opaqueBinding = false;
  while (pending.length > 0) {
    const item = pending.pop();
    const source = item.node;
    if (
      !isPoisonedIdentityWrapper(context, source) &&
      !isPoisonedReturnTargetWrapper(context, source) &&
      !suspiciousObjectWrapper(context, source)
    ) {
      const value = eventReference(context, source);
      if (
        value?.type === 'ConditionalExpression' ||
        value?.type === 'LogicalExpression'
      ) {
        const branches =
          value.type === 'ConditionalExpression'
            ? [value.consequent, value.alternate]
            : [value.left, value.right];
        pending.push({ node: branches[1] }, { node: branches[0] });
        continue;
      }
      if (value?.type === 'Identifier') {
        const variable = resolveVariable(context, value);
        if (!variable || visited.has(variable)) continue;
        const def = singleDef(variable);
        if (!def || def.type !== 'Variable') continue;
        visited.add(variable);
        const nextSeen = new Set(visited);
        const destructured = destructuredMethodReference(
          context,
          def,
          value,
          [],
          callNode,
          nextSeen
        );
        if (destructured) methods.push(destructured);
        const variableSummary = methodBindingSummary(context, variable);
        const assigned = classifiedAssignmentMethod(
          context,
          variable,
          variableSummary,
          callNode
        );
        if (assigned) methods.push(assigned);
        const representedGates = new Set(
          variableSummary.assignments.map((candidate) => candidate.gate)
        );
        const binding = bindingValues(context, variable);
        opaqueBinding ||= binding.opaqueWrite && !destructured && !assigned;
        for (let index = binding.entries.length - 1; index >= 0; index -= 1) {
          incrementAnalysisStat(context, 'methodBindingEntryVisits');
          const entry = binding.entries[index];
          if (
            (destructured && entry.initial) ||
            representedGates.has(entry.gate) ||
            (!entry.initial && !receiverWriteReachesCall(entry.gate, callNode))
          ) {
            continue;
          }
          pending.push({ node: entry.value });
        }
        continue;
      }
    }
    methods.push(methodReference(context, source, [], callNode, seen));
  }
  const result = joinMethods(
    methods,
    [],
    current,
    opaqueBinding && methods.some(Boolean)
  );
  if (cacheable) results.set(key, result);
  return result ? extendMethodReference(result, args, current) : null;
}

function methodReference(context, node, args, callNode, seen = new Set()) {
  if (seen.size > METHOD_REFERENCE_DEPTH_LIMIT) {
    const current = unwrap(node);
    if (current?.type !== 'Identifier') return null;
    const variable = resolveVariable(context, current);
    if (!variable) return null;
    const summary = methodBindingSummary(context, variable);
    return summary.candidates.length > 0 || summary.incomplete
      ? normalizedMethod(args, node, true)
      : null;
  }
  if (
    isPoisonedIdentityWrapper(context, node) ||
    isPoisonedReturnTargetWrapper(context, node) ||
    suspiciousObjectWrapper(context, node)
  ) {
    return normalizedMethod(args, node, true);
  }
  const current = eventReference(context, node);
  if (!current) return null;
  if (current === OPAQUE_GETTER_VALUE) {
    return normalizedMethod(args, node, true);
  }
  if (current.type === 'AwaitExpression') {
    return normalizedMethod(args, current, true);
  }
  const proxy = callableProxyProjection(context, current, seen);
  if (proxy) {
    if (proxy.opaque) return normalizedMethod(args, current, true);
    if (!proxy.target) return null;
    const inner = methodReference(context, proxy.target, [], callNode, seen);
    if (!inner) return null;
    return normalizedMethod(
      [...inner.args, ...args],
      current,
      inner.spreadArgs || hasSpread(args)
    );
  }
  const branched = branchedMethodReference(
    context,
    current,
    args,
    callNode,
    seen
  );
  if (branched) return branched;
  const direct = directMethodReference(context, current, args);
  if (direct) return direct;
  const bound = boundMethodReference(context, current, args, callNode, seen);
  if (bound) return bound;
  const contained = containerMethodReference(
    context,
    current,
    args,
    callNode,
    seen
  );
  if (contained || current.type !== 'Identifier') return contained;
  return identifierMethodReference(context, current, args, callNode, seen);
}

const normalizeEventCall = createEventCallNormalizer({
  eventReference,
  functionPrototypeMethod,
  hasSpread,
  methodReference,
  normalizedMethod,
  shadowedRevocableProxy,
  suspiciousWrappedReceiver,
});

module.exports = {
  hasSpread,
  methodBindingCandidates,
  normalizeEventCall,
};
