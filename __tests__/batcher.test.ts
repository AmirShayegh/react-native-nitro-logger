import { Batcher } from '../src/destinations/Batcher';
import type { BatcherOptions, FenceReason } from '../src/destinations/Batcher';
import { MemoryWriter } from './helpers/MemoryFileSink';
import type { MemoryFileSink } from './helpers/MemoryFileSink';
import { utf8Length } from '../src/utf8';

/** Loss notices are a plain, greppable line so tests read as behaviour. */
function notice(lost: { entries: number; bytes: number }): string {
  return `LOST ${lost.entries}/${lost.bytes}`;
}

function noticeLines(writer: MemoryWriter): string[] {
  return writer.lines().filter((line) => line.startsWith('LOST '));
}

function build(overrides: Partial<BatcherOptions> = {}): {
  batcher: Batcher;
  sink: MemoryFileSink;
  writer: MemoryWriter;
} {
  const writer = new MemoryWriter();
  const sink = writer.attach();
  sink.open('/memory/logs/app.log');
  const batcher = new Batcher(sink, {
    renderNotice: notice,
    batchBytes: 64,
    flushIntervalMs: 100,
    watermarkBytes: 256,
    ...overrides,
  });
  return { batcher, sink, writer };
}

/** A record of a known size, so byte assertions can be exact. */
function record(size: number, fill = 'a'): string {
  return fill.repeat(size);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Batcher — batching', () => {
  test('holds records until the byte threshold, then sends one batch', () => {
    const { batcher, sink, writer } = build({ batchBytes: 64 });

    batcher.add(record(20));
    batcher.add(record(20));
    expect(sink.appendCalls).toHaveLength(0);

    batcher.add(record(20)); // 3 × 21 = 63 … still under
    expect(sink.appendCalls).toHaveLength(0);

    batcher.add(record(20)); // 84 ≥ 64
    expect(sink.appendCalls).toHaveLength(1);
    expect(sink.appendCalls[0]!.entryCount).toBe(4);

    batcher.flush(1000);
    expect(writer.lines()).toHaveLength(4);
  });

  test('the idle timer sends what the threshold never would', () => {
    const { batcher, sink } = build({ batchBytes: 4096 });
    batcher.add('one');
    expect(sink.appendCalls).toHaveLength(0);

    jest.advanceTimersByTime(100);
    expect(sink.appendCalls).toHaveLength(1);
    expect(sink.appendCalls[0]!.batch).toBe('one\n');
  });

  test('every record in a batch is newline-terminated', () => {
    const { batcher, sink } = build();
    batcher.add('a');
    batcher.add('b');
    batcher.flush(1000);

    const batch = sink.appendCalls[0]!.batch;
    expect(batch).toBe('a\nb\n');
    expect(batch.endsWith('\n')).toBe(true);
    // entryCount is the loss unit: it must count records, not batches.
    expect(sink.appendCalls[0]!.entryCount).toBe(2);
  });

  test('the timer stops once there is nothing to send', () => {
    const { batcher, sink } = build();
    batcher.add('a');
    jest.advanceTimersByTime(100);
    expect(sink.appendCalls).toHaveLength(1);

    jest.advanceTimersByTime(10_000);
    expect(sink.appendCalls).toHaveLength(1);
  });
});

describe('Batcher — drop-newest', () => {
  test('the arriving record is dropped, not the oldest held', () => {
    const { batcher, writer } = build({
      batchBytes: 1_000_000, // never send on size
      maxPendingEntries: 3,
    });

    batcher.add('first');
    batcher.add('second');
    batcher.add('third');
    batcher.add('fourth'); // over the cap

    batcher.flush(1000);
    const lines = writer.lines();
    expect(lines).toContain('first');
    expect(lines).not.toContain('fourth');
    expect(noticeLines(writer)).toEqual(['LOST 1/7']);
  });

  test('the byte cap binds independently of the entry cap', () => {
    const { batcher, writer } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 1000,
      maxPendingBytes: 40,
    });

    batcher.add(record(19)); // 20 bytes
    batcher.add(record(19)); // 40 bytes — exactly at the cap
    batcher.add(record(19)); // would be 60
    expect(batcher.bufferedBytes()).toBe(40);
    expect(batcher.unreported()).toEqual({ entries: 1, bytes: 20 });

    batcher.flush(1000);
    expect(writer.lines().filter((l) => l.startsWith('a'))).toHaveLength(2);
  });

  test('drops keep accruing while the buffer stays full', () => {
    const { batcher } = build({ batchBytes: 1_000_000, maxPendingEntries: 1 });
    batcher.add('kept');
    for (let i = 0; i < 5; i += 1) batcher.add('gone');
    expect(batcher.unreported().entries).toBe(5);
  });
});

