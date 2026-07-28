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
}
