# react-native-nitro-logger

## 0.2.0

### Minor Changes

- df61052: One process at a time: a file sink now takes an exclusive lock on its log file.

  Two processes appending to one log file interleave mid-record and run two
  rotation schedules over the same names — the collision the writer registry
  prevents inside one process, arriving from outside it, where a registry cannot
  see it. An app extension, a share sheet, a background service pointed at the
  same path could all do it, and until now the log just quietly came apart.

  Opening a sink takes a non-blocking exclusive lock on a `<logfile>.lock` file
  next to the log — `flock` on iOS, `FileChannel.tryLock` on Android. An open that
  finds another process holding it fails with "another process is writing this log
  file" instead of appending alongside it. This does not make cross-process
  _writing_ work; it makes the second writer fail loudly rather than corrupt the
  first one's file.

  The lock is on a file of its own because rotation renames the active file and a
  lock follows the inode — held on the log itself the exclusion would ride the
  rename into an archive and leave the live file unguarded. It holds no log bytes
  and is never deleted, including by `purge()`: unlinking a locked name lets the
  next process lock a fresh file and write alongside the first, so removing it
  would defeat the exclusion rather than serve it. `PurgeOutcome.durable` keeps
  exactly the meaning it had.

  A filesystem that cannot lock is a degradation, not a failure. The new
  `exclusivity` bit (`1 << 5`) goes up in the mask `FileDestination.degradation()`
  returns and logging continues — refusing to log because the storage will not
  exclude would be a far worse answer than logging without the guarantee.

- d9f11c2: `collectForSupport()` — one gzip bundle of the whole log, for a support upload.

  `getLogFilePaths()` has been there since 0.1.0 and it is the wrong shape for
  what people actually do with it. An app that wants to attach its logs to a
  support ticket gets back a list of paths, and then has to read each one, work
  out that some are gzipped and some are not, and reassemble them in an order the
  filenames only approximately describe — the active file is the newest, the
  archives count backwards, and a rotation landing mid-collect changes the
  answer. Every app that does this writes the same code, and most of them get the
  ordering wrong.

  `FileDestination.collectForSupport({ maxTotalBytes })` does it once, natively,
  on the writer's own queue where a rotation cannot land halfway through. It
  returns a `CollectOutcome` with the path of a single `.gz` file that `gunzip`
  turns into the whole log as chronological JSON Lines.

  That works because gzip is a multi-member format: concatenated members
  decompress as one stream. Archives that are already compressed are copied in
  byte for byte — no decompress-recompress cycle, no second compression path to
  maintain — and the flushed active file is compressed in beside them through the
  compressor the writer already owns. The JS buffer is flushed first, so records
  written a moment ago are in it.

  **`maxTotalBytes` is required and `Infinity` is refused.** How much of a log
  leaves the device is the application's decision, and a default would be this
  library making it. It is measured on the source bytes rather than the
  compressed result — a ceiling you can only check after compressing does not
  bound the work — and applied newest-first, so a ceiling smaller than the log
  keeps the recent end, which is the end somebody debugging is asking about. A
  negative or non-finite value throws a `RangeError` rather than being read as
  "no ceiling", and the natives independently clamp such a value to zero: the
  direction a broken number has to fail in is sending nothing, never sending
  everything. Zero is legitimate and produces no bundle at all.

  Read `complete` before `path`. `complete: true` with an empty `path` is a
  device with no logs, which a support flow should report as "nothing to send"
  rather than as a failure; `complete: false` means the collect did not finish
  and there is no bundle. `truncated` is orthogonal and ordinary — the ceiling
  was reached.

  The bundle lands at a fixed name inside the sink's own directory, never a path
  the caller picks: a support feature is not a reason to ship a
  write-a-file-anywhere primitive, which is also why `readLogFile(path):
ArrayBuffer` was rejected in favour of this. It is written to a staging name and
  renamed, so an interrupted collect leaves something the retention sweep
  recognises rather than a plausible-looking `.gz` no tool can open. At most one
  exists — each collect replaces the last — and both names join the artifact
  predicate, so `purge()` deletes them; a compliance deletion that left a gzipped
  copy of the log behind would not be a deletion. It is excluded from
  `getLogFilePaths()`, from the archive count and from `maxTotalLogBytes`.

  Not built, and recorded as decisions in `docs/PRIVACY.md` rather than left as
  gaps: no upload, and no app-layer encryption. Transmission needs a consent flow
  and a retention policy at the far end that belong to the application; the
  bundle is already encrypted at rest by the platform under the same protections
  as every other artifact, and a decryption key shipped inside the app that reads
  it would be theatre.

  A collect the caller stopped waiting for does not publish. The build cannot be
  cancelled mid-copy — nothing cancels a queued block — so it is stopped at the
  rename instead: it deletes its staging file rather than putting a bundle in
  place. Without that, a call that reported "no bundle" would drop a complete
  second copy of the log beside the log seconds later, outside the retention
  budget the app configured and skipped by the orphan sweep, because a _finished_
  bundle is one somebody may be about to upload.

  The handoff is per collect rather than per writer, and the rename happens
  inside it. Both matter. Per collect, because one caller's timeout must not
  abandon another caller's build and must not poison every collect after it; and
  the rename inside the barrier, because that is what makes "did this publish?" a
  question with a single answer rather than a window measured in whatever timeout
  seemed generous. Both suites pin all three with a compressor slow enough to
  overrun the deadline: one collect that overruns publishes nothing, two that
  overrun publish nothing, and a collect after an overrun one still works.

  What this does not prove. The Swift suite decompresses with the real `gzip -dc`
  binary, which is the tool a support engineer would use, but the Kotlin suite
  reads with `GZIPInputStream` — a second implementation of the same format, not
  the same one. Neither says anything about what an upload endpoint does with the
  file afterwards.

  Nothing reaches the offset rollback that undoes a member whose copy died
  halfway. Staging one needs a read or a write that fails _part way through_ a
  256 KB chunk, and neither writer has a seam for that; the member failures the
  suites can stage all fail before a byte is written, where the rollback is a
  no-op. It is kept because the failure is real on a device even though the
  harness cannot produce it.

  And the order of two archives written inside the same millisecond is undefined
  — archives sort by modification time and the name only breaks exact ties. The
  tests buy that separation explicitly; production rotations, which are megabytes
  apart, get it for free.