describe('Batcher — loss notices', () => {
  test('the notice rides the next batch, after the records it excludes', () => {
    const { batcher, sink, writer } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 2,
    });

    batcher.add('kept-1');
    batcher.add('kept-2');
    batcher.add('dropped'); // 8 bytes with its newline
    batcher.flush(1000);

    expect(writer.lines()).toEqual(['kept-1', 'kept-2', 'LOST 1/8']);
    expect(sink.appendCalls[0]!.entryCount).toBe(3);
  });

  test('sink-side and local losses consolidate into one notice', () => {
    const { batcher, sink, writer } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 1,
    });

    // The sink's counters are read from whatever it hands back, so the first
    // append is what reveals the 4/400 — and it is also the one that fails,
    // adding its own record to the tally. All of it lands in one notice.
    writer.injectLoss(sink.id, 4, 400);
    sink.failNextAppends = 1;
    batcher.add('kept'); // 5 bytes, lost with its batch
    batcher.add('dropped'); // 8 bytes, dropped at the cap
    batcher.flush(1000);

    // 4/400 from the sink, plus the 5-byte record its batch took down with
    // it, plus the 8-byte record the cap refused.
    expect(noticeLines(writer)).toEqual(['LOST 6/413']);
  });

  test('a loss the batcher has not been told about yet is not in the notice', () => {
    // Cursors are consumed from append results and status probes. A loss the
    // sink has recorded but not yet reported rides the batch after the one
    // that reveals it — never the batch that was built before anyone knew.
    const { batcher, sink, writer } = build({ batchBytes: 1_000_000 });
    writer.injectLoss(sink.id, 4, 400);

    batcher.add('first');
    batcher.flush(1000);

    expect(writer.lines()).toEqual(['first', 'LOST 4/400']);
  });

  test('a settled notice is not written again', () => {
    const { batcher, writer } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 1,
    });

    batcher.add('kept');
    batcher.add('dropped');
    batcher.flush(1000);
    expect(noticeLines(writer)).toHaveLength(1);

    batcher.add('later');
    batcher.flush(1000);
    expect(noticeLines(writer)).toHaveLength(1);
  });

  test('a notice no flush confirmed is written again', () => {
    // Observed-versus-acknowledged: the sink took the notice but could not
    // fsync it. Reporting the loss twice is recoverable; reporting it zero
    // times means the counters were decoration.
    const { batcher, writer } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 1,
    });

    writer.syncFails = true;
    batcher.add('kept');
    batcher.add('dropped');
    const first = batcher.flush(1000);
    expect(first.durable).toBe(false);
    expect(first.unreportedEntries).toBe(1);
    expect(noticeLines(writer)).toEqual(['LOST 1/8']);

    writer.syncFails = false;
    batcher.flush(1000);
    expect(noticeLines(writer)).toEqual(['LOST 1/8', 'LOST 1/8']);

    // Now confirmed: it stops.
    batcher.flush(1000);
    expect(noticeLines(writer)).toHaveLength(2);
  });

  test('a loss discovered during the very append is not acknowledged by it', () => {
    // The notice describes the totals as of before the call. A drop the sink
    // reports back in that same result is not in it, so acknowledging the
    // post-call totals would bury a real loss forever.
    const writer = new MemoryWriter();
    const sink = writer.attach();
    sink.open('/memory/logs/app.log');

    const append = sink.appendBatch.bind(sink);
    let staged = false;
    sink.appendBatch = (batch, entryCount) => {
      if (!staged) {
        staged = true;
        writer.injectLoss(sink.id, 9, 900); // discovered mid-append
      }
      return append(batch, entryCount);
    };

    const batcher = new Batcher(sink, {
      renderNotice: notice,
      batchBytes: 1_000_000,
      maxPendingEntries: 1,
    });

    batcher.add('kept');
    batcher.add('dropped'); // local loss of 1/8
    batcher.flush(1000);

    // Two notices, not one. Acknowledging the totals the call returned would
    // have folded 9/900 into a notice that says 1/8, and it would never have
    // been mentioned again.
    expect(noticeLines(writer)).toEqual(['LOST 1/8', 'LOST 9/900']);
  });

  test('an unrenderable notice leaves the loss owed', () => {
    const { batcher, writer } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 1,
      renderNotice: () => {
        throw new Error('formatter exploded');
      },
    });

    batcher.add('kept');
    batcher.add('dropped');
    batcher.flush(1000);

    expect(writer.lines()).toEqual(['kept']);
    expect(batcher.unreported()).toEqual({ entries: 1, bytes: 8 });
  });

  test('a sink reporting a smaller total than before cannot cancel a loss', () => {
    const { batcher, sink, writer } = build({ batchBytes: 1_000_000 });
    writer.injectLoss(sink.id, 3, 30);
    batcher.add('trigger');
    batcher.flush(1000);
    expect(noticeLines(writer)).toEqual(['LOST 3/30']);

    // Monotonic by contract; a handle that regresses is not believed.
    writer.loss.set(sink.id, { entries: 0, bytes: 0 });
    batcher.add('after');
    batcher.flush(1000);
    expect(noticeLines(writer)).toHaveLength(1);
  });

  test('a loss found by the final sync is reported without another log call', () => {
    // Nothing has to be logged afterwards for the notice to appear: an app
    // that flushes on the way to the background and then stops logging still
    // records what that flush discovered.
    const { batcher, writer } = build({ batchBytes: 1_000_000 });
    batcher.add('first'); // 6 bytes
    writer.writeFails = true; // the batch dies during the final sync

    const outcome = batcher.flush(1000);
    expect(outcome.durable).toBe(false);
    expect(outcome.unreportedEntries).toBe(1);

    writer.writeFails = false;
    jest.advanceTimersByTime(100);
    writer.drain();
    expect(noticeLines(writer)).toEqual(['LOST 1/6']);
  });
});

