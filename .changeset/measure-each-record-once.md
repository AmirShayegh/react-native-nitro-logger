---
'react-native-nitro-logger': patch
---

Every record that reaches the file was being measured twice, and most of them
were being measured the slow way.

`FileDestination` has to compute a record's UTF-8 length to enforce
`maxEntryBytes`, and then handed the record to `Batcher.add`, which computed it
again to do its own byte accounting — two full passes over every log line.
`add(record, recordBytes?)` now accepts the count the caller already has. The
argument is optional and purely an optimisation: omit it and the batcher
measures for itself, and a differential test drives the same corpus both ways
and compares what the batcher *does*, not what it was told. A supplied value
is trusted as an exact measurement — a value that could not be a length at all
is recomputed, but a plausible wrong number is believed, and detecting one
would mean measuring, which is the thing being avoided.

`utf8Length` also gained a fast path for the leading run of ASCII, which is
nearly all of most log lines — it skips the run and adds its length, instead of
adding one per character. Where the run ends, the general loop resumes from
exactly that index.

Neither change moves a byte. The `JsonLinesFormatter` golden fixtures, which
are byte-locked against SwiftLogger, ran unmodified throughout, and
`utf8Length` now has a differential suite against the platform's own
`TextEncoder` over four-byte sequences, unpaired surrogates, and every position
of the ASCII/non-ASCII boundary in a fixed-length string.
