'use strict';

/**
 * Shared call-site analysis for the privacy lint rules.
 *
 * These rules enforce the "public by contract" half of the privacy design:
 * fields the runtime cannot redact — the message, the subsystem, the
 * correlation ID, metadata keys — have to be provably static at build time.
 * The runtime redacts values; lint keeps everything else from becoming a
 * value in the first place.
 *
 * Three rules govern everything below, and they are what make the analysis a
 * control rather than a speed bump:
 *
 * 1. **Receivers resolve permissively.** Failing to recognize a logger
 *    silences every rule at that call site, so aliases, import renames,
 *    computed access, `this` members, method references and post-declaration
 *    assignment are all followed. A receiver that merely *might* be a logger
 *    is `'ambiguous'`, not discarded.
 * 2. **Values resolve strictly.** `const` protects the binding, not the
 *    object. A binding is a constant only if nothing writes through it AND it
 *    never escapes into code we cannot see.
 * 3. **Unprovable is reported, never skipped.** Every position that could
 *    carry a public-by-contract field and cannot be resolved yields an
 *    `unanalyzable` result. A spread argument, an opaque options object and a
 *    computed property that could shadow a checked key are all findings, not
 *    reasons to fall silent.
 */

const LEVEL_METHODS = new Set([
  'verbose',
  'debug',
  'info',
  'warning',
  'error',
  'todo',
]);

/**
 * Level helpers plus the generic entry points.
 *
 * `logMessage` is here because it is public, exported, and the thing `log`
 * delegates to — `log(message, options)` is a one-line passthrough. Leaving it
 * out made `Log.logMessage(`MRN ${x}`, ...)` lint clean while the identical
 * `Log.log(...)` errored, which is not a defence-in-depth gap: message,
 * correlation and subsystem have no runtime redaction anywhere, so these rules
 * are the only thing standing between them and a log file.
 *
 * Anything emitting added to `Logger` must land in this set. That is not left
 * to memory — see the exhaustiveness test in `__tests__/eslintPlugin.test.js`,
 * which fails on a prototype method it cannot classify.
 */
const LOG_METHODS = new Set([...LEVEL_METHODS, 'log', 'logMessage']);

/** Level configuration, which only the Logger singleton exposes. */
const CONFIG_METHODS = new Set(['subsystem', 'resetSubsystem']);

/**
 * Methods whose second argument is a `LogOptions` object rather than metadata.
 *
 * `Log.log` is only this shape when its receiver resolves to the Logger — a
 * ScopedLogger's `log` takes `(message, level, metadata)`. `logMessage` has no
 * such overload, so it is always the options shape.
 */
const OPTIONS_METHODS = new Set(['log', 'logMessage']);

/**
 * Fields on a `LogOptions` object that carry caller metadata.
 *
 * Both reach `redactMetadata` and both are equally public — `scopeMetadata` is
 * what `ScopedLogger` threads through, and nothing stops an application from
 * passing it directly. A rule that read only `metadata` left the other half of
 * the same pipeline unchecked.
 */
const METADATA_OPTION_FIELDS = ['metadata', 'scopeMetadata'];

/** Every method whose arguments are public by contract. */
const API_METHODS = new Set([...LOG_METHODS, ...CONFIG_METHODS, 'scoped']);

/**
 * Every method the package's own Logger and ScopedLogger define.
 *
 * Kept as a closed list, not "any method on a trusted receiver", because
 * `Object.prototype` lends every object methods the package never wrote:
 * `Log.__defineGetter__('newCorrelationId', () => () => patient.mrn)`
 * replaces the generator through a call that mutates nothing the package
 * knows about. A call to anything absent from this list has to count as
 * tampering. Mirrors src/Logger.ts and src/ScopedLogger.ts.
 */
const LOGGER_OWN_METHODS = new Set([
  ...API_METHODS,
  'addDestination',
  'consoleLogging',
  'flush',
  'logMessage',
  'metadataKeyCatalog',
  'minimumLevel',
  'newCorrelationId',
  'privacyDefault',
  'redactAllMetadata',
  'removeDestination',
  // TypeScript `private` is erased, so these are ordinary prototype methods at
  // runtime. They belong here for the same reason as the rest: they are the
  // package's own code, so a call to one is not tampering.
  'noteFailure',
  'privacySettings',
]);

const DEFAULT_LOGGER_NAMES = ['Log', 'log', 'logger'];

function configuredLoggerNames(context) {
  const configured = context.options?.[0]?.loggerNames;
  return Array.isArray(configured) && configured.length > 0
    ? configured
    : DEFAULT_LOGGER_NAMES;
}

function loggerNames(context) {
  return new Set(configuredLoggerNames(context));
}

/**
 * The one name that means the Logger singleton itself, rather than "some
 * logger-shaped thing".
 *
 * `Log` is the documented export; `log` and `logger` are what people call
 * whatever they have to hand, very often a ScopedLogger. An unresolved
 * `Log.log(…)` can be assumed to have the Logger's argument order; an
 * unresolved `logger.log(…)` cannot.
 *
 * Configurable on its own rather than by `loggerNames` array order, so that
 * reordering that list cannot quietly change which name carries the meaning.
 * This decides argument SHAPE only — trusting a value still needs
 * {@link isTrustedLogger}, which requires a verified import.
 */
function canonicalLoggerName(context) {
  return (
    context.options?.[0]?.singletonName ?? configuredLoggerNames(context)[0]
  );
}

/**
 * The exported classes a consumer can construct a logger from.
 *
 * `Log.scoped()` is the documented way to get a ScopedLogger, but both classes
 * are root exports and `new ScopedLogger(logger, correlation, subsystem)` takes
 * the two unredactable channels directly as arguments. A rule set that only
 * understood `.scoped()` was silent on the constructor — same identifiers, same
 * destinations, no report.
 *
 * Matched against the **exported symbol**, not the local binding, so
 * `import { ScopedLogger as Scope }` and `new Scope(…)` is still a ScopedLogger.
 */
const DEFAULT_LOGGER_CLASSES = ['Logger'];
const DEFAULT_SCOPED_CLASSES = ['ScopedLogger'];

function loggerClassNames(context) {
  const configured = context.options?.[0]?.loggerClassNames;
  return new Set(
    Array.isArray(configured) && configured.length > 0
      ? configured
      : DEFAULT_LOGGER_CLASSES
  );
}

function scopedClassNames(context) {
  const configured = context.options?.[0]?.scopedClassNames;
  return new Set(
    Array.isArray(configured) && configured.length > 0
      ? configured
      : DEFAULT_SCOPED_CLASSES
  );
}

/**
 * The receiver-resolution options every rule accepts.
 *
 * Shared rather than copied into each rule's `meta.schema`. They were copied
 * before, and `additionalProperties: false` turns a missed copy into a crash
 * for any consumer who sets the option — the rule that forgot it rejects a
 * config the others accept. Adding an option here reaches all four rules at
 * once, which is the only way this stays true.
 */
const RECEIVER_OPTION_PROPERTIES = {
  loggerNames: { type: 'array', items: { type: 'string' } },
  loggerModules: { type: 'array', items: { type: 'string' } },
  singletonName: { type: 'string' },
  loggerClassNames: { type: 'array', items: { type: 'string' } },
  scopedClassNames: { type: 'array', items: { type: 'string' } },
};

/** Modules an import of the Logger may legitimately come from. */
const DEFAULT_LOGGER_MODULES = ['react-native-nitro-logger'];

function loggerModules(context) {
  const configured = context.options?.[0]?.loggerModules;
  return new Set(
    Array.isArray(configured) && configured.length > 0
      ? configured
      : DEFAULT_LOGGER_MODULES
  );
}

/**
 * Was this binding imported from a module that actually ships the Logger?
 *
 * A name is not provenance. `import { Log } from './phi-helpers'` binds the
 * documented name to something we know nothing about, and treating it as the
 * singleton would let its `newCorrelationId()` mint approved IDs out of MRNs.
 */
function isLoggerImport(context, def) {
  if (!def || def.type !== 'ImportBinding') return false;
  const imported = def.node.imported?.name ?? def.node.local?.name;
  if (!loggerNames(context).has(imported)) return false;
  const source = def.parent?.source?.value;
  return typeof source === 'string' && loggerModules(context).has(source);
}

/* -------------------------------------------------------------------------
 * Syntax normalization
 * ---------------------------------------------------------------------- */

/**
 * Strip the wrappers that change an expression's spelling but not its value:
 * TypeScript assertions, non-null assertions, optional-chain envelopes and
 * the comma operator. Each is a one-token bypass of a naive AST match —
 * `(0, Log.info)(msg)` and `(Log as any)!.info(msg)` must not read
 * differently from `Log.info(msg)`.
 */
function unwrap(node) {
  let current = node ?? null;
  for (;;) {
    if (!current) return null;
    switch (current.type) {
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
      case 'TSTypeAssertion':
      case 'TSInstantiationExpression':
      case 'ChainExpression':
        current = current.expression;
        break;
      case 'SequenceExpression':
        current = current.expressions[current.expressions.length - 1];
        break;
      default:
        return current;
    }
  }
}

/** The key of an object-literal property, or null when computed. */
function propertyKeyName(property) {
  if (property.computed) return null;
  const key = property.key;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal') return String(key.value);
  return null;
}

/* -------------------------------------------------------------------------
 * Binding resolution
 * ---------------------------------------------------------------------- */

function resolveVariable(context, identifier) {
  let scope = context.sourceCode.getScope(identifier);
  while (scope) {
    const found = scope.variables.find((v) => v.name === identifier.name);
    if (found) return found;
    scope = scope.upper;
  }
  return null;
}

function singleDef(variable) {
  return variable && variable.defs.length === 1 ? variable.defs[0] : null;
}

