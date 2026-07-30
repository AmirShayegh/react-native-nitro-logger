---
'react-native-nitro-logger': minor
---

Add `installRejectionHandler()` — unhandled promise rejections reach the log.

React Native installs a promise-rejection tracker in development and none in a
release build, so an `async` function that throws with nobody awaiting it has
been silent in exactly the builds that ship. This is the way to get it back.

The rejection reason goes through the same sanitiser an uncaught error does,
because it is caller data by construction: `Promise.reject(new Error(mrn))` is
an ordinary line to write. What reaches the log is a built-in class name, a
redacted message outside dev, and stack positions in files whose names were
already known.

It does not flush, unlike the crash handler — nothing is dying and the next
ordinary flush carries the entries out. It logs a second entry, at `info`, when
a rejection reported unhandled turns out to be handled after all: a tracker
decides "unhandled" on a timer, so a `.catch()` one turn late would otherwise
leave the log saying a failure went unreported and never taking it back. The two
entries carry the same `rejectionId`, and only the handler that wrote the first
one writes the second — a retraction of something the log never said would be
worse than none.

New exports: `installRejectionHandler`, `REJECTION_METADATA_KEYS`,
`UNHANDLED_REJECTION_MESSAGE`, `REJECTION_HANDLED_LATE_MESSAGE`,
`RejectionHandlerOptions`, `RejectionTrackingLike`, `RejectionTrackingOptions`.
Its `subsystem` option is covered by the `literal-subsystem` lint rule, like the
crash handler's.

Stated limits: chaining links calls to this function and nothing else, because
`enable()` replaces the tracker wholesale and offers no way to read back what
was there; and installing it in development replaces LogBox's rejection popup,
though the entry still reaches every destination, console included.
