# react-native-nitro-logger

## 0.3.0

### Minor Changes

- 1e39164: **Breaking changes.** Four of them, batched here so an upgrade has one place to
  read. Each is a compile error at every affected call site rather than a silent
  change of behaviour, which is why they are being made now: 0.2.0 shipped
  yesterday and the surface is still small enough to correct.

  **`ScopedLogger.log(message, options?)`** — was `log(message, level?,
metadata?)`. Three positionals in an order nobody could recall, and different
  from `Logger.log(message, options?)` for no reason beyond how each grew.
  `ScopedLogOptions` is `{ level?, metadata? }` and is a new root export.

  It deliberately has no `subsystem` and no `correlation`. A scope owns both —
  that is what a scope is — and a call that could override them would let one
  line quietly leave the unit of work every other line belongs to. Use
  `Logger.log` for a different subsystem, or nest a `scoped()` for a different
  correlation. The six level methods are untouched: `info(message, metadata?)`
  had no ambiguity worth fixing. A JavaScript caller who misses the change and
  passes a level string gets the default level and a delivered message, rather
  than a level read out of an object that is not one.

  **`scopeMetadata` is off `LogOptions`.** It was never something a caller should
  set: it is a scope's own defaults, it loses every collision with `metadata`,
  and it is validated one step more weakly, so passing it directly bought nothing
  over `metadata`. It now lives on an unexported `InternalLogOptions` that only
  `ScopedLogger` imports.

  `logMessage` still reads that field at runtime, off whatever object it is
  handed — removing a field from a TypeScript interface removes nothing from a
  JavaScript build — and that is deliberate: the redaction path must treat
  whatever arrives there as caller data. The ESLint rules go on checking it for
  exactly that reason, and are now the only thing that would notice a patient
  name in it. The plugin's model is pinned against both interfaces so a future
  edit cannot quietly shrink it.

  **The raw sinks left the root.** `createFileSink`, `createNativeConsoleSink`,
  `FileSink` and `NativeConsoleSink` are now only at
  `react-native-nitro-logger/unstable`. Most callers want
  `createFileDestination()` instead; a caller that genuinely wants the layer
  below a destination changes one import line and gets, at that line, the
  documentation for what that layer does not do.

  **The six spec result interfaces are `readonly`.** `RotationConfig`,
  `SinkStatus`, `AppendResult`, `FlushOutcome`, `ClearOutcome` and
  `CollectOutcome` — what the native calls hand back. Nitrogen's generated tree
  is byte-identical with the annotations applied, verified by regenerating and
  diffing, so this is a TypeScript-side statement only and no native change. It
  is also erased at runtime: these are ordinary mutable objects crossing the
  bridge, which is why the test proving two failed collects do not share one
  outcome object still mutates through a cast, and says why in place.

- 391df18: `createFileDestination(options?)` and `createNativeConsoleDestination(options?)`
  — the ordinary way to build a destination on the real native sink — plus a new
  `react-native-nitro-logger/unstable` entry point for the raw sinks underneath
  them.

  `new FileDestination(createFileSink(), options)` said the same thing while
  making a caller name a type it had no other reason to hold. The factories say
  it once. Both throw rather than degrade: a missing native module, a failed
  open, or a config conflict with a writer already open on that path. The
  constructors stay public, because driving a destination with a `FileSinkLike`
  double is how it is tested and substituting your own implementation is a
  legitimate thing to want.

  `createFileSink` and `createNativeConsoleSink`, with the `FileSink` and
  `NativeConsoleSink` types, now live at `react-native-nitro-logger/unstable`
  and are no longer root exports — see the breaking-changes entry. There is still
  exactly one place each hybrid-object name is spelled, and a test walks `src/`
  to prove it: those two strings fail at runtime on a device and nowhere
  earlier.

  The separate entry point is a warning about stability. It does not make the
  raw sinks safe, and the hazard has nothing to do with stability: a raw
  `clearLogs()` bumps the writer generation, which makes **every**
  `FileDestination` on that file stale, including ones the caller has never heard
  of. Nothing notifies them — each finds out when it next tries to write, has the
  append rejected as a stale generation, fences itself and loses that record, and
  reports `isEnabled: false` from then until something calls `reopen()`. Purge
  through the destination when you have one.

  `RotationConfig`, the `*Like` seams and the native call-result types stay at
  the root, because a `FileSinkLike` implementation has to construct them.

  The export-map entry mirrors the root's, including the source condition the
  example app resolves through and the `default` that Metro falls through to —
  `check-package-exports.sh` now proves the subpath resolves for `require`,
  `import`, a React Native app's Jest and both of Metro's condition sets, and
  that every built artifact actually declares the two names. The API-reference
  gate parses both barrels, and a new test holds its list of them against the
  export map in both directions, so a third entry point cannot be added without
  being documented.