describe('Batcher — backpressure', () => {
  test('a full sink pauses pushing and holds the buffer', () => {
    const { batcher, sink, writer } = build({ batchBytes: 8 });
    writer.capacityBytes = 30;

    batcher.add(record(20)); // 21 bytes: accepted, queue now 21
    expect(sink.appendCalls).toHaveLength(1);

    batcher.add(record(20)); // 21 more would be 42 > 30: rejected 'full'
    expect(sink.appendCalls).toHaveLength(2);
    // Held, not dropped: backpressure is not loss.
    expect(batcher.bufferedBytes()).toBe(21);
    expect(batcher.unreported()).toEqual({ entries: 0, bytes: 0 });
  });

  test('the paused poll asks getStatus, not the writer queue', () => {
    const { batcher, sink, writer } = build({ batchBytes: 8 });
    writer.capacityBytes = 1000;

    batcher.add(record(300)); // accepted; queue now over the 256 watermark
    expect(writer.queuedBytes).toBeGreaterThan(256);

    const before = sink.appendCalls.length;
    batcher.add('more');
    jest.advanceTimersByTime(100);

    // Paused: the tick probed rather than pushed.
    expect(sink.statusCalls).toBeGreaterThan(0);
    expect(sink.appendCalls).toHaveLength(before);
    expect(writer.queuedBytes).toBeGreaterThan(256);
  });

  test('pushing resumes once the queue drains below the watermark', () => {
    const { batcher, sink, writer } = build({ batchBytes: 8 });
    writer.capacityBytes = 1000;

    batcher.add(record(300));
    batcher.add('held');
    jest.advanceTimersByTime(100);
    const paused = sink.appendCalls.length;

    writer.drain(); // the writer catches up
    jest.advanceTimersByTime(100);
    writer.drain();

    expect(sink.appendCalls.length).toBeGreaterThan(paused);
    expect(writer.lines()).toContain('held');
  });

  test('a getStatus that throws leaves the batcher paused, not wedged', () => {
    const { batcher, sink, writer } = build({ batchBytes: 8 });
    writer.capacityBytes = 1000;

    batcher.add(record(300));
    batcher.add('held');
    sink.statusThrows = true;
    jest.advanceTimersByTime(300);
    expect(writer.lines()).not.toContain('held');

    sink.statusThrows = false;
    writer.drain();
    jest.advanceTimersByTime(100);
    writer.drain();
    expect(writer.lines()).toContain('held');
  });

  test('a batch larger than the sink can ever hold is given up, not held forever', () => {
    const { batcher, writer } = build({ batchBytes: 8 });
    writer.capacityBytes = 4; // nothing this batcher builds will ever fit

    batcher.add(record(20));
    const outcome = batcher.flush(1000);

    expect(batcher.bufferedBytes()).toBe(0);
    expect(outcome.unreportedEntries).toBe(1);
  });
});

