# react-native-nitro-logger — Implementation Plan

> **Approved 2026-07-27** after six codex-bridge review rounds (final verdict: approve, zero findings).
> Codex review session `019fa702-efeb-7483-8d2e-041545a4414d` — reuse for `review_code` during implementation.
> Review history: R1–R5 revise (privacy scope → backpressure boundary → liveness/hard bound → fs permissions/purge/deadlines/backup/privacy-default → key catalog + purge state machine) → R6 approve.
> Known issue: the bridge's Gemini provider fails (RESPONSE_PARSE_ERROR), so deliberate-mode reviews degraded to Codex-only.

## Context

RN port of SwiftLogger (`/Users/amirshayegh/Developer/logger`) for the telehealth patient app + standalone OSS. Hard never-log-PHI rule → privacy tiering, redact-no-reveal. **Kotlin question: No** — all logic once in TS; native is a dumb sink (~400 lines/platform); Kotlin sink is M8, never a prerequisite.

**Locked:** this repo (`~/Developer/react-native-nitro-logger`) · chime-rn-aligned tooling (Nitro ^0.36, Yarn 4 `nodeLinker: node-modules`, CRNL scaffold, New-Arch-only, RN ≥ 0.78, builder-bob, changesets) · v1 = TS core + console + privacy + native file sink (rotation+gzip) + JSON Lines + os_log/logcat + error handler + AppState flush · dropped: per-file overrides, highlight(), file/function/line · npm name `react-native-nitro-logger` (checked available 2026-07-27).

## Privacy contract

**Privacy default:** `Log.privacyDefault('private' | 'public')` — first-set-wins, tighten-only thereafter. `'private'`: every metadata value redacts in prod unless wrapped `pub(v)` (fail-closed — one forgotten wrapper hides data, never leaks it). `'public'` (OSS default, documented): values render unless wrapped `priv(v)`. The telehealth app sets `'private'` in its entry point. Both wrappers always available.

**Runtime validation:** at emit, metadata accepts only exact primitives (string/number finite/boolean) and PrivateValue/PublicValue markers recognized via **module-private WeakMap membership** (foreign lookalikes fail naturally). **Wrapper payloads are validated twice — at `pub()`/`priv()` construction AND at unwrap** (`pub({patient})` via `any` must not smuggle an object past primitive validation): objects, arrays, proxies, non-finite numbers, nested markers rejected with the fixed diagnostic. Arrays, objects, proxies, unsupported numbers as bare values likewise dropped, payload-free (count only). Tested via JS + `any` bypasses on both bare values and wrapped payloads.

