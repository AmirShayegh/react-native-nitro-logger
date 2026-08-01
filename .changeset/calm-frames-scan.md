---
'react-native-nitro-logger': patch
---

Two crash-path fixes: a ReDoS in stack-frame parsing, and error handlers that stacked up across Fast Refresh

**Hostile stack traces can no longer stall the fatal-error handler.** The
regex that picked `file:line:column` off the end of a stack frame backtracked
from every offset when the tail almost-matched, and `stack` is a property of
any thrown object — attacker-shaped input on the one path that runs between a
fatal error and `flush(2000)`. Measured through the shipped artifact: a
benign stack cost 0.1 ms; 64 KB of `"1:"` repeated cost 225 ms on desktop V8,
which is seconds on a mid-range phone — inside the handler whose whole job is
getting the log to disk before the watchdog kills the process. The parse is
now a backward scan, character-class-identical to the regex — proven by a
differential fuzz test (random strings, both parsers, identical
`(location, line, column)` triples) and pinned by a hostile fixture with a
tight time budget. Same output, linear time.

**A Fast Refresh no longer leaves the previous error handler installed.**
Each reload re-ran the installer while the old instance stayed chained on
`ErrorUtils`, so N reloads meant N sanitizer passes per error and N
`flush(2000)` barriers on a fatal one — multiplying exactly the path fixed
above. The install registry now lives on a global symbol, so a fresh instance
recognises its predecessor and marks it inert. Unbranded handlers — RedBox,
crash reporters — are never skipped; only this package's own stale instances
step aside. Development-only by nature, and the termination signal (module
re-evaluation) is stated in the handler for what it is: weaker than a real
teardown hook.
