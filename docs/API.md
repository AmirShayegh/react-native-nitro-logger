# API reference

Every export of `react-native-nitro-logger`, grouped by what it is for. The
README is the guided tour; this is the index.

Signatures are the real ones. Where behaviour is subtle — and in a logger most
of the subtlety is in failure paths — this points at the document that explains
it rather than restating it badly: [PRIVACY.md](PRIVACY.md) for the redaction
contract, [PARITY.md](PARITY.md) for where the two native writers differ.

- [Logging](#logging)
- [Privacy](#privacy)
- [Destinations](#destinations)
- [Formatters](#formatters)
- [Integrations](#integrations)
- [Native sinks](#native-sinks)
- [Utilities](#utilities)

---

## Logging

### `Log`

The shared `Logger`. A module singleton, because a logger that has to be passed
down to be useful ends up not being used at the layers that need it most.

<!-- api: Log -->

### `Logger`

| Method | Returns | What it does |
| --- | --- | --- |
| `verbose(message, metadata?, subsystem?)` | `void` | Emit at that level. `message` is a string or a `LazyMessage`. |
| `debug(…)` · `info(…)` · `warning(…)` · `error(…)` · `todo(…)` | `void` | Same shape. |
| `log(message, options?)` | `void` | The general form; takes `LogOptions` instead of positional arguments. |
| `logMessage(message, options?)` | `void` | What `log` delegates to. Covered by the ESLint rules for the same reason `log` is. |
| `minimumLevel(level)` | `this` | Global floor. |
| `subsystem(name, level)` | `this` | Per-subsystem floor, which overrides the global one. |
| `resetSubsystem(name)` | `this` | Drop a per-subsystem floor. |
| `privacyDefault(value)` | `this` | `'public'` or `'private'`. First call wins, and later calls may only tighten. |
| `redactAllMetadata()` | `this` | Redact every value regardless of marker. Not reversible. |
| `metadataKeyCatalog(keys)` | `this` | Approve key names. Calls intersect; one bad key approves none. **Mandatory under `'private'`** — see [PRIVACY.md](PRIVACY.md#metadata-keys). |
| `consoleLogging(enabled)` | `this` | Toggle the built-in console destination. |
| `addDestination(destination)` | `this` | Register. Labels are unique; re-registering a label replaces. |
| `removeDestination(label)` | `this` | Unregister and dispose. |
| `flush(deadlineMs?)` | `void` | Ask every destination to flush. Returns nothing — see the note below. |
| `newCorrelationId()` | `string` | A fresh ID, generated rather than derived. |
| `scoped(correlation?, subsystem?, metadata?)` | `ScopedLogger` | Omit `correlation` and one is generated. |

`flush()` deliberately returns `void`. Whether bytes reached disk is a question
only the file sink can answer, so ask it: `FileDestination.flush(deadlineMs)`
returns a `BatchFlushOutcome` with `durable` on it.

`metadataKeyCatalog` is tighten-only and implements that by **intersecting**:
the second call keeps only the keys the first one also approved and can never
add one back, so two calls naming two different groups approve their overlap
rather than their union. The list is validated as a whole, too — one entry that
is not a string or does not match `^[A-Za-z0-9._-]{1,64}$`, or an argument that
is not iterable at all, approves *nothing* instead of skipping the bad entry.
Call it once, from the entry point, with every key the app logs under. Both
mistakes are otherwise silent under `'private'`, so a development build warns
when a call leaves fewer keys approved than it found, or when the first call
approves none — counts only, never the key names themselves.

<!-- api: Logger -->

### `ScopedLogger`

Carries a correlation ID, an optional subsystem, and optional default metadata
into every call. Same six level methods as `Logger`, minus the `subsystem`
argument, since a scope already has one. `scoped()` nests, and a nested scope
inherits what it does not override.

Its default metadata goes through the same redaction path as call-site
metadata, and the ESLint rules read both.

Constructing one directly — `new ScopedLogger(logger, correlation, subsystem)` —
is equivalent to `logger.scoped(correlation, subsystem)` and is linted the
same way: the correlation and subsystem arguments are the same two channels
the runtime cannot redact, and the rules check them in either spelling. That
was not true before 0.1.2, when only `scoped()` was recognised and the
constructor reported nothing.

<!-- api: ScopedLogger -->

### `LogOptions`, `LazyMessage`, `LogLevel`, `LogEntry`

`LogLevel` is `'verbose' | 'debug' | 'info' | 'warning' | 'error' | 'todo'`.

`LazyMessage` is `string | (() => string)`. The function form is not evaluated
if the entry is filtered out by level, which is the point of it.

`LogEntry` is what a destination receives: level, message, timestamp,
correlation, subsystem, and already-redacted `metadata`. By the time an entry
reaches a destination, privacy has already been applied — a destination cannot
un-redact, and is not trusted to.

<!-- api: LogOptions, LazyMessage, LogLevel, LogEntry -->

---

## Privacy

Read [PRIVACY.md](PRIVACY.md) for the contract. This is the surface.

### `pub(value)` · `priv(value)`

Mark a metadata value public or private, overriding the ambient default.
`value` must be a `LogPrimitive` (`string | number | boolean`); anything else
fails closed and the entry is dropped rather than rendered.

Both return an opaque marker. There is no unwrap function, and that is
deliberate: payloads live in module-private `WeakMap`s, so `JSON.stringify`,
`String()`, spreading and console inspection all yield the placeholder.

<!-- api: pub, priv -->

### Constants

| Export | Value | Why it is public |
| --- | --- | --- |
| `METADATA_KEY_PATTERN_SOURCE` | `'^[A-Za-z0-9._-]{1,64}$'` | The key rule as a string, so an app can validate its own catalog with the same pattern the runtime uses. |
| `DROPPED_COUNT_KEY` | `'droppedMetadataCount'` | The key the count of rejected entries arrives under. Injected after filtering, so it can never itself be dropped. |
| `MAX_CATALOG_SIZE` | `4096` | Upper bound on catalog size, so a hostile or accidental infinite iterable cannot hang startup. |
| `UNREADABLE_VALUE` | opaque | Stands in for a value that could not be read — a getter that threw while a scope was being built. |

<!-- api: METADATA_KEY_PATTERN_SOURCE, DROPPED_COUNT_KEY, MAX_CATALOG_SIZE, UNREADABLE_VALUE -->

### `PrivacyDefault`, `PublicValue`, `PrivateValue`, `LogPrimitive`, `LogValue`, `LogMetadata`, `RedactedMetadata`

`LogValue` is `LogPrimitive | PublicValue | PrivateValue` — what you may pass.
`RedactedMetadata` is `Readonly<Record<string, LogPrimitive>>` — what a
destination gets, after markers are resolved and rejected keys removed.

<!-- api: PrivacyDefault, PublicValue, PrivateValue, LogPrimitive, LogValue, LogMetadata, RedactedMetadata -->

---

## Destinations

`LogDestination` is the interface: `label`, the optional `minimumLevel`,
`isEnabled`, `write(entry)`, `flush(deadlineMs?)`, `dispose()`. Implement it to
add your own.

`minimumLevel` is a per-destination floor, and the `Logger` applies it *before*
evaluating a `LazyMessage` — so a destination that declares one does not pay for
messages it will not write. Omit it and the destination sees everything the
global and per-subsystem floors let through.

### `ConsoleDestination`

`console.log` with `DefaultFormatter`. Options: `minimumLevel`, `formatter`.

Levels are routed rather than all printed the same way: `error` and `todo` go
to `console.error` and `warning` to `console.warn`, so LogBox surfaces them in
development. `flush` is a no-op — `console` writes synchronously, so there is
nothing buffered to wait for.

<!-- api: ConsoleDestination, LogDestination -->

### `FileDestination`

The durable one. Rotation, gzip, retention, crash-tail recovery, bounded
buffering, and a deadline-bounded purge.

```ts
import { FileDestination, createFileSink, JsonLinesFormatter } from 'react-native-nitro-logger';

const logFile = new FileDestination(createFileSink(), {
  formatter: new JsonLinesFormatter(),
  rotation: {
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxArchivedFilesCount: 5,
    compressArchives: true,
  },
});
```

| Member | Returns | Notes |
| --- | --- | --- |
| `filePath` | `string` | The active file. |
| `isEnabled` | `boolean` | False once disposed or fenced. |
| `lineFramed` | `boolean` | Whether the formatter opted into crash-tail trimming. |
| `flush(deadlineMs?)` | `BatchFlushOutcome` | `durable` says whether it reached disk. |
| `purge(deadlineMs?)` | `PurgeOutcome` | The compliance path. See below. |
| `getLogFilePaths()` | `string[]` | Active file first, then archives. Still answers after `dispose()`. For a consent-gated support upload. |
| `unreportedLoss()` | `LossCounts` | Entries and bytes lost that no `flush` result has reported yet. |
| `degradation()` | `number` | Bit mask; `0` is healthy. Rotation, prune, sidecar, gzip and protection each have a bit. |
| `dispose()` | `void` | Releases the native handle. |

`PurgeOutcome` reports `durable` (every pre-purge artifact is gone) separately
from `rebound` (the destination is writable again), because a complete deletion
can still be followed by a failed reopen, and a caller that resumed on
`durable` alone would write into a destination with nowhere to put anything.
It also carries `deletedCount`, `failedPaths`, and `discardedEntries` with
`discardedBytes` — buffered records thrown away by the purge, plus earlier
losses whose counts no `flush` result will now report, since the destination
they were queued for no longer exists. Two numbers rather than one because a
retention or upload budget is measured in bytes and an alerting threshold
usually is not.

**`purge()` after `dispose()` returns `durable: false`.** A disposed
destination cannot see the files, so it cannot honestly claim they are gone.

`FileDestinationOptions`, beyond the common `label`/`minimumLevel`/`formatter`:
`path`, `rotation`, `maxEntryBytes`, `batchBytes`, `flushIntervalMs`,
`maxPendingEntries`, `maxPendingBytes`, `watermarkBytes`.

<!-- api: FileDestination, FileDestinationOptions, PurgeOutcome -->

### `NativeConsoleDestination`

os_log and logcat. Best-effort by design — no backpressure, because os_log
never blocks on a disk. `dropped()` returns entries lost to the buffer ceiling
or a throwing sink; `isEnabled` goes false after three consecutive native
failures. `NativeConsoleDestinationOptions` adds `subsystem`, `category`,
`batchSize`, `flushIntervalMs` and `maxPendingEntries` to the common three; the
README section tabulates them with their defaults.

`category` becomes the logcat tag on Android, where it shares one entry with
the message: it is capped at 256 bytes, and a category past ~200 bytes shortens
each entry's message rather than costing its tail. Bytes there are counted as
JNI encodes them — modified UTF-8, so an emoji costs six — not as
`toByteArray()` would. On iOS the category is a field of the `os_log` object
and costs the message nothing. `docs/PARITY.md` has both rows.

<!-- api: NativeConsoleDestination, NativeConsoleDestinationOptions -->

---

## Formatters

`LogFormatter` is
`{ framing?: 'line'; format(entry): string; formatWithin?(entry, maxBytes): string }`.

Declaring `framing: 'line'` is a promise that one entry renders as one
LF-delimited record, which is what lets the native writer trim a torn record
after a crash. It is a promise about `\n` and about nothing else:
`JsonLinesFormatter` passes U+2028, U+2029 and the C1 range through as
themselves, for byte parity, so a reader has to split on LF and parse each
record *before* any line-oriented presentation logic —
[PARITY.md](PARITY.md) states that obligation in full. A formatter that
declares `framing` and then emits a `\n` breaks recovery, so declare it only if
it holds.

`formatWithin` is optional, and is how a formatter sheds content to fit a
UTF-8 byte budget *structurally* — dropping whole fields, truncating one at
code-point boundaries — so the result is still well-formed in that format. Best
effort: it may come back over budget, since a record has a floor below which it
identifies nothing, and the caller measures rather than assumes. A formatter
that omits it is never sliced to fit — an entry over the destination's
`maxEntryBytes` is replaced whole by a fixed notice, because cutting a rendered
record to length is how a log file stops being parseable.

### `JsonLinesFormatter`

The file default. One JSON object per line, asserted byte-identical to
SwiftLogger's `JSONLogFormatter` over a generated corpus, at the revision
[PARITY.md](PARITY.md) pins. `JsonLinesFormatterOptions` carries one field,
`timestampStyle`, being `JsonTimestampStyle` = `'iso8601' | 'epochSeconds'`.

<!-- api: JsonLinesFormatter, JsonLinesFormatterOptions, JsonTimestampStyle -->

### `DefaultFormatter`

The human-readable one, used by the console destinations. Escapes control
characters and the Unicode line separators in structured fields so a
correlation ID or metadata value cannot forge a log line. The message keeps its
newlines, indented as continuations, because stack traces go through it —
[PARITY.md](PARITY.md) records that as a deliberate difference from SwiftLogger.

<!-- api: DefaultFormatter, LogFormatter -->

---

## Integrations

### `installErrorHandler(options?)`

Logs uncaught errors through the global `ErrorUtils` hook, flushes on fatal
ones, then chains to whatever handler was installed before it. Returns an
idempotent `Uninstall`.

`ErrorHandlerOptions` extends `SanitizeErrorOptions` with `logger`, `chain`,
`subsystem`, `fatalFlushMs` and `errorUtils`. That last one takes an
`ErrorUtilsLike` — the structural shape of React Native's global — so the
handler can be driven in a test without a runtime to install into.

The thrown value is sanitised before it is logged: the message is dropped
outside dev, the class name reduced to a built-in or a fixed token, and frames
reduced to positions in files whose names were already known.

`ERROR_METADATA_KEYS` is the six keys it logs under — spread it into your
catalog rather than transcribing them:

```ts
import { Log as Logger2, ERROR_METADATA_KEYS, installErrorHandler } from 'react-native-nitro-logger';

Logger2.metadataKeyCatalog([...ERROR_METADATA_KEYS, 'requestId']);
const uninstall = installErrorHandler({ subsystem: 'crash' });
```

`UNCAUGHT_ERROR_MESSAGE` is the literal message it uses, exported so a test can
assert on it without hardcoding a string.

<!-- api: installErrorHandler, ERROR_METADATA_KEYS, UNCAUGHT_ERROR_MESSAGE, ErrorHandlerOptions, ErrorUtilsLike, Uninstall -->

### `installRejectionHandler(options?)`

Logs unhandled promise rejections, and — unless you turn it off — logs again
when one that was reported unhandled turns out to be handled after all. Returns
an idempotent `Uninstall`.

**In a release build this is the only way a rejection reaches the log.** React
Native installs a rejection tracker in development and none in production, so an
`async` function that throws with nobody awaiting it is silent in the builds you
ship.

The rejection reason is sanitised exactly as a thrown error is, and for the same
reason: `Promise.reject(new Error(patient.mrn))` is ordinary application code, so
the message is dropped outside dev, the class name reduced to a built-in or a
fixed token, and frames reduced to positions in files whose names were already
known.

`RejectionHandlerOptions` extends `SanitizeErrorOptions` with `logger`, `chain`,
`subsystem`, `logHandledLate` and `tracking`. That last one takes a
`RejectionTrackingLike` — the `enable(options)` shape Hermes and React Native's
polyfill both use, described by `RejectionTrackingOptions` — so the handler can
be driven in a test without a runtime to install into.

The late entry is only written by the handler that reported the rejection in the
first place — an entry retracting something this log never said would be worse
than none — and the ids it remembers are bounded, so a rejection handled after a
few hundred further reports gets no retraction. The failure direction is a
missing one, never a false one.

Two things this does not do. It does not flush: nothing is dying, unlike an
uncaught error, and the next ordinary flush carries these entries out. And it
cannot chain to a tracker somebody else installed — `enable()` replaces the
tracker wholesale and offers no way to read back what was there — so `chain`
links calls to this function and nothing else. Installing it in development
replaces LogBox's rejection popup; the entry still reaches every destination,
console included.

`REJECTION_METADATA_KEYS` is the six keys it logs under. Five are spelled the
same as `ERROR_METADATA_KEYS`, so one catalog entry covers both; the sixth,
`rejectionId`, is the tracker's own counter and joins the two entries about the
same rejection:

```ts
import {
  Log as Logger3,
  ERROR_METADATA_KEYS,
  REJECTION_METADATA_KEYS,
  installRejectionHandler,
} from 'react-native-nitro-logger';

Logger3.metadataKeyCatalog([
  ...ERROR_METADATA_KEYS,
  ...REJECTION_METADATA_KEYS,
]);
const uninstallRejections = installRejectionHandler({ subsystem: 'crash' });
```

`UNHANDLED_REJECTION_MESSAGE` and `REJECTION_HANDLED_LATE_MESSAGE` are the
literal messages it uses, exported so a test can assert on them without
hardcoding a string.

<!-- api: installRejectionHandler, REJECTION_METADATA_KEYS, UNHANDLED_REJECTION_MESSAGE, REJECTION_HANDLED_LATE_MESSAGE, RejectionHandlerOptions, RejectionTrackingLike, RejectionTrackingOptions -->

### `flushOnBackground(options?)`

Flushes when the app backgrounds. Best-effort and deadline-bounded: it returns
an uninstall handle only, so a flush that times out is not surfaced. Use
`FileDestination.flush(deadlineMs)` when you need the answer.

`FlushOnBackgroundOptions` takes `logger`, `deadlineMs` and `appState`, the
last being an `AppStateLike` for the same testability reason as
`ErrorUtilsLike` above.

<!-- api: flushOnBackground, FlushOnBackgroundOptions, AppStateLike -->

### `sanitizeError(error, options?)`

The sanitiser on its own, returning a `SanitizedError` — `name`, `message`,
`frames`, `frameCount`, `framesTruncated`. Useful for reporting a caught error
to your own crash service under the same rules. `SanitizeErrorOptions` tunes
it: `maxFrames` and `bundleNames`, defaulting to the two constants below.

| Constant | Value |
| --- | --- |
| `UNKNOWN_ERROR_NAME` | `'Error'` |
| `REDACTED_FRAME` | `'<frame>'` |
| `REDACTED_MESSAGE` | `'<redacted>'` |
| `NON_ERROR_THROWN` | `'<non-error>'` |
| `DEFAULT_MAX_FRAMES` | `12` |
| `DEFAULT_BUNDLE_NAMES` | the bundle filenames treated as known |

<!-- api: sanitizeError, SanitizedError, SanitizeErrorOptions, UNKNOWN_ERROR_NAME, REDACTED_FRAME, REDACTED_MESSAGE, NON_ERROR_THROWN, DEFAULT_MAX_FRAMES, DEFAULT_BUNDLE_NAMES -->

---

## Native sinks

`createFileSink()` and `createNativeConsoleSink()` construct the Nitro hybrid
objects. Call them once and hand the result to a destination; the destination
owns the handle from then on and releases it on `dispose()`.

`FileSink` and `NativeConsoleSink` are the Nitro interfaces. `FileSinkLike` and
`NativeConsoleSinkLike` are structural equivalents, which is what lets tests
drive a destination without a native runtime — and what lets you substitute
your own implementation.

`RotationConfig` requires `maxFileSizeBytes`, `maxArchivedFilesCount` and
`compressArchives` — all three, since a rotation policy that left any of them
implicit would be guessing on your behalf about retention. Optional:
`maxFileAgeSeconds` (rotate on age regardless of size),
`maxArchiveAgeSeconds` (delete old archives even when under the count cap), and
`maxTotalLogBytes` (a bound on the current file and all archives combined).

`SinkStatus` carries the sink's view of its own health, including the
degradation mask that `FileDestination.degradation()` surfaces.

<!-- api: createFileSink, createNativeConsoleSink, FileSink, NativeConsoleSink, FileSinkLike, NativeConsoleSinkLike, RotationConfig, SinkStatus -->

### Native call results

`AppendResult`, `ClearOutcome`, `FlushOutcome` and `RejectReason` are what the
Nitro sink methods return. Ordinary use never sees them: `FileDestination`
translates each into the type documented above — `AppendResult` into the loss
counts, `ClearOutcome` into `PurgeOutcome`, `FlushOutcome` into
`BatchFlushOutcome`, and `RejectReason` (`'full' | 'staleGeneration' |
'closed' | 'failed'`) into the backpressure that `unreportedLoss()` reports.

They are exported anyway, because a `FileSinkLike` implementation has to
produce them, and something you must construct is part of the API whether or
not you were meant to notice it.

<!-- api: AppendResult, ClearOutcome, FlushOutcome, RejectReason -->

---

## Utilities

Exported because the destinations are built from them and a custom destination
will want the same parts. Not required for ordinary use.

### `Batcher`

The bounded buffer behind `FileDestination`: size and byte ceilings, an idle
flush interval, a high-water mark, deadline-bounded draining, and loss
accounting. `BatchTarget` is what it drains into, `BatcherOptions` configures
it, `BatchFlushOutcome` is what a flush reports, `LossCounts` is what went
missing, and `FenceReason` (`'staleGeneration' | 'closed'`) says why it stopped
accepting writes.

<!-- api: Batcher, BatchTarget, BatcherOptions, BatchFlushOutcome, LossCounts, FenceReason -->

### `utf8Length(text)`

UTF-8 byte length, computed without encoding the string — no intermediate
`TextEncoder`, no allocation. The byte ceilings above are in bytes rather than
characters, and this is what measures them, so batching and console chunking
agree with the sink about how large a payload is. Surrogate pairs count as the
four bytes they encode to, not as the two code units JavaScript stores.

<!-- api: utf8Length -->

---

## Index

Every name this package exports. The list is not decoration: `__tests__/apiReference.test.js`
compares it against `src/index.tsx` in both directions, so an export missing
from here fails the suite, and so does an entry here that no longer exists.

- `AppendResult`
- `AppStateLike`
- `Batcher`
- `BatcherOptions`
- `BatchFlushOutcome`
- `BatchTarget`
- `ClearOutcome`
- `ConsoleDestination`
- `createFileSink`
- `createNativeConsoleSink`
- `DEFAULT_BUNDLE_NAMES`
- `DEFAULT_MAX_FRAMES`
- `DefaultFormatter`
- `DROPPED_COUNT_KEY`
- `ERROR_METADATA_KEYS`
- `ErrorHandlerOptions`
- `ErrorUtilsLike`
- `FenceReason`
- `FileDestination`
- `FileDestinationOptions`
- `FileSink`
- `FileSinkLike`
- `flushOnBackground`
- `FlushOnBackgroundOptions`
- `FlushOutcome`
- `installErrorHandler`
- `installRejectionHandler`
- `JsonLinesFormatter`
- `JsonLinesFormatterOptions`
- `JsonTimestampStyle`
- `LazyMessage`
- `Log`
- `LogDestination`
- `LogEntry`
- `LogFormatter`
- `Logger`
- `LogLevel`
- `LogMetadata`
- `LogOptions`
- `LogPrimitive`
- `LogValue`
- `LossCounts`
- `MAX_CATALOG_SIZE`
- `METADATA_KEY_PATTERN_SOURCE`
- `NativeConsoleDestination`
- `NativeConsoleDestinationOptions`
- `NativeConsoleSink`
- `NativeConsoleSinkLike`
- `NON_ERROR_THROWN`
- `priv`
- `PrivacyDefault`
- `PrivateValue`
- `pub`
- `PublicValue`
- `PurgeOutcome`
- `REDACTED_FRAME`
- `REDACTED_MESSAGE`
- `RedactedMetadata`
- `REJECTION_HANDLED_LATE_MESSAGE`
- `REJECTION_METADATA_KEYS`
- `RejectionHandlerOptions`
- `RejectionTrackingLike`
- `RejectionTrackingOptions`
- `RejectReason`
- `RotationConfig`
- `SanitizedError`
- `sanitizeError`
- `SanitizeErrorOptions`
- `ScopedLogger`
- `SinkStatus`
- `UNCAUGHT_ERROR_MESSAGE`
- `UNHANDLED_REJECTION_MESSAGE`
- `Uninstall`
- `UNKNOWN_ERROR_NAME`
- `UNREADABLE_VALUE`
- `utf8Length`