**Privacy-aware fields (runtime redaction; runtime absence tests):** metadata per the default above; uncaught-error messages (never raw in prod — built-in error classes → fixed tokens via allowlist, unknown → `"Error"`; stack frames emit **line/column plus basename only when it matches the app's known bundle names, else a fixed token** (a regex-valid basename can carry PHI); unrecognized lines discarded); `redactAllMetadata()` tighten-only.

**Public-by-contract fields (build-time enforcement; lint-fixture tests):** message — string literal or approved constant; eslint-plugin `strict` rejects variables/concat/interpolation/calls/conditionals/dynamic thunk bodies, **with bypass fixtures for aliasing, destructuring, wrappers, call/apply, and JS files linted in CI**. correlation — **branded type**: `Log.newCorrelationId()` returns `CorrelationId` (short-lived random); `strict` flags raw-string correlation args; README prohibits record-derived/hashed IDs. subsystem — `strict` requires literal constants. metadata keys — `^[A-Za-z0-9._-]{1,64}$` at runtime, `strict` rejects computed keys and object spreads, and **the telehealth/strict profile requires a mandatory, fail-closed approved-key catalog: exact membership enforced in lint AND at runtime for direct and scoped metadata — unknown keys dropped with the fixed diagnostic** (computed-key rejection alone still admits literal PHI keys like `patient123`). The catalog hook is optional only in the general OSS profile. Fixtures for PHI-lookalike keys in both profiles. Full hardened-API/banned-import architecture is app-side integration guidance, not SDK v1 (rationale stated in README).

PrivateValue/PublicValue payloads in module-private WeakMaps — no enumerable raw field; stringify/spread/String()/inspect yield placeholder (tested). Reveal branch `__DEV__`-gated, no loosen API (type-level test), redaction before entry construction. CI: release bundle `--dev false` → reveal-sentinel absent + runtime probe writes `<private>`; `lib/` `__DEV__` grep. README compliance boundary: reveal-capable builds = synthetic data only.

## Sink contract

String payload; no callbacks; batch = atomic loss unit.

```ts
interface SinkStatus  { queuedBytes: number; lostBytes: number; lostEntries: number;
                        degraded: number /* payload-free error-code bitmask: rotation, gzip, prune, sidecar, protection */ }
interface AppendResult extends SinkStatus { accepted: boolean;
                        rejectReason?: 'full' | 'staleGeneration' | 'closed' | 'failed' }
interface FlushOutcome extends SinkStatus { durable: boolean; timedOut: boolean; pendingBytes: number }

FileSink:
  readonly defaultLogDirectory: string
  open(path, rotation?): void            // throws on failure OR config conflict
  appendBatch(batch: string, entryCount: number): AppendResult
  getStatus(): SinkStatus                // non-enqueuing; MUST NOT wait behind writer I/O:
                                         // depth/loss/degraded state under atomics/short non-I/O lock
  flush(deadlineMs: number): FlushOutcome  // wall-clock-bounded; default 2000; never OS-watchdog territory
  close(deadlineMs: number): FlushOutcome  // deadline-aware like flush; hung write cannot block disposal forever
  getLogFilePaths(): string[]
  clearLogs(deadlineMs: number): { deletedCount: number; failedPaths: string[]; durable: boolean }
                                         // registry-serialized, deadline-aware; reports incomplete purge honestly
```

- **Loss accounting:** per-writer **monotonic totals + per-handle cursors, split into observed vs durably-acknowledged** — a handle advances its ack cursor only after the consolidated loss notice it wrote has flushed durably (observing a loss must not erase it before its notice survives; a crash between observe and ack yields a duplicate notice, which is acceptable and documented). Losses attributed per originating handle/batch.
- **Reject semantics:** JS distinguishes `full` (hold + poll, normal backpressure) from `staleGeneration`/`closed` (discard the pending buffer, baseline loss state, reacquire or self-disable — never transparently replay pre-purge data) from `failed`.
- **Hard bound:** accepted UTF-8 payload bytes stay **reserved from atomic acceptance until terminal write completion**; 1 MB cap enforced atomically across runtimes; documented as a payload bound, not process-memory. `entryCount` validated both sides (positive bounded safe integer; empty/nonempty mismatch rejected before reservation). JS adds a **pending-byte cap (512 KB)** alongside the 1000-entry cap.
- **Write integrity:** write-all with retry; on terminal failure **truncate to the recorded pre-batch offset** before counting the batch lost (no half-written JSONL); startup scan trims an incomplete final record — **only under a declared single-line framing contract**: built-in formatters guarantee one escaped record per line; a custom formatter must declare `framing: 'line'` to opt into tail-trim, otherwise crash-tail recovery is documented as reduced (native can't find record boundaries in opaque multi-line text). Short-write fault injection at multiple byte boundaries.
- **Purge flow:** deletion is exposed at the Logger/FileDestination layer, not raw sink: discard all local JS buffers (counted) → native `clearLogs(deadline)` under the registry lock with a **writer-generation bump**; stale handles get `staleGeneration` rejects (behavior above). **State ordering: the invoking handle rebinds to the new generation only after durable purge success.** On timeout/partial failure, deletion work stops where possible and ALL affected generations stay fenced/disabled until an explicit retry or recovery completes — new writes can never race a late deletion; the structured outcome reports the resulting writer state. **The deletion set is the complete artifact naming scheme**: current file, sidecar, archives, gzip temporaries, staging/recovery files under the canonical log directory — an interrupted compression must not leave a plaintext orphan surviving a compliance purge. Any failed removal or deadline overrun → `durable: false`.
- **Rotation degradation:** rotation/gzip/prune/sidecar failures set `degraded` codes and back off boundedly — a failed rotation must not retry on every append. Sustained-logging-after-fault tests.
- RotationConfig: **`maxFileSizeBytes`, `maxArchivedFilesCount`, `maxFileAgeSeconds?`, `compressArchives`, `maxArchiveAgeSeconds`, `maxTotalLogBytes`**; retention sweep at open() AND each rotation (background maintenance timer deferred v1.1 — an idle process writes nothing, sweep-on-rotation covers active ones). All numeric config validated in TS AND re-clamped natively.
- **Registry:** create the parent dir first, then key on **realpath-resolved normalized path**; reject symlink escapes; atomic acquisition; conflicting re-open throws; **Nitro native finalizer releases the refcount** even when abrupt runtime destruction skips JS `dispose()`. Cross-process out of scope, documented.

NativeConsoleSink: `install(subsystem, category)`, `logBatch(levels[], messages[])`; os_log level map verbose/debug→debug, info→info, warning→default, error→error, todo→fault; Android `Log.println`.

## Batcher & pipeline

4096-byte/100 ms flush; caps 1000 entries AND 512 KB; drop-newest; notice appended after retained entries. Oversized entries (structural): JSON formatter truncates at field level — drop metadata fields deterministically, then truncate message at code-point boundaries to the final UTF-8 limit; oversized custom-formatter output is replaced by a fixed valid notice, never sliced. Watermark pause (256 KB) → `getStatus()` poll on bounded 100 ms timer (canceled on dispose/flush) → resume on clear. Loss cursors consumed on every append/status → consolidated notice rides the next batch. `flush(deadline)`: bounded loop (drain JS→native in watermark steps, native flush between, consolidated notice, final flush) returning `FlushOutcome` — under persistent ENOSPC it reports `durable:false` with preserved losses (tests assert the honest outcome, not impossible durability). Logger pipeline: guarded lazy eval (throwing thunk → fixed safe entry); per-destination isolation (one throwing destination never blocks siblings; repeatedly-failing destinations disabled with payload-free diagnostics; no recursion); destination `dispose()` lifecycle + Fast Refresh teardown hook. Integrations: `installErrorHandler()`/`flushOnBackground()` return idempotent uninstall handles; error-handler uninstall restores the previous handler only if ours is still installed; `inactive`→`background` double-flush is a constant-time no-op when nothing is pending.

## Native sinks

**iOS** — vendored `LogFileWriter.swift` (from SwiftLogger's `FileDestination.swift`) with full recovery invariants (serial queue + inline-flush guard, O_APPEND, descriptor-liveness/external-delete detection, reopenOrFail, checked move/gzip/prune, mod-date prune sort). **Secure-create helpers are type-specific: 0700 directories, 0600 files** — with assertions that modes hold and traversal works across creation/rotation/gzip-failure/reopen/clear. Protection class `NSFileProtectionCompleteUntilFirstUserAuthentication` + backup exclusion on every artifact (dir, current, temp gzip, archives, recreated files). Retention sweep per config. No Nitro imports → XCTest-able. Thin `HybridFileSink.swift` adapter.

**Android** — single-thread executor daemon; **logs live under `noBackupFilesDir/logs`** (`filesDir` is Auto-Backup-eligible); `renameTo()` checked; `GZIPOutputStream` streaming; `fd.sync()`; age via `creationTime()` (API ≥ 26) or sidecar `<name>.meta` below (lastModified is bumped by every write and cannot carry age); sidecar + artifacts through the same helpers; assert resolved directory in tests.

## Tests

- Jest via constructor-injected scriptable `MemoryFileSink`: levels/tags; subsystem walk; scope merge; batcher (watermark pause → `getStatus` poll resumes; rejected-batch retention; cap engagement + notice count/placement; oversized structural truncation; loss folding); file destination (open-throw fallback, config-conflict throw, replace-by-label dispose); error handler (allowlist tokens, hostile stacks); AppState; lazy-not-evaluated; pipeline isolation; flush bounded loop + persistent-failure honesty.
- Privacy, two planes: (a) runtime absence — sentinel PHI through `priv()`/default-private values, scope + nested-child metadata, `Error.message`/cause chain, `__DEV__` false → sentinel in no console spy / file payload / native-console batch; wrapper hardening (stringify/spread/String/inspect); wrapper-payload bypass via `any` at construction and unwrap. (b) build-time — ESLint invalid-code fixtures (variables, concat, interpolation, calls, conditionals, dynamic thunk bodies, aliasing, destructuring, wrappers, call/apply; PHI-lookalike literal + computed keys in direct and scoped metadata). Type-level no-reveal-API test.
- JSON goldens vs SwiftLogger fixtures (~10 canonical + documented delta cases; parity claim: field-and-order compatible, byte-identical for the interoperable subset).
- Native: rotation threshold, archive regex, gzip round-trip + failure, prune order, fault injection (ENOSPC, EACCES, external delete of file/dir, failed rename, failed gzip → recovery + loss accounting), dir traversal/mode assertions, pre-26 sidecar age across restarts (Robolectric), concurrent registry acquire/release, purge-vs-buffered-JS with generation fencing, post-purge logging from invoking + second handle, hung-writer flush/close/clearLogs deadlines, blocked-writer getStatus latency, observed-vs-acked loss cursors with failed notice write, byte reservation across in-flight writes, short-write truncation + startup trim, purge sweep of orphan gzip temp/staging artifacts, formatter framing contract, sustained logging under rotation/gzip/prune faults, archive-age expiry without restart, Android noBackup assertion, stalled-writer stress with memory watermark, abrupt-runtime finalizer.
- CI: release-bundle privacy job (`--dev false`, reveal-sentinel absent + runtime probe) · `lib/` `__DEV__` grep · nitrogen regen diff · min-RN native iOS consumer (RN 0.78 compile+launch+exercise) · JSON goldens. Per-platform compat claims: iOS ≥ 0.78 CI-verified; Android verified at the example's RN version, 0.78 experimental until its own consumer job (v1.1).

## Milestones

- **M0 — Scaffold + vertical Nitro spike.** ~~npm name check~~ (available 2026-07-27); CRNL nitro-module scaffold; workspace lift; nitrogen generates BOTH platforms from the real specs (object returns + native finalizer verified); minimal Swift+Kotlin impls compile; append/flush/status on iOS sim + Android emulator; sink contract provisional until green; CI skeleton.
- **M1** TS core (types/levels/config/Logger/ScopedLogger/Console/DefaultFormatter) + suites.
- **M2** Privacy (privacyDefault, WeakMap wrappers + double validation, runtime validation, sentinel suite, eslint-plugin + bypass fixtures, key catalog).
- **M3** JSON formatter + SwiftLogger goldens (fixture side quest in the Swift repo) + parity matrix doc.
- **M4** Batcher + FileDestination vs MemoryFileSink (full backpressure/liveness/loss-cursor semantics against the fake).
- **M5 ★** iOS `LogFileWriter` (recovery invariants, secure-create, registry + generation, fault injection) + XCTests; example-app manual pass; 10k-burst bridge-cost sanity.
- **M6** os_log sink; Xcode Console interleaving verified.
- **M7** Error handler + AppState flush; release-bundle privacy + min-RN CI jobs live; Release-scheme privacy check.
- **M8** Android sink (noBackup dir, sidecar age, JUnit/Robolectric + emulator pass). Not blocking M5–M7.
- **M9** README (privacy contract + compliance boundary, per-platform compat table, parity matrix, batching semantics), ARCHITECTURE.md, changesets, npm trusted-publishing pipeline, publish dry-run.

## Right-sized / deferred (rationale)

Cross-process locking (no extension use case; in-process handled by registry+generation) · Android-0.78 native CI job (claim narrowed instead; v1.1) · classic-TM escape hatch documented-not-built · property-based JSON fixtures (goldens+deltas v1) · `collectLogsForSupport()` (consent/encryption design first; `getLogFilePaths()`+purge are the hooks) · promise rejections v1.1 · background maintenance sweep timer v1.1 · hardened app-side telehealth API layer (banned imports/provenance) = app integration guidance, not SDK surface.

## Risks

Nitro 0.x churn (exact-pin example, `^0.36.0` peer range, M0 spike verifies shapes+finalizer) · sync flush deadline-bounded, crash-path mandate only · backgrounded timer freeze (AppState flush; headless-task logs wait) · `ErrorUtils` de-facto-stable undocumented RN global · pending user calls (non-blocking): keep `todo` level name; example RN pin cadence.

## Manual verification script (example app)

1. "Log 100" → Metro console + on-disk JSON lines. 2. "Burst 5000" (with natively stalled writer) → drop notice with plausible count. 3. "Log priv()" → dev shows value; **Release build shows `<private>` in file and Xcode console**. 4. Tiny-rotation config → gzipped, pruned archives. 5. "Throw uncaught" → relaunch → `error.name` + frames on disk, message redacted. 6. Background mid-burst → foreground → tail on disk. 7. Console.app / logcat filtered by subsystem → JS + native logs interleave. 8. "Purge" → all artifacts gone incl. temp/staging; second runtime's stale handle discards, doesn't replay.
