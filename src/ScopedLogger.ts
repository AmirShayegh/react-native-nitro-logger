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

  private merged(callSite?: LogMetadata): LogMetadata | undefined {
    // Call-site metadata is untrusted like any caller object — snapshot it
    // with guarded reads before merging. Both sides are then frozen or fresh
    // null-prototype objects, so the merge itself cannot throw or route a
    // `__proto__` key through a prototype setter.
    const site = safeSnapshotMetadata(callSite);
    if (!this.metadata) return site;
    if (!site) return this.metadata;
    return Object.assign(
      Object.create(null) as LogMetadata,
      this.metadata,
      site
    );
  }

  log(
    message: LazyMessage,
    level: LogLevel = 'info',
    metadata?: LogMetadata
  ): void {
    this.logger.logMessage(message, {
      level,
      subsystem: this.subsystem,
      metadata: this.merged(metadata),
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

  /** Child scope: inherits this scope's subsystem unless overridden, merges
   * metadata (child keys win). */
  scoped(
    correlation: string,
    subsystem?: string,
    metadata?: LogMetadata
  ): ScopedLogger {
    return new ScopedLogger(
      this.logger,
      correlation,
      subsystem ?? this.subsystem,
      this.merged(metadata)
    );
  }
}
