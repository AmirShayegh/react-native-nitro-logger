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

/** No bundle, and the collect did not finish. */
const NOTHING_COLLECTED: CollectOutcome = {
  path: '',
  byteCount: 0,
  sourceFileCount: 0,
  truncated: false,
  complete: false,
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
  /** Refuse every append with 'closed'. */
  closed = false;
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
    this.writer.claimPath(path);
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
    if (this.closed) return this.reject('closed');
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
    return this.status();
  }

  maintain(deadlineMs: number): SinkStatus {
    this.maintainCalls.push(deadlineMs);
    if (this.maintainThrows) throw new Error('maintenance unavailable');
    // Both natives gate this on the handle still being live and answer a
    // zeroed status otherwise — the sweep belongs to whoever holds the writer
    // now, not to a handle a purge fenced.
    if (this.closed || this.generation !== this.writer.generation) {
      return { queuedBytes: 0, lostBytes: 0, lostEntries: 0, degraded: 0 };
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
    if (this.closed || this.generation !== this.writer.generation) {
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
    const outcome = this.flush(deadlineMs);
    this.closed = true;
    return outcome;
  }

  getLogFilePaths(): string[] {
    return this.openedPath ? [this.openedPath] : [];
  }

  clearLogs(_deadlineMs: number): ClearOutcome {
    this.clearCalls += 1;
    // A closed sink has no handle to delete through, and the file it wrote is
    // still there. Both native adapters answer `durable: false` here; a double
    // that purged anyway would let a purge-after-dispose test pass against a
    // library that reports a successful compliance deletion over surviving
    // files. The double has to be able to fail the way the real thing fails.
    //
    // Which means answering the way they answer, not merely failing: this is
    // the `FileSinkLifecycle` table, and both natives derive these two fields
    // from it.
    //
    // - `failedPaths` is empty. There is no handle, so nothing was attempted,
    //   and naming a path here would report a *deletion failure* for a file
    //   nobody tried to delete. This double used to name one.
    // - `durable` is vacuously true for a sink that never opened — nothing was
    //   ever created, so "every artifact is gone" holds with nothing to check
    //   — and false once files may exist. It used to be hardcoded false, which
    //   re-arms a compliance failure for a sink that cannot owe one.
    //
    // Dead today: `FileDestination.purge` short-circuits before reaching a
    // disposed sink. Fixed anyway, because the reason it is dead is a guard in
    // the caller, and the next caller inherits whatever this says.
    if (this.closed) {
      return {
        deletedCount: 0,
        failedPaths: [],
        durable: this.openedPath === undefined,
        rebound: false,
      };
    }
    const deleted = this.writer.file.length;
    const durable = this.writer.purge();
    // Deletion succeeding and the writer being usable again are separate
    // facts, and the native sink reports them separately. The invoking handle
    // rebinds only when both hold; otherwise it stays behind the bumped
    // generation along with every other handle.
    const rebound = durable && !this.writer.reopenFails;
    if (rebound) this.generation = this.writer.generation;
    return {
      deletedCount: durable ? deleted : 0,
      failedPaths: durable ? [] : [this.openedPath ?? ''],
      durable,
      rebound,
    };
  }

  private status(): SinkStatus {
    const totals = this.writer.totals(this.id);
    return {
      queuedBytes: this.writer.queuedBytes,
      lostBytes: totals.bytes,
      lostEntries: totals.entries,
      degraded: this.writer.degraded,
    };
  }

  private reject(rejectReason: AppendResult['rejectReason']): AppendResult {
    return { accepted: false, rejectReason, ...this.status() };
  }
}
