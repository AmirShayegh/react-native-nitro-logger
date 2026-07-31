import type { HybridObject } from 'react-native-nitro-modules';

/**
 * Rotation and retention policy for one log file.
 *
 * All numeric fields are validated in TypeScript (finite safe integers,
 * positive sizes, bounded counts) AND re-clamped natively before integer
 * conversion — a NaN/Infinity/negative must never trap a Swift/Kotlin cast.
 */
export interface RotationConfig {
  /** Soft threshold; overshoot bounded by one batch. */
  readonly maxFileSizeBytes: number;
  /** Archives to retain by count; 0 keeps none. */
  readonly maxArchivedFilesCount: number;
  /** Rotate the current file once this old, regardless of size. */
  readonly maxFileAgeSeconds?: number;
  /** Gzip archives as they rotate out. */
  readonly compressArchives: boolean;
  /** Delete archives older than this even if under the count cap. */
  readonly maxArchiveAgeSeconds?: number;
  /** Bound on current file + all archives combined. */
  readonly maxTotalLogBytes?: number;
}

/** Why an appendBatch was not accepted. */
export type RejectReason = 'full' | 'staleGeneration' | 'closed' | 'failed';

/**
 * Snapshot of sink health. MUST be served from atomics / a short non-I/O
 * lock — never from the writer queue — so a paused Batcher can poll it while
 * the writer is stalled on disk.
 *
 * Loss fields are per-handle observed counters (monotonic writer totals with
 * per-handle cursors underneath); observing a loss here does NOT acknowledge
 * it — acknowledgement happens only after the consolidated loss notice has
 * durably flushed.
 */
export interface SinkStatus {
  readonly queuedBytes: number;
  readonly lostBytes: number;
  readonly lostEntries: number;
  /** Payload-free degradation bitmask: rotation|gzip|prune|sidecar|protection|exclusivity. */
  readonly degraded: number;
}

export interface AppendResult {
  readonly accepted: boolean;
  /** Present only when accepted is false. */
  readonly rejectReason?: RejectReason;
  readonly queuedBytes: number;
  readonly lostBytes: number;
  readonly lostEntries: number;
  readonly degraded: number;
}

export interface FlushOutcome {
  /** True when every previously accepted byte reached storage and fsync. */
  readonly durable: boolean;
  readonly timedOut: boolean;
  readonly pendingBytes: number;
  readonly queuedBytes: number;
  readonly lostBytes: number;
  readonly lostEntries: number;
  readonly degraded: number;
}

export interface ClearOutcome {
  readonly deletedCount: number;
  readonly failedPaths: readonly string[];
  /** False when any artifact survived or the deadline elapsed. */
  readonly durable: boolean;
  /**
   * Whether the writer came back with a usable file afterwards.
   *
   * Separate from `durable` because they are separate facts and the caller
   * needs both. A purge can delete everything it was asked to — `durable` —
   * and still fail to reopen, on a directory that has become unwritable or a
   * volume that filled. Resuming on `durable` alone hands records to a writer
   * with nowhere to put them: every one is accepted, then rejected as
   * `staleGeneration`, then dropped.
   *
   * Resume only when both are true. `durable && !rebound` means the deletion
   * is genuinely complete — which is what a compliance caller asked — but the
   * destination must stay fenced until an explicit retry gets a live file back.
   */
  readonly rebound: boolean;
}

/**
 * What `collectLogs` produced.
 *
 * `complete` and `truncated` are separate facts and a caller needs both.
 * `truncated` is an ordinary successful outcome — the caller set a byte
 * ceiling and the logs were bigger than it — while `!complete` means the
 * operation did not finish and there is no bundle to send.
 */
