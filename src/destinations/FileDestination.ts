import type { LogEntry, LogLevel } from '../types';
import type { LogDestination } from './types';
import type { LogFormatter } from '../formatters/types';
import type {
  AppendResult,
  ClearOutcome,
  FlushOutcome,
  RotationConfig,
  SinkStatus,
} from '../specs/FileSink.nitro';
import type { BatchFlushOutcome, FenceReason, LossCounts } from './Batcher';
import { Batcher } from './Batcher';
import { JsonLinesFormatter } from '../formatters/JsonLinesFormatter';
import { utf8Length } from '../utf8';

/**
 * The part of `FileSink` a `FileDestination` uses.
 *
 * Structural rather than the Nitro interface itself, so the destination can
 * be driven by a scripted double in tests. The real `FileSink` satisfies it.
 */
export interface FileSinkLike {
  readonly defaultLogDirectory: string;
  open(path: string, rotation?: RotationConfig, lineFramed?: boolean): void;
  appendBatch(batch: string, entryCount: number): AppendResult;
  getStatus(): SinkStatus;
  flush(deadlineMs: number): FlushOutcome;
  close(deadlineMs: number): FlushOutcome;
  getLogFilePaths(): string[];
  /**
   * Delete every artifact and bump the writer generation, fencing every
   * handle on it.
   *
   * On `durable && rebound` the CALLING handle is rebound to the new
   * generation by this call — no second `open` follows, and none would be
   * accepted, since re-opening a live writer is a config conflict. That is why
   * the JS side only lifts its own fence afterwards. A `clearLogs` that bumped
   * the generation without rebinding its caller would leave the destination
   * writing into a stale handle, discarding every record it was handed and
   * disabling itself on the first rejection.
   *
   * The two flags are separate because they are separate facts. `durable`
   * answers the compliance question — the artifacts are gone — and a purge can
   * answer it truthfully and still fail to reopen, on a directory that has
   * become unwritable or a volume that filled. Only the second flag says there
   * is somewhere to write.
   *
   * On anything else the caller stays fenced along with everyone else, so a
   * deletion still in flight can never race a fresh write.
   */
  clearLogs(deadlineMs: number): ClearOutcome;
}

export interface FileDestinationOptions {
  /** Registration key. Default 'file'. */
  readonly label?: string;
  readonly minimumLevel?: LogLevel;
  /** Default `JsonLinesFormatter` — the one with a framing guarantee. */
  readonly formatter?: LogFormatter;
  /** Absolute path. Default `<defaultLogDirectory>/app.log`. */
  readonly path?: string;
  readonly rotation?: RotationConfig;
  /**
   * Largest single rendered record, in UTF-8 bytes. Default 64 KB — roomy for
   * a stack trace, far under the sink's payload cap so a batch always fits.
   */
  readonly maxEntryBytes?: number;
  readonly batchBytes?: number;
  readonly flushIntervalMs?: number;
  readonly maxPendingEntries?: number;
  readonly maxPendingBytes?: number;
  readonly watermarkBytes?: number;
}

export interface PurgeOutcome {
  /** Every artifact is gone. False on any survivor or a blown deadline. */
  readonly durable: boolean;
  /**
   * The destination is writable again, and writing has resumed.
   *
   * False means the deletion may well have succeeded — check `durable` — but
   * the sink did not come back with a usable file, or did not say so. Either
   * way this destination stays disabled until a retry.
   */
  readonly rebound: boolean;
  readonly deletedCount: number;
  readonly failedPaths: readonly string[];
  /** Buffered records thrown away, plus losses that will now go unreported. */
  readonly discardedEntries: number;
  readonly discardedBytes: number;
}

const DEFAULT_LABEL = 'file';
const DEFAULT_FILENAME = 'app.log';
const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024;
const DEFAULT_DEADLINE_MS = 2000;

/** Fixed text: a diagnostic that interpolates caller data is a log-injection
 * hole and a privacy hole at once. Only counts travel with it. */
const LOSS_MESSAGE = 'log entries were dropped';
const OVERSIZE_MESSAGE = 'a log entry was too large to record';

