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

**One behaviour change, and it is for a subclass rather than a caller.** The six
convenience methods used to reach the overridable method underneath them on
every call, and now they reach it only on calls that pass the level check. So a
subclass of `Logger` that overrides `logMessage()`, or of `ScopedLogger` that
overrides `log()`, no longer sees the calls the level filter drops — whatever
the override was for. That includes overrides that would have acted on those
calls rather than merely watched them: re-routing a filtered call, raising its
level, or deliberately emitting it is no longer possible from there, because
the call does not arrive.

Two things are unchanged. Calls that pass the level check still go through the
overridden method exactly as before, and a direct call to `logMessage()` or to
`log()` is untouched — which is the path every integration in this package
uses (the error handler, the rejection handler, the bridges).

`Logger.passesLevel(level, subsystem?)` is public as a consequence:
`ScopedLogger` has to be able to ask. It answers the level question and nothing
else — no message, no thunk, no entry.