export interface CollectOutcome {
  /**
   * Absolute path of the bundle, or `''` when none was produced.
   *
   * Always inside the sink's own directory and always the same name, so a
   * collect can never write anywhere the caller chooses. A general
   * write-a-file-here primitive is not what a support flow needs and is a
   * much larger thing to have to defend.
   */
  readonly path: string;
  /** Size of the bundle on disk. Zero when `path` is empty. */
  readonly byteCount: number;
  /** How many log files went in. */
  readonly sourceFileCount: number;
  /**
   * Some log files were left out.
   *
   * Two causes, both meaning the bundle is not the whole log: the byte
   * ceiling was reached, or a file could not be compressed into the stream.
   * Which files went in is answered by `sourceFileCount` against
   * `getLogFilePaths().length`, not by a reason string that would have to
   * name a path.
   */
  readonly truncated: boolean;
  /**
   * The collect ran to the end of what it set out to do.
   *
   * False means it was cut short — the deadline expired, the bundle could not
   * be written — and `path` is empty. True with an empty `path` means there
   * was nothing to collect, which is a different answer from a failure and
   * one a support flow should not report as an error.
   */
  readonly complete: boolean;
}

/**
 * Dumb native file sink. All intelligence (batching, backpressure, drop
 * accounting, formatting, redaction) lives in TypeScript; this object only
 * appends pre-batched text, rotates, compresses, and reports counters.
 *
 * One JS FileDestination = one FileSink handle; handles for the same
 * canonical path share one process-global writer (registry, refcounted,
 * generation-fenced). Batch = atomic loss unit.
 */