- 69a802c: Rotation and retention no longer wait for the next record: `maintain()` and
  `scheduleMaintenance()`.

  Rotation runs from the write path and nowhere else — the writer rotates when a
  record makes the file too big or too old _as it is being appended_, and sweeps
  retention when it opens or rotates. A sink nobody is logging to therefore keeps
  whatever it had when the last record landed: an age rotation that never fires,
  an expired archive that is never deleted, a `maxTotalLogBytes` cap that goes on
  being exceeded. An app that logs on error and then has a quiet week has a
  retention policy that did not run that week.

  `FileDestination.maintain(deadlineMs?)` runs both, on the writer's own queue so
  it cannot interleave with a rotation a write is already performing, and returns
  the degradation mask read once its bounded wait is over — a prune that has
  started failing shows up in the answer to the call that tried it, rather than on
  the next append that may never come. A sweep still running when the deadline
  expires is not in that answer; it finishes on the queue regardless, and any
  status read after it completes carries what it found. `flush()` is not a
  substitute and never was: it drains what is buffered and moves no files.

  `scheduleMaintenance({ destination, intervalMs, deadlineMs, appState })` is the
  timer, and it lives in JavaScript. A native one would have to run on a queue the
  app cannot see, wake a suspended process, and answer to a retention policy the
  JS side owns; a JS interval instead freezes when the JS thread freezes, and the
  policy stays with the caller. It pauses off the foreground and takes one
  catch-up sweep on the way back in — an interval frozen for six hours has six
  hours of expired archives waiting — and does _not_ sweep at install, because
  opening the sink has just run one and app launch is the worst moment to scan a
  directory. `intervalMs` defaults to five minutes and is clamped up to
  `MINIMUM_MAINTENANCE_INTERVAL_MS` (30 seconds).

  New exports: `scheduleMaintenance`, `MINIMUM_MAINTENANCE_INTERVAL_MS`,
  `ScheduleMaintenanceOptions`, `MaintainableDestination`. The spec gains
  `maintain(deadlineMs): SinkStatus`, so `FileSinkLike` implementations gain one
  method.

  Stated limits: a released or fenced handle sweeps nothing and reports the mask
  it already had — the files it would sweep belong to whichever handle holds the
  writer now — and a destination that is disposed does the same without calling
  the sink at all.

