import { ConsoleDestination } from '../src/destinations/ConsoleDestination';
import type { LogEntry } from '../src/types';

function entry(partial: Partial<LogEntry>): LogEntry {
  return {
    timestamp: new Date(2026, 6, 27, 12, 0, 0, 0).getTime(),
    level: 'info',
    message: 'msg',
    ...partial,
  };
}

describe('ConsoleDestination', () => {
  test('routes error/todo to console.error and warning to console.warn', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const dest = new ConsoleDestination();
      dest.write(entry({ level: 'info' }));
      dest.write(entry({ level: 'warning' }));
      dest.write(entry({ level: 'error' }));
      dest.write(entry({ level: 'todo' }));
      expect(log).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test('a throwing outputSink does not suppress console output', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const dest = new ConsoleDestination();
      dest.outputSink = () => {
        throw new Error('observer failed');
      };
      expect(() => dest.write(entry({}))).not.toThrow();
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  test('outputSink keeps receiving lines with printing off', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const dest = new ConsoleDestination();
      const lines: string[] = [];
      dest.outputSink = (line) => lines.push(line);
      dest.printEnabled = false;
      expect(dest.isEnabled).toBe(true);
      dest.write(entry({ message: 'observed' }));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('observed');
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  describe('dispose', () => {
    test('it drops the sink, so a released observer stops receiving lines', () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const dest = new ConsoleDestination();
        const lines: string[] = [];
        dest.outputSink = (line) => lines.push(line);
        dest.write(entry({ message: 'before' }));
        expect(lines).toHaveLength(1);

        dest.dispose();

        // The sink is the one thing this destination holds that outlives it:
        // a closure over a test harness, a breadcrumb collector, a screen that
        // has gone away. Keeping it after release is a leak with a payload —
        // every later record is still handed to an observer nobody can reach
        // to unregister.
        dest.write(entry({ message: 'after' }));
        expect(lines).toEqual([expect.stringContaining('before')]);
      } finally {
        log.mockRestore();
      }
    });

    test('printing survives it, and so does the destination', () => {
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const dest = new ConsoleDestination();
        dest.outputSink = () => {};
        dest.dispose();

        // Deliberately not a teardown that stops the console too. There is no
        // native handle here and nothing to close; a `ConsoleDestination` that
        // went silent on dispose would take the platform log with it for the
        // rest of the process, which is the opposite of what a logger should
        // do while an app is shutting down.
        expect(dest.isEnabled).toBe(true);
        dest.write(entry({ message: 'still printed' }));
        expect(log).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
      }
    });

    test('it is idempotent', () => {
      const dest = new ConsoleDestination();
      dest.outputSink = () => {};
      dest.dispose();
      // `Logger.removeDestination` disposes, and a caller may dispose too.
      expect(() => dest.dispose()).not.toThrow();
      expect(dest.outputSink).toBeUndefined();
    });
  });
});
