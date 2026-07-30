# The privacy contract

This library was built for an app that must never write patient data to a log
file. That requirement shaped every design decision below, and it is worth
saying plainly what the library does and does not promise.

**What it promises.** Values you pass as metadata are redacted or rendered
according to a rule you choose once, at startup. Redaction happens before an
entry is constructed, so a redacted value is never present in any object a
destination can see. The reveal path — the code that renders a private value in
the clear — is `__DEV__`-gated and provably absent from a release bundle.

**What it cannot promise.** Three things, and none of them is a detail:

- It cannot tell whether a string is a name. If you interpolate a medical record
  number into a message, this library writes it to disk. The message field is
  public by contract and constrained by lint, not at runtime.
- That lint is **opt-in**. Installing this package does not enable it.
- The redaction above is **release-build behaviour**. A debug build renders
  private payloads in the clear, to every destination including the file.

Each is expanded below. The short version is that this library makes the safe
thing the default in the builds that ship, and cannot make it the only thing.

---

## Two profiles

The default is the OSS-friendly one. Switching the *metadata* default to
fail-closed is one method call; the rest of the telehealth profile is not.
`privacyDefault('private')` also makes an approved-key catalog **mandatory** —
with none configured, no key is approved and every metadata key drops — and it
does nothing at all for message text, correlation IDs and subsystems, which
have no runtime redaction and are held to literals only by the bundled ESLint
configuration, which you have to enable in your own setup and run in CI.

```ts
import { Log } from 'react-native-nitro-logger';

// In the app's entry point, before anything logs. On its own this line drops
// every metadata key you supply; it needs the catalog below to be useful.
Log.privacyDefault('private');
```

