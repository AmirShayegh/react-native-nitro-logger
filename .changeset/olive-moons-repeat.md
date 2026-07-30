---
'react-native-nitro-logger': patch
---

Release the log writer when a React instance is destroyed (Android).

A reload — Metro's, or any `ReactHost.reload()` — tears down the JavaScript
context without running any of it, so nothing closed the file sink. On Android
nothing else could either: Nitro's `HybridObject` sits in a JNI
strong-reference cycle that only an explicit `dispose()` breaks, so `finalize()`
never runs. The writer kept the registry slot and the descriptor for the life of
the process, and the next `open` with a different rotation config was refused
against a sink nothing could reach. File logging was gone until the app
restarted.

Each handle is now recorded against the React instance that acquired it, and
that instance's claims are released when it is destroyed — on
`NativeModule.invalidate()`, which fires on exactly instance teardown. The unit
of release is the claim rather than the writer, so a writer shared with a
still-live instance survives at a lower refcount. In a host that never registers
the module nothing changes.

No API change. iOS was never affected: `deinit` is deterministic and already
did this.