/**
 * The one value a binding is ever given, whether at its declaration or by a
 * single later assignment.
 *
 * Receivers only. `let sink; sink = Log; sink.info(msg)` is a logger, and
 * `let s = Log.scoped(id)` is a scope — refusing to follow either would mean
 * one keyword disables every rule.
 */
function bindingInit(variable) {
  const def = singleDef(variable);
  if (!def || def.type !== 'Variable') return null;

  const pattern = def.node.id;
  if (def.node.init) {
    const init = unwrap(def.node.init);
    if (pattern.type === 'Identifier') return init;
    // `const [a] = [Log]` — follow the element this binding actually took.
    if (
      pattern.type === 'ArrayPattern' &&
      init &&
      init.type === 'ArrayExpression'
    ) {
      const index = pattern.elements.indexOf(def.name);
      const element = index < 0 ? null : init.elements[index];
      return element ? unwrap(element) : null;
    }
    return null;
  }

  // Declared empty, then assigned exactly once.
  const writes = variable.references.filter(
    (reference) => reference.isWrite() && reference.writeExpr
  );
  return writes.length === 1 ? unwrap(writes[0].writeExpr) : null;
}

/**
 * The initializer of a single-definition `const`.
 *
 * Values only. Unlike {@link bindingInit} this refuses `let`, because an
 * approved constant that can be reassigned is not a constant.
 */
function immutableInit(variable) {
  const def = singleDef(variable);
  if (!def || def.type !== 'Variable' || def.parent?.kind !== 'const') {
    return null;
  }
  return def.node.init ? unwrap(def.node.init) : null;
}

/**
 * Is this node in a position that gets written to?
 *
 * Simple assignment is the obvious case, but a member expression can also be
 * a destructuring target (`({ x: M.up } = leak)`, `[M.up] = [leak]`) or a
 * loop binding (`for (M.up of xs)`), and those reach through arbitrarily
 * nested patterns. So climb while the node stays in target position and
 * decide at whatever construct the pattern terminates in.
 */
function isWriteTarget(node) {
  let current = node;
  let parent = current.parent;
  while (parent) {
    switch (parent.type) {
      case 'AssignmentExpression':
        return parent.left === current;
      case 'ForOfStatement':
      case 'ForInStatement':
        return parent.left === current;
      case 'UpdateExpression':
        return parent.argument === current;
      case 'UnaryExpression':
        return parent.operator === 'delete' && parent.argument === current;
      // Still inside a pattern — keep climbing toward whatever assigns it.
      case 'AssignmentPattern':
        if (parent.left !== current) return false;
        break;
      case 'Property':
        if (parent.value !== current) return false;
        break;
      case 'ObjectPattern':
      case 'ArrayPattern':
      case 'RestElement':
        break;
      default:
        return false;
    }
    current = parent;
    parent = current.parent;
  }
  return false;
}

/**
 * `Object.*` and `Reflect.*` statics that hand the object back unchanged
 * *without running any of its code*.
 *
 * The second half of that is the load-bearing part. `Object.values`,
 * `Object.entries`, `Reflect.get` and `JSON.stringify` all look like reads and
 * are not: they invoke getters (and `toJSON`), so
 * `const M = { up: 'safe', get x() { this.up = patientName } }; Object.values(M)`
 * rewrites `M.up` before it is logged. Only operations that touch keys and
 * descriptors rather than values are listed here.
 *
 * Everything else on those namespaces — `assign`, `defineProperty`, `set`,
 * `deleteProperty`, `setPrototypeOf` — rewrites the object outright.
 */
const NON_MUTATING_STATICS = new Set([
  'keys',
  'freeze',
  'isFrozen',
  'seal',
  'isSealed',
  'getOwnPropertyNames',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'getPrototypeOf',
  'has',
  'ownKeys',
]);
const BUILTIN_NAMESPACES = new Set(['Object', 'Reflect', 'JSON']);
const GLOBAL_OBJECT_NAMES = new Set(['globalThis', 'global', 'window', 'self']);

/**
 * Builtin namespaces this file tampers with, in any of the ways that leave
 * the binding itself looking pristine.
 *
 * `const JSON = {…}` is a shadow and resolves as a definition, so scope
 * resolution catches it. These do not:
 *
 * - `Object.keys = (o) => { o.up = patientName; return [] }` — the namespace
 *   is the real one; a single method on it is not.
 * - `globalThis.JSON = fake` and `globalThis['JSON'] = fake` — replacement
 *   through the global object.
 * - `globalThis[name] = fake` — an unreadable key, so every namespace has to
 *   be assumed replaced.
 * - `Object.defineProperty(Object, 'keys', …)`, `Object.assign(Object, …)`,
 *   `tamper(Object)` — handing the namespace to code that can rewrite it.
 *
 * One walk per file, cached.
 */
const poisonedGlobalsCache = new WeakMap();
const ALL_NAMESPACES_POISONED = Symbol('all');

/**
 * Walk `a.b.c` down to its base identifier, collecting the property path.
 * Unreadable (computed, non-literal) steps come back as null so the caller
 * can decide how much to assume.
 */
function memberChain(node) {
  const path = [];
  let current = unwrap(node);
  while (current && current.type === 'MemberExpression') {
    if (!current.computed && current.property.type === 'Identifier') {
      path.unshift(current.property.name);
    } else {
      const literal = unwrap(current.property);
      path.unshift(
        literal && literal.type === 'Literal' ? String(literal.value) : null
      );
    }
    current = unwrap(current.object);
  }
  return { root: current, path };
}

/**
 * Does this expression name a builtin namespace, directly or through a const
 * alias?
 *
 * The binding is resolved BEFORE the spelling is trusted. A local
 * `function f() { const Object = {}; Object.keys = fake }` writes to its own
 * shadow, and reading that as tampering with the global would disable
 * `Object.keys` for the whole file — a false positive in exactly the code
 * most likely to be doing something ordinary.
 */
function builtinNamespaceOf(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return null;

  // `globalThis.Object`, and `const O = globalThis.Object` behind it.
  if (current.type === 'MemberExpression') {
    const { root, path } = memberChain(current);
    if (path.length !== 1 || path[0] === null) return null;
    if (!BUILTIN_NAMESPACES.has(path[0])) return null;
    return isGlobalObjectRef(context, root) ? path[0] : null;
  }

  if (current.type !== 'Identifier') return null;
  const variable = resolveVariable(context, current);
  if (!variable || variable.defs.length === 0) {
    return BUILTIN_NAMESPACES.has(current.name) ? current.name : null;
  }
  if (seen.has(variable)) return null;
  seen.add(variable);
  return builtinNamespaceOf(context, immutableInit(variable), seen);
}

/** Likewise for the global object: `globalThis`, or a const alias of it. */
function isGlobalObjectRef(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current || current.type !== 'Identifier') return false;
  const variable = resolveVariable(context, current);
  if (!variable || variable.defs.length === 0) {
    return GLOBAL_OBJECT_NAMES.has(current.name);
  }
  if (seen.has(variable)) return false;
  seen.add(variable);
  return isGlobalObjectRef(context, immutableInit(variable), seen);
}

function poisonedGlobals(context) {
  const cached = poisonedGlobalsCache.get(context);
  if (cached) return cached;

  const poisoned = new Set();
  // A namespace handed to a function can be wrapped on the way:
  // `tamper(...[Object])` and `tamper({ ns: Object })` pass the real thing.
  const poisonNamespaceOf = (node, seen = new Set()) => {
    const current = unwrap(node);
    if (!current || seen.has(current)) return;
    seen.add(current);
    // A cycle or a pathological nesting depth must not end the search
    // quietly: an unfinished search is exactly the case where a namespace
    // could be in there somewhere.
    if (seen.size > 64) {
      poisoned.add(ALL_NAMESPACES_POISONED);
      return;
    }

    const name = builtinNamespaceOf(context, current);
    if (name !== null) {
      poisoned.add(name);
      return;
    }
    switch (current.type) {
      case 'SpreadElement':
        poisonNamespaceOf(current.argument, seen);
        return;
      case 'ArrayExpression':
        for (const element of current.elements) {
          poisonNamespaceOf(element, seen);
        }
        return;
      case 'ObjectExpression':
        for (const property of current.properties) {
          poisonNamespaceOf(
            property.type === 'SpreadElement'
              ? property.argument
              : property.value,
            seen
          );
        }
        return;
      case 'ConditionalExpression':
        poisonNamespaceOf(current.consequent, seen);
        poisonNamespaceOf(current.alternate, seen);
        return;
      case 'LogicalExpression':
        poisonNamespaceOf(current.left, seen);
        poisonNamespaceOf(current.right, seen);
        return;
      case 'Identifier': {
        // `const namespaces = { object: Object }; tamper(namespaces)` — the
        // wrapper is a name, and the namespace is inside what it holds.
        const variable = resolveVariable(context, current);
        if (!variable || seen.has(variable)) return;
        seen.add(variable);
        poisonNamespaceOf(immutableInit(variable), seen);

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
            poisonNamespaceOf(parent.id, seen);
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
              poisonNamespaceOf(owner.right, seen);
              break;
            }
            if (owner.type === 'MemberExpression' && owner.object === member) {
              member = owner;
              continue;
            }
            break;
          }
        }
        return;
      }
      default:
        return;
    }
  };
  const poisonWriteTarget = (target) => {
    const { root, path } = memberChain(target);
    if (!root || root.type !== 'Identifier' || path.length === 0) return;

    // `Object.keys = …`, and `const O = Object; O.keys = …` — a method on the
    // real namespace, however the namespace was spelled.
    const namespace = builtinNamespaceOf(context, root);
    if (namespace !== null) {
      poisoned.add(namespace);
      return;
    }

    // `globalThis.JSON = …`, `globalThis['JSON'].parse = …`,
    // `const g = globalThis; g.JSON = …` — replacement reached through the
    // global object, at any depth.
    if (!isGlobalObjectRef(context, root)) return;
    const key = path[0];
    if (key === null) poisoned.add(ALL_NAMESPACES_POISONED);
    else if (BUILTIN_NAMESPACES.has(key)) poisoned.add(key);
  };

  // A write target can be a whole destructuring pattern:
  // `({ keys: Object.keys } = { keys: fake })` replaces the builtin without
  // any assignment whose left side is a member expression.
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

  const seenNodes = new Set();
  const visit = (node) => {
    if (!node || typeof node.type !== 'string' || seenNodes.has(node)) return;
    seenNodes.add(node);

    switch (node.type) {
      case 'AssignmentExpression':
        poisonPattern(node.left);
        break;
      case 'ForOfStatement':
      case 'ForInStatement':
        // `for (Object.keys of [fake]) {}`. A `VariableDeclaration` here
        // declares a fresh binding and falls through harmlessly.
        poisonPattern(node.left);
        break;
      case 'UpdateExpression':
        poisonWriteTarget(node.argument);
        break;
      case 'UnaryExpression':
        if (node.operator === 'delete') poisonWriteTarget(node.argument);
        break;
      case 'CallExpression':
      case 'NewExpression':
        // A namespace handed to a function is a namespace that function can
        // rewrite, whatever the function is.
        for (const argument of node.arguments) poisonNamespaceOf(argument);
        break;
      default:
        break;
    }

    for (const key of Object.keys(node)) {
      if (key === 'parent') continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value.type === 'string') visit(value);
    }
  };
  visit((context.sourceCode ?? context.getSourceCode()).ast);

  poisonedGlobalsCache.set(context, poisoned);
  return poisoned;
}

