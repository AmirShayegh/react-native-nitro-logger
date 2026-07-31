---
'react-native-nitro-logger': patch
---

Records the buffer has already refused are no longer formatted first.

Formatting is the expensive half of writing a log line. Under sustained
backpressure — a burst outrunning the sink, or a wedged writer — every record
was rendered in full and then dropped, which is the one situation where the
work is guaranteed to be wasted. `FileDestination.write` now asks
`Batcher.hasRoom()` before it renders.

`hasRoom()` is deliberately conservative, and the asymmetry is its contract.
`false` means *no* record of any size fits: the buffer is at its entry cap, at
or past its byte cap, or there is nowhere to write at all. `true` is not a
promise that this particular record fits, because that needs a length only
rendering can produce — so a record can still be admitted, rendered, and then
dropped by `add` with its bytes counted exactly. What cannot happen is a
`false` that turns away a record which would have been accepted.

**Behaviour change for a stateful formatter.** `LogFormatter.format` is now
called for fewer entries, so a formatter that carries state across calls — one
stamping an incrementing sequence number, say — produces a different sequence
than it did in 0.2.0. That contract was unstated and is now written down:
being formatted is not being written, in either direction — entries are
formatted and still lost (a full buffer, a rejected batch, a fence tripped
mid-flight) and entries are dropped by a level filter without ever being
formatted — so a formatter's call history has never matched the file's lines. A
formatter must not carry state that later records depend on. Three tests pin
which entries reach a formatter, so the shape is checkable rather than
folklore.

**`LossCounts.bytes` is now a lower bound**, and this is the other price. It counts
the bytes of records that were rendered and then dropped; a record refused
before rendering has no length to report and adds `0`. `LossCounts.entries`
stays exact — every dropped record is still counted once, still owed a notice,
and the notice still names the right number. Alert on `entries` and read
`bytes` as the floor it is. The alternative was rendering every record purely
to produce an exact byte total for the ones being thrown away, which is the
cost this change exists to avoid.

`LossCounts.entries` was also stated more carefully. It is exact for what the
pipeline accepted, and it deliberately does not count a record handed to a
fenced or disposed destination: the `isEnabled` guard turns that away before
anything accepts responsibility for it, so nothing owes a notice for it.

Also documented rather than changed: `BatcherOptions.renderNotice` is required
and stays required, because a default would have to write JSON Lines into a
file whose formatter may be anything else; and `maxBatchBytes` (256 KiB, the
ceiling on one handoff to the sink) is distinct from `batchBytes` (4 KiB, the
size at which a drain is triggered).
