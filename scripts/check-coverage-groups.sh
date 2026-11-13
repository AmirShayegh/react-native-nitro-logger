#!/usr/bin/env bash
#
# Every file coverage measures must belong to an explicit threshold group.
#
# `jest.config.js` gives `src/` and `eslint-plugin/` separate aggregate floors.
# That separation is deliberate: combining them under `global` would let one
# product pay for coverage lost in the other and would weaken the runtime floor
# merely because plugin coverage was added.
#
# What this proves: both aggregate roots exist, every measured file belongs to
# a declared threshold group, and every JavaScript module published under the
# plugin directory appears in Jest's own coverage summary. The last condition
# makes a stale `collectCoverageFrom` glob fail instead of silently shrinking
# the plugin denominator.
#
# What this does NOT prove: that the thresholds are set anywhere useful, or
# that a covered line is a tested line. The first is a judgement recorded in
# `jest.config.js`; the second is `check-mutants.sh`, and neither is this.
set -euo pipefail

cd "$(dirname "$0")/.."

SUMMARY=coverage/coverage-summary.json

# Read from jest's own output rather than re-deriving `collectCoverageFrom`.
# A second implementation of that glob set could disagree with the first, and
# the disagreement would be invisible: this file would approve a set jest never
# measured.
if [[ ! -f "$SUMMARY" ]]; then
  echo "  FAIL $SUMMARY is missing — run this through \`yarn test:coverage\`," >&2
  echo "       which produces it. A missing report is a failure, not a skip." >&2
  exit 1
fi

node - "$SUMMARY" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

// The same glob package `@jest/reporters` uses for threshold keys. Requiring a
// different implementation would risk this agreeing with jest by luck.
let glob;
try {
  glob = require('glob');
} catch {
  console.error('  FAIL cannot require("glob") — this check mirrors jest\'s');
  console.error('       own matching and will not guess at it');
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const config = require(path.resolve('jest.config.js'));

const files = Object.keys(summary).filter((key) => key !== 'total');
const thresholds = config.coverageThreshold ?? {};
const groups = Object.keys(thresholds).filter(
  (key) => key !== 'global'
);
const requiredAggregates = ['./src/', './eslint-plugin/'];
const measuredFiles = new Set(files.map((file) => path.resolve(file)));
const expectedPluginFiles = glob
  .sync(path.resolve('eslint-plugin/**/*.js'), {
    nodir: true,
    windowsPathsNoEscape: true,
  })
  .map((file) => path.resolve(file));

const problems = [];

// Vacuity guards, both directions. Everything below passes trivially against
// an empty file list, and a config whose thresholds vanished would produce
// exactly that shape.
if (files.length === 0) {
  problems.push(`${process.argv[2]} lists no files — nothing was measured`);
}
if (groups.length === 0) {
  problems.push('jest.config.js declares no explicit threshold groups');
}
for (const aggregate of requiredAggregates) {
  if (!(aggregate in thresholds)) {
    problems.push(`jest.config.js has no ${aggregate} aggregate threshold`);
  }
}
if (expectedPluginFiles.length === 0) {
  problems.push(
    'eslint-plugin/**/*.js matched no files — plugin coverage is vacuous'
  );
}
const unmeasuredPluginFiles = expectedPluginFiles.filter(
  (file) => !measuredFiles.has(file)
);
if (unmeasuredPluginFiles.length > 0) {
  problems.push(
    `${unmeasuredPluginFiles.length} ESLint plugin module(s) are absent from ` +
      'Jest coverage:'
  );
  for (const file of unmeasuredPluginFiles) {
    problems.push(`  - ${path.relative(process.cwd(), file)}`);
  }
}

// Mirrors `@jest/reporters`: a key that resolves to an existing path matches by
// prefix, anything else is matched as a glob.
const matchesFor = new Map();
for (const group of groups) {
  const resolved = path.resolve(group);
  const suffix =
    group.endsWith(path.sep) && !resolved.endsWith(path.sep) ? path.sep : '';
  const absolute = `${resolved}${suffix}`;
  matchesFor.set(group, {
    absolute,
    globbed: new Set(
      glob
        .sync(absolute, { windowsPathsNoEscape: true })
        .map((p) => path.resolve(p))
    ),
  });
}

const unmatched = [];
for (const file of files) {
  const resolved = path.resolve(file);
  const matched = groups.some((group) => {
    const { absolute, globbed } = matchesFor.get(group);
    return resolved.indexOf(absolute) === 0 || globbed.has(resolved);
  });
  if (!matched) unmatched.push(path.relative(process.cwd(), resolved));
}

if (unmatched.length > 0) {
  problems.push(
    `${unmatched.length} covered file(s) match no explicit threshold group:`
  );
  for (const file of unmatched) problems.push(`  - ${file}`);
  problems.push(
    'Give the directory its own aggregate in jest.config.js — that is the ' +
      'decision this is asking for, not a bigger `global`.'
  );
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  FAIL ${problem}`);
  process.exit(1);
}

console.log(
  `  ok   all ${files.length} covered files belong to one of ${groups.length} ` +
    'explicit threshold groups'
);
console.log('  ok   src/ and eslint-plugin/ have independent aggregate floors');
console.log(
  `  ok   all ${expectedPluginFiles.length} ESLint plugin modules are present ` +
    'in the coverage report'
);
NODE
