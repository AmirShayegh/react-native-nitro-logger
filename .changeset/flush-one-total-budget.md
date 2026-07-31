---
'react-native-nitro-logger': minor
---

`Logger.flush(deadlineMs)` is now one **total** budget rather than an allowance
each destination gets.

A caller asking for 2000 with three destinations registered could previously
block the JavaScript thread for six seconds — the number they passed multiplied
by a count they may not control, since adding a destination anywhere in the app
lengthened every flush in it. The number now means what it says.

Two consequences worth knowing before you upgrade:

- **Registration order is load-bearing.** Destinations are flushed in the order
  they were added and each is handed what the ones before it left, so a
  destination added later can find the budget spent. Register the one whose
  durability matters most — normally the file sink — first.
- **An exhausted budget does not skip.** Every destination is still asked, with
  `0`. `flush(0)` drains whatever needs no waiting, and skipping would be a new
  way to lose records on the crash path this method exists for.

The bound stays cooperative: a destination that ignores its deadline still
blocks.