- b21c47e: New exports for reading a degradation mask and for writing a custom
  destination: `describeDegradation(mask)`, the six `DEGRADED_*` bits,
  `levelAtLeast(level, minimum)`, `LEVEL_ORDER`, and `PRIVATE_PLACEHOLDER`.

  `FileDestination.degradation()` has always returned a bitmask, which is the
  right shape to send across a bridge and an awkward one to hold — `if (mask & 4)`
  is unreadable at the call site and unverifiable in review. The six bits now have
  names, and `describeDegradation` turns a mask into a frozen array of the ones
  set: `[]` when healthy, `['prune', 'exclusivity']` for `0x24`. A bit this build
  has no name for is ignored rather than reported, so a newer native paired with
  an older JavaScript bundle degrades to naming what it knows instead of
  inventing a string or throwing in the middle of diagnostics.

  `levelAtLeast` and `LEVEL_ORDER` are what a destination needs to filter by
  severity: `LogLevel` is a string, and `'warning' >= 'error'` is a
  lexicographic answer to a question nobody asked. `PRIVATE_PLACEHOLDER` is the
  exact string redaction substitutes, exported so a destination can recognise it
  without transcribing the literal. It does not tell you a field _was_ redacted —
  by the time an entry reaches a destination the placeholder is an ordinary
  string, indistinguishable from one a caller set to that text on purpose.

  `LEVEL_TAG` and `LEVEL_NAME` are deliberately still internal. They are the
  fixed-width tags and uppercase names the formatters emit for byte-parity with
  SwiftLogger — a wire format that happens to live in the same file, not API.

  The four places the degradation bits are written down — this module, both
  native writers, and the table in `docs/API.md` — are now held together by
  `__tests__/degradation.test.js`, which reads all four and fails if any disagrees
  about a name or a value. It pins the numbers, not the meanings: that all four
  agree `sidecar` is `1 << 3` says nothing about when a writer raises it.

