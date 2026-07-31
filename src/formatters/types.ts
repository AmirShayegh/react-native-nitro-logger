import type { LogEntry } from '../types';

export interface LogFormatter {
  /**
   * Framing contract for file destinations: 'line' guarantees exactly one
   * escaped record per line (newlines in content are escaped), which is what
   * makes native crash-tail trimming safe. Formatters that cannot guarantee
   * this omit it and are documented as having reduced crash-tail recovery.
   */
  readonly framing?: 'line';

  /**
   * Render one entry.
   *
   * **Being formatted is not being written, in either direction.** Entries
   * arrive here that never reach the file — the buffer is full, the sink
   * rejects the batch, the handle gets fenced mid-flight — and other entries
   * are discarded before they get here at all, filtered out by the global
   * level, a per-subsystem level, or this destination's `minimumLevel`. From
   * 0.3.0 a `FileDestination` also skips the call when its buffer is already
   * too full to accept anything, since formatting then is work done for the
   * wastebasket.
   *
   * So a formatter's own call history tells it nothing about what is in the
   * log, which makes this a requirement rather than an observation: **a
   * formatter must not carry state that later records depend on.** One that
   * stamps an incrementing sequence number is numbering its own calls, not the
   * file's lines, and the two have never been the same sequence. Derive
   * everything a record says from the entry it is given.
   */
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
