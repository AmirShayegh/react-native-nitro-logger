import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View, StyleSheet, Pressable, ScrollView } from 'react-native';
import {
  Log,
  FileDestination,
  NativeConsoleDestination,
  JsonLinesFormatter,
  createFileSink,
  createNativeConsoleSink,
  pub,
  priv,
} from 'react-native-nitro-logger';

/**
 * Device harness: the real pipeline, not the raw sinks.
 *
 * `Log` → `FileDestination` → `Batcher` → Nitro → `LogWriter`, and
 * `Log` → `NativeConsoleDestination` → Nitro → os_log alongside it. The XCTest
 * suite proves both natives' rules on macOS in a second; what only a device can
 * answer is whether the same code works through Hermes and the bridge, against
 * the real `Library/Logs` directory, under iOS data protection, and into the
 * unified log where Console can actually see it.
 *
 * Everything runs on mount and prints one greppable result line, so the pass
 * can be driven from the command line instead of by tapping.
 */

const SENTINEL = 'NITRO_M6';

/// Greppable from the shell:
///   xcrun simctl spawn <udid> log show --last 2m \
///     --predicate 'subsystem == "nitrologger.example.harness"'
/// which is the only way to prove the os_log leg from outside the app.
const OSLOG_SUBSYSTEM = 'nitrologger.example.harness';

/// Small enough that a few hundred records rotate several times, so archives,
/// compression, and pruning all actually happen during a run.
const ROTATION = {
  maxFileSizeBytes: 32 * 1024,
  maxArchivedFilesCount: 5,
  compressArchives: true,
  maxTotalLogBytes: 2 * 1024 * 1024,
};

interface Step {
  name: string;
  detail: string;
  ok: boolean;
}

