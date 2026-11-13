'use strict';

const {
  createBuiltinMethodAnalysisUnit,
} = require('./builtin-method-analysis');

function createBuiltinForwarderAnalysisUnit(
  dependencies,
  {
    analysisState,
    context,
    methodAnalysis,
    namespacePatternMethods,
    poisoned,
    possibleBuiltinNamespaceValues,
    referenceNamespacePatternMethods,
    resolveReturnTargetCall,
    staticContainerMemberValues,
    staticContainerPatternValues,
    staticMemberKey,
  }
) {
  const {
    ALL_NAMESPACES_POISONED,
    BUILTIN_CALLABLE_NAMESPACES,
    identityWrapper,
    normalizeStaticArguments,
    possibleEvalReference,
    projectPatternBinding,
    receiverAnalysisStats,
    resolveBindingSetComponents,
    resolveVariable,
    singleDef,
    unwrap,
  } = dependencies;
  const {
    builtinCallableBindingSources,
    directCallableBindingDependencies,
    possibleBuiltinMethods,
  } = methodAnalysis;

  const normalizeArgumentList = (elements) =>
    normalizeStaticArguments(context, elements);

  const unpackStaticArguments = (node) => {
    return normalizeArgumentList([{ type: 'SpreadElement', argument: node }]);
  };

  const functionPrototypeOwner = (node) => {
    const current = unwrap(node);
    if (current?.type !== 'MemberExpression') return false;
    const prototype = unwrap(current.object);
    return (
      prototype?.type === 'MemberExpression' &&
      staticMemberKey(prototype) === 'prototype' &&
      possibleBuiltinNamespaceValues(prototype.object).has('Function')
    );
  };

  const functionPrototypeForwarder = (node) => {
    const current = unwrap(node);
    const method =
      current?.type === 'MemberExpression' ? staticMemberKey(current) : null;
    return functionPrototypeOwner(current) &&
      ['apply', 'bind', 'call'].includes(method)
      ? method
      : null;
  };

  const incompleteForwarders = () => {
    const forwarders = new Set(['call', 'apply']);
    analysisState.incompleteForwarderSets.add(forwarders);
    return forwarders;
  };

  const possibleFunctionForwarders = (node, seen = new Set()) => {
    const current = unwrap(node);
    if (!current) return new Set();
    const returned = resolveReturnTargetCall(current, false);
    if (returned) {
      if (
        returned.opaque ||
        poisoned.has(ALL_NAMESPACES_POISONED) ||
        poisoned.has('Object')
      ) {
        return new Set(['apply', 'bind', 'call']);
      }
      return possibleFunctionForwarders(returned.arguments[0], seen);
    }
    const identity = identityWrapper(context, current);
    if (identity) {
      if (poisoned.has(ALL_NAMESPACES_POISONED) || poisoned.has('Object')) {
        return new Set(['apply', 'bind', 'call']);
      }
      return possibleFunctionForwarders(identity.arguments[0], seen);
    }
    if (current.type === 'ConditionalExpression') {
      const consequent = possibleFunctionForwarders(current.consequent, seen);
      const alternate = possibleFunctionForwarders(current.alternate, seen);
      const forwarders = new Set([...consequent, ...alternate]);
      if (
        forwarders.size > 0 &&
        (consequent.size === 0 || alternate.size === 0)
      ) {
        return new Set(['apply', 'bind', 'call']);
      }
      return forwarders;
    }
    if (current.type === 'LogicalExpression') {
      const left = possibleFunctionForwarders(current.left, seen);
      const right = possibleFunctionForwarders(current.right, seen);
      const forwarders = new Set([...left, ...right]);
      if (forwarders.size > 0 && (left.size === 0 || right.size === 0)) {
        return new Set(['apply', 'bind', 'call']);
      }
      return forwarders;
    }
    const direct = functionPrototypeForwarder(current);
    if (direct) return new Set([direct]);
    if (current.type === 'MemberExpression') {
      if (seen.has(current)) return incompleteForwarders();
      const nextSeen = new Set(seen);
      nextSeen.add(current);
      const projection = staticContainerMemberValues(current, nextSeen);
      const candidates = projection.values.map((value) =>
        possibleFunctionForwarders(value, nextSeen)
      );
      const stored = new Set(candidates.flatMap((candidate) => [...candidate]));
      if (stored.size > 0) {
        if (
          projection.opaque ||
          candidates.some((candidate) => candidate.size === 0)
        ) {
          return new Set(['apply', 'bind', 'call']);
        }
        return stored;
      }
      const method = staticMemberKey(current);
      const callable =
        functionPrototypeOwner(current) ||
        [...possibleBuiltinNamespaceValues(current.object)].some((namespace) =>
          BUILTIN_CALLABLE_NAMESPACES.has(namespace)
        ) ||
        possibleBuiltinMethods(current.object).size > 0 ||
        possibleFunctionForwarders(current.object, nextSeen).size > 0;
      if (callable) {
        return method === null
          ? new Set(['apply', 'bind', 'call'])
          : ['apply', 'bind', 'call'].includes(method)
            ? new Set([method])
            : new Set();
      }
      return new Set();
    }
    if (current.type === 'CallExpression') {
      const callee = unwrap(current.callee);
      return callee?.type === 'MemberExpression' &&
        staticMemberKey(callee) === 'bind'
        ? possibleFunctionForwarders(callee.object, seen)
        : new Set();
    }
    if (current.type !== 'Identifier') return new Set();
    const variable = resolveVariable(context, current);
    if (!variable) return new Set();
    if (seen.has(variable)) return incompleteForwarders();
    return resolveBindingSetComponents({
      analysisStats: receiverAnalysisStats.get(context),
      cache: analysisState.functionForwarderCache,
      createPlaceholder: incompleteForwarders,
      dependenciesOf: directCallableBindingDependencies,
      evaluate: (source) => possibleFunctionForwarders(source),
      incompleteSets: analysisState.incompleteForwarderSets,
      merge(descriptor, candidates) {
        const forwarders = new Set(
          candidates.flatMap((candidate) => [...candidate])
        );
        const mixed = candidates.some((candidate) => candidate.size === 0);
        if ((descriptor.opaque || mixed) && forwarders.size > 0) {
          for (const forwarder of ['apply', 'bind', 'call']) {
            forwarders.add(forwarder);
          }
        }
        return { values: forwarders };
      },
      onDiscover() {
        const stats = receiverAnalysisStats.get(context);
        if (stats) stats.forwarderBindingComputations += 1;
      },
      omitPlaceholders: true,
      read: builtinCallableBindingSources,
      rootVariable: variable,
    });
  };

  const normalizeForwardedCall = (call) => {
    const callee = unwrap(call.callee);
    let callable = call.callee;
    let thisArg = null;
    let rawArgs = call.arguments;
    let opaque = false;
    if (
      !functionPrototypeForwarder(callee) &&
      callee?.type === 'MemberExpression'
    ) {
      const forwarding = staticMemberKey(callee);
      const baseCallable =
        possibleBuiltinMethods(callee.object).size > 0 ||
        possibleFunctionForwarders(callee.object).size > 0;
      if ((forwarding === 'call' || forwarding === 'apply') && baseCallable) {
        callable = callee.object;
        thisArg = call.arguments[0];
        if (forwarding === 'call') {
          rawArgs = call.arguments.slice(1);
        } else {
          const unpacked = unpackStaticArguments(call.arguments[1]);
          rawArgs = unpacked.args;
          opaque = unpacked.opaque;
        }
      }
    }
    return { callable, opaque, rawArgs, thisArg };
  };

  const advanceFunctionForwarder = (forwarder, callable, args) => {
    if (forwarder === 'call') {
      return {
        callable,
        opaque: false,
        rawArgs: args.slice(1),
        thisArg: args[0],
      };
    }
    const unpacked = unpackStaticArguments(args[1]);
    return {
      callable,
      opaque: unpacked.opaque,
      rawArgs: unpacked.args,
      thisArg: args[0],
    };
  };

  const unwindForwardedCallable = ({
    analyzeInvalid,
    initial,
    invalid,
    visit,
  }) => {
    let state = initial;
    const seen = new Set();
    for (let depth = 0; ; depth += 1) {
      const current = unwrap(state.target);
      if (!current || depth > 32 || seen.has(current)) {
        const methods =
          analyzeInvalid && current
            ? possibleBuiltinMethods(current)
            : new Set();
        const forwarders =
          analyzeInvalid && current
            ? possibleFunctionForwarders(current)
            : new Set();
        return invalid({ current, forwarders, methods, state });
      }
      seen.add(current);
      const outcome = visit({
        current,
        forwarders: possibleFunctionForwarders(current),
        methods: possibleBuiltinMethods(current),
        state,
      });
      if (Object.hasOwn(outcome, 'value')) return outcome.value;
      state = outcome.next;
    }
  };

  const indirectBindResult = (call) => {
    const { callable, opaque, rawArgs, thisArg } = normalizeForwardedCall(call);
    const unknown = () => ({
      args: [],
      opaque: true,
      target: null,
      thisArg: null,
    });
    return unwindForwardedCallable({
      analyzeInvalid: false,
      initial: {
        target: callable,
        targetArgs: rawArgs,
        targetOpaque: opaque,
        targetThis: thisArg,
      },
      invalid: unknown,
      visit({ forwarders, methods, state }) {
        if (methods.size === 0 && forwarders.size === 0) {
          return { value: null };
        }
        const normalized = normalizeArgumentList(state.targetArgs);
        const args = normalized.args;
        const opaqueArgs = state.targetOpaque || normalized.opaque;
        if (methods.has('Reflect:apply')) {
          if (methods.size > 1 || opaqueArgs) return { value: unknown() };
          const unpacked = unpackStaticArguments(args[2]);
          return {
            next: {
              target: args[0],
              targetArgs: unpacked.args,
              targetOpaque: unpacked.opaque,
              targetThis: args[1],
            },
          };
        }
        if (methods.size > 0 && forwarders.size === 0) {
          return { value: null };
        }
        if (forwarders.size !== 1 || opaqueArgs) {
          return { value: unknown() };
        }
        const forwarder = forwarders.values().next().value;
        if (forwarder === 'bind') {
          return {
            value: {
              args: args.slice(1),
              opaque: false,
              target: state.targetThis,
              thisArg: args[0],
            },
          };
        }
        if (!state.targetThis) return { value: unknown() };
        const next = advanceFunctionForwarder(
          forwarder,
          state.targetThis,
          args
        );
        return {
          next: {
            target: next.callable,
            targetArgs: next.rawArgs,
            targetOpaque: next.opaque,
            targetThis: next.thisArg,
          },
        };
      },
    });
  };

  const boundCallableState = (node, seen = new Set()) => {
    const current = unwrap(node);
    if (!current) {
      return { args: [], hasBoundThis: false, opaque: false, thisArg: null };
    }
    if (seen.has(current) || seen.size > 64) {
      return { args: [], hasBoundThis: false, opaque: true, thisArg: null };
    }
    const nextSeen = new Set(seen);
    nextSeen.add(current);
    if (current.type === 'CallExpression') {
      const callee = unwrap(current.callee);
      if (
        callee?.type === 'MemberExpression' &&
        staticMemberKey(callee) === 'bind' &&
        (possibleBuiltinMethods(callee.object).size > 0 ||
          possibleFunctionForwarders(callee.object).size > 0)
      ) {
        const inner = boundCallableState(callee.object, nextSeen);
        const own = normalizeArgumentList(current.arguments.slice(1));
        return {
          args: [...inner.args, ...own.args],
          hasBoundThis: inner.hasBoundThis || current.arguments.length > 0,
          opaque: inner.opaque || own.opaque,
          thisArg: inner.hasBoundThis ? inner.thisArg : current.arguments[0],
        };
      }
      const indirect = indirectBindResult(current);
      if (indirect) {
        if (indirect.opaque || !indirect.target) {
          return {
            args: [],
            hasBoundThis: false,
            opaque: true,
            thisArg: null,
          };
        }
        const inner = boundCallableState(indirect.target, nextSeen);
        const own = normalizeArgumentList(indirect.args);
        return {
          args: [...inner.args, ...own.args],
          hasBoundThis: inner.hasBoundThis || !!indirect.thisArg,
          opaque: inner.opaque || own.opaque,
          thisArg: inner.hasBoundThis ? inner.thisArg : indirect.thisArg,
        };
      }
      return { args: [], hasBoundThis: false, opaque: false, thisArg: null };
    }
    if (current.type !== 'Identifier') {
      return { args: [], hasBoundThis: false, opaque: false, thisArg: null };
    }
    const variable = resolveVariable(context, current);
    if (!variable || seen.has(variable)) {
      return { args: [], hasBoundThis: false, opaque: false, thisArg: null };
    }
    const def = singleDef(variable);
    let exactPatternMethod = false;
    if (def?.type === 'Variable' && def.node.init) {
      const projection = projectPatternBinding(
        def.node.id,
        def.name ?? def.node.id,
        def.node.init,
        context
      );
      const staticProjection = staticContainerPatternValues(
        def.node.id,
        def.name ?? def.node.id,
        def.node.init
      );
      exactPatternMethod =
        namespacePatternMethods(
          def.node.id,
          def.name ?? def.node.id,
          def.node.init
        ).size > 0;
      const values = [
        ...new Set([...staticProjection.values, ...projection.values]),
      ];
      const opaque =
        !exactPatternMethod &&
        (staticProjection.values.length > 0
          ? staticProjection.opaque
          : staticProjection.opaque || projection.opaque);
      if (values.length === 1) {
        const projected = boundCallableState(
          values[0],
          new Set([...nextSeen, variable])
        );
        return {
          ...projected,
          opaque: projected.opaque || opaque,
        };
      }
      if (values.length > 1 || opaque) {
        return { args: [], hasBoundThis: false, opaque: true, thisArg: null };
      }
    }
    if (!exactPatternMethod) {
      exactPatternMethod = variable.references.some(
        (reference) =>
          reference.isWrite() &&
          reference.init !== true &&
          referenceNamespacePatternMethods(reference).size > 0
      );
    }
    if (exactPatternMethod) {
      return { args: [], hasBoundThis: false, opaque: false, thisArg: null };
    }
    const callable =
      possibleBuiltinMethods(current).size > 0 ||
      possibleFunctionForwarders(current).size > 0;
    return {
      args: [],
      hasBoundThis: false,
      opaque: callable,
      thisArg: null,
    };
  };

  const possibleDynamicCallable = (node) => {
    const root = unwrap(node);
    if (!root) return false;
    if (analysisState.dynamicCallableNodeCache.has(root)) {
      return analysisState.dynamicCallableNodeCache.get(root);
    }

    // Build the reachable node/binding graph iteratively, then propagate
    // positive evidence backwards. This is an OR-domain: an evidence-free
    // SCC is false, while one eval/Function source makes every predecessor
    // that can reach it true. Separate node and variable records avoid both
    // JS-stack growth on long aliases and copied `seen` sets on every hop.
    const records = new Set();
    const nodeRecords = new WeakMap();
    const variableRecords = new WeakMap();
    const pending = [];
    const recordFor = (kind, value) => {
      const cache =
        kind === 'node'
          ? analysisState.dynamicCallableNodeCache
          : analysisState.dynamicCallableVariableCache;
      if (cache.has(value)) return { cached: cache.get(value) };
      const index = kind === 'node' ? nodeRecords : variableRecords;
      let record = index.get(value);
      if (!record) {
        record = {
          dependencies: new Set(),
          direct: false,
          kind,
          reverse: new Set(),
          value,
        };
        index.set(value, record);
        records.add(record);
        pending.push(record);
      }
      return { record };
    };
    const dependOn = (record, kind, value) => {
      const current = kind === 'node' ? unwrap(value) : value;
      if (!current) return;
      const dependency = recordFor(kind, current);
      if (dependency.cached === true) {
        record.direct = true;
      } else if (dependency.record) {
        record.dependencies.add(dependency.record);
        dependency.record.reverse.add(record);
      }
    };

    const rootRecord = recordFor('node', root).record;
    while (pending.length > 0) {
      const record = pending.pop();
      if (record.kind === 'variable') {
        for (const source of builtinCallableBindingSources(record.value)
          .sources) {
          dependOn(record, 'node', source);
        }
        continue;
      }

      const current = record.value;
      if (possibleEvalReference(context, current)) {
        record.direct = true;
        continue;
      }
      if (current.type === 'Identifier') {
        const variable = resolveVariable(context, current);
        if (!variable || variable.defs.length === 0) {
          record.direct =
            possibleBuiltinNamespaceValues(current).has('Function');
        } else {
          dependOn(record, 'variable', variable);
        }
        continue;
      }
      if (possibleBuiltinNamespaceValues(current).has('Function')) {
        record.direct = true;
        continue;
      }
      if (
        current.type === 'ConditionalExpression' ||
        current.type === 'LogicalExpression'
      ) {
        if (current.type === 'ConditionalExpression') {
          dependOn(record, 'node', current.consequent);
          dependOn(record, 'node', current.alternate);
        } else {
          dependOn(record, 'node', current.left);
          dependOn(record, 'node', current.right);
        }
        continue;
      }
      if (current.type === 'MemberExpression') {
        const projection = staticContainerMemberValues(current);
        for (const value of projection.values) {
          dependOn(record, 'node', value);
        }
        continue;
      }
      if (current.type === 'CallExpression') {
        const callee = unwrap(current.callee);
        if (
          callee?.type === 'MemberExpression' &&
          staticMemberKey(callee) === 'bind'
        ) {
          dependOn(record, 'node', callee.object);
        }
        const indirect = indirectBindResult(current);
        if (indirect?.target && !indirect.opaque) {
          dependOn(record, 'node', indirect.target);
        }
      }
    }

    const truths = [];
    for (const record of records) {
      if (record.direct) truths.push(record);
    }
    while (truths.length > 0) {
      const record = truths.pop();
      if (record.truth) continue;
      record.truth = true;
      for (const dependent of record.reverse) truths.push(dependent);
    }
    for (const record of records) {
      const cache =
        record.kind === 'node'
          ? analysisState.dynamicCallableNodeCache
          : analysisState.dynamicCallableVariableCache;
      cache.set(record.value, record.truth === true);
    }
    return rootRecord.truth === true;
  };

  const dynamicCodeCall = (call, reflective = null) => {
    if (call.type !== 'CallExpression') {
      return possibleBuiltinNamespaceValues(call.callee).has('Function');
    }
    const directCallee = unwrap(call.callee);
    if (directCallee?.type === 'MemberExpression') {
      const method = staticMemberKey(directCallee);
      if (
        (method === 'call' || method === 'apply') &&
        possibleDynamicCallable(directCallee.object)
      ) {
        return true;
      }
    }
    // A proven non-Function builtin method cannot execute source text. This
    // reuses the reflective normalization that the poison scan needs anyway,
    // avoiding a second projection of every ordinary Object/Reflect call.
    const directMethods = reflective?.methods ?? new Set();
    if (
      directMethods.size > 0 &&
      ![...directMethods].some(
        (method) => method.startsWith('Function:') || method === 'Reflect:apply'
      )
    ) {
      return false;
    }
    if (possibleDynamicCallable(directCallee)) return true;

    const { callable, opaque, rawArgs, thisArg } = normalizeForwardedCall(call);
    return unwindForwardedCallable({
      analyzeInvalid: true,
      initial: {
        target: callable,
        targetArgs: rawArgs,
        targetOpaque: opaque,
        targetThis: thisArg,
      },
      invalid: ({ current }) => possibleDynamicCallable(current),
      visit({ current, forwarders, methods, state }) {
        if (possibleDynamicCallable(current)) return { value: true };
        const normalized = normalizeArgumentList(state.targetArgs);
        const args = normalized.args;
        const opaqueArgs = state.targetOpaque || normalized.opaque;
        if (methods.has('Reflect:apply')) {
          if (args[0] && possibleDynamicCallable(args[0])) {
            return { value: true };
          }
          if (methods.size > 1 || opaqueArgs) return { value: false };
          const unpacked = unpackStaticArguments(args[2]);
          return {
            next: {
              target: args[0],
              targetArgs: unpacked.args,
              targetOpaque: unpacked.opaque,
              targetThis: args[1],
            },
          };
        }
        if (forwarders.size !== 1) return { value: false };
        const bound = boundCallableState(current);
        const effectiveThis = bound.hasBoundThis
          ? bound.thisArg
          : state.targetThis;
        if (effectiveThis && possibleDynamicCallable(effectiveThis)) {
          return { value: true };
        }
        if (opaqueArgs || !effectiveThis) return { value: false };
        const forwarder = forwarders.values().next().value;
        if (forwarder === 'bind') return { value: false };
        const next = advanceFunctionForwarder(forwarder, effectiveThis, args);
        return {
          next: {
            target: next.callable,
            targetArgs: next.rawArgs,
            targetOpaque: next.opaque,
            targetThis: next.thisArg,
          },
        };
      },
    });
  };

  const reflectiveCall = createReflectiveCallUnit(dependencies, {
    advanceFunctionForwarder,
    boundCallableState,
    normalizeArgumentList,
    normalizeForwardedCall,
    staticMemberKey,
    unpackStaticArguments,
    unwindForwardedCallable,
  });

  return Object.freeze({
    dynamicCodeCall,
    indirectBindResult,
    reflectiveCall,
  });
}