export interface FileSink extends HybridObject<{
  ios: 'swift';
  android: 'kotlin';
}> {
  readonly defaultLogDirectory: string;

  /**
   * Throws on open failure OR on config conflict with an existing writer.
   *
   * `lineFramed` declares that every batch handed to `appendBatch` contains
   * whole records terminated by `\n`, with no raw newline inside a record.
   * Only then may the startup scan trim an incomplete trailing record: with
   * opaque multi-line text a writer cannot tell a torn record from an
   * intentional one, and trimming would destroy good data. Absent — the
   * default for a custom formatter that does not declare `framing: 'line'` —
   * the file is left exactly as the crash left it and recovery is reduced.
   *
   * Returns once the file is open and any torn trailing record has been
   * trimmed. The retention sweep is *queued*, not awaited: a `getStatus()`
   * taken immediately afterwards can still report the state from before the
   * sweep ran, so a clean `degraded` here does not mean retention succeeded.
   * The sweep runs unbounded directory I/O — listing, pruning by age, by count
   * and by total size — and waiting for it would make every open block on a
   * backlog the caller has no way to bound.
   */
  open(path: string, rotation?: RotationConfig, lineFramed?: boolean): void;

  /**
   * Enqueue only — never performs I/O inline. Atomic accept/reject BEFORE
   * enqueue against the hard shared payload cap; accepted bytes stay
   * reserved until terminal write completion. entryCount travels with the
   * queued item for exact loss accounting.
   */
  appendBatch(batch: string, entryCount: number): AppendResult;

  /** Non-enqueuing health probe; safe to poll while the writer is stalled. */
  getStatus(): SinkStatus;

  /** Wall-clock-bounded synchronous drain + fsync. */
  flush(deadlineMs: number): FlushOutcome;

  /** Deadline-aware disposal; a hung write cannot block forever. */
  close(deadlineMs: number): FlushOutcome;

  /**
   * Active file + archives, newest first.
   *
   * Answers from the directory once the handle is gone: closing releases a
   * writer, it does not delete files, and `[]` from a closed sink would tell a
   * support-upload flow there is nothing to collect. Empty means no artifacts
   * — a sink that never opened has no directory to look in, and one that
   * opened answers empty once its files have been purged or swept away.
   */
  getLogFilePaths(): string[];

  /**
   * Runs the housekeeping that otherwise only ever happens on a write.
   *
   * Rotation and retention are driven from the write path — `rotateIfNeeded`
   * from `performWrite`, the retention sweep from open and from rotation — so a
   * sink that has gone quiet keeps whatever it had when the last record landed.
   * An age-based rotation never fires, an expired archive is never deleted, and
   * a `maxTotalLogBytes` cap goes on being exceeded, for as long as nobody
   * logs. `flush(0)` cannot stand in for this: it drains the queue and touches
   * neither.
   *
   * Enqueued on the writer's own queue like every other operation, and bounded
   * by `deadlineMs`. The status comes back after that wait rather than after
   * the sweep — the same instant only when the sweep finished inside the
   * deadline. Within it, the caller's degradation mask reflects what this call
   * found rather than what the last write did; a deadline of `0`, or one spent
   * behind a wedged write, returns early and the sweep goes on without it, its
   * findings reaching whichever status is read after it completes.
   *
   * There is deliberately no timer behind it. Native timers here would fire on
   * a queue this library does not own, in a process state it cannot see; the
   * schedule belongs to the app, and `scheduleMaintenance()` in TypeScript is
   * the one this package ships.
   */
  maintain(deadlineMs: number): SinkStatus;

  /**
   * Packs the log files into one gzip bundle for a support upload.
   *
   * gzip is a multi-member format: concatenated members decompress as one
   * stream, so a `.gz` archive can be copied in byte for byte and the active
   * file compressed in beside it. `gunzip` on the bundle yields the whole log
   * as chronological JSON Lines, which is what somebody debugging actually
   * wants — and it is why this returns a bundle rather than a list of paths a
   * caller would have to read, order and combine itself.
   *
   * Runs on the writer's queue, so it cannot see a rotation half-done, and
   * flushes first, so the newest records are in it. Sources are chosen
   * newest-first under `maxTotalBytes`, measured on the SOURCE bytes rather
   * than the compressed result: a ceiling that could only be checked after
   * compressing is not a ceiling on the work done.
   *
   * `maxTotalBytes` has no default here or in TypeScript. Deciding how much
   * of a log leaves the device is the caller's decision to make explicitly,
   * and a default would be this library making it for them.
   *
   * Written to a staging name and renamed, so an interrupted collect leaves
   * something the retention sweep recognises rather than a plausible-looking
   * `.gz` that no tool can open. A collect that overruns `deadlineMs` is
   * stopped at that rename rather than mid-copy: it reports `complete: false`
   * and deletes its own staging file, so no bundle appears afterwards for a
   * call that said there was none. At most one bundle exists at a time; each
   * collect replaces the last. Both names are artifacts, so `clearLogs`
   * deletes them — a compliance purge that left a copy of the log behind
   * would be no purge at all.
   */
  collectLogs(deadlineMs: number, maxTotalBytes: number): CollectOutcome;

  /**
   * Deletes the bundle `collectLogs` produced, and its staging leftovers.
   *
   * The third step of a support flow: collect, upload, delete. Without it the
   * bundle stays on the device until a purge or the next collect replaces it —
   * a gzipped copy of the whole log, outside the retention budget the app
   * configured, and deliberately skipped by the orphan sweep because a
   * FINISHED bundle is one somebody may still be uploading.
   *
   * Exactly the three support names and never a log file. This is not a purge
   * and must not become a smaller, quieter one; `clearLogs` deletes these as
   * well, along with everything else.
   *
   * `true` means no bundle artifact remained when this ran, including
   * vacuously for a sink that never opened and has no directory to look in.
   * That is a statement about an instant, not a promise about the next one: a
   * collect starting afterwards — or one already in flight when this landed —
   * legitimately writes a new bundle, and the caller sequences the two.
   *
   * `false` is the whole of the rest, and deliberately not a list of causes:
   * the deletion was refused, timed out, or could not be *durably* confirmed
   * gone. It does not assert that anything survived — a refusal establishes
   * nothing about the directory — so the bundle should be assumed still there.
   *
   * Queue-bound on the writer while a handle is live, so it cannot land inside
   * a collect's rename. A closed sink still deletes — closing releases a
   * writer, it does not delete files, and an upload finishing after the
   * destination went away is exactly when this gets called — but with no queue
   * to reach, that path is best-effort in the way `getLogFilePaths` already is
   * for a closed sink.
   */
  deleteSupportBundle(deadlineMs: number): boolean;

  /**
   * Registry-serialized purge of the COMPLETE artifact set (current file,
   * sidecar, archives, gzip temporaries, staging/recovery files). Bumps the
   * writer generation; the invoking handle rebinds only after durable
   * success. Reached via the Logger-layer purge flow, never called ad hoc.
   */
  clearLogs(deadlineMs: number): ClearOutcome;
}
