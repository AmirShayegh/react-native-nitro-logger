'use strict';

function scanBuiltinPoisoning(sourceCode, handlers) {
  const visitorKeys = sourceCode.visitorKeys ?? {};

  // Retained deliberately, and NOT pinned by any test — recorded here rather
  // than left to look load-bearing. Removing it leaves the current plugin
  // suite passing because no fixture reaches one node under two visitor keys.
  // That is a fact about the fixtures, not a proof about TS-ESTree, and the
  // cost of being wrong is a walk that does not finish inside someone's
  // editor.
  const seenNodes = new Set();
  const visit = (node) => {
    if (!node || typeof node.type !== 'string' || seenNodes.has(node)) return;
    seenNodes.add(node);

    switch (node.type) {
      case 'AssignmentExpression':
        handlers.poisonPattern(node.left);
        break;
      case 'ForOfStatement':
      case 'ForInStatement':
        // `for (Object.keys of [fake]) {}`. A `VariableDeclaration` here
        // declares a fresh binding and falls through harmlessly.
        handlers.poisonPattern(node.left);
        break;
      case 'UpdateExpression':
        handlers.poisonPattern(node.argument);
        break;
      case 'UnaryExpression':
        if (node.operator === 'delete') {
          handlers.poisonPattern(node.argument);
        }
        break;
      case 'CallExpression':
      case 'NewExpression': {
        // Call expressions are normalized once and shared by both security
        // checks. Without this hand-off, dynamic-code detection and
        // reflective-write detection independently project every static
        // container member in large files.
        const reflective =
          node.type === 'CallExpression'
            ? handlers.analyzeReflectiveCall(node)
            : null;
        handlers.poisonDynamicCode(node, reflective);
        // A namespace handed to a function is a namespace that function can
        // rewrite, whatever the function is.
        for (const argument of node.arguments) {
          handlers.poisonNamespaceOf(argument);
        }
        if (node.type === 'CallExpression') {
          handlers.poisonNamespaceReceiver(node);
          handlers.poisonReflectiveGlobalWrite(node, reflective);
        }
        break;
      }
      default:
        break;
    }

    // The parser's child-key table skips `loc`, `range`, `type` and the rest
    // that a generic object walk would revisit. The fallback is mandatory: a
    // node type absent from that table is exactly where silently skipping a
    // namespace write would turn into a privacy false negative.
    const keys = visitorKeys[node.type] ?? Object.keys(node);
    for (const key of keys) {
      if (key === 'parent') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === 'string') visit(value);
    }
  };
  visit(sourceCode.ast);
}

function createBuiltinPoisonScanUnit(
  dependencies,
  {
    context,
    dynamicCodeCall,
    poisonNamespaceOf,
    poisoned,
    possibleBuiltinNamespaceValues,
    reflectiveCall,
    staticCallKey,
    staticMemberKey,
  }
) {
  const {
    ALL_NAMESPACES_POISONED,
    BUILTIN_NAMESPACES,
    memberChain,
    possibleBuiltinNamespaces,
    possibleGlobalObjectRef,
    propertyKeyName,
    unwrap,
  } = dependencies;
  const poisonWriteTarget = (target) => {
    const { root, path } = memberChain(target);
    if (!root || root.type !== 'Identifier') return;
    if (path.length === 0) {
      for (const namespace of possibleBuiltinNamespaces(context, root)) {
        poisoned.add(namespace);
      }
      return;
    }

    const namespaces = possibleBuiltinNamespaces(context, root);
    if (namespaces.size > 0) {
      for (const namespace of namespaces) poisoned.add(namespace);
      return;
    }

    if (!possibleGlobalObjectRef(context, root)) return;
    const key = path[0];
    if (key === null) poisoned.add(ALL_NAMESPACES_POISONED);
    else if (BUILTIN_NAMESPACES.has(key)) poisoned.add(key);
  };

  const poisonGlobalKey = (key) => {
    if (key === null) poisoned.add(ALL_NAMESPACES_POISONED);
    else if (BUILTIN_NAMESPACES.has(key)) poisoned.add(key);
  };

  const poisonGlobalProperties = (node) => {
    const object = unwrap(node);
    if (object?.type !== 'ObjectExpression') {
      poisoned.add(ALL_NAMESPACES_POISONED);
      return;
    }
    for (const property of object.properties) {
      if (property.type === 'SpreadElement' || property.computed) {
        poisoned.add(ALL_NAMESPACES_POISONED);
      } else {
        poisonGlobalKey(propertyKeyName(property));
      }
    }
  };

  const poisonNamespaceReceiver = (call) => {
    const callee = unwrap(call.callee);
    if (callee?.type !== 'MemberExpression') return;
    const method = staticMemberKey(callee);
    if (
      method !== null &&
      method !== '__defineGetter__' &&
      method !== '__defineSetter__'
    ) {
      return;
    }
    for (const namespace of possibleBuiltinNamespaceValues(callee.object)) {
      poisoned.add(namespace);
    }
  };

  const poisonDynamicCode = (call, reflective) => {
    if (dynamicCodeCall(call, reflective)) {
      // Direct eval and the Function constructor can replace any global
      // namespace without leaving an AST write for this scan to observe.
      // Once either is provably invoked, every builtin-derived provenance
      // answer in the file must fail closed.
      poisoned.add(ALL_NAMESPACES_POISONED);
    }
  };

  const poisonReflectiveGlobalWrite = (call, normalized) => {
    const { args, methods, opaqueArgs, unknown } =
      normalized ?? reflectiveCall(call);
    if (unknown) {
      poisoned.add(ALL_NAMESPACES_POISONED);
      return;
    }
    for (const builtin of methods) {
      const separator = builtin.indexOf(':');
      const namespace = builtin.slice(0, separator);
      const method = builtin.slice(separator + 1);
      const mutating =
        (namespace === 'Reflect' &&
          (method === 'set' || method === 'defineProperty')) ||
        (namespace === 'Object' &&
          (method === 'defineProperty' ||
            method === 'defineProperties' ||
            method === 'assign'));
      if (!mutating && method !== '*') continue;
      if (opaqueArgs) {
        poisoned.add(ALL_NAMESPACES_POISONED);
        continue;
      }
      const receiver =
        namespace === 'Reflect' && method === 'set' ? args[3] : null;
      if (
        !possibleGlobalObjectRef(context, args[0]) &&
        !possibleGlobalObjectRef(context, receiver)
      ) {
        continue;
      }
      if (method === '*') {
        poisoned.add(ALL_NAMESPACES_POISONED);
      } else if (
        (namespace === 'Reflect' &&
          (method === 'set' || method === 'defineProperty')) ||
        (namespace === 'Object' && method === 'defineProperty')
      ) {
        poisonGlobalKey(staticCallKey(args[1]));
      } else if (
        namespace === 'Object' &&
        (method === 'defineProperties' || method === 'assign')
      ) {
        for (const source of args.slice(1)) poisonGlobalProperties(source);
      }
    }
  };

  const poisonPattern = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'ObjectPattern':
        for (const property of node.properties) {
          poisonPattern(
            property.type === 'RestElement' ? property.argument : property.value
          );
        }
        return;
      case 'ArrayPattern':
        for (const element of node.elements) poisonPattern(element);
        return;
      case 'AssignmentPattern':
        poisonPattern(node.left);
        return;
      case 'RestElement':
        poisonPattern(node.argument);
        return;
      default:
        poisonWriteTarget(node);
    }
  };

  return Object.freeze({
    analyzeReflectiveCall: reflectiveCall,
    poisonDynamicCode,
    poisonNamespaceOf,
    poisonNamespaceReceiver,
    poisonPattern,
    poisonReflectiveGlobalWrite,
  });
}

