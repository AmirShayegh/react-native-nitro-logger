# Parity with SwiftLogger

This package is a port of [SwiftLogger](https://github.com/amirshayegh/logger).
Where the two can produce the same bytes, they do — `JsonLinesFormatter` is
asserted byte-identical to `JSONLogFormatter` over a generated corpus in
`__tests__/jsonLinesFormatter.test.ts`. Where they cannot, this file says why.

Nothing here is aspirational. Every "identical" row is covered by a golden;
every difference is either enforced by a test or unreachable through the
public API, and the table says which.

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
the same invariants: 112 XCTest cases and 68 JUnit cases, neither of which needs
a simulator or an emulator.

| Concern | iOS | Android | Consequence |
| ------- | --- | ------- | ----------- |
| Open-and-check | `O_RDWR\|O_APPEND\|O_CREAT\|O_NOFOLLOW\|O_NONBLOCK` in one syscall, then `fstat` | check-then-open: `lstat` for a symlink, then `FileOutputStream` | a window on Android, over app-private storage no other app can write to |
| Crash-tail trim | through the same descriptor it will append with | a separate `RandomAccessFile` opened before the append stream exists | the trim and the writes provably concern one inode on iOS; on Android that rests on there being no other descriptor yet |
| File age across restarts | `creationDate` from the filesystem | `<base>.meta` sidecar, authoritative once written | see below |
| At-rest protection | `NSFileProtectionCompleteUntilFirstUserAuthentication` and a backup-exclusion flag, per artifact | `noBackupFilesDir` plus owner-only modes | **not equivalent** — see below |
| Link count / directory sync | `fstat` and `fsync` directly | behind `PlatformIo`, so the writer imports nothing from `android.*` | the Android writer is JVM-testable; `PlatformIo.Jvm` reports "cannot say" for link count, so that path is driven by a fake |
| Deadlines | `DispatchTime` | injected monotonic clock (`System.nanoTime`) | same guarantee, reached differently |

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

These claims are deliberately narrower than "React Native ≥ 0.78 on both
platforms", because only one of them is verified against the bottom of the
range.

| Platform | Claim | How it is backed |
| -------- | ----- | ---------------- |
| iOS | React Native ≥ 0.78 | the `min-rn-ios` CI job packs a tarball into a pristine 0.78 app, builds it Release, launches it on a simulator and reads a run-ID-matched verdict out of the app container |
| Android | verified at the example's React Native version; **0.78 experimental** | `test-android` runs the writer's JUnit suite and `build-android` builds the example, but no equivalent minimum-version consumer job exists yet |

The Android gap is tracked for v1.1. Narrowing the claim was the deliberate
alternative to asserting something no job checks.

`min-rn-ios` is pinned to `macos-15` with Xcode 16.4. React Native 0.78 pins
fmt 11.0.2 through RCT-Folly and clang from Xcode 26 rejects its
`format-inl.h`; that is upstream and unrelated to this library, but it is also
not a combination any consumer is in, since an app on 0.78 builds with the
toolchain 0.78 shipped against. The cost of keeping the floor at 0.78 is that
this job is pinned to a runner image GitHub will eventually retire — raising
the floor is what would let it move.