describe('Batcher — fencing', () => {
  test.each<FenceReason>(['staleGeneration', 'closed'])(
    '%s discards the buffer instead of replaying it',
    (reason) => {
      const { batcher, sink, writer } = build({ batchBytes: 1_000_000 });
      const fenced: FenceReason[] = [];
      const local = new Batcher(sink, {
        renderNotice: notice,
        batchBytes: 1_000_000,
        onFenced: (r) => fenced.push(r),
      });
      batcher.dispose();

      local.add('pre-purge');
      if (reason === 'closed') {
        sink.closed = true;
      } else {
        writer.generation += 1;
      }
      local.flush(1000);

      expect(fenced).toEqual([reason]);
      expect(local.isFenced()).toBe(true);
      expect(writer.lines()).not.toContain('pre-purge');
    }
  );

  test('fencing baselines the counters so no notice describes deleted data', () => {
    const { batcher, sink, writer } = build({ batchBytes: 1_000_000 });
    writer.injectLoss(sink.id, 7, 70);
    batcher.add('pre-purge');

    writer.generation += 1;
    batcher.flush(1000);
    expect(batcher.unreported()).toEqual({ entries: 0, bytes: 0 });

    sink.open('/memory/logs/app.log'); // the owner rebinds the handle…
    batcher.rebind(); // …then the batcher starts its cursors over
    batcher.add('post-purge');
    batcher.flush(1000);

    expect(writer.lines()).toEqual(['post-purge']);
  });

  test('rebinding starts the sink cursors over, not from the old maximum', () => {
    // The trap: sink counters are monotonic PER HANDLE, and a rebound handle
    // is a new one whose counters may start at zero. Carrying the old
    // maximum forward would make every post-purge loss smaller than the
    // pre-purge total invisible — reported zero times, which is the one
    // outcome this whole protocol exists to prevent.
    const { batcher, sink, writer } = build({ batchBytes: 1_000_000 });
    writer.injectLoss(sink.id, 40, 4000);
    batcher.add('pre-purge');
    batcher.flush(1000);

    writer.generation += 1;
    batcher.flush(1000); // fenced
    writer.purge(); // deletion resets the handle's counters
    sink.open('/memory/logs/app.log');
    batcher.rebind();

    // A new loss far smaller than the 40 that came before.
    writer.injectLoss(sink.id, 2, 20);
    batcher.add('post-purge');
    batcher.flush(1000);

    expect(noticeLines(writer)).toEqual(['LOST 2/20']);
  });

  test('a fenced batcher counts further records as lost, never buffers them', () => {
    const { batcher, sink } = build({ batchBytes: 1_000_000 });
    sink.closed = true;
    batcher.add('a');
    batcher.flush(1000);

    batcher.add('b');
    expect(batcher.bufferedBytes()).toBe(0);
  });
});

