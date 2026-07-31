# Parity with SwiftLogger

This package is a port of [SwiftLogger][swiftlogger], and the comparison
throughout is against commit [`670e183`][swiftlogger-rev] — "byte-identical"
means nothing without saying identical to what. A commit rather than a release
tag on purpose: the newest tag, 2.3.0, predates `JSONLogFormatter` entirely, so
citing it would name a version that cannot support the claim being made. Where
the two can produce the same bytes, they do:
`JsonLinesFormatter` is asserted byte-identical to [`JSONLogFormatter`][formatter]
over a generated corpus in [`__tests__/jsonLinesFormatter.test.ts`][goldens].
That test is not in the npm tarball — `files` excludes `__tests__` — so
checking the claim rather than taking it means reading it in the repository.
Where the two cannot produce the same bytes, this file says why.

Nothing here is aspirational. Every "identical" row is covered by a golden;
every difference is either enforced by a test or unreachable through the
public API, and the table says which.

**What holds that revision in place is documentation, not a gate, and that is
worth saying plainly.** The goldens are checked in as a generated TypeScript
module, and CI asserts this package still matches them — so a change *here*
that breaks byte-parity fails. What no job can check is that the corpus still
corresponds to `670e183`, because SwiftLogger is not a dependency of this
package and nothing in CI holds a checkout of it. If SwiftLogger's formatter
changes, this suite stays green and the claim silently becomes a claim about a
past revision. The revision is therefore recorded in three places — here, the
generated module's own header, and `scripts/README.md` — so that regenerating
is a deliberate act with a number attached rather than a refresh.

## How much of this is actually enforced

<!-- test-counts: js=1168/27 swift=252/13 kotlin=244/12 -->

| Target                              | Tests | Suites |
| ----------------------------------- | ----- | ------ |
| JavaScript / TypeScript (`jest`)    | 1168  | 27     |
| iOS (`swift test`)                  | 252   | 13     |
| Android (`testDebugUnitTest`)       | 244   | 12     |

A count is a weak claim on its own — it says how much was run, not what was
proven — and it is here for one specific thing: these are floors, not
observations. `scripts/check-test-reports.sh` fails if any target reports
fewer, so a suite that stops being discovered cannot be mistaken for a suite
that passes. That failure mode is not hypothetical for a repository with three
test runners: a renamed Gradle task, a Swift target dropped from `Package.swift`
or a Jest `testPathIgnorePatterns` typo each produce a green run over nothing.

The numbers above and the floors in that script are checked against each other
by `scripts/check-parity-counts.sh`, so this table cannot quietly go stale —
which is the only thing that would make it worse than no table at all.

## JSON record

Field order is fixed on both sides so output diffs cleanly.

| Field         | SwiftLogger                          | This package                     | Status |
| ------------- | ------------------------------------ | -------------------------------- | ------ |
| `timestamp`   | ISO 8601 UTC ms, or epoch seconds    | same                             | identical |
| `level`       | `VERBOSE`…`TODO`                     | same                             | identical |
| `message`     | RFC 8259 escaped string              | same                             | identical |
| `correlation` | omitted when absent                  | same                             | identical |
| `subsystem`   | omitted when absent                  | same                             | identical |
| `file`        | emitted when non-empty               | **never emitted**                | differs |
| `function`    | emitted when non-empty               | **never emitted**                | differs |
| `line`        | **always emitted**                   | **never emitted**                | differs |
| `metadata`    | sorted keys, omitted when empty      | same                             | identical |
| `truncated`   | —                                    | added by `formatWithin`          | extension |

### Why no `file`, `function`, `line`

Swift captures these for free with `#fileID`, `#function`, and `#line`. JavaScript
has no equivalent, and the alternative — parsing a Hermes stack trace on every
log call — is both expensive and unreliable across Hermes versions and release
builds. Subsystems are the filtering mechanism instead.

This is the only structural difference in the record, and the parity test
encodes it exactly: it strips `,"line":N` from each golden and requires
byte equality on everything that remains. `file` and `function` are absent
from the goldens because the corpus leaves them empty, which is what a port
with no call-site capture would produce anyway.

### Escaping