function createPoisonNamespaceUnit(
  dependencies,
  { context, possibleBuiltinNamespaceValues }
) {
  const {
    BUILTIN_NAMESPACES,
    builtinNamespaceOf,
    immutableInit,
    resolveVariable,
    unwrap,
  } = dependencies;
  const poisoned = new Set();
  // A namespace handed to a function can be wrapped on the way:
  // `tamper(...[Object])` and `tamper({ ns: Object })` pass the real thing.
  const poisonNamespaceOf = (node, seen = new Set()) => {
    const pending = [node];
    while (pending.length > 0) {
      const current = unwrap(pending.pop());
      if (!current || seen.has(current)) continue;
      seen.add(current);
      switch (current.type) {
        case 'SpreadElement':
          pending.push(current.argument);
          break;
        case 'ArrayExpression':
          pending.push(...current.elements);
          break;
        case 'ObjectExpression':
          for (const property of current.properties) {
            pending.push(
              property.type === 'SpreadElement'
                ? property.argument
                : property.value
            );
          }
          break;
        case 'ConditionalExpression':
          pending.push(current.consequent, current.alternate);
          break;
        case 'LogicalExpression':
          pending.push(current.left, current.right);
          break;
        case 'Identifier': {
          // `const namespaces = { object: Object }; tamper(namespaces)` — the
          // wrapper is a name, and the namespace is inside what it holds.
          const variable = resolveVariable(context, current);
          if (!variable || variable.defs.length === 0) {
            if (BUILTIN_NAMESPACES.has(current.name)) {
              poisoned.add(current.name);
            }
            break;
          }
          if (seen.has(variable)) break;
          seen.add(variable);
          pending.push(immutableInit(variable));

          // The wrapper may have been filled in after it was declared:
          // `const bag = {}; bag.namespace = Object; tamper(bag)`. Its
          // declaration says nothing, so the writes have to be read too —
          // at any depth (`bag.inner.namespace = Object`) and through any
          // alias (`const b = bag; b.namespace = Object`).
          for (const reference of variable.references) {
            const parent = reference.identifier.parent;
            if (!parent) continue;
            if (
              parent.type === 'VariableDeclarator' &&
              parent.init === reference.identifier &&
              parent.id.type === 'Identifier'
            ) {
              pending.push(parent.id);
              continue;
            }
            if (
              parent.type !== 'MemberExpression' ||
              parent.object !== reference.identifier
            ) {
              continue;
            }
            let member = parent;
            for (;;) {
              const owner = member.parent;
              if (!owner) break;
              if (
                owner.type === 'AssignmentExpression' &&
                owner.left === member
              ) {
                pending.push(owner.right);
                break;
              }
              if (
                owner.type === 'MemberExpression' &&
                owner.object === member
              ) {
                member = owner;
                continue;
              }
              break;
            }
          }
          break;
        }
        case 'MemberExpression':
          // A member may hold a namespace (`holder.ns`, `[Object][0]`). The
          // resolver intentionally asks for the member's VALUE, so ordinary
          // namespace methods such as `Object.assign` remain functions rather
          // than poisoning the Object namespace that owns them.
          for (const namespace of possibleBuiltinNamespaceValues(current)) {
            poisoned.add(namespace);
          }
          break;
        default: {
          const name = builtinNamespaceOf(context, current);
          if (name !== null) poisoned.add(name);
          break;
        }
      }
    }
  };

  return Object.freeze({ poisonNamespaceOf, poisoned });
}

module.exports = {
  createBuiltinPoisonScanUnit,
  createPoisonNamespaceUnit,
  scanBuiltinPoisoning,
};
