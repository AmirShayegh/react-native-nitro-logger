---
'react-native-nitro-logger': minor
---

The level decision is memoised, and made before the options object is built

A message below the minimum is the most common thing a logger does, and it was
the most expensive thing it did per call for its result. Resolving a subsystem
walked the dot hierarchy every time — a Map lookup, a `lastIndexOf` and an
allocated slice per segment — and the six level methods allocated an options
object before anything had asked whether the message would be logged at all.

Both are fixed. Resolution is memoised per subsystem name and the memo is
discarded whenever `minimumLevel`, `subsystem` or `resetSubsystem` changes what
it could answer; the six level methods, on `Logger` and on `ScopedLogger`, ask
the level question first and return before allocating. `logMessage` still makes
the same check on arrival, so integrations and direct callers are unaffected.

The memo is bounded at 512 subsystem names. Past that, resolution still answers
correctly, it is simply not remembered — the keys are caller-supplied strings,
and an unbounded cache of them would be a process-lifetime record of every
subsystem name ever logged.

**One behaviour change, and it is for a subclass rather than a caller.** A class
extending `ScopedLogger` that overrides `log()` to observe every call will no
longer see calls that the level filter drops, because the level methods now
return before reaching `log()`. Overriding `log()` to change what gets logged
is unaffected — those calls pass the level check first.

`Logger.passesLevel(level, subsystem?)` is public as a consequence:
`ScopedLogger` has to be able to ask. It answers the level question and nothing
else — no message, no thunk, no entry.
