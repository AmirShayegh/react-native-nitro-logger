import { FileDestination } from './destinations/FileDestination';
import type { FileDestinationOptions } from './destinations/FileDestination';
import { NativeConsoleDestination } from './destinations/NativeConsoleDestination';
import type { NativeConsoleDestinationOptions } from './destinations/NativeConsoleDestination';
import { createFileSink, createNativeConsoleSink } from './unstable';

// ── Public API ──────────────────────────────────────────────────────────────
export { Log, Logger } from './Logger';
export type { DestinationStatus, LogOptions } from './Logger';
export { ScopedLogger } from './ScopedLogger';
export type {
  LogLevel,
  LazyMessage,
  LogPrimitive,
  LogValue,
  LogMetadata,
  RedactedMetadata,
  LogEntry,
} from './types';
export { pub, priv } from './privacy';
export {
  METADATA_KEY_PATTERN_SOURCE,
  DROPPED_COUNT_KEY,
  MAX_CATALOG_SIZE,
  UNREADABLE_VALUE,
} from './privacy';
export type { PublicValue, PrivateValue, PrivacyDefault } from './privacy';
export type { LogDestination } from './destinations/types';
export { ConsoleDestination } from './destinations/ConsoleDestination';
export { FileDestination } from './destinations/FileDestination';
export type {
  CollectForSupportOptions,
  FileDestinationOptions,
  FileSinkLike,
  PurgeOutcome,
} from './destinations/FileDestination';
export { NativeConsoleDestination } from './destinations/NativeConsoleDestination';
export type {
  NativeConsoleDestinationOptions,
  NativeConsoleSinkLike,
} from './destinations/NativeConsoleDestination';
export { installErrorHandler } from './integrations/errorHandler';
export {
  ERROR_METADATA_KEYS,
  UNCAUGHT_ERROR_MESSAGE,
} from './integrations/errorHandler';
export type {
  ErrorHandlerOptions,
  ErrorUtilsLike,
  Uninstall,
} from './integrations/errorHandler';
export { installRejectionHandler } from './integrations/rejectionHandler';
export {
  REJECTION_METADATA_KEYS,
  UNHANDLED_REJECTION_MESSAGE,
  REJECTION_HANDLED_LATE_MESSAGE,
} from './integrations/rejectionHandler';
export type {
  RejectionHandlerOptions,
  RejectionTrackingLike,
  RejectionTrackingOptions,
} from './integrations/rejectionHandler';
export { flushOnBackground } from './integrations/appState';
export type {
  FlushOnBackgroundOptions,
  AppStateLike,
} from './integrations/appState';
export { scheduleMaintenance } from './integrations/maintenance';
export { MINIMUM_MAINTENANCE_INTERVAL_MS } from './integrations/maintenance';
export type {
  ScheduleMaintenanceOptions,
  MaintainableDestination,
} from './integrations/maintenance';
export {
  sanitizeError,
  DEFAULT_BUNDLE_NAMES,
  DEFAULT_MAX_FRAMES,
  REDACTED_FRAME,
  REDACTED_MESSAGE,
  UNKNOWN_ERROR_NAME,
  NON_ERROR_THROWN,
} from './integrations/sanitizeError';
export type {
  SanitizedError,
  SanitizeErrorOptions,
} from './integrations/sanitizeError';
export { Batcher } from './destinations/Batcher';
export type {
  BatchTarget,
  BatchFlushOutcome,
  BatcherOptions,
  FenceReason,
  LossCounts,
} from './destinations/Batcher';
export { utf8Length } from './utf8';
export {
  DEGRADED_ROTATION,
  DEGRADED_GZIP,
  DEGRADED_PRUNE,
  DEGRADED_SIDECAR,
  DEGRADED_PROTECTION,
  DEGRADED_EXCLUSIVITY,
  describeDegradation,
} from './degradation';
export { levelAtLeast, LEVEL_ORDER } from './levels';
export { PRIVATE_PLACEHOLDER } from './privacy';
export type { LogFormatter } from './formatters/types';
export { DefaultFormatter } from './formatters/DefaultFormatter';
export { JsonLinesFormatter } from './formatters/JsonLinesFormatter';
export type {
  JsonTimestampStyle,
  JsonLinesFormatterOptions,
} from './formatters/JsonLinesFormatter';

/**
 * A `FileDestination` on the real native sink — the ordinary way to get one.
 *
 * `new FileDestination(createFileSink(), options)` says the same thing and
 * makes a caller name a type it has no other reason to hold. The constructor
 * stays public because a `FileSinkLike` double is how this is tested, and that
 * is a legitimate thing to want.
 *
 * Throws what the constructor throws: a missing native module, an open
 * failure, or a config conflict with a writer already open on that path. A
 * file destination that silently writes nowhere is worse than one that refuses
 * to be constructed.
 */
export function createFileDestination(
  options: FileDestinationOptions = {}
): FileDestination {
  return new FileDestination(createFileSink(), options);
}

/** A `NativeConsoleDestination` on the real native sink. Same reasoning. */
export function createNativeConsoleDestination(
  options: NativeConsoleDestinationOptions = {}
): NativeConsoleDestination {
  return new NativeConsoleDestination(createNativeConsoleSink(), options);
}

// ── Native call results ─────────────────────────────────────────────────────
// The shapes the native calls return, and the rotation config they take. Root
// exports because a `FileSinkLike` implementation has to construct them.
export type {
  RotationConfig,
  RejectReason,
  SinkStatus,
  AppendResult,
  FlushOutcome,
  ClearOutcome,
  CollectOutcome,
} from './specs/FileSink.nitro';

// ── Raw sink access ─────────────────────────────────────────────────────────
// Re-exported here through 0.3.0 and moving out at the next major: the sinks
// themselves now live behind `react-native-nitro-logger/unstable`, which is
// where a caller that genuinely wants the layer below a destination should
// import them from. See `src/unstable.ts` for what that layer does not do for
// you.
export type { FileSink } from './specs/FileSink.nitro';
export type { NativeConsoleSink } from './specs/NativeConsoleSink.nitro';
export { createFileSink, createNativeConsoleSink } from './unstable';
