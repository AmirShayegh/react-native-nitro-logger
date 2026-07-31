import type {
  AppendResult,
  ClearOutcome,
  CollectOutcome,
  FlushOutcome,
  RotationConfig,
  SinkStatus,
} from '../../src/specs/FileSink.nitro';
import type { FileSinkLike } from '../../src/destinations/FileDestination';
import { utf8Length } from '../../src/utf8';

/**
 * A scriptable stand-in for the native file writer.
 *
 * It exists because every interesting property of the pipeline — backpressure,
 * drop accounting, the purge handshake, what happens when the disk stops
 * answering — is a property of how JavaScript reacts to the sink, not of the
 * sink itself. Faults that are awkward to stage on a device (a writer thread
 * wedged mid-write, an fsync that never succeeds, a generation bumped out
 * from under a live handle) are one field assignment here.
 *
 * The split into writer and handle is the shape the native registry has:
 * handles for one canonical path share a writer, losses are attributed to the
 * handle whose batch was lost, and a purge bumps a generation that fences
 * every handle that has not rebound.
 */
export class MemoryWriter {
  /** Bumped by every purge; a handle below it is fenced. */
  generation = 1;
  /** Batches that reached storage, in order. */
  readonly file: string[] = [];
  /** Accepted, not yet durable. */
  private queue: Queued[] = [];
  queuedBytes = 0;

  /** Queue cap; a batch that would exceed it is rejected 'full'. */
  capacityBytes = Number.POSITIVE_INFINITY;
  /** Writer thread wedged: flush drains nothing and reports a timeout. */
  hung = false;
  /** Data lands but cannot be fsynced — a full disk, essentially. */
  syncFails = false;
  /** Terminal write failure: queued batches are lost on flush, not written. */
  writeFails = false;
  /** Deletion cannot complete. */
  clearFails = false;
  /**
   * Deletion completes, but the writer cannot open a file afterwards — an
   * unwritable directory, a volume that filled. The distinct half of the purge
   * contract: everything really is gone, and there is still nowhere to write.
   */
  reopenFails = false;
  /** Payload-free degradation bitmask handed back in every result. */
  degraded = 0;

  /** Monotonic loss totals, attributed to the handle whose batch was lost. */
  readonly loss = new Map<number, LossTotals>();

  private nextHandle = 1;
  private openPath: string | undefined;

  /** A second handle on the same writer — a second runtime, in effect. */
  attach(): MemoryFileSink {
    const id = this.nextHandle;
    this.nextHandle += 1;
    return new MemoryFileSink(this, id);
  }

  /** Every record written so far, one per line. */
  lines(): string[] {
    return this.file
      .join('')
      .split('\n')
      .filter((line) => line.length > 0);
  }

  /** Stage a loss the writer discovered on its own — a rotation that ate a
   * batch, a short write that could not be retried. */
  injectLoss(handleId: number, entries: number, bytes: number): void {
    const totals = this.totals(handleId);
    totals.entries += entries;
    totals.bytes += bytes;
  }

  totals(handleId: number): LossTotals {
    let totals = this.loss.get(handleId);
    if (!totals) {
      totals = { entries: 0, bytes: 0 };
      this.loss.set(handleId, totals);
    }
    return totals;
  }

  claimPath(path: string): void {
    if (this.openPath !== undefined && this.openPath !== path) {
      throw new Error('conflicting open on the same writer');
    }
    this.openPath = path;
  }

  accept(handleId: number, batch: string, entryCount: number): boolean {
    const bytes = utf8Length(batch);
    if (this.queuedBytes + bytes > this.capacityBytes) return false;
    this.queue.push({ handleId, text: batch, entryCount, bytes });
    this.queuedBytes += bytes;
    return true;
  }

