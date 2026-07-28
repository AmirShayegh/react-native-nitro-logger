import { NitroModules } from 'react-native-nitro-modules';
import type { FileSink } from './specs/FileSink.nitro';
import type { NativeConsoleSink } from './specs/NativeConsoleSink.nitro';

// ── Public API ──────────────────────────────────────────────────────────────
export { Log, Logger } from './Logger';
export type { LogOptions } from './Logger';
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
export { flushOnBackground } from './integrations/appState';
export type {
  FlushOnBackgroundOptions,
  AppStateLike,
} from './integrations/appState';
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
export type { LogFormatter } from './formatters/types';
export { DefaultFormatter } from './formatters/DefaultFormatter';
export { JsonLinesFormatter } from './formatters/JsonLinesFormatter';
export type {
  JsonTimestampStyle,
  JsonLinesFormatterOptions,
} from './formatters/JsonLinesFormatter';

// ── Spike-era raw sink access ───────────────────────────────────────────────
// Used by the example app's M0 harness; becomes internal once the
// FileDestination (M4/M5) and NativeConsoleDestination (M6) wrap these.
export type {
  FileSink,
  RotationConfig,
  RejectReason,
  SinkStatus,
  AppendResult,
  FlushOutcome,
  ClearOutcome,
} from './specs/FileSink.nitro';
export type { NativeConsoleSink } from './specs/NativeConsoleSink.nitro';

export function createFileSink(): FileSink {
  return NitroModules.createHybridObject<FileSink>('FileSink');
}

export function createNativeConsoleSink(): NativeConsoleSink {
  return NitroModules.createHybridObject<NativeConsoleSink>(
    'NativeConsoleSink'
  );
}