Identical, and not by coincidence: `JSON.stringify` on a string produces the
same bytes as SwiftLogger's hand-rolled escaper for every input Swift can
represent — the two mandatory escapes, the `\b \f \n \r \t` shorthands,
lowercase `\u00XX` for the rest of C0, and everything else literal including
non-ASCII. Goldens cover each class.

One case exists only on this side. A JavaScript string can hold an unpaired
surrogate; a Swift `String` cannot. Written raw it would make the log file
invalid UTF-8, so it is escaped as `\udXXX`, which is also what `JSON.stringify`
does. No golden covers it because Swift cannot produce one.

### Metadata values

| Value        | SwiftLogger                    | This package        | Status |
| ------------ | ------------------------------ | ------------------- | ------ |
| string       | quoted                         | quoted              | identical |
| bool         | `true` / `false`               | same                | identical |
| integer      | `LogValue.int` → `42`          | `42`                | identical |
| fractional   | `LogValue.double` → `1.5`      | `1.5`               | identical |
| whole double | `LogValue.double(3)` → `3.0`   | `3`                 | differs |
| non-finite   | quoted `"nan"` / `"inf"`       | quoted `"NaN"` / `"Infinity"` | differs, unreachable |

The last two rows are both consequences of JavaScript having one numeric type
where Swift has two. `LogValue.double(3.0)` renders `3.0`; a JavaScript `3` is
indistinguishable from `3.0` and renders `3`. The values are numerically
identical and both are valid JSON — a consumer parsing the field gets the same
number either way.

Non-finite values differ only in spelling, and redaction rejects them before a
formatter ever sees one (`__tests__/redaction.test.ts`). The branch exists so a
hand-built entry produces a parseable record rather than a bare `NaN` token.

### Timestamps

`iso8601` is identical, including the pre-1970 case where flooring rather than
truncating toward zero decides the date — `-1500 ms` renders
`1969-12-31T23:59:58.500Z` on both sides, and there is a golden for it.

`epochSeconds` differs textually for whole seconds: Swift's `Double` rendering
gives `1769516130.0` where JavaScript gives `1769516130`. Numerically equal,
and the JSON type is a number on both sides. `iso8601` is the default and the
style the goldens are written against.

Out-of-range instants have no Swift analogue to match — Swift falls back to a
`DateFormatter`, and this package clamps to the epoch rather than letting
`toISOString` throw inside a log call that was already reporting a problem.

## Console record

`DefaultFormatter` follows SwiftLogger's console layout minus the same
call-site column:

```
LEVEL | HH:mm:ss.SSS | [correlation] [subsystem] message {key=value}
```

Level tags are the byte-identical five-character forms (`TRACE`, `DEBUG`,
` INFO`, ` WARN`, `ERROR`, ` TODO`), and metadata renders as `key=value` sorted
by key. The timestamp is local time on both sides.

### Control characters in structured fields

| Field                    | SwiftLogger | This package         |
| ------------------------ | ----------- | -------------------- |
| `correlation`            | escaped     | escaped              |
| `subsystem`              | escaped     | escaped              |
| metadata keys and values | escaped     | escaped              |
| `message`                | **verbatim**| **line-break safe**  |

Both sides render controls in the structured fields as `\n`, `\r`, `\t`, or
`\u{HH}` with uppercase hex. SwiftLogger covers C0 and DEL; this package also
covers **C1 (U+0080–U+009F)**, which is easy to overlook and worth the
divergence: U+009B is a single-character CSI, so a terminal reads what follows
it as a cursor-movement or erase sequence, and U+0085 is NEL, a line break to
any Unicode-aware reader.

This layout puts one entry per line, so a newline inside any field lets
whoever supplied it forge whole entries — a correlation ID, a subsystem, a
metadata key or value, or a message can each arrive from a request header, a
username, a URL, or an error. `"a\nERROR | 00:00:00.000 | "` would otherwise
write a fake line a reader cannot distinguish from a real one.

**The message is where the two diverge, deliberately.** SwiftLogger leaves it
verbatim so the crash handler can log multi-line stack traces. This package
wanted the same thing without the forgery, so it keeps the lines and indents
every one after the first under the message column:

```
ERROR | 12:15:30.842 | Unhandled TypeError
      |              | at foo (bundle.js:1:2)
```

