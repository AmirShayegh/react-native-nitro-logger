import type { HybridObject } from 'react-native-nitro-modules';

/**
 * Routes pre-formatted lines to the platform's native log stream so JS logs
 * interleave with native ones — os_log on iOS (Console.app / Xcode), logcat
 * on Android.
 *
 * Levels cross as numeric codes 0–5 (verbose…todo) and map natively:
 * verbose/debug → .debug, info → .info, warning → .default, error → .error,
 * todo → .fault (iOS); Log.println priorities on Android.
 *
 * Batched like the file sink: one logBatch call per Batcher drain, parallel
 * primitive arrays, no per-entry struct marshaling.
 */
export interface NativeConsoleSink extends HybridObject<{
  ios: 'swift';
  android: 'kotlin';
}> {
  install(subsystem: string, category: string): void;
  logBatch(levels: number[], messages: string[]): void;
}
