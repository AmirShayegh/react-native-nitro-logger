/**
 * SwiftLogger JSON goldens — GENERATED, do not edit by hand.
 *
 * Produced by `scripts/GenGoldens.swift` running against SwiftLogger's own
 * `JSONLogFormatter`. A golden someone typed out is a record of what they
 * believed the Swift side does, which is the thing under test. See
 * `scripts/README.md` to regenerate.
 *
 * Kept as a TypeScript module rather than a data file the test reads at
 * runtime: this package targets Hermes and its tsconfig deliberately carries
 * no Node type definitions, so nothing under test should need `fs`.
 */
export interface SwiftGolden {
  readonly name: string;
  readonly json: string;
}

export const SWIFT_GOLDENS: readonly SwiftGolden[] = [
  {
    name: 'minimal',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"started","line":0}',
  },
  {
    name: 'all-levels-verbose',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"VERBOSE","message":"m","line":0}',
  },
  {
    name: 'all-levels-debug',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"DEBUG","message":"m","line":0}',
  },
  {
    name: 'all-levels-warning',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"WARNING","message":"m","line":0}',
  },
  {
    name: 'all-levels-error',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"ERROR","message":"m","line":0}',
  },
  {
    name: 'all-levels-todo',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"TODO","message":"m","line":0}',
  },
  {
    name: 'correlation-only',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"m","correlation":"c0ffee","line":0}',
  },
  {
    name: 'subsystem-only',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"m","subsystem":"network","line":0}',
  },
  {
    name: 'correlation-and-subsystem',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"m","correlation":"c0ffee","subsystem":"network","line":0}',
  },
  {
    name: 'metadata-types',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"m","line":0,"metadata":{"b":true,"i":42,"s":"text"}}',
  },
  {
    name: 'metadata-key-sorting',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"m","line":0,"metadata":{"Mango":3,"_under":4,"alpha":2,"zebra":1}}',
  },
  {
    name: 'metadata-numeric-keys',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"m","line":0,"metadata":{"1":"one","10":"ten","2":"two","b":"bee"}}',
  },
  {
    name: 'escape-quote-backslash',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"he said \\"hi\\" and C:\\\\path","line":0}',
  },
  {
    name: 'escape-shorthand-controls',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"nl\\ncr\\rtab\\tbs\\bff\\f","line":0}',
  },
  {
    name: 'escape-other-c0',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"\\u0000\\u0001\\u001f","line":0}',
  },
  {
    name: 'unicode-passthrough',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"café 日本語 🎉 emoji","line":0}',
  },
  {
    name: 'escaped-metadata-key',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"m","line":0,"metadata":{"with\\nnewline":"w","with\\"quote":"v"}}',
  },
  {
    name: 'empty-message',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"","line":0}',
  },
  {
    name: 'empty-metadata-omitted',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"m","line":0}',
  },
  {
    name: 'negative-and-fractional-numbers',
    json: '{"timestamp":"2026-07-27T12:15:30.842Z","level":"INFO","message":"m","line":0,"metadata":{"frac":1.5,"neg":-17,"zero":0}}',
  },
  {
    name: 'epoch-before-1970',
    json: '{"timestamp":"1969-12-31T23:59:58.500Z","level":"INFO","message":"m","line":0}',
  },
];
