import type { LogEntry } from '../types';

export interface LogFormatter {
  /**
   * Framing contract for file destinations: 'line' guarantees exactly one
   * escaped record per line (newlines in content are escaped), which is what
   * makes native crash-tail trimming safe. Formatters that cannot guarantee
   * this omit it and are documented as having reduced crash-tail recovery.
   */
  readonly framing?: 'line';

  format(entry: LogEntry): string;

  /**
   * Render `entry` within a UTF-8 byte budget by shedding content
   * structurally — dropping whole fields, truncating a field at code-point
   * boundaries — so the result is still well-formed in this format.
   *
   * A formatter that omits this is never sliced to fit: an entry too large
   * for the destination's per-entry limit is replaced whole by a fixed
   * notice, because cutting a rendered record to length is how a log file
   * stops being parseable.
   *
   * Best effort. Returning something still over budget is allowed — a record
   * has a floor below which it no longer identifies anything — and callers
   * must measure the result rather than assume it fits.
   */
  formatWithin?(entry: LogEntry, maxBytes: number): string;
}