  drain(): { durable: boolean; timedOut: boolean } {
    if (this.hung) return { durable: false, timedOut: true };
    const draining = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    for (const item of draining) {
      if (this.writeFails) {
        const totals = this.totals(item.handleId);
        totals.entries += item.entryCount;
        totals.bytes += item.bytes;
      } else {
        this.file.push(item.text);
      }
    }
    return {
      durable: !this.writeFails && !this.syncFails,
      timedOut: false,
    };
  }

  purge(): boolean {
    this.generation += 1;
    if (this.clearFails) return false;
    this.queue = [];
    this.queuedBytes = 0;
    this.file.length = 0;
    // The loss totals described data that no longer exists, so they go with
    // it. A handle that rebinds meets counters starting from zero again —
    // the case where carrying a stale maximum forward would swallow every
    // smaller loss that follows.
    this.loss.clear();
    return true;
  }
}

interface Queued {
  readonly handleId: number;
  readonly text: string;
  readonly entryCount: number;
  readonly bytes: number;
}

interface LossTotals {
  entries: number;
  bytes: number;
}

/** No bundle, and the collect did not finish — a fenced handle's answer. */
const NOTHING_COLLECTED: CollectOutcome = {
  path: '',
  byteCount: 0,
  sourceFileCount: 0,
  truncated: false,
  complete: false,
};

/**
 * No bundle, and there was nothing to put in one.
 *
 * `complete: true` is the difference that matters, and it is what both
 * adapters answer with no handle: a sink nobody opened has finished collecting
 * everything it has.
 */
const NOTHING_TO_COLLECT: CollectOutcome = {
  ...NOTHING_COLLECTED,
  complete: true,
};

/** The status both adapters report when there is no handle to ask. */
const ZEROED: SinkStatus = {
  queuedBytes: 0,
  lostBytes: 0,
  lostEntries: 0,
  degraded: 0,
};

/** One handle on a {@link MemoryWriter}; one `FileDestination` drives one. */
export class MemoryFileSink implements FileSinkLike {
  readonly defaultLogDirectory = '/memory/logs';
  readonly writer: MemoryWriter;
  readonly id: number;

  /** What `open` was told, so a test can assert the framing declaration. */
  openedPath: string | undefined;
  openedRotation: RotationConfig | undefined;
  openedLineFramed: boolean | undefined;
  openCount = 0;

  /** Call counters, for asserting a probe stayed off the writer queue. */
  statusCalls = 0;
  appendCalls: Array<{ batch: string; entryCount: number }> = [];
  clearCalls = 0;
  closeCalls = 0;

  /** Reject the next N appends with 'failed'. */
  failNextAppends = 0;
  /** Throw out of the next N appends, as a native call can. */
  throwNextAppends = 0;
  /**
   * Which of the two bits every no-handle answer is derived from.
   *
   * The natives do not carry a "closed" boolean; they carry a handle that is
   * either there or not, plus `FileSinkLifecycle.vacuousSuccess`. Deriving the
   * answers from the same two bits here is what stops this double drifting
   * from the table both adapters implement — it had drifted on four rows.
   */
  private state: 'idle' | 'open' | 'closed' = 'idle';

  /**
   * The negation of `FileSinkLifecycle.vacuousSuccess`.
   *
   * Set when the open is *claimed*, not when it succeeds, for the reason the
   * Swift twin gives: `acquire` creates the log directory before it opens the
   * file, so a failed open is not evidence that nothing was written.
   */
  private mayHaveArtifacts = false;

  /**
   * Whether this sink has no live handle.
   *
   * A settable alias kept because tests use `sink.closed = true` to mean "now
   * behave like a sink whose handle is gone", which is a legitimate thing to
   * stage. Reading it answers the natives' question — `current() == nil` —
   * which is why a sink that was never opened reads as closed: it has no
   * handle either.
   */
  get closed(): boolean {
    return this.state !== 'open';
  }

