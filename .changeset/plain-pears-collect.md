---
'react-native-nitro-logger': minor
---

`collectForSupport()` — one gzip bundle of the whole log, for a support upload.

`getLogFilePaths()` has been there since 0.1.0 and it is the wrong shape for
what people actually do with it. An app that wants to attach its logs to a
support ticket gets back a list of paths, and then has to read each one, work
out that some are gzipped and some are not, and reassemble them in an order the
filenames only approximately describe — the active file is the newest, the
archives count backwards, and a rotation landing mid-collect changes the
answer. Every app that does this writes the same code, and most of them get the
ordering wrong.

`FileDestination.collectForSupport({ maxTotalBytes })` does it once, natively,
on the writer's own queue where a rotation cannot land halfway through. It
returns a `CollectOutcome` with the path of a single `.gz` file that `gunzip`
turns into the whole log as chronological JSON Lines.

That works because gzip is a multi-member format: concatenated members
decompress as one stream. Archives that are already compressed are copied in
byte for byte — no decompress-recompress cycle, no second compression path to
maintain — and the flushed active file is compressed in beside them through the
compressor the writer already owns. The JS buffer is flushed first, so records
written a moment ago are in it.

**`maxTotalBytes` is required and `Infinity` is refused.** How much of a log
leaves the device is the application's decision, and a default would be this
library making it. It is measured on the source bytes rather than the
compressed result — a ceiling you can only check after compressing does not
bound the work — and applied newest-first, so a ceiling smaller than the log
keeps the recent end, which is the end somebody debugging is asking about. A
negative or non-finite value throws a `RangeError` rather than being read as
"no ceiling", and the natives independently clamp such a value to zero: the
direction a broken number has to fail in is sending nothing, never sending
everything. Zero is legitimate and produces no bundle at all.

Read `complete` before `path`. `complete: true` with an empty `path` is a
device with no logs, which a support flow should report as "nothing to send"
rather than as a failure; `complete: false` means the collect did not finish
and there is no bundle. `truncated` is orthogonal and ordinary — the ceiling
was reached.

The bundle lands at a fixed name inside the sink's own directory, never a path
the caller picks: a support feature is not a reason to ship a
write-a-file-anywhere primitive, which is also why `readLogFile(path):
ArrayBuffer` was rejected in favour of this. It is written to a staging name and
renamed, so an interrupted collect leaves something the retention sweep
recognises rather than a plausible-looking `.gz` no tool can open. At most one
exists — each collect replaces the last — and both names join the artifact
predicate, so `purge()` deletes them; a compliance deletion that left a gzipped
copy of the log behind would not be a deletion. It is excluded from
`getLogFilePaths()`, from the archive count and from `maxTotalLogBytes`.

Not built, and recorded as decisions in `docs/PRIVACY.md` rather than left as
gaps: no upload, and no app-layer encryption. Transmission needs a consent flow
and a retention policy at the far end that belong to the application; the
bundle is already encrypted at rest by the platform under the same protections
as every other artifact, and a decryption key shipped inside the app that reads
it would be theatre.

A collect the caller stopped waiting for does not publish. The build cannot be
cancelled mid-copy — nothing cancels a queued block — so it is stopped at the
rename instead: it deletes its staging file rather than putting a bundle in
place. Without that, a call that reported "no bundle" would drop a complete
second copy of the log beside the log seconds later, outside the retention
budget the app configured and skipped by the orphan sweep, because a *finished*
bundle is one somebody may be about to upload.

The handoff is per collect rather than per writer, and the rename happens
inside it. Both matter. Per collect, because one caller's timeout must not
abandon another caller's build and must not poison every collect after it; and
the rename inside the barrier, because that is what makes "did this publish?" a
question with a single answer rather than a window measured in whatever timeout
seemed generous. Both suites pin all three with a compressor slow enough to
overrun the deadline: one collect that overruns publishes nothing, two that
overrun publish nothing, and a collect after an overrun one still works.

What this does not prove. The Swift suite decompresses with the real `gzip -dc`
binary, which is the tool a support engineer would use, but the Kotlin suite
reads with `GZIPInputStream` — a second implementation of the same format, not
the same one. Neither says anything about what an upload endpoint does with the
file afterwards.

Nothing reaches the offset rollback that undoes a member whose copy died
halfway. Staging one needs a read or a write that fails *part way through* a
256 KB chunk, and neither writer has a seam for that; the member failures the
suites can stage all fail before a byte is written, where the rollback is a
no-op. It is kept because the failure is real on a device even though the
harness cannot produce it.

And the order of two archives written inside the same millisecond is undefined
— archives sort by modification time and the name only breaks exact ties. The
tests buy that separation explicitly; production rotations, which are megabytes
apart, get it for free.
