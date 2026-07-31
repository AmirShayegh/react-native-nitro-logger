---
'react-native-nitro-logger': minor
---

`ScopedLogger.scoped()` takes an optional `correlation` and inherits the parent
scope's when it is omitted.

That is the opposite of `Logger.scoped()`, which generates a fresh one, and both
are right for the same reason: a correlation ID names a unit of work.
`Logger.scoped()` starts one; a scope nested inside it is that same unit of work
seen closer up, so a new ID there severs the trail at exactly the point somebody
reading the logs is trying to follow it. Pass one explicitly to start a
genuinely separate unit from inside an existing scope.

Purely additive — the argument was required and every existing call still
compiles and behaves identically.

`ConsoleDestination.flush(deadlineMs?)` also names its parameter now, matching
`LogDestination`. It remains a no-op; `console` writes synchronously.
