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
Regulated use also requires enabling the ESLint configuration in your own
setup and running it in CI, and — where your key vocabulary can carry an
identifier — registering an approved-key catalog. `privacyDefault('private')`
does neither of those for you.

```ts
import { Log } from 'react-native-nitro-logger';

// In the app's entry point, before anything logs.
Log.privacyDefault('private');
```

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
is why the strict profile adds an **approved-key catalog**:

```ts
Log.metadataKeyCatalog(['requestId', 'statusCode', 'durationMs', 'retryCount']);
```

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

The practical consequence is that the strict profile takes two calls, not one:

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

The catalog governs metadata the library itself emits, not only yours. The
crash handler logs under six keys of its own, and under `'private'` an
uncatalogued one means crash reports arrive with their metadata stripped —
which is why those six are exported as `ERROR_METADATA_KEYS` rather than left
for you to transcribe. Spreading the constant also survives a key being added
in a future version, where a hand-written list would silently start dropping
one.

Their *values* are already `pub()`-marked at the call site, because this
package generates every one of them and none can carry caller data; but a
`pub()` value does not exempt a key from the catalog, since the catalog exists
to police key *names*.

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

The file sink writes to app-private storage — `noBackupFilesDir` on Android,
`Library/Logs` on iOS. Owner-only modes (0700 directories, 0600 files) are
applied to every artifact, and on iOS each artifact also gets
`NSFileProtectionCompleteUntilFirstUserAuthentication` and a backup-exclusion
flag.

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
the writer created the directory, it is unambiguously the writer's and gets all
three. *Files* are different and always get all three: a log file at the log
path is one the writer is about to append to, rotate and purge, so it counts as
its own even if it was already there — and a `0644` log file left by an earlier
version is exactly the thing worth tightening. Android has nothing to scope —
its equivalent is structural (`noBackupFilesDir`), and its `restrictToOwner`
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