- 546c9a9: `FileDestination.deleteSupportBundle(deadlineMs?)` — the third step of a
  support flow.

  The flow is **collect → upload → delete**, and until now it stopped at two.
  `collectForSupport` writes a gzipped copy of the whole log beside the log
  files, and nothing reclaimed it: the retention sweep deliberately keeps a
  _finished_ bundle, because somebody may still be uploading it, so the copy sat
  outside the rotation budget the app configured until a `purge()` or the next
  collect happened to replace it. On a device holding regulated data that was the
  one artifact retention never came back for, and the app had no way to remove it
  short of deleting everything.

  This deletes exactly the bundle and its two staging leftovers — the half-written
  `.part` and the `.member` scratch a plaintext source is compressed into, both of
  which hold log bytes — through the same `supportName` / `supportStagingName` /
  `supportMemberName` helpers `isArtifactName` is built from, so the two lists
  cannot drift apart. It is not a smaller `purge()` and deletes no log file; the
  Swift and Kotlin tests assert the file list is unchanged across the call, and a
  mutant that swept by `isArtifactName` instead — which is what a purge does —
  turns that assertion red on both platforms.

  `true` means no bundle artifact remained when the call ran, including vacuously
  for a sink that never opened. That is a statement about an instant and not a
  promise about the next one: a collect started afterwards writes a new bundle,
  and sequencing the two is the caller's job. `false` is the whole of the rest and
  deliberately not a list of causes — refused, timed out, threw, or absence could
  not be _durably_ confirmed — and it asserts nothing about what survived, since a
  refusal never looked. Read it as "assume a copy may still be there".

  Absence is success — deleting a bundle that is already gone is the outcome the
  caller asked for, and only `ENOENT` on iOS / `Presence.ABSENT` on Android counts
  as absent, so a directory that has stopped answering reports a survivor rather
  than a clean sweep.

  A fenced or disposed destination refuses. The first draft of this let a disposed
  one delete, reasoning from `getLogFilePaths()` still answering after `dispose()`
  — and review caught that the analogy is backwards. Reading a directory this
  object no longer owns is harmless; deleting from it is not. With the handle gone
  there is no writer generation left to check, so another destination may own that
  path and be part-way through publishing into it, and the `.support.gz` removed
  would be _its_ bundle, whose path it has already handed to a caller. Delete
  before disposing, or through a fresh destination on the same path — both give a
  live handle on a current generation, which is what makes the deletion safe
  rather than merely willing.

  **Liveness is not currency, and the same review caught that too.** The registry's
  gates (`isLive`, `liveGeneration()`) say a handle is _active_; they do not say it
  is _current_, which is why `appendBatch` has always passed its generation down
  for the writer to check. Deletion now does the same, and the check runs on the
  writer's own queue immediately before the unlinks rather than at the call site —
  so a purge that lands while the task waits its turn is seen. A stale append adds
  a record to somebody else's file; a stale delete removes somebody else's bundle.
  Both platforms have a test where a sibling purges and then collects, and the
  handle left behind — never closed, so every liveness gate says yes — is refused
  and the current generation's bundle survives. A mutant dropping the check turns
  that test red on both.

  **A timed-out delete is abandoned, not merely unreported.** This was found by
  the test rather than designed in: the first version left its queued unlink in
  place, and the race test caught it reaching the front of the writer's queue
  _after_ a slow build published — deleting a bundle a later collect had just
  handed back the path of, seconds after the call that returned "I deleted
  nothing". The fix is the barrier `CollectHandoff.giveUp` already puts in front
  of a publish, pointed the other way: the caller marks its own request abandoned
  under a monitor before returning `false`, and the queued task asks whether it is
  still wanted before it unlinks anything. Both platforms; a mutant that ignores
  the flag turns the race test red on both. The window that stays open is the
  terminal one — a task already past that check runs to completion, so a caller
  can be told `false` about a deletion that then happens — which is safe in the
  direction it fails (a retry says `true`) and cannot take a later bundle, because
  the queue is serial and any subsequent publish is a later task.

  The Nitro spec gains one method, and `nitrogen` regenerated additively: 42
  inserted lines, nothing removed or reordered.

  **On running new JavaScript against an older native binary.** The 0.2.0 review
  left this unverified and warned it could differ by platform. It cannot, and the
  reason is structural: the method table is registered by
  `nitrogen/generated/shared/c++/HybridFileSinkSpec.cpp`, one shared translation
  unit compiled into both platforms' binaries, so iOS and Android cannot disagree
  about which methods a prototype has. Construction is unaffected —
  `NitroModules.createHybridObject('FileSink')` passes a name and nothing else,
  with no JS-side spec to check a shape against, and TypeScript types are erased
  by then. So a 0.2 binary should yield a working sink whose prototype simply has no
  `deleteSupportBundle`; the call should fail at invocation, inside the wrapper's
  own `try`, and the caller should get `false`.

  **That is now measured rather than reasoned.** Both platforms were run with 0.3
  JavaScript over a native binary built from the `react-native-nitro-logger@0.2.0`
  tag — a pristine consumer app on RN 0.85, the library installed from a 0.2.0
  `yarn pack` tarball, and the run refused to start unless the compiled spec did
  _not_ register the method and the JavaScript about to load _did_ contain the
  wrapper. The probe made three calls: construct, invoke the missing method, and
  then a method 0.2 does register, the last of these as a control so that "the
  call failed" could not be satisfied by a sink that never worked at all.

  |         | construct | `deleteSupportBundle` | control               |
  | ------- | --------- | --------------------- | --------------------- |
  | iOS     | ok        | returned `false`      | flush durable, 1 file |
  | Android | ok        | returned `false`      | flush durable, 1 file |

  Identical on both, which is what the shared `HybridFileSinkSpec.cpp` predicted.
  The delivery differed by platform and is worth stating: iOS ran a Release build
  with `main.jsbundle` replaced inside the built `.app`, Android a Debug build
  with Metro serving the new JavaScript. Neither rebuilt native code.

  Two things this does not say. It is a statement about the **native** boundary
  only — 0.3 also carries four breaking JavaScript changes, listed above, so an
  app shipping 0.3 JS over a 0.2 binary still has to fix its own call sites, and
  the preflight caught exactly that when its first probe imported `createFileSink`
  from the root export 0.3 removed. And it is one nitro-modules version (0.36.3)
  on one RN version (0.85.0) on a simulator and an emulator; a different Nitro
  could resolve an unregistered method differently, and nothing here constrains
  that.

