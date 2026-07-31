---
'react-native-nitro-logger': minor
---

A destination that fails five writes in a row is cut off, and until now an app
had no way to find that out or undo it.

The only signal was a development-only `console.warn`, so in a shipped build a
destination could stop receiving records permanently and silently. `Logger` now
answers both questions.

`destinations()` returns a frozen array of frozen `{ label, enabled }` rows —
the new `DestinationStatus` type — in registration order. Two fields, on
purpose: anything more would have to come from the destination's own getters,
and a failure *count* would invite callers to build a policy on top of a
threshold this logger owns.

`enabled` reports the circuit breaker and only that. It is deliberately **not**
the destination's own `isEnabled`, which is caller-supplied and untrusted — a
throwing getter would break a diagnostics call, and a lying one would report
healthy for something the logger stopped writing to. So `enabled: true` is not
a promise that records are arriving: a destination that reports
`isEnabled: false` about itself is skipped by the write path and still appears
here as `enabled`, a fenced `FileDestination` being exactly that, because from
the logger's side nothing has gone wrong. The label is the one captured at
registration, so a destination whose label getter later starts throwing still
appears under the name this logger knows it by.

Re-arming is `addDestination(theSameInstance)`. That call previously returned
immediately having done nothing at all, which made "I have fixed it, try again"
the one gesture with no effect; it now clears the failure count and the
disabled mark. It still does not flush or dispose — that is the same-label
replacement path, and an instance handed back is not a replacement — and it
still does not re-read the label getter, so the capture-once invariant holds.

There is deliberately no `enableDestination(label)`: reviving by name would let
code that does not hold the destination re-arm it, and holding the instance is
the evidence that the caller is the one who fixed it.