  set closed(value: boolean) {
    // Only ever closes. Assigning `false` would put the double in a state no
    // adapter can be in — live handle, no path claimed, nothing opened — and
    // the whole point of computing the answers from the state is that a test
    // cannot script its way into a lifecycle the natives cannot reach.
    if (!value) {
      throw new Error(
        'a live handle comes from open(), not from an assignment'
      );
    }
    this.state = 'closed';
  }

  /**
   * Artifacts the sink left behind, listed when there is no live handle.
   *
   * The natives answer `getLogFilePaths` on a closed sink from the *recorded
   * path*, not from the handle — closing releases a handle, it does not delete
   * files, and `[]` would tell a support-upload flow there is nothing to
   * collect over logs still sitting on the device. Defaults to the log file
   * alone; a test staging archives assigns the fuller list, which is the only
   * way to exercise the multi-file shape from JavaScript.
   */
  artifactPaths: string[] | undefined;

  /**
   * Fields merged over the computed [getStatus] answer.
   *
   * The double must be able to lie the way a native across a bridge can lie —
   * a status that reports bytes queued on a sink that has none, a degradation
   * bit nothing set. **Nothing else in this file may.** Every other answer is
   * computed from the state above, because a double that can be told what to
   * say about its own lifecycle is a double that cannot disagree with the
   * caller, and disagreeing is the entire job.
   */
  hostileStatus: Partial<SinkStatus> | undefined;

  /** The same hatch for [clearLogs]. See [hostileStatus]. */
  hostileClear: Partial<ClearOutcome> | undefined;
  /** Throw out of getStatus. */
  statusThrows = false;
  /** Throw out of maintain, as a native call can. */
  maintainThrows = false;
  /** Deadlines `maintain` was called with, in order. */
  maintainCalls: number[] = [];
  /** Runs on the writer queue, where the real sweep runs. */
  onMaintain: (() => void) | undefined;
  /** Throw out of collectLogs, as a native call can. */
  collectThrows = false;
  /** Arguments every collect was called with, in order. */
  collectCalls: Array<{ deadlineMs: number; maxTotalBytes: number }> = [];
  /**
   * What each produced bundle contained, in order.
   *
   * The real bundle is gzip; this is the plaintext that went into it, which
   * is what a JS-side test can actually assert about — that the collect saw
   * the records the batcher was still holding when it was called.
   */
  collectedBundles: string[] = [];
  /** Runs on the writer queue, where the real bundle is built. */
  onCollect: (() => void) | undefined;

  private generation: number;

  constructor(writer: MemoryWriter = new MemoryWriter(), id = 1) {
    this.writer = writer;
    this.id = id;
    this.generation = writer.generation;
  }

  open(path: string, rotation?: RotationConfig, lineFramed?: boolean): void {
    // Forfeited before anything that can fail, matching `beginOpen`: the
    // directory may already have been created by the time an open throws, so a
    // sink whose open failed can no longer claim that nothing exists.
    this.mayHaveArtifacts = true;
    this.writer.claimPath(path);
    this.state = 'open';
    this.openedPath = path;
    this.openedRotation = rotation;
    this.openedLineFramed = lineFramed;
    this.openCount += 1;
    this.generation = this.writer.generation;
  }

  appendBatch(batch: string, entryCount: number): AppendResult {
    this.appendCalls.push({ batch, entryCount });
    if (this.throwNextAppends > 0) {
      this.throwNextAppends -= 1;
      throw new Error('native append failed');
    }
    // Covers the sink that was never opened too, which is the point: it has no
    // handle either, and this double used to accept its batches.
    if (this.closed) {
      return {
        accepted: false,
        rejectReason: 'closed',
        ...this.withHostileStatus(ZEROED),
      };
    }
    if (this.generation !== this.writer.generation) {
      return this.reject('staleGeneration');
    }
    if (this.failNextAppends > 0) {
      this.failNextAppends -= 1;
      return this.reject('failed');
    }
    if (!this.writer.accept(this.id, batch, entryCount)) {
      return this.reject('full');
    }
    return { accepted: true, ...this.status() };
  }

