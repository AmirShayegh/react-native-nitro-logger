---
'react-native-nitro-logger': patch
---

Two fixes on the paths that touch caller data: correlation IDs are drawn from
the platform's random source where there is one, and a scope's metadata
snapshot now applies the key rule before it reads a value.

**`newCorrelationId()` prefers `crypto.getRandomValues`.** Resolved on first
successful use rather than decided at import — on React Native a `crypto`
polyfill routinely installs during startup, after this module is first
imported, and a logger that chose once would spend the rest of the process on
`Math.random` with nothing indicating why. A source that later throws is
evicted, so a replacement is picked up. `Math.random` remains the fallback and
always answers: an ID names a unit of work, and failing the call that asked for
one fails whatever was being logged.

Read that as hardening rather than a leak fix. The privacy requirement on a
correlation ID is provenance — that it was generated, not derived from a
patient or record identifier — and `Math.random` satisfied that completely.
What changes is same-session predictability.

**A scope's metadata no longer reads a value behind a key that cannot survive
redaction.** `redactMetadata` was careful never to run a getter behind a
malformed or reserved key, and then `safeSnapshotMetadata` ran it anyway, at
construction. A scope built with a `patient.name` getter fired it on
`logger.scoped(...)`, before any message was logged, so neither level filtering
nor redaction could prevent it. The key is still kept and still counted in
`droppedMetadataCount` — only the read is skipped.

The catalog check deliberately stays at emit and cannot move: `metadataKeyCatalog`
intersects at any time, so a key approved when a scope was built can be
unapproved by the time it emits. The honest form of the guarantee, now written
where the old one was: a getter behind a malformed or reserved key never runs;
a getter behind an unapproved key runs once, at construction, and never again.
