// M0 spike surface: raw access to the two native sinks, enough to prove the
// bridge contract end-to-end on both platforms. The real public API (Log
// singleton, scoped loggers, privacy, batching) replaces this in M1+ and the
// sinks become internal.
import { NitroModules } from 'react-native-nitro-modules';
import type { FileSink } from './specs/FileSink.nitro';
import type { NativeConsoleSink } from './specs/NativeConsoleSink.nitro';

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
