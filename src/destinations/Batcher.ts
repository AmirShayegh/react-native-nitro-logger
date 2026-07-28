import type {
  AppendResult,
  FlushOutcome,
  RejectReason,
  SinkStatus,
} from '../specs/FileSink.nitro';
import { utf8Length } from '../utf8';

/**
 * The part of a `FileSink` the batcher drives. Narrow on purpose: it is what
 * lets the whole backpressure and loss protocol be tested against a scripted
 * double, with no native runtime and no filesystem.
 */
export interface BatchTarget {
  appendBatch(batch: string, entryCount: number): AppendResult;
  getStatus(): SinkStatus;
  flush(deadlineMs: number): FlushOutcome;
}

/** Entries that never reached the file, and the bytes they would have been. */
export interface LossCounts {
  readonly entries: number;
  readonly bytes: number;
}

/** Why the sink cut this handle off. Both are terminal for the batcher. */
export type FenceReason = 'staleGeneration' | 'closed';

export interface BatcherOptions {
  /**
   * Render the consolidated loss notice in the destination's format. The
   * notice is a record in the log file, so only the destination knows how to
   * spell it.
   *
   * Returning `undefined` (or throwing) leaves the loss unacknowledged rather
   * than silently forgotten — it will be offered again on the next batch.
   */
  readonly renderNotice: (lost: LossCounts) => string | undefined;
  /**
   * Called once when the sink fences this handle. The batcher has already
   * discarded its buffer and baselined its counters by then; the owner
   * decides between rebinding and self-disabling.
   */
  readonly onFenced?: (reason: FenceReason) => void;
  /** Bytes of pending content that trigger a batch. Default 4096. */
  readonly batchBytes?: number;
  /** Idle flush interval, also the backpressure poll interval. Default 100. */
  readonly flushIntervalMs?: number;
  /** Pending-buffer caps; whichever binds first. Default 1000 / 512 KB. */
  readonly maxPendingEntries?: number;
  readonly maxPendingBytes?: number;
  /** Sink queue depth at which pushing pauses. Default 256 KB. */
  readonly watermarkBytes?: number;
  /** Largest single batch. Default 256 KB. */
  readonly maxBatchBytes?: number;
}

/**
 * What a bounded drain achieved.
 *
 * Deliberately not the sink's `FlushOutcome`: the sink reports monotonic
 * per-handle totals, whereas `unreportedEntries` / `unreportedBytes` are the
 * losses that still have no notice in the file. That is the number a caller
 * can act on, and conflating the two is how "we already logged that" turns
 * into a loss no one ever hears about.
 */
export interface BatchFlushOutcome {
  /** Every accepted byte reached storage, nothing is buffered, no loss is owed. */
  readonly durable: boolean;
  readonly timedOut: boolean;
  /** Bytes not yet durable: still in the JS buffer plus still in the sink. */
  readonly pendingBytes: number;
  readonly unreportedEntries: number;
  readonly unreportedBytes: number;
  /** Sink degradation bitmask, passed through. */
  readonly degraded: number;
}

/** Monotonic totals, JS-side and sink-side, at one instant. */
interface Cursor {
  sinkEntries: number;
  sinkBytes: number;
  localEntries: number;
  localBytes: number;
}

interface Pending {
  readonly text: string;
  /** UTF-8 bytes including the record's terminating newline. */
  readonly bytes: number;
}

type PushResult = 'sent' | 'full' | 'failed' | 'fenced' | 'empty';

/** How far a bounded drain has got. See {@link advanced}. */
interface Position {
  readonly entries: number;
  readonly bytes: number;
  readonly owedEntries: number;
  readonly owedBytes: number;
}

const DEFAULTS = {
  batchBytes: 4096,
  flushIntervalMs: 100,
  maxPendingEntries: 1000,
  maxPendingBytes: 512 * 1024,
  watermarkBytes: 256 * 1024,
  maxBatchBytes: 256 * 1024,
};

/** Upper bound on any deadline handed to the sink, in milliseconds. */
const MAX_DEADLINE_MS = 30_000;

/** Consecutive no-progress rounds before a bounded drain gives up. */
const MAX_STALLS = 8;

/** Pushes per timer tick, so catching up cannot monopolise the JS thread. */
const PUSHES_PER_TICK = 4;

