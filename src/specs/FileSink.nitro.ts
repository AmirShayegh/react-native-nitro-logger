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
  maxFileSizeBytes: number;
  /** Archives to retain by count; 0 keeps none. */
  maxArchivedFilesCount: number;
  /** Rotate the current file once this old, regardless of size. */
  maxFileAgeSeconds?: number;
  /** Gzip archives as they rotate out. */
  compressArchives: boolean;
  /** Delete archives older than this even if under the count cap. */
  maxArchiveAgeSeconds?: number;
  /** Bound on current file + all archives combined. */
  maxTotalLogBytes?: number;
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
  queuedBytes: number;
  lostBytes: number;
  lostEntries: number;
  /** Payload-free degradation bitmask: rotation|gzip|prune|sidecar|protection. */
  degraded: number;
}

export interface AppendResult {
  accepted: boolean;
  /** Present only when accepted is false. */
  rejectReason?: RejectReason;
  queuedBytes: number;
  lostBytes: number;
  lostEntries: number;
  degraded: number;
}

export interface FlushOutcome {
  /** True when every previously accepted byte reached storage and fsync. */
  durable: boolean;
  timedOut: boolean;
  pendingBytes: number;
  queuedBytes: number;
  lostBytes: number;
  lostEntries: number;
  degraded: number;
}

export interface ClearOutcome {
  deletedCount: number;
  failedPaths: string[];
  /** False when any artifact survived or the deadline elapsed. */
  durable: boolean;
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
  rebound: boolean;
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

  /** Active file + archives, newest first. */
  getLogFilePaths(): string[];

  /**
   * Registry-serialized purge of the COMPLETE artifact set (current file,
   * sidecar, archives, gzip temporaries, staging/recovery files). Bumps the
   * writer generation; the invoking handle rebinds only after durable
   * success. Reached via the Logger-layer purge flow, never called ad hoc.
   */
  clearLogs(deadlineMs: number): ClearOutcome;
}