describe('Batcher — failure', () => {
  test('a failed batch is lost whole — the batch is the loss unit', () => {
    const { batcher, sink, writer } = build({ batchBytes: 1_000_000 });
    sink.failNextAppends = 1;

    batcher.add('lost'); // 5 bytes
    batcher.add('also'); // 5 bytes, same batch, same fate
    batcher.flush(1000);

    expect(writer.lines()).toEqual(['LOST 2/10']);
    expect(batcher.bufferedBytes()).toBe(0);
  });

  test('the buffer moves on after a failure instead of retrying forever', () => {
    const { batcher, sink, writer } = build({ batchBytes: 1_000_000 });
    sink.failNextAppends = 1;

    batcher.add('lost');
    batcher.flush(1000);
    batcher.add('kept');
    batcher.flush(1000);

    expect(writer.lines()).toEqual(['LOST 1/5', 'kept']);
  });

  test('a throwing appendBatch is a failing appendBatch', () => {
    const { batcher, sink, writer } = build({ batchBytes: 1_000_000 });
    sink.throwNextAppends = 1;

    batcher.add('lost');
    batcher.flush(1000);

    expect(writer.lines()).toEqual(['LOST 1/5']);
  });

  test('a terminal write failure preserves the loss rather than claiming durability', () => {
    const { batcher, writer } = build({ batchBytes: 1_000_000 });
    writer.writeFails = true;

    batcher.add('doomed');
    const outcome = batcher.flush(1000);

    expect(outcome.durable).toBe(false);
    expect(outcome.unreportedEntries).toBe(1);
    expect(writer.lines()).toHaveLength(0);
  });
});