export default function App() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [verdict, setVerdict] = useState<string>('running…');
  const started = useRef(false);

  const destination = useMemo(() => {
    return new FileDestination(createFileSink(), {
      formatter: new JsonLinesFormatter(),
      rotation: ROTATION,
      // Deliberately small, so the burst below actually reaches the
      // backpressure path rather than sailing through an oversized buffer.
      maxPendingEntries: 500,
      watermarkBytes: 64 * 1024,
    });
  }, []);

  // Not named `console`: that would shadow the global this file logs through.
  const osLog = useMemo(() => {
    return new NativeConsoleDestination(createNativeConsoleSink(), {
      subsystem: OSLOG_SUBSYSTEM,
      category: 'harness',
    });
  }, []);

  const run = useCallback(() => {
    const collected: Step[] = [];
    const record = (name: string, ok: boolean, detail: string) => {
      collected.push({ name, detail, ok });
    };

    try {
      Log.addDestination(destination);
      record('open', true, destination.filePath);

      // 1. Ordinary logging, including both privacy wrappers. In a release
      //    build `priv()` renders as a placeholder; here it reveals, which is
      //    the difference the release-bundle CI job exists to check.
      Log.info('harness started', {
        run: pub(SENTINEL),
        device: priv('simulator'),
        rotationBytes: ROTATION.maxFileSizeBytes,
      });
      for (let i = 0; i < 200; i += 1) {
        Log.debug('warm-up record', { index: i });
      }
      const warm = destination.flush(5000);
      record('warm-up 200', warm.durable, `durable=${warm.durable}`);

      // 2. The burst. The Batcher answers `full` by pausing and polling, so
      //    the interesting number is how many records went unreported, not how
      //    fast it went.
      const burstStart = Date.now();
      for (let i = 0; i < 10_000; i += 1) {
        Log.info('burst record', { index: i, subsystemish: 'burst' });
      }
      const burst = destination.flush(20_000);
      const elapsed = Date.now() - burstStart;
      const unreported = destination.unreportedLoss();
      record(
        'burst 10000',
        burst.durable,
        `${elapsed}ms durable=${burst.durable} lost=${unreported.entries}`
      );

      // 3. Rotation, compression, and pruning all happened during the burst.
      const paths = destination.getLogFilePaths();
      const archives = paths.slice(1);
      const compressed = archives.filter((p) => p.endsWith('.gz')).length;
      record(
        'rotation',
        archives.length > 0 &&
          archives.length <= ROTATION.maxArchivedFilesCount,
        `${archives.length} archives (${compressed} gzipped), cap ${ROTATION.maxArchivedFilesCount}`
      );

      // 4. Degradation must be clean on a healthy device. A non-zero mask here
      //    is the single most useful thing this harness can report.
      const degraded = destination.degradation();
      record('degraded', degraded === 0, `mask=${degraded}`);

      // 5. Purge, then prove the sink still works. This is the compliance path:
      //    nothing may survive it, and logging must resume afterwards.
      const purge = destination.purge(5000);
      record(
        'purge',
        purge.durable,
        `deleted=${purge.deletedCount} durable=${purge.durable} failed=${purge.failedPaths.length}`
      );

      Log.info('after purge', { phase: pub('post-purge') });
      const after = destination.flush(5000);
      const afterPaths = destination.getLogFilePaths();
      record(
        'post-purge write',
        after.durable && afterPaths.length === 1,
        `durable=${after.durable} files=${afterPaths.length}`
      );

      record('paths', true, paths.slice(0, 3).join('\n'));

      // 6. The os_log leg. Nothing here can be read back from JavaScript — the
      //    unified log is write-only from inside the app — so the assertion is
      //    that the destination accepted and delivered everything, and the
      //    proof that it arrived comes from `log show` outside the process.
      Log.addDestination(osLog);
      for (const level of [
        'verbose',
        'debug',
        'info',
        'warning',
        'error',
        'todo',
      ] as const) {
        Log[level](`${SENTINEL} os_log level probe`, { level: pub(level) });
      }
      // Longer than one os_log entry will store, so the native chunker runs on
      // a real line rather than only under XCTest.
      Log.info(`${SENTINEL} long line ${'x'.repeat(4000)}`);
      osLog.flush();
      record(
        'os_log',
        osLog.isEnabled && osLog.dropped() === 0,
        `subsystem=${OSLOG_SUBSYSTEM} enabled=${osLog.isEnabled} dropped=${osLog.dropped()}`
      );
    } catch (e) {
      record('EXCEPTION', false, String(e));
    }

    setSteps(collected);
    const failed = collected.filter((s) => !s.ok);
    const summary =
      failed.length === 0
        ? `PASS ${collected.length}/${collected.length}`
        : `FAIL ${failed.map((s) => s.name).join(',')}`;
    setVerdict(summary);
    console.log(`${SENTINEL} ${summary}`);

    // The results go into the log file too, not just the console.
    //
    // `console.log` reaches the Metro terminal and nowhere else, which is no
    // use to a pass driven from a shell. Writing them here — after the purge,
    // so they survive it — means `cat Library/Logs/app.log` on the simulator
    // container is the whole report, and the harness's own output doubles as
    // proof the pipeline it is testing still works.
    try {
      Log.info('harness verdict', {
        result: pub(summary),
        steps: collected.length,
      });
      collected.forEach((step) => {
        Log.info('harness step', {
          step: step.name,
          ok: step.ok,
          detail: step.detail.replace(/\n/g, ' | '),
        });
      });
      destination.flush(5000);
    } catch (e) {
      console.log(`${SENTINEL} could not record the verdict: ${String(e)}`);
    }
  }, [destination, osLog]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    run();
  }, [run]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>nitro-logger · device harness</Text>
      <Text style={[styles.verdict, verdict.startsWith('PASS') && styles.pass]}>
        {verdict}
      </Text>
      <Pressable style={styles.button} onPress={run}>
        <Text style={styles.buttonText}>Run again</Text>
      </Pressable>
      <ScrollView style={styles.output}>
        {steps.map((step, i) => (
          <View key={i} style={styles.row}>
            <Text style={[styles.name, !step.ok && styles.bad]}>
              {step.ok ? '✓' : '✗'} {step.name}
            </Text>
            <Text style={styles.detail}>{step.detail}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 80, paddingHorizontal: 16 },
  title: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  verdict: {
    fontFamily: 'Menlo',
    fontSize: 14,
    marginBottom: 12,
    color: '#b91c1c',
  },
  pass: { color: '#15803d' },
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  buttonText: { color: 'white', textAlign: 'center', fontWeight: '500' },
  output: { flex: 1, marginTop: 8 },
  row: { marginBottom: 10 },
  name: { fontFamily: 'Menlo', fontSize: 12, fontWeight: '600' },
  bad: { color: '#b91c1c' },
  detail: { fontFamily: 'Menlo', fontSize: 11, color: '#475569' },
});