- f1613d8: ESLint: a logger bound from a factory is no longer silently exempt

  `classifyReceiver` resolved a binding's initializer and returned whatever
  that produced, `null` included. So a binding whose initializer the analysis
  could not see through was classified as "not a logger", and all four rules
  went quiet at every call on it.

  The spelling this hits is the ordinary one:

  ```js
  const Log = useLogger();
  Log.info(`patient ${patient.mrn} admitted`);
  ```

  Canonical name, real logger, PHI in a template literal, and not one
  diagnostic — because a hook is a call the analysis cannot follow. An
  unresolvable initializer now falls through to the name heuristic, which is
  what `shared.js` already said it does: "a receiver that merely _might_ be a
  logger is `'ambiguous'`, not discarded."

  The widening is to `'ambiguous'`, never `'logger'`. Provenance is the
  difference: what comes out of an opaque factory may behave like the
  singleton, but nothing establishes that it _is_ the singleton, and
  `no-derived-correlation` must not assume it.

  A `null` from a _construction_ still ends the classification. `new Widget()`
  is a decision — the callee was examined and found not logger-shaped — where
  `useLogger()` is only a shrug, and conflating them would have made the
  `loggerClassNames` option stop narrowing anything.

  **This reports code that lints clean today.** A codebase getting its logger
  from a hook, a factory, a conditional or a property read will see new
  diagnostics on lines that were never examined before. They are not new
  violations; they are violations that were always there and never looked at.
  Each is fixable the usual way — a literal message with the value in
  metadata — and `loggerNames` narrows what counts as a logger name if a
  binding is being matched that should not be.

