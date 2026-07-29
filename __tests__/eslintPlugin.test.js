'use strict';

const { ESLint, RuleTester } = require('eslint');
const tsParser = require('@typescript-eslint/parser');
const plugin = require('../eslint-plugin');

/**
 * Handing an object to a logger call is the one escape the mutation analysis
 * forgives — but only for a logger it can PROVE is the one the package ships.
 * An unresolved global named `Log` could be anything, including a function
 * that rewrites the object it was handed, so fixtures about object metadata
 * have to import the real thing. Message and subsystem fixtures do not: their
 * values are strings, which no escape can alter.
 */
const IMPORT_LOG = "import { Log } from 'react-native-nitro-logger';";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

/**
 * The same rules again through the TypeScript parser. The plugin's real
 * workload is `.ts`/`.tsx`, whose AST carries wrapper nodes espree never
 * produces — `as`, `satisfies`, `!`, `<T>x` — and each of those wrappers is
 * a one-token bypass if the analysis does not strip it.
 */
const tsRuleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

/**
 * `.tsx` is a different grammar, not a superset: enabling JSX is what makes
 * `<any>x` an unclosed element rather than a type assertion. Both are real
 * source files in an RN app, so both get exercised.
 */
const tsxRuleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

/**
 * Bypass fixtures matter more than the happy path here. A rule that only
 * matches `Log.info(...)` is a speed bump: aliasing, destructuring, computed
 * access and `.call` are the first things a developer reaches for when a
 * lint rule is in the way, and each one must still be caught.
 */
