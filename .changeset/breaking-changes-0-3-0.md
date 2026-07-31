---
'react-native-nitro-logger': minor
---

**Breaking changes.** Four of them, batched here so an upgrade has one place to
read. Each is a compile error at every affected call site rather than a silent
change of behaviour, which is why they are being made now: 0.2.0 shipped
yesterday and the surface is still small enough to correct.

**`ScopedLogger.log(message, options?)`** — was `log(message, level?,
metadata?)`. Three positionals in an order nobody could recall, and different
from `Logger.log(message, options?)` for no reason beyond how each grew.
`ScopedLogOptions` is `{ level?, metadata? }` and is a new root export.

It deliberately has no `subsystem` and no `correlation`. A scope owns both —
that is what a scope is — and a call that could override them would let one
line quietly leave the unit of work every other line belongs to. Use
`Logger.log` for a different subsystem, or nest a `scoped()` for a different
correlation. The six level methods are untouched: `info(message, metadata?)`
had no ambiguity worth fixing. A JavaScript caller who misses the change and
passes a level string gets the default level and a delivered message, rather
than a level read out of an object that is not one.

**`scopeMetadata` is off `LogOptions`.** It was never something a caller should
set: it is a scope's own defaults, it loses every collision with `metadata`,
and it is validated one step more weakly, so passing it directly bought nothing
over `metadata`. It now lives on an unexported `InternalLogOptions` that only
`ScopedLogger` imports.

`logMessage` still reads that field at runtime, off whatever object it is
handed — removing a field from a TypeScript interface removes nothing from a
JavaScript build — and that is deliberate: the redaction path must treat
whatever arrives there as caller data. The ESLint rules go on checking it for
exactly that reason, and are now the only thing that would notice a patient
name in it. The plugin's model is pinned against both interfaces so a future
edit cannot quietly shrink it.

**The raw sinks left the root.** `createFileSink`, `createNativeConsoleSink`,
`FileSink` and `NativeConsoleSink` are now only at
`react-native-nitro-logger/unstable`. Most callers want
`createFileDestination()` instead; a caller that genuinely wants the layer
below a destination changes one import line and gets, at that line, the
documentation for what that layer does not do.

**The six spec result interfaces are `readonly`.** `RotationConfig`,
`SinkStatus`, `AppendResult`, `FlushOutcome`, `ClearOutcome` and
`CollectOutcome` — what the native calls hand back. Nitrogen's generated tree
is byte-identical with the annotations applied, verified by regenerating and
diffing, so this is a TypeScript-side statement only and no native change. It
is also erased at runtime: these are ordinary mutable objects crossing the
bridge, which is why the test proving two failed collects do not share one
outcome object still mutates through a cast, and says why in place.