  getStatus(): SinkStatus {
    this.statusCalls += 1;
    if (this.statusThrows) throw new Error('status unavailable');
    // No handle, nothing to report — the same zeroed answer both adapters
    // give, rather than the last status the handle happened to have.
    return this.closed ? this.withHostileStatus(ZEROED) : this.status();
  }

  maintain(deadlineMs: number): SinkStatus {
    this.maintainCalls.push(deadlineMs);
    if (this.maintainThrows) throw new Error('maintenance unavailable');
    // Both natives gate this on the handle still being live and answer a
    // zeroed status otherwise — the sweep belongs to whoever holds the writer
    // now, not to a handle a purge fenced.
    if (this.closed || this.generation !== this.writer.generation) {
      return this.withHostileStatus(ZEROED);
    }
    this.onMaintain?.();
    return this.status();
  }

  /**
   * The bundle the last successful collect would have written.
   *
   * Same shape as both natives: a fixed name beside the log file, never a
   * path the caller chose.
   */
  get bundlePath(): string {
    return this.openedPath === undefined ? '' : `${this.openedPath}.support.gz`;
  }

  collectLogs(deadlineMs: number, maxTotalBytes: number): CollectOutcome {
    this.collectCalls.push({ deadlineMs, maxTotalBytes });
    if (this.collectThrows) throw new Error('collect unavailable');
    // The same gate both natives apply. A fenced or closed handle does not
    // pack the files it used to own; they belong to whoever holds the writer
    // now, and a bundle built from them would be a stale-generation read of
    // somebody else's log.
    // Two different answers, and they used to be one. A *fenced* handle has
    // collected nothing and is not finished — the files belong to whoever holds
    // the writer now. A sink with no handle at all has finished collecting
    // everything it has, which is nothing: `complete: true`, because a support
    // flow must not show a failure for an app that simply has no logs yet.
    if (this.closed) return { ...NOTHING_TO_COLLECT };
    if (this.generation !== this.writer.generation) {
      return { ...NOTHING_COLLECTED };
    }

    this.onCollect?.();
    const contents = this.writer.file.join('');
    const bytes = utf8Length(contents);
    // A ceiling that is not a number is zero, never "no ceiling". This mirrors
    // `byteCap` on both natives; the destination rejects those values before
    // they reach a sink, and the double still has to fail the same way, or a
    // future caller that skips the check meets a double that sends everything.
    const cap =
      Number.isFinite(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : 0;

    // Nothing to pack is a finished collect, not a failed one — a device with
    // no logs is not an error a support flow should show.
    if (bytes === 0) {
      return {
        path: '',
        byteCount: 0,
        sourceFileCount: 0,
        truncated: false,
        complete: true,
      };
    }
    // One file, so the ceiling is all-or-nothing here; newest-first selection
    // across several is the natives' behaviour and is pinned there.
    if (bytes > cap) {
      return {
        path: '',
        byteCount: 0,
        sourceFileCount: 0,
        truncated: true,
        complete: true,
      };
    }

    this.collectedBundles.push(contents);
    return {
      path: this.bundlePath,
      byteCount: bytes,
      sourceFileCount: 1,
      truncated: false,
      complete: true,
    };
  }

  flush(deadlineMs: number): FlushOutcome {
    if (this.closed) return this.noHandleOutcome();
    const before = this.writer.queuedBytes;
    const result =
      deadlineMs > 0
        ? this.writer.drain()
        : { durable: this.writer.queuedBytes === 0, timedOut: true };
    return {
      durable: result.durable,
      timedOut: result.timedOut,
      pendingBytes: result.timedOut ? before : 0,
      ...this.status(),
    };
  }

  close(deadlineMs: number): FlushOutcome {
    this.closeCalls += 1;
    // Idempotent, like `beginClose`: the second close finds no handle and
    // answers without draining anything. Draining again would let a test see a
    // durable flush from a sink that has nothing left to flush through.
    if (this.closed) return this.noHandleOutcome();
    const outcome = this.flush(deadlineMs);
    this.state = 'closed';
    return outcome;
  }

  getLogFilePaths(): string[] {
    if (this.openedPath === undefined) return [];
    // Not `[]` for a closed sink. Closing releases a handle; it does not delete
    // files, and answering `[]` tells a support-upload flow there is nothing to
    // collect over logs that are still on the device.
    return this.artifactPaths ?? [this.openedPath];
  }

  clearLogs(_deadlineMs: number): ClearOutcome {
    this.clearCalls += 1;
    // No live handle to delete through — the sink was closed, or was never
    // opened at all. A double that purged anyway would let a
    // purge-after-dispose test pass against a library reporting a successful
    // compliance deletion over surviving files.
    //
    // Which means answering the way the adapters answer, not merely failing:
    // this is the `FileSinkLifecycle` table, and both derive these fields from
    // the same two bits.
    //
    // Dead today: `FileDestination.purge` short-circuits before reaching a
    // disposed sink. Right anyway, because the reason it is dead is a guard in
    // the caller, and the next caller inherits whatever this says.
    if (this.closed) {
      return this.withHostileClear({
        deletedCount: 0,
        // No handle, so nothing was attempted. Naming a path here reports a
        // deletion *failure* for a file nobody tried to delete.
        failedPaths: [],
        // Vacuously true only while nothing may exist. Derived from the same
        // bit the natives read, rather than from whether `open` was called —
        // an open that threw halfway may still have created the directory.
        durable: !this.mayHaveArtifacts,
        // Nothing to rebind onto, whatever else is true.
        rebound: false,
      });
    }
    const deleted = this.writer.file.length;
    const durable = this.writer.purge();
    // Deletion succeeding and the writer being usable again are separate
    // facts, and the native sink reports them separately. The invoking handle
    // rebinds only when both hold; otherwise it stays behind the bumped
    // generation along with every other handle.
    const rebound = durable && !this.writer.reopenFails;
    if (rebound) this.generation = this.writer.generation;
    // Staged archives are artifacts, and a durable purge deletes artifacts. A
    // rebound purge recreates the log file and nothing else; one that could not
    // reopen leaves the directory empty. Untouched when the deletion failed —
    // that is the case where the files are still there.
    if (durable) {
      this.artifactPaths =
        rebound && this.openedPath !== undefined ? [this.openedPath] : [];
    }
    return this.withHostileClear({
      deletedCount: durable ? deleted : 0,
      failedPaths: durable ? [] : [this.openedPath ?? ''],
      durable,
      rebound,
    });
  }

  private status(): SinkStatus {
    const totals = this.writer.totals(this.id);
    return this.withHostileStatus({
      queuedBytes: this.writer.queuedBytes,
      lostBytes: totals.bytes,
      lostEntries: totals.entries,
      degraded: this.writer.degraded,
    });
  }

  /** What both adapters answer for a flush or a close with no handle. */
  private noHandleOutcome(): FlushOutcome {
    return {
      durable: !this.mayHaveArtifacts,
      timedOut: false,
      pendingBytes: 0,
      ...this.withHostileStatus(ZEROED),
    };
  }

  // Both always build a fresh object, even with no override to merge. Handing
  // back the shared `ZEROED` constant would let one caller mutating a status it
  // was given change what every later call on every sink reports — a failure
  // mode a real bridge, which marshals a new value each time, does not have.
  private withHostileStatus(computed: SinkStatus): SinkStatus {
    return { ...computed, ...(this.hostileStatus ?? {}) };
  }

  private withHostileClear(computed: ClearOutcome): ClearOutcome {
    return { ...computed, ...(this.hostileClear ?? {}) };
  }

  private reject(rejectReason: AppendResult['rejectReason']): AppendResult {
    return { accepted: false, rejectReason, ...this.status() };
  }
}