/**
 * Writes formatted records to a native file sink, batched and backpressured.
 *
 * The division of labour is the whole design: this side decides what to write
 * and what to give up on, the sink only appends text and reports counters.
 * Everything interesting — batching, drop policy, loss notices, the purge
 * handshake — is therefore testable without a device.
 *
 * Three behaviours are worth knowing about before using it.
 *
 * **Oversized entries are never sliced.** A formatter that can shed structure
 * is asked to re-render within the limit; one that cannot has its output
 * replaced whole by a fixed notice. Cutting a rendered record to length is
 * how a log file stops being parseable, and an unparseable file is worth less
 * than an honestly incomplete one.
 *
 * **Framing is declared, not assumed.** A formatter guaranteeing one record
 * per line lets the native side trim a torn trailing record after a crash.
 * Without that guarantee the file is left as the crash left it, because a
 * writer cannot tell a torn record from an intentional newline.
 *
 * **A fenced handle stays fenced.** When the sink reports that this handle's
 * generation is stale — someone purged the file underneath it — the buffer is
 * discarded rather than replayed into the new file, and the destination
 * disables itself. Pre-purge records must not reappear after a compliance
 * deletion. The handle that invoked the purge rebinds; any other one does
 * not, and reacquisition is the native registry's job.
 */
export class FileDestination implements LogDestination {
  readonly label: string;
  readonly minimumLevel: LogLevel | undefined;

  private readonly sink: FileSinkLike;
  private readonly formatter: LogFormatter;
  private readonly batcher: Batcher;
  private readonly maxEntryBytes: number;
  private readonly path: string;
  /** Held for the M5 registry's reacquisition path, which needs the same
   * config the handle was opened with. */
  private readonly rotation: RotationConfig | undefined;

  private fenced = false;
  private disposed = false;

  constructor(sink: FileSinkLike, options: FileDestinationOptions = {}) {
    this.sink = sink;
    this.label = options.label ?? DEFAULT_LABEL;
    this.minimumLevel = options.minimumLevel;
    this.formatter = options.formatter ?? new JsonLinesFormatter();
    this.maxEntryBytes = positive(
      options.maxEntryBytes,
      DEFAULT_MAX_ENTRY_BYTES
    );
    this.path =
      options.path ?? `${sink.defaultLogDirectory}/${DEFAULT_FILENAME}`;
    this.rotation = options.rotation;

    this.batcher = new Batcher(sink, {
      renderNotice: (lost) => this.renderLossNotice(lost),
      onFenced: (reason) => this.onFenced(reason),
      batchBytes: options.batchBytes,
      flushIntervalMs: options.flushIntervalMs,
      maxPendingEntries: options.maxPendingEntries,
      maxPendingBytes: options.maxPendingBytes,
      watermarkBytes: options.watermarkBytes,
    });

    // Throws on open failure or on a config conflict with an existing writer,
    // and deliberately so: a file destination that silently writes nowhere is
    // worse than one that refuses to be constructed.
    sink.open(this.path, this.rotation, this.lineFramed);
  }

  /** True only while this handle may write. */
  get isEnabled(): boolean {
    return !this.fenced && !this.disposed;
  }

  /** Where records are going. */
  get filePath(): string {
    return this.path;
  }

  /**
   * Whether the native side may trim a torn trailing record after a crash.
   * Follows the formatter's declaration; nothing infers it.
   */
  get lineFramed(): boolean {
    return this.formatter.framing === 'line';
  }

  write(entry: LogEntry): void {
    if (!this.isEnabled) return;
    const record = this.renderRecord(entry);
    if (record === undefined) return;
    this.batcher.add(record);
  }

  /**
   * Drain to disk and fsync, bounded by a wall-clock deadline.
   *
   * Returns the outcome even though `LogDestination` asks only for `void`: a
   * caller flushing before backgrounding or on a crash path needs to know
   * whether it worked, and `durable: false` is the answer that matters.
   */
  flush(deadlineMs: number = DEFAULT_DEADLINE_MS): BatchFlushOutcome {
    return this.batcher.flush(deadlineMs);
  }