describe('no-dynamic-message', () => {
  ruleTester.run('no-dynamic-message', plugin.rules['no-dynamic-message'], {
    valid: [
      "Log.info('started');",
      'Log.info(`started`);',
      "Log.error('failed', { code: 4 });",
      "const MSG = 'started'; Log.info(MSG);",
      "const M = Object.freeze({ up: 'started' }); Log.info(M.up);",
      "const M = { up: 'started' }; Log.info(M.up);",
      // Passing the table to a PROVEN logger call, or a key-reading builtin,
      // is not an escape — otherwise every metadata object would be opaque.
      `${IMPORT_LOG} const M = { up: 'started' }; Log.info('m', M); Log.info(M.up);`,
      "const M = { up: 'started' }; Object.keys(M); Log.info(M.up);",
      `${IMPORT_LOG} const M = { up: 'started' }; Log.info.call(Log, 'm', M); Log.info(M.up);`,
      // Destructuring a scalar copies it. Whatever happens to the copy
      // afterwards cannot reach the table it came from, and treating it as an
      // escape would reject ordinary code.
      "const M = { up: 'started' }; const { up } = M; consume(up); Log.info(M.up);",
      "const M = { a: 'x', b: 'y' }; const { a: first, b: second } = M; consume(first, second); Log.info(M.a);",
      // A call through a PROVEN logger, to one of the package's OWN methods,
      // is not a mutation of it. That has to hold across the whole API or the
      // singleton goes untrusted the moment anyone mints a correlation ID or
      // configures a level.
      `${IMPORT_LOG} const id = Log.newCorrelationId(); const s = Log.scoped(id, 'net'); const M = { up: 'started' }; s.info('m', M); Log.info(M.up);`,
      `${IMPORT_LOG} Log.privacyDefault('private').minimumLevel('info'); const M = { up: 'started' }; Log.info('m', M); Log.info(M.up);`,
      // A write to a local shadow is not a write to the global namespace.
      "function f() { const Object = {}; Object.keys = fake; } const M = { up: 'started' }; Object.keys(M); Log.info(M.up);",
      // An object that never held a logger method is not a logger call site.
      'const cache = {}; cache.get = fn; cache.get(key);',
      // A write AFTER the call cannot affect it, so it must not make the call
      // ambiguous in hindsight — when both sit in straight-line code.
      "const h = { emit: Log.info }; h.emit('safe'); h.emit = analytics.info;",
      // KNOWN LIMITATION, and a deliberate one — see the README section
      // "What the rules cannot see". A logger installed onto an object by a
      // function call is not followed, whether the function is local or
      // imported, and such a call site is outside ALL FOUR rules rather than
      // the message rule alone. These fixtures pin the silence so that
      // restoring the analysis is a decision someone makes on purpose rather
      // than a side effect.
      //
      // The rules did follow local helpers for several revisions. Doing it
      // correctly means interprocedural dataflow — parameter defaults,
      // destructuring at any depth, rest patterns, spreads, reassignment,
      // shadowing, and every invocation form — and the implementation kept
      // admitting new spellings while starting to report ordinary code. A
      // rule that reports ordinary code gets switched off, and a rule that is
      // switched off protects nothing.
      'const cache = {}; configure(cache, fn); cache.get(key);',
      'const cache = {}; function process(t, fn) { t.onError = fn; } process(cache, Log.info); cache.get(key);',
      'const h = {}; function configure(target, fn) { target.emit = fn; } configure(h, Log.info); h.emit(patientName);',
      'const h = {}; function configure(target) { target.emit = Log.info; } configure(h); h.emit(patientName);',
      'const h = {}; function configure(t, fn = Log.info) { t.emit = fn; } configure(h); h.emit(patientName);',
      'const h = {}; function configure(t, { emit }) { t.emit = emit; } configure(h, { emit: Log.info }); h.emit(patientName);',
      'const h = {}; function configure(t, ...rest) { t.emit = rest[0]; } configure(h, Log.info); h.emit(patientName);',
      'const h = {}; function setup(c) { c.get = makeGetter(); } setup(h); h.get(patientName);',
      // A STATIC field runs immediately, in source order, so a later
      // straight-line write cannot reach back to it.
      "const h = { emit: Log.info }; class C { static leak = h.emit('safe'); } h.emit = analytics.info;",
      'const target = {}; Object.assign(target, { a: 1 }); target.a();',
      "const h = { helper() {}, emit: Log.info }; h.emit('started');",
      "Log.info(() => 'expensive but constant');",
      "Log.info(() => { return 'constant'; });",
      "const s = Log.scoped('c'); s.info('started');",
      "const L = Log; L.info('started');",
      "const { info } = Log; info('started');",
      "Log.info.call(null, 'started');",
      "Log['info']('started');",
      "import { Log as AuditLog } from 'react-native-nitro-logger'; AuditLog.info('started');",
      "class A { m() { this.logger.info('started'); } }",
      "const emit = Log.info; emit('started');",
      // Not a logger — out of scope, must not produce noise.
      'analytics.info(`user ${id}`);',
      'notALogger.debug(dynamic);',
    ],
    invalid: [
      {
        code: 'Log.info(`patient ${id} admitted`);',
        errors: [{ messageId: 'dynamic' }],
      },
      { code: 'Log.info(patientName);', errors: [{ messageId: 'dynamic' }] },
      // The bypass this rule cared about most: `logMessage` is public and is
      // what every level helper calls, so an interpolated message through it
      // reaches a log file by exactly the same path.
      {
        code: 'Log.logMessage(`patient ${id} admitted`);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "Log.logMessage(patientName, { level: 'error' });",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "Log.info('patient ' + id);",
        errors: [{ messageId: 'dynamic' }],
      },
      { code: 'Log.error(err.message);', errors: [{ messageId: 'dynamic' }] },
      {
        code: 'Log.info(formatMessage(patient));',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "Log.info(flag ? 'a' : dynamic);",
        errors: [{ messageId: 'dynamic' }],
      },
      // A lazy thunk must not become the escape hatch.
      {
        code: 'Log.debug(() => `patient ${id}`);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'Log.debug(() => { return buildMessage(patient); });',
        errors: [{ messageId: 'dynamic' }],
      },
      // Bypass fixtures — receiver obfuscation.
      {
        code: 'const L = Log; L.info(`patient ${id}`);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'const { info } = Log; info(`patient ${id}`);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'const { info: emit } = Log; emit(`patient ${id}`);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'const { info = noop } = Log; info(`patient ${id}`);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const s = Log.scoped('c'); s.warning(patientName);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const s = Log.scoped('c'); const c = s.scoped('d'); c.info(name);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "let s = Log.scoped('c'); s.info(patientName);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'Log.info.call(null, `patient ${id}`);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'Log.info.apply(null, [`patient ${id}`]);',
        errors: [{ messageId: 'unanalyzable' }],
      },
      { code: 'Log.info(...args);', errors: [{ messageId: 'unanalyzable' }] },
      {
        code: "Log['info'](`patient ${id}`);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: '(0, Log.info)(`patient ${id}`);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'Log?.info(`patient ${id}`);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "import { Log as AuditLog } from 'react-native-nitro-logger'; AuditLog.info(`p ${id}`);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'class A { m() { this.logger.info(`patient ${id}`); } }',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'const emit = Log.info; emit(`patient ${id}`);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'const f = Log.info.bind(Log); f(`patient ${id}`);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const f = Log.info.bind(Log, 'pre'); f('x');",
        errors: [{ messageId: 'unanalyzable' }],
      },
      // A `let` can be reassigned, so it is not an approved constant.
      {
        code: "let MSG = 'started'; Log.info(MSG);",
        errors: [{ messageId: 'dynamic' }],
      },
      // `const` protects the reference, not the object.
      {
        code: "const M = { up: 'safe' }; M.up = patientName; Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe' }; Object.assign(M, patient); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe' }; Reflect.set(M, 'up', patientName); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // A getter rewrites its own sibling the moment anything reads the
      // object — including the logger's own redaction pass, one line earlier.
      {
        code: `${IMPORT_LOG} const M = { up: 'safe', get trigger() { this.up = patientName; return 'x'; } }; Log.info('m', M); Log.info(M.up);`,
        errors: [{ messageId: 'dynamic' }],
      },
      // Operations that look like reads and are not: each one invokes
      // accessors, so each one can rewrite the table before it is read.
      {
        code: "const M = { up: 'safe', get x() { this.up = patientName; return 1; } }; Object.values(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe' }; Object.entries(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe' }; Reflect.get(M, 'x'); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // A shadowed namespace is caught by scope resolution; a namespace
      // tampered with through the global object, or one method deep, leaves
      // the binding looking pristine — so the file is scanned for all of it.
      {
        code: "globalThis.Object = { keys: (o) => { o.up = patientName; return []; } }; const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "Object.keys = (o) => { o.up = patientName; return []; }; const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "globalThis['Object'] = fake; const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // An unreadable key means any namespace could be the one replaced.
      {
        code: "globalThis[pick()] = fake; const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // Handing the namespace to a function is handing over the right to
      // rewrite it.
      {
        code: "Object.defineProperty(Object, 'keys', { value: (o) => { o.up = patientName; return []; } }); const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // `.call` runs the real method body against a receiver of the caller's
      // choosing, and the logger reaches its sinks through `this`.
      {
        code: `${IMPORT_LOG} const M = { up: 'safe' }; Log.info.call({ logMessage(_m, o) { o.up = patientName; } }, 'm', M); Log.info(M.up);`,
        errors: [{ messageId: 'dynamic' }],
      },
      // A literal is only a table of constants if nothing in it executes:
      // an inherited accessor or method reached through `__proto__`…
      {
        code: "const P = { get x() { this.up = patientName; return 1; } }; const M = { __proto__: P, up: 'safe' }; M.x; Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const P = { mutate() { this.up = patientName; } }; const M = { __proto__: P, up: 'safe' }; M.mutate(); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // …a function- or class-valued data property, which `property.method`
      // does not flag…
      {
        code: "const M = { up: 'safe', mutate: function () { this.up = patientName; } }; M.mutate(); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe', mutate: () => { M.up = patientName; } }; M.mutate(); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe', C: class { constructor() { M.up = patientName; } } }; new M.C(); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // …or a getter one level down, which still runs and still reaches the
      // outer object through a closure.
      {
        code: "const M = { up: 'safe', inner: { get t() { M.up = patientName; return 1; } } }; M.inner.t; Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // The same hazards behind a name, or inside an array, at any depth.
      // These use `this` rather than closing over M, because a closure over M
      // is itself a member write and would report for the wrong reason.
      {
        code: "const mutate = function () { this.up = patientName; }; const M = { up: 'safe', mutate }; M.mutate(); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe', h: [function () { this.up = patientName; }] }; M.h[0].call(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // `Object.prototype` hands every object a way to install an accessor,
      // and none of it reads as a write to the binding.
      {
        code: "const M = { up: 'safe' }; M.__defineGetter__('t', function () { this.up = patientName; }); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // Builtin tampering reached through a nested chain or an alias of
      // either the global object or the namespace itself.
      {
        code: "globalThis.Object.keys = (o) => { o.up = patientName; return []; }; const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const g = globalThis; g.Object = fake; const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const O = Object; O.keys = fake; const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // A destructuring or loop target replaces a builtin without any
      // assignment whose left side is a member expression.
      {
        code: "({ keys: Object.keys } = { keys: fake }); const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "for (Object.keys of [fake]) {} const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // A tagged template invokes the method with `this` bound just as a
      // call does.
      {
        code: "const M = { up: 'safe', mutate: buildMutator() }; M.mutate`x`; Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // An unrelated method next to the one being called says nothing about
      // it, and discarding the container over it would silence the call site.
      {
        code: 'const h = { helper() {}, emit: Log.info }; h.emit(patientName);',
        errors: [{ messageId: 'dynamic' }],
      },
      // Receiver resolution ignores mutation by design, so the property's
      // later value has to be considered too — otherwise the stale
      // initializer answers for a call that is a logger call by the time it
      // runs. Which one runs is unknowable, so it is reported.
      {
        code: 'const h = { emit: analytics.info }; h.emit = Log.info; h.emit(patientName);',
        errors: [{ messageId: 'unanalyzable' }],
      },
      {
        code: 'const h = { emit: analytics.info }; Object.assign(h, { emit: Log.info }); h.emit(patientName);',
        errors: [{ messageId: 'unanalyzable' }],
      },
      // Source order only settles reachability when both sides sit in
      // straight-line code. Here the write is later in the file and still
      // happens first, because the call is deferred.
      {
        code: 'const h = { emit: analytics.info }; function run() { h.emit(patientName); } h.emit = Log.info; run();',
        errors: [{ messageId: 'unanalyzable' }],
      },
      // The same installation, one refactor out, and through a helper.
      {
        code: 'const h = {}; const methods = { emit: Log.info }; Object.assign(h, methods); h.emit(patientName);',
        errors: [{ messageId: 'dynamic' }],
      },
      // A wrapper written into at depth, or through an alias.
      {
        code: "const bag = { inner: {} }; bag.inner.namespace = Object; tamper(bag); const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const bag = {}; const b = bag; b.namespace = Object; tamper(bag); const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // Deferred by a class field initializer rather than a function.
      {
        code: 'const h = { emit: analytics.info }; class C { leak = h.emit(patientName); } h.emit = Log.info; new C();',
        errors: [{ messageId: 'unanalyzable' }],
      },
      // A wrapper filled in after its declaration still carries the namespace.
      {
        code: "const bag = {}; bag.namespace = Object; tamper(bag); const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // A namespace can sit inside a named wrapper rather than an inline one.
      {
        code: "const namespaces = { object: Object }; tamper(namespaces); const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // A write anywhere along a member chain reaches the root binding.
      {
        code: "const M = { up: 'safe', a: { b: 'x' } }; M.a.b = patientName; Log.info(M.a.b);",
        errors: [{ messageId: 'dynamic' }],
      },
      // A namespace reference can be wrapped on its way into a call.
      {
        code: "tamper(...[Object]); const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "tamper({ ns: Object }); const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const O = globalThis.Object; O.keys = fake; const M = { up: 'safe' }; Object.keys(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // Awaiting a value calls its `then` with `this` bound to it.
      {
        code: "async function f() { const M = { up: 'safe', then: build() }; await M; Log.info(M.up); }",
        errors: [{ messageId: 'dynamic' }],
      },
      // A member expression can be a destructuring target or a loop binding,
      // not just the left side of a plain assignment.
      {
        code: "const M = { up: 'safe' }; ({ x: M.up } = patient); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe' }; [M.up] = [patientName]; Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe' }; ({ a: { b: M.up } = {} } = patient); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe' }; for (M.up of names) {} Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe' }; for (M.up in names) {} Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe' }; M.up += patientName; Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // A spread can override the key the lookup found.
      {
        code: "const M = Object.freeze({ up: 'safe', ...patient }); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // Duplicate keys resolve to the last, like JavaScript does.
      {
        code: "const M = { up: 'safe', up: dynamic }; Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // A getter is a function call, not a constant.
      {
        code: 'const M = { get up() { return patientName; } }; Log.info(M.up);',
        errors: [{ messageId: 'dynamic' }],
      },
      // A shadowed `Object` means `freeze` proves nothing.
      {
        code: 'const Object = { freeze: (x) => x }; const M = Object.freeze({ up: dyn }); Log.info(M.up);',
        errors: [{ messageId: 'dynamic' }],
      },
      // A computed key can shadow the literal one the lookup found.
      {
        code: "const M = Object.freeze({ up: 'safe', [k]: patientName }); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // Handing the table to code we cannot see is the same as mutating it.
      {
        code: "const M = { up: 'safe' }; mutate(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // The logger exemption checks that the call really is a logger call.
      // Sharing a method name is not enough, or any object with an `info`
      // method would hand the mutation hole straight back.
      {
        code: "const M = { up: 'safe' }; evil.info(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe' }; evil.scoped(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const M = { up: 'safe' }; const alias = [M]; Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // A method name held in a constant is still that method.
      {
        code: "const method = 'info'; Log[method](patientName);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "const NAMES = Object.freeze({ emit: 'warning' }); Log[NAMES.emit](patientName);",
        errors: [{ messageId: 'dynamic' }],
      },
      // A binding assigned after its declaration is still a logger.
      {
        code: 'let sink; sink = Log; sink.info(patientName);',
        errors: [{ messageId: 'dynamic' }],
      },
      // Mutually referential constants resolve to nothing — the point of
      // these is that the analysis terminates rather than chasing the cycle.
      {
        code: 'const a = b; const b = a; Log.info(a);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'const k1 = o[k2]; const k2 = o[k1]; Log.info(k1);',
        errors: [{ messageId: 'dynamic' }],
      },
      // A method held in a container is still that method.
      {
        code: 'const [emit] = [Log.info]; emit(patientName);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'const handlers = { emit: Log.info }; handlers.emit(patientName);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: '(Log.info.bind(Log))(patientName);',
        errors: [{ messageId: 'dynamic' }],
      },
      // A method name we cannot read means we cannot rule out a log call.
      {
        code: "Log['in' + 'fo'](patientName);",
        errors: [{ messageId: 'unanalyzable' }],
      },
      {
        code: 'Log[getMethod()](patientName);',
        errors: [{ messageId: 'unanalyzable' }],
      },
      // An alias points at the same object, so a write through it counts.
      {
        code: "const M = { up: 'safe' }; const A = M; A.up = patientName; Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      // The builtin allowlist requires the real builtin.
      {
        code: "const JSON = { stringify: (o) => { o.up = leak; return ''; } }; const M = { up: 'safe' }; JSON.stringify(M); Log.info(M.up);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "let s; s = Log.scoped('c'); s.info(patientName);",
        errors: [{ messageId: 'dynamic' }],
      },
    ],
  });

  tsRuleTester.run(
    'no-dynamic-message (typescript)',
    plugin.rules['no-dynamic-message'],
    {
      valid: [
        "const MSG = 'started' as const; Log.info(MSG);",
        "Log.info('started' satisfies string);",
        "const s = Log.scoped('c'); s.info('started');",
      ],
      invalid: [
        {
          code: '(Log as any).info(`patient ${id}`);',
          errors: [{ messageId: 'dynamic' }],
        },
        {
          code: 'Log!.info(`patient ${id}`);',
          errors: [{ messageId: 'dynamic' }],
        },
        {
          code: 'Log.info(patientName as string);',
          errors: [{ messageId: 'dynamic' }],
        },
        {
          code: 'Log.info(patientName satisfies string);',
          errors: [{ messageId: 'dynamic' }],
        },
        {
          code: 'Log.info(patient!.name);',
          errors: [{ messageId: 'dynamic' }],
        },
        {
          code: 'class A { private logger = Log; m() { this.logger.info(`p ${id}`); } }',
          errors: [{ messageId: 'dynamic' }],
        },
        {
          code: 'class A { #logger = Log; m() { this.#logger.info(`p ${id}`); } }',
          errors: [{ messageId: 'dynamic' }],
        },
        {
          code: 'Log.info(<any>patientName);',
          errors: [{ messageId: 'dynamic' }],
        },
        {
          code: 'Log.info!(patientName);',
          errors: [{ messageId: 'dynamic' }],
        },
        {
          code: 'Log.info(((patientName as any)! satisfies string));',
          errors: [{ messageId: 'dynamic' }],
        },
        {
          code: 'const f = Log.info<string>; f(patientName);',
          errors: [{ messageId: 'dynamic' }],
        },
        {
          code: "const method = 'info' as const; Log[method](patientName);",
          errors: [{ messageId: 'dynamic' }],
        },
      ],
    }
  );

  tsxRuleTester.run(
    'no-dynamic-message (tsx)',
    plugin.rules['no-dynamic-message'],
    {
      valid: [
        {
          code: "function C() { Log.info('rendered'); return <View a={patient.id} />; }",
          filename: 'Component.tsx',
        },
      ],
      invalid: [
        {
          code: 'function C() { Log.info(`patient ${id}`); return <View />; }',
          filename: 'Component.tsx',
          errors: [{ messageId: 'dynamic' }],
        },
      ],
    }
  );
});

describe('no-computed-metadata-key', () => {
  ruleTester.run(
    'no-computed-metadata-key',
    plugin.rules['no-computed-metadata-key'],
    {
      valid: [
        "Log.info('m', { state: 'running' });",
        "Log.info('m', { 'session.state': 'running' });",
        "const s = Log.scoped('c'); s.info('m', { state: 'x' });",
        "Log.scoped('c', 'sub', { user: 'u1' });",
        "Log.log('m', { metadata: { state: 'x' } });",
        "Log.info('m', undefined, 'network');",
        // A const object the rule can follow is as reviewable as an inline one.
        `${IMPORT_LOG} const md = { state: 'x' }; Log.info('m', md);`,
        // `Object.keys` reads keys, never values, so it cannot run a getter.
        `${IMPORT_LOG} const md = { state: 'x' }; for (const k of Object.keys(md)) {} Log.info('m', md);`,
        // A nested plain object holds no code, so it stays resolvable.
        `${IMPORT_LOG} const md = { state: 'x', inner: { k: 'v' } }; Log.info('m', md);`,
        `${IMPORT_LOG} const md = { state: 'x', tags: ['a', 'b'] }; Log.info('m', md);`,
        // A call VALUE is not a callback the reader can trigger: `pub()` runs
        // once while the literal is built. Rejecting it would reject the
        // documented way to write metadata.
        `${IMPORT_LOG} const md = { userId: pub(user), state: 'x' }; Log.info('m', md);`,
        // A destructured scalar is a copy, not an alias.
        `${IMPORT_LOG} const md = { userId: 'u' }; const { userId } = md; send(userId); Log.info('m', md);`,
        // Opaque metadata is a finding by default; the opt-out is explicit
        // and named for what it costs.
        {
          code: "Log.info('m', metadataBuiltElsewhere);",
          options: [{ allowOpaqueMetadata: true }],
        },
        {
          code: "Log.info('m', { state: 'running' });",
          options: [{ catalog: ['state'] }],
        },
      ],
      invalid: [
        {
          code: "Log.info('m', { [patientId]: 'x' });",
          errors: [{ messageId: 'computed' }],
        },
        {
          code: "Log.info('m', { ...record });",
          errors: [{ messageId: 'spread' }],
        },
        {
          code: "const s = Log.scoped('c'); s.info('m', { [k]: 'x' });",
          errors: [{ messageId: 'computed' }],
        },
        {
          code: "Log.scoped('c', 'sub', { ...patient });",
          errors: [{ messageId: 'spread' }],
        },
        {
          code: "Log['scoped']('c', 'sub', { ...patient });",
          errors: [{ messageId: 'spread' }],
        },
        {
          code: "Log.log('m', { metadata: { [k]: 'x' } });",
          errors: [{ messageId: 'computed' }],
        },
        {
          code: "const { info } = Log; info('m', { ...record });",
          errors: [{ messageId: 'spread' }],
        },
        // The alias bypass: identical leak, one indirection away.
        {
          code: `${IMPORT_LOG} const md = { [patientId]: 'x' }; Log.info('m', md);`,
          errors: [{ messageId: 'computed' }],
        },
        {
          code: `${IMPORT_LOG} const md = { ...patient }; Log.info('m', md);`,
          errors: [{ messageId: 'spread' }],
        },
        // A getter is a callback the redaction pass invokes, and it can
        // rewrite its own siblings on the way past. No property of such an
        // object is a constant, so the object cannot be resolved at all.
        {
          code: `${IMPORT_LOG} const md = { state: 'x', get trigger() { return patientName; } }; Log.info('m', md);`,
          errors: [{ messageId: 'unanalyzable' }],
        },
        {
          code: `${IMPORT_LOG} const md = { state: 'x', toJSON() { return patient; } }; Log.info('m', md);`,
          errors: [{ messageId: 'unanalyzable' }],
        },
        // `property.method` is false here, but `md.mutate()` rewrites the
        // object just the same.
        {
          code: `${IMPORT_LOG} const md = { state: 'x', mutate: function () { this.state = patientName; } }; Log.info('m', md);`,
          errors: [{ messageId: 'unanalyzable' }],
        },
        {
          code: `${IMPORT_LOG} const md = { __proto__: base, state: 'x' }; Log.info('m', md);`,
          errors: [{ messageId: 'unanalyzable' }],
        },
        // Behind a name, and one level down, are the same hazard.
        {
          code: `${IMPORT_LOG} const inner = { get t() { return patientName; } }; const md = { state: 'x', inner }; Log.info('m', md);`,
          errors: [{ messageId: 'unanalyzable' }],
        },
        {
          code: `${IMPORT_LOG} const md = { state: 'x' }; md.__defineGetter__('t', function () { return patientName; }); Log.info('m', md);`,
          errors: [{ messageId: 'unanalyzable' }],
        },
        // `JSON.stringify` runs `toJSON` and every getter, so it is a call
        // that can rewrite what it was handed — not a read.
        {
          code: `${IMPORT_LOG} const md = { state: 'x' }; JSON.stringify(md); Log.info('m', md);`,
          errors: [{ messageId: 'unanalyzable' }],
        },
        // Only a PROVEN logger call is exempt from mutation analysis. An
        // unresolved receiver is free to rewrite the object it is handed.
        {
          code: `${IMPORT_LOG} function f(logger) { const md = { state: 'x' }; logger.info('m', md); Log.info('m', md); }`,
          // Both sites report: once `md` can be rewritten by the unproven
          // receiver, neither call can be shown to log the keys written here.
          errors: [
            { messageId: 'unanalyzable' },
            { messageId: 'unanalyzable' },
          ],
        },
        {
          code: "class A { m() { this.logger.info('m', { [k]: 1 }); } }",
          errors: [{ messageId: 'computed' }],
        },
        // A ScopedLogger named `logger` must not be read as the Logger, or
        // its third argument goes unexamined.
        {
          code: "const logger = Log.scoped('c'); logger.log('m', 'info', { [patientId]: 'x' });",
          errors: [{ messageId: 'computed' }],
        },
        // An unresolved receiver could be either shape, so both are checked.
        {
          code: "logger.log('m', 'info', { [patientId]: 'x' });",
          errors: [{ messageId: 'computed' }],
        },
        // Catalog enforcement mirrors the runtime's approved-key list.
        {
          code: "Log.info('m', { patient123: 'x' });",
          options: [{ catalog: ['state'] }],
          errors: [{ messageId: 'unapproved', data: { key: 'patient123' } }],
        },
        {
          code: "Log.info('m', { 'patient.name': 'x' });",
          options: [{ catalog: ['state'] }],
          errors: [{ messageId: 'unapproved' }],
        },
        {
          code: "Log.info('m', { 42: 'x' });",
          options: [{ catalog: ['state'] }],
          errors: [{ messageId: 'unapproved', data: { key: '42' } }],
        },
        {
          code: "Log.info('m', { patient });",
          options: [{ catalog: ['state'] }],
          errors: [{ messageId: 'unapproved', data: { key: 'patient' } }],
        },
        // Opaque metadata fails closed by default — this is the case the rule
        // cannot see through, so exempting it would leave only the mistakes
        // nobody makes.
        {
          code: "Log.info('m', metadataBuiltElsewhere);",
          errors: [{ messageId: 'unanalyzable' }],
        },
        {
          code: "Log.info('m', buildMetadata(patient));",
          errors: [{ messageId: 'unanalyzable' }],
        },
        // A catalog is a promise every key was reviewed, so it overrides an
        // explicit opt-out rather than coexisting with it.
        {
          code: "Log.info('m', metadataBuiltElsewhere);",
          options: [{ catalog: ['state'], allowOpaqueMetadata: true }],
          errors: [{ messageId: 'unanalyzable' }],
        },
        {
          code: "let md = { state: 'x' }; Log.info('m', md);",
          errors: [{ messageId: 'unanalyzable' }],
        },
        {
          code: "const md = { state: 'x' }; md[patientId] = 'x'; Log.info('m', md);",
          errors: [{ messageId: 'unanalyzable' }],
        },
        // The object escapes to code that could add a key before it is logged.
        {
          code: "const md = { state: 'x' }; mutate(md); Log.info('m', md);",
          errors: [{ messageId: 'unanalyzable' }],
        },
        // Spread hides which position metadata even landed in.
        {
          code: 'Log.info(...args);',
          errors: [{ messageId: 'unanalyzable' }],
        },
        {
          code: "Log.scoped(...[patientId, 'sub', { [patientId]: v }]);",
          errors: [{ messageId: 'unanalyzable' }],
        },
        // `logMessage` is what `log` delegates to, and equally public. It was
        // absent from the rule's method set, so this exact call — identical to
        // a `Log.log` the rule does catch — went unexamined.
        {
          code: "Log.logMessage('m', { metadata: { [patientId]: 'x' } });",
          errors: [{ messageId: 'computed' }],
        },
        {
          code: "Log.logMessage('m', { metadata: metadataBuiltElsewhere });",
          errors: [{ messageId: 'unanalyzable' }],
        },
        // `scopeMetadata` reaches the same redaction path as `metadata` and is
        // just as reachable from application code; reading only one of the two
        // left half the pipeline unchecked.
        {
          code: "Log.log('m', { scopeMetadata: { [patientId]: 'x' } });",
          errors: [{ messageId: 'computed' }],
        },
        {
          code: "Log.logMessage('m', { scopeMetadata: { [patientId]: 'x' } });",
          errors: [{ messageId: 'computed' }],
        },
        {
          code: "Log.log('m', { scopeMetadata: { patient } });",
          options: [{ catalog: ['state'] }],
          errors: [{ messageId: 'unapproved', data: { key: 'patient' } }],
        },
        // Both fields on one call are two findings, not one.
        {
          code: "Log.log('m', { metadata: { [a]: 1 }, scopeMetadata: { [b]: 2 } });",
          errors: [{ messageId: 'computed' }, { messageId: 'computed' }],
        },
      ],
    }
  );

  tsRuleTester.run(
    'no-computed-metadata-key (typescript)',
    plugin.rules['no-computed-metadata-key'],
    {
      valid: ["Log.info('m', { state: 'running' } as const);"],
      invalid: [
        {
          code: "Log.info('m', { [patientId]: 'x' } as Record<string, string>);",
          errors: [{ messageId: 'computed' }],
        },
        {
          code: "(Log as any).info('m', { ...patient });",
          errors: [{ messageId: 'spread' }],
        },
      ],
    }
  );
});

describe('no-derived-correlation', () => {
  ruleTester.run(
    'no-derived-correlation',
    plugin.rules['no-derived-correlation'],
    {
      // Minting an approved correlation ID requires a Logger traceable to an
      // import of the real package. A bare global named `Log` is a fine hint
      // for deciding what to CHECK, but it is not provenance: nothing stops
      // `globalThis.Log = fakeLogger`, and this is the one place the plugin
      // TRUSTS a value rather than inspecting it.
      valid: [
        `${IMPORT_LOG} Log.scoped();`,
        `${IMPORT_LOG} Log.scoped(Log.newCorrelationId());`,
        `${IMPORT_LOG} const id = Log.newCorrelationId(); Log.scoped(id);`,
        `${IMPORT_LOG} Log.scoped(Log.newCorrelationId(), 'sync');`,
        `${IMPORT_LOG} Log.log('m', { correlation: Log.newCorrelationId() });`,
        `${IMPORT_LOG} const { newCorrelationId } = Log; Log.scoped(newCorrelationId());`,
        // An alias of a verified import carries its provenance.
        `${IMPORT_LOG} const L = Log; L.scoped(L.newCorrelationId());`,
        // Omitted means auto-generate, exactly like passing nothing.
        `${IMPORT_LOG} Log.scoped(undefined);`,
        `${IMPORT_LOG} Log.log('m', { correlation: undefined });`,
        'unrelated.scoped(patientId);',
      ],
      invalid: [
        { code: 'Log.scoped(patientId);', errors: [{ messageId: 'derived' }] },
        {
          code: "Log.scoped('patient-42');",
          errors: [{ messageId: 'derived' }],
        },
        {
          code: 'Log.scoped(hash(patient.mrn));',
          errors: [{ messageId: 'derived' }],
        },
        {
          code: 'Log.scoped(`visit-${visitId}`);',
          errors: [{ messageId: 'derived' }],
        },
        {
          code: 'let id = patientId; Log.scoped(id);',
          errors: [{ messageId: 'derived' }],
        },
        {
          code: "Log.log('m', { correlation: patientId });",
          errors: [{ messageId: 'derived' }],
        },
        {
          code: "Log.logMessage('m', { correlation: patientId });",
          errors: [{ messageId: 'derived' }],
        },
        {
          code: `${IMPORT_LOG} const s = Log.scoped(Log.newCorrelationId()); s.scoped(patientId);`,
          errors: [{ messageId: 'derived' }],
        },
        {
          code: "Log['scoped'](patientId);",
          errors: [{ messageId: 'derived' }],
        },
        // Provenance, not spelling: a same-named local function is the leak.
        {
          code: 'function newCorrelationId() { return patient.mrn; } Log.scoped(newCorrelationId());',
          errors: [{ messageId: 'derived' }],
        },
        // A Logger imported from somewhere else is not the Logger. This is
        // also what an app that re-exports the logger from its own module
        // hits, which is why `loggerModules` exists and is documented as the
        // first thing to configure — the valid list has the fixed form.
        {
          code: "import { Log } from './phi-helpers'; Log.scoped(Log.newCorrelationId());",
          errors: [{ messageId: 'derived' }],
        },
        // An unresolved global is a hint, not provenance.
        {
          code: 'Log.scoped(Log.newCorrelationId());',
          errors: [{ messageId: 'derived' }],
        },
        // Which property was destructured is the whole point.
        {
          code: `${IMPORT_LOG} const { patientId: newCorrelationId } = Log; Log.scoped(newCorrelationId());`,
          errors: [{ messageId: 'derived' }],
        },
        // `__defineGetter__` replaces the generator through a method the
        // package never wrote, so the exemption for calls through a trusted
        // logger has to be a closed list of its own methods.
        {
          code: `${IMPORT_LOG} Log.__defineGetter__('newCorrelationId', function () { return () => patient.mrn; }); Log.scoped(Log.newCorrelationId());`,
          errors: [{ messageId: 'derived' }],
        },
        // Trust has to survive the rest of the file. A binding that is
        // rebound, or a singleton whose method is replaced, is no longer the
        // generator the package shipped — even though the spelling is.
        {
          code: `${IMPORT_LOG} let L = Log; L = fakeLogger; Log.scoped(L.newCorrelationId());`,
          errors: [{ messageId: 'derived' }],
        },
        {
          code: `${IMPORT_LOG} Log.newCorrelationId = () => patient.mrn; Log.scoped(Log.newCorrelationId());`,
          errors: [{ messageId: 'derived' }],
        },
        // Spread hides the options object and the correlation inside it.
        {
          code: `${IMPORT_LOG} Log.log(...['m', { correlation: patientId }]);`,
          errors: [{ messageId: 'unanalyzable' }],
        },
        {
          code: `${IMPORT_LOG} Log.log.apply(Log, ['m', { correlation: patientId }]);`,
          errors: [{ messageId: 'unanalyzable' }],
        },
        {
          code: 'Log.scoped(patient.newCorrelationId());',
          errors: [{ messageId: 'derived' }],
        },
        {
          code: 'const id = patient.newCorrelationId(); Log.scoped(id);',
          errors: [{ messageId: 'derived' }],
        },
        // Last duplicate wins, exactly as it does at runtime.
        {
          code: "import { Log } from 'react-native-nitro-logger'; Log.log('m', { correlation: Log.newCorrelationId(), correlation: patientId });",
          errors: [{ messageId: 'derived' }],
        },
        // An aliased options object is opened, not waved through.
        {
          code: "import { Log } from 'react-native-nitro-logger'; const opts = { correlation: patientId }; Log.log('m', opts);",
          errors: [{ messageId: 'derived' }],
        },
        // One that genuinely cannot be opened is reported as such, rather
        // than treated as an absent correlation.
        {
          code: "import { Log } from 'react-native-nitro-logger'; Log.log('m', buildOptions());",
          errors: [{ messageId: 'unanalyzable' }],
        },
        {
          code: "import { Log } from 'react-native-nitro-logger'; Log.log('m', { ...defaults, level: 'info' });",
          errors: [{ messageId: 'unanalyzable' }],
        },
        // A computed key could be `correlation` under another spelling, so
        // finding a safe literal one first proves nothing.
        {
          code: "Log.log('m', { correlation: Log.newCorrelationId(), [key]: patientId });",
          errors: [{ messageId: 'unanalyzable' }],
        },
        // Provenance is exact: an ambiguous receiver cannot mint an approved
        // ID, or any object's method would launder into one.
        {
          code: 'function f(logger) { Log.scoped(logger.newCorrelationId()); }',
          errors: [{ messageId: 'derived' }],
        },
        {
          code: "import { newCorrelationId } from './phi-helpers'; Log.scoped(newCorrelationId());",
          errors: [{ messageId: 'derived' }],
        },
        {
          code: "import { newCorrelationId } from 'react-native-nitro-logger'; Log.scoped(newCorrelationId());",
          errors: [{ messageId: 'derived' }],
        },
        // Spread hides the correlation position entirely.
        {
          code: 'Log.scoped(...[patientId]);',
          errors: [{ messageId: 'unanalyzable' }],
        },
        // An ambiguous `.log` with an opaque second argument could be either
        // shape, so the Logger interpretation cannot be dismissed.
        {
          code: "function emit(logger, opts) { logger.log('m', opts); }",
          errors: [{ messageId: 'unanalyzable' }],
        },
      ],
    }
  );
});

describe('literal-subsystem', () => {
  ruleTester.run('literal-subsystem', plugin.rules['literal-subsystem'], {
    valid: [
      "Log.subsystem('network', 'debug');",
      "Log.resetSubsystem('network');",
      "const S = 'network'; Log.subsystem(S, 'debug');",
      "Log.info('m', undefined, 'network');",
      "Log.scoped(Log.newCorrelationId(), 'network');",
      "Log.log('m', { subsystem: 'network' });",
      // ScopedLogger has no subsystem argument; the second argument is
      // metadata and must not be flagged.
      "const s = Log.scoped('c'); s.info('m', { state: 'x' });",
      "const s = Log.scoped('c'); s.log('m', 'info', { state: 'x' });",
    ],
    invalid: [
      {
        code: 'Log.subsystem(name, "debug");',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "Log.info('m', undefined, `net.${region}`);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'Log.scoped(Log.newCorrelationId(), computedSubsystem);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "Log.log('m', { subsystem: dynamicName });",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "Log.logMessage('m', { subsystem: dynamicName });",
        errors: [{ messageId: 'dynamic' }],
      },
      { code: 'Log.resetSubsystem(name);', errors: [{ messageId: 'dynamic' }] },
      // Computed method access must read as dot access.
      {
        code: "Log['subsystem'](patientName, 'debug');",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "Log['resetSubsystem'](patientName);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: "Log['scoped'](Log.newCorrelationId(), patientName);",
        errors: [{ messageId: 'dynamic' }],
      },
      {
        code: 'class A { m() { this.logger.subsystem(name, "debug"); } }',
        errors: [{ messageId: 'dynamic' }],
      },
    ],
  });
});

describe('plugin configs', () => {
  test('recommended enables the always-a-mistake rules', () => {
    expect(Object.keys(plugin.configs.recommended.rules)).toEqual([
      'nitro-logger/no-dynamic-message',
      'nitro-logger/no-computed-metadata-key',
    ]);
  });

  test('strict adds correlation and subsystem enforcement', () => {
    expect(Object.keys(plugin.configs.strict.rules)).toEqual([
      'nitro-logger/no-dynamic-message',
      'nitro-logger/no-computed-metadata-key',
      'nitro-logger/no-derived-correlation',
      'nitro-logger/literal-subsystem',
    ]);
  });

  test('the TypeScript variants carry the same rules as their siblings', () => {
    // Whole objects, not key lists: the docs say the variants are "the same
    // as `strict`, in a TypeScript app", and a downgraded severity or a
    // changed options object would break that promise while the names still
    // matched.
    expect(plugin.configs.recommendedTypeScript.rules).toEqual(
      plugin.configs.recommended.rules
    );
    expect(plugin.configs.strictTypeScript.rules).toEqual(
      plugin.configs.strict.rules
    );
  });

  test('the TypeScript variants match TypeScript, and the plain ones do not', () => {
    // The whole of C1. A flat config with no `files` applies only to ESLint's
    // default set, so `strict` in a TypeScript app inspects nothing and exits
    // 0 — silence that reads exactly like compliance. `scripts/check-eslint-
    // consumer.sh` proves the end-to-end behaviour from a packed tarball;
    // this pins the shape so the regression is visible here too.
    for (const name of ['recommended', 'strict']) {
      expect(plugin.configs[name].files).toBeUndefined();
    }
    for (const name of ['recommendedTypeScript', 'strictTypeScript']) {
      const [pattern] = plugin.configs[name].files;
      expect(pattern).toContain('ts');
      expect(pattern).toContain('tsx');
      // Covers JavaScript too, so a consumer needs one entry rather than two.
      expect(pattern).toContain('js');
    }
  });

  test('the parser is resolved lazily, not at import', () => {
    // A JavaScript-only consumer never installs the optional peer. Resolving
    // it eagerly would make importing the plugin throw for them, turning an
    // optional peer into a hard dependency — and spreading `languageOptions`
    // anywhere would do the same by evaluating the getter.
    for (const name of ['recommendedTypeScript', 'strictTypeScript']) {
      const descriptor = Object.getOwnPropertyDescriptor(
        plugin.configs[name].languageOptions,
        'parser'
      );
      expect(typeof descriptor.get).toBe('function');
      expect('value' in descriptor).toBe(false);
    }
  });

  test('the parser peer constrains no version and may be absent', () => {
    // `optional` means the package may be ABSENT; it does not stop npm
    // checking the RANGE when it is present. These configs hand the parser
    // straight to ESLint and never introspect it, so any floor would be an
    // ERESOLVE waiting to happen for a consumer whose setup already works —
    // and @react-native/eslint-config@0.78 pins parser ^7.1.1, so even a
    // `>=8` floor would break the toolchain this package targets.
    const pkg = require('../package.json');
    expect(pkg.peerDependencies['@typescript-eslint/parser']).toBe('*');
    expect(pkg.peerDependenciesMeta['@typescript-eslint/parser'].optional).toBe(
      true
    );
  });

  test('the missing-parser error is actionable and promises no version', () => {
    // It must name the package and an install command, and must NOT print a
    // range — the manifest does not enforce one, and telling someone to
    // install a specific range would contradict what the package accepts.
    const message = (() => {
      try {
        plugin.configs.strictTypeScript.languageOptions.parser;
        return null;
      } catch (error) {
        return error.message;
      }
    })();

    // The parser IS installed in this repo, so the getter resolves and there
    // is no error to inspect. Assert the resolution instead, and leave the
    // error text to the consumer fixture, which is the only place the parser
    // is genuinely absent.
    if (message === null) {
      expect(
        plugin.configs.strictTypeScript.languageOptions.parser
      ).toBeTruthy();
      return;
    }
    expect(message).toContain('@typescript-eslint/parser');
    expect(message).toContain('npm install');
    expect(message).not.toMatch(/[><]=?\s*\d+\.\d+\.\d+/);
  });

  test('both configs fail closed on metadata by default', () => {
    for (const name of ['recommended', 'strict']) {
      // No options object at all: opaque metadata is an error unless the
      // consumer explicitly opts out, rather than unless they opt in.
      expect(
        plugin.configs[name].rules['nitro-logger/no-computed-metadata-key']
      ).toBe('error');
    }
  });

  test('every rule is reachable from a config', () => {
    const configured = new Set(
      Object.values(plugin.configs).flatMap((c) => Object.keys(c.rules))
    );
    for (const name of Object.keys(plugin.rules)) {
      expect(configured.has(`nitro-logger/${name}`)).toBe(true);
    }
  });

  test('the plugin ships and resolves as its own entry point', () => {
    const pkg = require('../package.json');
    // Consumers write `require('react-native-nitro-logger/eslint-plugin')`
    // from an eslint.config file, which never goes through the RN bundler.
    expect(pkg.exports['./eslint-plugin']).toBe('./eslint-plugin/index.js');
    expect(pkg.files).toContain('eslint-plugin');
    // The subpath is CommonJS, so the package must not be marked ESM.
    expect(pkg.type).toBeUndefined();
    // ESLint is only needed by consumers who opt into the plugin.
    expect(pkg.peerDependencies.eslint).toBeDefined();
    expect(pkg.peerDependenciesMeta.eslint.optional).toBe(true);
  });

  /**
   * RuleTester hands a rule straight to the linter, so it never exercises
   * config resolution: the `nitro-logger/` namespacing, the options the
   * `strict` config passes down, or whether the rules survive a real parser
   * on a real `.tsx` file. This runs the whole thing the way a consumer's
   * eslint.config.mjs would.
   */
  test('the strict config works end to end on a TSX source file', async () => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          ...plugin.configs.strict,
          files: ['**/*.tsx'],
          languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: 'module',
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
        },
      ],
    });

    const source = [
      "import { Log } from 'react-native-nitro-logger';",
      "const MESSAGES = Object.freeze({ started: 'visit started' });",
      'export function Good() {',
      '  const id = Log.newCorrelationId();',
      "  const scope = Log.scoped(id, 'visit', { state: 'active' });",
      '  scope.info(MESSAGES.started);',
      "  Log.info('sync complete', { state: 'done' }, 'network');",
      '  return <View />;',
      '}',
      'export function Bad(patient) {',
      '  Log.info(`patient ${patient.id} admitted`);', // dynamic
      "  Log.scoped(patient.mrn, 'visit');", // derived
      "  Log.info('note', { [patient.id]: 'x' });", // computed
      "  Log.info('note', buildMetadata());", // unanalyzable
      '  (Log as any).info(patient.mrn);', // dynamic, through `as`
      "  Log['subsystem'](patient.mrn, 'debug');", // dynamic subsystem
      '}',
    ].join('\n');

    const [result] = await eslint.lintText(source, { filePath: 'app.tsx' });
    const byRule = result.messages.map((m) => m.ruleId);

    expect(result.messages.every((m) => !m.fatal)).toBe(true);
    expect(byRule).toEqual([
      'nitro-logger/no-dynamic-message',
      'nitro-logger/no-derived-correlation',
      'nitro-logger/no-computed-metadata-key',
      'nitro-logger/no-computed-metadata-key',
      'nitro-logger/no-dynamic-message',
      'nitro-logger/literal-subsystem',
    ]);
    // Every report lands in Bad(), never in Good().
    expect(Math.min(...result.messages.map((m) => m.line))).toBeGreaterThan(9);
  });

  /**
   * The plugin is CommonJS and cannot import the TypeScript runtime, so its
   * catalog schema restates the runtime's key contract by hand. This is the
   * test that keeps the two from drifting: a catalog lint approves but the
   * runtime rejects is worse than no catalog, because it green-lights at
   * build time what is silently dropped in production.
   */
  test('the catalog schema mirrors the runtime key contract', () => {
    const runtime = require('../src/privacy');
    const schema =
      plugin.rules['no-computed-metadata-key'].meta.schema[0].properties
        .catalog;

    expect(schema.items.pattern).toBe(runtime.METADATA_KEY_PATTERN_SOURCE);
    expect(schema.maxItems).toBe(runtime.MAX_CATALOG_SIZE);
    expect(schema.items.not.const).toBe(runtime.DROPPED_COUNT_KEY);
    expect(schema.uniqueItems).toBe(true);

    // And the contract itself still holds at runtime: a key the schema
    // accepts survives buildCatalog, one it rejects does not.
    expect(runtime.buildCatalog(['session.state']).has('session.state')).toBe(
      true
    );
    expect(runtime.buildCatalog(['bad key!']).size).toBe(0);
  });

  /**
   * The mutation analysis exempts a call through a proven Logger only when the
   * method is one the package itself defines — otherwise
   * `Log.__defineGetter__('newCorrelationId', …)` replaces the generator
   * through a method inherited from `Object.prototype` and the singleton stays
   * trusted. That makes the list a standing obligation against the source, so
   * this test is what keeps it honest in both directions.
   */
  test('the trusted-method list matches the Logger it is protecting', () => {
    const { LOGGER_OWN_METHODS } = require('../eslint-plugin/shared');
    const { Logger } = require('../src/Logger');
    const { ScopedLogger } = require('../src/ScopedLogger');

    const defined = new Set();
    for (const klass of [Logger, ScopedLogger]) {
      for (const name of Object.getOwnPropertyNames(klass.prototype)) {
        if (name === 'constructor' || name.startsWith('#')) continue;
        if (typeof klass.prototype[name] !== 'function') continue;
        defined.add(name);
      }
    }

    // Missing a real method fails CLOSED: the singleton would look tampered
    // with and every rule that depends on trusting it would misfire.
    const missing = [...defined].filter((n) => !LOGGER_OWN_METHODS.has(n));
    expect(missing).toEqual([]);

    // Listing one the package does not define fails OPEN: it would exempt a
    // call the package never makes, which is the `__defineGetter__` hole.
    const extra = [...LOGGER_OWN_METHODS].filter((n) => !defined.has(n));
    expect(extra).toEqual([]);
  });

  /**
   * The companion to the test above, and the one that would have caught
   * `logMessage`.
   *
   * `LOGGER_OWN_METHODS` is about *trust* — is this method one the package
   * wrote. `LOG_METHODS` is about *coverage* — does calling it put a
   * public-by-contract field on the wire. `logMessage` was in the first set and
   * missing from the second, so the plugin knew the method existed and checked
   * nothing about its arguments. `Log.logMessage(`MRN ${x}`)` linted clean.
   *
   * Every emitting method must therefore be classified deliberately. Adding one
   * to the Logger without deciding which side it falls on fails here.
   */
  test('every emitting method is covered by a rule, or listed as not emitting', () => {
    const { LOG_METHODS } = require('../eslint-plugin/shared');
    const { Logger } = require('../src/Logger');
    const { ScopedLogger } = require('../src/ScopedLogger');

    // Methods that exist on the loggers but do not put caller-supplied text
    // into an entry. Each is here because of what it does, not because adding
    // it made the test pass.
    const NOT_EMITTING = new Set([
      'addDestination', // takes a destination, no message
      'consoleLogging', // boolean toggle
      'flush', // deadline only
      'metadataKeyCatalog', // key names, checked at runtime instead
      'minimumLevel', // level only
      'newCorrelationId', // generates, never accepts
      'privacyDefault', // mode only
      'redactAllMetadata', // no arguments
      'removeDestination', // label only
      'resetSubsystem', // covered by CONFIG_METHODS
      'scoped', // covered by API_METHODS; creates, does not emit
      'subsystem', // covered by CONFIG_METHODS
      'noteFailure', // internal, takes no caller text
      'privacySettings', // internal accessor
    ]);

    const unclassified = [];
    for (const klass of [Logger, ScopedLogger]) {
      for (const name of Object.getOwnPropertyNames(klass.prototype)) {
        if (name === 'constructor' || name.startsWith('#')) continue;
        if (typeof klass.prototype[name] !== 'function') continue;
        if (LOG_METHODS.has(name) || NOT_EMITTING.has(name)) continue;
        unclassified.push(name);
      }
    }

    expect(unclassified).toEqual([]);

    // And the exemption list may not drift into naming methods that no longer
    // exist — a stale entry there would silently re-open the same hole.
    const defined = new Set();
    for (const klass of [Logger, ScopedLogger]) {
      for (const name of Object.getOwnPropertyNames(klass.prototype)) {
        defined.add(name);
      }
    }
    expect([...NOT_EMITTING].filter((n) => !defined.has(n))).toEqual([]);
  });

  test('every rule declares the options it reads', () => {
    const { RECEIVER_OPTION_PROPERTIES } = require('../eslint-plugin/shared');

    for (const [name, rule] of Object.entries(plugin.rules)) {
      const schema = rule.meta.schema[0];
      expect(schema.additionalProperties).toBe(false);

      // Every rule resolves receivers, so every rule must accept every
      // receiver option. `additionalProperties: false` turns a rule that
      // missed one into a hard config error for anyone who sets it — the
      // rules would disagree about what a valid config is. These were
      // hand-copied into four files before, which is exactly how that drifts.
      for (const option of Object.keys(RECEIVER_OPTION_PROPERTIES)) {
        expect(Object.keys(schema.properties)).toContain(option);
      }

      expect(rule.meta.type).toBe('problem');
      expect(Object.keys(rule.meta.messages).length).toBeGreaterThan(0);
      expect(typeof rule.meta.docs.description).toBe('string');
      expect(name).toMatch(/^[a-z-]+$/);
    }
  });
});

/* -------------------------------------------------------------------------
 * Constructing a logger
 * ---------------------------------------------------------------------- */

/**
 * `Log.scoped()` is the documented way to get a ScopedLogger, so the rules
 * only ever learned that one. But `ScopedLogger` is a root export whose
 * constructor takes correlation and subsystem — the two channels the runtime
 * cannot redact — as plain arguments, and `new ScopedLogger(Log, patient.id,
 * `tenant-${patient.id}`)` reported NOTHING while the `.scoped()` spelling of
 * the same thing reported three errors.
 *
 * These assert EXACT classifications rather than "not null". `'ambiguous'` is
 * not null, so a truthiness check passes with the constructor unrecognized —
 * the same shape of vacuous test the marker guard in `apiReference.test.js`
 * had to be rewritten to avoid.
 */
const { Linter } = require('eslint');
const shared = require('../eslint-plugin/shared');

/** What `classifyConstruction` returns for each `new` in `code`. */
function classificationsOf(code, options = {}) {
  const seen = [];
  const probe = {
    meta: {
      schema: [
        {
          type: 'object',
          properties: shared.RECEIVER_OPTION_PROPERTIES,
          additionalProperties: false,
        },
      ],
    },
    create(context) {
      return {
        NewExpression(node) {
          seen.push(shared.classifyConstruction(context, node));
        },
      };
    },
  };

  // Through the real Linter, so scope resolution and import bindings are the
  // ones ESLint actually builds rather than a hand-made stand-in.
  const messages = new Linter().verify(code, {
    plugins: { probe: { rules: { probe } } },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: { 'probe/probe': ['error', options] },
  });
  const fatal = messages.filter((m) => m.fatal);
  if (fatal.length)
    throw new Error(`fixture did not parse: ${fatal[0].message}`);

  return seen;
}

describe('constructing a logger', () => {
  const FROM_PACKAGE = "from 'react-native-nitro-logger';";

  test('an imported ScopedLogger constructs a scoped logger', () => {
    expect(
      classificationsOf(
        `import { ScopedLogger } ${FROM_PACKAGE}\nnew ScopedLogger(l, 'c');`
      )
    ).toEqual(['scoped']);
  });

  test('an imported Logger constructs a logger', () => {
    expect(
      classificationsOf(`import { Logger } ${FROM_PACKAGE}\nnew Logger();`)
    ).toEqual(['logger']);
  });

  test('an alias resolves to the class it aliases, not its local name', () => {
    // Provenance is the exported symbol. Keying off the local binding would
    // make `import { ScopedLogger as S }` invisible.
    expect(
      classificationsOf(
        `import { ScopedLogger as S } ${FROM_PACKAGE}\nnew S(l, 'c');`
      )
    ).toEqual(['scoped']);
    expect(
      classificationsOf(`import { Logger as L } ${FROM_PACKAGE}\nnew L();`)
    ).toEqual(['logger']);
  });

  test('the same name from another module is checked but never trusted', () => {
    // A name is not provenance: `./phi-helpers` could export anything.
    expect(
      classificationsOf(
        "import { ScopedLogger } from './phi-helpers';\nnew ScopedLogger(l, 'c');"
      )
    ).toEqual(['ambiguous']);
  });

  test('a local class of the same name is checked but never trusted', () => {
    expect(
      classificationsOf("class ScopedLogger {}\nnew ScopedLogger(l, 'c');")
    ).toEqual(['ambiguous']);
  });

  test('a shadowing binding is never the import it shadows', () => {
    // Provenance is resolved through the scope active at the `new`, not by
    // spelling. If it were by spelling, any of these would inherit the
    // outer import's trust and silence the correlation and subsystem checks
    // on a value the resolver knows nothing about.
    const shadows = [
      // A parameter.
      `import { ScopedLogger } ${FROM_PACKAGE}\nfunction f(ScopedLogger) { new ScopedLogger(l, 'c'); }`,
      // A block-local class.
      `import { ScopedLogger } ${FROM_PACKAGE}\n{ class ScopedLogger {} new ScopedLogger(l, 'c'); }`,
      // A catch binding.
      `import { ScopedLogger } ${FROM_PACKAGE}\ntry { g(); } catch (ScopedLogger) { new ScopedLogger(l, 'c'); }`,
      // A local `const` in an inner scope.
      `import { ScopedLogger } ${FROM_PACKAGE}\nfunction f() { const ScopedLogger = Other; new ScopedLogger(l, 'c'); }`,
    ];
    for (const code of shadows) {
      expect(classificationsOf(code)).toEqual(['ambiguous']);
    }
  });

  test('a default import is not the export that shares its name', () => {
    // Only a named import carries an exported symbol. A default import binds
    // whatever the module put there, so verifying it against `loggerModules`
    // would grant trusted-constructor status on the strength of the local
    // name alone — the exact thing the specifier check exists to prevent.
    expect(
      classificationsOf(
        "import AppScope from './logging';\nnew AppScope(l, 'c');",
        {
          scopedClassNames: ['AppScope'],
          loggerModules: ['./logging'],
        }
      )
    ).toEqual(['ambiguous']);
    // The named import from the identical module IS verified, so the
    // distinction above is about the import form and nothing else.
    expect(
      classificationsOf(
        "import { AppScope } from './logging';\nnew AppScope(l, 'c');",
        { scopedClassNames: ['AppScope'], loggerModules: ['./logging'] }
      )
    ).toEqual(['scoped']);
  });

  test('the namespace form is explicitly unsupported, not silently trusted', () => {
    // The specifier check cannot see through a namespace object to learn
    // which module the class came from, so this is a property name and
    // nothing more. Downgrading to 'ambiguous' keeps its calls checked.
    expect(
      classificationsOf(
        `import * as M ${FROM_PACKAGE}\nnew M.ScopedLogger(l, 'c');`
      )
    ).toEqual(['ambiguous']);
  });

  test('an unrelated class is not a logger at all', () => {
    expect(classificationsOf('class Widget {}\nnew Widget();')).toEqual([null]);
    expect(
      classificationsOf(`import { Widget } ${FROM_PACKAGE}\nnew Widget();`)
    ).toEqual([null]);
  });

  test('configured class names are honoured', () => {
    expect(
      classificationsOf(
        "import { AppScope } from './logging';\nnew AppScope(l, 'c');",
        { scopedClassNames: ['AppScope'], loggerModules: ['./logging'] }
      )
    ).toEqual(['scoped']);
  });

  test('the new options compose with the existing ones', () => {
    // `additionalProperties: false` means an option a rule forgot to declare
    // is a hard config error, so the combination has to be exercised.
    expect(
      classificationsOf(
        "import { AppScope } from './logging';\nnew AppScope(l, 'c');",
        {
          loggerNames: ['Log', 'logger'],
          loggerModules: ['./logging'],
          singletonName: 'Log',
          loggerClassNames: ['AppLogger'],
          scopedClassNames: ['AppScope'],
        }
      )
    ).toEqual(['scoped']);
  });
});

describe('the constructor reaches the same channels as scoped()', () => {
  // End-to-end through the real rules, because classification alone does not
  // prove the rules consume the resulting argument shape. `new ScopedLogger`
  // puts the logger first, so correlation and subsystem sit one position
  // later than in `Log.scoped(...)`.
  const IMPORTS =
    "import { Log, ScopedLogger } from 'react-native-nitro-logger';";

  ruleTester.run(
    'no-derived-correlation',
    plugin.rules['no-derived-correlation'],
    {
      valid: [
        `${IMPORTS}\nnew ScopedLogger(Log, Log.newCorrelationId(), 'checkout');`,
      ],
      invalid: [
        {
          code: `${IMPORTS}\nnew ScopedLogger(Log, patient.id, 'checkout');`,
          errors: [{ messageId: 'derived' }],
        },
        {
          code: `${IMPORTS}\nnew ScopedLogger(...args);`,
          errors: [{ messageId: 'unanalyzable' }],
        },
      ],
    }
  );

  ruleTester.run('literal-subsystem', plugin.rules['literal-subsystem'], {
    valid: [
      `${IMPORTS}\nnew ScopedLogger(Log, Log.newCorrelationId(), 'checkout');`,
    ],
    invalid: [
      {
        code:
          IMPORTS +
          '\nnew ScopedLogger(Log, Log.newCorrelationId(), `tenant-${id}`);',
        errors: [{ messageId: 'dynamic' }],
      },
    ],
  });

  ruleTester.run(
    'no-computed-metadata-key',
    plugin.rules['no-computed-metadata-key'],
    {
      valid: [
        `${IMPORTS}\nconst s = new ScopedLogger(Log, Log.newCorrelationId());\ns.info('ok', { statusCode: 200 });`,
      ],
      invalid: [
        {
          code: `${IMPORTS}\nconst s = new ScopedLogger(Log, Log.newCorrelationId());\ns.info('ok', { [patient.id]: 1 });`,
          errors: [{ messageId: 'computed' }],
        },
      ],
    }
  );

  ruleTester.run('no-dynamic-message', plugin.rules['no-dynamic-message'], {
    valid: [
      `${IMPORTS}\nconst s = new ScopedLogger(Log, Log.newCorrelationId());\ns.info('admitted');`,
    ],
    invalid: [
      {
        code:
          IMPORTS +
          '\nconst s = new ScopedLogger(Log, Log.newCorrelationId());\ns.info(`patient ${p.name}`);',
        errors: [{ messageId: 'dynamic' }],
      },
    ],
  });

  // The constructor's fourth argument is the scope's DEFAULT metadata: it
  // rides every message the scope emits, so a computed key there leaks once
  // per log line. `describeScopedCall` normalizes it into `args[2]`, but that
  // only helps a rule that actually visits `NewExpression` — this one did not,
  // so the constructor spelling went unreported while `Log.scoped()` with the
  // identical object was caught.
  ruleTester.run(
    'no-computed-metadata-key',
    plugin.rules['no-computed-metadata-key'],
    {
      valid: [
        `${IMPORTS}\nnew ScopedLogger(Log, Log.newCorrelationId(), 'sub', { statusCode: 200 });`,
        // Stating there is no metadata is what the runtime sees too.
        `${IMPORTS}\nnew ScopedLogger(Log, Log.newCorrelationId(), 'sub', undefined);`,
      ],
      invalid: [
        {
          code: `${IMPORTS}\nnew ScopedLogger(Log, Log.newCorrelationId(), 'sub', { [patient.id]: 1 });`,
          errors: [{ messageId: 'computed' }],
        },
        {
          code: `${IMPORTS}\nnew ScopedLogger(Log, Log.newCorrelationId(), 'sub', { ...patient });`,
          errors: [{ messageId: 'spread' }],
        },
      ],
    }
  );
});

describe('a ScopedLogger reached through a local barrel is still checked', () => {
  /*
   * `export { ScopedLogger } from 'react-native-nitro-logger'` in an app's own
   * `src/logging.ts` is the ordinary way React Native apps centralise this —
   * arguably more common than importing the package directly. The class is the
   * genuine one, but the specifier says `./logging`, so provenance cannot be
   * verified.
   *
   * The first cut of this fix treated unverified as "not a ScopedLogger", and
   * these all reported NOTHING while the `Log.scoped(...)` spelling of the same
   * leak reported `derived` — the C2 defect reproduced one layer in. Checking
   * is decided by what the arguments reach; only TRUST needs provenance.
   */
  const BARREL = "import { ScopedLogger, Log } from './logging';";

  ruleTester.run(
    'no-derived-correlation',
    plugin.rules['no-derived-correlation'],
    {
      valid: [
        {
          // The escape hatch, and the reason it has to be pinned: naming the
          // barrel in `loggerModules` restores trust, so the encouraged form
          // stops reporting. Only the rejecting cases were pinned before, and
          // a provenance change could have left this configured path broken
          // with the suite still green.
          code: `${BARREL}\nnew ScopedLogger(Log, Log.newCorrelationId(), 'checkout');`,
          options: [{ loggerModules: ['./logging'] }],
        },
      ],
      invalid: [
        {
          code: `${BARREL}\nnew ScopedLogger(Log, patient.id, 'checkout');`,
          errors: [{ messageId: 'derived' }],
        },
        {
          // Unconfigured, the correct spelling is still reported: `Log` from
          // an unverified module is not a trusted mint. Conservative and
          // deliberate — and identical to what `Log.scoped()` has always done
          // through an unconfigured barrel, so the constructor is consistent
          // rather than newly strict.
          code: `${BARREL}\nnew ScopedLogger(Log, Log.newCorrelationId(), 'checkout');`,
          errors: [{ messageId: 'derived' }],
        },
      ],
    }
  );

  ruleTester.run('literal-subsystem', plugin.rules['literal-subsystem'], {
    valid: [],
    invalid: [
      {
        code: BARREL + '\nnew ScopedLogger(Log, c, `tenant-${id}`);',
        errors: [{ messageId: 'dynamic' }],
      },
    ],
  });

  ruleTester.run(
    'no-computed-metadata-key',
    plugin.rules['no-computed-metadata-key'],
    {
      valid: [],
      invalid: [
        {
          code: `${BARREL}\nnew ScopedLogger(Log, c, 'sub', { [patient.id]: 1 });`,
          errors: [{ messageId: 'computed' }],
        },
      ],
    }
  );

  test('a same-named class from an unrelated library is checked too', () => {
    // The deliberate cost of checking unverified constructions: `Logger` is a
    // common class name, so `new Logger()` from another logging library gets
    // its later calls checked as well.
    //
    // That is defensible rather than accidental. These rules do not protect
    // this package's API, they enforce "no interpolated log messages in this
    // codebase" — and under `strict`, in an app handling PHI, a variable
    // interpolated into tslog's output leaks exactly as much as one
    // interpolated into ours. The line is drawn at "looks like a logger":
    // an unrelated `Widget` is left alone entirely.
    const run = (code, options = {}) =>
      new Linter()
        .verify(code, {
          plugins: { n: plugin },
          languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
          rules: { 'n/no-dynamic-message': ['error', options] },
        })
        .map((m) => m.messageId);

    const OTHER_LIB =
      "import { Logger } from 'tslog';\n" +
      'const log = new Logger();\n' +
      'log.info(`user ${id}`);';

    expect(run(OTHER_LIB)).toEqual(['dynamic']);
    // Nothing that does not look like a logger is touched.
    expect(
      run(
        "import { Widget } from 'x';\nconst w = new Widget();\nw.info(`user ${id}`);"
      )
    ).toEqual([]);
    // And the escape hatch genuinely narrows it, so a project that wants only
    // its own class checked can say so.
    expect(run(OTHER_LIB, { loggerClassNames: ['AppLogger'] })).toEqual([]);
  });

  test('checking it does not also mean trusting it', () => {
    // The barrel class is checked, but it is not proof that nothing writes
    // through what it is handed, so it must NOT buy the escape exemption the
    // verified constructor gets.
    const messages = new Linter().verify(
      `${BARREL}\nconst MESSAGES = { start: 'started' };\n` +
        "new ScopedLogger(Log, 'c', 'sub', MESSAGES);\n" +
        'Log.info(MESSAGES.start);',
      {
        plugins: { n: plugin },
        languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
        rules: { 'n/no-dynamic-message': 'error' },
      }
    );
    expect(messages.map((m) => m.messageId)).toEqual(['dynamic']);
  });
});

describe('constructing does not launder a binding', () => {
  // Handing a value to `new X(…)` is normally an escape: X can write through
  // the reference before a later call reads it. Recognizing the package's own
  // constructors had to carve one exemption out of that, and the exemption
  // must stay exactly one constructor wide.
  //
  // The carve-out exists because without it `new ScopedLogger(Log, …)` made
  // `Log` escape, which cost it the trust `Log.newCorrelationId()` needs — so
  // the *encouraged* form of the constructor reported a derived correlation
  // ID. A rule that fires on correct code is a rule that gets disabled.
  ruleTester.run('no-dynamic-message', plugin.rules['no-dynamic-message'], {
    valid: [
      // The package's own constructor cannot rewrite what it is handed.
      "import { Log, ScopedLogger } from 'react-native-nitro-logger';\n" +
        "const MESSAGES = { start: 'started' };\n" +
        "new ScopedLogger(Log, 'c', 'sub', MESSAGES);\n" +
        'Log.info(MESSAGES.start);',
    ],
    invalid: [
      {
        // Any other constructor is a function we cannot see inside.
        code:
          `${IMPORT_LOG}\n` +
          "const MESSAGES = { start: 'started' };\n" +
          'new Registry(MESSAGES);\n' +
          'Log.info(MESSAGES.start);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        // A same-named constructor from somewhere else is not the package's.
        code:
          `${IMPORT_LOG}\n` +
          "import { ScopedLogger } from './phi-helpers';\n" +
          "const MESSAGES = { start: 'started' };\n" +
          "new ScopedLogger(Log, 'c', 'sub', MESSAGES);\n" +
          'Log.info(MESSAGES.start);',
        errors: [{ messageId: 'dynamic' }],
      },
      {
        // The builtin-statics allowlist is for CALLS. Routing constructors
        // through `callCanMutateArguments` briefly let this through as well,
        // which is one exemption more than the fix needs — `new Object.freeze`
        // throws at runtime, so nothing is gained by trusting it.
        code:
          `${IMPORT_LOG}\n` +
          "const MESSAGES = { start: 'started' };\n" +
          'new Object.freeze(MESSAGES);\n' +
          'Log.info(MESSAGES.start);',
        errors: [{ messageId: 'dynamic' }],
      },
    ],
  });

  test('the call form of the same allowlist is untouched', () => {
    // Narrowing the constructor path must not cost `Object.freeze(M)` its
    // exemption, which is the case the allowlist actually exists for.
    const messages = new Linter().verify(
      "import { Log } from 'react-native-nitro-logger';\n" +
        "const MESSAGES = { start: 'started' };\n" +
        'Object.freeze(MESSAGES);\n' +
        'Log.info(MESSAGES.start);',
      {
        plugins: { n: plugin },
        languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
        rules: { 'n/no-dynamic-message': 'error' },
      }
    );
    expect(messages).toEqual([]);
  });
});

describe('every constructible logger is classified', () => {
  /**
   * The provenance twin of the `LOGGER_OWN_METHODS` pin.
   *
   * That one fails when the Logger grows a method nobody classified. This one
   * fails when the package grows a *class* you can construct a logger from and
   * nobody taught `classifyConstruction` about it — which is how the
   * `ScopedLogger` constructor went unguarded through two releases while
   * `Log.scoped()` was covered.
   *
   * Derived from the real export list rather than a written-down list, so it
   * cannot be satisfied by remembering to update it.
   */
  const { LOG_METHODS } = require('../eslint-plugin/shared');
  const ts = require('typescript');
  const { readdirSync, readFileSync } = require('fs');
  const { join } = require('path');

  /**
   * Every exported class under `src/`, with the names it extends.
   *
   * Read from the source text rather than by importing: `src/index.tsx` pulls
   * in `react-native-nitro-modules`, which needs a TurboModule that does not
   * exist in this environment. Scanning the whole tree rather than following
   * `src/index.tsx` is deliberate and errs wide — a class is found wherever it
   * lives, so a new logger cannot hide behind a barrel that has not re-exported
   * it yet. The cost is that a class exported from a module the package never
   * re-exports is guarded too, which is the harmless direction.
   *
   * Handled: an `export` modifier or a later `export { X }`; an emitting
   * method or a property holding a function; and `extends` through a
   * qualified name or a renamed import.
   *
   * NOT handled, because this is syntax rather than a resolved program: a base
   * class reached through a namespace import (`import * as m; extends m.X`),
   * `export * from`, or a base class whose name collides across two files.
   * Those would need a real `ts.Program` and a TypeChecker. The failure mode
   * is a new emitting class going unguarded, so this is a floor on coverage,
   * not a proof of completeness.
   */
  function exportedClasses(dir) {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...exportedClasses(path));
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;

      const file = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );

      // `export { AuditLogger }` further down the file exports just as much as
      // an `export` modifier on the declaration.
      const exportedLater = new Set();
      // `import { Logger as BaseLogger }` — the heritage clause names the
      // local alias, so `extends BaseLogger` has to resolve back to `Logger`
      // or an inherited emitter looks like an unrelated base class.
      const importAliases = new Map();
      for (const node of file.statements) {
        if (ts.isExportDeclaration(node) && node.exportClause) {
          if (ts.isNamedExports(node.exportClause)) {
            for (const el of node.exportClause.elements) {
              exportedLater.add((el.propertyName ?? el.name).text);
            }
          }
          continue;
        }
        if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
          const bindings = node.importClause.namedBindings;
          if (ts.isNamedImports(bindings)) {
            for (const el of bindings.elements) {
              if (el.propertyName) {
                importAliases.set(el.name.text, el.propertyName.text);
              }
            }
          }
        }
      }

      for (const node of file.statements) {
        if (!ts.isClassDeclaration(node) || !node.name) continue;
        const exported =
          (ts.getModifiers(node) ?? []).some(
            (m) => m.kind === ts.SyntaxKind.ExportKeyword
          ) || exportedLater.has(node.name.text);
        if (!exported) continue;

        // A method, or a property holding a function — `info = (m) => …` is
        // as much an emitting method to a caller as `info(m) { … }`.
        const declaresEmitter = node.members.some((m) => {
          const named =
            m.name && ts.isIdentifier(m.name) && LOG_METHODS.has(m.name.text);
          if (!named) return false;
          if (ts.isMethodDeclaration(m)) return true;
          return (
            ts.isPropertyDeclaration(m) &&
            !!m.initializer &&
            (ts.isArrowFunction(m.initializer) ||
              ts.isFunctionExpression(m.initializer))
          );
        });

        // `extends Logger`, `extends BaseLogger` (an alias), and
        // `extends logging.Logger` all name the same base. Take the rightmost
        // identifier of a qualified expression, then map any local alias back
        // to the symbol it was imported under.
        const baseName = (expression) => {
          if (ts.isIdentifier(expression)) return expression.text;
          if (
            ts.isPropertyAccessExpression(expression) &&
            ts.isIdentifier(expression.name)
          ) {
            return expression.name.text;
          }
          return null;
        };

        const extendsNames = (node.heritageClauses ?? [])
          .filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
          .flatMap((h) => h.types.map((t) => baseName(t.expression)))
          .filter(Boolean)
          .map((name) => importAliases.get(name) ?? name);

        found.push({ name: node.name.text, declaresEmitter, extendsNames });
      }
    }
    return found;
  }

  /**
   * Classes that emit, including by inheritance.
   *
   * A subclass that adds nothing still reaches every destination its base
   * does, so `class AuditLogger extends Logger {}` has to be classified even
   * though it declares no method of its own.
   */
  function emittingClasses(classes) {
    const emitting = new Set(
      classes.filter((c) => c.declaresEmitter).map((c) => c.name)
    );
    for (let changed = true; changed;) {
      changed = false;
      for (const c of classes) {
        if (emitting.has(c.name)) continue;
        if (c.extendsNames.some((base) => emitting.has(base))) {
          emitting.add(c.name);
          changed = true;
        }
      }
    }
    return [...emitting];
  }

  const declared = exportedClasses(join(__dirname, '..', 'src'));
  const loggerClasses = emittingClasses(declared).sort();

  test('the source scan found the classes it is meant to guard', () => {
    // Without this the loop below passes vacuously on an empty list.
    expect(loggerClasses).toEqual(['Logger', 'ScopedLogger']);
  });

  test('inheritance is followed transitively and survives a cycle', () => {
    // The fixed-point loop is what makes a subclass that declares nothing
    // still count. It runs over syntax, so a cycle — which TypeScript itself
    // rejects, but a malformed tree can contain — must terminate rather than
    // hang the suite.
    expect(
      emittingClasses([
        { name: 'Logger', declaresEmitter: true, extendsNames: [] },
        {
          name: 'AuditLogger',
          declaresEmitter: false,
          extendsNames: ['Logger'],
        },
        // Two levels down, and via an alias the scan already resolved.
        {
          name: 'TenantLogger',
          declaresEmitter: false,
          extendsNames: ['AuditLogger'],
        },
        { name: 'Unrelated', declaresEmitter: false, extendsNames: ['Widget'] },
        { name: 'A', declaresEmitter: false, extendsNames: ['B'] },
        { name: 'B', declaresEmitter: false, extendsNames: ['A'] },
      ]).sort()
    ).toEqual(['AuditLogger', 'Logger', 'TenantLogger']);
  });

  test.each(loggerClasses)('new %s() is classified, not ignored', (name) => {
    const [classification] = classificationsOf(
      `import { ${name} } from 'react-native-nitro-logger';\nnew ${name}(a, 'c');`
    );
    // Exact, not truthy: 'ambiguous' is truthy and would mean the class was
    // recognized by NAME only, with its provenance never established.
    expect(['logger', 'scoped']).toContain(classification);
  });
});