The complete strict setup — both calls, in one place — is under
[Metadata keys](#metadata-keys).

**In a release build** (`__DEV__` false):

| | `'public'` (default) | `'private'` |
| --- | --- | --- |
| A bare metadata value | rendered | redacted to `<private>` |
| `pub(v)` | rendered | rendered |
| `priv(v)` | redacted | redacted |
| Forgetting a wrapper | leaks | hides |

**In a debug build the redaction column does not apply.** The reveal branch is
`__DEV__`-gated, so a development build renders private payloads in the clear —
to *every* configured destination, not just the console, because visibility is
resolved before the entry is constructed and the file sink receives whatever
that produced. A debug build is therefore not suitable for real regulated data;
see [The compliance boundary](#the-compliance-boundary).

`'private'` is fail-closed, which is the entire reason it exists: in the builds
that ship, the failure mode of a forgotten wrapper is a missing value in a log
file, not a patient identifier in one.

`privacyDefault` is **first-set-wins, then tighten-only**. The first call
decides; later calls can move `'public'` → `'private'` but never back. A
library you depend on cannot loosen your setting, and a second call in a
different module cannot silently undo the one in your entry point.

`redactAllMetadata()` is the same idea taken to the end: every value redacts,
wrapped or not, permanently.

---

## What may be a metadata value

Only exact primitives: `string`, finite `number`, `boolean`, and the
`pub()`/`priv()` markers wrapping one of those.

Everything else is dropped without being rendered — objects, arrays, proxies,
`NaN`, `Infinity`, functions, symbols, `null`, `undefined`. Dropping is
payload-free: the entry gains a `droppedMetadataCount` integer and nothing
else. A rejected value never appears in output, not even as a type name, since
`String(value)` on a hostile object runs `toString` and that is somebody else's
code deciding what your log file contains.

Wrapper payloads are validated **twice** — once when `pub()`/`priv()` is called
and again when the value is unwrapped at emit. The second check is not
redundant. `pub(patient as any)` type-checks fine, and only the unwrap sees
what actually arrived.

Markers are recognised by membership in a module-private `WeakMap`, never by a
property or a `Symbol`. A foreign object shaped like a `PublicValue` is not
one, and fails validation naturally rather than by a check somebody has to
remember to write.

The payload is held in that `WeakMap` too, so there is no enumerable field to
find. `JSON.stringify`, spreading, `String()`, and `console.log` inspection all
yield the placeholder.

### Metadata keys

Keys must match `^[A-Za-z0-9._-]{1,64}$` at runtime. That stops a key from
carrying a payload, but it does not stop `patient123` from being a key — which
is why the strict profile adds an **approved-key catalog**.

With a catalog set, an unrecognised key is dropped and counted, in both direct
and scoped metadata. Fail-closed, and the only mechanism here that stops a
literal PHI key.

Under `privacyDefault('private')` the catalog is **mandatory, and enforced by
the runtime rather than by convention**: with no catalog configured, no key is
approved, so every metadata key drops and is counted. Choosing the strict
profile and then forgetting the catalog leaves none of the metadata you
supplied — only the injected `droppedMetadataCount`, which is exactly the
signal that this is what happened. Loud, and in the safe direction; not a
silent failure open.

So the runtime side of the strict profile is two calls, and the catalog has to
be **exactly one** of them: a single `metadataKeyCatalog` naming every key the
app will ever log under. This snippet, and no second call elsewhere in the app:

```ts
import { Log, ERROR_METADATA_KEYS } from 'react-native-nitro-logger';

Log.privacyDefault('private');
Log.metadataKeyCatalog([
  ...ERROR_METADATA_KEYS,
  'requestId',
  'statusCode',
  'durationMs',
  'retryCount',
]);
```

**Repeat calls narrow; they never widen.** `metadataKeyCatalog` is
tighten-only, and it enforces that by intersecting: a second call keeps only
the keys the first one also approved, and can never add one back. Two calls
naming two different groups of keys approve their *overlap*, which is usually
nothing at all — so a per-feature call in each module reads like registration
and behaves like revocation. Pass the whole set once, from the entry point.

**One malformed entry empties the whole catalog.** The check is fail-closed
over the entire input rather than per key: a value that is not a string, a key
that fails the pattern above, an argument that is not iterable, an iterator
that throws, or an implausibly long one each yield an approved set of
*nothing*, not an exception and not a partial catalog. One typo among fifty
good keys approves none of the fifty.

Both mistakes land in the same place — every metadata field of every entry
rendering `<private>`, and the log itself saying nothing about why. So a debug
build says it out loud: `metadataKeyCatalog` warns on the console when a call
leaves fewer keys approved than were approved before it — carrying the size
before and the size after — and when the very first call approves none at all.
**Counts, never a key name.**
An approved name is application vocabulary, and a rejected one may be the
PHI-shaped literal the catalog exists to keep out of the log, so a diagnostic
that printed it would put it in exactly the place it must never reach. It is
development-only for the same reason the reveal is: a release build has nobody
to read a console, and `droppedMetadataCount` is the signal that survives into
one.

The catalog governs metadata the library itself emits, not only yours. The
crash handler logs under six keys of its own, and under `'private'` an
uncatalogued one means crash reports arrive with their metadata stripped —
which is why those six are exported as `ERROR_METADATA_KEYS` rather than left
for you to transcribe. Spreading the constant also survives a key being added
in a future version, where a hand-written list would silently start dropping
one.

`installRejectionHandler` is the same story with the same answer:
`REJECTION_METADATA_KEYS`, spread alongside. Five of its six names are the
crash handler's, so the two constants overlap and spreading both is not a
mistake; the sixth is `rejectionId`, the tracker's own counter, which is how
the entry saying a rejection went unhandled and the entry taking that back name
the same rejection. A rejection *reason* is caller data by construction —
`Promise.reject(new Error(patient.mrn))` is an ordinary line to write — so it
goes through the same sanitiser an uncaught error does, before privacy sees it
at all.

Their *values* are already `pub()`-marked at the call site. Five of the six are
generated here and can carry nothing of yours: a class name reduced to a
built-in or a fixed token, frame positions in files whose names were already
known, two counts and a boolean.

`errorMessage` is the exception, and it is the same exception as everywhere
else in this document. Outside a dev build it is the fixed redaction token, so
the `pub()` marking is exact. **In a dev build it is the thrown message
verbatim** — the first line of application code can put anything in there —
and `pub()` means it renders even under `'private'`. That is the reveal branch
doing what it is documented to do, not a hole in it: a build where a private
payload can render in the clear is a build for synthetic data, and this key is
one more reason why. See [The compliance boundary](#the-compliance-boundary).

A `pub()` value does not exempt a key from the catalog either way, since the
catalog exists to police key *names*.

`droppedMetadataCount` is the exception and needs no entry. It is added after
filtering rather than passing through it, and is rejected as an incoming key,
so the count of what was dropped can never itself be dropped.

---

## Public by contract

Four things are **not** redacted at runtime, because redacting them would make
the logger useless — a log of `<private>` lines is not a log. They are
constrained at build time instead, by the bundled ESLint plugin.

**This enforcement is opt-in and does nothing until you turn it on.** Installing
the package ships the rules; it does not apply them. Until you extend one of the
configs below in your own ESLint setup *and* run ESLint in CI, nothing stops a
template literal in a message position, and the guarantees in this section do
not hold for your codebase.

| Field | Rule | Enforced by |
| --- | --- | --- |
| `message` | string literal or approved constant | `no-dynamic-message` |
| metadata keys | no computed keys, no object spreads | `no-computed-metadata-key` |
| `correlation` | must come from `Log.newCorrelationId()` | `no-derived-correlation` |
| `subsystem` | literal constant | `literal-subsystem` |

<!-- eslint-setup:begin -->

```js
// eslint.config.mjs
import nitroLogger from 'react-native-nitro-logger/eslint-plugin';

export default [nitroLogger.configs.strictTypeScript];
```

<!-- eslint-setup:end -->

`recommended` enables the first two. `strict` enables all four and is what the
telehealth profile means.

**Use the `TypeScript` variant, and check that it is the one you have.** The
bare `strict` and `recommended` configs carry no `files` key, so under ESLint
flat config they select only `.js`, `.mjs` and `.cjs`. Used on their own in a
TypeScript app they inspect nothing, report nothing, and exit 0 — which reads
exactly like compliance. Every rule here guards a field the runtime *cannot*
redact, so that silence is the whole protection gone. `strictTypeScript` sets
the file set and the parser; it covers JavaScript too, so it is the only entry
needed.

A file-less config *does* apply to a TypeScript file that some other entry in
your config already selects and supplies a parser for. That is what masked
this defect in our own repository, where `@react-native/eslint-config`
provided both. Do not rely on it: it lasts only as long as that other entry
keeps selecting TypeScript and supplying a compatible parser, which is another
package's decision to change. **Confirm the rules fire on your own code**: interpolate a
variable into a `Log.info` message in a `.ts` file and check that it is
reported.

The rules reject variables, concatenation, template interpolation, calls,
conditionals and dynamic thunk bodies in the message position. There are
fixture tests for the ways people get around that by accident — aliasing,
destructuring, wrappers, `call`/`apply` — and the plugin is run over `.js`
files in CI as well as `.ts`.

**Correlation IDs must be random and short-lived.** `Log.newCorrelationId()`
returns one — an opaque string, not a branded type, because the enforcement is
in the lint rule rather than in the type system. Do not derive them from a
record identifier, and do not hash one: a hash of a small identifier space is
trivially reversible, and it joins across sessions exactly as well as the
original did.

`no-derived-correlation` checks *provenance*, not spelling. A local
`function newCorrelationId() { return patient.mrn }` produces exactly the leak
the rule exists to prevent, so the generator has to be traceable to an import
of this package.

---

## The compliance boundary

**A build where reveal is possible is a build for synthetic data only.**

The reveal branch is `__DEV__`-gated, and there is no API to turn it on at
runtime. That absence is asserted rather than assumed: a test sweeps every
function the privacy module exports, calls each one with a `priv('SECRET')`,
and fails if any of them hands the payload back. Adding a reveal path to that
module breaks the test. Three CI jobs cover the rest:

- **`build-library`** inventories every `__DEV__` in the built output. It fails
  when a new gated module appears *and* when an allowlisted one disappears —
  the second because a vanished gate would quietly make the next check vacuous.
- **`privacy-release-bundle`** bundles with `--dev false` and requires both that
  the reveal sentinels are absent and that a witness token from each gated
  module is present. Without the witness, the check would pass just as happily
  if the module were never bundled at all.
- The TypeScript suite asserts the runtime absence: with `__DEV__` false, a
  private value renders as `<private>`.

What this does *not* cover: a debug build renders private payloads in the clear,
and it does so to **every configured destination**. Redaction is resolved before
an entry is constructed, so a revealed value reaches the file sink and the
system console exactly as it reaches `console.log` — and the file sink writes it
to disk, where it outlives the session that produced it.

That is the point of a debug build, and it is why the boundary is stated as a
rule about data rather than a rule about builds: the enforcement is that reveal
cannot reach production, not that reveal cannot exist.

If you run a debug build against real regulated data, understand what can and
cannot be undone. `FileDestination.purge()` removes the file sink's artifacts —
that is the recoverable part. Everything the same entry handed to `os_log` or
`logcat` is **not** recoverable: those are the operating system's stores, this
library has no delete API for them, and on iOS the unified log is readable from
a connected Mac. There is no call in this package that clears them. The only
reliable control over that copy is not producing it in the first place, which is
what the boundary above is for.

### Logs on disk

By default the file sink writes to app-private storage — `noBackupFilesDir` on
Android, `Library/Logs` on iOS. Owner-only modes (0700 directories, 0600 files)
are applied to every artifact, and on iOS each artifact also gets
`NSFileProtectionCompleteUntilFirstUserAuthentication` and a backup-exclusion
flag.

**On Android the backup exclusion is a property of that default path, not of
the writer.** `noBackupFilesDir` is a directory Auto Backup and device-to-device
transfer skip; nothing is applied to the artifacts to make them skippable. So
the writer's guarantee covers the default path and stops there. Supply your own
`path` and whether those logs are backed up is a question about the directory
you chose and the app's backup rules — some directories are excluded already
(the cache directory is, and so is anything else under `noBackupFilesDir`), and
a log file under `filesDir` is as eligible as any other app file. What the
writer *cannot* do either way is make the artifacts themselves skippable; there
is no such attribute to set. iOS is the other way around: its exclusion is set
per artifact, so it does follow the files wherever you point them. If you choose
an Android log directory and back-ups matter, settle it in the app's
`data_extraction_rules` (and `full_backup_content` below API 31).

**A log directory the writer did not create is inspected, never changed.** The
log path is yours to choose, and nothing stops it being a directory your app
already owns and uses. Every protection here is a property of the *directory*
and outlives the sink: the backup exclusion is persistent and directory-wide,
the protection class is inherited by every file created there afterwards, and
even `0700` strips access from a directory that may be deliberately shared with
an app group or an extension. Point a sink at `<Documents>/app.log` and claiming
those would silently take your whole document tree out of iCloud backup.

So if the directory was already there, the writer leaves it exactly as it found
it and reports a loose mode as a `protection` degradation for you to act on. If
the writer created the directory, it is the writer's and gets all three — with
one exception, below.

**The exception is the default iOS directory, which the writer creates but does
not claim.** `<Library>/Logs` is where an iOS app is *expected* to put logs, so
your app and any other library in the process may be using it too; on a fresh
install whoever opens first simply wins the `mkdir`, and winning that race is
not ownership. Claiming it would apply a persistent, directory-wide backup
exclusion and an inherited protection class to a conventional directory, and you
would have no way to see that it had happened. So a directory the writer creates
at the default path gets the `0700` mode — which takes nothing from anyone,
since the directory did not exist a moment earlier — and neither of the two
directory-wide settings.

That is decided by the directory's name and not by who asked for it, so spelling
`<Library>/Logs` out yourself gets the same restraint as taking the default —
the reason to hold back is that your app is entitled to that directory, and that
is true however the writer arrived at it. It is recognized by identity rather
than by spelling, so a path that reaches it through a symlink is the same
directory, and it is decided for each level the writer creates, so asking for
`<Library>/Logs/mine` does not claim `Logs` on the way past. Any other directory
you name is yours to give away and is still claimed in full.

Nothing is lost by that. Every artifact the writer creates gets all three
explicitly through its own descriptor, so the log files carry their own
protection whether or not the directory carries any. The directory-wide settings
were never what protected them. Android has no equivalent case: its default is
`<noBackupFilesDir>/logs`, a name this package chose, and the backup behaviour
there comes from the path rather than from anything the writer applies.

*Files* are different and always get all three: a log file at the log
path is one the writer is about to append to, rotate and purge, so it counts as
its own even if it was already there — and a `0644` log file left by an earlier
version is exactly the thing worth tightening. Android has nothing to scope —
its equivalent is structural — a property of where the default path is rather
than of anything applied to the artifacts, as above — and its `restrictToOwner`
only sets modes.

The practical consequence: **if you supply your own log directory, create it
with the protections you want.** This applies to the iOS default too —
`Library/Logs` is a standard system directory and may well already exist, in
which case the writer inspects it like any other. That is not a gap: what the
backup exclusion and the protection class are actually protecting is the log
files, and those are the writer's own artifacts, so they get both regardless of
who made the directory around them.

Those are applied, not guaranteed. When the platform refuses, the writer records
a `protection` bit in the `degraded` bitmask and keeps logging rather than
failing shut — losing a mode is worth reporting, not worth dropping the app's
logs over. Read `degradation()` if you need to know. The two platforms are also
not equivalent here: iOS's protection class makes the file cryptographically
inaccessible until first unlock, and Android has no per-file counterpart.

**`FileDestination.purge(deadlineMs)` is the compliance primitive.** It is
synchronous and returns a `PurgeOutcome`. It deletes every artifact the writer
can produce — active file, age sidecar, archives, and interrupted gzip staging
files — bumps a generation so nothing in flight can write into the fresh file,
and `fsync`s the directory so the removals survive a crash.

Its reach is the file sink. It does not and cannot clear what other
destinations did with the same entry; see the paragraph above on `os_log` and
`logcat`.

`durable` means every *pre-purge* artifact is gone and the directory has been
synced, so the removals hold across a crash. It is not a claim that the log
directory is left empty: a purge that succeeds and rebinds immediately opens a
fresh, empty active file, because the alternative is a destination that accepts
records with nowhere to put them. `durable` describes the data that was there.

`durable` is false on any survivor, any deadline overrun, and any path where
deletion failed *or could not be proven to have succeeded*: a file the platform
cannot make a statement about is reported as a failure, never as a deletion.
`rebound` is reported separately, because a complete deletion can still be
followed by a failed reopen, and the destination stays fenced until it comes
back. `discardedEntries` and `discardedBytes` say what was thrown away from the
JS buffer, which is deliberately discarded rather than flushed — flushing it
would write pre-purge records into the file moments before or after deleting it.

`getLogFilePaths()` exists so an app can implement its own consent-gated
support-log upload. Collecting and transmitting logs is deliberately not in
this library: that needs a consent flow and an encryption story that belong to
the application, not to its logger.

It keeps answering after `dispose()`, and that is deliberate rather than an
oversight in the teardown path. Disposing releases the native handle; it does
not delete the log set, so there is still something to collect afterwards —
though individual filenames can change while an outstanding close finishes
rotating or compressing, which is what makes the list best-effort rather than a
frozen inventory (below). An empty list there would tell a support flow "there is nothing to
collect" about logs that are still on the device — and `removeDestination()`
followed by a collection is an ordinary sequence, not a contrived one. This is
the one place where losing the handle does *not* narrow what can be said,
because the answer is a fact about storage rather than a claim about reach —
contrast `purge()`, which reports `durable: false` after disposal for exactly
the mirrored reason.

Empty means "no artifacts", not "no sink": a destination that never opened has
no directory to inspect, and one that opened answers with nothing once a purge,
a retention sweep or something outside the process has taken the files. The
list is also a **best-effort snapshot** when there is no live handle. Nothing
serializes it against a writer that is still draining a close, so an archive
being renamed at that instant may be missed. A collector opens what it finds
and tolerates a file having gone; that trade is the right way round against
answering `[]`.

---

## Threat model, briefly

Assumed hostile: values arriving as metadata, thrown values reaching the
uncaught-error handler, and configuration numbers arriving from JavaScript.
Where each is checked differs, and it is worth being exact:

| Input | Validated in TypeScript | Validated natively |
| --- | --- | --- |
| Metadata values and keys | yes — primitives only, twice for wrapper payloads | **no**: native receives the already-rendered string, never the original value |
| Thrown values | yes — every read guarded, message and frames sanitised | **no**, same reason |
| Rotation and retention numbers | yes | yes — re-clamped independently, since `NaN` and `Infinity` cross the bridge as ordinary numbers |
| Batch payload and entry count | yes | partly — the count must be a finite integer in range, and an empty payload with a nonzero count (or the reverse) is rejected; a nonzero count is **not** re-derived from the payload |

The last row is worth being blunt about, and worth naming the layer each check
sits in. The count crosses the bridge as a `double`, and both platforms refuse
it unless it converts to an integer exactly: `Int(exactly:)` on iOS,
`BridgeNumber.exactLong` on Android. Neither rounds — `2.5` is rejected, not
silently turned into `2` — and neither accepts a NaN or an infinity, both of
which a bare cast would quietly turn into a plausible number. The writer then
bounds the range and rejects an empty payload carrying a nonzero count, or the
reverse.

What no layer does is parse the batch to confirm the number. Native trusts a
plausible count. It drives loss accounting rather than what gets written, so a
wrong-but-plausible count skews a statistic rather than corrupting the file.

So "validated on both sides" is true of the numbers and of the batch framing,
and not of the content. The content is resolved to a string in JavaScript, and
the native side's job is to write that string without corrupting it, not to
second-guess it.

Assumed trusted: the application's own string literals, the device's storage,
and the developer's build configuration. A logger cannot defend against an app
that decides to log a patient record on purpose, and pretending otherwise would
be worse than saying so.

Out of scope: cross-process access to the log directory (there is no extension
use case), and an attacker with root on the device.
