---
'react-native-nitro-logger': minor
---

Batches cross the bridge as bytes — 0.4.0 needs a native rebuild, and this JavaScript over a 0.3.x binary is not OTA-safe

`appendBatch` now takes an `ArrayBuffer`. The batch is encoded to UTF-8
exactly once, in TypeScript, with the `TextEncoder` Hermes has shipped since
well below this package's React Native 0.78 floor; the bytes cross the bridge
as they are, and each adapter makes one copy into memory the writer owns.
Through 0.3.x the same batch crossed as a String — UTF-16 on the wire, roughly
twice the bytes for JSON Lines — and was then re-encoded to UTF-8 a second
time on the native side, on Android under the handle lock. What lands on disk
is byte-identical; the 21 SwiftLogger goldens run unchanged as the proof.

For a caller the only shape change is `FileSinkLike`: a custom sink's
`appendBatch` now receives an `ArrayBuffer` of UTF-8 bytes where it received a
`string`, and the compiler points at it.

**The cost is the wire type, and it is a real compatibility break.** A 0.3.x
binary registered `appendBatch(std::string)`; 0.4.0 JavaScript hands that
binary an object. This was measured, not inferred — on both platforms, a
consumer app compiled against the published 0.3.0 tarball with this release's
JavaScript delivered over it, which is the OTA pairing exactly:

- Construction succeeds. The method names did not change, so nothing fails at
  startup, where a failure would at least be visible.
- The bridge rejects every batch. The raw sink call throws
  `FileSink.appendBatch(...): Value is an object, expected a String` — `at
  appendBatch (native)` — on both platforms.
- Through `FileDestination`, nothing throws at any logging call site. The
  batcher treats a throwing sink as a failing sink: every flush returns
  `durable: false` with `unreportedEntries`/`unreportedBytes` climbing
  (measured: 1 entry owed after the first flush, 2 after the second — 141
  then 286 bytes on iOS, 137 then 278 on Android; the second batch also
  carries the loss notice for the first, and loses it the same way), while
  `degraded` stays `0`, `isEnabled` stays `true`, and the signature-unchanged
  methods keep answering normally (`getLogFilePaths` returned the opened
  file; `deleteSupportBundle` returned `true`). Every record is lost,
  silently, for as long as the pairing runs.

So: ship 0.4.0 as a native release, never as an over-the-air JavaScript
update onto a binary built from 0.3.x. The mismatched app runs, looks
healthy, and writes nothing to disk; the only runtime signals are `flush()`'s
`durable: false` and its unreported-loss counters.