/** Is this identifier an untouched global with the given name? */
function isGlobalNamed(context, node, names) {
  if (!node || node.type !== 'Identifier' || !names.has(node.name))
    return false;
  const poisoned = poisonedGlobals(context);
  if (poisoned.has(ALL_NAMESPACES_POISONED) || poisoned.has(node.name)) {
    return false;
  }
  const variable = resolveVariable(context, node);
  // Absent, or present as a declared global with no definition of its own.
  return !variable || variable.defs.length === 0;
}

/**
 * A read-only builtin static, like `Object.keys(M)`.
 *
 * The namespace has to be the real global: `const JSON = { stringify: (o) =>
 * { o.up = leak; return ''; } }` would otherwise launder a mutation through
 * the allowlist.
 *
 * A `new` is never one of these. `new Object.freeze(M)` throws at runtime, so
 * exempting it protects nothing — but once `computeIsMutable` began asking
 * this question about constructors too, it silently widened the escape
 * exemption past the one constructor it is meant to cover.
 */
function isNonMutatingStatic(context, node) {
  if (node.type === 'NewExpression') return false;

  const callee = unwrap(node.callee);
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) {
    return false;
  }
  return (
    isGlobalNamed(context, unwrap(callee.object), BUILTIN_NAMESPACES) &&
    callee.property.type === 'Identifier' &&
    NON_MUTATING_STATICS.has(callee.property.name)
  );
}

/**
 * Can this call mutate an object handed to it?
 *
 * A real logger call cannot — passing a metadata object to `Log.info` is the
 * entire point of having one — and neither can the read-only builtin statics.
 * Anything else is a function we cannot see inside.
 *
 * "A real logger call" means one whose receiver is PROVABLY the shipped
 * Logger, not one that merely classifies. Classification accepts an
 * unresolved `logger.info(M)` so its arguments still get checked, but
 * exempting that same call from mutation analysis would trust it:
 * `function f(logger) { const M = { up: 'safe' }; logger.info(M);
 * Log.info(M.up) }` hands `M` to a function we know nothing about, which is
 * free to rewrite `M.up` into PHI before the second call reads it.
 */
function callCanMutateArguments(context, node) {
  if (isNonMutatingStatic(context, node)) return false;
  return !isTrustedLoggerCall(context, node);
}

/** An API method invoked on a receiver proven to be the shipped Logger. */
function isTrustedApiMethod(context, member) {
  const method = staticPropertyName(context, member);
  return (
    method !== null &&
    API_METHODS.has(method) &&
    isTrustedLogger(context, member.object)
  );
}

function isTrustedLoggerCall(context, node) {
  // `new ScopedLogger(Log, id, 'net')` hands the Logger to the package's own
  // constructor. Without this it reads as an escape — the binding was passed
  // to code that could write through it — and `Log` loses the trust that
  // `Log.newCorrelationId()` depends on, so the *encouraged* form of the
  // constructor reports a derived correlation ID. A false positive on the
  // correct spelling is how a rule gets switched off, and this one guards a
  // channel nothing else guards.
  //
  // Only the package's own classes qualify, on the same provenance rule as
  // everything else here: a lookalike from another module is exactly the code
  // that could write through the reference. TRUST needs `verified`, unlike
  // `describeScopedCall`, which only needs to know the arguments are worth
  // checking — a class reached through a local barrel is checked but is not
  // proof that nothing writes through what it is handed.
  if (node.type === 'NewExpression') {
    const provenance = constructionProvenance(context, node);
    return !!provenance && provenance.kind === 'scoped' && provenance.verified;
  }

  const callee = unwrap(node.callee);
  if (!callee || callee.type !== 'MemberExpression') return false;

  const method = staticPropertyName(context, callee);
  if (method === null) return false;

  // `Log.info.call(thisArg, 'm', M)` — the real method is one level in, but
  // the method alone is not enough. `.call` runs that real body against a
  // receiver of the caller's choosing, and the logger reaches its sinks
  // through `this`, so a forged receiver
  // (`Log.info.call({ logMessage(_m, o) { o.up = patientName } }, 'm', M)`)
  // mutates M from inside a call that looks entirely legitimate. The `this`
  // has to be the real Logger too.
  if (method === 'call' || method === 'apply') {
    const inner = unwrap(callee.object);
    if (!inner || inner.type !== 'MemberExpression') return false;
    if (!isTrustedApiMethod(context, inner)) return false;
    const thisArg = node.arguments[0];
    return (
      !!thisArg &&
      thisArg.type !== 'SpreadElement' &&
      isTrustedLogger(context, thisArg)
    );
  }

  return isTrustedApiMethod(context, callee);
}

/**
 * Does the binding leave this file's sight — written through, or handed to
 * code that could write through it?
 *
 * `const` freezes the reference and nothing else. A message table patched
 * after definition (`MESSAGES.startup = patientName`) reads as a table of
 * literals at its declaration and leaks at the call site, and a table handed
 * to `mutate(MESSAGES)` can be rewritten by a function we never see.
 *
 * Being read as a property, aliased to another const, or passed to one of the
 * logger's own methods is not an escape — the last one matters, because
 * handing a metadata object to `Log.info` is the entire point of having one.
 */
/**
 * Guards the cycle `isMutable` → `callCanMutateArguments` → `describeCall` →
 * `classifyReceiver` → `staticPropertyName` → `staticStringValue` →
 * `isMutable`. Re-entering for the same binding means the question is already
 * being answered further up the stack; assuming immutable there terminates
 * without changing the outcome, because the outer frame still applies every
 * check to that same binding.
 */
const mutabilityInProgress = new Set();

/**
 * Answers are cached per rule run. `isMutable` walks every reference of a
 * binding, and resolution asks about the same binding once per call site, so
 * an uncached message table referenced by R log calls costs O(R²). The cache
 * is keyed on `context` as well as the variable because `loggerNames` is
 * configurable per rule, and that changes what counts as a logger call.
 */
const mutabilityCache = new WeakMap();

function isMutable(context, variable) {
  let perContext = mutabilityCache.get(context);
  if (!perContext) {
    perContext = new WeakMap();
    mutabilityCache.set(context, perContext);
  }
  const cached = perContext.get(variable);
  if (cached !== undefined) return cached;

  if (mutabilityInProgress.has(variable)) return false;
  mutabilityInProgress.add(variable);
  let result;
  try {
    result = computeIsMutable(context, variable);
  } finally {
    mutabilityInProgress.delete(variable);
  }
  perContext.set(variable, result);
  return result;
}

/** Every identifier a binding pattern introduces, however deeply nested. */
function collectPatternIdentifiers(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier':
      out.push(node);
      return;
    case 'ObjectPattern':
      for (const property of node.properties) {
        collectPatternIdentifiers(
          property.type === 'RestElement' ? property.argument : property.value,
          out
        );
      }
      return;
    case 'ArrayPattern':
      for (const element of node.elements) {
        collectPatternIdentifiers(element, out);
      }
      return;
    case 'AssignmentPattern':
      collectPatternIdentifiers(node.left, out);
      return;
    case 'RestElement':
      collectPatternIdentifiers(node.argument, out);
      return;
    default:
      // A member expression as a destructuring target is a write, which
      // `isWriteTarget` already reports.
      return;
  }
}

function bindingIdentifiersMutable(context, node) {
  const identifiers = [];
  collectPatternIdentifiers(node, identifiers);
  return identifiers.some((identifier) => {
    const variable = resolveVariable(context, identifier);
    return !variable || isMutable(context, variable);
  });
}

/** A value that is copied on read, so it carries no object identity. */
function isPrimitiveLiteral(node) {
  const value = unwrap(node);
  if (!value) return false;
  if (value.type === 'Literal') return !value.regex;
  return value.type === 'TemplateLiteral' && value.expressions.length === 0;
}

/**
 * Destructuring reads the source, but a binding it extracts can still ALIAS
 * part of it: `const { inner } = md; inner.k = patientName` rewrites `md`.
 * So each extracted binding has to clear the same bar the source does.
 *
 * A binding that took a primitive is exempt, and that exemption is what keeps
 * the rule usable. `const { up } = M` copies the string, so nothing done to
 * `up` afterwards can reach `M` — without this, destructuring one scalar and
 * passing it anywhere would make the whole table unresolvable, which is
 * ordinary code rather than a leak.
 *
 * Anything not proven primitive stays conservative: rest elements, computed
 * keys, defaults, nested patterns, and every key when the source literal
 * itself could not be resolved.
 */