- cab47a8: `FileDestination.reopen(deadlineMs?)` — the way back from a fence.

  A fence is permanent by design, and until now it was permanent in practice.
  `purge` promised "disabled until an explicit retry" in two separate comments
  and there was no retry to make: a destination fenced by _another_ handle's
  purge, or by a purge that deleted durably and could not reopen afterwards, was
  dead for the life of the process. Constructing a replacement is a poor
  substitute rather than an impossible one: on the same canonical path a second
  handle is eligible to share the writer when the rotation policy and framing
  match, differing ones are a config conflict, and matching them is no promise of
  success either — an acquisition still fails on a previous writer that is still
  closing, or on the filesystem, or on the lock. Whichever way it goes, the
  fenced destination is still alive, holding its retain on the writer and its
  registration with whatever logger it was given to, until someone disposes it.

  `reopen` closes this handle and opens a fresh one with the same path, rotation
  and framing it was constructed with, and returns whether the destination can
  write when the call returns. Disposed returns `false` and stays disposed, since
  dispose is a release and not a pause. Unfenced returns `true` having touched
  nothing — closing a live handle to prove it could be reopened would throw away
  the buffer and the file position for a question already answered. A failed open
  leaves it fenced, exactly as dead as it was; a failed close does not, because
  there was nothing drainable behind a fence and the open is what decides.
  `deadlineMs` bounds the close, the only half that waits.

  What `true` does not claim: that the file behind the new handle holds what the
  old one wrote. After another handle's purge it is a fresh, empty file, which is
  the purge working. The new file does not open with a loss notice about the old
  one either — the fence clears what was owed on the way in, because a count of
  deliberately deleted records describes the deletion, and a fenced destination
  accepts nothing afterwards to accumulate a new one.

  The retained rotation config is now a frozen **copy** taken at construction
  rather than the caller's object. A caller that goes on mutating what it passed
  would otherwise have its reopen acquire a policy the first open never used —
  and because the registry compares policies to decide whether two handles may
  share a writer, a drifted one is not a quiet difference but a config conflict
  against a sibling handle that is still open.

  No spec change: `open` and `close` were already on `FileSinkLike`, and the
  config was already retained — its comment named a native registry reacquisition
  path that does not exist, and now names this.

- 5130b7b: `Logger.flush(deadlineMs)` is now one **total** budget rather than an allowance
  each destination gets.

  A caller asking for 2000 with three destinations registered could previously
  block the JavaScript thread for six seconds — the number they passed multiplied
  by a count they may not control, since adding a destination anywhere in the app
  lengthened every flush in it. The number now means what it says.

  Two consequences worth knowing before you upgrade:

  - **Registration order is load-bearing.** Destinations are flushed in the order
    they were added and each is handed what the ones before it left, so a
    destination added later can find the budget spent. Register the one whose
    durability matters most — normally the file sink — first.
  - **An exhausted budget does not skip.** Every destination is still asked, with
    `0`. `flush(0)` drains whatever needs no waiting, and skipping would be a new
    way to lose records on the crash path this method exists for.

  The bound stays cooperative: a destination that ignores its deadline still
  blocks.

- cd0e3bd: A destination that fails five writes in a row is cut off, and until now an app
  had no way to find that out or undo it.

  The only signal was a development-only `console.warn`, so in a shipped build a
  destination could stop receiving records permanently and silently. `Logger` now
  answers both questions.

  `destinations()` returns a frozen array of frozen `{ label, enabled }` rows —
  the new `DestinationStatus` type — in registration order. Two fields, on
  purpose: anything more would have to come from the destination's own getters,
  and a failure _count_ would invite callers to build a policy on top of a
  threshold this logger owns.

  `enabled` reports the circuit breaker and only that. It is deliberately **not**
  the destination's own `isEnabled`, which is caller-supplied and untrusted — a
  throwing getter would break a diagnostics call, and a lying one would report
  healthy for something the logger stopped writing to. So `enabled: true` is not
  a promise that records are arriving: a destination that reports
  `isEnabled: false` about itself is skipped by the write path and still appears
  here as `enabled`, a fenced `FileDestination` being exactly that, because from
  the logger's side nothing has gone wrong. The label is the one captured at
  registration, so a destination whose label getter later starts throwing still
  appears under the name this logger knows it by.

  Re-arming is `addDestination(theSameInstance)`. That call previously returned
  immediately having done nothing at all, which made "I have fixed it, try again"
  the one gesture with no effect; it now clears the failure count and the
  disabled mark. It still does not flush or dispose — that is the same-label
  replacement path, and an instance handed back is not a replacement — and it
  still does not re-read the label getter, so the capture-once invariant holds.

  There is deliberately no `enableDestination(label)`: reviving by name would let
  code that does not hold the destination re-arm it, and holding the instance is
  the evidence that the caller is the one who fixed it.

