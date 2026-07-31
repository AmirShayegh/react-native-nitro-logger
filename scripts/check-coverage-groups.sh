#!/usr/bin/env bash
#
# Every file coverage measures must belong to a threshold group.
#
# `jest.config.js` sets a `global` threshold and four narrower ones. That looks
# like five independent floors and is not: jest removes a file from `global`'s
# set as soon as any narrower key matches it, and when that empties the set
# completely it falls back to ALL covered files
# (`@jest/reporters`: `globalFiles.length > 0 ? globalFiles : coveredFiles`).
# Every `src/` file matches a narrower key today, so the set IS empty and
# `global` means "the whole library" — which is the only reading under which it
# is worth having.
#
# Add `src/new-area/module.ts` and that stops being true, silently. The set is
# no longer empty, the fallback no longer fires, and `global` starts meaning
# "the new area only". A well-covered new directory would then hold the global
# threshold up on its own while the rest of the library rotted underneath it,
# and nothing would fail. The thresholds would still be there, still green, and
# no longer measuring what the comment beside them says.
#
# So: enumerate what jest actually instrumented and require every file to match
# a narrower key. A new nested directory then has to declare its own aggregate
# before the suite can go green, which is the decision someone should be making
# on purpose.
#
# What this proves: the `global` group is empty, so its fallback fires, so its
# threshold is computed over the whole library.
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
const groups = Object.keys(config.coverageThreshold ?? {}).filter(
  (key) => key !== 'global'
);

const problems = [];

// Vacuity guards, both directions. Everything below passes trivially against
// an empty file list, and a config whose thresholds vanished would produce
// exactly that shape.
if (files.length === 0) {
  problems.push(`${process.argv[2]} lists no files — nothing was measured`);
}
if (groups.length === 0) {
  problems.push('jest.config.js declares no threshold group besides `global`');
}
if (!('global' in (config.coverageThreshold ?? {}))) {
  problems.push(
    'jest.config.js declares no `global` threshold — this check exists to ' +
      'keep that one honest, so its absence means the check is measuring ' +
      'nothing'
  );
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
      glob.sync(absolute, { windowsPathsNoEscape: true }).map((p) => path.resolve(p))
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
    `${unmatched.length} covered file(s) match no threshold group, so jest ` +
      'will compute `global` from them alone instead of from the whole ' +
      'library:'
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
    'threshold groups, so `global` covers the whole library'
);
NODE
