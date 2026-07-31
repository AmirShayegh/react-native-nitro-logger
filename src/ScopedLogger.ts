import type { LazyMessage, LogLevel, LogMetadata } from './types';
import type { InternalLogOptions, Logger } from './Logger';
import { safeSnapshotMetadata } from './metadata';

/**
 * What a {@link ScopedLogger.log} call may say for itself.
 *
 * Two fields, and the omissions are the design. A scope owns its `subsystem`
 * and its `correlation` — that is what a scope is — so neither appears here.
 * A call that could override them would let one line quietly leave the unit of
 * work every other line belongs to, which is the trail a scope exists to keep
 * intact.
 */
export interface ScopedLogOptions {
  /** Defaults to `'info'`, as the old positional form did. */
  readonly level?: LogLevel;
  /** Call-site metadata. Wins over the scope's defaults on any shared key. */
  readonly metadata?: LogMetadata;
}

/**
 * A lightweight logger that tags every message with a correlation ID,
 * optional default subsystem, and default metadata. Direct port of
 * SwiftLogger's ScopedLogger: immutable, delegates all work to the parent
 * Logger, nests.
 *
 * Metadata semantics: the scope's metadata merges into every message;
 * call-site keys win on collision (a message reporting `state: 'failed'`
 * must not be masked by the scope's `state: 'running'`). Child scopes merge
 * into — never replace — the parent's metadata.
 */
export class ScopedLogger {
  /** Frozen snapshot taken at construction — mutating the object the caller
   * passed in (or this field) after the fact must not change future logs,
   * matching SwiftLogger's value semantics. */
  readonly metadata?: Readonly<LogMetadata>;

  constructor(
    private readonly logger: Logger,
    readonly correlation: string,
    readonly subsystem?: string,
    metadata?: LogMetadata
  ) {
    const snapshot = safeSnapshotMetadata(metadata);
    this.metadata = snapshot ? Object.freeze(snapshot) : undefined;
  }

  /**
   * The general form, taking options rather than positional arguments.
   *
   * **Changed in 0.3.0**, and loudly on purpose. It was
   * `log(message, level?, metadata?)` — three positionals, in an order nobody
   * could recall, and different from `Logger.log(message, options?)` for no
   * reason beyond how each grew. A caller that passed a level still passes a
   * level; the compiler names the two lines to change, and a JavaScript caller
   * gets `'info'` rather than a level silently read from an object.
   *
   * `ScopedLogOptions` deliberately has no `subsystem` and no `correlation`:
   * a scope owns both, and letting a call override them would make the scope's
   * one job — every line in this unit of work carrying the same tag —
   * something a single call could quietly opt out of. Use `Logger.log` or a
   * nested `scoped()` for a genuinely different unit.
   *
   * The six level methods are unchanged: `info(message, metadata?)` and its
   * siblings already had no ambiguity worth fixing.
   */
  log(message: LazyMessage, options?: ScopedLogOptions): void {
    // Typed as the internal shape rather than passed as a literal: the public
    // `LogOptions` no longer carries `scopeMetadata`, and this is the one
    // caller that is supposed to set it.
    const threaded: InternalLogOptions = {
      level: options?.level ?? 'info',
      subsystem: this.subsystem,
      // Handed over unmerged: redaction settles precedence per key and
      // validates the winner BEFORE reading it, so a getter behind a
      // rejected key — or one the call site overrode — is not run here.
      // Merging would read every value first and defeat that.
      //
      // For this scope's own defaults the guarantee is one step weaker, and
      // the weakness is structural: `safeSnapshotMetadata` already applied the
      // key rule at construction, but not the catalog, which tightens at any
      // time. A default behind an unapproved key was therefore read once, when
      // the scope was built. Call-site metadata has no such step.
      scopeMetadata: this.metadata,
      metadata: options?.metadata,
      correlation: this.correlation,
    };
    this.logger.logMessage(message, threaded);
  }

  /**
   * The six level methods ask the parent whether the level passes before
   * doing anything else.
   *
   * A dropped scoped call used to allocate TWO objects — the
   * `ScopedLogOptions` literal here, then the threaded `InternalLogOptions`
   * in {@link log} — both to reach a decision neither of them influences.
   * The parent's answer is the same one `logMessage` would reach on arrival,
   * so what is logged is unchanged.
   *
   * **One named behaviour change**, for a subclass rather than a caller:
   * these methods no longer route a FILTERED call through {@link log}, so a
   * subclass that overrides `log` no longer sees the calls that were going
   * to be dropped — whatever it overrode `log` for. Not just observation:
   * an override that would have re-routed such a call, raised its level or
   * emitted it anyway cannot, because the call does not arrive. Calls that
   * pass the level check still go through the override as before, and a
   * direct call to `log` is untouched. Disclosed in the changeset.
   */
  verbose(message: LazyMessage, metadata?: LogMetadata): void {
    if (!this.logger.passesLevel('verbose', this.subsystem)) return;
    this.log(message, { level: 'verbose', metadata });
  }

  debug(message: LazyMessage, metadata?: LogMetadata): void {
    if (!this.logger.passesLevel('debug', this.subsystem)) return;
    this.log(message, { level: 'debug', metadata });
  }

  info(message: LazyMessage, metadata?: LogMetadata): void {
    if (!this.logger.passesLevel('info', this.subsystem)) return;
    this.log(message, { level: 'info', metadata });
  }

  warning(message: LazyMessage, metadata?: LogMetadata): void {
    if (!this.logger.passesLevel('warning', this.subsystem)) return;
    this.log(message, { level: 'warning', metadata });
  }

  error(message: LazyMessage, metadata?: LogMetadata): void {
    if (!this.logger.passesLevel('error', this.subsystem)) return;
    this.log(message, { level: 'error', metadata });
  }

  todo(message: LazyMessage, metadata?: LogMetadata): void {
    if (!this.logger.passesLevel('todo', this.subsystem)) return;
    this.log(message, { level: 'todo', metadata });
  }

  /**
   * Child scope: inherits this scope's correlation and subsystem unless
   * overridden, merges metadata (child keys win).
   *
   * `correlation` is optional and defaults to **this scope's**, which is the
   * opposite of `Logger.scoped()` generating a fresh one — and both are right
   * for the same reason. A correlation ID names a unit of work. `Logger.scoped()`
   * starts one; a scope nested inside it is still the same unit of work seen
   * closer up, and giving it a new ID severs the trail at exactly the point
   * someone reading the logs is trying to follow it. Pass one explicitly to
   * start a genuinely separate unit from inside an existing scope.
   *
   * The merge happens at construction, like any scope snapshot — both sides are
   * materialized here so later mutation of the caller's object cannot change
   * what the child reports.
   */
  scoped(
    correlation?: string,
    subsystem?: string,
    metadata?: LogMetadata
  ): ScopedLogger {
    const child = safeSnapshotMetadata(metadata);
    const merged = this.metadata
      ? Object.assign(Object.create(null) as LogMetadata, this.metadata, child)
      : child;
    return new ScopedLogger(
      this.logger,
      correlation ?? this.correlation,
      subsystem ?? this.subsystem,
      merged
    );
  }
}
