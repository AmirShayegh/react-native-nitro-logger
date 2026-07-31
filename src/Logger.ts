import type { LazyMessage, LogEntry, LogLevel, LogMetadata } from './types';
import type { LogDestination } from './destinations/types';
import type { PrivacyDefault, PrivacySettings } from './privacy';
import { ConsoleDestination } from './destinations/ConsoleDestination';
import { resolveSubsystemLevel } from './config';
import { levelAtLeast } from './levels';
import { startDeadline } from './deadline';
import { newCorrelationId } from './correlation';
import {
  buildCatalog,
  normalizePrivacyDefault,
  redactMetadata,
} from './privacy';
import { ScopedLogger } from './ScopedLogger';

export interface LogOptions {
  level?: LogLevel;
  subsystem?: string;
  metadata?: LogMetadata;
  /** Scope defaults, outranked by `metadata` on any key they share. Kept a
   * separate field rather than pre-merged: redaction settles precedence per
   * key and validates the winner before reading it, which a merge would
   * defeat by reading everything first. `ScopedLogger` sets this. */
  scopeMetadata?: LogMetadata;
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

  // Privacy state. Every transition tightens; nothing here can be loosened
  // at runtime, so a compromised or careless call site cannot turn redaction
  // off in a shipped build.
  private privacyDefaultValue: PrivacyDefault = 'public';
  private privacyDefaultLocked = false;
  private redactAll = false;
  private keyCatalog: ReadonlySet<string> | undefined;

  // ── Privacy ─────────────────────────────────────────────────────────────

  /**
   * Choose how bare (unmarked) metadata values are treated.
   *
   * `'public'` — the OSS default — renders them. `'private'` redacts every
   * bare value outside dev builds unless wrapped in `pub()`, so a forgotten
   * wrapper hides data instead of leaking it. Apps handling PHI set
   * `'private'` in their entry point.
   *
   * First call wins; later calls may only tighten (`'public'` → `'private'`).
   * A request to loosen is ignored, not obeyed. Anything that is not exactly
   * `'public'` or `'private'` — a JS caller, JSON config, an `any` — resolves
   * to `'private'`: ambiguity must never resolve toward disclosure.
   *
   * `'private'` also makes the metadata key catalog mandatory — see
   * {@link metadataKeyCatalog}.
   */
  privacyDefault(value: PrivacyDefault): this {
    const normalized = normalizePrivacyDefault(value);
    if (!this.privacyDefaultLocked) {
      this.privacyDefaultValue = normalized;
      this.privacyDefaultLocked = true;
    } else if (normalized === 'private') {
      this.privacyDefaultValue = 'private';
    }
    return this;
  }

  /** Redact every metadata value from here on, marked or not, dev or not.
   * One-way: there is no call that undoes it. */
  redactAllMetadata(): this {
    this.redactAll = true;
    return this;
  }

  /**
   * Restrict metadata to an approved set of keys; anything else is dropped
   * and counted. Rejecting computed keys is not enough on its own — a
   * literal key like `patient123` is still PHI — so the catalog checks exact
   * membership at runtime.
   *
   * **Tighten-only, and that means every call intersects.** The second call
   * does not replace the first, it narrows it — so passing two different
   * groups of keys in two calls approves their *overlap*, which is usually
   * empty. One call, with the whole set, is the only shape that does what it
   * reads like. Mandatory under a `'private'` privacy default, where an
   * unconfigured catalog approves nothing and all metadata drops.
   *
   * **A malformed entry empties the whole catalog**, rather than being skipped
   * — see {@link buildCatalog}. Input is not trusted: a non-iterable, a
   * throwing iterator, a non-string or invalid key, or an over-long iterable
   * all yield an empty set rather than an exception or a hung JS thread.
   * Fail-closed is right, and it is also silent: one typo among fifty valid
   * keys drops all fifty, and under `'private'` every field of every entry
   * then renders `<private>` with nothing saying why.
   *
   * Which is what the development-only warning below is for. It fires when a
   * call makes the effective catalog *smaller* — the case that is nearly
   * always a mistake — and when the first call approves nothing at all. Never
   * with a key name: the keys are the thing this whole subsystem exists to
   * keep out of the log.
   */
  metadataKeyCatalog(keys: Iterable<string>): this {
    const incoming = buildCatalog(keys);
    const current = this.keyCatalog;

    if (current === undefined) {
      this.keyCatalog = incoming;
    } else {
      const intersection = new Set<string>();
      for (const key of current) {
        if (incoming.has(key)) intersection.add(key);
      }
      this.keyCatalog = intersection;
    }

    warnIfCatalogShrank(current, incoming, this.keyCatalog);
    return this;
  }

  private privacySettings(): PrivacySettings {
    return {
      privacyDefault: this.privacyDefaultValue,
      redactAll: this.redactAll,
      keyCatalog: this.keyCatalog,
    };
  }

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