- 5130b7b: `ScopedLogger.scoped()` takes an optional `correlation` and inherits the parent
  scope's when it is omitted.

  That is the opposite of `Logger.scoped()`, which generates a fresh one, and both
  are right for the same reason: a correlation ID names a unit of work.
  `Logger.scoped()` starts one; a scope nested inside it is that same unit of work
  seen closer up, so a new ID there severs the trail at exactly the point somebody
  reading the logs is trying to follow it. Pass one explicitly to start a
  genuinely separate unit from inside an existing scope.

  Purely additive — the argument was required and every existing call still
  compiles and behaves identically.

  `ConsoleDestination.flush(deadlineMs?)` also names its parameter now, matching
  `LogDestination`. It remains a no-op; `console` writes synchronously.

### Patch Changes

- d1b721a: Two fixes on the paths that touch caller data: correlation IDs are drawn from
  the platform's random source where there is one, and a scope's metadata
  snapshot now applies the key rule before it reads a value.

  **`newCorrelationId()` prefers `crypto.getRandomValues`.** Resolved on first
  successful use rather than decided at import — on React Native a `crypto`
  polyfill routinely installs during startup, after this module is first
  imported, and a logger that chose once would spend the rest of the process on
  `Math.random` with nothing indicating why. A source that later throws is
  evicted, so a replacement is picked up. `Math.random` remains the fallback and
  always answers: an ID names a unit of work, and failing the call that asked for
  one fails whatever was being logged.

  Read that as hardening rather than a leak fix. The privacy requirement on a
  correlation ID is provenance — that it was generated, not derived from a
  patient or record identifier — and `Math.random` satisfied that completely.
  What changes is same-session predictability.

  **A scope's metadata no longer reads a value behind a key that cannot survive
  redaction.** `redactMetadata` was careful never to run a getter behind a
  malformed or reserved key, and then `safeSnapshotMetadata` ran it anyway, at
  construction. A scope built with a `patient.name` getter fired it on
  `logger.scoped(...)`, before any message was logged, so neither level filtering
  nor redaction could prevent it. The key is still kept and still counted in
  `droppedMetadataCount` — only the read is skipped.

  The catalog check deliberately stays at emit and cannot move: `metadataKeyCatalog`
  intersects at any time, so a key approved when a scope was built can be
  unapproved by the time it emits. The honest form of the guarantee, now written
  where the old one was: a getter behind a malformed or reserved key never runs;
  a getter behind an unapproved key runs once, at construction, and never again.

- 5130b7b: Deadlines: `Infinity` now means the 30-second ceiling on the JavaScript side
  too, and every bounded wait is measured against a monotonic clock.

  **`Infinity` reached the two sides of the bridge differently.** Both native
  writers already clamped an infinite deadline to their 30-second ceiling, while
  the JavaScript clamp turned it into `0` — so `FileDestination.flush(Infinity)`
  waited nothing on this side and up to thirty seconds on the other. The
  JavaScript side now answers the way the natives do. If you were passing
  `Infinity` to `Logger.flush` or `FileDestination.flush` and relying on it
  returning immediately, pass `0`, which has always meant that.

  **Elapsed time is no longer read from the wall clock.** A deadline was the
  difference between two `Date.now()` readings, which is not a stopwatch: an NTP
  step or a manual clock change landing mid-flush could hand the rest of the call
  backwards time — an hour-backwards correction turning a 2-second bound into an
  hour-and-two-second block on the JavaScript thread, a forwards one ending the
  flush before it drained anything. `Logger.flush` and the file destination's
  bounded drain now read `performance.now()` where the host provides one, falling
  back to `Date.now` where it does not. Every runtime this library supports —
  Hermes, JSC, and Node under the tests — provides one.

