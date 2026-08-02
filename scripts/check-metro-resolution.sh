#!/usr/bin/env bash
#
# Which of this package's entry points a stock app at the MINIMUM supported
# React Native can actually resolve.
#
# The raw sinks and analytics schema API live at package subpaths. Subpath
# exports are the one part of the
# export map Metro does not honour unconditionally — `unstable_enablePackageExports`
# was added off by default and turned on later — so the migration the release
# notes ask for ("change one import line") is not, at the bottom of the
# supported range, only an import line. It also needs a line of `metro.config.js`.
#
# `check-package-exports.sh` cannot see this. It runs Node's resolver and
# `tsc`, both of which honour `exports` unconditionally; every entry point
# passes there and one of them still fails to bundle. Neither can the min-rn
# jobs, which deliberately import only the root entry point so that they keep
# standing for a stock consumer app.
#
# So this fixture, which is the README's claim executed rather than asserted:
# real react-native, real @react-native/metro-config, the real packed tarball,
# and the stock template `metro.config.js` — `mergeConfig(getDefaultConfig(...))`
# with nothing added — bundling each specifier for real.
#
# WHAT THIS DOES NOT PROVE. Resolution only, and only at the pinned minimum. It
# builds a bundle; it never runs one, so it says nothing about whether the
# module works, whether the native side is linked, or whether anything is
# registered at runtime — the min-rn jobs own that. It also proves nothing
# about versions above the pin: Metro turned this default on in 0.82, and the
# fact that every later version keeps it on is read from their defaults, not
# executed here.
#
# WHEN TO DELETE THIS. The whole constraint is a property of React Native 0.78
# being the floor. Raise the floor to 0.79 or above and this file, plus the
# README's "/unstable needs one line of Metro config" section, should go
# together — which is why the peer-range assertion below fails loudly rather
# than quietly passing if that day comes.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"

# The floor this fixture is about. Pinned rather than read from MIN_RN_VERSION
# on purpose: the min-rn scripts take an override because they are asking "does
# it work here", and this one is asking "what is true at the bottom", which is
# a fixed question with a fixed answer to assert.
RN_VERSION=0.78.0
METRO_MAJOR_MINOR=0.81
# What @react-native-community/template@0.78.0 pins, and what
# react-native@0.78.0 declares as its peer (`^19.0.0`) — not a version picked
# to make the solver quiet. A tree that pairs the floor with the wrong React is
# not the tree this is claiming to measure.
REACT_VERSION=19.0.0

# If the floor moves, the answer below changes and this fixture is measuring a
# version nobody supports any more. Fail rather than mislead.
PEER="$(node -p "require('$REPO/package.json').peerDependencies['react-native']")"
if [ "$PEER" != ">=$RN_VERSION" ]; then
  echo "FAIL: peerDependencies.react-native is \"$PEER\", not \">=$RN_VERSION\"."
  echo "      This fixture pins the floor it measures. If the floor moved up to"
  echo "      0.79 or beyond, subpath exports resolve by default and both this"
  echo "      script and the README's Metro section should be deleted."
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/nitro-logger-metro.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

echo "==> Packing the tarball a consumer would install"
# stdout carries the `prepare` build's output as well as the filename, so take
# the filename from the directory rather than from what npm printed.
npm pack --pack-destination "$WORK" >"$WORK/pack.log" 2>&1 || {
  echo "FAIL: npm pack"; tail -20 "$WORK/pack.log"; exit 1
}
TARBALL="$(ls "$WORK"/react-native-nitro-logger-*.tgz)"
[ -f "$TARBALL" ] || { echo "FAIL: no tarball produced"; exit 1; }

cd "$WORK"
npm init -y >/dev/null 2>&1

echo "==> Installing a React Native $RN_VERSION dependency tree"
npm install --silent --no-audit --no-fund \
  "react-native@$RN_VERSION" \
  "@react-native/metro-config@$RN_VERSION" \
  "metro@^$METRO_MAJOR_MINOR.0" \
  "react@$REACT_VERSION" \
  react-native-nitro-modules@0.36.3 \
  "$TARBALL" >"$WORK/install.log" 2>&1 || {
  echo "FAIL: npm install"; tail -30 "$WORK/install.log"; exit 1
}

# Assert what actually got installed. A resolver claim is about a version, and
# a fixture that silently drifted to a different Metro would keep passing while
# proving something else.
ACTUAL_RN="$(node -p "require('react-native/package.json').version")"
ACTUAL_REACT="$(node -p "require('react/package.json').version")"
ACTUAL_METRO="$(node -p "require('metro/package.json').version")"
ACTUAL_PKG="$(node -p "require('react-native-nitro-logger/package.json').version")"
EXPECTED_PKG="$(node -p "require('$REPO/package.json').version")"
[ "$ACTUAL_RN" = "$RN_VERSION" ] || { echo "FAIL: react-native is $ACTUAL_RN, expected $RN_VERSION"; exit 1; }
[ "$ACTUAL_REACT" = "$REACT_VERSION" ] || { echo "FAIL: react is $ACTUAL_REACT, expected $REACT_VERSION"; exit 1; }
case "$ACTUAL_METRO" in
  "$METRO_MAJOR_MINOR".*) ;;
  *) echo "FAIL: metro is $ACTUAL_METRO, expected $METRO_MAJOR_MINOR.x"; exit 1 ;;
