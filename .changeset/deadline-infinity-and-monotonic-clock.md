---
'react-native-nitro-logger': patch
---

Deadlines: `Infinity` now means the 30-second ceiling on the JavaScript side
too, and every bounded wait is measured against a monotonic clock.

**`Infinity` reached the two sides of the bridge differently.** Both native
writers already clamped an infinite deadline to their 30-second ceiling, while
the JavaScript clamp turned it into `0` — so `FileDestination.flush(Infinity)`
waited nothing on this side and up to thirty seconds on the other. The
JavaScript side now answers the way the natives do. If you were passing
`Infinity` to `Logger.flush` or `FileDestination.flush` and relying on it
returning immediately, pass `0`, which has always meant that.

**Elapsed time is no longer read from the wall clock.** A deadline was the
difference between two `Date.now()` readings, which is not a stopwatch: an NTP
step or a manual clock change landing mid-flush could hand the rest of the call
backwards time — an hour-backwards correction turning a 2-second bound into an
hour-and-two-second block on the JavaScript thread, a forwards one ending the
flush before it drained anything. `Logger.flush` and the file destination's
bounded drain now read `performance.now()` where the host provides one, falling
back to `Date.now` where it does not. Every runtime this library supports —
Hermes, JSC, and Node under the tests — provides one.