function patternBindingsMutable(context, pattern, sourceLiteral) {
  for (const property of pattern.properties) {
    if (property.type === 'RestElement') {
      if (bindingIdentifiersMutable(context, property.argument)) return true;
      continue;
    }
    const key = property.computed ? null : propertyKeyName(property);
    const source =
      key !== null && sourceLiteral
        ? objectProperty(context, sourceLiteral, key)
        : null;
    if (
      source &&
      property.value.type === 'Identifier' &&
      isPrimitiveLiteral(source.value)
    ) {
      continue;
    }
    if (bindingIdentifiersMutable(context, property.value)) return true;
  }
  return false;
}

function computeIsMutable(context, variable) {
  for (const reference of variable.references) {
    if (reference.isWrite()) {
      // A write that is not the declaration's own initializer is a rebind.
      if (reference.init !== true) return true;
      // The declaration's own binding occurrence says nothing about mutation,
      // and it must not reach the escape analysis below: a destructured
      // binding sits inside a `Property`, which that analysis reads as the
      // very different `{ key: M }`.
      continue;
    }

    const identifier = reference.identifier;
    const parent = identifier.parent;
    if (!parent) continue;

    if (parent.type === 'MemberExpression' && parent.object === identifier) {
      // Climb the WHOLE chain before deciding. A write or a call anywhere
      // along it reaches the root: `M.a.b = patientName` rewrites part of M,
      // and `Log.constructor.prototype.newCorrelationId = …` replaces the
      // generator while the reference's immediate parent is only
      // `Log.constructor`.
      let member = parent;
      for (;;) {
        if (isWriteTarget(member)) return true;

        // `M.__defineGetter__('t', function () { this.up = patientName })`
        // installs an accessor without anything that reads as a write, and
        // `Object.prototype` hands that method to every object. So a call
        // THROUGH the binding is a possible mutation.
        //
        // A proven Logger calling one of its OWN methods is the exception,
        // and has to be: `Log.info('m', md)`, `Log.newCorrelationId()` and
        // `scope.info('m', md)` are all calls through a binding, and treating
        // them as mutations would make every Logger binding mutable, which
        // would un-trust the logger and cascade into every rule.
        //
        // Both halves are load-bearing. Dropping the receiver check would
        // exempt `attacker.info(M)`; dropping the method check would exempt
        // `Log.__defineGetter__('newCorrelationId', …)`, which replaces the
        // generator using a method the package never wrote.
        const invocation = member.parent;
        const invoked =
          invocation &&
          ((invocation.type === 'CallExpression' &&
            unwrap(invocation.callee) === member) ||
            (invocation.type === 'NewExpression' &&
              unwrap(invocation.callee) === member) ||
            // `M.mutate`x`` calls M.mutate with `this === M` too.
            (invocation.type === 'TaggedTemplateExpression' &&
              unwrap(invocation.tag) === member));
        if (invoked) {
          // `Log.info.call(Log, …)` invokes at the second level, so unwrap
          // the forwarding method to the real one before judging it.
          let target = member;
          let method = staticPropertyName(context, member);
          if (method === 'call' || method === 'apply' || method === 'bind') {
            const inner = unwrap(member.object);
            if (inner && inner.type === 'MemberExpression') {
              target = inner;
              method = staticPropertyName(context, inner);
            }
          }
          const ownApiCall =
            method !== null &&
            LOGGER_OWN_METHODS.has(method) &&
            // The method has to hang off the binding itself. Otherwise
            // `Log.constructor.prototype.info()` would ride the exemption on
            // a name it only borrowed.
            unwrap(target.object) === identifier &&
            isTrustedLogger(context, identifier);
          if (!ownApiCall) return true;
        }

        const next = member.parent;
        if (
          next &&
          next.type === 'MemberExpression' &&
          next.object === member
        ) {
          member = next;
          continue;
        }
        break;
      }
      continue;
    }

    // `const A = M` — the alias points at the same object, so a write through
    // A is a write through M. Following it beats treating aliasing as an
    // escape, which would reject the ordinary `const md = base;` refactor.
    if (parent.type === 'VariableDeclarator' && parent.init === identifier) {
      if (parent.id.type === 'Identifier') {
        const alias = resolveVariable(context, parent.id);
        if (!alias || isMutable(context, alias)) return true;
        continue;
      }
      // `const { userId } = md` reads M rather than writing it — but each
      // binding it extracts can alias a nested object, so they have to clear
      // the same bar the whole-object alias above does.
      if (parent.id.type === 'ObjectPattern') {
        const literal = unwrapFreeze(context, immutableInit(variable));
        const source =
          literal && literal.type === 'ObjectExpression' ? literal : null;
        if (patternBindingsMutable(context, parent.id, source)) return true;
        continue;
      }
      // An ArrayPattern runs the iteration protocol, which is code.
      return true;
    }

    // Handed to a function that could write through it.
    //
    // `new` is asked the same question as a call rather than being assumed
    // hostile: `new ScopedLogger(Log, id, 'net')` is the constructor form of
    // `Log.scoped(id, 'net')`, and treating it as an escape cost `Log` the
    // trust that `Log.newCorrelationId()` needs — reporting the encouraged
    // spelling as a derived correlation ID. `callCanMutateArguments` still
    // says yes for every constructor that is not one of the package's own.
    if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
      if (parent.callee === identifier) continue;
      if (!callCanMutateArguments(context, parent)) continue;
      return true;
    }

    // Spread into another object, returned, put in an array — out of sight.
    //
    // `await M` belongs here too, and not obviously: awaiting a value calls
    // its `then` with `this` bound to it, so a thenable metadata object
    // rewrites itself at the await. `yield M` hands it to whoever drives the
    // iterator.
    if (
      parent.type === 'SpreadElement' ||
      parent.type === 'ReturnStatement' ||
      parent.type === 'ArrayExpression' ||
      parent.type === 'Property' ||
      parent.type === 'AssignmentExpression' ||
      parent.type === 'AwaitExpression' ||
      parent.type === 'YieldExpression'
    ) {
      return true;
    }
  }
  return false;
}

/** Is this identifier the untouched global `Object`? */
function isGlobalObject(context, node) {
  if (!node || node.type !== 'Identifier' || node.name !== 'Object') {
    return false;
  }
  const variable = resolveVariable(context, node);
  // Absent, or present as a declared global with no definition of its own.
  return !variable || variable.defs.length === 0;
}

/** `Object.freeze({...})` → the object literal, via the real `Object`. */
function unwrapFreeze(context, node) {
  const call = unwrap(node);
  if (!call || call.type !== 'CallExpression') return call;
  const callee = unwrap(call.callee);
  if (
    callee &&
    callee.type === 'MemberExpression' &&
    staticPropertyName(context, callee) === 'freeze' &&
    isGlobalObject(context, unwrap(callee.object)) &&
    call.arguments.length === 1
  ) {
    return unwrap(call.arguments[0]);
  }
  return call;
}

/* -------------------------------------------------------------------------
 * Value analysis
 * ---------------------------------------------------------------------- */

/**
 * Resolve an expression to an object literal, following `const` aliases and
 * `Object.freeze`. Returns null when it cannot be proven to be one —
 * including when the binding is mutable by the definition above.
 */
/**
 * Can reading this literal run any code?
 *
 * A table of constants is only constant if nothing inside it executes. Four
 * ways a literal smuggles in behaviour, all of which rewrite an approved
 * value before it is logged:
 *
 * - **A getter or setter.** Not a value but a callback, which the runtime
 *   invokes while redacting, and which can rewrite its own siblings on the
 *   way past: `{ up: 'safe', get t() { this.up = patientName } }`.
 * - **A shorthand method**, the same hazard reached through `toJSON`.
 * - **A function- or class-valued property.** `property.method` is false for
 *   `{ mutate: function () { this.up = patientName } }`, but `M.mutate()`
 *   rewrites `up` just the same, and nothing about that call reads as a write
 *   to `M`.
 * - **`__proto__`.** It sets the prototype, so the getters and methods that
 *   can run are ones this literal never mentions:
 *   `{ __proto__: P, up: 'safe' }` inherits everything `P` defines.
 *
 * Nested literals are checked too — a getter one level down still runs, and
 * still reaches the outer object through a closure.
 */
function literalRunsCode(context, object, seen = new Set()) {
  if (seen.has(object)) return false;
  seen.add(object);
  return object.properties.some((property) => {
    if (property.type === 'SpreadElement') return false;
    if (property.kind !== 'init' || property.method) return true;
    if (!property.computed && propertyKeyName(property) === '__proto__') {
      return true;
    }
    return valueRunsCode(context, property.value, seen);
  });
}

/**
 * The same question for a single value, at arbitrary depth.
 *
 * Split out because the hazard does not care how deeply it is nested or how
 * many names it is behind: `{ h: [[fn]] }` and
 * `const mutate = function () {…}; { mutate }` hide exactly what
 * `{ mutate() {…} }` states outright. Identifiers are followed through their
 * `const` initializers so an alias is not a way around the check.
 *
 * A call is NOT treated as executable. `{ userId: pub(value) }` is the
 * documented way to write metadata, and the call runs once while the literal
 * is built — before anything reads it — so it is not a callback the reader
 * can trigger.
 */
function valueRunsCode(context, node, seen = new Set()) {
  const value = unwrap(node);
  if (!value) return false;
  switch (value.type) {
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ClassExpression':
      return true;
    case 'ObjectExpression':
      return literalRunsCode(context, value, seen);
    case 'ArrayExpression':
      return value.elements.some((element) =>
        valueRunsCode(context, element, seen)
      );
    case 'Identifier': {
      const variable = resolveVariable(context, value);
      if (!variable || seen.has(variable)) return false;
      seen.add(variable);
      return valueRunsCode(context, immutableInit(variable), seen);
    }
    default:
      return false;
  }
}

