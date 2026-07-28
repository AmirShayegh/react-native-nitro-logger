#!/usr/bin/env node
// Wraps GenGoldens.swift's JSON Lines output into the TypeScript module the
// parity test imports. See scripts/README.md.

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const records = input
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  if (records.length === 0) {
    console.error('goldensToModule: no records on stdin');
    process.exit(1);
  }

  const body = records
    .map(
      (r) =>
        `  { name: ${JSON.stringify(r.name)}, json: ${JSON.stringify(r.json)} },`
    )
    .join('\n');

  process.stdout.write(`/**
 * SwiftLogger JSON goldens — GENERATED, do not edit by hand.
 *
 * Produced by \`scripts/GenGoldens.swift\` running against SwiftLogger's own
 * \`JSONLogFormatter\`. A golden someone typed out is a record of what they
 * believed the Swift side does, which is the thing under test. See
 * \`scripts/README.md\` to regenerate.
 *
 * Kept as a TypeScript module rather than a data file the test reads at
 * runtime: this package targets Hermes and its tsconfig deliberately carries
 * no Node type definitions, so nothing under test should need \`fs\`.
 */
export interface SwiftGolden {
  readonly name: string;
  readonly json: string;
}

export const SWIFT_GOLDENS: readonly SwiftGolden[] = [
${body}
];
`);
});
