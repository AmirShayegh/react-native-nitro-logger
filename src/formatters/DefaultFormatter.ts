import type { LogEntry } from '../types';
import type { LogFormatter } from './types';
import { LEVEL_TAG } from '../levels';
import { formatTime } from './timestamp';

/**
 * SwiftLogger's default layout minus the `File.swift:42` column (no call-site
 * capture in JS):
 *
 *     LEVEL | HH:mm:ss.SSS | [correlation] [subsystem] message {key=value}
 *
 * Metadata renders as `key=value` pairs sorted by key.
 */
export class DefaultFormatter implements LogFormatter {
  format(entry: LogEntry): string {
    let tags = '';
    if (entry.correlation !== undefined) tags += `[${entry.correlation}] `;
    if (entry.subsystem !== undefined) tags += `[${entry.subsystem}] `;

    let body = `${tags}${entry.message}`;
    if (entry.metadata) {
      const keys = Object.keys(entry.metadata).sort();
      if (keys.length > 0) {
        const pairs = keys
          .map((k) => `${k}=${String(entry.metadata![k])}`)
          .join(', ');
        body += ` {${pairs}}`;
      }
    }

    return `${LEVEL_TAG[entry.level]} | ${formatTime(entry.timestamp)} | ${body}`;
  }
}
