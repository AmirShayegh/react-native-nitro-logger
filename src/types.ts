/** Severity levels, least to most severe. `todo` marks incomplete work and
 * sorts highest so it always surfaces (SwiftLogger parity). */
export type LogLevel =
  'verbose' | 'debug' | 'info' | 'warning' | 'error' | 'todo';

/** Messages accept a thunk so hot-path callers can defer interpolation —
 * the `@autoclosure` equivalent. The thunk is NOT invoked when the entry is
 * filtered out or no destination is eligible. */
export type LazyMessage = string | (() => string);

/** Metadata values. M2 widens this with PrivateValue/PublicValue privacy
 * markers; everything else in the pipeline is typed against the
 * post-redaction shape below and will not change. */
export type LogValue = string | number | boolean;

export type LogMetadata = Record<string, LogValue>;

/** Metadata after redaction — what formatters and destinations see. Privacy
 * markers are unrepresentable here by construction. */
export type RedactedMetadata = Readonly<
  Record<string, string | number | boolean>
>;

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
