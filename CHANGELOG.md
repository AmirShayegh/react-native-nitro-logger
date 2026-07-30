# react-native-nitro-logger

## 0.1.3

### Patch Changes

- `require()` resolves, the podspec points at a tag that exists, and four native
  paths report what actually happened.

  **A React Native app's Jest could not load the package.** Through 0.1.2 the only
  build target was ESM and `exports["."]` had no `require` condition, so the ESM
  file arrived untransformed in a CommonJS context and the suite died with
  `Cannot use import statement outside a module` before a single test ran —
  `@react-native/jest-preset`'s `transformIgnorePatterns` allowlist does not match
  this package name. There is a `commonjs` target now, with explicit
  `require`/`import` conditions carrying their own declarations, checked by probes
  that assert _which_ built entry each of Node `require`, ESM `import`, Jest and a
  Metro production bundle resolves — from a fixture outside the monorepo, since
  in-repo the workspace link resolves to `src/` and the shipped export map is
  never exercised at all.

  **The podspec named a tag that has never existed.** It interpolated
  `:tag => "#{s.version}"`, while Changesets tags releases as
  `react-native-nitro-logger@<version>`, so a CocoaPods consumer installing from
  git could not resolve the source.

  **iOS writer.** A flush that reached the writer after the close barrier called
  `writableHandle(ignoringBackoff:)`, which opened a descriptor nothing would ever
  close and then reported the sync as `durable`. A log directory whose backup
  exclusion or protection class silently failed was indistinguishable from one
  where it held: the registry evaluated the verdict and discarded it, so it never
  reached `degradation()`. And the registry's close-drain waits were measured
  against `Date()`, so a clock step during teardown could stretch a 200 ms close
  budget to the 30 s ceiling — they are monotonic now, as every other wait in the
  writer already was.

  **Sink lifecycle, both platforms.** The rules lived in the two Nitro adapters,
  which are excluded from the test targets, so neither copy was pinned and the two
  disagreed. They now delegate to one `FileSinkLifecycle` per platform, built from
  a written transition table, with matching suites on both sides. Two behaviours
  change: with no live handle, `flush` and `close` report `durable: true` only for
  a sink that never opened — iOS previously said `true` even after a close that
  timed out with bytes still pending, Android said `false` even for a sink that
  could not owe anything — and a second `close` arriving before an in-flight
  acquisition lands no longer frees the sink, which could previously hand the
  second caller a writer opened for the first caller's path and rotation policy.

  **Android modes.** A successful `chmod` is not evidence that the mode took: the
  FUSE layer over shared storage derives permissions from the mount and returns
  success regardless, and a FAT volume has no mode bits at all. Both left the file
  exactly as readable as it was while the writer recorded protection it never got.
  `restrictToOwner` reads the mode back with `Os.stat` masked to `07777` and
  reports a `protection` degradation on a mismatch. The syscall path is covered by
  13 instrumented cases on emulators at API 24 and 34 — it previously had no test
  at all, the Kotlin job having exercised a different implementation of the same
  interface.

  **Lint.** `no-derived-correlation` hardcoded the method name `log` in its
  spread/apply branch, so `Log.logMessage(...args)`, `.apply` and `.call` reported
  nothing — the one method whose second argument is always the options shape. It
  reports `unanalyzable` now, so a codebase using that form will see new errors.

  **`metadataKeyCatalog` says when it narrowed.** Repeat calls intersect and one
  malformed key empties the whole catalog; both are deliberate, both are silent,
  and under `privacyDefault('private')` both end with every metadata field
  rendering `<private>`. A development build now warns when a call leaves fewer
  keys approved than it found, and when the first call approves none — counts
  only, never a key name.

  **Documentation.** `JsonLinesFormatter` claimed to escape every control
  character; it escapes U+0000–U+001F, and the guarantee is that LF-delimited
  record boundaries stay intact, which obliges a reader to split on LF and parse
  each record before applying line semantics. Android's backup exclusion comes
  from `noBackupFilesDir` being the _default_ directory, so it does not travel
  with a log path you supply. `docs/PRIVACY.md`'s strict profile taught a one-call
  setup that drops all metadata, and the README's crash section taught a catalog
  that strips crash metadata. `LogFormatter.formatWithin`, `PurgeOutcome.discardedBytes`
  and `LogDestination.minimumLevel` were documented nowhere.

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
