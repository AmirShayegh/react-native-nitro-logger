/**
 * One case, one process — the isolation `bench/run.js` promises.
 *
 * A shared process would let case A's JIT tiering, string table, and heap
 * shape leak into case B's numbers; the classic symptom is a case that gets
 * "faster" when an unrelated case is added before it. The child ends after
 * one case, so every case starts from the same cold engine.
 *
 * Protocol: argv is `<case-file> <case-name> <mode>`; the result is a single
 * JSON line on stdout. Anything on stderr is a failure narrative for the
 * parent to surface.
 */
const path = require('path');
const { runCase } = require('./measure');

const PROFILES = {
  // Best-of-7 with two discarded warm batches, ≥20 ms per batch.
  full: { targetMs: 20, samples: 7, warmup: 2 },
  // The CI "still executes" pass: proves every case constructs and runs.
  quick: { targetMs: 2, samples: 2, warmup: 1 },
};

function main() {
  const file = process.argv[2];
  const name = process.argv[3];
  const mode = process.argv[4] || 'full';
  const profile = PROFILES[mode];
  if (!file || !name || !profile) {
    process.stderr.write('usage: worker.js <case-file> <case-name> <mode>\n');
    process.exit(2);
  }

  const found = require(path.resolve(file)).cases.filter(
    (candidate) => candidate.name === name
  );
  if (found.length !== 1) {
    process.stderr.write(
      `expected exactly one case named ${name} in ${file}, found ${found.length}\n`
    );
    process.exit(1);
  }

  const instance = found[0].setup();
  const result = runCase(instance.op, {
    now: () => Number(process.hrtime.bigint()) / 1e6,
    gc: typeof global.gc === 'function' ? global.gc : undefined,
    targetMs: profile.targetMs,
    samples: profile.samples,
    warmup: profile.warmup,
  });
  if (instance.teardown) instance.teardown();

  process.stdout.write(
    JSON.stringify({
      name,
      nsPerOp: result.nsPerOp,
      iterations: result.iterations,
      samples: result.samples,
    }) + '\n'
  );
  // A batcher case may have live timers; the measurement is done and written.
  process.exit(0);
}

main();
