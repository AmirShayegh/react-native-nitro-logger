import type {
  LazyMessage,
  LogEntry,
  LogLevel,
  LogMetadata,
  RedactedMetadata,
} from './types';
import type { LogDestination } from './destinations/types';
import { ConsoleDestination } from './destinations/ConsoleDestination';
import { resolveSubsystemLevel } from './config';
import { levelAtLeast } from './levels';
import { safeSnapshotMetadata } from './metadata';
import { ScopedLogger } from './ScopedLogger';

export interface LogOptions {
  level?: LogLevel;
  subsystem?: string;
  metadata?: LogMetadata;
  correlation?: string;
}

/** A destination is cut off after this many consecutive write failures. */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * A registered destination plus the label captured once, at registration.
 * The label is never re-read afterwards: a getter that succeeds during
 * registration and throws later would otherwise break removal, and failure
 * accounting needs a stable key or a misbehaving destination can never be
 * disabled.
 */
interface Registration {
  readonly destination: LogDestination;
  readonly label: string;
}

/**
 * The logger. Access through the `Log` singleton.
 *
 * Everything runs on the JS thread, so unlike the Swift original there is no
 * lock or config-snapshot machinery — plain fields mutated by the fluent
 * methods are safe by construction.
 *
 * Pipeline per message: resolve effective level (exact subsystem → parent
 * walk → global) → collect destinations passing isEnabled AND minimumLevel →
 * return BEFORE evaluating a lazy message when none remain → evaluate once,
 * guarded → prepare metadata (redaction seam; M2 adds privacy wrappers) →
 * freeze → fan out with per-destination isolation.
 *
 * Destinations are treated as untrusted: every property read and call is
 * guarded so one faulty implementation can neither crash the app nor starve
 * its siblings.
 */
export class Logger {
  private globalMinimum: LogLevel = 'debug';
  private readonly subsystemLevels = new Map<string, LogLevel>();
  private registrations: Registration[] = defaultRegistrations();

  /** Consecutive write-failure counts per destination label. */
  private readonly failureCounts = new Map<string, number>();
  private readonly disabledLabels = new Set<string>();

  // ── Fluent configuration ────────────────────────────────────────────────

  /** Global minimum level; messages below it are discarded. Default 'debug'. */
  minimumLevel(level: LogLevel): this {
    this.globalMinimum = level;
    return this;
  }

  /** Minimum level for a dot-hierarchical subsystem (`network` covers
   * `network.api` unless the child sets its own). */
  subsystem(name: string, level: LogLevel): this {
    this.subsystemLevels.set(name, level);
    return this;
  }

  resetSubsystem(name: string): this {
    this.subsystemLevels.delete(name);
    return this;
  }

  /** Toggle console printing. The console destination's test sink, when set,
   * keeps receiving lines regardless. */
  consoleLogging(enabled: boolean): this {
    for (const { destination } of this.registrations) {
      if (destination instanceof ConsoleDestination) {
        destination.printEnabled = enabled;
      }
    }
    return this;
  }

  /**
   * Register a destination. A *different* destination already holding the
   * same label is flushed, disposed, and replaced; re-adding an instance
   * that is already registered is a no-op, because disposing and re-pushing
   * the same object would leave a live destination in a closed state.
   */
  addDestination(destination: LogDestination): this {
    // Identity first: an already-registered instance must not have its label
    // getter touched again, or the capture-once invariant leaks right here.
    if (this.registrations.some((r) => r.destination === destination)) {
      return this;
    }
    let label: string;
    try {
      label = destination.label;
    } catch {
      warnFixed(
        '[Logger] a destination was rejected: its label could not be read'
      );
      return this;
    }
    if (typeof label !== 'string') {
      warnFixed(
        '[Logger] a destination was rejected: its label is not a string'
      );
      return this;
    }
    this.removeDestination(label);
    this.registrations.push({ destination, label });
    return this;
  }

  removeDestination(label: string): this {
    const index = this.registrations.findIndex((r) => r.label === label);
    if (index >= 0) {
      const removed = this.registrations.splice(index, 1)[0]!;
      // Guarded separately: a failing flush must not skip dispose, or the
      // removed destination leaks timers/handles it will never release.
      try {
        removed.destination.flush();
      } catch {
        // a failing flush must not break reconfiguration
      }
      try {
        removed.destination.dispose();
      } catch {
        // a failing dispose must not break reconfiguration
      }
    }
    this.failureCounts.delete(label);
    this.disabledLabels.delete(label);
    return this;
  }

  /** Drain every destination synchronously (bounded per destination). */
  flush(deadlineMs = 2000): void {
    for (const { destination } of this.registrations) {
      try {
        destination.flush(deadlineMs);
      } catch {
        // isolation: one failing flush must not stop the others
      }
    }
  }

  // ── Scopes & correlation ────────────────────────────────────────────────

  /** Short-lived random correlation ID — the encouraged way to correlate.
   * Never derive correlation IDs from patient/visit/record identifiers. */
  newCorrelationId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  /** A scoped logger tagging every message with a correlation ID, optional
   * subsystem, and default metadata. Omit `correlation` to auto-generate. */
  scoped(
    correlation?: string,
    subsystem?: string,
    metadata?: LogMetadata
  ): ScopedLogger {
    return new ScopedLogger(
      this,
      correlation ?? this.newCorrelationId(),
      subsystem,
      metadata
    );
  }

  // ── Logging ─────────────────────────────────────────────────────────────

  log(message: LazyMessage, options?: LogOptions): void {
    this.logMessage(message, options);
  }