A real record always carries a known five-character level tag and a timestamp
of digits, so a blank in either column cannot be read as a header. Five
sequences count as line breaks — `\n`, `\r\n`, a bare `\r`, U+0085, and
U+2028/U+2029 — and every other control character, C0 through C1, is escaped
as in the structured fields.

### The JSON record does not do this

`JsonLinesFormatter` escapes exactly what RFC 8259 requires, byte-identically
to SwiftLogger: C0 escaped, everything else literal, C1 included. That is not
an oversight.

Its `framing: 'line'` contract is defined over **`\n` bytes**, because that is
what the native crash-tail trimmer scans for. A raw U+0085 or U+009B inside a
JSON string encodes to `C2 85` / `C2 9B` — no `0x0A` byte anywhere — so record
boundaries survive, and the record is still valid JSON that any parser reads
back exactly as written. Escaping them would buy nothing and break byte parity
with the goldens.

The distinction is that a console line is read by a terminal, and a JSON line
is read by a parser.

Which puts an obligation on whatever reads the file: **split on `\n`, parse
each JSON value, and only then apply line-oriented presentation logic.** A
reader that applies JavaScript line semantics to the raw bytes first — `^`/`$`
under `m`, `split(/^/m)`, a viewer that reflows on Unicode line separators —
can be shown an apparent record nobody wrote, because a message value may
contain U+2028. The guarantee here is that **LF-delimited record boundaries
remain intact**, which is narrower than "records cannot be forged"; the
remainder is an accepted compatibility risk, taken to keep byte parity with the
goldens. Parsing first removes it, since the separator is then one more
character inside a string. `__tests__/jsonLinesFormatter.test.ts` pins both
halves — the characters that pass through, and the framing that survives them.

This package escaped none of these fields until the parity matrix was written.
The structured-field gap was found by comparing against the Swift
implementation; the message gap was found in review of that fix, on the
grounds that matching the reference is not the same as being safe. Both are
the argument for keeping this document accurate.

## Beyond the formatter

| Area | SwiftLogger | This package |
| ---- | ----------- | ------------ |
| Privacy | `os_log`-style interpolation privacy | `pub()` / `priv()` markers plus `privacyDefault`, enforced at runtime and by an ESLint plugin |
| Metadata keys | unconstrained | validated, optionally catalog-restricted |
| Call-site capture | `#fileID` / `#function` / `#line` | none, by design |
| Per-file level overrides | supported | dropped for v1 |
| `highlight()` | supported | dropped for v1 |

The privacy layer is the substantive divergence. Swift's model leans on
`os_log` privacy interpolation, which has no equivalent in a JavaScript logger
that also writes files; this package resolves visibility itself, before an
entry is constructed. `eslint-plugin/README.md` covers what that does and does
not protect.

---

# Parity between the two native writers

The Android writer is a port of the iOS one. Structure, naming scheme, clamping
rules, the two-lock split, generation fencing and the durable/rebound split are
identical by intent — a rotation or a purge that behaves differently on the two
platforms is a bug report nobody can reproduce.

The rows below are the places where they genuinely differ, and why. Everything
not listed here is the same on both platforms and covered by suites that assert
the same invariants: 151 XCTest cases and 123 JUnit cases, neither of which
needs a simulator or an emulator.

One Android suite does need a device. `AndroidPlatformIo` is every
`android.system.Os` call the writer makes, and a JVM cannot make them — the JVM
job exercises `PlatformIo.Jvm`, a different implementation of the same
interface. Its 13 cases run on an emulator at API 24 and 34, and are the only
part of either platform's coverage that is not free.