function createBuiltinBindingMethodForwarderUnit(dependencies, options) {
  const { RETURN_TARGET_OBJECT_METHOD_ARITY, unwrap } = dependencies;
  const state = {
    builtinMethodCache: new WeakMap(),
    dynamicCallableNodeCache: new WeakMap(),
    dynamicCallableVariableCache: new WeakMap(),
    functionForwarderCache: new WeakMap(),
    incompleteBuiltinMethodSets: new WeakSet(),
    incompleteForwarderSets: new WeakSet(),
    indirectBindResult: null,
    reflectiveCall: null,
  };
  const resolveReturnTargetCall = (node, failClosed = true) => {
    const call = unwrap(node);
    if (call?.type !== 'CallExpression' || !state.reflectiveCall) return null;
    const normalized = state.reflectiveCall(call);
    if (!normalized) return null;
    const targetMethods = [];
    for (const builtin of normalized.methods) {
      const separator = builtin.indexOf(':');
      const namespace = builtin.slice(0, separator);
      const method = builtin.slice(separator + 1);
      if (
        namespace === 'Object' &&
        (method === '*' || RETURN_TARGET_OBJECT_METHOD_ARITY.has(method))
      ) {
        targetMethods.push(method);
      }
    }
    if (targetMethods.length === 0) return null;
    const exact =
      !normalized.unknown &&
      !normalized.opaqueArgs &&
      normalized.methods.size === 1 &&
      targetMethods.length === 1 &&
      targetMethods[0] !== '*';
    if (!exact) {
      if (!failClosed) return null;
      return Object.freeze({
        call,
        arguments: [],
        method: null,
        opaque: true,
      });
    }
    const arity = RETURN_TARGET_OBJECT_METHOD_ARITY.get(targetMethods[0]);
    return normalized.args.length >= arity
      ? Object.freeze({
          call,
          arguments: normalized.args,
          method: targetMethods[0],
          opaque: false,
        })
      : null;
  };
  const method = createBuiltinMethodAnalysisUnit(dependencies, {
    ...options,
    resolveReturnTargetCall,
    state,
  });
  const forwarder = createBuiltinForwarderAnalysisUnit(dependencies, {
    ...options,
    analysisState: state,
    methodAnalysis: method,
    resolveReturnTargetCall,
  });
  state.indirectBindResult = forwarder.indirectBindResult;
  state.reflectiveCall = forwarder.reflectiveCall;

  return Object.freeze({
    dynamicCodeCall: forwarder.dynamicCodeCall,
    indirectBindResult: forwarder.indirectBindResult,
    reflectiveCall: forwarder.reflectiveCall,
    resetPoisonSensitiveCaches() {
      // Calls encountered during the scan may precede a later write to Object
      // or Function. Only these two caches read `poisoned`; container and
      // namespace-value provenance is syntax-only and remains valid.
      state.builtinMethodCache = new WeakMap();
      state.dynamicCallableNodeCache = new WeakMap();
      state.dynamicCallableVariableCache = new WeakMap();
      state.functionForwarderCache = new WeakMap();
    },
    resolveReturnTargetCall,
  });
}

