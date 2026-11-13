#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v go >/dev/null 2>&1; then
  echo "FAIL: Go is required for the analytics grammar decoder probe"
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/nitro-logger-grammar.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

corepack yarn prepare >/dev/null
node scripts/probes/emit-analytics-grammar.js > "$WORK/grammar.json"
node - "$WORK/grammar.json" "$WORK/tampered.json" <<'NODE'
const fs = require('fs');
const document = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
document.additionalEvents = true;
fs.writeFileSync(process.argv[3], JSON.stringify(document));
NODE

go build -o "$WORK/decoder" scripts/probes/analytics-grammar-decode.go
if "$WORK/decoder" "$WORK/tampered.json" > "$WORK/negative.log" 2>&1; then
  echo "FAIL: Go decoder accepted the deliberately opened grammar"
  exit 1
fi
if ! grep -q "additionalEvents" "$WORK/negative.log"; then
  echo "FAIL: Go decoder rejected the negative control for the wrong reason"
  sed -n '1,4p' "$WORK/negative.log"
  exit 1
fi

"$WORK/decoder" "$WORK/grammar.json"