/**
 * Buffers formatted records and feeds them to a sink under backpressure.
 *
 * Three things happen here that do not happen anywhere else.
 *
 * **Backpressure.** The sink's queue is bounded, so once it passes the
 * watermark the batcher stops pushing and polls `getStatus()` instead — which
 * is why that call is specified never to wait behind writer I/O. Records
 * accumulate in the JS buffer meanwhile, itself bounded by an entry count and
 * a byte count.
 *
 * **Drop-newest.** When the JS buffer is full the arriving record is dropped,
 * not the oldest one held. Under a sustained overload the two policies lose
 * the same volume; they differ in what survives, and the older records are
 * the ones with the context explaining how the overload started.
 *
 * **Loss is owed until it is written.** Every drop — here or in the sink —
 * accrues to a counter that is only cleared once a notice describing it has
 * been accepted, and is re-armed if the flush that should have made that
 * notice durable says otherwise. A loss can therefore be reported twice; it
 * cannot be reported zero times. Silence has to mean nothing was lost, or the
 * counters are decoration.
 */
export class Batcher {
  private readonly target: BatchTarget;
  private readonly renderNotice: (lost: LossCounts) => string | undefined;
  private readonly onFenced: ((reason: FenceReason) => void) | undefined;
  private readonly batchBytes: number;
  private readonly flushIntervalMs: number;
  private readonly maxPendingEntries: number;
  private readonly maxPendingBytes: number;
  private readonly watermarkBytes: number;
  private readonly maxBatchBytes: number;

  private pending: Pending[] = [];
  private pendingBytes = 0;
  private paused = false;
  private fenced = false;
  private disposed = false;
  /**
   * A notice could not be delivered on its own — unrenderable, or refused by
   * the sink — and nothing about ticking again would change that.
   *
   * The debt stays owed and still shows in `unreported()`; what stops is the
   * retrying on a timer, which would go on for the life of the process
   * achieving nothing. The next record to arrive reopens it — that retry
   * rides a batch that carries the record, so it cannot spin — as does an
   * explicit `flush()`.
   */
  private noticeBlocked = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** Highest sink totals seen, and every byte this side has dropped. */
  private observed: Cursor = zeroCursor();
  /** Covered by a notice the sink has accepted. */
  private acked: Cursor = zeroCursor();
  /** Covered by a notice a durable flush has confirmed. */
  private confirmed: Cursor = zeroCursor();

  private degraded = 0;

  constructor(target: BatchTarget, options: BatcherOptions) {
    this.target = target;
    this.renderNotice = options.renderNotice;
    this.onFenced = options.onFenced;
    this.batchBytes = positive(options.batchBytes, DEFAULTS.batchBytes);
    this.flushIntervalMs = positive(
      options.flushIntervalMs,
      DEFAULTS.flushIntervalMs
    );
    this.maxPendingEntries = positive(
      options.maxPendingEntries,
      DEFAULTS.maxPendingEntries
    );
    this.maxPendingBytes = positive(
      options.maxPendingBytes,
      DEFAULTS.maxPendingBytes
    );
    this.watermarkBytes = positive(
      options.watermarkBytes,
      DEFAULTS.watermarkBytes
    );
    this.maxBatchBytes = positive(
      options.maxBatchBytes,
      DEFAULTS.maxBatchBytes
    );
  }

  // ── Producing ───────────────────────────────────────────────────────────

  /**
   * Buffer one formatted record. Never performs I/O beyond handing a full
   * batch to the sink, and never throws: a logging call must not fail the
   * code that made it.
   */
  add(record: string): void {
    if (this.disposed || this.fenced) {
      this.dropped(record);
      return;
    }
    const bytes = utf8Length(record) + 1; // the record's own newline
    if (
      this.pending.length >= this.maxPendingEntries ||
      this.pendingBytes + bytes > this.maxPendingBytes
    ) {
      this.dropped(record, bytes);
      this.ensureTimer();
      return;
    }

    this.pending.push({ text: record, bytes });
    this.pendingBytes += bytes;
    // A record to ride with is a fresh chance for a notice the sink refused
    // earlier, and the reason it refused is usually temporary — a queue that
    // was full a moment ago. Retrying on this event cannot spin the way a
    // timer can: the batch carries a record, so it makes progress either way,
    // and if the notice fails again the dead ends below block it again.
    // Waiting instead for the next explicit flush means a process that dies
    // first reports the loss zero times.
    this.noticeBlocked = false;

    if (!this.paused && this.pendingBytes >= this.batchBytes) {
      this.pushOnce();
    }
    this.ensureTimer();
  }