  /**
   * Current file and archives, newest first; empty if the sink refuses.
   *
   * Still answers after `dispose()`. Releasing the handle does not unmake the
   * files, and a support-upload flow that collected after `removeDestination()`
   * would otherwise be told there is nothing on the device.
   *
   * Empty means "no artifacts", not "no sink". A destination that never opened
   * has no directory to inspect; one that opened keeps inspecting its own
   * directory afterwards and will rightly answer with nothing once a `purge()`,
   * a retention sweep or something outside this process has taken the files.
   */
  getLogFilePaths(): string[] {
    try {
      return this.sink.getLogFilePaths();
    } catch {
      return [];
    }
  }

  /** Losses with no notice in the file yet. */
  unreportedLoss(): LossCounts {
    return this.batcher.unreported();
  }

  /**
   * What has stopped working underneath, as a payload-free bitmask —
   * rotation, gzip, prune, sidecar, protection.
   *
   * The mask exists because the alternative is a message, and a message built
   * from an `errno` string or a path is exactly the kind of thing that carries
   * a username into a log file. Bits carry no payload, so an app can surface
   * "log rotation is failing" to support without surfacing anything else.
   *
   * Non-zero does not mean records are being lost — a failed compression or a
   * failed prune costs disk, not data. Check {@link unreportedLoss} for that.
   */
  degradation(): number {
    return this.batcher.degradation();
  }

  /**
   * Delete every log artifact, then rebind.
   *
   * The ordering is the point. This handle is fenced first, so nothing can be
   * written into the window where deletion is in flight; the JS buffer is
   * discarded rather than flushed, because flushing it would write pre-purge
   * records into the file a moment before deleting it — or worse, a moment
   * after. Only a durable deletion lifts the fence. A partial or timed-out
   * one leaves this handle disabled until an explicit retry, so a late
   * deletion can never race a fresh write.
   *
   * Discarded counts come back here rather than going into a loss notice: a
   * "4,182 entries dropped" line at the top of a file that was just cleared
   * for compliance describes the clearing, which the caller already knows
   * about.
   */
  purge(deadlineMs: number = DEFAULT_DEADLINE_MS): PurgeOutcome {
    // A disposed destination has closed its sink, and a closed sink has no
    // handle left to delete through — so this call cannot do the one thing it
    // exists to do. Saying so is the entire point: the alternative is a
    // `durable: true` over files that are still on disk, told to the one caller
    // who asked because they are legally obliged to know. `removeDestination()`
    // then a compliance purge is an ordinary sequence, not a contrived one.
    if (this.disposed) {
      return {
        durable: false,
        rebound: false,
        deletedCount: 0,
        failedPaths: [],
        discardedEntries: 0,
        discardedBytes: 0,
      };
    }

    this.fenced = true;
    const discarded = this.batcher.discard();

    let outcome: ClearOutcome;
    try {
      outcome = this.sink.clearLogs(deadlineMs);
    } catch {
      return {
        durable: false,
        // The call threw, so nothing is known about the sink's state and the
        // fence set above stays up. Reporting a rebind here would lift it.
        rebound: false,
        deletedCount: 0,
        failedPaths: [],
        discardedEntries: discarded.entries,
        discardedBytes: discarded.bytes,
      };
    }

    // Both facts, not just the first. `durable` says the artifacts are gone;
    // `rebound` says the sink has a usable file again. Lifting the fence on
    // `durable` alone resumes writing into a handle the sink never rebound —
    // every record accepted, rejected as `staleGeneration`, and dropped. The
    // deletion is still complete and still reported as such; the destination
    // just stays disabled until an explicit retry gets a live file back.
    //
    // `=== true`, not `!== false`. An absent field is not a promise, and the
    // sink most likely to omit it is one that predates it — including a native
    // build that deletes by closing and never reopens at all. A JS bundle can
    // be updated over the air without the binary underneath it changing, so
    // "old native, new JS" is a real pairing, and reading silence as success
    // there rebuilds exactly the silent post-purge loss this flag exists to
    // stop. Staying fenced until a retry is the failure that announces itself.
    const resumed = outcome.durable && outcome.rebound === true;
    if (resumed) {
      this.fenced = this.disposed;
      this.batcher.rebind();
    }

    return {
      durable: outcome.durable,
      rebound: resumed,
      deletedCount: count(outcome.deletedCount),
      failedPaths: Array.isArray(outcome.failedPaths)
        ? outcome.failedPaths
        : [],
      discardedEntries: discarded.entries,
      discardedBytes: discarded.bytes,
    };
  }

