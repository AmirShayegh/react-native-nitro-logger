---
'react-native-nitro-logger': patch
---

The audit sweep: measured performance work across every layer, with byte output pinned unchanged

Six subsystem audits, each finding measured before landing and each landing
behind the tests that pin its behaviour. Log bytes on disk are unchanged
everywhere — the SwiftLogger golden suite is the proof — and no redaction,
durability, ordering or loss-accounting rule moved. The highlights, per
layer:

- **Per-call TypeScript path.** A filtered call — what a production logger
  does most — resolves its subsystem from a bounded memo instead of walking
  the dot hierarchy (291.6 → 31 ns measured), and the six level methods
  return before allocating anything. Delivered calls redact through a
  single-source fast path (720 → 400 ns for five keys). The memo is capped
  at 512 names because caller-supplied strings retained for process lifetime
  are a disclosure surface, not just memory.
- **Formatters.** JSON Lines timestamps come from a whole-second memo
  (~600 → ~30 ns for same-second entries — pure memos, output stays a
  function of the entry alone), budget-fitting an oversize record is no
  longer quadratic (9.6× on shedding, and crash-handler stacks are exactly
  that shape), and the console formatter escapes clean messages without a
  rebuild.
- **Batcher.** The steady-state drain stopped allocating an array per flush
  and the no-loss path stopped building snapshots nobody reads; the batch
  joins once.
- **iOS writer.** Archive-name recognition is a hand scan (93× over the
  per-name regex), retention prunes are linear instead of O(n²), the CRC in
  archive compression is sliced-by-8 (about −45% off whole-archive
  compression, on the queue every append waits behind), directory sweeps
  walk once, opens `stat()` instead of round-tripping `FileManager` (28×),
  and the per-append `fstat` is gone — the failure path re-measures the file
  before any rollback, so a torn batch still truncates to a boundary read
  from disk, never to arithmetic on counters.
- **Android writer.** Appends make one syscall where they made two, rotation
  asks its cheap question before reading any clock, archive sizes are read
  only when a byte cap will use them, the logcat writer budgets lines
  without re-walking the tag per message (with the NUL-costs-two-bytes edge
  pinned), and the purge fence's executor-side read is a volatile load — the
  drop half of that fence is pinned by test; the write stays locked.
- **ESLint plugin and integrations.** The plugin's receiver walk is no
  longer quadratic in file size and its config sets are built once per
  context — 2.9× on the plugin's share of a 5,209-line file, verified
  byte-identical against all 362 extracted rule fixtures, twice. App resumes
  no longer pay a catch-up maintenance sweep on every notification-shade
  bounce.

What did NOT change, deliberately, is recorded too: the declined rewrites
(engine-specific string tricks, a shared scratch buffer a re-entrant
destination could clobber, a process-lifetime key cache) live in the plan and
in code comments, each with the measurement or the hazard that killed it.
