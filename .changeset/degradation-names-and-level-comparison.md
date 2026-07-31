---
'react-native-nitro-logger': minor
---

New exports for reading a degradation mask and for writing a custom
destination: `describeDegradation(mask)`, the six `DEGRADED_*` bits,
`levelAtLeast(level, minimum)`, `LEVEL_ORDER`, and `PRIVATE_PLACEHOLDER`.

`FileDestination.degradation()` has always returned a bitmask, which is the
right shape to send across a bridge and an awkward one to hold — `if (mask & 4)`
is unreadable at the call site and unverifiable in review. The six bits now have
names, and `describeDegradation` turns a mask into a frozen array of the ones
set: `[]` when healthy, `['prune', 'exclusivity']` for `0x24`. A bit this build
has no name for is ignored rather than reported, so a newer native paired with
an older JavaScript bundle degrades to naming what it knows instead of
inventing a string or throwing in the middle of diagnostics.

`levelAtLeast` and `LEVEL_ORDER` are what a destination needs to filter by
severity: `LogLevel` is a string, and `'warning' >= 'error'` is a
lexicographic answer to a question nobody asked. `PRIVATE_PLACEHOLDER` is the
exact string redaction substitutes, exported so a destination can recognise it
without transcribing the literal. It does not tell you a field *was* redacted —
by the time an entry reaches a destination the placeholder is an ordinary
string, indistinguishable from one a caller set to that text on purpose.

`LEVEL_TAG` and `LEVEL_NAME` are deliberately still internal. They are the
fixed-width tags and uppercase names the formatters emit for byte-parity with
SwiftLogger — a wire format that happens to live in the same file, not API.

The four places the degradation bits are written down — this module, both
native writers, and the table in `docs/API.md` — are now held together by
`__tests__/degradation.test.js`, which reads all four and fails if any disagrees
about a name or a value. It pins the numbers, not the meanings: that all four
agree `sidecar` is `1 << 3` says nothing about when a writer raises it.