  /** Idempotent: flush what is buffered, release the timer, close the sink. */
  dispose(): void {
    if (this.disposed) return;
    try {
      this.batcher.flush(DEFAULT_DEADLINE_MS);
    } catch {
      // a failing drain must not leak the handle below
    }
    this.disposed = true;
    this.batcher.dispose();
    try {
      this.sink.close(DEFAULT_DEADLINE_MS);
    } catch {
      // nothing left to salvage
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Render one entry, or account for why it could not be rendered.
   *
   * Returns undefined when nothing writable came out; the loss is recorded
   * before returning, so an entry is either in the file or in the counters
   * and never in neither.
   */
  private renderRecord(entry: LogEntry): string | undefined {
    const record = this.formatOrUndefined(entry);
    if (record === undefined) {
      this.batcher.noteLoss(1, 0);
      return undefined;
    }

    // The ORIGINAL size, held onto for the rest of this method. What gets
    // discarded is the entry the caller wrote, so that is the number the
    // counters and the notice have to carry — not the size of whatever
    // undersized floor the formatter came back with instead.
    const bytes = utf8Length(record);
    if (bytes <= this.maxEntryBytes) return record;

    // Structural shedding first: a formatter that knows its own shape can
    // drop whole fields and truncate one at code-point boundaries, and what
    // comes back is still valid in that format.
    if (this.formatter.formatWithin) {
      const shorter = this.formatWithinOrUndefined(entry);
      if (shorter !== undefined && utf8Length(shorter) <= this.maxEntryBytes) {
        return shorter;
      }
      // Still over: a record has a floor below which it identifies nothing.
    }

    // Nothing renderable fits, so the entry is replaced whole by a notice in
    // the same format. Never sliced: a fragment of a record is not a record.
    this.batcher.noteLoss(1, bytes);
    return this.boundedNotice(
      noticeEntry(entry.timestamp, OVERSIZE_MESSAGE, { droppedBytes: bytes })
    );
  }

  private renderLossNotice(lost: LossCounts): string | undefined {
    return this.boundedNotice(
      noticeEntry(Date.now(), LOSS_MESSAGE, {
        droppedEntries: lost.entries,
        droppedBytes: lost.bytes,
      })
    );
  }

  /**
   * Render one of the pipeline's own notices under the same per-entry limit
   * as everything else.
   *
   * The limit exists so a batch always fits the sink. A notice exempt from it
   * could be refused forever by a sink that will never take it, and the loss
   * it describes would sit undelivered behind it — the pipeline's own
   * diagnostics jamming the pipeline. Returning undefined when nothing fits
   * leaves the loss counted and owed, which is the honest outcome.
   */
  private boundedNotice(entry: LogEntry): string | undefined {
    const text = this.formatOrUndefined(entry);
    if (text === undefined) return undefined;
    if (utf8Length(text) <= this.maxEntryBytes) return text;
    if (this.formatter.formatWithin) {
      const shorter = this.formatWithinOrUndefined(entry);
      if (shorter !== undefined && utf8Length(shorter) <= this.maxEntryBytes) {
        return shorter;
      }
    }
    return undefined;
  }

  private formatOrUndefined(entry: LogEntry): string | undefined {
    try {
      const text = this.formatter.format(entry);
      return typeof text === 'string' ? text : undefined;
    } catch {
      return undefined;
    }
  }

  private formatWithinOrUndefined(entry: LogEntry): string | undefined {
    try {
      const text = this.formatter.formatWithin!(entry, this.maxEntryBytes);
      return typeof text === 'string' ? text : undefined;
    } catch {
      return undefined;
    }
  }

  private onFenced(_reason: FenceReason): void {
    this.fenced = true;
  }
}

/**
 * A synthetic entry describing the pipeline's own state.
 *
 * Built directly rather than routed through the logger: it carries only
 * counts, so there is nothing for redaction to protect, and going through the
 * logger would put it behind the very destination that is trying to report a
 * problem.
 */
function noticeEntry(
  timestamp: number,
  message: string,
  metadata: Record<string, number>
): LogEntry {
  return Object.freeze({
    timestamp,
    level: 'warning' as const,
    message,
    metadata: Object.freeze({ ...metadata }),
    subsystem: 'logger',
  });
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function count(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}