describe('Batcher — flush', () => {
  test('drains everything and reports durable', () => {
    const { batcher, writer } = build({ batchBytes: 1_000_000 });
    for (let i = 0; i < 50; i += 1) batcher.add(`line-${i}`);

    const outcome = batcher.flush(2000);
    expect(outcome).toMatchObject({
      durable: true,
      timedOut: false,
      pendingBytes: 0,
      unreportedEntries: 0,
    });
    expect(writer.lines()).toHaveLength(50);
  });

  test('a wedged writer is reported, in bounded rounds, not waited out', () => {
    // Fake timers freeze the clock, so nothing here can be rescued by the
    // deadline: only the retry bound stops the loop. That is the point —
    // a device that stops answering honours a deadline instantly, forever.
    const { batcher, sink, writer } = build({ batchBytes: 8 });
    writer.capacityBytes = 60;

    batcher.add(record(40)); // 41 bytes accepted; queue loaded
    expect(writer.queuedBytes).toBe(41);

    writer.hung = true; // the writer stops answering
    batcher.add(record(40)); // 41 more would be 82 > 60: held
    expect(batcher.bufferedBytes()).toBe(41);

    const outcome = batcher.flush(2000);

    expect(outcome.durable).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(sink.appendCalls.length).toBeLessThanOrEqual(12);
    // Held, not thrown away: the writer may still come back.
    expect(batcher.bufferedBytes()).toBe(41);
  });

  test('flush overrides the pause instead of waiting for it to clear', () => {
    const { batcher, writer } = build({ batchBytes: 8 });
    writer.capacityBytes = 1000;

    batcher.add(record(300)); // pushes the queue past the watermark
    batcher.add('held');

    const outcome = batcher.flush(2000);
    expect(outcome.durable).toBe(true);
    expect(writer.lines()).toContain('held');
  });

  test('a notice-only batch that keeps failing does not spin the loop', () => {
    // The subtle one. A batch holding nothing but the notice removes no
    // records when it fails and settles no debt, so a drain that infers
    // progress from "the push said failed, not full" never stops — and with
    // the clock frozen, never times out either.
    const { batcher, sink, writer } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 1,
    });

    batcher.add('kept');
    batcher.add('dropped'); // the debt
    batcher.flush(1000); // clears 'kept' and the notice
    expect(noticeLines(writer)).toHaveLength(1);

    // Now a fresh debt whose notice the sink refuses every single time.
    batcher.add('kept-2');
    batcher.add('dropped-2');
    sink.failNextAppends = 500;

    const outcome = batcher.flush(1000);
    expect(outcome.durable).toBe(false);
    expect(outcome.unreportedEntries).toBeGreaterThan(0);
    expect(sink.appendCalls.length).toBeLessThan(40);
  });

  test('a notice the sink itself refuses is set aside, not polled forever', () => {
    const { batcher, sink, writer } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 1,
      renderNotice: () => 'LOST enormous'.padEnd(400, '!'),
    });

    batcher.add('kept');
    batcher.add('dropped');
    writer.capacityBytes = 60; // the notice will never fit on its own
    batcher.flush(1000);

    // The records got through; the notice did not, and the debt is kept.
    expect(writer.lines()).toEqual(['kept']);
    expect(batcher.unreported().entries).toBe(1);

    // And the timer has stopped rather than re-offering it every 100 ms.
    const calls = sink.appendCalls.length;
    jest.advanceTimersByTime(5000);
    expect(sink.appendCalls).toHaveLength(calls);

    // An explicit flush is the retry, and once there is room it lands.
    writer.capacityBytes = 100_000;
    batcher.flush(1000);
    expect(writer.lines()[1]).toContain('LOST enormous');
    expect(batcher.unreported().entries).toBe(0);
  });

  test('a run of failing batches is progress, not a stall', () => {
    // Records moving out of the buffer and into the debt they now owe is a
    // conserved total. A drain that measures the sum sees no change at the
    // exact moment it is working through a failing sink, and gives up with
    // records still queued that the sink was about to start accepting again.
    const { batcher, writer, sink } = build({
      batchBytes: 1_000_000,
      maxBatchBytes: 1, // one record per batch, so failures are countable
      maxPendingEntries: 100,
    });

    for (let i = 0; i < 15; i += 1) batcher.add(`r${i}`);
    sink.failNextAppends = 12; // more consecutive failures than MAX_STALLS

    batcher.flush(2000);

    // The last three got through rather than being abandoned behind the
    // twelve that did not.
    expect(writer.lines()).toContain('r12');
    expect(writer.lines()).toContain('r14');
    expect(batcher.bufferedBytes()).toBe(0);
  });

  test('an undeliverable notice stops the timer instead of retrying forever', () => {
    const { batcher, sink, writer } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 1,
      renderNotice: () => undefined, // nothing this formatter can produce
    });

    batcher.add('kept');
    batcher.add('dropped');
    batcher.flush(1000);

    expect(writer.lines()).toEqual(['kept']);
    // Still owed — the debt is set aside, not forgiven.
    expect(batcher.unreported().entries).toBe(1);

    const calls = sink.appendCalls.length;
    jest.advanceTimersByTime(10_000);
    expect(sink.appendCalls).toHaveLength(calls);
  });

  test('a blocked notice rides the next record once the sink recovers', () => {
    // Setting a notice aside must not mean shelving it until the next
    // explicit flush. A queue that was full a moment ago is the ordinary
    // reason one gets refused, and a process that dies before the next
    // background flush would report that loss zero times.
    const { batcher, writer } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 1,
      renderNotice: (l) => `LOST ${l.entries}/${l.bytes}`.padEnd(120, '!'),
    });

    batcher.add('kept');
    batcher.add('dropped');
    writer.capacityBytes = 60; // too small for the notice
    batcher.flush(1000);
    expect(batcher.unreported().entries).toBe(1);

    // The sink recovers, and an ordinary log call — not a flush — delivers it.
    writer.capacityBytes = 100_000;
    batcher.add('later');
    jest.advanceTimersByTime(100);
    writer.drain();

    expect(noticeLines(writer)).toHaveLength(1);
    expect(batcher.unreported().entries).toBe(0);
  });

  test('a notice-only batch the sink rejects outright stops the timer too', () => {
    const { batcher, sink, writer } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 1,
    });

    batcher.add('kept');
    batcher.add('dropped');
    sink.failNextAppends = 100;
    batcher.flush(1000);
    expect(batcher.unreported().entries).toBeGreaterThan(0);

    sink.failNextAppends = 0;
    const calls = sink.appendCalls.length;
    jest.advanceTimersByTime(10_000);
    expect(sink.appendCalls).toHaveLength(calls);

    // The explicit flush is what reopens it.
    batcher.flush(1000);
    expect(noticeLines(writer)).toHaveLength(1);
    expect(batcher.unreported().entries).toBe(0);
  });

  test('a zero deadline still reports honestly rather than throwing', () => {
    const { batcher } = build({ batchBytes: 1_000_000 });
    batcher.add('a');
    const outcome = batcher.flush(0);
    expect(outcome.durable).toBe(false);
    expect(outcome.timedOut).toBe(true);
  });

  test('flush cancels the timer it interrupted', () => {
    const { batcher, sink } = build({ batchBytes: 1_000_000 });
    batcher.add('a');
    batcher.flush(1000);
    const calls = sink.appendCalls.length;

    jest.advanceTimersByTime(1000);
    expect(sink.appendCalls).toHaveLength(calls);
  });
});

