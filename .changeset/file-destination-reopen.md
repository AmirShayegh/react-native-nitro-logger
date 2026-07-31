---
'react-native-nitro-logger': minor
---

`FileDestination.reopen(deadlineMs?)` — the way back from a fence.

A fence is permanent by design, and until now it was permanent in practice.
`purge` promised "disabled until an explicit retry" in two separate comments
and there was no retry to make: a destination fenced by *another* handle's
purge, or by a purge that deleted durably and could not reopen afterwards, was
dead for the life of the process. Constructing a replacement is a poor
substitute rather than an impossible one: on the same canonical path a second
handle is eligible to share the writer when the rotation policy and framing
match, differing ones are a config conflict, and matching them is no promise of
success either — an acquisition still fails on a previous writer that is still
closing, or on the filesystem, or on the lock. Whichever way it goes, the
fenced destination is still alive, holding its retain on the writer and its
registration with whatever logger it was given to, until someone disposes it.

`reopen` closes this handle and opens a fresh one with the same path, rotation
and framing it was constructed with, and returns whether the destination can
write when the call returns. Disposed returns `false` and stays disposed, since
dispose is a release and not a pause. Unfenced returns `true` having touched
nothing — closing a live handle to prove it could be reopened would throw away
the buffer and the file position for a question already answered. A failed open
leaves it fenced, exactly as dead as it was; a failed close does not, because
there was nothing drainable behind a fence and the open is what decides.
`deadlineMs` bounds the close, the only half that waits.

What `true` does not claim: that the file behind the new handle holds what the
old one wrote. After another handle's purge it is a fresh, empty file, which is
the purge working. The new file does not open with a loss notice about the old
one either — the fence clears what was owed on the way in, because a count of
deliberately deleted records describes the deletion, and a fenced destination
accepts nothing afterwards to accumulate a new one.

The retained rotation config is now a frozen **copy** taken at construction
rather than the caller's object. A caller that goes on mutating what it passed
would otherwise have its reopen acquire a policy the first open never used —
and because the registry compares policies to decide whether two handles may
share a writer, a drifted one is not a quiet difference but a config conflict
against a sibling handle that is still open.

No spec change: `open` and `close` were already on `FileSinkLike`, and the
config was already retained — its comment named a native registry reacquisition
path that does not exist, and now names this.