| Concern | iOS | Android | Consequence |
| ------- | --- | ------- | ----------- |
| Open-and-check | `O_RDWR\|O_APPEND\|O_CREAT\|O_NOFOLLOW\|O_NONBLOCK` in one syscall, then `fstat` | check-then-open: `lstat` for a symlink, then `FileOutputStream` | a window on Android, over app-private storage no other app can write to |
| Taking the exclusion | `open(O_CREAT\|O_RDWR\|O_NOFOLLOW\|O_CLOEXEC)` then `flock(LOCK_EX\|LOCK_NB)`, and `fchmod` through that descriptor | `lstat` for a symlink, then `RandomAccessFile` and `FileChannel.tryLock`, and a path-based mode | the same three answers on both — held, refused, or no exclusion with the `exclusivity` bit raised — and the same refusal to follow a symlink at the lock path. The difference is only where the refusal comes from: one syscall on iOS, a check before the open on Android, with the same window and the same reason it is acceptable as the row above |
| Crash-tail trim | through the same descriptor it will append with | a separate `RandomAccessFile` opened before the append stream exists | the trim and the writes provably concern one inode on iOS; on Android that rests on there being no other descriptor yet |
| File age across restarts | `creationDate` from the filesystem | `<base>.meta` sidecar, authoritative once written | see below |
| At-rest protection | `NSFileProtectionCompleteUntilFirstUserAuthentication` and a backup-exclusion flag, per artifact | `noBackupFilesDir` plus owner-only modes | **not equivalent** — see below |
| Backup exclusion | an attribute the writer sets on each artifact, so it follows the files to whatever `path` you choose | structural: the *default* directory is `noBackupFilesDir`, which Auto Backup skips. Nothing is set on the artifacts | **the Android guarantee covers the default path and stops there.** Supply your own `path` and backup eligibility becomes a property of the directory you chose and the app's `data_extraction_rules` — some are excluded already, `filesDir` is not. The writer has no per-artifact attribute to set either way |
| Link count / directory sync | `fstat` and `fsync` directly | behind `PlatformIo`, so the writer imports nothing from `android.*` | the Android writer is JVM-testable; `PlatformIo.Jvm` reports "cannot say" for link count, so that path is driven by a fake |
| Deadlines | `DispatchTime` everywhere a wait or backoff is measured: the writer's queue waits, reopen/rotation backoffs, the purge lock, and the registry's close-drain waits (a `pthread_cond_timedwait_relative_np` condition, since `NSCondition` can only wait against a `Date`) | injected monotonic clock (`System.nanoTime`) | same guarantee, reached differently. Through 0.1.2 the registry's three waits were realtime — an NTP step during teardown could stretch a 200 ms close budget to the 30 s ceiling |
| A purge landing after the close barrier | the sweep is already on the serial queue, so it lands *behind* the terminate barrier and runs after it: deletes every artifact, reports `durable` for the deletion, and never reopens | the executor is shut down, so the submission is refused — and the deletion then runs inline on the calling thread, once `awaitTermination` has established that no task can ever run again. Never reopens either, and deliberately does not consult `terminated`: a close whose own barrier submission was rejected leaves that flag false over a dead executor | the same answer on both — every artifact deleted, `durable` describing the deletion, `rebound` always false. **Through 0.2.0 Android deleted nothing here and reported `durable: false`**, contradicting its own comment two screens up: a blanket `catch (Exception)` read "I could not schedule the work" as "the deletion failed", so disposing a destination and then asking for a compliance purge silently erased nothing. Pinned by three Kotlin tests and an iOS parity anchor |
| Sink lifecycle | `FileSinkLifecycle` (`ios/FileSinkLifecycle.swift`), which carries the transition table | `FileSinkLifecycle.kt`, the same states and transitions | **intended to be identical, and pinned by matching transition-table suites** — not identical *by construction*: these are two hand-written implementations of one table and can drift, which is what the paired suites exist to catch. A row added to one belongs in the other. Through 0.1.2 the rules lived in the two adapters instead, with no test on either, and they disagreed: with no live handle, `flush` and `close` reported `durable: true` on iOS and `false` on Android, in **both** the never-opened and the closed-after-open state. Now both answer `true` only where the claim is vacuous |
| Releasing a sink nobody closed | `deinit`, which is deterministic: the descriptor and the registry slot come back whether or not JavaScript ran | no per-object equivalent — `finalize()` exists but cannot run — so the release comes from outside the object, when the React instance that opened it is destroyed (see below) | on Android `close()` or `dispose()` is still the right thing to call: the instance sweep covers a runtime dying, not a sink you dropped while it lives |
| Console chunk size | 900 bytes per `os_log` entry | 3800 bytes per logcat entry | the platform limits genuinely differ; the behaviour around them — `(i/n)` markers, 8-chunk ceiling, a truncation notice that fits inside its own entry — is identical |
| Console split boundary | grapheme clusters (`Character`) | code points | iOS also keeps combining sequences whole; Android only guarantees surrogate pairs are not cut. Both prevent replacement characters, which is the corruption that matters — see below |
| Console category | a field of the `os_log` object, and no part of the entry's payload | the logcat tag, which shares the entry with the message | Android caps the stored tag at 256 bytes and subtracts its length from the message budget; iOS needs neither, because a long category there costs the message nothing. Through 0.1.3 Android stored the caller's category verbatim against a fixed 3800-byte chunk size, so a long one silently truncated the tail of every entry — the failure the chunker exists to prevent |
| Console byte accounting | standard UTF-8 — `os_log` takes a C string | **modified** UTF-8, because `Log.println` crosses JNI through `GetStringUTFChars`: a supplementary code point costs six bytes there rather than four, and U+0000 costs two rather than one | the same budget arithmetic on two different encodings. Counting the Android side in standard UTF-8 undercounts an emoji-heavy line by half again — enough to push a "safely under 4 KB" entry past the limit and have logcat drop its tail in silence. `NativeConsoleWriter.logcatLength` is the Android count; iOS measures what it actually writes |
| Default log directory | `<Library>/Logs` — a platform convention, so the writer creates it but claims only the `0700` mode, never the directory-wide backup exclusion or protection class. Recognized by canonical identity and at every level, so a second spelling of that path, or reaching it as an intermediate of a deeper one, gets the same restraint | `<noBackupFilesDir>/logs` — a name this package chose, created and owned outright | the asymmetry is about whose directory it is, not about how much protection the logs get. Artifacts carry all three on iOS either way. Claiming `Library/Logs` would apply a persistent, directory-wide backup exclusion and an inherited protection class to a directory the host app is equally entitled to use, invisibly to it |
| Securing a created directory | descriptor-based: `open(O_DIRECTORY\|O_NOFOLLOW)` straight after the `mkdir`, then `fchmod`/`fstat`, so the mode is bound to the inode | `mkdir` with the mode, then a path-based read-back | iOS refuses a symlink sitting at the name when it opens the directory, where a path `chmod` and its path read-back would agree about an inode this process never created, and it detects a replacement arriving after that — the protections still go out by name, but they are read back through the descriptor, so landing on another inode is reported as a shortfall instead of as success. Neither platform covers the window between the `mkdir` and the `open`: a *real* directory swapped in there is not a symlink, the descriptor is then the replacement, and it can be reported secured. Every one of these needs write access to the parent, which inside app-private storage means the app's own uid — outside the threat model in **Threats this does not address**. Android's JVM API offers no descriptor equivalent, so it has neither the refusal nor the read-back |

