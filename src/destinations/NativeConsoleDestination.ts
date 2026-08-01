import type { LogEntry, LogLevel } from '../types';
import type { LogDestination } from './types';
import type { LogFormatter } from '../formatters/types';
import { DefaultFormatter } from '../formatters/DefaultFormatter';
import { LEVEL_ORDER } from '../levels';

/**
 * The part of `NativeConsoleSink` this destination uses.
 *
 * Structural rather than the Nitro interface itself, so tests can drive it
 * with a double. The real `NativeConsoleSink` satisfies it.
 */
export interface NativeConsoleSinkLike {
  install(subsystem: string, category: string): void;
  logBatch(levels: number[], messages: string[]): void;
}

export interface NativeConsoleDestinationOptions {
  /** Registration key. Default 'native-console'. */
  readonly label?: string;
  readonly minimumLevel?: LogLevel;
  /**
   * Default `DefaultFormatter` — os_log wants a line, not a JSON record.
   *
   * `PlatformConsoleFormatter` is the better fit and is not the default:
   * it drops the ` INFO | 12:15:30.842 | ` columns, which both native writers
   * duplicate with their own severity and timestamp and which are charged
   * against each sink's chunk budget on every chunk. Changing what a
   * developer sees in Console.app is not something a package upgrade should
   * do by itself, so it is opt-in:
   *
   *     new NativeConsoleDestination(sink, {
   *       formatter: new PlatformConsoleFormatter(),
   *     })
   */
  readonly formatter?: LogFormatter;
  /** Reverse-DNS, as os_log expects. Default: the bundle's, chosen natively. */
  readonly subsystem?: string;
  /**
   * Default 'log'. Becomes the logcat tag on Android, where it shares the
   * entry with the message and is capped at 256 bytes; a category longer than
   * ~200 bytes shortens each entry's message rather than costing its tail.
   * Bytes are counted as JNI encodes them — modified UTF-8, so an emoji costs
   * six. On iOS the category is a field of the `os_log` object and costs
   * nothing.
   */
  readonly category?: string;
  /** Entries per bridge crossing. Default 64. */
  readonly batchSize?: number;
  /** Idle coalescing window. Default 100 ms. */
  readonly flushIntervalMs?: number;
  /** Buffer ceiling; oldest survive, newest are dropped. Default 1000. */
  readonly maxPendingEntries?: number;
}

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_MAX_PENDING = 1000;

/**
 * Number of consecutive failed `logBatch` calls before the destination stops
 * trying. A native sink that is throwing every time will not start working
 * because we asked once more, and a try/catch per drain forever is a cost the
 * app pays for nothing.
 */
const FAILURE_LIMIT = 3;

/**
 * Renders entries into the platform log stream — os_log on iOS, logcat on
 * Android — so JS logs interleave with native ones in Console.app and Xcode.
 *
 * Batched, unlike {@link ConsoleDestination}: one bridge crossing per drain
 * with two parallel primitive arrays, rather than a crossing per entry.
 *
 * Deliberately simpler than {@link FileDestination}. There is no backpressure
 * and no loss accounting because there is nothing to push back on: os_log
 * accepts what it is given and never blocks on a disk. What this destination
 * does account for is its own buffer — entries dropped at the ceiling, and
 * entries lost to a throwing sink — through {@link dropped}, because a
 * diagnostic channel that quietly loses records is worse than one that says
 * it did.
 *
 * The durable copy is the file destination's. Nothing here is a system of
 * record, which is what makes best-effort the right posture.
 */
export class NativeConsoleDestination implements LogDestination {
  readonly label: string;
  readonly minimumLevel?: LogLevel;

  private readonly sink: NativeConsoleSinkLike;
  private readonly formatter: LogFormatter;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxPending: number;

  private levels: number[] = [];
  private messages: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private failures = 0;
  private droppedEntries = 0;

  constructor(
    sink: NativeConsoleSinkLike,
    options?: NativeConsoleDestinationOptions
  ) {
    this.sink = sink;
    this.label = options?.label ?? 'native-console';
    this.minimumLevel = options?.minimumLevel;
    this.formatter = options?.formatter ?? new DefaultFormatter();
    this.batchSize = positive(options?.batchSize, DEFAULT_BATCH_SIZE);
    this.flushIntervalMs = positive(
      options?.flushIntervalMs,
      DEFAULT_FLUSH_INTERVAL_MS
    );
    this.maxPending = positive(options?.maxPendingEntries, DEFAULT_MAX_PENDING);

    // An empty subsystem is legal and produces a logger nobody can find in
    // Console; the native side substitutes the bundle identifier for it.
    this.sink.install(options?.subsystem ?? '', options?.category ?? 'log');
  }

  /**
   * False once disposed, or once the native sink has failed enough times in a
   * row to be considered gone. The Logger checks this before formatting, so a
   * dead sink stops costing render work as well as bridge calls.
   */
  get isEnabled(): boolean {
    return !this.disposed && this.failures < FAILURE_LIMIT;
  }

  /** Entries this destination never handed to the platform log. */
  dropped(): number {
    return this.droppedEntries;
  }

  write(entry: LogEntry): void {
    if (!this.isEnabled) return;

    if (this.messages.length >= this.maxPending) {
      // Drop-newest, matching the Batcher. Under a burst the oldest entries
      // are the ones that explain how it started, which is what a reader is
      // looking for; keeping the newest would leave only the aftermath.
      this.droppedEntries += 1;
      return;
    }

    // Render first, then append both halves together. The two arrays are
    // parallel and are read by index natively, so pushing the level before the
    // message that might not arrive leaves them one apart — and from that point
    // on every entry in the batch is logged at its predecessor's severity. The
    // Logger catches a throwing destination and carries on, which is exactly
    // what would let the misalignment survive unnoticed.
    let rendered: string;
    try {
      rendered = this.formatter.format(entry);
    } catch {
      // Not counted against the sink's failure run: the sink is fine, the
      // formatter is not, and disabling the channel over someone else's bug
      // would take the console down for every entry a working formatter could
      // still have rendered.
      this.droppedEntries += 1;
      return;
    }

    this.levels.push(LEVEL_ORDER[entry.level]);
    this.messages.push(rendered);

    if (this.messages.length >= this.batchSize) {
      this.drain();
      return;
    }
    this.arm();
  }

  /**
   * Hands everything buffered to the platform log.
   *
   * The deadline is accepted and ignored, deliberately: `logBatch` does not
   * wait on anything, so there is no wait to bound. Taking the parameter keeps
   * the destination interchangeable with the ones that do need it.
   */
  flush(_deadlineMs?: number): void {
    this.drain();
  }

  dispose(): void {
    if (this.disposed) return;
    // Flush before the flag, not after: entries buffered up to this moment
    // were accepted, and disposing is not a reason to drop them.
    this.drain();
    this.disposed = true;
    this.cancel();
  }

  private drain(): void {
    this.cancel();
    if (this.messages.length === 0) return;

    const levels = this.levels;
    const messages = this.messages;
    this.levels = [];
    this.messages = [];

    if (this.disposed) return;

    try {
      this.sink.logBatch(levels, messages);
      this.failures = 0;
    } catch {
      // Payload-free: whatever the native side threw is not worth risking on
      // the way back through a logger. The batch is gone either way, so it is
      // counted rather than retried — replaying it against a sink that just
      // rejected it only doubles the chance of the same failure.
      this.failures += 1;
      this.droppedEntries += messages.length;
    }
  }

  private arm(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drain();
    }, this.flushIntervalMs);
  }

  private cancel(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Finite positive integers only; anything else falls back. */
function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return value;
}
