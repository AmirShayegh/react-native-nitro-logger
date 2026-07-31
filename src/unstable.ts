import { NitroModules } from 'react-native-nitro-modules';
import type { FileSink } from './specs/FileSink.nitro';
import type { NativeConsoleSink } from './specs/NativeConsoleSink.nitro';

/**
 * The raw Nitro sinks, behind a name that says what they are.
 *
 * @module
 *
 * Everything here is the layer underneath `FileDestination` and
 * `NativeConsoleDestination`: a direct handle on the native writer, with no
 * batching, no loss accounting, no fence, and no redaction between a caller
 * and the file. It is exported because the example app's harness needs it and
 * because a `FileSinkLike` implementation is easier to write with the real
 * thing to compare against — not because reaching for it is ordinarily right.
 *
 * **`/unstable` makes this opt-in, not safe.** The name is a warning about
 * stability, and these carry a hazard that has nothing to do with stability: a
 * raw `clearLogs` bumps the writer generation, which makes every
 * `FileDestination` on that file stale — including ones this caller does not
 * know about. Nothing tells them. Each finds out when it next tries to write,
 * has the append rejected as a stale generation, fences itself and drops that
 * record; from then on it reports `isEnabled: false` until someone calls
 * `reopen()`. Purge through the destination if you have one.
 *
 * No stability promise: these names may change shape in a minor release. The
 * root export is the API with the compatibility commitment.
 */

export type { FileSink } from './specs/FileSink.nitro';
export type { NativeConsoleSink } from './specs/NativeConsoleSink.nitro';

/**
 * A raw file sink. Throws when the native module is not linked — see the
 * README's setup section, since that throw is the usual symptom of a missing
 * pod install or an app still on the old architecture.
 */
export function createFileSink(): FileSink {
  return NitroModules.createHybridObject<FileSink>('FileSink');
}

/** A raw native console sink. Throws under the same conditions. */
export function createNativeConsoleSink(): NativeConsoleSink {
  return NitroModules.createHybridObject<NativeConsoleSink>(
    'NativeConsoleSink'
  );
}
