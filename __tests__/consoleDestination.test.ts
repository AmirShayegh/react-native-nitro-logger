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
});
