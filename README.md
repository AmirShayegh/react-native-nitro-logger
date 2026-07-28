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
  FileDestination,
  createFileSink,
} from 'react-native-nitro-logger';

Log.addDestination(new ConsoleDestination());
Log.addDestination(new FileDestination(createFileSink()));

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
import { Log, pub, priv } from 'react-native-nitro-logger';

Log.privacyDefault('private');
Log.metadataKeyCatalog(['requestId', 'statusCode', 'durationMs']);

Log.info('request finished', {
  requestId: pub(id),   // rendered
  statusCode: 200,      // redacted — unwrapped, and the default is private
});
```

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

```js
// eslint.config.mjs
import nitroLogger from 'react-native-nitro-logger/eslint-plugin';

export default [nitroLogger.configs.strict];
```

**Read [docs/PRIVACY.md](docs/PRIVACY.md) before using this in an app that
handles regulated data.** It covers what the contract does and does not
promise, the approved-key catalog, and the compliance boundary — in short, a
build where reveal is possible is a build for synthetic data only.

## Writing to a file

```ts
const file = new FileDestination(createFileSink(), {
  rotation: {
    maxFileSizeBytes: 10 * 1024 * 1024,
    maxArchivedFilesCount: 5,
    compressArchives: true,
    maxTotalLogBytes: 50 * 1024 * 1024,
  },
});
Log.addDestination(file);
```

Logs live in app-private storage — `noBackupFilesDir` on Android, `Library/Logs`
on iOS. Owner-only modes are applied to every artifact; where the platform
refuses, the sink reports a `protection` degradation and keeps logging rather
than failing shut.

```ts
file.getLogFilePaths();     // for a consent-gated support upload

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

## Crash handling and backgrounding

```ts
import { installErrorHandler, flushOnBackground } from 'react-native-nitro-logger';

const uninstallHandler = installErrorHandler();
const uninstallFlush = flushOnBackground();
```

The error handler logs uncaught errors with the message dropped outside dev,
the class name reduced to a built-in or a fixed token, and stack frames reduced
to a position in a file whose name was already known. It flushes on fatal
errors, then chains to whatever handler was installed before it. Both functions
return idempotent uninstall handles.

## Output format

`JsonLinesFormatter` is the default for files — one JSON object per line, with
a framing guarantee the native crash-tail recovery depends on. It is asserted
byte-identical to [SwiftLogger][swiftlogger]'s `JSONLogFormatter` over a
generated corpus.

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

- [docs/PRIVACY.md](docs/PRIVACY.md) — the privacy contract and compliance boundary
- [docs/PARITY.md](docs/PARITY.md) — parity with SwiftLogger, and between the two native writers
- [eslint-plugin/README.md](eslint-plugin/README.md) — what the lint rules protect, and what they do not

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT

[nitro]: https://nitro.margelo.com/
[swiftlogger]: https://github.com/amirshayegh/logger
