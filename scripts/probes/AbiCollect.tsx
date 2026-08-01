import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Log,
  JsonLinesFormatter,
  createFileDestination,
  pub,
} from 'react-native-nitro-logger';

const SENTINEL = 'ABI_COLLECT';
const RUN_ID = '__RUN_ID__';
const RECORDS = 60;

/**
 * The collect probe: rotation with compressed archives, then a support
 * bundle, collected through the full production path — published package,
 * real bridge, real filesystem. The launching script pulls the bundle off
 * the device and hands it to verify-bundle.js, which counts the gzip
 * members out of the bytes (archives are byte-copied members, the active
 * file is compressed in beside them — that framing is the property under
 * test), ties the count to the `sourceFileCount` reported below, and checks
 * every sequence number arrived exactly once and in order. Fifteen seconds
 * later the app deletes the bundle and reports that too, so the script can
 * verify the delete is not a silent no-op.
 */
export default function App() {
  const [verdict, setVerdict] = useState('running');

  useEffect(() => {
    const facts: string[] = [];
    const post = (line: string) => {
      fetch('http://localhost:8099/verdict', {
        method: 'POST',
        body: line,
      }).catch(() => {});
      console.log(line);
    };

    try {
      const destination = createFileDestination({
        formatter: new JsonLinesFormatter(),
        rotation: {
          maxFileSizeBytes: 2048,
          maxArchivedFilesCount: 10,
          compressArchives: true,
        },
      });
      facts.push('construct=ok');
      Log.addDestination(destination);

      // Zero-padded so the host can assert order with a plain scan.
      for (let i = 0; i < RECORDS; i += 1) {
        Log.info('collect probe record', {
          run: pub(RUN_ID),
          seq: pub('seq-' + String(i).padStart(4, '0')),
        });
        // Every ten records, push the batch to native so rotation (which
        // runs on the write path) actually happens mid-stream.
        if (i % 10 === 9) destination.flush(10000);
      }
      const settled = destination.flush(10000);
      facts.push(`wrote=${RECORDS},durable:${settled.durable}`);

      const paths = destination.getLogFilePaths();
      facts.push(`paths=${paths.length}`);

      const outcome = destination.collectForSupport({
        maxTotalBytes: 10_000_000,
        deadlineMs: 10000,
      });
      facts.push(
        `collect=complete:${outcome.complete},truncated:${outcome.truncated},` +
          `files:${outcome.sourceFileCount},bytes:${outcome.byteCount}`
      );
      // Last token on the line, so the host can take everything after "path=".
      facts.push(`path=${outcome.path}`);

      const line = `${SENTINEL} ${RUN_ID} ${facts.join(' ')}`;
      post(line);
      setVerdict(line);

      // The delete probe, after the host has had time to pull the bundle.
      setTimeout(() => {
        const deleted = destination.deleteSupportBundle(5000);
        post(`${SENTINEL}_DEL ${RUN_ID} deleted=${String(deleted)}`);
      }, 15000);
    } catch (e) {
      const line = `${SENTINEL} ${RUN_ID} threw(${String(e).slice(0, 220)})`;
      post(line);
      setVerdict(line);
    }
  }, []);

  return (
    <View style={styles.page}>
      <Text>{verdict}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingTop: 80, paddingHorizontal: 16 },
});
