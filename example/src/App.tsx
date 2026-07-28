import { useCallback, useMemo, useState } from 'react';
import {
  Text,
  View,
  StyleSheet,
  Pressable,
  ScrollView,
  Platform,
} from 'react-native';
import {
  createFileSink,
  createNativeConsoleSink,
} from 'react-native-nitro-logger';

// M0 spike harness: drives the raw sink contract end-to-end on device.
// Replaced by the real Log API demo screen in M1+.
export default function App() {
  const [lines, setLines] = useState<string[]>([]);
  const log = useCallback((line: string) => {
    setLines((prev) => [...prev.slice(-30), line]);
  }, []);

  const fileSink = useMemo(() => createFileSink(), []);
  const consoleSink = useMemo(() => {
    const sink = createNativeConsoleSink();
    sink.install('com.nitrologger.example', 'javascript');
    return sink;
  }, []);

  const logPath = useMemo(
    () => `${fileSink.defaultLogDirectory}/spike.log`,
    [fileSink]
  );

  const runSpike = useCallback(() => {
    try {
      fileSink.open(logPath);
      log(`open ok: ${logPath}`);

      const batch =
        Array.from({ length: 100 }, (_, i) =>
          JSON.stringify({ level: 'INFO', message: `spike entry ${i}` })
        ).join('\n') + '\n';
      const append = fileSink.appendBatch(batch, 100);
      log(
        `appendBatch: accepted=${append.accepted} queuedBytes=${append.queuedBytes}`
      );

      const status = fileSink.getStatus();
      log(
        `getStatus: queuedBytes=${status.queuedBytes} lost=${status.lostEntries}`
      );

      const flush = fileSink.flush(2000);
      log(
        `flush: durable=${flush.durable} timedOut=${flush.timedOut} pending=${flush.pendingBytes}`
      );

      const paths = fileSink.getLogFilePaths();
      log(`paths: ${paths.join(', ')}`);

      consoleSink.logBatch(
        [2, 3, 4],
        ['spike info line', 'spike warning line', 'spike error line']
      );
      log(
        `native console: 3 lines → ${Platform.OS === 'ios' ? 'os_log' : 'logcat'}`
      );
    } catch (e) {
      log(`ERROR: ${String(e)}`);
    }
  }, [fileSink, consoleSink, logPath, log]);

  const runClear = useCallback(() => {
    try {
      const out = fileSink.clearLogs(2000);
      log(`clearLogs: deleted=${out.deletedCount} durable=${out.durable}`);
    } catch (e) {
      log(`ERROR: ${String(e)}`);
    }
  }, [fileSink, log]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>nitro-logger M0 spike</Text>
      <Pressable style={styles.button} onPress={runSpike}>
        <Text style={styles.buttonText}>Run spike (open → append → flush)</Text>
      </Pressable>
      <Pressable style={styles.button} onPress={runClear}>
        <Text style={styles.buttonText}>Clear logs</Text>
      </Pressable>
      <ScrollView style={styles.output}>
        {lines.map((line, i) => (
          <Text key={i} style={styles.outputLine}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 80, paddingHorizontal: 16 },
  title: { fontSize: 18, fontWeight: '600', marginBottom: 16 },
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  buttonText: { color: 'white', textAlign: 'center', fontWeight: '500' },
  output: { flex: 1, marginTop: 16 },
  outputLine: { fontFamily: 'Menlo', fontSize: 11, marginBottom: 2 },
});