  /**
   * Drain every destination synchronously, inside **one** budget.
   *
   * `deadlineMs` is the total, not an allowance per destination. It used to be
   * the latter, which meant a caller asking for 2000 with three destinations
   * registered could block the JavaScript thread for six seconds — the number
   * they passed multiplied by a count they may not control, since adding a
   * destination lengthened every flush in the app.
   *
   * The budget is spent in **registration order**, which is therefore now
   * load-bearing: the first destination registered gets first call on the time,
   * and a destination added later can find none left. Register the one whose
   * durability matters most — normally the file sink — first.
   *
   * An exhausted budget keeps iterating with `0` rather than skipping the rest.
   * `flush(0)` is not a no-op: it drains everything that needs no waiting, and
   * every destination still gets asked. Skipping would introduce a new way to
   * lose records on the crash path, which is the path this method exists for.
   *
   * What this does NOT bound: a destination that ignores its deadline. The
   * budget is cooperative, and a third-party `flush` that blocks for a minute
   * blocks for a minute. The two destinations in this package honour it.
   *
   * The time is read from a monotonic clock where the host has one, so a device
   * clock correction landing between two destinations cannot lengthen or end
   * the budget — see `startDeadline`.
   */
  flush(deadlineMs = 2000): void {
    const remaining = startDeadline(deadlineMs);
    for (const { destination } of this.registrations) {
      try {
        destination.flush(remaining());
      } catch {
        // isolation: one failing flush must not stop the others
      }
    }
  }

  // ── Scopes & correlation ────────────────────────────────────────────────

  /**
   * Short-lived random correlation ID — the encouraged way to correlate.
   * Never derive correlation IDs from patient/visit/record identifiers.
   *
   * Drawn from `crypto.getRandomValues` where the platform has it, and from
   * `Math.random` where it does not — see `src/correlation.ts` for why that
   * fallback is unconditional and why the choice is made per call rather than
   * once at import.
   */
  newCorrelationId(): string {
    return newCorrelationId();
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
      metadata: redactMetadata(
        options?.scopeMetadata,
        options?.metadata,
        this.privacySettings()
      ),
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

  // Deliberately no reset/reconfigure hook. Such a method would be a public
  // runtime path to loosen every privacy control on the `Log` singleton, and
  // an `@internal` tag does not remove a method from a JS build. Tests
  // construct their own `new Logger()` instead.
}

function defaultRegistrations(): Registration[] {
  const console_ = new ConsoleDestination();
  return [{ destination: console_, label: console_.label }];
}

/**
 * Says so, in development, when a catalog call approved less than it looks
 * like it did.
 *
 * Two mistakes are silent and both end the same way — every metadata field
 * rendering `<private>` with nothing to explain it:
 *
 * - **A malformed key empties the whole catalog.** `buildCatalog` is
 *   fail-closed on purpose, so one typo among fifty valid keys approves none
 *   of the fifty.
 * - **Repeat calls intersect.** Two calls with two different groups of keys
 *   approve their overlap, which is usually nothing. The method reads like it
 *   replaces; it narrows.
 *
 * The condition is that the **effective** catalog got smaller, not that the
 * intersection is smaller than one of its operands: calling again with a
 * superset is a legitimate no-op and firing on it would train people to
 * ignore this.
 *
 * **Counts only, never key names.** Approved key names are application
 * vocabulary and a rejected one may be the PHI-shaped literal — `patient123`
 * — that the catalog exists to keep out of the log. A diagnostic that printed
 * it would put it exactly where it must never be.
 *
 * Development only. This is guidance while the catalog is being configured,
 * and a release build has nobody to read it.
 */
function warnIfCatalogShrank(
  previous: ReadonlySet<string> | undefined,
  incoming: ReadonlySet<string>,
  effective: ReadonlySet<string>
): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;

  if (previous === undefined) {
    // The first call. Nothing narrowed, so the only failure visible here is a
    // catalog that came back with nothing in it — a malformed key, an input
    // that was not iterable, or an empty one.
    if (incoming.size > 0) return;
    warnFixed(
      '[nitro-logger] metadataKeyCatalog() approved 0 keys, so every ' +
        'metadata key will be dropped. One invalid key empties the whole ' +
        'catalog; check that each is 1-64 characters of [A-Za-z0-9._-].'
    );
    return;
  }

  if (effective.size >= previous.size) return;
  warnFixed(
    `[nitro-logger] metadataKeyCatalog() narrowed the approved keys from ` +
      `${previous.size} to ${effective.size}. Calls intersect rather than ` +
      `replace, so pass every key in a single call.`
  );
}

/** Fixed-text diagnostic; never interpolates caller-controlled data. */
function warnFixed(message: string): void {
  try {
    console.warn(message);
  } catch {
    // nothing left to report to
  }
}

/** Global shorthand, mirroring SwiftLogger's `Log`. */
export const Log = new Logger();
