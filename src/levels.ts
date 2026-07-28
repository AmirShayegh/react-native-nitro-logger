import type { LogLevel } from './types';

/** Numeric severity order; also the codes that cross the bridge. */
export const LEVEL_ORDER: Record<LogLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warning: 3,
  error: 4,
  todo: 5,
};

export function levelAtLeast(level: LogLevel, minimum: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minimum];
}

/** Fixed-width 5-character tags, byte-identical to SwiftLogger's. */
export const LEVEL_TAG: Record<LogLevel, string> = {
  verbose: 'TRACE',
  debug: 'DEBUG',
  info: ' INFO',
  warning: ' WARN',
  error: 'ERROR',
  todo: ' TODO',
};

/** Uppercase names used by the JSON formatter (SwiftLogger rawValue parity). */
export const LEVEL_NAME: Record<LogLevel, string> = {
  verbose: 'VERBOSE',
  debug: 'DEBUG',
  info: 'INFO',
  warning: 'WARNING',
  error: 'ERROR',
  todo: 'TODO',
};
