import type { LogEntry, LogLevel } from '../types';
import type { LogDestination } from './types';
import type { LogFormatter } from '../formatters/types';
import { DefaultFormatter } from '../formatters/DefaultFormatter';
import { LEVEL_ORDER } from '../levels';

/**
 * Renders to the JS console (Metro in dev). warning → console.warn and
 * error/todo → console.error deliberately: LogBox surfacing errors in dev is
 * a feature, not noise.
 *
 * `outputSink` mirrors SwiftLogger's test hook: when set, lines are also
 * handed to the sink, and `isEnabled` stays true even with printing off.
 */
export class ConsoleDestination implements LogDestination {
  readonly label = 'console';
  readonly minimumLevel?: LogLevel;
  printEnabled = true;
  outputSink?: (line: string) => void;

  private readonly formatter: LogFormatter;

  constructor(options?: { minimumLevel?: LogLevel; formatter?: LogFormatter }) {
    this.minimumLevel = options?.minimumLevel;
    this.formatter = options?.formatter ?? new DefaultFormatter();
  }

  get isEnabled(): boolean {
    return this.printEnabled || this.outputSink !== undefined;
  }

  write(entry: LogEntry): void {
    const line = this.formatter.format(entry);
    if (this.outputSink) {
      // Guarded: a faulty observer must not suppress console output or get
      // the whole destination disabled as repeatedly failing.
      try {
        this.outputSink(line);
      } catch {
        // observer-only failure; console printing below still runs
      }
    }
    if (!this.printEnabled) return;
    if (LEVEL_ORDER[entry.level] >= LEVEL_ORDER.error) {
      console.error(line);
    } else if (entry.level === 'warning') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  /**
   * Nothing to drain — console writes already happened.
   *
   * The parameter exists so the signature matches `LogDestination`, which every
   * caller already satisfies: `Logger.flush` passes a deadline to everything it
   * holds, and a zero-argument `flush` accepting it only by TypeScript's
   * arity-compatibility rule reads like an oversight rather than a decision.
   * Naming it says the deadline was considered and there is nothing to spend
   * it on.
   */
  flush(_deadlineMs?: number): void {
    // console writes are synchronous; nothing buffers here
  }

  dispose(): void {
    this.outputSink = undefined;
  }
}
