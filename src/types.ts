import type { PrivateValue, PublicValue } from './privacy';
import type { PrimitiveValue } from './constraints';

export type { PrivateValue, PublicValue };

/** Severity levels, least to most severe. `todo` marks incomplete work and
 * sorts highest so it always surfaces (SwiftLogger parity). */
export type LogLevel =
  'verbose' | 'debug' | 'info' | 'warning' | 'error' | 'todo';

/** Messages accept a thunk so hot-path callers can defer interpolation —
 * the `@autoclosure` equivalent. The thunk is NOT invoked when the entry is
 * filtered out or no destination is eligible. */
export type LazyMessage = string | (() => string);

/** The only value shapes the pipeline can render. */
export type LogPrimitive = PrimitiveValue;

/** Metadata values: a bare primitive, whose visibility follows the privacy
 * default, or one explicitly marked with `pub()` / `priv()`. */
export type LogValue = LogPrimitive | PublicValue | PrivateValue;

export type LogMetadata = Record<string, LogValue>;

/** Metadata after redaction — what formatters and destinations see. Privacy
 * markers are unrepresentable here by construction: every value has already
 * been resolved to a primitive or replaced by a placeholder. */
export type RedactedMetadata = Readonly<Record<string, LogPrimitive>>;

/** A single log event, post-redaction. Readonly and frozen at runtime: one
 * entry fans out to every destination, so no destination may mutate what its
 * siblings receive. No file/function/line: JS has no `#fileID`, and Hermes
 * stack parsing is unreliable — subsystems are the filtering mechanism
 * instead. */
export interface LogEntry {
  /** Epoch milliseconds, not a `Date`: `Object.freeze` does not protect a
   * Date's internal slots, so a destination could `setTime()` the entry its
   * siblings are about to receive. A number is immutable by construction and
   * crosses the native bridge unchanged. */
  readonly timestamp: number;
  readonly level: LogLevel;
  readonly message: string;
  readonly metadata?: RedactedMetadata;
  readonly correlation?: string;
  readonly subsystem?: string;
}
