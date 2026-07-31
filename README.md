# react-native-nitro-logger

Structured, privacy-tiered logging for React Native. A TypeScript core with
native file and system-console sinks built on [Nitro Modules][nitro].

- **Privacy is a setting, not a habit.** One call at startup decides whether an
  unwrapped metadata value renders or redacts. In the builds that ship, the
  strict profile is fail-closed: a forgotten wrapper hides data rather than
  leaking it.
- **Designed around the things that actually go wrong.** Rotation, gzip and
  retention; crash-tail recovery; detection of an externally deleted file, with
  a reopen into a fresh one; and a compliance purge that reports honestly when
  it could not finish. Where records cannot be saved they are *accounted for*
  rather than papered over: a full disk loses records and counts what it lost,
  and the partial write is rolled back to the last record boundary so the
  damage does not spread — an attempt, not a guarantee, since the rollback is
  itself I/O that can fail. An external deletion is detected and recovered
  from, but the unlinked file and anything written before detection are gone.
- **New Architecture only**, iOS and Android, no bridge fallback.

```sh
npm install react-native-nitro-logger react-native-nitro-modules
```

`react-native-nitro-modules` is a required peer — this library is built on
[Nitro Modules][nitro].

## Quick start

```ts
import {
  Log,
  ConsoleDestination,
  createFileDestination,
} from 'react-native-nitro-logger';

Log.addDestination(new ConsoleDestination());
Log.addDestination(createFileDestination());

Log.info('app started');
Log.warning('retrying upload', { attempt: 2, statusCode: 503 });
```

A scoped logger tags every line with a correlation ID, so one request's lines
can be picked out of a busy file. Omit the correlation argument and one is
generated for you — which is also what the lint rules want, since a correlation
ID must never be derived from an identifier you already have:

```ts
const scope = Log.scoped(undefined, 'checkout', { orderKind: 'subscription' });
scope.info('payment authorised');
scope.error('capture failed', { statusCode: 502 });
```

## Levels

`verbose` · `debug` · `info` · `warning` · `error` · `todo`

```ts
Log.minimumLevel('info');             // globally
Log.subsystem('networking', 'debug'); // and per subsystem
```

## Privacy

The default profile renders metadata values and is fine for open-source and
general application use. Apps handling regulated data should switch to the
strict one in their entry point, before anything logs:

```ts
import {
  Log,
  pub,
  priv,
  ERROR_METADATA_KEYS,
} from 'react-native-nitro-logger';

Log.privacyDefault('private');
Log.metadataKeyCatalog([
  ...ERROR_METADATA_KEYS, // the crash handler's own six — see below
  'requestId',
  'statusCode',
  'durationMs',
]);

function onRequestFinished(id: string) {
  Log.info('request finished', {
    requestId: pub(id), // rendered
    statusCode: 200,    // redacted — unwrapped, and the default is private
  });
}
```

