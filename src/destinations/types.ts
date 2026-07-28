import type { LogEntry, LogLevel } from '../types';

/**
 * A log output backend. The Logger filters on `isEnabled` and `minimumLevel`
 * BEFORE evaluating a lazy message, isolates each destination's `write` (one
 * throwing destination never blocks siblings), and calls `dispose()` on
 * replace/remove/reset — JS garbage collection is nondeterministic, so
 * timers, native handles, and listeners must be released explicitly.
 */
export interface LogDestination {
  readonly label: string;
  readonly minimumLevel?: LogLevel;
  readonly isEnabled: boolean;
  write(entry: LogEntry): void;
  /** Drain any buffered output synchronously (bounded by deadlineMs). */
  flush(deadlineMs?: number): void;
  /** Idempotent: cancel timers, flush, release native handles/listeners. */
  dispose(): void;
}
