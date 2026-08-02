# react-native-nitro-logger — Non-Negotiable Engineering Rules

These are hard constraints, not preferences. Each exists because violating it
silently leaks private data, loses log records, or breaks a lock the product's
trust rests on. If a ticket seems to require breaking one, stop and surface the
conflict — do not route around it.

## 1. Privacy outranks speed
This library feeds a telehealth app with a "never log PHI" rule. Redaction
correctness beats any performance win; a check that misses a violation is a
privacy failure, not a perf trade. Strict profiles fail closed: a forgotten
wrapper hides data rather than leaking it. An ESLint rule that stays silent on
a violation is itself a defect. (docs/PRIVACY.md)

## 2. Byte parity is locked
`JsonLinesFormatter` output is byte-identical to the SwiftLogger goldens
(pinned `670e183`); the golden suite is the proof and runs unchanged after
every formatter-adjacent change. Accepted differences live in `docs/PARITY.md`
and nowhere else. `~/Developer/logger` is a read-only reference repo — never
modify it. (docs/PARITY.md)

## 3. Probes verify reality; a probe that cannot fail is vacuous
Tests verify contracts; probes read actual bytes on a real device through the
real production path. Every probe carries a positive control proving it would
catch the defect it claims to catch, and every gate states what it does NOT
prove. Decoding is not framing: an independent decoder proves readability,
never structure. (docs/HARDENING.md)

## 4. Redaction probes run only against `--dev false` bundles
Dev builds reveal private values by design, so a redaction probe served by
Metro tests the opposite of the production contract. Drivers grep the bundle
for the reveal sentinel and reject verdicts that do not carry `dev:false`.
(docs/HARDENING.md; src/privacy.ts)

## 5. Durability, ordering, and drop accounting are load-bearing
`flush → durable`, record ordering, loss accounting, and file protection modes
are contract, not implementation detail. Changes touching them land guard-test
first; rollback paths never truncate blindly to a tracked value. Every dropped
byte is counted and reported in-band.

## 6. Mutation discipline
Every new check is mutation-tested against the defect it claims to catch and
must fail for the right reason. The pinned mutants in
`scripts/mutants/manifest.json` stay killable. Deliberate-break probes restore
via `cp` backup from a scratchpad — never `git checkout <file>`.

## 7. ABI changes follow the preflight discipline
Any Nitro spec change is preflighted with old binary + new JS on both
platforms; the *measured* failure shape is recorded in the changeset, and
OTA-safety is stated plainly ("native rebuild required" when true). The 0.3.x
lesson is structural, not folklore. (CHANGELOG 0.4.0)

## 8. Releases are gated, then verified
Changesets → PR → all 14 CI jobs green on the release SHA → merge →
`corepack yarn release` → registry poll → tag dereference check → published
tarball inspected. A release that skipped a step is not a release.

## 9. No time-based estimates
Plans and roadmaps are ordered gates with exit criteria — probes, reviews,
sign-offs. Policy numbers that are commitments (retention days, cost, RTO)
are fine; durations are not.

## 10. Process
No AI co-author lines in commits. Independent reviews (codex-bridge) iterate
to approve before a unit's commits are final; findings are dispositioned,
never silently dropped.

---

*When in doubt, re-read the cited document. These rules are downstream of
measured failures — each one was earned.*