  /**
   * Record a loss that happened before the batcher saw it — a record that
   * could not be rendered, or one too large to be rendered honestly. It is
   * owed a notice on exactly the same terms as anything dropped here.
   */
  noteLoss(entries: number, bytes: number): void {
    this.observed.localEntries += toCount(entries);
    this.observed.localBytes += toCount(bytes);
    this.ensureTimer();
  }

  /** Losses with no notice in the file yet. */
  unreported(): LossCounts {
    return this.delta();
  }

  /** Bytes buffered on this side, not yet handed to the sink. */
  bufferedBytes(): number {
    return this.pendingBytes;
  }

  /**
   * Payload-free bitmask of what has stopped working underneath — rotation,
   * gzip, prune, sidecar, protection.
   *
   * This mirrors the sink's own mask, which accumulates bits and drops them
   * only when a durable purge baselines everything. That is deliberate: these
   * are things an app wants to know happened *at all*, and a mask that cleared
   * itself the moment the next batch succeeded would report nothing the one
   * time it mattered.
   */
  degradation(): number {
    return this.degraded;
  }

  isFenced(): boolean {
    return this.fenced;
  }

  // ── Draining ────────────────────────────────────────────────────────────

  /**
   * Drain to the sink and fsync, bounded by a wall-clock deadline.
   *
   * Backpressure is overridden for the duration: the whole point of a flush
   * is to push through a full queue rather than wait for it to clear, so a
   * rejected batch is followed by a bounded sink flush and retried.
   *
   * The postcondition is honest rather than absolute. Under a disk that stays
   * full, this returns `durable: false` with the losses preserved — the
   * alternative, insisting everything is either durable or noticed, is a
   * promise no implementation can keep.
   */
  flush(deadlineMs: number): BatchFlushOutcome {
    this.cancelTimer();
    if (this.disposed || this.fenced) return this.outcome(false, false, 0);

    const deadlineAt = Date.now() + clampDeadline(deadlineMs);
    this.paused = false;
    // An explicit flush is the retry: a notice the sink refused on its own
    // gets one more chance here before being set aside again.
    this.noticeBlocked = false;

    let timedOut = false;
    let stalls = 0;
    let attempts = 0;
    const maxAttempts = this.maxPendingEntries + MAX_STALLS * 2 + 16;

    while (this.pending.length > 0 || this.owesNotice()) {
      if (attempts >= maxAttempts || Date.now() >= deadlineAt) {
        timedOut = true;
        break;
      }
      attempts += 1;

      const before = this.position();
      const result = this.pushOnce();
      if (result === 'empty' || result === 'fenced') break;

      if (result === 'full') {
        // Ask the sink to write what it has, then retry.
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0) {
          timedOut = true;
          break;
        }
        const mid = this.targetFlush(remaining);
        if (mid.timedOut) timedOut = true;
      }

      // Progress is MEASURED, never inferred from the result: a notice-only
      // batch that fails removes no records and settles no debt, and a sink
      // that finds a fresh loss on every append can hold the debt constant
      // indefinitely — both look like progress to a check that only asks
      // whether the push said 'failed'.
      if (advanced(before, this.position())) {
        stalls = 0;
      } else {
        stalls += 1;
        if (stalls >= MAX_STALLS) break;
      }
    }

    const final = this.targetFlush(Math.max(0, deadlineAt - Date.now()));
    if (final.timedOut) timedOut = true;

    const settled =
      final.durable && this.pending.length === 0 && !this.owesNotice();
    if (settled) {
      // Every notice accepted so far is now on disk.
      this.confirmed = { ...this.acked };
    } else {
      // An accepted notice that no flush has confirmed is not a notice yet.
      // Re-arming risks writing it twice, which beats losing it.
      this.acked = { ...this.confirmed };
    }

    // The final sync is itself a place losses are discovered — a batch the
    // writer could not land shows up in the counters it returns. Re-arm, or a
    // loss learned about here waits for the next log call to be reported, and
    // an app that has stopped logging never makes one.
    this.ensureTimer();

