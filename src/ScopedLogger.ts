import type { LazyMessage, LogLevel, LogMetadata } from './types';
import type { Logger } from './Logger';
import { safeSnapshotMetadata } from './metadata';

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

  log(
    message: LazyMessage,
    level: LogLevel = 'info',
    metadata?: LogMetadata
  ): void {
    this.logger.logMessage(message, {
      level,
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
      metadata,
      correlation: this.correlation,
    });
  }

  verbose(message: LazyMessage, metadata?: LogMetadata): void {
    this.log(message, 'verbose', metadata);
  }

  debug(message: LazyMessage, metadata?: LogMetadata): void {
    this.log(message, 'debug', metadata);
  }

  info(message: LazyMessage, metadata?: LogMetadata): void {
    this.log(message, 'info', metadata);
  }

  warning(message: LazyMessage, metadata?: LogMetadata): void {
    this.log(message, 'warning', metadata);
  }

  error(message: LazyMessage, metadata?: LogMetadata): void {
    this.log(message, 'error', metadata);
  }

  todo(message: LazyMessage, metadata?: LogMetadata): void {
    this.log(message, 'todo', metadata);
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