esac
[ "$ACTUAL_PKG" = "$EXPECTED_PKG" ] || {
  echo "FAIL: installed react-native-nitro-logger is $ACTUAL_PKG, expected $EXPECTED_PKG"
  exit 1
}
echo "  react-native $ACTUAL_RN / react $ACTUAL_REACT / metro $ACTUAL_METRO / react-native-nitro-logger $ACTUAL_PKG"

# The stock React Native 0.78 template's metro.config.js, verbatim from
# @react-native-community/template@0.78.0 — the file `npx ... init` writes.
cat > "$WORK/metro.config.stock.js" <<'CFG'
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const config = {};
module.exports = mergeConfig(getDefaultConfig(__dirname), config);
CFG

# The same file with the one documented line added, in the merged form the
# README tells a reader to use. If the README's snippet and this diverge, the
# documented workaround stops being the tested one.
cat > "$WORK/metro.config.flag.js" <<'CFG'
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const config = {resolver: {unstable_enablePackageExports: true}};
module.exports = mergeConfig(getDefaultConfig(__dirname), config);
CFG

echo "import {createFileDestination} from 'react-native-nitro-logger'; console.log(typeof createFileDestination);" > "$WORK/entry-root.js"
echo "import {createFileSink} from 'react-native-nitro-logger/unstable'; console.log(typeof createFileSink);" > "$WORK/entry-unstable.js"
echo "import {defineEvents, oneOf} from 'react-native-nitro-logger/analytics'; const events = defineEvents({probe: {value: oneOf('ok')}}); if (events.grammar.additionalEvents !== false || JSON.stringify(events.grammar) !== events.grammarJSON) throw new Error('invalid grammar');" > "$WORK/entry-analytics.js"

mkdir -p "$WORK/out"

# Six bundles, and the expected outcome of each. `expect` is the whole point:
# four of these must succeed and two must fail, and each failure must
# fail by naming the specifier — an unrelated resolution error would otherwise
# sign off the claim that subpath exports are what is broken.
cat > "$WORK/drive.js" <<'JS'
const Metro = require('metro');
const path = require('path');

const CASES = [
  {config: 'stock', entry: 'entry-root.js', expect: 'resolves'},
  {config: 'stock', entry: 'entry-unstable.js', expect: 'fails', specifier: 'react-native-nitro-logger/unstable'},
  {config: 'stock', entry: 'entry-analytics.js', expect: 'fails', specifier: 'react-native-nitro-logger/analytics'},
  {config: 'flag', entry: 'entry-root.js', expect: 'resolves'},
  {config: 'flag', entry: 'entry-unstable.js', expect: 'resolves'},
  {config: 'flag', entry: 'entry-analytics.js', expect: 'resolves'},
];

(async () => {
  let failures = 0;
  for (const {config: cfg, entry, expect, specifier} of CASES) {
    const loaded = await Metro.loadConfig({
      cwd: __dirname,
      config: path.join(__dirname, `metro.config.${cfg}.js`),
    });
    // Silenced by overriding the LOADED config, not by passing a default to
    // loadConfig: that second argument supplies defaults, which
    // getDefaultConfig's own reporter then wins over — so the banner still
    // printed, four times, burying the four lines that matter.
    const config = {...loaded, reporter: {update() {}}};
    let outcome, detail = '';
    try {
      await Metro.runBuild(config, {
        entry,
        platform: 'android',
        dev: false,
        minify: false,
        out: path.join(__dirname, 'out', `${cfg}-${entry}`),
      });
      outcome = 'resolves';
    } catch (e) {
      outcome = 'fails';
      detail = String((e && e.message) || e).split('\n')[0];
    }

    let ok = outcome === expect;
    // The failing case has to fail for the documented reason.
    if (ok && expect === 'fails' && !detail.includes(specifier)) {
      ok = false;
      detail += `  <-- expected the error to name ${specifier}`;
    }
    if (!ok) failures += 1;
    const label = `${cfg} + ${entry}`;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(34)} ${outcome}` +
      (detail ? `\n         ${detail.slice(0, 140)}` : ''));
  }
  process.exit(failures === 0 ? 0 : 1);
})();
JS

echo "==> Bundling each entry point under each config"
if node "$WORK/drive.js"; then
  cat <<EOM

the export map resolves as documented at React Native $RN_VERSION:
  the root entry point bundles with or without unstable_enablePackageExports
  the /unstable and /analytics subpaths bundle only with it
EOM
else
  echo
  echo "FAIL: the export map does not resolve as the README documents"
  exit 1
fi
