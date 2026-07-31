import type { LogEntry, LogLevel } from '../types';
import type { LogDestination } from './types';
import type { LogFormatter } from '../formatters/types';
import type {
  AppendResult,
  ClearOutcome,
  CollectOutcome,
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
  /**
   * Run rotation and the retention sweep now, bounded by `deadlineMs`, and
   * report the status once that wait is over. See
   * {@link FileDestination.maintain}.
   */
  maintain(deadlineMs: number): SinkStatus;
  /**
   * Pack the log files into one gzip bundle under the sink's own directory
   * and report what went in. See {@link FileDestination.collectForSupport}.
   */
  collectLogs(deadlineMs: number, maxTotalBytes: number): CollectOutcome;
  /**
   * Delete the bundle `collectLogs` produced and its staging leftovers, and
   * report whether none of the three remains. See
   * {@link FileDestination.deleteSupportBundle}.
   */
  deleteSupportBundle(deadlineMs: number): boolean;
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

export interface CollectForSupportOptions {
  /**
   * Ceiling on the log bytes that go into the bundle. Required, deliberately.
   *
   * How much of a log leaves the device is the calling app's decision, and a
   * default here would be this library making it on their behalf — for a file
   * whose size is bounded by a rotation policy the app also chose. Measured on
   * the source bytes, not on the compressed result, and applied newest-first:
   * a ceiling smaller than the whole log keeps the recent end, which is the
   * end somebody debugging is asking about.
   *
   * Zero is a legitimate value and produces no bundle at all. `Infinity` is
   * not: "send everything" has to be spelled as a number the caller is willing
   * to state, and accepting it would also make `NaN` and a genuine overflow
   * indistinguishable from a deliberate choice.
   */
  readonly maxTotalBytes: number;
  /**
   * Default 10s. Compression is proportional to the log.
   *
   * Bounds each of the two waits this call makes — the buffer flush, then the
   * native collect — rather than their sum. Splitting one budget across both
   * would make a slow flush eat the time the bundle needs and report an
   * incomplete collect for it.
   */
  readonly deadlineMs?: number;
}

const DEFAULT_LABEL = 'file';
const DEFAULT_FILENAME = 'app.log';
const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024;
const DEFAULT_DEADLINE_MS = 2000;
/**
 * Longer than {@link DEFAULT_DEADLINE_MS}, because the work is different in
 * kind: a flush drains a bounded buffer, a collect compresses however many
 * megabytes of log the retention policy allows. A two-second bound would
 * routinely report `complete: false` on a bundle that was nearly finished.
 */
const DEFAULT_COLLECT_DEADLINE_MS = 10_000;

/** Fixed text, and a `RangeError` rather than a silent zero: `NaN` arriving
 * here is an arithmetic bug in the caller, and quietly collecting nothing
 * would hide it behind a support flow that simply never produced a file. */
const CEILING_MESSAGE =
  'collectForSupport: maxTotalBytes must be a finite, non-negative number';

/**
 * Nothing was collected, and no bundle exists to send.
 *
 * A factory rather than a shared constant: `CollectOutcome` crosses the Nitro
 * boundary and its fields are mutable, so handing every failed call the same
 * object would let one caller's edit change what a later, unrelated call
 * returns.
 */
function collectedNothing(): CollectOutcome {
  return {
    path: '',
    byteCount: 0,
    sourceFileCount: 0,
    truncated: false,
    complete: false,
  };
}

/** Fixed text: a diagnostic that interpolates caller data is a log-injection
 * hole and a privacy hole at once. Only counts travel with it. */
const LOSS_MESSAGE = 'log entries were dropped';
const OVERSIZE_MESSAGE = 'a log entry was too large to record';

/**
 * A record and the size of *that* record.
 *
 * Not exported: this is how rendering hands its own measurement forward so the
 * batcher does not repeat it, and the pair exists only because the two things
 * must not be separated. `bytes` always describes `record` — never an earlier
 * string that rendering looked at and rejected on the way to it.
 *
 * Excludes the newline the batcher frames records with, which is the batcher's
 * to add and therefore the batcher's to count.
 */
interface Rendered {
  readonly record: string;
  readonly bytes: number;
}

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
 * deletion. The handle that invoked the purge rebinds; any other one does not,
 * and stays fenced until someone calls {@link FileDestination.reopen} — the
 * fence is permanent by design, but no longer permanent in practice.
 */
export class FileDestination implements LogDestination {
  readonly label: string;
  readonly minimumLevel: LogLevel | undefined;

  private readonly sink: FileSinkLike;
  private readonly formatter: LogFormatter;
  private readonly batcher: Batcher;
  private readonly maxEntryBytes: number;
  private readonly path: string;
  /**
   * A **copy** of the rotation config, held so {@link FileDestination.reopen}
   * can acquire the new handle with what the first one was opened with.
   *
   * Copied rather than kept by reference because the caller owns the object it
   * passed and may go on mutating it, and a reopen has to reproduce the
   * original acquisition rather than whatever the object says later. The
   * native registry compares policies to decide whether a second handle on a
   * file may share the writer, so a drifted config is not a quiet difference —
   * it is a `CONFIG_CONFLICT` against a sibling handle that is still open, and
   * the reopen fails.
   *
   * Read once, here, before the sink is opened: a config assembled from
   * getters is evaluated at construction, which is the moment the caller
   * chose, and a throwing one fails the constructor before any handle exists.
   */
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
    this.rotation =
      options.rotation === undefined
        ? undefined
        : Object.freeze({ ...options.rotation });

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
    // Asked before rendering, because rendering is the expensive half of
    // writing a log line and a full buffer will drop whatever comes out of it.
    // Under sustained backpressure that is the difference between formatting
    // every record for the wastebasket and formatting none of them.
    //
    // The record is still counted — it was a real entry that did not reach the
    // file — but with no byte count, because producing one means rendering it.
    // See {@link LossCounts}, where that asymmetry is the documented contract.
    if (!this.batcher.hasRoom()) {
      this.batcher.noteLoss(1, 0);
      return;
    }
    const rendered = this.renderRecord(entry);
    if (rendered === undefined) return;
    // The byte count travels with the record. Enforcing `maxEntryBytes` means
    // this side has already measured whatever it is handing over, and letting
    // the batcher measure it again is a second full pass over every record.
    this.batcher.add(rendered.record, rendered.bytes);
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

  /**
   * Run the housekeeping that otherwise only ever happens on a write, and
   * report what has stopped working underneath.
   *
   * Rotation and retention are driven from the write path alone: nothing
   * age-rotates, expires an archive or enforces `maxTotalLogBytes` until the
   * next record arrives. A sink that has gone quiet — an app left open on one
   * screen, a subsystem that only logs when something goes wrong — therefore
   * keeps whatever it had when the last record landed, indefinitely.
   * {@link flush} is not a substitute: it drains what is buffered and moves no
   * files. `scheduleMaintenance` is the thing that calls this on a timer.
   *
   * Returns the same bitmask {@link degradation} returns, read after the
   * native call's bounded wait — so a prune that has started failing shows up
   * in the answer to the call that tried it, rather than on the next append.
   * A sweep still running when `deadlineMs` expires is not in that answer yet;
   * it finishes on the writer's queue, and any status read after it completes
   * carries what it found — which is not necessarily the very next one, since
   * nothing stops a caller reading again while the sweep is still going.
   *
   * A destination that is fenced or disposed does nothing and reports the mask
   * it already had. A disposed one has closed its sink; a fenced one is behind
   * a purge, and the files it would sweep belong to whoever holds the writer
   * now.
   */
  maintain(deadlineMs: number = DEFAULT_DEADLINE_MS): number {
    if (!this.isEnabled) return this.batcher.degradation();
    try {
      this.batcher.observeStatus(this.sink.maintain(deadlineMs));
    } catch {
      // A sweep that threw leaves the cached mask where it stood. Maintenance
      // runs on a timer with nobody watching, and a throw out of here would
      // land in whatever scheduled it.
    }
    return this.batcher.degradation();
  }

  /**
   * Pack this destination's log files into one gzip bundle a support flow can
   * upload, and report what went into it.
   *
   * `gunzip` on the bundle yields the whole log as chronological JSON Lines,
   * because gzip is a multi-member format: already-compressed archives are
   * copied in byte for byte and the active file is compressed in beside them.
   * That is why this returns a bundle rather than the list of paths
   * {@link getLogFilePaths} gives — a caller handed paths has to read, order
   * and combine them itself, and the ordering is not the one the filenames
   * suggest.
   *
   * The buffer is flushed first, so records written a moment ago are in it.
   *
   * The bundle always lands at a fixed name inside the sink's own directory,
   * never a path the caller picks — a support feature is not a reason to ship
   * a write-a-file-anywhere primitive. At most one exists; each collect
   * replaces the last, and {@link purge} deletes it along with everything
   * else, because a compliance deletion that left a gzipped copy of the log
   * behind would not be a deletion.
   *
   * Nothing is uploaded, and nothing is encrypted by this library — see
   * `docs/PRIVACY.md` for why both are the app's call and not ours.
   *
   * Read `complete` before `path`. `complete: true` with an empty `path` is a
   * device with no logs to collect, which a support flow should report as
   * "nothing to send" rather than as an error; `complete: false` means the
   * collect did not finish and there is no bundle. `truncated` is orthogonal
   * and ordinary: the ceiling was reached, and what came back is the newest
   * end of the log.
   *
   * A fenced or disposed destination collects nothing. A disposed one has
   * closed its sink; a fenced one is behind a purge, and the files it would
   * pack belong to whoever holds the writer now — which is the whole reason
   * the fence exists.
   *
   * @throws RangeError if `maxTotalBytes` is negative or not finite.
   */
  collectForSupport(options: CollectForSupportOptions): CollectOutcome {
    const { maxTotalBytes, deadlineMs = DEFAULT_COLLECT_DEADLINE_MS } = options;
    if (!Number.isFinite(maxTotalBytes) || maxTotalBytes < 0) {
      throw new RangeError(CEILING_MESSAGE);
    }
    if (!this.isEnabled) return collectedNothing();

    // Before the collect, not after: the native side flushes its own queue,
    // but records sitting in the JS batcher have not reached that queue yet,
    // and a bundle missing the last few seconds is missing the part somebody
    // is asking about. A flush that times out is not a reason to abandon the
    // collect — the bundle is then simply missing the tail it could not
    // durably write, which is the same thing a crash would have done.
    this.batcher.flush(deadlineMs);

    let outcome: CollectOutcome;
    try {
      outcome = this.sink.collectLogs(deadlineMs, maxTotalBytes);
    } catch {
      // A native throw is `complete: false`, not a rethrow. The caller is a
      // support flow: it needs to know there is no bundle, and it can do
      // nothing useful with a native error object that it could not do with
      // that fact.
      return collectedNothing();
    }

    // A collect can fail to compress a member or fail to apply a file's
    // protections, and both raise a degradation bit natively. `CollectOutcome`
    // carries no status, so without this read the app would be told the sink
    // is healthy until some unrelated later append happened to notice — which
    // for a destination nothing is writing to means never. The bit that
    // matters most here is `protection`: it says a bundle of the whole log is
    // sitting on disk without the mode it was supposed to get.
    try {
      this.batcher.observeStatus(this.sink.getStatus());
    } catch {
      // A status read that threw says nothing about the collect, which
      // already succeeded or failed on its own terms.
    }
    return outcome;
  }

  /**
   * Delete the bundle {@link collectForSupport} produced, once it has been
   * uploaded.
   *
   * The third step of a support flow: collect, upload, delete. Skipping it
   * leaves a gzipped copy of the whole log on the device until a
   * {@link purge} or the next collect replaces it — outside the retention
   * budget `rotation` configures, and deliberately skipped by the native
   * orphan sweep, which keeps a finished bundle precisely because somebody may
   * still be uploading it. On a device holding patient data that copy is the
   * one artifact retention never reclaims.
   *
   * Deletes exactly the bundle and its staging leftovers, never a log file.
   * This is not a smaller `purge()` and must not be used as one.
   *
   * `true` means no bundle artifact remained when the call ran — including
   * vacuously, for a destination that never opened. It describes that instant
   * and promises nothing about the next: a collect started afterwards writes a
   * new bundle, and sequencing the two is the caller's job.
   *
   * `false` is the whole of the rest, and deliberately not a list of causes:
   * the deletion was refused, timed out, threw, or could not be *durably*
   * confirmed gone. It does not assert that anything survived — a refusal
   * establishes nothing about the directory — so read it as "assume a copy may
   * still be there" and retry through a live, current destination.
   *
   * A fenced or disposed destination refuses, and unlike
   * {@link getLogFilePaths} — which still answers after `dispose()` — that is
   * the right answer here. Reading a directory this destination no longer owns
   * is harmless; deleting from one is not. With the handle gone there is no
   * generation left to check, so another destination may own that path now and
   * be mid-publish in it, and the `.support.gz` removed would be *its* bundle,
   * whose path it has already handed to a caller. A fence says the same thing
   * one step earlier: a purge moved the writer on, which is the reason
   * {@link collectForSupport} declines to pack those files too.
   *
   * So **delete before disposing**, or through a fresh destination on the same
   * path — either gives a live handle on a current generation, which is what
   * makes the deletion safe rather than merely willing.
   */
  deleteSupportBundle(deadlineMs: number = DEFAULT_DEADLINE_MS): boolean {
    if (!this.isEnabled) return false;
    try {
      return this.sink.deleteSupportBundle(deadlineMs);
    } catch {
      // A native throw is `false`, not a rethrow. The caller is a support flow
      // finishing an upload; it needs to know the copy may still be there, and
      // there is nothing it could do with a native error object that it cannot
      // do with that fact.
      return false;
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
   * after. Only a durable deletion lifts the fence. A partial or timed-out one
   * leaves this handle disabled until {@link FileDestination.reopen}, so a
   * late deletion can never race a fresh write.
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
    // just stays disabled until `reopen()` gets a live file back.
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

  /**
   * The way back from a fence: close this handle and open a fresh one.
   *
   * A fence is deliberately permanent until something asks for a retry, and
   * until 0.3.0 nothing could. `purge` says so twice — "disabled until an
   * explicit retry" — and there was no retry to make; a destination fenced by
   * another handle's purge, or by a purge that deleted durably and could not
   * reopen, was dead for the life of the process.
   *
   * Constructing a replacement was the only recourse, and it is a poor one
   * rather than an impossible one. On the same canonical path a second handle
   * is eligible to share the writer when the rotation policy and framing
   * match; differing ones are a `CONFIG_CONFLICT`. Matching them is not a
   * promise of success either — an acquisition still fails on a previous
   * writer that is still closing, or on the filesystem, or on the lock. And
   * whichever way it goes, the fenced destination is still alive: holding its
   * retain on the writer, still registered with whatever logger it was given
   * to, until someone disposes it.
   *
   * Returns whether this destination can write when the call returns.
   *
   * - Disposed → `false`. The sink is closed and the handle is gone; a
   *   disposed destination is finished, not resting, and reopening one would
   *   resurrect an object its owner has already released.
   * - Not fenced → `true`, having touched nothing. Closing a live handle to
   *   prove it can be reopened would throw away the buffer and the file
   *   position for a question already answered.
   * - Otherwise the sink is closed and reopened with the same path, rotation
   *   and framing it was constructed with. On success the fence lifts and the
   *   batcher rebinds to the new generation; on failure it stays fenced and
   *   the destination is exactly as dead as it was, which is the only safe
   *   direction for this to fail in.
   *
   * `deadlineMs` bounds the close, the only half that waits — it drains and
   * fsyncs a handle that may have a queue behind it. `open` does not take one.
   * A close that throws is swallowed rather than reported: this handle is
   * fenced, so there was nothing worth draining, and whether the reopen worked
   * is the question the return value answers.
   *
   * **What `true` does not claim.** It says a handle was acquired, not that
   * the file behind it is the one this destination was writing to before.
   * Reopening after another handle's purge lands on a fresh, empty file —
   * which is the point of the purge — and nothing here can or should undo
   * that.
   *
   * **The new file does not open with a notice about the old one**, and that
   * falls out of two decisions rather than a rule written here. `Batcher.fence`
   * clears the owed delta on the way in, because a notice about deliberately
   * deleted data would describe the deletion; and `write` above refuses while
   * fenced, so nothing accumulates behind the fence either. A reopened
   * destination starts clean. What `Batcher.rebind` preserves is the loss
   * accounting of a batcher driven directly — this destination cannot reach
   * that state, and the reason is the `isEnabled` guard, not luck.
   */
  reopen(deadlineMs: number = DEFAULT_DEADLINE_MS): boolean {
    if (this.disposed) return false;
    if (!this.fenced) return true;

    try {
      this.sink.close(deadlineMs);
    } catch {
      // Nothing was drainable behind a fence. If the handle is still open the
      // `open` below fails as a config conflict, which is the honest answer.
    }

    try {
      this.sink.open(this.path, this.rotation, this.lineFramed);
    } catch {
      return false;
    }

    this.fenced = false;
    this.batcher.rebind();
    return true;
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
   *
   * The byte count comes back **with** the record, and it is the count of the
   * record being returned — never of the one that was measured on the way to
   * it. That distinction is the whole reason this returns a pair rather than
   * letting the caller reuse `bytes`: on the oversize path the returned string
   * is a notice, a different and much shorter string than the entry whose size
   * put it there, and handing the batcher the original number would inflate
   * every pending-byte total in the pipeline.
   */
  private renderRecord(entry: LogEntry): Rendered | undefined {
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
    if (bytes <= this.maxEntryBytes) return { record, bytes };

    // Structural shedding first: a formatter that knows its own shape can
    // drop whole fields and truncate one at code-point boundaries, and what
    // comes back is still valid in that format.
    if (this.formatter.formatWithin) {
      const shorter = this.formatWithinOrUndefined(entry);
      if (shorter !== undefined) {
        const shorterBytes = utf8Length(shorter);
        if (shorterBytes <= this.maxEntryBytes) {
          return { record: shorter, bytes: shorterBytes };
        }
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
    // A string, not a `Rendered`, and nothing is lost by that: a loss notice
    // goes straight into an outgoing batch rather than into the pending
    // buffer, so no byte count is ever wanted for it. `renderNotice` is also a
    // public `BatcherOptions` field, and widening its return type would be a
    // break bought for nothing.
    return this.boundedNotice(
      noticeEntry(Date.now(), LOSS_MESSAGE, {
        droppedEntries: lost.entries,
        droppedBytes: lost.bytes,
      })
    )?.record;
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
  private boundedNotice(entry: LogEntry): Rendered | undefined {
    const text = this.formatOrUndefined(entry);
    if (text === undefined) return undefined;
    const bytes = utf8Length(text);
    if (bytes <= this.maxEntryBytes) return { record: text, bytes };
    if (this.formatter.formatWithin) {
      const shorter = this.formatWithinOrUndefined(entry);
      if (shorter !== undefined) {
        const shorterBytes = utf8Length(shorter);
        if (shorterBytes <= this.maxEntryBytes) {
          return { record: shorter, bytes: shorterBytes };
        }
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