  verbose(
    message: LazyMessage,
    metadata?: LogMetadata,
    subsystem?: string
  ): void {
    this.logMessage(message, { level: 'verbose', metadata, subsystem });
  }

  debug(
    message: LazyMessage,
    metadata?: LogMetadata,
    subsystem?: string
  ): void {
    this.logMessage(message, { level: 'debug', metadata, subsystem });
  }

  info(message: LazyMessage, metadata?: LogMetadata, subsystem?: string): void {
    this.logMessage(message, { level: 'info', metadata, subsystem });
  }

  warning(
    message: LazyMessage,
    metadata?: LogMetadata,
    subsystem?: string
  ): void {
    this.logMessage(message, { level: 'warning', metadata, subsystem });
  }

  error(
    message: LazyMessage,
    metadata?: LogMetadata,
    subsystem?: string
  ): void {
    this.logMessage(message, { level: 'error', metadata, subsystem });
  }

  /** Marks incomplete work; highest severity so it always surfaces. */
  todo(message: LazyMessage, metadata?: LogMetadata, subsystem?: string): void {
    this.logMessage(message, { level: 'todo', metadata, subsystem });
  }

  /** Integration entry point (ScopedLogger, error handler, bridges). */
  logMessage(message: LazyMessage, options?: LogOptions): void {
    const level = options?.level ?? 'info';
    const subsystem = options?.subsystem;

    const effectiveMinimum =
      (subsystem !== undefined
        ? resolveSubsystemLevel(this.subsystemLevels, subsystem)
        : undefined) ?? this.globalMinimum;
    if (!levelAtLeast(level, effectiveMinimum)) return;

    // Eligibility BEFORE message evaluation: a lazy thunk must not run when
    // nothing will receive the entry. isEnabled/minimumLevel may be throwing
    // getters, so each read is isolated and charged to the stable label.
    const eligible: Registration[] = [];
    for (const registration of this.registrations) {
      const { destination, label } = registration;
      if (this.disabledLabels.has(label)) continue;
      try {
        if (!destination.isEnabled) continue;
        if (
          destination.minimumLevel !== undefined &&
          !levelAtLeast(level, destination.minimumLevel)
        ) {
          continue;
        }
      } catch {
        this.noteFailure(label);
        continue;
      }
      eligible.push(registration);
    }
    if (eligible.length === 0) return;

    let text: string;
    try {
      text = typeof message === 'function' ? message() : message;
    } catch {
      // Payload-free by design: the thrown value could contain anything.
      text = '[Logger] message thunk threw';
    }

    // Frozen: the same entry fans out to every destination, so a mutating
    // destination must not change what its siblings receive. Every field is
    // a primitive or a frozen null-prototype object, so freezing the entry
    // is enough — nothing reachable from it is mutable.
    const entry: LogEntry = Object.freeze({
      timestamp: Date.now(),
      level,
      message: text,
      metadata: prepareMetadata(options?.metadata),
      correlation: options?.correlation,
      subsystem,
    });

    for (const { destination, label } of eligible) {
      try {
        destination.write(entry);
        this.failureCounts.delete(label);
      } catch {
        this.noteFailure(label);
      }
    }
  }

  /** Count a consecutive failure; disable the destination at the threshold.
   * The diagnostic is fixed text — labels are caller-controlled, so including
   * one would break the payload-free contract and invite log injection. */
  private noteFailure(label: string): void {
    const failures = (this.failureCounts.get(label) ?? 0) + 1;
    this.failureCounts.set(label, failures);
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      this.disabledLabels.add(label);
      warnFixed(
        '[Logger] a destination was disabled after repeated write failures'
      );
    }
  }

  // ── Test support ────────────────────────────────────────────────────────

  /** @internal */
  resetForTesting(): void {
    for (const { destination } of this.registrations) {
      try {
        destination.dispose();
      } catch {
        // ignore
      }
    }
    this.globalMinimum = 'debug';
    this.subsystemLevels.clear();
    this.registrations = defaultRegistrations();
    this.failureCounts.clear();
    this.disabledLabels.clear();
  }
}

function defaultRegistrations(): Registration[] {
  const console_ = new ConsoleDestination();
  return [{ destination: console_, label: console_.label }];
}

/** Fixed-text diagnostic; never interpolates caller-controlled data. */
function warnFixed(message: string): void {
  try {
    console.warn(message);
  } catch {
    // nothing left to report to
  }
}

/**
 * Redaction seam. M1: pass metadata through, copying only primitive values —
 * objects/arrays/functions are dropped (payload-free). Enumeration and reads
 * are guarded (Proxy traps / throwing getters must not crash the app), the
 * copy has a null prototype (so a `__proto__` key is stored as data rather
 * than routed through `Object.prototype`'s setter), and the result is frozen
 * before fan-out. M2 replaces the filtering with privacy-default resolution,
 * wrapper validation, and key checks.
 */
function prepareMetadata(
  metadata: LogMetadata | undefined
): RedactedMetadata | undefined {
  const snapshot = safeSnapshotMetadata(metadata);
  if (!snapshot) return undefined;
  const result: Record<string, string | number | boolean> = Object.create(null);
  let count = 0;
  for (const key of Object.keys(snapshot)) {
    const value = snapshot[key];
    const kind = typeof value;
    if (
      kind === 'string' ||
      kind === 'boolean' ||
      (kind === 'number' && Number.isFinite(value as number))
    ) {
      result[key] = value as string | number | boolean;
      count += 1;
    }
    // else: dropped silently in M1; M2 adds the fixed count-only diagnostic
  }
  return count > 0 ? Object.freeze(result) : undefined;
}

/** Global shorthand, mirroring SwiftLogger's `Log`. */
export const Log = new Logger();
