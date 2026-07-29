# react-native-nitro-logger

## 0.1.2

### Patch Changes

- The published ESLint config now lints TypeScript, and `new ScopedLogger(...)` is checked.

  `configs.recommended` and `configs.strict` carry no `files` key, so under ESLint
  flat config they select only `.js`, `.mjs` and `.cjs`. In a React Native app the
  documented setup therefore matched nothing and `eslint .` exited 0 in silence —
  and message text, correlation IDs and subsystems have no runtime redaction, so
  those rules were the whole protection. Use **`configs.strictTypeScript`** (or
  `recommendedTypeScript`), which set the file set and the parser and cover
  JavaScript too, so one entry is enough. `@typescript-eslint/parser` is an
  optional peer with no version constraint.

  `new ScopedLogger(logger, correlation, subsystem, metadata)` reaches the same
  unredactable channels as `logger.scoped(...)` and was reported on by nothing;
  all four rules now check both spellings, including a `ScopedLogger` re-exported
  through your own barrel.

## 0.1.1

### Patch Changes

- Documentation only; no runtime behaviour changed.

  The 0.1.0 README and `docs/PARITY.md` cited the SwiftLogger repository at a URL
  that 404s, so every reference backing the `JsonLinesFormatter` parity claim
  pointed at nothing. The citation is corrected and repinned to the specific
  SwiftLogger commit the comparison is actually against — the version it named
  before predates the formatter it claimed parity with.

  - **`docs/API.md`** is new and documents all 69 exports, including several that
    were reachable but undocumented: `sanitizeError` and its constants, `Batcher`,
    `utf8Length`, and the Nitro call-result types a `FileSinkLike` implementation
    has to construct.
  - **The native console sink is documented.** `NativeConsoleDestination` and
    `createNativeConsoleSink` appeared nowhere, though the package advertises
    system-console sinks in its first sentence.
  - **`CHANGELOG.md` now ships.** It was missing from `files`, so it never reached
    the 0.1.0 tarball. The README's contributing links are absolute, since those
    files do not ship and the relative links died inside `node_modules`.
  - **`keywords`** covers logging, privacy, os_log and logcat rather than only the
    platform names.

## 0.1.0

### Minor Changes

- 86a9cbf: Initial release.

  Structured, privacy-tiered logging for React Native, with native file and
  system-console sinks on Nitro Modules.

  - **Privacy tiering.** In a release build, `Log.privacyDefault('private')` makes
    every unwrapped metadata value redact, so a forgotten `pub()` hides data
    rather than leaking it. (A debug build renders private payloads in the clear,
    to every destination — see `docs/PRIVACY.md`.) Values are validated to exact
    primitives on the way in and again on unwrap; markers and their payloads live
    in module-private `WeakMap`s, so there is no enumerable field to find and no
    reveal API to call. The reveal branch is `__DEV__`-gated and CI proves it is
    absent from a release bundle.
  - **A bundled ESLint plugin** for the fields that cannot be redacted at
    runtime: message text, metadata keys, subsystems, and correlation IDs.
    `recommended` covers messages and keys; `strict` adds correlation provenance
    and literal subsystems.
  - **A native file sink** with size- and age-based rotation, gzipped archives,
    three retention limits, crash-tail recovery under a declared framing
    contract, detection of externally deleted files, bounded byte reservation
    with honest backpressure, and a deadline-bounded compliance purge that
    reports `durable` and `rebound` separately.
  - **`JsonLinesFormatter`**, asserted byte-identical to SwiftLogger's
    `JSONLogFormatter` over a generated corpus.
  - **An uncaught-error handler** that sanitises the thrown value before logging
    it, and an AppState hook that attempts to flush buffered entries before the
    app suspends. That flush is deadline-bounded and best-effort: the hook returns
    an uninstall handle only, so a flush that times out or fails is not surfaced
    to the caller. `Logger.flush()` returns nothing either — call
    `FileDestination.flush(deadlineMs)` if you need the `durable` result.

  Compatibility is claimed per platform: iOS is CI-verified against React Native
  0.78 by building and launching a pristine consumer app, while Android is
  verified at the example's version and 0.78 is marked experimental until an
  equivalent Android job exists.