function resolveObjectLiteral(context, node, seen = new Set()) {
  const current = unwrapFreeze(context, node);
  if (!current) return null;
  if (current.type === 'ObjectExpression') {
    return literalRunsCode(context, current) ? null : current;
  }

  if (current.type === 'Identifier') {
    const variable = resolveVariable(context, current);
    if (!variable || seen.has(variable)) return null;
    seen.add(variable);
    if (isMutable(context, variable)) return null;
    return resolveObjectLiteral(context, immutableInit(variable), seen);
  }

  return null;
}

/**
 * Look a property up in an object literal.
 *
 * A spread or a computed key anywhere poisons the whole lookup: both can
 * introduce or override the key we are about to approve, and neither is
 * visible to static analysis. `{ correlation: newCorrelationId(), [k]: id }`
 * is safe only if `k !== 'correlation'`, which we cannot know. Duplicate
 * literal keys resolve to the LAST, matching JavaScript.
 *
 * Anything executable ANYWHERE in the literal poisons it too, for the reason
 * given on {@link literalRunsCode}: reading one property can rewrite another,
 * so no property in such an object is a constant.
 */
/**
 * The same two lookups again, for RECEIVERS rather than values.
 *
 * Rule 1 and rule 2 want opposite things here. Asking "is this a constant"
 * of `const handlers = { emit: Log.info }` should say no — a call through
 * `handlers` could rewrite it. Asking "could `handlers.emit(msg)` be a logger
 * call" must still say yes, because answering no silences every rule at that
 * call site, which is the one outcome worse than a false positive.
 *
 * So receiver resolution follows the binding without the mutation gate and
 * without the executable-literal gate. It keeps the key-ambiguity checks: a
 * spread or computed key really can mean the method is not the one named.
 */
function resolveReceiverObject(context, node, seen = new Set()) {
  const current = unwrapFreeze(context, node);
  if (!current) return null;
  if (current.type === 'ObjectExpression') return current;
  if (current.type === 'Identifier') {
    const variable = resolveVariable(context, current);
    if (!variable || seen.has(variable)) return null;
    seen.add(variable);
    return resolveReceiverObject(context, bindingInit(variable), seen);
  }
  return null;
}

/**
 * Every value the property `name` of this container could hold: whatever the
 * literal gives it, plus anything a later `container.name = …` assigns.
 *
 * Reading only the initializer is a bypass, because receiver resolution
 * deliberately ignores mutation:
 * `const handlers = { emit: analytics.info }; handlers.emit = Log.info`
 * resolves to the stale non-logger value and falls silent on a call that is
 * a logger call by the time it runs.
 */
function receiverPropertyCandidates(context, node, name, callNode) {
  const candidates = [];
  const property = receiverProperty(resolveReceiverObject(context, node), name);
  if (property) candidates.push(property.value);

  const current = unwrap(node);
  if (!current || current.type !== 'Identifier') return candidates;
  const variable = resolveVariable(context, current);
  if (!variable) return candidates;

  for (const reference of variable.references) {
    const identifier = reference.identifier;
    const member = identifier.parent;
    if (!member || member.type !== 'MemberExpression') {
      const call = member;
      if (
        !call ||
        call.type !== 'CallExpression' ||
        !call.arguments.includes(identifier) ||
        !reachesCall(call, callNode)
      ) {
        continue;
      }

      // `Object.assign(handlers, { emit: Log.info })`, and the same thing one
      // refactor out as `Object.assign(handlers, methods)`, install the
      // method without ever naming `handlers.emit`.
      if (
        call.arguments[0] === identifier &&
        isNamespaceMethod(context, call, 'Object', 'assign')
      ) {
        for (const source of call.arguments.slice(1)) {
          const match = receiverProperty(
            resolveReceiverObject(context, source),
            name
          );
          if (match) candidates.push(match.value);
        }
        continue;
      }

      // `function configure(target, fn) { target.emit = fn }` called as
      // `configure(handlers, Log.info)` installs a logger this analysis does
      // not follow, and DELIBERATELY so. Following it means reproducing
      // interprocedural dataflow inside a lint rule: parameter defaults,
      // destructuring at any depth, rest patterns, spread arguments,
      // reassignment, shadowing, and every way a function can be invoked.
      // Seven review rounds went into an implementation that kept finding new
      // spellings, and the last one had started reporting ordinary code —
      // `{ [key]: () => Log.info('setup') }` is a callback that logs a
      // literal, not a logger installed on `handlers`.
      //
      // A lint rule that cries wolf gets switched off, and a rule that is
      // switched off protects nothing.
      //
      // Being in the same file is NOT what makes a logger followable — the
      // local `configure` above is exactly as invisible as an imported one.
      // What is followed is a logger that reaches the call site without
      // passing through a call: a direct call, a `Log.scoped(...)` result, a
      // `const` alias of a method, a property assignment, an object literal,
      // or `Object.assign`. Note that a call site this misses is outside ALL
      // FOUR rules, metadata keys included. The runtime redacts metadata
      // VALUES; keys are only stopped by the catalog, which is mandatory
      // under privacyDefault('private') and absent by default otherwise.
      // The README states the split in those terms.
      continue;
    }
    if (
      member.object !== identifier ||
      staticPropertyName(context, member) !== name
    ) {
      continue;
    }
    const assignment = member.parent;
    if (
      assignment &&
      assignment.type === 'AssignmentExpression' &&
      assignment.left === member &&
      reachesCall(assignment, callNode)
    ) {
      candidates.push(assignment.right);
    }
  }
  return candidates;
}

/**

/** Is this a call to `Namespace.method(…)` on the untampered global? */
function isNamespaceMethod(context, call, namespace, method) {
  const callee = unwrap(call.callee);
  return (
    !!callee &&
    callee.type === 'MemberExpression' &&
    builtinNamespaceOf(context, callee.object) === namespace &&
    staticPropertyName(context, callee) === method
  );
}

/**
 * Could this write affect that call?
 *
 * A write earlier in the file can. So can one written later but inside a
 * function or a loop, which may run first or run again. A later write in
 * straight-line code cannot, and counting it would report the call before it
 * on evidence that does not exist yet.
 */
function reachesCall(write, callNode) {
  if (!callNode || write.range[0] < callNode.range[0]) return true;
  // A write inside a function or loop may run first, or run again.
  if (isDeferred(write)) return true;
  // And so may the CALL: in
  // `function run() { h.emit(phi) } h.emit = Log.info; run();`
  // the write is later in the file and still happens first. Source order only
  // settles the question when both sit in straight-line code.
  return isDeferred(callNode);
}

