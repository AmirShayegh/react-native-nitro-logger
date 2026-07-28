import type { LogLevel } from './types';

/**
 * Resolves the effective minimum level for a subsystem by walking the
 * dot-separated hierarchy: exact match, then each parent (`a.b.c` → `a.b` →
 * `a`), then undefined so the caller falls back to the global minimum.
 * Direct port of SwiftLogger's LoggerConfiguration.resolveSubsystemLevel.
 *
 * Single-threaded JS means no snapshot/locking machinery — a plain Map
 * mutated by the fluent config methods is safe.
 */
export function resolveSubsystemLevel(
  subsystemLevels: ReadonlyMap<string, LogLevel>,
  name: string
): LogLevel | undefined {
  if (subsystemLevels.size === 0) return undefined;
  let current = name;
  for (;;) {
    const level = subsystemLevels.get(current);
    if (level !== undefined) return level;
    const dot = current.lastIndexOf('.');
    if (dot < 0) return undefined;
    current = current.slice(0, dot);
  }
}
