---
'react-native-nitro-logger': minor
---

`FileDestination.deleteSupportBundle(deadlineMs?)` — the third step of a
support flow.

The flow is **collect → upload → delete**, and until now it stopped at two.
`collectForSupport` writes a gzipped copy of the whole log beside the log
files, and nothing reclaimed it: the retention sweep deliberately keeps a
*finished* bundle, because somebody may still be uploading it, so the copy sat
outside the rotation budget the app configured until a `purge()` or the next
collect happened to replace it. On a device holding regulated data that was the
one artifact retention never came back for, and the app had no way to remove it
short of deleting everything.

This deletes exactly the bundle and its two staging leftovers — the half-written
`.part` and the `.member` scratch a plaintext source is compressed into, both of
which hold log bytes — through the same `supportName` / `supportStagingName` /
`supportMemberName` helpers `isArtifactName` is built from, so the two lists
cannot drift apart. It is not a smaller `purge()` and deletes no log file; the
Swift and Kotlin tests assert the file list is unchanged across the call, and a
mutant that swept by `isArtifactName` instead — which is what a purge does —
turns that assertion red on both platforms.

`true` means no bundle artifact remained when the call ran, including vacuously
for a sink that never opened. That is a statement about an instant and not a
promise about the next one: a collect started afterwards writes a new bundle,
and sequencing the two is the caller's job. `false` is the whole of the rest and
deliberately not a list of causes — refused, timed out, threw, or absence could
not be *durably* confirmed — and it asserts nothing about what survived, since a
refusal never looked. Read it as "assume a copy may still be there".

Absence is success — deleting a bundle that is already gone is the outcome the
caller asked for, and only `ENOENT` on iOS / `Presence.ABSENT` on Android counts
as absent, so a directory that has stopped answering reports a survivor rather
than a clean sweep.

A fenced or disposed destination refuses. The first draft of this let a disposed
one delete, reasoning from `getLogFilePaths()` still answering after `dispose()`
— and review caught that the analogy is backwards. Reading a directory this
object no longer owns is harmless; deleting from it is not. With the handle gone
there is no writer generation left to check, so another destination may own that
path and be part-way through publishing into it, and the `.support.gz` removed
would be *its* bundle, whose path it has already handed to a caller. Delete
before disposing, or through a fresh destination on the same path — both give a
live handle on a current generation, which is what makes the deletion safe
rather than merely willing.

**Liveness is not currency, and the same review caught that too.** The registry's
gates (`isLive`, `liveGeneration()`) say a handle is *active*; they do not say it
is *current*, which is why `appendBatch` has always passed its generation down
for the writer to check. Deletion now does the same, and the check runs on the
writer's own queue immediately before the unlinks rather than at the call site —
so a purge that lands while the task waits its turn is seen. A stale append adds
a record to somebody else's file; a stale delete removes somebody else's bundle.
Both platforms have a test where a sibling purges and then collects, and the
handle left behind — never closed, so every liveness gate says yes — is refused
and the current generation's bundle survives. A mutant dropping the check turns
that test red on both.

**A timed-out delete is abandoned, not merely unreported.** This was found by
the test rather than designed in: the first version left its queued unlink in
place, and the race test caught it reaching the front of the writer's queue
*after* a slow build published — deleting a bundle a later collect had just
handed back the path of, seconds after the call that returned "I deleted
nothing". The fix is the barrier `CollectHandoff.giveUp` already puts in front
of a publish, pointed the other way: the caller marks its own request abandoned
under a monitor before returning `false`, and the queued task asks whether it is
still wanted before it unlinks anything. Both platforms; a mutant that ignores
the flag turns the race test red on both. The window that stays open is the
terminal one — a task already past that check runs to completion, so a caller
can be told `false` about a deletion that then happens — which is safe in the
direction it fails (a retry says `true`) and cannot take a later bundle, because
the queue is serial and any subsequent publish is a later task.

The Nitro spec gains one method, and `nitrogen` regenerated additively: 42
inserted lines, nothing removed or reordered.

**On running new JavaScript against an older native binary.** The 0.2.0 review
left this unverified and warned it could differ by platform. It cannot, and the
reason is structural: the method table is registered by
`nitrogen/generated/shared/c++/HybridFileSinkSpec.cpp`, one shared translation
unit compiled into both platforms' binaries, so iOS and Android cannot disagree
about which methods a prototype has. Construction is unaffected —
`NitroModules.createHybridObject('FileSink')` passes a name and nothing else,
with no JS-side spec to check a shape against, and TypeScript types are erased
by then. So a 0.2 binary yields a working sink whose prototype simply has no
`deleteSupportBundle`; the call fails at invocation, inside the wrapper's own
`try`, and the caller gets `false`. **What was not done: an on-device run of 0.3
JavaScript against separately built 0.2 iOS and Android binaries.** The above is
read off the generated registration code and nitro-modules 0.36.3's runtime, not
measured on a device, and it is recorded that way rather than as a tested
guarantee.

Floors: JS 976 → 985, Swift 214 → 221, Kotlin 209 → 215.
