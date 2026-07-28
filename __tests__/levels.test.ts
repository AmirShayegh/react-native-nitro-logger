import {
  LEVEL_ORDER,
  LEVEL_TAG,
  LEVEL_NAME,
  levelAtLeast,
} from '../src/levels';
import type { LogLevel } from '../src/types';

const ASCENDING: LogLevel[] = [
  'verbose',
  'debug',
  'info',
  'warning',
  'error',
  'todo',
];

describe('levels', () => {
  test('orders verbose < debug < info < warning < error < todo', () => {
    for (let i = 1; i < ASCENDING.length; i++) {
      expect(LEVEL_ORDER[ASCENDING[i]!]).toBeGreaterThan(
        LEVEL_ORDER[ASCENDING[i - 1]!]
      );
    }
  });

  test('levelAtLeast is inclusive', () => {
    expect(levelAtLeast('info', 'info')).toBe(true);
    expect(levelAtLeast('warning', 'info')).toBe(true);
    expect(levelAtLeast('debug', 'info')).toBe(false);
  });

  test('tags are the exact 5-char SwiftLogger strings', () => {
    expect(LEVEL_TAG.verbose).toBe('TRACE');
    expect(LEVEL_TAG.debug).toBe('DEBUG');
    expect(LEVEL_TAG.info).toBe(' INFO');
    expect(LEVEL_TAG.warning).toBe(' WARN');
    expect(LEVEL_TAG.error).toBe('ERROR');
    expect(LEVEL_TAG.todo).toBe(' TODO');
    for (const level of ASCENDING) {
      expect(LEVEL_TAG[level]).toHaveLength(5);
    }
  });

  test('JSON names match SwiftLogger rawValues', () => {
    expect(LEVEL_NAME.verbose).toBe('VERBOSE');
    expect(LEVEL_NAME.warning).toBe('WARNING');
    expect(LEVEL_NAME.todo).toBe('TODO');
  });
});
