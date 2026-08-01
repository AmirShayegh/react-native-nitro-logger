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

/**
 * Every level method, on both loggers, against a subsystem override.
 *
 * Twelve near-identical methods each make the same decision about the same
 * two inputs, which is precisely the shape where one of them quietly differs
 * — a copy-paste that names the wrong level, or drops the subsystem argument
 * so the call is judged against the global minimum instead of the override.
 * Neither mistake announces itself: the entry is simply absent.
 *
 * Both directions per method, because they fail differently. A subsystem
 * that LOOSENS (override below the global minimum) catches a check that
 * forgot the subsystem — that call would be dropped, and losing the
 * diagnostics somebody just turned on is the failure people debug for hours.
 * A subsystem that TIGHTENS catches the opposite, which in a package built
 * for "never log PHI" is the one that matters more: a line that should have
 * been filtered reaching a destination.
 *
 * This is written table-driven rather than as twelve tests so that adding a
 * seventh level cannot be done without adding it here.
 */
describe('every level method honours a subsystem override', () => {
  const { Logger } = require('../src/Logger') as typeof import('../src/Logger');
  const { TestDestination } =
    require('./helpers/TestDestination') as typeof import('./helpers/TestDestination');

  /** One level below the method's own, so the method's level passes it. */
  const BELOW: Record<LogLevel, LogLevel> = {
    verbose: 'verbose',
    debug: 'verbose',
    info: 'debug',
    warning: 'info',
    error: 'warning',
    todo: 'error',
  };

  for (const level of ASCENDING) {
    for (const via of ['logger', 'scope'] as const) {
      test(`${via}.${level} is judged against the subsystem, not the global minimum`, () => {
        // Loosening: the global minimum forbids this level, the subsystem
        // permits it. A check that ignored the subsystem would drop it.
        const permissive = new Logger();
        const heard = new TestDestination();
        permissive.removeDestination('console');
        permissive.addDestination(heard);
        permissive.minimumLevel('todo').subsystem('net', BELOW[level]);
        if (via === 'logger') {
          permissive[level]('kept', undefined, 'net');
        } else {
          permissive.scoped('corr', 'net')[level]('kept');
        }
        expect(heard.messages).toEqual(['kept']);

        // Tightening: the global minimum permits it, the subsystem forbids
        // it. A check that ignored the subsystem would let it through.
        const strict = new Logger();
        const silent = new TestDestination();
        strict.removeDestination('console');
        strict.addDestination(silent);
        strict.minimumLevel('verbose').subsystem('net', 'todo');
        if (via === 'logger') {
          strict[level]('dropped', undefined, 'net');
        } else {
          strict.scoped('corr', 'net')[level]('dropped');
        }
        // `todo` is the ceiling, so a `todo` call passes its own override.
        expect(silent.messages).toEqual(level === 'todo' ? ['dropped'] : []);
      });
    }
  }
});
