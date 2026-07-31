/**
 * The standalone JS benchmark — Node/V8 half of the perf harness.
 *
 * Not jest, deliberately: jest's module registry, its environment, and any
 * coverage instrumentation dominate sub-microsecond timings. This is plain
 * Node, one child process per case (see `bench/worker.js` for why), against
 * the BUILT library in `lib/commonjs` — the artifact that ships.
 *
 * Usage:
 *   node bench/run.js                  # every case, best-of-7
 *   node bench/run.js --filter utf8    # substring match on case names
 *   node bench/run.js --quick          # the CI "still executes" profile
 *   node bench/run.js --json out.json  # machine-readable results
 *
 * WHAT THIS DOES NOT PROVE. These are V8 numbers on whatever machine ran
 * them. They compare two commits in one session; they are not device
 * numbers, they are not comparable across machines, and CI never gates on
 * them — the `--quick` run in CI asserts only that every case still
 * executes. The engine that ships is Hermes; `scripts/bench-hermes-android.sh`
 * runs this same case list there, and any finding gated on Hermes behaviour
 * (B1, B6) is decided by THAT run, never by this one.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CASE_FILES = ['hotpath.js', 'format.js', 'batcher.js'].map((name) =>
  path.join(__dirname, 'cases', name)
);

function mtimeRange(directory) {
  let newest = 0;
  let oldest = Infinity;
  for (const entry of fs.readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const stamp = fs.statSync(
      path.join(entry.parentPath ?? entry.path, entry.name)
    ).mtimeMs;
    if (stamp > newest) newest = stamp;
    if (stamp < oldest) oldest = stamp;
  }
  return { newest, oldest };
}

/**
 * A stale build is the harness's one silent-lie mode: `bench/api.js` requires
 * `lib/commonjs`, so measuring after editing `src` without rebuilding
 * benchmarks last week's code under this week's commit message. Refuse.
 *
 * The comparison is the OLDEST built file against the NEWEST source: one
 * `corepack yarn prepare` rewrites every output after every edit, so
 * oldest-lib > newest-src holds exactly when the whole build postdates the
 * whole source tree. A partial or failed build leaves at least one output
 * older than the edit and is refused — comparing the newest built file
 * instead would let one surviving fresh output vouch for a stale tree.
 * The failure direction is safe: a false refusal costs one rebuild, a false
 * pass benchmarks the wrong code silently.
 */
function assertLibFresh() {
  const marker = path.join(ROOT, 'lib', 'commonjs', 'index.js');
  if (!fs.existsSync(marker)) {
    process.stderr.write(
      'FAIL: lib/commonjs is missing — run `corepack yarn prepare` first\n'
    );
    process.exit(1);
  }
  const lib = mtimeRange(path.join(ROOT, 'lib', 'commonjs'));
  const src = mtimeRange(path.join(ROOT, 'src'));
  if (src.newest > lib.oldest) {
    process.stderr.write(
      'FAIL: part of lib/commonjs predates the newest src edit — run ' +
        '`corepack yarn prepare` so the bench measures the code you edited\n'
    );
    process.exit(1);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const quick = argv.includes('--quick');
  const filterAt = argv.indexOf('--filter');
  const filter = filterAt >= 0 ? argv[filterAt + 1] : undefined;
  const jsonAt = argv.indexOf('--json');
  const jsonPath = jsonAt >= 0 ? argv[jsonAt + 1] : undefined;
  const mode = quick ? 'quick' : 'full';

  assertLibFresh();

  const selected = [];
  for (const file of CASE_FILES) {
    for (const candidate of require(file).cases) {
      if (filter && !candidate.name.includes(filter)) continue;
      selected.push({ file, name: candidate.name });
    }
  }
  if (selected.length === 0) {
    process.stderr.write(`FAIL: no cases match --filter ${filter}\n`);
    process.exit(1);
  }

  const results = [];
  for (const { file, name } of selected) {
    const child = spawnSync(
      process.execPath,
      ['--expose-gc', path.join(__dirname, 'worker.js'), file, name, mode],
      { cwd: ROOT, encoding: 'utf8' }
    );
    if (child.status !== 0) {
      process.stderr.write(`FAIL: case ${name} did not execute\n`);
      process.stderr.write(child.stderr || '');
      process.exit(1);
    }
    const result = JSON.parse(child.stdout);
    results.push(result);
    const ns =
      result.nsPerOp >= 1000
        ? (result.nsPerOp / 1000).toFixed(2) + ' µs/op'
        : result.nsPerOp.toFixed(1) + ' ns/op';
    process.stdout.write(`${result.name.padEnd(44)} ${ns.padStart(14)}\n`);
  }

  if (jsonPath) {
    const commit = (() => {
      try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
          cwd: ROOT,
          encoding: 'utf8',
        }).trim();
      } catch {
        return 'unknown';
      }
    })();
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        { engine: 'node-v8', node: process.version, commit, mode, results },
        null,
        2
      ) + '\n'
    );
    process.stdout.write(`\nwrote ${results.length} results to ${jsonPath}\n`);
  }

  process.stdout.write(
    quick
      ? `\nok: all ${results.length} cases execute (quick profile — the numbers above are not measurements)\n`
      : `\nok: ${results.length} cases, best-of-7 on V8 ${process.version} — Hermes decides Hermes-gated findings\n`
  );
}

main();