describe('Batcher — lifecycle', () => {
  test('dispose releases the timer without a blocking drain', () => {
    const { batcher, sink } = build({ batchBytes: 1_000_000 });
    batcher.add('a');
    batcher.dispose();

    jest.advanceTimersByTime(10_000);
    expect(sink.appendCalls).toHaveLength(0);
    expect(batcher.bufferedBytes()).toBe(0);
  });

  test('dispose is idempotent and later records go nowhere', () => {
    const { batcher, sink } = build({ batchBytes: 1 });
    batcher.dispose();
    batcher.dispose();
    batcher.add('after');
    expect(sink.appendCalls).toHaveLength(0);
  });

  test('discard reports what it threw away and stops the notice', () => {
    const { batcher, sink, writer } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 1,
    });
    writer.injectLoss(sink.id, 2, 200);
    batcher.add('buffered');
    batcher.add('dropped');

    // Buffered, dropped, and the sink's own 2/200 — which discard goes and
    // asks for, so a loss recorded before the purge cannot cross it and be
    // reported against the new file.
    const discarded = batcher.discard();
    expect(discarded.entries).toBe(1 + 1 + 2);
    expect(discarded.bytes).toBe(9 + 8 + 200);

    batcher.add('after');
    batcher.flush(1000);
    expect(writer.lines()).toEqual(['after']);
  });
});

describe('Batcher — byte accounting', () => {
  test('a record is charged its UTF-8 length plus its newline', () => {
    const { batcher } = build({ batchBytes: 1_000_000 });
    const multibyte = 'héllo → 😀'; // 2- 3- and 4-byte sequences
    batcher.add(multibyte);
    expect(batcher.bufferedBytes()).toBe(utf8Length(multibyte) + 1);
  });

  test('the dropped-byte count is what would have been written', () => {
    const { batcher } = build({
      batchBytes: 1_000_000,
      maxPendingEntries: 1,
    });
    batcher.add('kept');
    batcher.add('😀'); // 4 bytes + newline
    expect(batcher.unreported()).toEqual({ entries: 1, bytes: 5 });
  });
});

describe('Batcher — conservation', () => {
  /**
   * The claim the whole loss protocol rests on: a record is in the file, or
   * it is described by a notice, or it is still owed one. Never none of the
   * three.
   *
   * Individual tests each stage one fault. This drives a long pseudo-random
   * sequence of all of them at once — cap overflows, full queues, failed
   * appends, terminal write failures, unsyncable flushes — because the way an
   * accounting bug survives review is by needing two faults to overlap.
   */
  function conserves(seedStart: number): void {
    let seed = seedStart;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };

    const { batcher, sink, writer } = build({
      batchBytes: 40,
      maxPendingEntries: 6,
      maxPendingBytes: 90,
      watermarkBytes: 60,
    });

    let added = 0;
    for (let round = 0; round < 200; round += 1) {
      writer.capacityBytes = rand(4) === 0 ? 30 + rand(60) : 100_000;
      writer.writeFails = rand(9) === 0;
      writer.syncFails = rand(7) === 0;
      writer.hung = rand(11) === 0;
      if (rand(6) === 0) sink.failNextAppends = 1;
      if (rand(13) === 0) sink.throwNextAppends = 1;
      if (rand(10) === 0) writer.injectLoss(sink.id, 0, 0); // no-op probe

      for (let i = rand(4); i >= 0; i -= 1) {
        batcher.add(`R${added}`);
        added += 1;
      }
      if (rand(3) === 0) jest.advanceTimersByTime(100);
      if (rand(5) === 0) batcher.flush(500);
    }

    // Let everything recover, then drain until it settles.
    writer.capacityBytes = Number.POSITIVE_INFINITY;
    writer.writeFails = false;
    writer.syncFails = false;
    writer.hung = false;
    sink.failNextAppends = 0;
    sink.throwNextAppends = 0;
    for (let i = 0; i < 5; i += 1) batcher.flush(1000);
    writer.drain();

    const lines = writer.lines();
    const written = lines.filter((line) => line.startsWith('R'));
    const announced = lines
      .filter((line) => line.startsWith('LOST '))
      .reduce((sum, line) => sum + Number(line.slice(5).split('/')[0]), 0);

    // Nothing was invented, and nothing arrived twice.
    expect(new Set(written).size).toBe(written.length);
    expect(written.length).toBeLessThanOrEqual(added);

    // Quiescent: nothing buffered, nothing owed.
    expect(batcher.bufferedBytes()).toBe(0);
    expect(batcher.unreported()).toEqual({ entries: 0, bytes: 0 });

    // And every record that did not reach the file was announced. The
    // comparison is >= because a notice no flush confirmed gets written
    // again — losses may be double-counted, never uncounted.
    expect(announced).toBeGreaterThanOrEqual(added - written.length);
  }

  test.each([1, 7, 42, 1337, 90210])('holds under fault seed %i', (seed) => {
    conserves(seed);
  });
});

