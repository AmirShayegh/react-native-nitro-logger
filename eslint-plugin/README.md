# `react-native-nitro-logger/eslint-plugin`

The build-time half of the privacy contract.

Under `privacyDefault('private')` the runtime redacts metadata **values**. It
can never redact the fields around them: by the time a message string,
subsystem, correlation ID, or metadata key reaches the logger, any
interpolation already happened and the original data is gone. Those four fields
are *public by contract*, and these rules are what make that contract true.

Under the default `privacyDefault('public')` profile, values are not redacted
either — they are public because you declared them so. These rules matter more
there, not less.

<!-- eslint-setup:begin -->

```js
// eslint.config.mjs
import nitroLogger from 'react-native-nitro-logger/eslint-plugin';

export default [nitroLogger.configs.strictTypeScript];
```

<!-- eslint-setup:end -->

## Configs

| Config                  | Lints                        | Rules                                                    | For                                                |
| ----------------------- | ---------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| `recommended`           | **JavaScript only**          | `no-dynamic-message`, `no-computed-metadata-key`          | OSS apps. Catches what is almost always a mistake. |
| `strict`                | **JavaScript only**          | those plus `no-derived-correlation`, `literal-subsystem`  | Apps under `privacyDefault('private')` — PHI, PII. |
| `recommendedTypeScript` | `.ts`, `.tsx` and JavaScript | same as `recommended`                                     | The same, in a TypeScript app.                     |
| `strictTypeScript`      | `.ts`, `.tsx` and JavaScript | same as `strict`                                          | The same, in a TypeScript app.                     |

Pick **one**, not two — the TypeScript variants already cover JavaScript.
"JavaScript only" above means *used on their own*; see the qualification below.

**Why the distinction is load-bearing.** A flat config with no `files` key
selects only ESLint's default set: `.js`, `.mjs`, `.cjs`. Point the bare
`strict` config at a TypeScript app and it brings in nothing — `eslint .`
prints no findings and exits 0, and `eslint src/app.ts` says "File ignored
because no matching configuration was supplied". These rules are the *only*
protection for message text, correlation IDs and subsystems, none of which the
runtime can redact, so that silence looks identical to compliance and is the
opposite of it. The TypeScript variants set both the file set and the parser.

One qualification, because it is why this went unnoticed for two releases: a
file-less entry *does* apply to a TypeScript file that another entry in the
same config has already selected and supplied a parser for. This repository's
own `eslint.config.mjs` extends `@react-native/eslint-config`, which does
exactly that — so the rules ran here while the published config was inert.
That behaviour lasts only as long as the other entry keeps selecting
TypeScript and supplying a compatible parser, which is another package's
decision to change, so it is not something to depend on deliberately.

They need `@typescript-eslint/parser`, declared as an **optional** peer with no
version constraint: these configs hand the parser to ESLint and never
introspect it, so pinning a range would only risk an `ERESOLVE` for a consumer
whose parser already works — a `>=8.60` floor would reject parser 8.20 with
TypeScript 5.7, which lints these rules perfectly well. The parser's own peer
range governs which TypeScript it accepts. In practice ESLint sets the floor:
these configs require `eslint >=9`, and parser 7.x declares `eslint ^8.56.0`,
so an app still on `@react-native/eslint-config@0.78` (which pins parser
`^7.1.1`) needs to upgrade both before any of this applies. Selecting a
TypeScript config without the parser fails with an install command rather than
a resolution stack trace. Flow-annotated `.js` is the one case to avoid these
configs: the TypeScript parser rejects it, so compose `strict` with your own
parser instead.

Both fail closed on metadata: an object the rules cannot open is reported,
because that is exactly the case where they cannot tell a reviewed key from a
patient identifier.

## Configure `loggerModules` first

Almost every app re-exports the logger from its own module:

```ts
// src/logging.ts
export { Log } from 'react-native-nitro-logger';
```

The rules trust a logger by **provenance, not by name** — a binding called
`Log` imported from somewhere unknown could be anything, and treating it as the
singleton would let its `newCorrelationId()` mint approved IDs out of medical
record numbers. So out of the box, `import { Log } from '../logging'` is
checked but not trusted, and correct code reports:

```
no-derived-correlation  Correlation IDs must come from newCorrelationId()…
no-computed-metadata-key  Metadata must be an object literal at the call site…
```

