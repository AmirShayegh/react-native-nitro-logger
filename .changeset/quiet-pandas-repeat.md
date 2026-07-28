---
'react-native-nitro-logger': minor
---

Initial release.

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