- 33f728e: Add `installRejectionHandler()` — unhandled promise rejections reach the log.

  React Native installs a promise-rejection tracker in development and none in a
  release build, so an `async` function that throws with nobody awaiting it has
  been silent in exactly the builds that ship. This is the way to get it back.

  The rejection reason goes through the same sanitiser an uncaught error does,
  because it is caller data by construction: `Promise.reject(new Error(mrn))` is
  an ordinary line to write. What reaches the log is a built-in class name, a
  redacted message outside dev, and stack positions in files whose names were
  already known.

  It does not flush, unlike the crash handler — nothing is dying and the next
  ordinary flush carries the entries out. It logs a second entry, at `info`, when
  a rejection reported unhandled turns out to be handled after all: a tracker
  decides "unhandled" on a timer, so a `.catch()` one turn late would otherwise
  leave the log saying a failure went unreported and never taking it back. The two
  entries carry the same `rejectionId`, and only the handler that wrote the first
  one writes the second — a retraction of something the log never said would be
  worse than none.

  New exports: `installRejectionHandler`, `REJECTION_METADATA_KEYS`,
  `UNHANDLED_REJECTION_MESSAGE`, `REJECTION_HANDLED_LATE_MESSAGE`,
  `RejectionHandlerOptions`, `RejectionTrackingLike`, `RejectionTrackingOptions`.
  Its `subsystem` option is covered by the `literal-subsystem` lint rule, like the
  crash handler's.

  Stated limits: chaining links calls to this function and nothing else, because
  `enable()` replaces the tracker wholesale and offers no way to read back what
  was there; and installing it in development replaces LogBox's rejection popup,
  though the entry still reaches every destination, console included.

### Patch Changes

- 7588836: Android's React Native ≥ 0.78 claim is now verified, not narrowed.

  Since 0.1.0 the compatibility table said one thing for iOS and a weaker thing
  for Android: `min-rn-ios` packs a tarball into a pristine 0.78 app, builds it
  Release and launches it, while Android had `test-android` (the writer's JUnit
  suite) and `build-android` (the example, on the newest React Native) and
  nothing that asked whether a consumer on the bottom of the range could install
  the package at all. The claim was narrowed to "0.78 experimental" rather than
  asserted, which was the honest option available at the time.

  `min-rn-android` closes it. Same shape as the iOS job — `yarn pack`, scaffold
  0.78 from the community template, install the tarball, open a file sink, write
  500 records, flush, list, purge — built Release for the emulator's own ABI and
  launched on API 34.

  The one difference is how the verdict gets out, and it is stated in
  `docs/PARITY.md` rather than glossed. iOS reads the log file out of the app
  container; Android would need `run-as` for that, which needs a debuggable
  build, and a debug build does not verify the thing this job exists for — R8,
  the bundled JavaScript and the packaged `.so` set are exactly what differs in
  release. So the app reports its own verdict through `console.log`, which Hermes
  routes to the `ReactNativeJS` logcat tag. A library that misreported its own
  outcome would be believed there and caught on iOS; a run ID required in the
  verdict line is what stops a stale logcat buffer signing off a run that never
  happened.

  Still not claimed: arm64 hardware, physical devices, and OS versions other than
  API 34 — minimum-OS is `test-android-instrumented`'s claim, which runs down to
  API 24.

- 8283ded: Release the log writer when a React instance is destroyed (Android).

  A reload — Metro's, or any `ReactHost.reload()` — tears down the JavaScript
  context without running any of it, so nothing closed the file sink. On Android
  nothing else could either: Nitro's `HybridObject` sits in a JNI
  strong-reference cycle that only an explicit `dispose()` breaks, so `finalize()`
  never runs. The writer kept the registry slot and the descriptor for the life of
  the process, and the next `open` with a different rotation config was refused
  against a sink nothing could reach. File logging was gone until the app
  restarted.

  Each handle is now recorded against the React instance that acquired it, and
  that instance's claims are released when it is destroyed — on
  `NativeModule.invalidate()`, which fires on exactly instance teardown. The unit
  of release is the claim rather than the writer, so a writer shared with a
  still-live instance survives at a lower refcount. In a host that never registers
  the module nothing changes.

  No API change. iOS was never affected: `deinit` is deterministic and already
  did this.

- f8375f7: Fix release builds on Android, which failed for every consumer.

  The package declared no `codegenConfig`, and React Native's Gradle plugin runs
  codegen for a library module regardless — with its scan root defaulting to the
  package directory. From there it reached React Native's own `Native*.js` files,
  treated them as this library's specs, and compiled about ninety
  `com.facebook.fbreact.specs.*` and `com.facebook.react.viewmanagers.*` classes
  into the artifact.

  A consumer then had those classes twice, once from here and once from
  `react-android`. Debug builds tolerate that; release builds fail:

      Type com.facebook.fbreact.specs.NativeAccessibilityInfoSpec is defined
      multiple times

  Codegen is now scoped to this package's own `src`, and the artifact contains
  this library's classes and nothing else. No API change, and nothing to do on
  upgrade beyond a clean build.

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