## Why an unclosed Android sink stays open

On iOS, a `FileSink` that goes out of scope releases its writer: `deinit` runs
deterministically, hands the handle back to the registry, and the descriptor
and the slot are free. Nothing on the JavaScript side has to cooperate.

Android has no equivalent, and the `finalize()` in `HybridFileSink` is not one.
Nitro's `HybridObject.CxxPart` holds a `HybridData` whose C++ side holds a JNI
*global* reference back to that same `CxxPart`; a global reference is a garbage
collection root, so the cycle is rooted outside the Java heap and the object is
never collected. `CxxPart` also holds the sink strongly. Only
`HybridData.resetNative()` breaks the cycle, and the only thing that reaches it
is `dispose()`.

So **`close()` — or `dispose()` — is part of the contract on Android**, not
housekeeping. `FileDestination` does this for you; a raw sink does not.

### What a reload does

Through 0.1.3 a reload leaked the writer outright. Metro tears the JavaScript
context down without running any of it, nothing closed the sink, and the writer
kept the registry slot and the descriptor for the life of the process — so the
next `open` with a *different* rotation config was refused `CONFIG_CONFLICT`
against a sink nothing could reach. File logging was gone until the app
restarted.

It is released now, and by something outside the object, because nothing can
reach the object. Each handle records which React instance acquired it; when
that instance is destroyed — a reload, a `ReactHost.reload()`, any teardown —
its claims are released. The signal is `NativeModule.invalidate()`, which fires
on exactly instance destruction on both architectures, and the release is
per *claim* rather than per writer: a writer shared with a still-live instance
survives at a lower refcount instead of being closed under it.

