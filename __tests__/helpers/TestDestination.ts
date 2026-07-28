import type { LogEntry, LogLevel } from '../../src/types';
import type { LogDestination } from '../../src/destinations/types';

/** Captures entries in memory; scriptable enable/level/failure behavior. */
export class TestDestination implements LogDestination {
  readonly entries: LogEntry[] = [];
  enabled = true;
  throwOnWrite = false;
  flushCount = 0;
  disposeCount = 0;

  constructor(
    readonly label = 'test',
    readonly minimumLevel?: LogLevel
  ) {}

  get isEnabled(): boolean {
    return this.enabled;
  }

  write(entry: LogEntry): void {
    if (this.throwOnWrite) throw new Error('scripted write failure');
    this.entries.push(entry);
  }

  flush(): void {
    this.flushCount += 1;
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  get messages(): string[] {
    return this.entries.map((e) => e.message);
  }
}
