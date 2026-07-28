import type {
  AppendResult,
  ClearOutcome,
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
    const deleted = this.writer.file.length;
    const durable = this.writer.purge();
    // The invoking handle rebinds only on durable success; on failure it
    // stays behind the bumped generation along with every other handle.
    if (durable) this.generation = this.writer.generation;
    return {
      deletedCount: durable ? deleted : 0,
      failedPaths: durable ? [] : [this.openedPath ?? ''],
      durable,
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