function createReflectiveCallUnit(
  dependencies,
  {
    advanceFunctionForwarder,
    boundCallableState,
    normalizeArgumentList,
    normalizeForwardedCall,
    staticMemberKey,
    unpackStaticArguments,
    unwindForwardedCallable,
  }
) {
  const { unwrap } = dependencies;
  return (call) => {
    const callee = unwrap(call.callee);
    if (
      callee?.type === 'MemberExpression' &&
      staticMemberKey(callee) === 'bind'
    ) {
      return {
        args: [],
        methods: new Set(),
        opaqueArgs: false,
        unknown: false,
      };
    }
    const { callable, opaque, rawArgs, thisArg } = normalizeForwardedCall(call);
    return unwindForwardedCallable({
      analyzeInvalid: true,
      initial: {
        target: callable,
        targetArgs: rawArgs,
        targetOpaque: opaque,
        targetThis: thisArg,
      },
      invalid: ({ methods }) => ({
        args: [],
        methods,
        opaqueArgs: true,
        unknown: true,
      }),
      visit({ current, forwarders, methods, state }) {
        if (methods.size === 0 && forwarders.size === 0) {
          return {
            value: {
              args: [],
              methods,
              opaqueArgs: false,
              unknown: false,
            },
          };
        }
        const bound = boundCallableState(current);
        const directArgs = normalizeArgumentList(state.targetArgs);
        const args = [...bound.args, ...directArgs.args];
        const opaqueArgs =
          state.targetOpaque || bound.opaque || directArgs.opaque;
        const effectiveThis = bound.hasBoundThis
          ? bound.thisArg
          : state.targetThis;
        if (methods.has('Reflect:apply')) {
          if (methods.size > 1 || opaqueArgs) {
            return {
              value: {
                args: [],
                methods,
                opaqueArgs: true,
                unknown: true,
              },
            };
          }
          const unpacked = unpackStaticArguments(args[2]);
          return {
            next: {
              target: args[0],
              targetArgs: unpacked.args,
              targetOpaque: unpacked.opaque,
              targetThis: args[1],
            },
          };
        }
        if (methods.size > 0) {
          return {
            value: { args, methods, opaqueArgs, unknown: false },
          };
        }
        if (forwarders.size !== 1 || opaqueArgs || !effectiveThis) {
          return {
            value: {
              args: [],
              methods,
              opaqueArgs: true,
              unknown: true,
            },
          };
        }
        const forwarder = forwarders.values().next().value;
        if (forwarder === 'bind') {
          return {
            value: {
              args: [],
              methods,
              opaqueArgs: false,
              unknown: false,
            },
          };
        }
        const next = advanceFunctionForwarder(forwarder, effectiveThis, args);
        return {
          next: {
            target: next.callable,
            targetArgs: next.rawArgs,
            targetOpaque: next.opaque,
            targetThis: next.thisArg,
          },
        };
      },
    });
  };
}

module.exports = {
  createBuiltinBindingMethodForwarderUnit,
  createBuiltinForwarderAnalysisUnit,
  createReflectiveCallUnit,
};