Two things follow that are worth knowing:

- **A handle acquired for an instance that is already gone is refused**, rather
  than granted a writer nothing would ever close.
- **In a host that never registers the module, nothing changes.** The claim is
  recorded against nobody and behaves exactly as it did before — the fail-open
  direction, on the grounds that a logger which stops working in an unfamiliar
  host is worse than one that leaks a writer there.

`SPIKE-C13.md` records the investigation, including the signal it originally
proposed and why that one was wrong. The proof is `C13ReloadLeakTest`, which
drives a real `ReactHost.reload()` on a device — it landed red, one commit
before the fix.

## Why the console split boundary differs

Both platforms drop the tail of an over-long console line in silence — no
ellipsis, no diagnostic — so both writers split it themselves and mark the
pieces. What they will not do is split *inside a character*, because that
produces replacement characters in the console and suggests corruption that is
not there.

iOS splits on `Character`, which is an extended grapheme cluster, so a flag
emoji and a combining sequence both stay whole. Android splits on code points,
which keeps surrogate pairs — the emoji — together but can separate a combining
mark from the letter it modifies.

The gap is deliberate. Matching iOS exactly means `BreakIterator` and therefore
ICU, whose version varies by device, in the one code path that runs on every
console line of every app. The failure it would prevent is a combining mark
rendering on its own at a chunk boundary: visually odd, still legible, and
still valid UTF-8. The failure both platforms *do* prevent is a half-encoded
character, which is neither.

## At-rest protection is not equivalent

The table says "not equivalent" rather than "different mechanism, same result",
because that would be a claim neither platform supports.

iOS applies a data-protection class, so between boot and the first unlock the
file's contents are cryptographically unavailable even to code that can reach
the path. Android's log directory is app-private and excluded from Auto Backup,
and every artifact is chmod'd to its owner, but the writer requests no
per-file protection class — there is no Android equivalent to ask for. Whatever
protection the artifacts have at rest is whatever platform storage encryption
provides for that device and that user state.

So the difference is narrow and specific: **before first unlock**, iOS gives the
log file a guarantee the Android one does not have. After first unlock the two
are much closer, and neither is a defence against an attacker who already has
privileged access to the device — that case is out of scope for both, and
`docs/PRIVACY.md` says so.

The platforms also differ in how much they have to *withhold*. On iOS all three
protections — mode, protection class, backup exclusion — are applied only to a
log directory the writer itself created; one that was already there is inspected
and left alone, because each of them is directory-wide, outlives the sink, and
the log path may well be a directory the host app owns and shares. Android has
nothing to withhold at that level: `restrictToOwner` sets modes and nothing
else, and the Auto Backup exclusion comes from living under `noBackupFilesDir`
rather than from an attribute the writer sets. Android's Kotlin therefore still
tightens a pre-existing log directory's mode where iOS now reports it instead.
That is a deliberate difference and the one place the two writers' directory
handling is not identical: the case iOS is protecting — a directory deliberately
shared with an app group or an extension — has no Android counterpart. App
storage there is uid-isolated with no cross-process sharing to strip, and a
directory on external storage does not honour POSIX modes in the first place.
Files are treated the same on both, and unlike directories they are treated as
owned whether or not the writer created them — a log file already sitting at the
log path is one this writer is about to append to, rotate, and purge, so it is
its artifact by every meaning that matters, and a `0644` one full of patient
data is worth tightening. Every writer-managed file gets everything its platform
offers.

Both platforms can also fall short of what they attempt: applying or verifying
a mode can fail, and the writer records a `protection` degradation and keeps
logging rather than refusing to log at all. So "owner-only modes on every
artifact" describes what is applied and reported, not an invariant that always
holds. Read the `degraded` bitmask if the distinction matters to you.

## Why Android needs a sidecar

`BasicFileAttributes.creationTime()` is API 26, and this library supports 24.
Worse, where it does exist it is not reliably populated: several Android
filesystems have no birth time and return the mtime instead, which advances on
every write. A writer that trusted it would see a freshly created file at every
restart and postpone age-based rotation forever.