Tell the plugin which modules legitimately hand out the logger:

```js
{
  rules: {
    'nitro-logger/no-derived-correlation': [
      'error',
      { loggerModules: ['react-native-nitro-logger', '@/logging'] },
    ],
  },
}
```

List every module that re-exports it. This is a trust boundary — anything named
here is believed to hand out the real Logger, so keep it to modules you own.

Since 0.1.2 this applies to `new ScopedLogger(logger, correlation, subsystem)`
as well, which reaches the same two unredactable channels as
`logger.scoped(...)`. A `ScopedLogger` re-exported from your own barrel is
checked either way; naming that barrel here is what stops the *correct*
spelling from reporting, exactly as it does for `Log.scoped()`.

## Rules

### `no-dynamic-message`

Messages must be string literals or constants that resolve to one.

```js
Log.info(`patient ${id} admitted`); // error: interpolation cannot be redacted
Log.info('patient admitted', { patientRef: pub(ref) }); // ok
```

### `no-computed-metadata-key`

Metadata keys must be literal and, when a catalog is configured, drawn from it.
A computed key or a spread hides the key set from review — and `patientId` is
very often a value like `patient123`, which passes the runtime's shape check and
reaches the destination intact.

```js
Log.info('m', { [patientId]: v }); // error: computed
Log.info('m', { ...record }); // error: spread
Log.info('m', buildMetadata(p)); // error: unanalyzable
```

### `no-derived-correlation`

Correlation IDs appear on every line of a scope, so they must be opaque and
freshly random. Reusing a record identifier turns the whole scope into a
re-identification key, and hashing does not fix it — a hash of a small
identifier space is trivially reversible.

```js
Log.scoped(patient.mrn); // error
Log.scoped(hash(patient.mrn)); // error — still 1:1 with the patient
Log.scoped(Log.newCorrelationId()); // ok
```

### `literal-subsystem`

Subsystem names must be literal. A computed name is both a leak risk and a
functional bug: `Log.subsystem('network', 'debug')` can only match names known
at configuration time, so a dynamic name silently misses every level override
the app configured.

This covers the package's free functions as well as its methods —
`installErrorHandler({ subsystem })` tags every uncaught-error entry with a name
that renders unredacted, and it is checked the same way. Free functions are
matched by **import**, not by name: an `installErrorHandler` of your own is not
this package's, and demanding a literal of it would be a false positive on
unrelated code. The cost is that a re-export barrel is not followed — add the
barrel's module path to `loggerModules` and it is.

## Options

Every rule accepts `loggerNames`, `loggerModules`, and `singletonName`.
`no-computed-metadata-key` additionally accepts `catalog` and
`allowOpaqueMetadata`.

| Option                | Default                          | Meaning                                                                                                                    |
| --------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `loggerNames`         | `['Log', 'log', 'logger']`       | Identifiers to treat as logger receivers. Widens what is **checked**, never what is **trusted**.                            |
| `loggerModules`       | `['react-native-nitro-logger']`  | Modules an import of the logger may come from. This is what grants trust — see above.                                       |
| `singletonName`       | first of `loggerNames`           | The name meaning the Logger itself rather than a ScopedLogger. Decides argument **shape**, since `Log.log` and `scope.log` differ. |
| `catalog`             | none                             | Approved metadata keys. Mirrors the runtime's contract, so a key lint accepts is one the runtime will keep.                 |
| `allowOpaqueMetadata` | `false`                          | Stop reporting metadata objects the rules cannot open. A `catalog` overrides this — a catalog promises every key was reviewed. |

## What the rules cannot see

They are a control, not a proof. Analysis is per-file and stops at the module
boundary: metadata assembled in another file and imported arrives opaque, and is
reported as `unanalyzable` rather than approved.

### Loggers installed by a function call are not followed

This is the one limitation worth knowing before you rely on these rules.

```js
function configure(target, fn) {
  target.emit = fn;
}
configure(handlers, Log.info);
handlers.emit(`patient ${id} admitted`, { [mrn]: v }); // NOT reported
```

The rules see `handlers.emit(...)` and cannot tell it is a logger call. That
call site is then outside **all four rules at once**, not just the message:

| Field          | Normally enforced by      | At a helper-wired call site |
| -------------- | ------------------------- | --------------------------- |
| message        | `no-dynamic-message`      | unchecked                   |
| metadata keys  | `no-computed-metadata-key`| unchecked                   |
| correlation ID | `no-derived-correlation`  | unchecked                   |
| subsystem      | `literal-subsystem`       | unchecked                   |

What the runtime still does for you at such a call site depends entirely on
which privacy profile you are running, and the difference is large:

|                     | `privacyDefault('private')`                     | `privacyDefault('public')` — the default |
| ------------------- | ----------------------------------------------- | ---------------------------------------- |
| Unwrapped **value** | redacted to `<private>`                          | **logged as written**                    |
| `pub(v)` / `priv(v)`| renders / redacts                                | renders / redacts                        |
| **Key**             | catalog mandatory; without one all metadata drops| **any key matching `^[A-Za-z0-9._-]{1,64}$` is kept** |

Under `'private'` the runtime is the backstop the lint rules are not: a
forgotten wrapper hides data rather than leaking it, and a key you never
approved never appears. This gap then costs you the message, subsystem, and
correlation checks — real, but not the metadata.

Under the default `'public'` profile there is no backstop at all. Values are
public because you said they were, and `patient123` satisfies the key pattern.
A helper-wired `handlers.emit('m', { [mrn]: name })` reaches the destination
with the key and the value both intact.

**So if you log anything sensitive, set `privacyDefault('private')` and a
catalog.** That is worth doing regardless of this limitation, and it is what
makes the limitation survivable.

This holds whether `configure` is imported or defined right above the call.

It is deliberate. Following it correctly means interprocedural dataflow
analysis — parameter defaults, destructuring at any depth, rest patterns,
spread arguments, reassignment, shadowing, and every way a function can be
invoked — and each of those is a way to get it wrong in one of two directions.
An earlier revision of this plugin did follow local helpers. It went through
seven review rounds, kept admitting spellings it had missed, and had begun
reporting ordinary code: `configure(h, { [key]: () => Log.info('setup') })` is
a callback that logs a literal, not a logger installed on `h`. A rule that
reports ordinary code gets switched off, and a rule that is switched off
protects nothing.

**What to do instead.** Moving the helper into the same file does not help —
the local `configure` above is just as invisible. What the rules follow is a
logger that reaches the call site without passing through a call:

```js
Log.info(msg); // direct call
const s = Log.scoped(Log.newCorrelationId()); // scoped logger, then s.info(msg)
const emit = Log.info; // const alias of a method
handlers.emit = Log.info; // direct property assignment
const handlers = { emit: Log.info }; // object literal
Object.assign(handlers, { emit: Log.info }); // Object.assign
```

Those six forms are the supported set. Anything that hands the logger to a
function and lets the function install it is not.

**Which methods are checked.** The six level helpers (`verbose`, `debug`,
`info`, `warning`, `error`, `todo`), plus `log` and `logMessage` — the latter
because it is public and is what every other emitting method delegates to.
`scoped`, `subsystem` and `resetSubsystem` are checked for their own arguments.

That list is not maintained by hand against memory: a test enumerates
`Logger.prototype` and `ScopedLogger.prototype` and fails on any method that is
neither covered by a rule nor named in an explicit not-emitting list. This
matters because it is how coverage drifts — `logMessage` was public from the
start, was known to the plugin as a trusted method, and was checked by nothing,
so a `logMessage` call with an interpolated message linted clean while the
identical `log` call errored. Adding an emitting method now fails the suite
until somebody decides which side it falls on.

Within an options object both `metadata` and `scopeMetadata` are inspected.
They reach the same redaction path, and reading only the first left the other
half of the same pipeline unchecked.

Two more behaviours follow from taking the module boundary seriously, and both
look strict on first contact:

- **`const` protects the binding, not the object.** A metadata object that is
  written through, or handed to a function the rules cannot see inside, is not
  a constant.
- **A table of constants is only constant if nothing in it executes.** A
  literal containing a getter, a method, a function- or class-valued property,
  or `__proto__` resolves to nothing at all. Getters are the sharp case: one
  runs while the logger walks the object, and can rewrite its own siblings
  before they are read. Keep tables to plain data and they stay resolvable.
- **Unprovable is reported.** A spread argument, an opaque options object, a
  computed method name — each is a finding. Falling silent on the calls it
  cannot read is how a lint rule becomes decorative.
