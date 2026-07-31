---
'react-native-nitro-logger': minor
---

`createFileDestination(options?)` and `createNativeConsoleDestination(options?)`
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
`NativeConsoleSink` types, now live at `react-native-nitro-logger/unstable`.
They are still re-exported from the root for this release and move out at the
next major. The root re-export is the *same function object*, not a second
implementation — there is one place each hybrid-object name is spelled, and a
test pins that.

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