/**
 * `add(record, bytes)` and `add(record)` must be the same call.
 *
 * The second argument is an optimisation: the caller that rendered a record
 * has already measured it, and letting the batcher measure it again is a
 * second full pass over every record that reaches the file. An optimisation
 * that changes an answer is a bug, so every assertion here is a differential
 * one — the same input driven both ways, compared on what the batcher does
 * rather than on what it was told.
 *
 * ## What these do NOT prove
 *
 * **That it is faster.** Nothing here times anything. The claim being defended
 * is only that taking the shortcut cannot change the outcome; whether the
 * shortcut is worth taking is a judgement about how often `write` runs, not
 * something a test can settle.
 */
describe('Batcher.add — a caller-supplied byte count', () => {
  /** Everything observable about a batcher after the same records went in. */
  function drive(
    texts: readonly string[],
    supply: (text: string) => number | undefined
  ) {
    const { batcher, sink, writer } = build({ batchBytes: 1024 });
    for (const text of texts) batcher.add(text, supply(text));
    const buffered = batcher.bufferedBytes();
    batcher.flush(1000);
    return {
      buffered,
      lines: writer.lines(),
      unreported: batcher.unreported(),
      appended: sink.appendCalls.map((call) => call.entryCount),
    };
  }

  const CORPUS = [
    'plain ascii record',
    '',
    'a',
    'naïve café résumé',
    '日本語のログ',
    '🙂 emoji at the front',
    'emoji at the back 🙂',
    'a🙂b',
    // A lone high surrogate: three bytes, and the character after it still
    // counts. This is the input a naive counter gets wrong.
    'torn \ud83d tail',
    '\ude42 lone low',
    `${'x'.repeat(2000)}🙂`,
  ];

  test('supplying the count changes nothing about the outcome', () => {
    const measured = drive(CORPUS, (text) => utf8Length(text));
    const unmeasured = drive(CORPUS, () => undefined);
    expect(measured).toEqual(unmeasured);
  });

  test('a count that cannot be a length at all is recomputed', () => {
    // Note what this does NOT say: that a wrong count is caught. `add(r, 1)`
    // for a ten-byte record is trusted, and has to be — detecting it would
    // mean measuring, which is the whole thing being avoided. What the guard
    // rejects is a value that is not a length in the first place, so nonsense
    // cannot propagate into the pending total from a mis-typed call site.
    const honest = drive(CORPUS, () => undefined);
    for (const impossible of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      expect(drive(CORPUS, () => impossible)).toEqual(honest);
    }
  });

  test('a count of zero is honoured, because zero is a real length', () => {
    // The guard rejects what is not a usable count. Zero IS one — an empty
    // record is a newline — so it must not be swept up with the nonsense
    // above and silently recomputed.
    const { batcher } = build({ batchBytes: 1024 });
    batcher.add('', 0);
    expect(batcher.bufferedBytes()).toBe(1);
  });

  test('a dropped record is still counted with the supplied size', () => {
    const { batcher } = build({ maxPendingBytes: 8, batchBytes: 1024 });
    const text = '🙂🙂🙂🙂'; // 16 bytes, over the pending cap
    batcher.add(text, utf8Length(text));
    expect(batcher.unreported()).toEqual({ entries: 1, bytes: 17 });

    const other = build({ maxPendingBytes: 8, batchBytes: 1024 });
    other.batcher.add(text);
    expect(other.batcher.unreported()).toEqual(batcher.unreported());
  });
});
