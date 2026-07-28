#!/usr/bin/env bash
#
# Proves the privacy reveal branches are not in a release bundle.
#
# The library gates every reveal on `__DEV__`, which Metro substitutes with a
# literal at bundle time so the whole branch becomes dead code and is stripped.
# That is the design; this is the check that it is also the reality. A refactor
# that moves a reveal behind a runtime flag, or a bundler configured without the
# substitution, would leave the branch — and its sentinel — in the shipped
# JavaScript, and nothing else in the build would notice.
#
# Run it anywhere: `./scripts/check-release-bundle.sh`. CI runs the same script,
# so a failure here is reproducible without pushing.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# An explicit path is a bundle the caller built and wants inspected. The
# default path is ours, and it is rebuilt every run: reusing whatever happens
# to be sitting there means the second local invocation after an edit checks
# the previous build and passes for the wrong reason.
if [ "$#" -ge 1 ]; then
  BUNDLE="$1"
  REBUILD=0
else
  BUNDLE="${TMPDIR:-/tmp}/nitro-logger-release.jsbundle"
  REBUILD=1
fi

# Every sentinel the reveal branches assign. Each lives inside an `if (__DEV__)`
# and is otherwise unreachable, so its presence in a release bundle means the
# branch survived.
SENTINELS=(
  '__NITRO_LOGGER_PRIVATE_REVEAL__'
  '__NITRO_LOGGER_ERROR_REVEAL__'
)

if [ "$REBUILD" -eq 1 ]; then
  rm -f "$BUNDLE"
fi

if [ ! -f "$BUNDLE" ]; then
  echo "Building a release bundle → $BUNDLE"
  (cd "$ROOT/example" && npx react-native bundle \
    --platform ios \
    --dev false \
    --entry-file index.js \
    --bundle-output "$BUNDLE" \
    --assets-dest "$(dirname "$BUNDLE")/assets")
fi

echo "Checking $(wc -c < "$BUNDLE" | tr -d ' ') bytes for reveal sentinels"

failed=0
for sentinel in "${SENTINELS[@]}"; do
  if grep -qF "$sentinel" "$BUNDLE"; then
    echo "FAIL: $sentinel is present in the release bundle"
    failed=1
  else
    echo "ok:   $sentinel is absent"
  fi
done

# A token from each gated module must survive.
#
# Without this the check has a false pass hiding in it: if a module were not
# bundled at all — unreachable from the example, tree-shaken away, renamed —
# its sentinel would be absent for a reason that has nothing to do with
# `__DEV__`, and the job would go green having proved nothing. Each token below
# lives outside the reveal branch, so its presence means the module is really
# there and its sentinel really was stripped.
declare -a WITNESSES=(
  '<private>:the privacy module'
  '<frame>:the error sanitiser'
)

for witness in "${WITNESSES[@]}"; do
  token="${witness%%:*}"
  what="${witness#*:}"
  if grep -qF "$token" "$BUNDLE"; then
    echo "ok:   $what is bundled (found '$token')"
  else
    echo "FAIL: '$token' is missing — $what is not in the bundle at all,"
    echo "      which makes its sentinel check above meaningless"
    failed=1
  fi
done

exit "$failed"
