# API reference

Every export of `react-native-nitro-logger`, grouped by what it is for. The
README is the guided tour; this is the index.

Signatures are the real ones. Where behaviour is subtle — and in a logger most
of the subtlety is in failure paths — this points at the document that explains
it rather than restating it badly: [PRIVACY.md](PRIVACY.md) for the redaction
contract, [PARITY.md](PARITY.md) for where the two native writers differ, and
[WIRE.md](WIRE.md) for the versioned remote-ingest bytes and immutable segment
identity.

- [Logging](#logging)
- [Analytics schemas](#analytics-schemas)
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
| `passesLevel(level, subsystem?)` | `boolean` | Does this level clear the effective minimum for the given subsystem? The level threshold and nothing else — `true` does not promise delivery, since destinations can be absent, disabled, or have their own floor. The level methods and `ScopedLogger` ask it before building an options object a filtered call would discard. Public because `ScopedLogger` needs it; you rarely do. |
| `minimumLevel(level)` | `this` | Global floor. |
| `subsystem(name, level)` | `this` | Per-subsystem floor, which overrides the global one. |
| `resetSubsystem(name)` | `this` | Drop a per-subsystem floor. |
| `privacyDefault(value)` | `this` | `'public'` or `'private'`. First call wins, and later calls may only tighten. |
| `redactAllMetadata()` | `this` | Redact every value regardless of marker. Not reversible. |
| `metadataKeyCatalog(keys)` | `this` | Approve key names. Calls intersect; one bad key approves none. **Mandatory under `'private'`** — see [PRIVACY.md](PRIVACY.md#metadata-keys). |
| `consoleLogging(enabled)` | `this` | Toggle the built-in console destination. |
| `addDestination(destination)` | `this` | Register. Labels are unique; re-registering a label replaces. Re-adding the *same instance* re-arms it. |
| `destinations()` | `readonly DestinationStatus[]` | What is registered, and which of them this logger has cut off. |
| `removeDestination(label)` | `this` | Unregister and dispose. |
| `flush(deadlineMs?)` | `void` | Ask every destination to flush, inside one total budget. Returns nothing — see the note below. |
| `newCorrelationId()` | `string` | A fresh ID, generated rather than derived. |
| `scoped(correlation?, subsystem?, metadata?)` | `ScopedLogger` | Omit `correlation` and one is generated. |

`flush()` deliberately returns `void`. Whether bytes reached disk is a question
only the file sink can answer, so ask it: `FileDestination.flush(deadlineMs)`
returns a `BatchFlushOutcome` with `durable` on it.

`deadlineMs` (default 2000) is the **total** for the whole call, not an
allowance each destination gets. Destinations are flushed in registration order
and each is handed what the ones before it left, so register the destination
whose durability matters most — normally the file sink — first. A destination
reached with the budget already spent is still asked, with `0`: that drains
whatever needs no waiting, and skipping it would be a new way to lose records on
the crash path. The bound is cooperative — a destination that ignores its
deadline still blocks — and `Infinity` means the 30-second ceiling rather than
forever. Time is measured against a monotonic clock, so a device clock
correction between two destinations cannot stretch or end the budget.

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

A destination whose `write` throws five times in a row is auto-disabled: the
logger stops calling it rather than paying for the throw on every entry. The
only signal is a development-only console warning, which a shipped build never
sees, so `destinations()` is how a running app finds out. It returns a frozen
array of frozen `DestinationStatus` rows — `{ label, enabled }` and nothing
else.

`enabled` reports **one thing**: this logger's circuit breaker. It is
deliberately not the destination's own `isEnabled`, because that getter is
caller-supplied — a throwing one would break a diagnostics call and a lying one
would report healthy for something this logger stopped writing to. Which means
`enabled: true` is not a promise that records are arriving: a destination that
reports `isEnabled: false` about itself is skipped by the write path and still
appears here as `enabled`, and a fenced `FileDestination` is exactly that. From
this logger's side nothing has gone wrong. The two are different questions, and
this method answers the one you cannot find out any other way. The label is the
one captured at registration, so a destination whose label getter started
throwing since then still appears under the name this logger knows it by.

Re-arming is `addDestination(theSameInstance)`: passing an instance that is
already registered clears its failure count and its disabled mark and returns
without touching the label getter again. That is the whole gesture — "I have
fixed it, try again" — and before 0.3.0 it was the one call that did nothing.
There is deliberately no `enableDestination(label)`, because reviving by name
would let code that does not hold the destination re-arm it, and holding the
instance is the evidence that the caller is the one who fixed it.

<!-- api: Logger, DestinationStatus -->

### `ScopedLogger`

Carries a correlation ID, an optional subsystem, and optional default metadata
into every call. Same six level methods as `Logger`, minus the `subsystem`
argument, since a scope already has one. `scoped()` nests, and a nested scope
inherits what it does not override — **including the correlation ID**.

| Method | Returns | What it does |
| --- | --- | --- |
| `verbose(message, metadata?)` · `debug(…)` · `info(…)` · `warning(…)` · `error(…)` · `todo(…)` | `void` | Emit at that level. Unchanged. |
| `log(message, options?)` | `void` | The general form. `ScopedLogOptions` is `{ level?, metadata? }`. |
| `scoped(correlation?, subsystem?, metadata?)` | `ScopedLogger` | Nests. Inherits the correlation unless you pass one. |

**`log` changed shape in 0.3.0.** It was `log(message, level?, metadata?)` —
three positionals in an order nobody could recall, and different from
`Logger.log(message, options?)` for no reason beyond how each grew. It now
takes options, so both spellings agree. The compiler names every line to
change, and a JavaScript caller that misses one gets the default level rather
than a level read silently out of an object.

`ScopedLogOptions` has **no `subsystem` and no `correlation`**, deliberately. A
scope owns both — that is what a scope is — and a call that could override them
would let one line quietly leave the unit of work every other line belongs to.
Use `Logger.log` for a genuinely different subsystem, or nest a `scoped()` for
a different correlation.

That is the opposite of `Logger.scoped()`, which generates a fresh one when you
omit it, and both are right for the same reason: a correlation ID names a unit
of work. `Logger.scoped()` starts one. A scope nested inside it is that same
unit of work seen closer up, so a new ID there would sever the trail at exactly
the point someone reading the logs is trying to follow it. Pass one explicitly
to start a genuinely separate unit from inside an existing scope.

Its default metadata goes through the same redaction path as call-site
metadata, and the ESLint rules read both.

Constructing one directly — `new ScopedLogger(logger, correlation, subsystem)` —
is equivalent to `logger.scoped(correlation, subsystem)` and is linted the
same way: the correlation and subsystem arguments are the same two channels
the runtime cannot redact, and the rules check them in either spelling. That
was not true before 0.1.2, when only `scoped()` was recognised and the
constructor reported nothing.

<!-- api: ScopedLogger, ScopedLogOptions -->

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

## Analytics schemas

Import this surface from `react-native-nitro-logger/analytics`. It authors a
closed event grammar once; later analytics tooling consumes the same frozen
schema instead of maintaining a second list of names, properties, or bounds.

### `defineEvents(definition)` and its inferred types

`defineEvents` returns an immutable `EventArtifact` containing the normalized
schema, its runtime validator, an inspectable `grammar`, and the authoritative
precomputed `grammarJSON` bytes. Its `lint` member is an
`AnalyticsLintArtifactV1`: `{ formatVersion: 1, grammar }`, frozen over the
same grammar object for schema-dependent ESLint rules. `EventName<Artifact>`
extracts the exact event-name union, while `EventProperties<Artifact, Name>`
extracts one event's required and optional property object.
`ValidationResult<Artifact>` is a closed discriminated union: success
correlates `eventName` with validated `properties`; failures carry fixed codes
and never rejected caller data.

The validator accepts unknown runtime input for JavaScript and decoded-data
callers. Bare and `pub()` values must satisfy their descriptors. Authentic
`priv()` markers are checked for authenticity but never compared with a
caller-selected constraint, because a payload-dependent result would become a
range or equality oracle; their descriptor compatibility remains a TypeScript
guarantee and the server grammar remains authoritative for modified clients.

<!-- api: defineEvents, AnalyticsLintArtifactV1, EventArtifact, EventName, EventProperties, ValidationResult -->

### Canonical analytics grammar

`AnalyticsGrammar` currently aliases `AnalyticsGrammarV1`. Its component types
are `AnalyticsGrammarEvent`, `AnalyticsGrammarProperty`, and
`AnalyticsGrammarConstraint`, whose concrete branches are
`AnalyticsGrammarEnumConstraint`, `AnalyticsGrammarIntegerConstraint`, and
`AnalyticsGrammarNamedStringConstraint`. The exact portable shape is:

```ts
type AnalyticsGrammarV1 = {
  artifact: 'react-native-nitro-logger/analytics-grammar';
  formatVersion: 1;
  additionalEvents: false;
  events: readonly {
    name: string;
    additionalProperties: false;
    properties: readonly {
      name: string;
      required: boolean;
      constraint:
        | { type: 'enum'; values: readonly string[] }
        | { type: 'integer'; minimum: number; maximum: number }
        | { type: 'named-string'; registry: string; values: readonly string[] };
    }[];
  }[];
};
```

Event and property names are sorted; authored constraint-member order is
preserved. Both levels are closed, every node is recursively frozen, and the
stored `grammarJSON` is serialized once from a prototype-independent graph.
Normal `JSON.stringify(artifact.grammar)` produces the same string, but later
registration must use `grammarJSON` so ambient serializer changes cannot alter
approved bytes.

V1 accepts only safe integer bounds, Unicode-scalar constraint members no
larger than 256 UTF-8 bytes, at most 256 events, 2,048 properties, 16,384
serialized member references, and 1 MiB of JSON. `formatVersion` identifies
this document format; it is not the gateway-assigned D10 `schemaVersion`.
Emission proves neither tenant approval nor registration, active/retired/
revoked lifecycle state, signature validity, or server enforcement.

<!-- api: AnalyticsGrammar, AnalyticsGrammarConstraint, AnalyticsGrammarEnumConstraint, AnalyticsGrammarEvent, AnalyticsGrammarIntegerConstraint, AnalyticsGrammarNamedStringConstraint, AnalyticsGrammarProperty, AnalyticsGrammarV1 -->

### `oneOf`, `int`, `namedString`, `screenName`, and `optional`

`oneOf` defines a non-empty exact string enum. `int` defines an inclusive,
finite integer range. `namedString` binds a non-empty exact string set to a
structural registry name, and `screenName` is its screen-registry shorthand.
`optional` marks one descriptor optional without widening its inferred value.
Every constructor copies and freezes its input, rejects duplicates or invalid
bounds at definition time, and exposes no free-form string descriptor.

<!-- api: oneOf, int, namedString, screenName, optional -->

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
import { createFileDestination, JsonLinesFormatter } from 'react-native-nitro-logger';

const logFile = createFileDestination({
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
| `maintain(deadlineMs?)` | `number` | Rotation and the retention sweep, on demand. Returns the same mask as `degradation()`, read once the bounded wait is over. |
| `purge(deadlineMs?)` | `PurgeOutcome` | The compliance path. See below. |
| `reopen(deadlineMs?)` | `boolean` | The way back from a fence. See below. |
| `collectForSupport({ maxTotalBytes, deadlineMs? })` | `CollectOutcome` | One gzip bundle of the whole log, for a support upload. See below. |
| `deleteSupportBundle(deadlineMs?)` | `boolean` | Deletes that bundle once it is uploaded. See below. |
| `getLogFilePaths()` | `string[]` | Active file first, then archives. Still answers after `dispose()`. For a consent-gated support upload. |
| `unreportedLoss()` | `LossCounts` | Entries and bytes lost that no `flush` result has reported yet. |
| `degradation()` | `number` | Bit mask; `0` is healthy. Rotation, prune, sidecar, gzip, protection and exclusivity each have a bit. |
| `dispose()` | `void` | Releases the native handle. |

Every `deadlineMs` here bounds a wait on the JavaScript thread, and every one of
them is capped at **30 seconds** — `Infinity` means that cap, not forever, on
both sides of the bridge. `flush` applies the cap in JavaScript before it starts
draining; `maintain`, `purge` and `collectForSupport` hand the number to the
native writer, which applies the same one. The waits are measured against a
monotonic clock, so a device clock correction landing mid-call cannot stretch
them. What none of them bound is a filesystem that never answers: the deadline
governs how long this code waits, not how long a single blocking syscall takes.

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

**`reopen(deadlineMs?)` is the way back from a fence**, and it returns whether
the destination can write when the call returns. A fence is deliberately
permanent until something asks for a retry: a destination fenced by *another*
handle's purge, or by a purge that deleted durably and then could not reopen,
stays disabled, and before 0.3.0 there was nothing to ask. Constructing a
replacement is a poor substitute rather than an impossible one. On the same
canonical path a second handle is eligible to share the writer when its
rotation policy and framing match, and differing ones are a config conflict —
though matching them is no promise of success either, since an acquisition can
still fail on a previous writer that is still closing, on the filesystem, or on
the lock. Whichever way it goes, the fenced destination is still alive, holding
its retain on the writer and its registration with whatever logger it was given
to, until someone disposes it.

It closes this handle and opens a fresh one with the same path, rotation and
framing it was constructed with. A disposed destination returns `false` and
stays disposed, because dispose is a release and not a pause. An unfenced one
returns `true` having touched nothing, since closing a live handle to prove it
could be reopened would throw away the buffer and the file position. A failed
open leaves it fenced, which is the only safe direction for this to fail in; a
failed *close* does not, because there was nothing drainable behind a fence and
the open is what decides. `deadlineMs` bounds the close, the only half that
waits.

`true` says a handle was acquired — not that the file behind it holds what the
old one did. After another handle's purge it is a fresh, empty file, which is
the purge working. The new file also does not open with a loss notice about the
old one: the fence clears what was owed on the way in, because a count of
deliberately deleted records describes the deletion.

**`collectForSupport({ maxTotalBytes, deadlineMs? })`** packs the log files into one gzip bundle beside them and returns a
`CollectOutcome`. `gunzip` on that file gives you the whole log as
chronological JSON Lines — gzip is a multi-member format, so archives that are
already compressed are copied in byte for byte and the active file is
compressed in beside them, on the writer's own queue and after a flush.

```ts
import { createFileDestination as createFileDestination3 } from 'react-native-nitro-logger';

const supportable = createFileDestination3();
const bundle = supportable.collectForSupport({ maxTotalBytes: 5 * 1024 * 1024 });

if (bundle.complete && bundle.path !== '') {
  // Upload `bundle.path`, then delete it — see below.
} else if (bundle.complete) {
  // Nothing to send: this device has no logs.
}
```

**`deleteSupportBundle(deadlineMs?)` is the third step**, and the flow is
**collect → upload → delete**. Skipping it leaves a gzipped copy of the whole
log on the device until a `purge()` or the next collect replaces it — outside
the retention budget `rotation` configures, and deliberately skipped by the
native orphan sweep, which keeps a finished bundle precisely because somebody
may still be uploading it. On a device holding regulated data that copy is the
one artifact retention never reclaims, so a support flow that does not call this
has to decide it is content to leave it there.

```ts
import { createFileDestination as createFileDestination4 } from 'react-native-nitro-logger';

const uploader = createFileDestination4();
const collected = uploader.collectForSupport({ maxTotalBytes: 5 * 1024 * 1024 });

if (collected.complete && collected.path !== '') {
  // await upload(collected.path);
  if (!uploader.deleteSupportBundle()) {
    // Still there. Safe to call again — deleting a bundle that is already gone
    // is `true`, not an error.
  }
}
```

It deletes the bundle and its staging leftovers, never a log file; this is not a
smaller `purge()`. `true` means no bundle artifact remained when the call ran,
**including vacuously** for a destination that never opened. That describes an
instant and promises nothing about the next one: a collect started afterwards
writes a new bundle, and sequencing the two is the caller's job.

`false` is the whole of the rest, and deliberately not a list of causes: the
deletion was refused, timed out, threw, or could not be *durably* confirmed
gone. It does not assert that anything survived — a refusal establishes nothing
about the directory — so read it as "assume a copy may still be there" and retry
through a live, current destination.

A fenced or disposed destination refuses, and `getLogFilePaths()` still
answering after `dispose()` is **not** a precedent for doing otherwise: reading
a directory this destination no longer owns is harmless, and deleting from one
is not. Once the handle is gone there is no writer generation left to check, so
another destination may own that path by now and be part-way through publishing
into it — the `.support.gz` removed would be *its* bundle, whose path it has
already handed to a caller. A fence says the same thing one step earlier.

So **delete before disposing**, or through a fresh destination on the same path.
Either gives a live handle on a current generation, which is what makes the
deletion safe rather than merely willing. The generation is re-checked natively
at the last instant before the unlinks, so a purge landing mid-call is caught
too.

A delete whose deadline expires is abandoned rather than left queued. Without
that, a call that returned "I deleted nothing" could reach the front of the
writer's queue seconds later and unlink a bundle a *subsequent* collect had just
published and handed back the path of.

`CollectForSupportOptions` is that argument object: `maxTotalBytes`, and an
optional `deadlineMs` that defaults to 10s and bounds each of the two waits —
the buffer flush and the native collect — rather than their sum.

`CollectOutcome` carries `path` (`''` when no bundle was produced),
`byteCount`, `sourceFileCount`, `truncated` and `complete`. Read `complete`
first. `complete: true` with an empty `path` is a device with nothing to
collect, which is not a failure and should not be shown as one; `complete:
false` means the collect did not finish and there is no bundle to send — and
none appears afterwards either. A collect that overran its deadline is stopped
at the last step rather than mid-copy, so the build it could not wait for
deletes its own staging file instead of publishing a bundle nobody was told
about.
`truncated` is orthogonal and ordinary — the ceiling was reached, and what came
back is the newest end of the log, because that is the end anybody debugging is
asking about.

**`maxTotalBytes` has no default, and `Infinity` is refused.** How much of a
log leaves the device is the app's decision, and a default would be this
library making it. The value is measured on the source bytes rather than the
compressed result, so it bounds the work as well as the upload. A negative or
non-finite value throws a `RangeError` rather than being read as "no ceiling" —
`NaN` arriving here is an arithmetic bug upstream, and the dangerous way to
resolve it is to send everything. Zero is legitimate and produces no bundle.

The bundle lands at a fixed name inside the sink's own directory, never a path
you choose: a support feature is not a reason to ship a write-anywhere
primitive. At most one exists — each collect replaces the last — and `purge()`
deletes it along with everything else, because a compliance deletion that left
a gzipped copy of the log behind would not be a deletion. It is excluded from
`getLogFilePaths()`, from the retention count and from `maxTotalLogBytes`.

Nothing is uploaded and nothing is encrypted by this library. `docs/PRIVACY.md`
records why both are the app's call.

**The support flow is three steps, not two.**

```ts
import { createFileDestination } from 'react-native-nitro-logger';

declare function uploadToSupport(path: string): Promise<void>;
declare function scheduleSupportBundleRetry(): void;

async function sendDiagnostics(file: ReturnType<typeof createFileDestination>) {
  // 1. collect — a gzipped copy of the log, beside the log files.
  const bundle = file.collectForSupport({ maxTotalBytes: 5 * 1024 * 1024 });

  try {
    // 2. upload — yours. Nothing here transmits or encrypts. Only a complete
    //    bundle is worth sending; an incomplete collect still has step 3.
    if (bundle.complete && bundle.path !== '') {
      await uploadToSupport(bundle.path);
    }
  } finally {
    // 3. delete — in `finally`, because the failure paths are exactly the ones
    //    that leave bytes behind. An incomplete collect can leave staging
    //    artifacts, and a throwing upload skips everything after it.
    if (!file.deleteSupportBundle()) {
      // Assume a copy may still be there. Retrying is the response; ignoring
      // it silently is how a gzipped log outlives the flow that made it.
      scheduleSupportBundleRetry();
    }
  }
}
```

Step 3 is not tidiness, and the `finally` is the part worth copying. Retention
deliberately keeps a *finished* bundle, because the sweep cannot know whether an
upload is still reading it — so a bundle nobody deletes sits outside the rotation
budget the app configured, indefinitely, as a gzipped copy of the whole log. On a
device holding regulated data that is the one artifact retention never comes back
for.

Which is why the paths that skip step 3 matter more than the happy one. A
throwing upload and an early return on an incomplete collect are exactly the
cases that leave bytes on disk: a collect that did not finish can still have
written the `.part` and `.member` staging files, which hold log content, and
`deleteSupportBundle` is what removes those too.

Two ordering rules, both of which return `false` rather than guessing:

- **Delete before `dispose()`.** A released handle no longer knows whether the
  bundle at that path is still its own — another destination may have opened the
  same directory and be mid-publish — so a disposed destination refuses.
- **Sequence collect and delete yourself.** `true` means no bundle artifact
  remained at the instant of the call. A collect started afterwards writes a new
  one.

`false` is deliberately not a list of causes — refused, timed out, threw, or
absence could not be *durably* confirmed. Read it as "assume a copy may still be
there" and retry rather than branching on why.

**`FileDestinationOptions`, and what happens if you pass nothing.**

Every option has a working default, and the defaults are worth reading rather
than inferring — two of them decide behaviour people expect to be automatic.

| Option | Default | Notes |
| --- | --- | --- |
| `label` | `'file'` | Identifies the destination in loss notices. |
| `formatter` | `new JsonLinesFormatter()` | Line-framed, so crash-tail trimming is on. |
| `path` | `<sink default dir>/app.log` | `noBackupFilesDir` on Android, `Library/Logs` on iOS. |
| `minimumLevel` | none | Falls through to the logger's. |
| `rotation` | **none** | No rotation, no retention, no size cap. See below. |
| `maxEntryBytes` | 64 KiB | One entry over this is truncated, not dropped. |
| `batchBytes` | 4 KiB | Soft target for one native `appendBatch`. |
| `flushIntervalMs` | 100 ms | The timer that pushes a partial batch. |
| `maxPendingEntries` | 1000 | Buffer ceiling by count; over it, records are dropped and counted. |
| `maxPendingBytes` | 512 KiB | The same ceiling by size. |
| `watermarkBytes` | 256 KiB | Backpressure point, below the ceiling. |

**`rotation` defaulting to none is the one to notice.** Omit it and the file
grows without bound: no size threshold, no archive count, no
`maxTotalLogBytes`. That is deliberate — a library that silently started
deleting an app's log data would be making a retention decision that belongs to
the app — but it means a long-lived app that never configures rotation has a
file that only `purge()` ever shortens. The Quick start passes a rotation block
for that reason.

The second is `maxEntryBytes`: an entry above it is **truncated to fit**, not
discarded, and formatters that implement `formatWithin` are asked to do the
truncation so the result is still valid for the format. A dropped entry is a
different event with a different count.

<!-- api: FileDestination, FileDestinationOptions, PurgeOutcome, CollectForSupportOptions, CollectOutcome -->

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

### `PlatformConsoleFormatter`

The same layout as `DefaultFormatter` with the level and timestamp columns
left off — `[correlation] [subsystem] message {key=value}` — for
`NativeConsoleDestination`, whose sinks stamp their own severity and time.
**Recommended there, and not the default:** it changes what you see in
Console.app and Xcode, which a package upgrade should not do by itself.

```ts
import {
  createNativeConsoleDestination,
  PlatformConsoleFormatter,
} from 'react-native-nitro-logger';

createNativeConsoleDestination({ formatter: new PlatformConsoleFormatter() });
```

The ` INFO | 12:15:30.842 | ` those columns cost is 23 characters, and it is
paid per line rather than once per entry — every continuation line carries the
same 23 columns blanked out, against four characters here. A thirty-frame stack
trace spends 713 characters on framing under the default layout and 120 under
this one. os_log and logcat both chunk the rendered entry by size, so that is
593 bytes of budget back — most of an os_log chunk. That can decide whether an
entry crosses a chunk boundary rather than always deciding it: this trace
splits in two either way. It tells for entries near a boundary, and near the
eight-chunk ceiling both writers enforce, past which the tail arrives as a byte
count instead of as content.

Structured fields are escaped exactly as `DefaultFormatter` escapes them. The
continuation marker is weaker: with no columns to blank, a message that begins
`  | ` renders a first line that looks like a continuation. What that could
impersonate is another line of your app's console output, never a record —
the durable copy is `FileDestination`'s, and `JsonLinesFormatter` is what makes
it unforgeable. Keep the default if you want the stronger guarantee in the
console too.

<!-- api: PlatformConsoleFormatter -->

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

### `scheduleMaintenance(options)`

Rotation and retention only ever run from a write: the native writer rotates
when a record makes the file too big or too old *as it is being appended*, and
sweeps retention when it opens or rotates. A sink nobody is logging to keeps
whatever it had when the last record landed — an age rotation that never fires,
an expired archive that is never deleted, a `maxTotalLogBytes` cap that goes on
being exceeded. `flush()` does not stand in for it; it drains what is buffered
and moves no files.

This is the timer that runs `FileDestination.maintain()` for you.

```ts
import {
  createFileDestination as createFileDestination2,
  scheduleMaintenance,
} from 'react-native-nitro-logger';

const maintained = createFileDestination2();
const stopMaintenance = scheduleMaintenance({
  destination: maintained,
  intervalMs: 10 * 60 * 1000,
});
```

`ScheduleMaintenanceOptions` takes `destination`, `intervalMs` (default 5
minutes, clamped up to `MINIMUM_MAINTENANCE_INTERVAL_MS`, which is 30 seconds),
`deadlineMs` (default 1000) and `appState`. `destination` is typed as
`MaintainableDestination` — anything with `maintain(deadlineMs)` — so a
destination this package does not ship can be swept the same way.

The interval stops when the app leaves the foreground and starts again when it
returns, with one catch-up sweep on the way in; an interval frozen for six hours
has six hours of expired archives waiting. Installing while the app is already
in the foreground does **not** sweep, because opening the sink has just run one.

The timer lives in JavaScript rather than in the writer, so it freezes with the
JS thread and the policy — how often, how long, whether at all — stays with the
caller. Nothing in the native sink schedules work on its own.

<!-- api: scheduleMaintenance, MINIMUM_MAINTENANCE_INTERVAL_MS, ScheduleMaintenanceOptions, MaintainableDestination -->

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

`createFileDestination(options?)` and `createNativeConsoleDestination(options?)`
are how you get a destination on the real native sink, and are what the samples
above use. Each constructs the Nitro hybrid object and hands it to the
destination, which owns the handle from then on and releases it on `dispose()`.
Both throw rather than degrade: a missing native module, a failed open, or a
config conflict with a writer already open on that path. A file destination
that silently writes nowhere is worse than one that refuses to be built.

The constructors stay public because a `FileSinkLike` double is how a
destination is tested, and substituting your own implementation is a legitimate
thing to want.

`createFileSink()` and `createNativeConsoleSink()` build the raw sinks on their
own. **They moved to `react-native-nitro-logger/unstable` in 0.3.0** and are no
longer root exports — importing them from the root is now a build error naming
the two lines to change. The separate entry point is a warning about
stability, and it does not make
them safe: a raw `clearLogs()` bumps the writer generation, which makes *every*
`FileDestination` on that file stale — including ones the caller does not know
about. Nothing notifies them. Each finds out when it next tries to write, has
the append rejected as a stale generation, fences itself and loses that record;
from then on it reports `isEnabled: false` until something calls `reopen()`.
Purge through the destination when you have one.

On **React Native 0.78 only**, importing from `/unstable` also needs
`resolver.unstable_enablePackageExports: true` in `metro.config.js`: Metro 0.81
ships with subpath exports off, and 0.82 — React Native 0.79 and up — turns
them on. The root entry point is unaffected at every version. The
[README](../README.md#package-subpaths-need-one-line-of-metro-config-on-react-native-078)
has the measurements.

`FileSink` and `NativeConsoleSink` are the Nitro interfaces, and moved to
`/unstable` with the two factories. `FileSinkLike` and `NativeConsoleSinkLike`
are structural equivalents that stay at the root — they are what lets tests drive a
destination without a native runtime, and what you implement to substitute your
own.

`RotationConfig` requires `maxFileSizeBytes`, `maxArchivedFilesCount` and
`compressArchives` — all three, since a rotation policy that left any of them
implicit would be guessing on your behalf about retention. Optional:
`maxFileAgeSeconds` (rotate on age regardless of size),
`maxArchiveAgeSeconds` (delete old archives even when under the count cap), and
`maxTotalLogBytes` (a bound on the current file and all archives combined).

`SinkStatus` carries the sink's view of its own health, including the
degradation mask that `FileDestination.degradation()` surfaces.

| Bit | Name | What stopped working |
| --- | --- | --- |
| `1 << 0` | rotation | The active file could not be rotated. |
| `1 << 1` | gzip | An archive could not be compressed and was kept as plaintext. |
| `1 << 2` | prune | Retention could not delete something it wanted to. |
| `1 << 3` | sidecar | The age sidecar could not be written, so age-based rotation is guessing. |
| `1 << 4` | protection | A file or directory did not get the mode, protection class or backup exclusion it should have. |
| `1 << 5` | exclusivity | The filesystem would not give this writer an exclusive claim on its file, so nothing stops a second process appending to it. |

The mask is payload-free on purpose: these numbers cross into JavaScript and end
up in a log file, and a path or an `errno` description is exactly the kind of
string that carries a username in it.

**One process at a time.** Opening a file sink takes a non-blocking exclusive
lock on a `<logfile>.lock` file next to the log, and an open that finds another
process holding it fails rather than appending alongside it — two processes
interleaving mid-record, running two rotation schedules over the same names, is
the collision the library exists to prevent. The lock is on a file of its own
because rotation renames the active file and a lock follows the inode; it is
never deleted, including by `purge()`, because unlinking a locked name lets the
next process lock a fresh file and write alongside the first. It holds no log
bytes. A filesystem that cannot lock raises the `exclusivity` bit and logging
continues — refusing to log would be the worse answer.

<!-- api: createFileDestination, createNativeConsoleDestination, createFileSink, createNativeConsoleSink, FileSink, NativeConsoleSink, FileSinkLike, NativeConsoleSinkLike, RotationConfig, SinkStatus -->

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

`BatcherOptions.renderNotice` is **required**, and stays that way. A default
would have to pick a format, and the only one available here is JSON Lines —
which, written into a destination whose formatter is anything else, produces a
file that no longer parses as what it claims to be. The notice is a record in
the log, so only the owner knows how to spell one.

`maxBatchBytes` (default 256 KiB) is the ceiling on a single handoff to the
sink, distinct from `batchBytes` (default 4 KiB), which is the size at which a
drain is *triggered*. The first bounds how much crosses the bridge in one call;
the second decides when to make the call. A buffer that has grown past the
trigger — because the sink was busy, or a burst outran it — is handed over in
several bounded batches rather than one enormous one.

`LossCounts.entries` is exact for what the pipeline accepted; it does not count
a record handed to a fenced or disposed destination, which the `isEnabled`
guard turns away before anything accepts responsibility for it.
`LossCounts.bytes` is a **lower bound**: from 0.3.0 it counts the bytes of
records that were rendered and then dropped, and a record turned away before
rendering contributes `0`. That is the deliberate price of not formatting
records the buffer has already refused — under sustained overload the count of
lost entries stays right while their total size under-reports. Alert on
`entries`.

Being formatted is not being written, in either direction. Entries reach
`LogFormatter.format` and still never reach the file — the buffer fills, the
sink rejects the batch, the handle is fenced mid-flight — and entries are
dropped by a level filter without arriving there at all. From 0.3.0 a full
buffer skips the call too. **A formatter must not carry state that later
records depend on**: one stamping a sequence number is numbering its own calls,
not the file's lines, and those have never been the same sequence. Derive what
a record says from the entry it is given.

<!-- api: Batcher, BatchTarget, BatcherOptions, BatchFlushOutcome, LossCounts, FenceReason -->

### `utf8Length(text)`

UTF-8 byte length, computed without encoding the string — no intermediate
`TextEncoder`, no allocation. The byte ceilings above are in bytes rather than
characters, and this is what measures them, so batching and console chunking
agree with the sink about how large a payload is. Surrogate pairs count as the
four bytes they encode to, not as the two code units JavaScript stores.

<!-- api: utf8Length -->

### `describeDegradation(mask)` and the `DEGRADED_*` bits

`FileDestination.degradation()` returns a bitmask, which is the right thing to
send across a bridge and an awkward thing to hold: `if (mask & 4)` is
unreadable at the call site and unverifiable in review. `DEGRADED_ROTATION`,
`DEGRADED_GZIP`, `DEGRADED_PRUNE`, `DEGRADED_SIDECAR`, `DEGRADED_PROTECTION`
and `DEGRADED_EXCLUSIVITY` are those bits by name, matching the table above.

`describeDegradation(mask)` turns one into a frozen array of the names set —
`[]` for a healthy `0`, `['prune', 'exclusivity']` for `0x24`. Bits this build
has no name for are ignored rather than reported: a newer native paired with an
older JavaScript bundle can set one, and inventing `'bit6'` would put a string
in a log line that means nothing to whoever reads it. Compare against the raw
mask if you need to know that something unnamed is set.

The output is payload-free by construction — six fixed literals, and no path,
`errno` or filename can reach it — which is the same reason the natives report
a mask instead of a message.

```ts
import {
  Log as Logger6,
  createFileDestination as createFileDestination6,
  describeDegradation,
} from 'react-native-nitro-logger';

const watched = createFileDestination6();
const problems = describeDegradation(watched.degradation());
if (problems.length > 0) {
  Logger6.warning('logging degraded', { degraded: problems.join(',') }, 'diagnostics');
}
```

<!-- api: describeDegradation, DEGRADED_ROTATION, DEGRADED_GZIP, DEGRADED_PRUNE, DEGRADED_SIDECAR, DEGRADED_PROTECTION, DEGRADED_EXCLUSIVITY -->

### `levelAtLeast(level, minimum)`, `LEVEL_ORDER` and `PRIVATE_PLACEHOLDER`

The three things a custom `LogDestination` cannot implement without. A
destination that filters by severity has to compare two `LogLevel`s, which are
strings — `'warning' >= 'error'` is a lexicographic answer to a question nobody
asked. `LEVEL_ORDER` maps each level to the numeric severity that also crosses
the bridge, and `levelAtLeast(level, minimum)` is the comparison itself.
`PRIVATE_PLACEHOLDER` is the exact string (`<private>`) that redaction
substitutes for a value, exported so a destination can recognise it — to count
redactions, or render them differently — without transcribing the literal and
drifting from it.

It does **not** tell you a field was redacted. By the time an entry reaches a
destination the placeholder is an ordinary string, indistinguishable from one a
caller set to that same text on purpose, and nothing in `LogEntry` records which
it was. That is a property of the design rather than an oversight: the payload
is gone, not hidden, so there is nothing left to carry the provenance.

Deliberately **not** exported: `LEVEL_TAG` and `LEVEL_NAME`. Those are the
fixed-width tags and uppercase names the formatters emit for byte-parity with
SwiftLogger. They are a wire format that happens to live in the same file, not
API, and exporting them would invite a consumer to depend on bytes this package
has promised to a different project.

<!-- api: levelAtLeast, LEVEL_ORDER, PRIVATE_PLACEHOLDER -->

---

## Index

Every name this package exports. The list is not decoration: `__tests__/apiReference.test.js`
compares it against `src/index.tsx` in both directions, so an export missing
from here fails the suite, and so does an entry here that no longer exists.

- `AppendResult`
- `AppStateLike`
- `AnalyticsGrammar`
- `AnalyticsGrammarConstraint`
- `AnalyticsGrammarEnumConstraint`
- `AnalyticsGrammarEvent`
- `AnalyticsGrammarIntegerConstraint`
- `AnalyticsGrammarNamedStringConstraint`
- `AnalyticsGrammarProperty`
- `AnalyticsGrammarV1`
- `AnalyticsLintArtifactV1`
- `Batcher`
- `BatcherOptions`
- `BatchFlushOutcome`
- `BatchTarget`
- `ClearOutcome`
- `CollectForSupportOptions`
- `CollectOutcome`
- `ConsoleDestination`
- `createFileDestination`
- `createFileSink`
- `createNativeConsoleDestination`
- `createNativeConsoleSink`
- `DEFAULT_BUNDLE_NAMES`
- `DEFAULT_MAX_FRAMES`
- `DefaultFormatter`
- `DEGRADED_EXCLUSIVITY`
- `DEGRADED_GZIP`
- `DEGRADED_PROTECTION`
- `DEGRADED_PRUNE`
- `DEGRADED_ROTATION`
- `DEGRADED_SIDECAR`
- `describeDegradation`
- `DestinationStatus`
- `DROPPED_COUNT_KEY`
- `ERROR_METADATA_KEYS`
- `ErrorHandlerOptions`
- `ErrorUtilsLike`
- `EventArtifact`
- `EventName`
- `EventProperties`
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
- `int`
- `JsonLinesFormatter`
- `JsonLinesFormatterOptions`
- `JsonTimestampStyle`
- `LazyMessage`
- `LEVEL_ORDER`
- `levelAtLeast`
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
- `MaintainableDestination`
- `MAX_CATALOG_SIZE`
- `METADATA_KEY_PATTERN_SOURCE`
- `MINIMUM_MAINTENANCE_INTERVAL_MS`
- `NativeConsoleDestination`
- `NativeConsoleDestinationOptions`
- `NativeConsoleSink`
- `NativeConsoleSinkLike`
- `namedString`
- `NON_ERROR_THROWN`
- `PlatformConsoleFormatter`
- `oneOf`
- `optional`
- `priv`
- `PrivacyDefault`
- `PRIVATE_PLACEHOLDER`
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
- `scheduleMaintenance`
- `ScheduleMaintenanceOptions`
- `screenName`
- `ScopedLogger`
- `ScopedLogOptions`
- `SinkStatus`
- `UNCAUGHT_ERROR_MESSAGE`
- `UNHANDLED_REJECTION_MESSAGE`
- `Uninstall`
- `UNKNOWN_ERROR_NAME`
- `UNREADABLE_VALUE`
- `ValidationResult`
- `defineEvents`
- `utf8Length`