    return this.outcome(settled, timedOut, final.pendingBytes);
  }

  /**
   * Release timers and let the buffer go. Idempotent.
   *
   * Deliberately does not flush: `LogDestination` calls `flush()` before
   * `dispose()`, and a dispose that quietly blocked on a stalled disk would
   * turn tearing down a destination into a hang.
   */
  dispose(): void {
    this.cancelTimer();
    this.disposed = true;
    this.pending = [];
    this.pendingBytes = 0;
  }

  /**
   * Forget everything buffered and start the loss counters over, returning
   * what was discarded.
   *
   * This is the purge path. The counts go back to the caller instead of into
   * a notice, because a "4,182 entries dropped" line written into a file that
   * was just cleared for compliance reasons describes the clearing, and the
   * caller already knows it cleared the file.
   */
  discard(): LossCounts {
    const discardedEntries = this.pending.length;
    const discardedBytes = this.pendingBytes;
    this.pending = [];
    this.pendingBytes = 0;
    this.syncCounters();
    const owed = this.delta();
    this.baseline();
    this.paused = false;
    return {
      entries: discardedEntries + owed.entries,
      bytes: discardedBytes + owed.bytes,
    };
  }

  /**
   * Resume against a fresh generation after the owner has rebound.
   *
   * The sink cursors are re-read from scratch rather than carried over,
   * because the old totals are not a baseline for the new handle's. Whether
   * the sink resets its per-handle counters on rebind or keeps them running
   * is not something this side can know — and getting it wrong is silent in
   * the worse direction: keeping a stale maximum would swallow every new loss
   * smaller than the pre-purge total, reporting it zero times.
   *
   * Local counters are deliberately left alone. Records this side dropped
   * after the fence went up are real drops of real entries, and they belong
   * to the new file as much as to the old one.
   */
  rebind(): void {
    this.fenced = false;
    this.paused = false;
    this.noticeBlocked = false;
    this.observed.sinkEntries = 0;
    this.observed.sinkBytes = 0;
    this.syncCounters();
    this.acked.sinkEntries = this.observed.sinkEntries;
    this.acked.sinkBytes = this.observed.sinkBytes;
    this.confirmed.sinkEntries = this.observed.sinkEntries;
    this.confirmed.sinkBytes = this.observed.sinkBytes;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Hand at most one batch to the sink.
   *
   * The loss snapshot is taken BEFORE the call and acknowledged to that
   * snapshot rather than to the totals the call returns. A drop that happens
   * during this very append is not described by the notice riding in it, and
   * acknowledging the post-call totals would bury it.
   */
  private pushOnce(): PushResult {
    const lines: string[] = [];
    let entryCount = 0;
    let entryBytes = 0;
    for (const item of this.pending) {
      if (entryCount > 0 && entryBytes + item.bytes > this.maxBatchBytes) break;
      lines.push(item.text);
      entryBytes += item.bytes;
      entryCount += 1;
    }

    const snapshot: Cursor = { ...this.observed };
    const owed = this.delta();
    let carriesNotice = false;
    if (!this.noticeBlocked && (owed.entries > 0 || owed.bytes > 0)) {
      const notice = this.noticeText(owed);
      if (notice !== undefined) {
        lines.push(notice);
        carriesNotice = true;
      } else if (entryCount === 0) {
        // A notice that will not render, and nothing else to send. Trying
        // again in a hundred milliseconds will produce the same nothing, so
        // the debt is set aside rather than retried on a timer for the life
        // of the process. It is still owed, and an explicit flush reopens it.
        this.noticeBlocked = true;
      }
    }
    if (lines.length === 0) return 'empty';

    // Whether this batch is carrying the notice and nothing else, which is
    // what makes a rejection unrecoverable by retrying: there is no record to
    // give up to make it smaller, and no smaller notice to send.
    const noticeOnly = entryCount === 0;

    // The notice goes after the records it does not describe, so a reader
    // meets the surviving entries first and the gap where the others were.
    const batch = `${lines.join('\n')}\n`;

    let result: AppendResult;
    try {
      result = this.target.appendBatch(batch, lines.length);
    } catch {
      // A throwing sink is a failing sink. The batch is gone either way.
      this.loseHead(entryCount, entryBytes);
      if (noticeOnly) this.noticeBlocked = true;
      return 'failed';
    }

    this.observeCounts(result.lostEntries, result.lostBytes, result.degraded);

    if (result.accepted) {
      this.loseHead(entryCount, 0, false);
      if (carriesNotice) this.acked = snapshot;
      if (toCount(result.queuedBytes) >= this.watermarkBytes)
        this.paused = true;
      return 'sent';
    }

    const reason: RejectReason = result.rejectReason ?? 'failed';
    if (reason === 'staleGeneration' || reason === 'closed') {
      this.fence(reason);
      return 'fenced';
    }
    if (reason === 'full') {
      // An empty sink that still refuses means the batch is larger than the
      // sink can ever hold, not that it is busy. Waiting for room that will
      // never come wedges every later record behind this one.
      if (toCount(result.queuedBytes) === 0) {
        if (carriesNotice) {
          // The notice may be the whole reason this did not fit, so it goes
          // first — before any record is given up for it. Setting it aside
          // beats pausing on a sink that has already given its final answer:
          // the debt is kept and offered again on the next explicit flush,
          // and meanwhile records are not held behind a line about old ones.
          this.noticeBlocked = true;
          return 'failed';
        }
        const head = this.pending[0];
        if (head !== undefined) {
          // Records alone, and still too big: give up the oldest and try a
          // smaller batch.
          this.loseHead(1, head.bytes);
        }
        return 'failed';
      }
      this.paused = true;
      return 'full';
    }
    this.loseHead(entryCount, entryBytes);
    // A notice-only batch the sink rejected outright leaves the state exactly
    // as it was: nothing removed, nothing settled. Retrying it on the timer
    // is a loop with no exit.
    if (noticeOnly) this.noticeBlocked = true;
    return 'failed';
  }

  /**
   * Remove the batch's records from the head of the buffer, optionally
   * counting them as lost.
   */
  private loseHead(count: number, bytes: number, lost = true): void {
    if (count === 0) return;
    const removed = this.pending.splice(0, count);
    for (const item of removed) this.pendingBytes -= item.bytes;
    if (this.pendingBytes < 0) this.pendingBytes = 0;
    if (lost) {
      this.observed.localEntries += count;
      this.observed.localBytes += bytes;
    }
  }

  private dropped(record: string, bytes?: number): void {
    this.observed.localEntries += 1;
    this.observed.localBytes += bytes ?? utf8Length(record) + 1;
  }

  private fence(reason: FenceReason): void {
    // Pre-purge records must never be replayed into a post-purge file, and a
    // notice about them is a statement about data that was deliberately
    // deleted. Both go.
    this.pending = [];
    this.pendingBytes = 0;
    this.syncCounters();
    this.baseline();
    this.fenced = true;
    this.paused = false;
    this.cancelTimer();
    try {
      this.onFenced?.(reason);
    } catch {
      // the owner's problem, not the pipeline's
    }
  }

  /**
   * Bring the sink's counters up to date without writing anything.
   *
   * Cursors normally advance off append results, which means a loss the sink
   * has recorded but not yet had occasion to report is invisible here. Before
   * drawing a line under the past — a purge, a fence — that window has to be
   * closed, or a loss from the old file crosses over and gets described as if
   * it had happened to the new one.
   */
  private syncCounters(): void {
    try {
      const status = this.target.getStatus();
      this.observeCounts(status.lostEntries, status.lostBytes, status.degraded);
    } catch {
      // An unreadable probe just means the line is drawn where we stand.
    }
  }

  /** Declare every loss seen so far as settled, reporting none of it. */
  private baseline(): void {
    this.acked = { ...this.observed };
    this.confirmed = { ...this.observed };
  }

  private noticeText(lost: LossCounts): string | undefined {
    let text: string | undefined;
    try {
      text = this.renderNotice(lost);
    } catch {
      return undefined;
    }
    return typeof text === 'string' && text.length > 0 ? text : undefined;
  }

  private delta(): LossCounts {
    return {
      entries: Math.max(
        0,
        this.observed.sinkEntries -
          this.acked.sinkEntries +
          (this.observed.localEntries - this.acked.localEntries)
      ),
      bytes: Math.max(
        0,
        this.observed.sinkBytes -
          this.acked.sinkBytes +
          (this.observed.localBytes - this.acked.localBytes)
      ),
    };
  }

  private owesNotice(): boolean {
    const owed = this.delta();
    return owed.entries > 0 || owed.bytes > 0;
  }

  /** Where the drain has got to: records still buffered, loss still owed. */
  private position(): Position {
    const owed = this.delta();
    return {
      entries: this.pending.length,
      bytes: this.pendingBytes,
      owedEntries: owed.entries,
      owedBytes: owed.bytes,
    };
  }

  /**
   * Fold sink counters in. They are monotonic per handle, so the maximum
   * seen is the truth; a sink that reported a smaller number than last time
   * would otherwise drive the delta negative and cancel a real loss.
   */
  private observeCounts(
    lostEntries: number,
    lostBytes: number,
    degraded: number
  ): void {
    this.observed.sinkEntries = Math.max(
      this.observed.sinkEntries,
      toCount(lostEntries)
    );
    this.observed.sinkBytes = Math.max(
      this.observed.sinkBytes,
      toCount(lostBytes)
    );
    this.degraded = toCount(degraded);
  }

  private targetFlush(deadlineMs: number): FlushOutcome {
    let outcome: FlushOutcome;
    try {
      outcome = this.target.flush(clampDeadline(deadlineMs));
    } catch {
      return {
        durable: false,
        timedOut: true,
        pendingBytes: 0,
        queuedBytes: 0,
        lostBytes: this.observed.sinkBytes,
        lostEntries: this.observed.sinkEntries,
        degraded: this.degraded,
      };
    }
    this.observeCounts(
      outcome.lostEntries,
      outcome.lostBytes,
      outcome.degraded
    );
    return outcome;
  }

  private outcome(
    durable: boolean,
    timedOut: boolean,
    sinkPending: number
  ): BatchFlushOutcome {
    const owed = this.delta();
    return {
      durable,
      timedOut,
      // Both sides of the handoff: what never left the JS buffer, plus what
      // the sink took but has not made durable.
      pendingBytes: this.pendingBytes + toCount(sinkPending),
      unreportedEntries: owed.entries,
      unreportedBytes: owed.bytes,
      degraded: this.degraded,
    };
  }

  // ── Timer ───────────────────────────────────────────────────────────────

  private ensureTimer(): void {
    if (this.timer !== undefined || this.disposed || this.fenced) return;
    // A blocked notice is not a reason to keep ticking: the sink has already
    // refused it, and the next explicit flush is what retries.
    const owed = this.owesNotice() && !this.noticeBlocked;
    if (this.pending.length === 0 && !this.paused && !owed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onTick();
    }, this.flushIntervalMs);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private onTick(): void {
    if (this.disposed || this.fenced) return;

    if (this.paused) {
      // The non-enqueuing probe: this is the call that is specified to be
      // answerable while the writer thread is stalled on disk, and the whole
      // pause/resume cycle rests on that.
      try {
        const status = this.target.getStatus();
        this.observeCounts(
          status.lostEntries,
          status.lostBytes,
          status.degraded
        );
        if (toCount(status.queuedBytes) < this.watermarkBytes) {
          this.paused = false;
        }
      } catch {
        // stay paused; try again next tick
      }
    }

    if (!this.paused) {
      for (let i = 0; i < PUSHES_PER_TICK; i += 1) {
        const result = this.pushOnce();
        if (result !== 'sent') break;
        if (this.paused) break;
      }
    }

    this.ensureTimer();
  }
}

function zeroCursor(): Cursor {
  return { sinkEntries: 0, sinkBytes: 0, localEntries: 0, localBytes: 0 };
}

/**
 * Did the drain get anywhere between these two positions?
 *
 * The two halves are compared separately rather than summed, because a batch
 * the sink refused moves records out of the buffer and into the debt they now
 * owe a notice — a conserved total, and real progress. Summing them says the
 * drain is stuck at exactly the moment it is working through a failing sink,
 * and abandons the records queued behind the ones it just gave up on.
 */
function advanced(before: Position, after: Position): boolean {
  if (after.entries < before.entries || after.bytes < before.bytes) return true;
  return (
    after.owedEntries < before.owedEntries || after.owedBytes < before.owedBytes
  );
}

/** A count from across the bridge; anything not a positive number is zero. */
function toCount(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function clampDeadline(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), MAX_DEADLINE_MS);
}