So `<base>.meta` holds the epoch millis the current file began, and it is
authoritative once written — the filesystem is consulted only to seed a sidecar
that does not exist yet, and only when its answer is positive and not in the
future. The sidecar is part of the artifact naming scheme, so a purge takes it.
Rotation overwrites it with the fresh timestamp and holds that value in memory
until the write lands, so a failed write followed by a failed reopen cannot
send the process back to the archived file's age.

## `java.nio.file` is not available

API 26 again, and it is worth stating separately because the failure is not a
graceful one: an unresolvable class raises `NoClassDefFoundError`, which is an
`Error` and passes straight through `catch (Exception)`.

Every use of `java.nio.file` in the Android sources is confined to
`PlatformIo.Jvm.Nio`, a private object nothing on Android ever calls. The
enclosing `PlatformIo.Jvm` *is* reachable from Android — `AndroidPlatformIo`
falls back to its `restrictToOwner`, which uses only `java.io` — which is
exactly why `Nio` is held separately: resolving `Jvm` must not drag
`java.nio.file` into an Android class load.

Android answers symlink detection and tri-state existence with `Os.lstat`
(API 21), and path normalisation is done textually. It does not answer creation
time at all: `AndroidPlatformIo.creationTimeMillis` returns null unconditionally,
because the API-26 call is both unavailable below 26 and unreliable above it,
and the sidecar is the mechanism instead.

`platform` is a required parameter on both `LogFileWriter.open` and
`LogWriterRegistry.acquire` specifically so that falling back to the JVM
implementation is not expressible.

## Compatibility, per platform

Both are now verified against the bottom of the range, by a job each. What
differs is how the verdict gets out of the app, and that difference is worth
knowing about before trusting either.

| Platform | Claim | How it is backed |
| -------- | ----- | ---------------- |
| iOS | React Native ≥ 0.78 | the `min-rn-ios` CI job packs a tarball into a pristine 0.78 app, builds it Release, launches it on a simulator and reads a run-ID-matched verdict out of the app container |
| Android | React Native ≥ 0.78 | the `min-rn-android` CI job does the same into a pristine 0.78 app, builds it Release for the device's ABI, launches it on an API-34 emulator and reads a run-ID-matched verdict off the `ReactNativeJS` logcat tag |

The one fidelity difference: iOS reads an artifact the library wrote, Android
reads what the app said about itself. Reading the file on Android needs
`run-as`, which needs a debuggable build — and a debug build would not be
verifying the thing this job exists for, since R8, the bundled JavaScript and
the packaged `.so` set are exactly what differs in release. A library that
misreported its own outcome would be believed by the Android job and caught by
the iOS one. The run ID in the verdict line closes the other hole, where a
stale logcat buffer signs off a run that never happened.

`min-rn-android` also pins API 34 rather than running a matrix. The minimum-OS
claim belongs to `test-android-instrumented`, which goes down to API 24; this
job's variable is the React Native version, and holding the OS still is what
makes a failure here unambiguous.

`min-rn-ios` is pinned to `macos-15` with Xcode 16.4. React Native 0.78 pins
fmt 11.0.2 through RCT-Folly and clang from Xcode 26 rejects its
`format-inl.h`; that is upstream and unrelated to this library, but it is also
not a combination any consumer is in, since an app on 0.78 builds with the
toolchain 0.78 shipped against. The cost of keeping the floor at 0.78 is that
this job is pinned to a runner image GitHub will eventually retire — raising
the floor is what would let it move.

[swiftlogger]: https://github.com/AmirShayegh/SwiftLogger
[goldens]: https://github.com/AmirShayegh/react-native-nitro-logger/blob/main/__tests__/jsonLinesFormatter.test.ts

<!-- Pinned to a commit, not to `main` and not to a tag. A link to a moving
     branch would quietly stop being evidence the next time that formatter
     changes, and the newest tag does not contain the file at all. -->

[swiftlogger-rev]: https://github.com/AmirShayegh/SwiftLogger/commit/670e183e585ffade915bbedb9dd51be517c9f4c6
[formatter]: https://github.com/AmirShayegh/SwiftLogger/blob/670e183e585ffade915bbedb9dd51be517c9f4c6/Sources/Logger/LogFormatter.swift