/** Is this node somewhere that can run out of source order, or more than once? */
function isDeferred(node) {
  for (let current = node.parent; current; current = current.parent) {
    switch (current.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ForStatement':
      case 'ForOfStatement':
      case 'ForInStatement':
      case 'WhileStatement':
      case 'DoWhileStatement':
      // An INSTANCE field initializer runs at construction, which can be long
      // after the line it is written on: `class C { leak = h.emit(phi) }`
      // runs when something says `new C()`. A static field runs immediately,
      // in source order, so it settles like any other straight-line code and
      // the walk continues past it.
      // eslint-disable-next-line no-fallthrough
      case 'PropertyDefinition':
      case 'FieldDefinition':
      case 'AccessorProperty':
        if (!current.static) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

function receiverProperty(object, name) {
  if (!object) return null;
  let match = null;
  for (const property of object.properties) {
    // Spread and computed keys stay whole-object ambiguity: either can be the
    // key we are looking for under a spelling we cannot read.
    if (property.type === 'SpreadElement') return null;
    if (property.computed) return null;
    if (propertyKeyName(property) !== name) continue;
    // Only the MATCHING property has to be a plain value. An unrelated
    // `helper() {}` next to `emit: Log.info` says nothing about what `emit`
    // is, and discarding the whole container over it silences every rule at
    // the call site.
    if (property.kind !== 'init' || property.method) return null;
    match = property;
  }
  return match;
}

function objectProperty(context, object, name) {
  if (!object) return null;
  if (literalRunsCode(context, object)) return null;
  let match = null;
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') return null;
    if (property.computed) return null;
    if (propertyKeyName(property) !== name) continue;
    match = property;
  }
  return match;
}

/**
 * The compile-time value of a string expression, or null if it has none.
 *
 * Returns the string rather than a boolean so that a computed member access
 * (`Log[method]`) can be resolved to the name it actually reads.
 */
function staticStringValue(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return null;
  switch (current.type) {
    case 'Literal':
      return typeof current.value === 'string' ? current.value : null;
    case 'TemplateLiteral':
      // A template with no `${}` is just a literal spelled differently.
      return current.expressions.length === 0
        ? current.quasis[0].value.cooked
        : null;
    case 'Identifier': {
      const variable = resolveVariable(context, current);
      if (!variable || seen.has(variable)) return null;
      seen.add(variable);
      // No mutability check here, deliberately. Whatever this resolves to is
      // a string, and a string cannot be changed by anything an escape could
      // do to it — member writes are no-ops on a primitive, and `immutableInit`
      // already restricts this to `const`, which forbids rebinding. Escape
      // analysis belongs to the object paths, and `MemberExpression` below
      // still goes through it.
      return staticStringValue(context, immutableInit(variable), seen);
    }
    case 'MemberExpression': {
      // `MESSAGES.startup`, where MESSAGES is a const object of literals that
      // nothing writes through and nothing else can reach.
      const name = staticPropertyName(context, current, seen);
      if (name === null) return null;
      const object = resolveObjectLiteral(context, current.object, seen);
      const property = objectProperty(context, object, name);
      return property ? staticStringValue(context, property.value, seen) : null;
    }
    default:
      return null;
  }
}

/** Is this expression a compile-time-constant string? */
function isStaticString(context, node) {
  return staticStringValue(context, node) !== null;
}

/**
 * The property name of a member expression, however it is spelled: a dot, a
 * string subscript, or a subscript that resolves to a constant string.
 * `Log.info`, `Log['info']` and `const m = 'info'; Log[m]` are one thing.
 */
function staticPropertyName(context, node, seen = new Set()) {
  if (!node || node.type !== 'MemberExpression') return null;
  if (!node.computed) {
    // `this.#logger` is as much a named field as `this.logger`; the hash is
    // visibility, not identity.
    return node.property.type === 'Identifier' ||
      node.property.type === 'PrivateIdentifier'
      ? node.property.name
      : null;
  }
  return staticStringValue(context, node.property, new Set(seen));
}

/**
 * A message argument is acceptable when it is a static string, or a thunk
 * whose body is one. `() => \`patient ${id}\`` is exactly the dynamic case
 * the lazy-message API would otherwise smuggle past a naive check.
 */
function isStaticMessage(context, node) {
  const current = unwrap(node);
  if (!current) return false;
  if (isStaticString(context, current)) return true;
  if (
    current.type === 'ArrowFunctionExpression' ||
    current.type === 'FunctionExpression'
  ) {
    if (current.body.type === 'BlockStatement') {
      const statements = current.body.body;
      if (statements.length !== 1 || statements[0].type !== 'ReturnStatement') {
        return false;
      }
      return isStaticString(context, statements[0].argument);
    }
    return isStaticString(context, current.body);
  }
  return false;
}

/* -------------------------------------------------------------------------
 * Receiver classification
 * ---------------------------------------------------------------------- */

/**
 * Classify a call's receiver: the Logger singleton, a ScopedLogger, or
 * something carrying a logger name that resolves to neither.
 *
 * Argument roles differ between the two shapes — `Log.info(msg, meta, sub)`
 * vs `scope.info(msg, meta)`, `Log.log(msg, options)` vs `scope.log(msg,
 * level, meta)` — so rules that key off position must know which they have.
 *
 * Resolution happens BEFORE the name check. `const logger = Log.scoped()` is
 * a ScopedLogger whatever it is called, and trusting the spelling first is
 * exactly how its metadata argument goes unexamined.
 *
 * The distinction between `'logger'` and `'ambiguous'` is provenance, not
 * confidence: an import of the singleton, or a bare global spelled with its
 * documented name, IS the Logger. A parameter or a property that merely
 * happens to be called `logger` could be anything, and correlation
 * provenance in particular must not trust it.
 *
 * @returns {'logger' | 'scoped' | 'ambiguous' | null}
 */
function classifyReceiver(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return null;

  if (current.type === 'Identifier') {
    const variable = resolveVariable(context, current);
    if (variable && !seen.has(variable)) {
      seen.add(variable);
      const def = singleDef(variable);

      // `import { Log } from 'react-native-nitro-logger'`, possibly renamed.
      if (def && def.type === 'ImportBinding') {
        if (isLoggerImport(context, def)) return 'logger';
        // Same name, unknown module: still worth CHECKING its calls, never
        // worth TRUSTING as the singleton.
        const imported = def.node.imported?.name ?? def.node.local?.name;
        return loggerNames(context).has(imported) ? 'ambiguous' : null;
      }

      const init = bindingInit(variable);
      if (init) return classifyReceiver(context, init, seen);

      // A parameter, or a binding we cannot pin down. The name is a hint,
      // never proof.
      return loggerNames(context).has(current.name) ? 'ambiguous' : null;
    }
    if (seen.has(variable)) return null;
    // Unresolved global. Only the canonical name is the singleton itself.
    if (current.name === canonicalLoggerName(context)) return 'logger';
    return loggerNames(context).has(current.name) ? 'ambiguous' : null;
  }

  // `this.logger.info(…)`, `deps.log.info(…)` — very common, and the property
  // name is the only signal available, so it can only ever be a hint.
  if (current.type === 'MemberExpression') {
    const name = staticPropertyName(context, current);
    return name !== null && loggerNames(context).has(name) ? 'ambiguous' : null;
  }

  // `Log.scoped(…)` and `scope.scoped(…)` both produce a ScopedLogger.
  if (current.type === 'CallExpression') {
    const callee = unwrap(current.callee);
    if (
      callee &&
      callee.type === 'MemberExpression' &&
      staticPropertyName(context, callee) === 'scoped' &&
      classifyReceiver(context, callee.object, seen) !== null
    ) {
      return 'scoped';
    }
    return null;
  }

  // `new ScopedLogger(…)` / `new Logger(…)`.
  if (current.type === 'NewExpression') {
    return classifyConstruction(context, current);
  }

  return null;
}

/**
 * What `new X(…)` produces, and how sure we are.
 *
 * Returns `{ kind: 'scoped' | 'logger', verified: boolean }`, or `null` when
 * the callee is nothing this cares about.
 *
 * The two answers are needed separately because they buy different things.
 * `kind` decides whether the arguments are WORTH CHECKING — a `new
 * ScopedLogger(…)` puts a correlation ID and a subsystem in the two channels
 * the runtime cannot redact no matter where the class was imported from.
 * `verified` decides whether the construction is worth TRUSTING, which is a
 * much stronger claim and the only thing that may relax a check.
 *
 * Collapsing them is how the first cut of this fix left the most common real
 * spelling unguarded. An app with `export { ScopedLogger } from
 * 'react-native-nitro-logger'` in `src/logging.ts` imports the genuine class
 * through a local barrel, which cannot be traced to the package by specifier,
 * so it is unverified — and treating unverified as "not a ScopedLogger at all"
 * meant `new ScopedLogger(Log, patient.id, …)` reported nothing, while the
 * `Log.scoped(patient.id, …)` spelling of the same leak reported `derived`.
 * That is the C2 defect reproduced one layer in.
 *
 * Provenance is decided the same way {@link isLoggerImport} decides it for the
 * singleton — by the module the binding came from, not by what it is called.
 * A local `class Logger {}` is not this package's Logger, and trusting it
 * would let its own `newCorrelationId` mint approved IDs.
 *
 * Only a named import carries an exported symbol. A default or namespace
 * import binds whatever the module chose to put there, so `import AppScope
 * from './logging'` is not the export named `AppScope` and does not qualify as
 * verified however the options are configured.
 */
function constructionProvenance(context, node) {
  const callee = unwrap(node.callee);
  if (!callee) return null;

  const scopedNames = scopedClassNames(context);
  const loggerNamesOfClasses = loggerClassNames(context);
  const byName = (name) => {
    if (scopedNames.has(name)) return 'scoped';
    if (loggerNamesOfClasses.has(name)) return 'logger';
    return null;
  };

  // `new M.Logger()` — the specifier check cannot see through a namespace
  // object to learn which module the class came from, so this is a property
  // name and nothing more. Never verified.
  if (callee.type === 'MemberExpression') {
    const name = staticPropertyName(context, callee);
    if (name === null) return null;
    const kind = byName(name);
    return kind && { kind, verified: false };
  }

  if (callee.type !== 'Identifier') return null;

  const variable = resolveVariable(context, callee);
  const def = variable && singleDef(variable);

  // A named import is the only form that carries an exported symbol. Reading
  // `imported` means an alias still resolves to the class it aliases:
  // `import { ScopedLogger as S }` and `new S(…)` is still a ScopedLogger.
  if (
    def &&
    def.type === 'ImportBinding' &&
    def.node.type === 'ImportSpecifier'
  ) {
    const kind = byName(def.node.imported?.name);
    if (!kind) return null;
    const source = def.parent?.source?.value;
    return {
      kind,
      verified:
        typeof source === 'string' && loggerModules(context).has(source),
    };
  }

  // A local class, a parameter, a default or namespace import, or a binding
  // that cannot be pinned down. The name is a hint; it is never provenance.
  const kind = byName(callee.name);
  return kind && { kind, verified: false };
}

/**
 * The receiver classification for `new X(…)`.
 *
 * Unverified constructions resolve to `'ambiguous'` rather than `null`,
 * matching the identifier branch above: their calls are still worth CHECKING,
 * they are just never worth TRUSTING. The asymmetry is deliberate — a false
 * report on a lookalike costs a suppression comment, a missed one costs a
 * patient identifier in a log file.
 */
function classifyConstruction(context, node) {
  const provenance = constructionProvenance(context, node);
  if (!provenance) return null;
  return provenance.verified ? provenance.kind : 'ambiguous';
}

/** Could this receiver be the Logger singleton? */
function maybeLogger(receiver) {
  return receiver === 'logger' || receiver === 'ambiguous';
}

/**
 * Is this expression provably the Logger the package ships?
 *
 * Stricter than `classifyReceiver(...) === 'logger'`, and deliberately so.
 * Classification exists to decide what to CHECK, where a bare global named
 * `Log` is a fine hint. This exists to decide what to TRUST — currently only
 * `newCorrelationId`'s provenance — and a name that nothing in the file
 * defines proves nothing at all: `globalThis.Log = fakeLogger` satisfies it.
 * Only a binding traceable to an import of the real package counts.
 */
function isTrustedLogger(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current) return false;

  // `Log.scoped(id, 'net')` — a scope minted by a trusted Logger inherits its
  // trust, so `scope.info(M)` stays exempt from mutation analysis.
  if (current.type === 'CallExpression') {
    const callee = unwrap(current.callee);
    return (
      !!callee &&
      callee.type === 'MemberExpression' &&
      staticPropertyName(context, callee) === 'scoped' &&
      isTrustedLogger(context, callee.object, seen)
    );
  }

  if (current.type !== 'Identifier') return false;
  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return false;
  seen.add(variable);

  // The binding has to still hold what it was given. A rebind
  // (`let L = Log; L = fakeLogger`), a write through it
  // (`Log.newCorrelationId = () => patient.mrn`), or an escape into code we
  // cannot see all mean the method we are about to trust may not be the one
  // the package shipped.
  if (isMutable(context, variable)) return false;

  const def = singleDef(variable);
  if (def && def.type === 'ImportBinding') return isLoggerImport(context, def);
  // `const` only: `immutableInit` rather than `bindingInit`, because the
  // latter reports a declaration initializer that a later write has replaced.
  return isTrustedLogger(context, immutableInit(variable), seen);
}

/* -------------------------------------------------------------------------
 * Call description
 * ---------------------------------------------------------------------- */

function hasSpread(args) {
  return args.some((a) => a.type === 'SpreadElement');
}

/** `Log.info`, `Log['info']`, `Log.info.bind(Log)` → a described method. */
function describeMethodReference(context, node, args) {
  const current = unwrap(node);
  if (!current) return null;

  if (current.type === 'MemberExpression') {
    const method = staticPropertyName(context, current);
    if (method === null || !API_METHODS.has(method)) return null;
    const receiver = classifyReceiver(context, current.object);
    if (receiver === null) return null;
    return { method, receiver, args, spreadArgs: hasSpread(args) };
  }

  // A partially applied bind shifts every position, so it is reported as
  // unanalyzable rather than trusted.
  if (current.type === 'CallExpression') {
    const callee = unwrap(current.callee);
    if (
      callee &&
      callee.type === 'MemberExpression' &&
      staticPropertyName(context, callee) === 'bind'
    ) {
      const inner = describeMethodReference(context, callee.object, args);
      if (!inner) return null;
      return {
        ...inner,
        spreadArgs: inner.spreadArgs || current.arguments.length > 1,
      };
    }
  }

  return null;
}

/**
 * Describe any call into the logger's public API — level helpers, `log`,
 * `scoped`, `subsystem`, `resetSubsystem` — normalizing away
 * `.call`/`.apply`/`.bind`, computed access, destructured methods and method
 * aliases so every rule sees one shape.
 *
 * Returns `{ method, receiver, args, spreadArgs }` where `args` are the
 * logical arguments with any `thisArg` stripped, or null if this is not an
 * API call. `spreadArgs` means the call exists but its arguments cannot be
 * matched to positions — which is a finding, not a reason to stay quiet.
 */
function describeCall(context, node) {
  const callee = unwrap(node.callee);
  if (!callee) return null;

  if (callee.type === 'MemberExpression') {
    // `Log.info.call(thisArg, message, …)` / `.apply(thisArg, argsArray)`
    const outer = staticPropertyName(context, callee);
    if (outer === 'call' || outer === 'apply') {
      const inner = unwrap(callee.object);
      if (inner && inner.type === 'MemberExpression') {
        const method = staticPropertyName(context, inner);
        if (method !== null && API_METHODS.has(method)) {
          const receiver = classifyReceiver(context, inner.object);
          if (receiver === null) return null;
          const args = outer === 'call' ? node.arguments.slice(1) : [];
          return {
            method,
            receiver,
            // `.apply` passes an array — positional analysis is meaningless,
            // so report only that the call exists.
            args,
            spreadArgs: outer === 'apply' || hasSpread(args),
          };
        }
      }
    }

    const method = staticPropertyName(context, callee);
    const receiver = classifyReceiver(context, callee.object);

    if (method !== null && API_METHODS.has(method)) {
      if (receiver === null) return null;
      return {
        method,
        receiver,
        args: node.arguments,
        spreadArgs: hasSpread(node.arguments),
      };
    }

    // `Log['in' + 'fo'](…)` / `Log[pick()](…)` — the receiver is a logger and
    // the method is unreadable, so we cannot rule out that this is a log
    // call. That is a finding, not a reason to fall silent.
    if (method === null && callee.computed && receiver !== null) {
      return {
        method: null,
        receiver,
        args: node.arguments,
        spreadArgs: true,
        opaqueMethod: true,
      };
    }

    // `const handlers = { emit: Log.info }; handlers.emit(msg)` — the method
    // lives in a const object rather than a binding of its own.
    if (method !== null) {
      const candidates = receiverPropertyCandidates(
        context,
        callee.object,
        method,
        node
      );
      const described = candidates
        .map((value) => describeMethodReference(context, value, node.arguments))
        .filter(Boolean);
      // Exactly one possible value, and it is a logger method: analyze it.
      if (candidates.length === 1 && described.length === 1)
        return described[0];
      // Several possible values and at least one is a logger method. Which
      // one runs is unknowable, so this is a finding rather than a guess.
      if (described.length > 0) {
        return {
          method: null,
          receiver: described[0].receiver,
          args: node.arguments,
          spreadArgs: true,
          opaqueMethod: true,
        };
      }
    }
    return null;
  }

  // `(Log.info.bind(Log))(msg)` — the callee is the bind call itself.
  if (callee.type === 'CallExpression') {
    return describeMethodReference(context, callee, node.arguments);
  }

  if (callee.type !== 'Identifier') return null;

  const variable = resolveVariable(context, callee);
  const def = singleDef(variable);
  if (!def || def.type !== 'Variable') return null;

  const pattern = def.node.id;

  // `const { info } = Log` / `{ info: emit }` / `{ info = fallback }`
  if (pattern.type === 'ObjectPattern') {
    const property = pattern.properties.find((p) => {
      if (p.type !== 'Property') return false;
      const target =
        p.value.type === 'AssignmentPattern' ? p.value.left : p.value;
      return target === def.name;
    });
    if (!property) return null;
    const method = propertyKeyName(property);
    if (method === null || !API_METHODS.has(method)) return null;
    const receiver = classifyReceiver(context, def.node.init);
    if (receiver === null) return null;
    return {
      method,
      receiver,
      args: node.arguments,
      spreadArgs: hasSpread(node.arguments),
    };
  }

  // `const emit = Log.info` and `const [emit] = [Log.info]`, plus the `.bind`
  // form of either.
  return describeMethodReference(
    context,
    bindingInit(variable),
    node.arguments
  );
}

/**
 * An API call restricted to the message-emitting methods — plus calls whose
 * method name could not be read at all, since one of the things they could be
 * is a log call.
 */
function describeLogCall(context, node) {
  const call = describeCall(context, node);
  if (!call) return null;
  return LOG_METHODS.has(call.method) || call.opaqueMethod ? call : null;
}

/**
 * Anything that produces a ScopedLogger, with its arguments normalized.
 *
 * `Log.scoped(correlation, subsystem, metadata)` and
 * `new ScopedLogger(logger, correlation, subsystem, metadata)` carry the same
 * three channels; the constructor just puts the logger in front. Dropping that
 * first argument here means both forms present `args[0]` as correlation and
 * `args[1]` as subsystem, so the rules that read those positions cover the
 * constructor without knowing it exists.
 *
 * That normalization is the fix for the half of this that receiver
 * classification does not reach: classifying `new ScopedLogger(…)` makes later
 * `scope.info(…)` calls checkable, but the identifiers passed to the
 * constructor itself are already in the two unredactable channels.
 */
function describeScopedCall(context, node) {
  if (node.type === 'NewExpression') {
    // CHECKED whether or not the class can be traced to the package: an
    // unverified `new ScopedLogger(…)` still puts its arguments in the two
    // unredactable channels. Requiring verification here is what left the
    // local-barrel spelling — the common one — reporting nothing.
    const provenance = constructionProvenance(context, node);
    if (!provenance || provenance.kind !== 'scoped') return null;
    const args = node.arguments.slice(1);
    return {
      method: 'scoped',
      receiver: provenance.verified ? 'scoped' : 'ambiguous',
      args,
      // A spread anywhere makes every later position unknowable — including a
      // spread in the logger slot, which shifts everything after it.
      spreadArgs: hasSpread(node.arguments),
    };
  }

  const call = describeCall(context, node);
  return call && call.method === 'scoped' ? call : null;
}

/** `Log.subsystem(name, level)` / `Log.resetSubsystem(name)`. */
function describeSubsystemConfigCall(context, node) {
  const call = describeCall(context, node);
  if (!call || !CONFIG_METHODS.has(call.method)) return null;
  // ScopedLogger has no level-configuration API.
  return maybeLogger(call.receiver) ? call : null;
}

/* -------------------------------------------------------------------------
 * Argument-position modeling
 * ---------------------------------------------------------------------- */

const ABSENT = { kind: 'absent' };
const found = (node) => ({ kind: 'value', node });
const opaque = (node) => ({ kind: 'unanalyzable', node });

/** Nothing passed in this position, or an explicit "no value". */
function isOmitted(context, node) {
  const current = unwrap(node);
  if (!current) return true;
  if (current.type === 'Literal' && current.value === null) return true;
  if (current.type === 'Identifier' && current.name === 'undefined') {
    // Only the real global; a local named `undefined` is someone's problem.
    const variable = resolveVariable(context, current);
    return !variable || variable.defs.length === 0;
  }
  return false;
}

/**
 * A named property of an options object, following `const` aliases.
 *
 * @returns {{kind:'value',node}|{kind:'absent'}|{kind:'unanalyzable',node}}
 */
function optionsProperty(context, node, name) {
  const current = unwrap(node);
  if (isOmitted(context, current)) return ABSENT;
  const object = resolveObjectLiteral(context, current);
  if (!object) return opaque(current);
  // A spread or a computed key can introduce or override this field under a
  // spelling we cannot read, so neither can be reasoned past.
  const wildcard = object.properties.find(
    (p) => p.type === 'SpreadElement' || p.computed
  );
  if (wildcard) return opaque(wildcard.key ?? wildcard);
  const property = objectProperty(context, object, name);
  if (!property) return ABSENT;
  // `{ subsystem: undefined }` states the field is absent, which is what the
  // runtime sees too.
  return isOmitted(context, property.value) ? ABSENT : found(property.value);
}

/**
 * `Log.log(msg, options)` and `scope.log(msg, level, meta)` share a name.
 * When the receiver is ambiguous the second argument decides: a bare level
 * string means the ScopedLogger shape, an object literal means the Logger
 * shape, and anything else — including an omitted argument, since a scope's
 * level is defaulted — means both have to be checked.
 */
function logCallShape({ receiver, args, method }, context) {
  // `logMessage` exists only on the Logger and takes exactly one shape,
  // `(message, options)`. There is no ScopedLogger overload to disambiguate
  // against, so it never needs the argument sniffing below.
  if (method === 'logMessage') return 'logger';
  if (receiver === 'scoped') return 'scoped';
  if (receiver === 'logger') return 'logger';
  const second = unwrap(args[1]);
  const level = staticStringValue(context, second);
  if (level !== null && LEVEL_METHODS.has(level)) return 'scoped';
  if (second && second.type === 'ObjectExpression') return 'logger';
  return 'both';
}

/**
 * Every argument position carrying metadata for this call.
 *
 * `Log.<level>(message, metadata, subsystem)` · `scope.<level>(message,
 * metadata)` · `scope.log(message, level, metadata)` · `Log.log(message,
 * { metadata })`.
 */
function metadataArguments(context, call) {
  // Spread is handled by the rule, which has the call node to report on.
  if (call.spreadArgs) return [];
  const { method, args } = call;
  if (!OPTIONS_METHODS.has(method)) {
    return isOmitted(context, args[1]) ? [] : [found(args[1])];
  }

  const shape = logCallShape(call, context);
  const results = [];
  if (shape === 'scoped' || shape === 'both') {
    if (!isOmitted(context, args[2])) results.push(found(args[2]));
  }
  if (shape === 'logger' || shape === 'both') {
    for (const field of METADATA_OPTION_FIELDS) {
      const property = optionsProperty(context, args[1], field);
      if (property.kind !== 'absent') results.push(property);
    }
  }
  // One node, one result. An options object nobody can read is unreadable for
  // every field at once — a spread or a computed key makes `optionsProperty`
  // hand back the *same* wildcard node for `metadata` and for `scopeMetadata`
  // — and the loop above would otherwise return it once per field. That is two
  // errors at byte-identical ranges on a single `...opts`, which reads as two
  // problems and is one.
  //
  // Identity, not position: two real fields always have distinct value nodes,
  // so nothing legitimate collapses. `{ metadata: x, scopeMetadata: x }` is two
  // references to `x` and therefore two nodes.
  const seen = new Set();
  return results.filter((result) => {
    if (seen.has(result.node)) return false;
    seen.add(result.node);
    return true;
  });
}

/* -------------------------------------------------------------------------
 * Free functions
 * ---------------------------------------------------------------------- */

/**
 * The package's own exported free functions, and which fields of their options
 * object feed a channel a rule polices.
 *
 * Every subsystem and correlation rule here is built around a receiver, and a
 * free function has none — `classifyReceiver` has nothing to classify, so
 * `installErrorHandler({ subsystem: patientId })` was invisible to the whole
 * plugin. It is not a marginal channel: that name is attached to every
 * uncaught-error entry the handler emits and renders unredacted in each one.
 *
 * Enumerated rather than discovered, and pinned against the real option
 * interfaces by a test in `eslintPlugin.test.js`. The failure this table has to
 * survive is a new integration, or a new field on an existing one, that carries
 * a channel nobody wired up — which is exactly how this gap opened.
 *
 * `flushOnBackground` is listed with no channels on purpose. It takes an
 * options object and none of its fields reach a policed channel today; leaving
 * it out entirely would make "absent from the table" ambiguous between
 * "checked, nothing to check" and "never considered".
 */
const FREE_FUNCTION_OPTION_CHANNELS = {
  installErrorHandler: { subsystem: ['subsystem'] },
  flushOnBackground: {},
};

/**
 * The exported name a callee resolves to, or null when it is not ours.
 *
 * Verified by import, not by name, for the reason `isLoggerImport` gives: an
 * application's own `installErrorHandler` is not this package's, and demanding
 * a literal subsystem of it would be a false positive on unrelated code. So the
 * binding has to be an import whose *imported* name is in the table — aliasing
 * on the way in changes the local spelling and nothing else — and whose module
 * is one that ships this package.
 *
 * The cost of that strictness, stated rather than hidden: a re-export barrel is
 * not followed. `import { installErrorHandler } from './logging'` is unchecked
 * until './logging' is added to `loggerModules`, which is what that option is
 * for. Following arbitrary re-exports would mean resolving modules from a lint
 * rule, and the same trade is already made for the Logger itself.
 */
function integrationName(context, callee) {
  const current = unwrap(callee);
  if (!current) return null;

  // `installErrorHandler(…)`, under whatever local name the import gave it.
  //
  // A *named* import and nothing else. A default import binds whatever the
  // module's default export happens to be, and its local spelling is the
  // author's choice — `import installErrorHandler from '…'` says nothing about
  // what it received, so reading the local name there would lint a function
  // this package never exported on the strength of its variable name.
  if (current.type === 'Identifier') {
    const def = importDefFrom(context, current);
    if (!def || def.node.type !== 'ImportSpecifier') return null;
    // `imported` is a Literal for a string-named import (`{ 'a-b' as x }`),
    // which has no `.name` and is therefore not in the table.
    return knownIntegration(def.node.imported?.name);
  }

  // `import * as logger from '…'; logger.installErrorHandler(…)` reaches the
  // identical function, and a namespace import is the ordinary way to write it.
  if (current.type === 'MemberExpression') {
    const property = staticPropertyName(context, current);
    if (property === null) return null;
    const object = unwrap(current.object);
    if (!object || object.type !== 'Identifier') return null;
    const def = importDefFrom(context, object);
    if (!def || def.node.type !== 'ImportNamespaceSpecifier') return null;
    return knownIntegration(property);
  }

  return null;
}

/** The import this identifier binds to, if it came from a module we ship. */
function importDefFrom(context, identifier) {
  const def = singleDef(resolveVariable(context, identifier));
  if (!def || def.type !== 'ImportBinding') return null;
  const source = def.parent?.source?.value;
  if (typeof source !== 'string' || !loggerModules(context).has(source)) {
    return null;
  }
  return def;
}

function knownIntegration(name) {
  return typeof name === 'string' &&
    Object.prototype.hasOwnProperty.call(FREE_FUNCTION_OPTION_CHANNELS, name)
    ? name
    : null;
}

/**
 * A call to one of this package's free functions.
 *
 * Returns null for anything else, including a locally declared function that
 * merely shares the name — that one is provably not ours.
 */
function describeIntegrationCall(context, node) {
  if (!node || node.type !== 'CallExpression') return null;
  const name = integrationName(context, node.callee);
  if (!name) return null;
  return {
    name,
    node,
    args: node.arguments,
    spreadArgs: node.arguments.some((a) => a.type === 'SpreadElement'),
  };
}

/**
 * Argument positions carrying a subsystem name in a free-function call.
 *
 * The spread case is answered here rather than by the rule, because it is the
 * same question: whether *this* function has a subsystem channel at all. A
 * spread hides the options object, so for a function that takes a subsystem the
 * name is somewhere unreadable rather than provably absent — reported against
 * the call, which is the only node there is. For a function that takes none —
 * `flushOnBackground` — there was never anything to read, and reporting its
 * spread would be an error about a channel that does not exist.
 */
function integrationSubsystemArguments(context, call) {
  const fields = FREE_FUNCTION_OPTION_CHANNELS[call.name]?.subsystem ?? [];
  if (fields.length === 0) return [];
  if (call.spreadArgs) return [{ kind: 'unanalyzable', node: call.node }];
  const results = [];
  for (const field of fields) {
    const property = optionsProperty(context, call.args[0], field);
    if (property.kind !== 'absent') results.push(property);
  }
  return results;
}

/** Positions carrying an options-object field of the Logger shape. */
function loggerOptionField(context, call, name) {
  if (!OPTIONS_METHODS.has(call.method)) return [];
  const shape = logCallShape(call, context);
  if (shape === 'scoped') return [];
  const property = optionsProperty(context, call.args[1], name);
  return property.kind === 'absent' ? [] : [property];
}

/** Argument positions carrying a subsystem name. */
function subsystemArguments(context, call) {
  const { method, receiver, args } = call;
  if (!OPTIONS_METHODS.has(method)) {
    // Only the Logger's level helpers take a subsystem third argument;
    // ScopedLogger inherits it and has no such parameter.
    if (!maybeLogger(receiver)) return [];
    if (call.spreadArgs) return [];
    return isOmitted(context, args[2]) ? [] : [found(args[2])];
  }
  if (call.spreadArgs) return [];
  return loggerOptionField(context, call, 'subsystem');
}

/** Argument positions carrying a correlation ID. */
function correlationArguments(context, call) {
  if (call.spreadArgs) return [];
  return loggerOptionField(context, call, 'correlation');
}

module.exports = {
  API_METHODS,
  CONFIG_METHODS,
  FREE_FUNCTION_OPTION_CHANNELS,
  LEVEL_METHODS,
  LOGGER_OWN_METHODS,
  LOG_METHODS,
  METADATA_OPTION_FIELDS,
  OPTIONS_METHODS,
  RECEIVER_OPTION_PROPERTIES,
  classifyConstruction,
  classifyReceiver,
  correlationArguments,
  describeCall,
  describeIntegrationCall,
  describeLogCall,
  describeScopedCall,
  describeSubsystemConfigCall,
  integrationSubsystemArguments,
  isMutable,
  isOmitted,
  isStaticMessage,
  isStaticString,
  isTrustedLogger,
  maybeLogger,
  metadataArguments,
  objectProperty,
  optionsProperty,
  resolveObjectLiteral,
  resolveVariable,
  singleDef,
  staticPropertyName,
  staticStringValue,
  subsystemArguments,
  unwrap,
};