- 747721c: Records the buffer has already refused are no longer formatted first.

  Formatting is the expensive half of writing a log line. Under sustained
  backpressure — a burst outrunning the sink, or a wedged writer — every record
  was rendered in full and then dropped, which is the one situation where the
  work is guaranteed to be wasted. `FileDestination.write` now asks
  `Batcher.hasRoom()` before it renders.

  `hasRoom()` is deliberately conservative, and the asymmetry is its contract.
  `false` means _no_ record of any size fits: the buffer is at its entry cap, at
  or past its byte cap, or there is nowhere to write at all. `true` is not a
  promise that this particular record fits, because that needs a length only
  rendering can produce — so a record can still be admitted, rendered, and then
  dropped by `add` with its bytes counted exactly. What cannot happen is a
  `false` that turns away a record which would have been accepted.

  **Behaviour change for a stateful formatter.** `LogFormatter.format` is now
  called for fewer entries, so a formatter that carries state across calls — one
  stamping an incrementing sequence number, say — produces a different sequence
  than it did in 0.2.0. That contract was unstated and is now written down:
  being formatted is not being written, in either direction — entries are
  formatted and still lost (a full buffer, a rejected batch, a fence tripped
  mid-flight) and entries are dropped by a level filter without ever being
  formatted — so a formatter's call history has never matched the file's lines. A
  formatter must not carry state that later records depend on. Three tests pin
  which entries reach a formatter, so the shape is checkable rather than
  folklore.

  **`LossCounts.bytes` is now a lower bound**, and this is the other price. It counts
  the bytes of records that were rendered and then dropped; a record refused
  before rendering has no length to report and adds `0`. `LossCounts.entries`
  stays exact — every dropped record is still counted once, still owed a notice,
  and the notice still names the right number. Alert on `entries` and read
  `bytes` as the floor it is. The alternative was rendering every record purely
  to produce an exact byte total for the ones being thrown away, which is the
  cost this change exists to avoid.

  `LossCounts.entries` was also stated more carefully. It is exact for what the
  pipeline accepted, and it deliberately does not count a record handed to a
  fenced or disposed destination: the `isEnabled` guard turns that away before
  anything accepts responsibility for it, so nothing owes a notice for it.

  Also documented rather than changed: `BatcherOptions.renderNotice` is required
  and stays required, because a default would have to write JSON Lines into a
  file whose formatter may be anything else; and `maxBatchBytes` (256 KiB, the
  ceiling on one handoff to the sink) is distinct from `batchBytes` (4 KiB, the
  size at which a drain is triggered).

- 24d9bfb: Every record that reaches the file was being measured twice, and most of them
  were being measured the slow way.

  `FileDestination` has to compute a record's UTF-8 length to enforce
  `maxEntryBytes`, and then handed the record to `Batcher.add`, which computed it
  again to do its own byte accounting — two full passes over every log line.
  `add(record, recordBytes?)` now accepts the count the caller already has. The
  argument is optional and purely an optimisation: omit it and the batcher
  measures for itself, and a differential test drives the same corpus both ways
  and compares what the batcher _does_, not what it was told. A supplied value
  is trusted as an exact measurement — a value that could not be a length at all
  is recomputed, but a plausible wrong number is believed, and detecting one
  would mean measuring, which is the thing being avoided.

  `utf8Length` also gained a fast path for the leading run of ASCII, which is
  nearly all of most log lines — it skips the run and adds its length, instead of
  adding one per character. Where the run ends, the general loop resumes from
  exactly that index.

  Neither change moves a byte. The `JsonLinesFormatter` golden fixtures, which
  are byte-locked against SwiftLogger, ran unmodified throughout, and
  `utf8Length` now has a differential suite against the platform's own
  `TextEncoder` over four-byte sequences, unpaired surrogates, and every position
  of the ASCII/non-ASCII boundary in a fixed-length string.

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
