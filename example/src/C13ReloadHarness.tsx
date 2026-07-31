import { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { Log, FileDestination } from 'react-native-nitro-logger';
// The raw sink, deliberately: this harness needs the handle itself, and the
// directory it resolves, before any destination wraps it.
import { createFileSink } from 'react-native-nitro-logger/unstable';

/**
 * The C13 reload harness: a JavaScript runtime that opens a log file and then
 * dies without closing it.
 *
 * This is not a demo. It exists so an instrumented test can destroy the
 * `ReactInstance` underneath a live `FileDestination` and ask what the native
 * registry did about it — the observation `SPIKE-C13.md` could not make, and
 * the reason C13 was deferred whole.
 *
 * On Android nothing in the teardown path reaches this writer. The Kotlin
 * `HybridObject` sits in a JNI strong-reference cycle that only an explicit
 * `dispose()` breaks, so `finalize()` never runs; a Metro reload — or any
 * instance destruction — leaves the writer open, holding its descriptor and its
 * registry slot, with nothing left alive that could release either.
 *
 * **The per-launch rotation config is what makes this reproduce.** A reopen
 * with the *same* configuration is not refused: the registry hands back the
 * existing writer and increments its refcount, so a leak looks exactly like a
 * success and the harness would go green over the bug. A configuration nothing
 * else can be holding turns the leak into the one thing a test can see — the
 * reopen is refused, because the file is still open with somebody else's
 * settings.
 */

/** Greppable from `adb logcat`, and written into the file itself. */
const SENTINEL = 'C13_RELOAD_HARNESS';

/** The file both this component and `C13ReloadLeakTest` agree on. */
export const HARNESS_FILENAME = 'c13-reload.log';

/**
 * New in every runtime this component mounts in.
 *
 * Module scope, so it is evaluated once per JavaScript VM: a reload builds a
 * new VM and therefore a new nonce, which is what lets the test tell the second
 * launch's records from the first's. `Math.random` is mixed in because two
 * reloads inside one millisecond would otherwise collide, and a collision here
 * reads as "the reopen never happened".
 */
const LAUNCH_NONCE = `${Date.now().toString(36)}-${Math.floor(
  Math.random() * 1e9
).toString(36)}`;

/**
 * A rotation configuration nothing else in the process can be holding.
 *
 * The size is what the registry compares, and it has to differ between
 * launches for the reason in the header. It stays large enough that the
 * harness's own handful of records never rotate — rotation is not what is being
 * tested here, and an archive appearing mid-run would only add noise.
 */
const ROTATION = {
  maxFileSizeBytes: 4 * 1024 * 1024 + Math.floor(Math.random() * 1024 * 1024),
  maxArchivedFilesCount: 2,
  compressArchives: false,
  maxTotalLogBytes: 16 * 1024 * 1024,
};

interface Result {
  readonly ok: boolean;
  readonly line: string;
}

function run(): Result {
  const sink = createFileSink();
  const path = `${sink.defaultLogDirectory}/${HARNESS_FILENAME}`;

  let destination: FileDestination;
  try {
    // Throws on a config conflict, which is exactly the failure this harness is
    // built to provoke: before the fix, the previous runtime's writer is still
    // open on this path with the previous runtime's rotation config.
    destination = new FileDestination(sink, {
      label: 'c13',
      path,
      rotation: ROTATION,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      line: `${SENTINEL} OPEN_FAILED nonce=${LAUNCH_NONCE} reason=${reason}`,
    };
  }

  Log.addDestination(destination);
  Log.info(`${SENTINEL} launch=${LAUNCH_NONCE}`, undefined, 'c13');

  // Bounded, and the result is reported rather than assumed: a record still in
  // the batcher is not a record the test can read off the disk, and "the file
  // has no second nonce in it" has to mean the reopen failed, not that the
  // flush had not got round to it yet.
  const flushed = destination.flush(2000);

  return {
    ok: flushed.durable,
    line:
      `${SENTINEL} READY nonce=${LAUNCH_NONCE}` +
      ` size=${ROTATION.maxFileSizeBytes}` +
      ` durable=${flushed.durable}` +
      ` path=${path}`,
  };
}

export default function C13ReloadHarness() {
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let outcome: Result;
    try {
      outcome = run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outcome = { ok: false, line: `${SENTINEL} THREW ${reason}` };
    }
    // console, because logcat is what survives the runtime this ran in.
    console.log(outcome.line);
    setResult(outcome);

    // Deliberately no cleanup. The destination is *not* disposed and the sink
    // is *not* closed when this unmounts — that is the leak under test, and
    // tidying up here would be tidying away the whole question.
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.line}>{result?.line ?? 'C13 harness starting…'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, justifyContent: 'center' },
  line: { fontFamily: 'monospace', fontSize: 11 },
});
