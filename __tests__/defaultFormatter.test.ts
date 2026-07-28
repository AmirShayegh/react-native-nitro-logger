import { DefaultFormatter } from '../src/formatters/DefaultFormatter';
import type { LogEntry } from '../src/types';

const at = new Date(2026, 6, 27, 12, 15, 30, 842).getTime(); // local 12:15:30.842

function entry(partial: Partial<LogEntry>): LogEntry {
  return { timestamp: at, level: 'info', message: 'msg', ...partial };
}

describe('DefaultFormatter', () => {
  const formatter = new DefaultFormatter();

  test('renders LEVEL | time | message', () => {
    expect(formatter.format(entry({}))).toBe(' INFO | 12:15:30.842 | msg');
  });

  test('renders correlation and subsystem tags in order', () => {
    expect(
      formatter.format(entry({ correlation: 'job-1', subsystem: 'net' }))
    ).toBe(' INFO | 12:15:30.842 | [job-1] [net] msg');
  });

  test('renders metadata sorted by key', () => {
    expect(
      formatter.format(entry({ metadata: { b: 2, a: 'x', c: true } }))
    ).toBe(' INFO | 12:15:30.842 | msg {a=x, b=2, c=true}');
  });

  test('level tags keep the fixed-width alignment', () => {
    expect(formatter.format(entry({ level: 'error' }))).toMatch(/^ERROR \| /);
    expect(formatter.format(entry({ level: 'warning' }))).toMatch(/^ WARN \| /);
  });
});
