# react-native-nitro-logger — Engineering Orientation

Structured, **privacy-tiered logging for React Native**: a TypeScript core with
zero runtime dependencies and native file/system-console sinks built on Nitro
Modules (Swift + Kotlin). Current release: **0.4.0 on npm**. The moat is not
feature count — it is *verified* privacy and durability: byte-parity with a
reference implementation, and an on-device probe discipline that reads what
actually landed on disk instead of trusting what the API reported.

**Authoritative documents — read before touching anything non-trivial:**
- `docs/HARDENING.md` — the probe log and checklist. **Verification authority.**
  Every probe records what it proved and what it deliberately does not prove.
- `docs/PARITY.md` — byte-parity decisions against the SwiftLogger reference.
  **Format authority.** Accepted differences are listed; everything else is
  locked by the golden suite.
- `docs/PRIVACY.md` + `docs/API.md` — the privacy model and public surface.
- `docs/internal/LOG-INGEST-001.html` — **scope authority** for the ingestion
  pipeline work tracked in the `ingest-*` phases (v0.6, approved).
- `docs/internal/ANALYTICS-001.html` — **scope authority** for the analytics
  work tracked in the `analytics` phase (v0.7, approved).
- `docs/internal/` is deliberately gitignored: the scoping documents and the
  backlog stay private to the maintainer. If a file named there is missing,
  ask the owner — do not reconstruct it from guesswork.

This file orients you. The hard rules live in `RULES.md` — read it too; it is
not optional.

## The shape of the system

- **TS core** (`src/`): `Logger`/`ScopedLogger` → level gate → privacy
  redaction (`src/privacy.ts`) → pluggable formatters → destinations. The
  batcher + `FileDestination` feed the native `FileSink` over an ArrayBuffer
  wire (0.4.0); `NativeConsoleDestination` feeds os_log/logcat.
- **Native writers** (`ios/`, `android/`): rotation, gzipped archives,
  retention sweeps, crash-tail recovery, externally-deleted-file detection,
  compliance purge with honest reporting. The two implementations are twins;
  parity counts are CI-checked.
- **Privacy model**: `priv()` markers + metadata key catalogs, tighten-only
  settings. Dev builds reveal private values **by design**
  (`__NITRO_LOGGER_PRIVATE_REVEAL__`, stripped from release bundles); release
  builds are fail-closed. The `eslint-plugin/` subpackage is part of the
  privacy story, not tooling garnish.
- **Planned transport**: subpath export `react-native-nitro-logger/remote`
  feeding a Canada-hosted ingestion pipeline (OVH BHS). The root package keeps
  zero runtime dependencies.

## How work is tracked

This project runs on **storybloq** (`.story/`, local-only and gitignored —
the backlog is private): 7 phases, tickets with `blockedBy` edges. Phase
order is the build order, and the phases mirror the scoping documents'
delivery gates: **shipped → hardening → ingest-g0-scope → ingest-g1-gateway →
ingest-g2-client → ingest-g3plus-server → analytics.** Gate-exit milestone
tickets (`G1-EXIT` … `G4-EXIT`, Q1-APPROVAL, the `A*-EXIT` chain, AA-APPROVAL)
are graph constraints — production cutover is transitively blocked by every
one of them, and analytics enablement additionally sits behind the cutover.

`/story` loads context; `/story auto T-XXX` works a ticket; `/story handover`
ends a session.

## The two locks that define "done"

1. **The golden suite is the format definition.** `JsonLinesFormatter` output
   is byte-parity-locked to the SwiftLogger goldens (pinned at `670e183`).
   The suite runs unchanged after every formatter-adjacent commit; a changed
   byte is a failure, not an update. `~/Developer/logger` is the READ-ONLY
   reference repo — never modify it.
2. **The probe checklist is the reality definition.** Tests verify contracts;
   probes verify bytes on a real device through the real production path.
   A release claim that has not survived its probes is a claim, not a release.

## Working style

- Match the surrounding code: naming, comment density, idiom.
- `corepack yarn`, never bare yarn; `npx` for one-offs.
  `ANDROID_HOME="$HOME/Library/Android/sdk"` for Gradle.
- Tests: `corepack yarn test` (JS), `swift test` (ios/), Gradle (android/).
  The `scripts/check-*.sh` gates and 14 CI jobs are the merge bar.
- Verify by bytes, not by claim: run the test, read the output, show the
  failure. "Should pass" is not "passes."
- Releases: changesets → PR → all CI green on the release SHA → merge →
  `corepack yarn release` → registry poll → tag verify → published-tarball
  inspection.

See `RULES.md` for the non-negotiables.