That is one `metadataKeyCatalog` call listing every key the app logs under, and
it is meant to stay one: calls **intersect** rather than replace, so a second
one naming different keys approves the overlap of the two, and a single
malformed key approves nothing at all. Under `'private'` either mistake shows
up only as metadata that has quietly gone — a development build warns, and
[docs/PRIVACY.md](docs/PRIVACY.md#metadata-keys) has the rest.

**In a release build** (`__DEV__` false):

| | `'public'` (default) | `'private'` |
| --- | --- | --- |
| bare value | rendered | `<private>` |
| `pub(v)` | rendered | rendered |
| `priv(v)` | `<private>` | `<private>` |

**A debug build renders private payloads in the clear**, to every destination
including the file — so the fail-closed behaviour above is a property of the
builds that ship, not of every build. A build where reveal is possible is a
build for synthetic data only.

`privacyDefault` is first-set-wins and tighten-only, so a dependency cannot
loosen your setting.

Message text, metadata keys, subsystems and correlation IDs are **public by
contract** — they are never redacted at runtime. The bundled ESLint plugin
constrains them at build time instead, but only once you enable it: installing
this package ships the rules, it does not apply them.

<!-- eslint-setup:begin -->

```js
// eslint.config.mjs
import nitroLogger from 'react-native-nitro-logger/eslint-plugin';

export default [nitroLogger.configs.strictTypeScript];
```

<!-- eslint-setup:end -->

`strictTypeScript` covers `.ts`, `.tsx` **and** JavaScript, so it is the only
entry a React Native app needs — pick one config, not both. It needs
`@typescript-eslint/parser` (an optional peer, no version constraint), which
most RN apps already have via `@react-native/eslint-config`.

**Used on their own, `configs.strict` and `configs.recommended` lint
JavaScript only.** A flat config with no `files` key applies to ESLint's
default set — `.js`, `.mjs`, `.cjs` — so on their own they never bring `.ts`
or `.tsx` into the linted set, and `eslint .` exits 0 without a word. If some
*other* entry in your config already matches TypeScript and supplies a parser,
these rules do run there as well — that is incidental composition, not
something to rely on, and it is exactly why this repository's own CI stayed
green while the published config was inert. It holds only while that other
entry keeps selecting TypeScript and supplying a compatible parser. Reach for
the bare configs if your sources are JavaScript, or if you have Flow-annotated
`.js` that the TypeScript parser would reject, in which case compose `strict`
with your own parser.

**Read [docs/PRIVACY.md](docs/PRIVACY.md) before using this in an app that
handles regulated data.** It covers what the contract does and does not
promise, the approved-key catalog, and the compliance boundary — in short, a
build where reveal is possible is a build for synthetic data only.

## Upgrading to 0.3.0

Four breaking changes, each of which the compiler points at:

| Was | Now |
| --- | --- |
| `scope.log(msg, 'error', meta)` | `scope.log(msg, { level: 'error', metadata: meta })` |
| `LogOptions.scopeMetadata` | gone from the public type; set it by using a scope |
| `import { createFileSink } from 'react-native-nitro-logger'` | `…from 'react-native-nitro-logger/unstable'` |
| mutating a `CollectOutcome` field | the six spec result types are `readonly` |

The scope's six level methods (`scope.info(msg, meta)` and siblings) did not
change. Most callers of `createFileSink` want `createFileDestination()`
instead, which is a root export and does both steps.

## Writing to a file

```ts
const file = createFileDestination({
  rotation: {
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxArchivedFilesCount: 5,
    compressArchives: true,
    maxTotalLogBytes: 50 * 1024 * 1024,
  },
});
Log.addDestination(file);
```

By default logs live in app-private storage — `noBackupFilesDir` on Android,
`Library/Logs` on iOS. Owner-only modes are applied to every artifact; where the
platform refuses, the sink reports a `protection` degradation and keeps logging
rather than failing shut. Passing your own `path` keeps the modes, but Android's
backup exclusion comes from that default directory rather than from anything set
on the files, so it does not travel with them —
[docs/PRIVACY.md](docs/PRIVACY.md#logs-on-disk) has the detail.

```ts
file.getLogFilePaths();     // the individual files, if you would rather send those

// One gzip bundle of the whole log, for a consent-gated support upload.
// `gunzip` on it gives chronological JSON Lines. `maxTotalBytes` is required:
// how much of a log leaves the device is your call, not this library's.
const bundle = file.collectForSupport({ maxTotalBytes: 5 * 1024 * 1024 });
if (bundle.complete && bundle.path !== '') {
  // Upload `bundle.path`. Nothing is transmitted or encrypted for you.
}

const outcome = file.purge(5000);   // the compliance purge
if (!outcome.durable) {
  // Something survived, or the deadline blew. The destination stays fenced
  // until an explicit retry, so nothing is written into a pending deletion.
}
```

`purge` is synchronous and deadline-bounded. It reports `durable` (every
pre-purge artifact is gone) separately from `rebound` (the destination is
writable again), because a complete deletion can still be followed by a failed
reopen, and a caller that resumes on `durable` alone would write into a
destination with nowhere to put anything. A purge that rebinds opens a fresh,
empty active file — `durable` is a statement about the data that was there, not
a promise that the directory is left empty.

It clears the **file sink's** artifacts and nothing else. Anything already
handed to `os_log` or `logcat` is outside this library's reach.

## Logging to os_log and logcat

`NativeConsoleDestination` writes into the platform log stream — os_log on iOS,
logcat on Android — so your JavaScript lines interleave with native ones in
Console.app, Xcode, and `adb logcat`.

```ts
import {
  Log,
  createNativeConsoleDestination,
} from 'react-native-nitro-logger';

Log.addDestination(
  createNativeConsoleDestination({
    subsystem: 'com.example.app',
    category: 'network',
  })
);
```

Unlike `ConsoleDestination`, this one batches: a drain crosses the bridge once
with two parallel primitive arrays rather than once per entry.

**It is best-effort by design, and that is the important thing to know about
it.** There is no backpressure and no loss accounting against a disk, because
os_log accepts what it is given and never blocks. What it *does* account for is
its own buffer — `dropped()` returns the entries lost at the ceiling or to a
sink that threw, because a diagnostic channel that quietly loses records is
worse than one that admits it. After three consecutive native failures the
destination reports `isEnabled === false` and the logger stops formatting for
it, so a dead sink stops costing render work as well as bridge calls.

The durable copy is `FileDestination`'s. Nothing here is a system of record,
which is what makes best-effort the right posture.

| Option | Default | Notes |
| --- | --- | --- |
| `subsystem` | the bundle's, chosen natively | Reverse-DNS, as os_log expects. Empty is legal and produces a logger nobody can find. |
| `category` | `'log'` | Becomes the logcat tag on Android. |
| `formatter` | `DefaultFormatter` | os_log wants a line, not a JSON record. |
| `label` | `'native-console'` | Registration key for `removeDestination`. |
| `minimumLevel` | inherited | Per-destination floor. |
| `batchSize` | `64` | Entries per bridge crossing. |
| `flushIntervalMs` | `100` | Idle coalescing window. |
| `maxPendingEntries` | `1000` | Buffer ceiling; oldest survive, newest are dropped. |

Long lines are split rather than silently cut off — the two platforms have
genuinely different limits, and [docs/PARITY.md](docs/PARITY.md) records both
the chunk sizes and why the split boundary differs between them.

## Crash handling and backgrounding

```ts
import {
  installErrorHandler,
  installRejectionHandler,
  flushOnBackground,
} from 'react-native-nitro-logger';

const uninstallHandler = installErrorHandler();
const uninstallRejections = installRejectionHandler();
const uninstallFlush = flushOnBackground();
```

The error handler logs uncaught errors with the message dropped outside dev,
the class name reduced to a built-in or a fixed token, and stack frames reduced
to a position in a file whose name was already known. It flushes on fatal
errors, then chains to whatever handler was installed before it. All three
functions return idempotent uninstall handles.

It logs under six metadata keys of its own, exported as `ERROR_METADATA_KEYS`.
Under `privacyDefault('private')` those keys go through the same catalog as
yours, so a catalog that does not list them leaves crash reports arriving with
their metadata stripped — which is why the privacy snippet above spreads the
constant rather than transcribing the six. Spreading also survives a key being
added in a later version; a hand-written list would start dropping it without
saying so.

The rejection handler does the same for unhandled promise rejections, and this
one is worth installing even if you think you have it covered: React Native
tracks rejections in development and **not at all in a release build**, so an
`async` function that throws with nobody awaiting it is silent in exactly the
builds that ship. It does not flush — nothing is dying — and it logs a second
entry, at `info`, when a rejection reported unhandled turns out to be handled
after all, so the log takes back what a timer made it say too early.

Its keys are `REJECTION_METADATA_KEYS`, the constant above's twin, and spreading
both into one catalog is not a mistake: five of the six names are shared, and
the sixth is `rejectionId`, which joins the two entries about one rejection.

## Output format

`JsonLinesFormatter` is the default for files — one JSON object per line, with
a framing guarantee the native crash-tail recovery depends on. It is asserted
byte-identical to [SwiftLogger][swiftlogger]'s `JSONLogFormatter` over a
generated corpus, against the specific revision
[docs/PARITY.md](docs/PARITY.md) pins.

```json
{"timestamp":"2026-07-28T10:15:00.123Z","level":"INFO","message":"app started"}
```

`DefaultFormatter` is the human-readable one used by the console destination.
Custom formatters implement `LogFormatter`; declare `framing: 'line'` to opt
into crash-tail trimming.

## Compatibility

| | Supported | Verified |
| --- | --- | --- |
| iOS | React Native ≥ 0.78 | CI builds, launches and exercises a pristine 0.78 consumer app |
| Android | React Native at the example's version; **≥ 0.78 experimental**. minSdk 24 | CI runs the writer's unit suite and builds the example; no minimum-version consumer job exists yet |

New Architecture only. The compatibility claims are split per platform on
purpose — see [docs/PARITY.md](docs/PARITY.md) for what backs each one, and for
where the two native writers genuinely differ.

## Documentation

- [docs/API.md](docs/API.md) — every export, grouped by what it is for
- [docs/PRIVACY.md](docs/PRIVACY.md) — the privacy contract and compliance boundary
- [docs/PARITY.md](docs/PARITY.md) — parity with SwiftLogger, and between the two native writers
- [eslint-plugin/README.md](eslint-plugin/README.md) — what the lint rules protect, and what they do not

## Contributing

Absolute links, because these files are not in the npm tarball — they are
repository documents, and a relative link to them dies for anyone reading this
README inside `node_modules`.

- [Development workflow](https://github.com/AmirShayegh/react-native-nitro-logger/blob/main/CONTRIBUTING.md#development-workflow)
- [Sending a pull request](https://github.com/AmirShayegh/react-native-nitro-logger/blob/main/CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](https://github.com/AmirShayegh/react-native-nitro-logger/blob/main/CODE_OF_CONDUCT.md)

## License

MIT

[nitro]: https://nitro.margelo.com/
[swiftlogger]: https://github.com/AmirShayegh/SwiftLogger
