import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { runCase } from '../../bench/measure';
import { cases as controlCases } from '../../bench/cases/control';
import { cases as hotpathCases } from '../../bench/cases/hotpath';
import { cases as formatCases } from '../../bench/cases/format';
import { cases as batcherCases } from '../../bench/cases/batcher';
import type { BenchCase } from '../../bench/cases/cases';

/**
 * The Hermes mirror of `bench/run.js`.
 *
 * Same case files, same measurement core (`bench/measure.js`), different
 * engine — which is the entire point: every number in the audit was V8, and
 * Hermes has its own regex engine, weaker escape analysis, and its own
 * `toISOString`, so any finding gated on Hermes behaviour is decided by THIS
 * run and never by the Node one.
 *
 * What one process cannot mirror: `bench/run.js` isolates every case in a
 * fresh child so no case sees another's JIT state or heap shape. An app has
 * one JS instance, so cases run oldest-first in a stable order with a yield
 * between them, and cross-case contamination is accepted and CONSTANT —
 * fine for before/after comparison of the same case list, which is the only
 * use these numbers have.
 *
 * Results leave through `console.log`, one line per case, each carrying the
 * run ID `scripts/bench-hermes-android.sh` passed in as a launch prop —
 * Hermes routes them to logcat's ReactNativeJS tag, and the run ID is what
 * stops a stale logcat buffer from signing off a run that never happened
 * (the min-rn lesson). Without a run ID prop it still runs, labelled
 * `manual`, for a human watching Metro logs.
 */
const ALL_CASES: BenchCase[] = [
  // Control first, as in `bench/run.js`: Hermes is the engine whose
  // elimination behaviour is least documented, so the floor its numbers
  // are checked against is measured on the same device in the same run.
  ...controlCases,
  ...hotpathCases,
  ...formatCases,
  ...batcherCases,
];

const MARKER = 'NITRO_BENCH';

/**
 * Hermes provides `performance.now` on the RN 0.78 floor; the React Native
 * type set this example compiles against does not declare it, hence the
 * ambient declaration. The `Date.now` fallback keeps the harness total on a
 * host without it — millisecond resolution is enough, because the
 * measurement core amortises the clock into ≥20 ms batches.
 */
declare const performance: { now(): number } | undefined;

const nowMs: () => number =
  typeof performance !== 'undefined' && performance
    ? () => performance.now()
    : () => Date.now();

interface BenchHarnessProps {
  readonly benchRunId?: string;
}

export default function BenchHarness(props: BenchHarnessProps) {
  const runId = props.benchRunId ?? 'manual';
  const [lines, setLines] = useState<string[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    let cancelled = false;
    const yieldToHost = () =>
      new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 50);
      });

    (async () => {
      // Let the first frame land so startup work is not billed to case one.
      await yieldToHost();

      for (const candidate of ALL_CASES) {
        if (cancelled) return;
        const instance = candidate.setup();
        const result = runCase(instance.op, {
          now: nowMs,
          gc: undefined,
          targetMs: 20,
          samples: 7,
          warmup: 2,
        });
        if (instance.teardown) instance.teardown();

        const record = JSON.stringify({
          name: candidate.name,
          nsPerOp: result.nsPerOp,
          iterations: result.iterations,
          samples: result.samples,
        });
        // The log line IS the output: Hermes routes it to logcat, where the
        // harvest script collects it by run ID.
        console.log(`${MARKER} ${runId} ${record}`);
        setLines((previous) => [
          ...previous,
          `${candidate.name}  ${Math.round(result.nsPerOp)} ns/op`,
        ]);
        await yieldToHost();
      }

      console.log(`${MARKER} ${runId} DONE ${ALL_CASES.length}`);
      setLines((previous) => [...previous, `done: ${ALL_CASES.length} cases`]);
    })();

    return () => {
      cancelled = true;
    };
  }, [runId]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hermes bench — run {runId}</Text>
      <ScrollView>
        {lines.map((line) => (
          <Text key={line} style={styles.line}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 64, paddingHorizontal: 16 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  line: { fontFamily: 'monospace', fontSize: 12, marginBottom: 2 },
});
