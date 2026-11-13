/* global Buffer */

const fs = require('node:fs');
const path = require('node:path');
const {
  baseDecode,
  classifySegment,
  decimalInRange,
  identifierRawValid,
  otlpSemanticCaseValid,
  serializeHeader,
  strictUnknownPaths,
  unknownFields,
} = require('./helpers/wireContract');

const ROOT = path.resolve(__dirname, '..');
const DESCRIPTOR = path.join(ROOT, 'spec/wire/v1/contract.json');
const VECTORS = path.join(ROOT, 'spec/wire/v1/golden-vectors.json');
const WIRE_DOC = path.join(ROOT, 'docs/WIRE.md');

function load(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function requestContaining(message, object) {
  if (message === 'ExportLogsServiceRequest') return object;
  if (message === 'ResourceLogs') return { resourceLogs: [object] };
  if (message === 'Resource') return { resourceLogs: [{ resource: object }] };
  if (message === 'ScopeLogs')
    return { resourceLogs: [{ scopeLogs: [object] }] };
  if (message === 'InstrumentationScope') {
    return { resourceLogs: [{ scopeLogs: [{ scope: object }] }] };
  }
  if (message === 'LogRecord') {
    return { resourceLogs: [{ scopeLogs: [{ logRecords: [object] }] }] };
  }
  if (message === 'KeyValue') {
    return { resourceLogs: [{ resource: { attributes: [object] } }] };
  }
  if (message === 'AnyValue') {
    return {
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: object }] }] }],
    };
  }
  const arm = message === 'ArrayValue' ? 'arrayValue' : 'kvlistValue';
  return requestContaining('AnyValue', { [arm]: object });
}

function withoutKey(value, removed) {
  if (Array.isArray(value))
    return value.map((entry) => withoutKey(entry, removed));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== removed)
      .map(([key, child]) => [key, withoutKey(child, removed)])
  );
}

test('publishes one authoritative v1 descriptor and its public document', () => {
  expect(fs.existsSync(DESCRIPTOR)).toBe(true);
  expect(fs.existsSync(VECTORS)).toBe(true);
  expect(fs.existsSync(WIRE_DOC)).toBe(true);
  const descriptor = load(DESCRIPTOR);
  expect(descriptor.contractVersion).toBe(1);
  expect(descriptor.upstream).toEqual({
    otlpSpecification: '1.11.0',
    protobufDefinitions: 'v1.10.0',
  });
  expect(descriptor.header.version).toBe(1);
  expect(descriptor.header.byteOrder).toBe('big-endian');
  expect(descriptor.header.hash).toBe('sha256');
  expect(descriptor.identifiers).toEqual({
    maxBytes: 128,
    pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$',
  });
  expect(descriptor.header.fields).toEqual([
    { name: 'magic', encoding: 'fixed-bytes', bytes: 8 },
    { name: 'headerVersion', encoding: 'u16', bytes: 2 },
    { name: 'headerLength', encoding: 'u32', bytes: 4 },
    { name: 'segmentId', encoding: 'fixed-bytes', bytes: 16 },
    {
      name: 'contentHash',
      encoding: 'fixed-bytes',
      bytes: 32,
      zeroWhenHashing: true,
    },
    { name: 'tenantId', encoding: 'ascii', lengthPrefix: 'u16', maxBytes: 128 },
    { name: 'streamId', encoding: 'ascii', lengthPrefix: 'u16', maxBytes: 128 },
    {
      name: 'sourceEpoch',
      encoding: 'ascii',
      lengthPrefix: 'u16',
      maxBytes: 128,
    },
    { name: 'schemaVersion', encoding: 'u32', bytes: 4 },
    { name: 'consentGeneration', encoding: 'u64', bytes: 8 },
    { name: 'recordCount', encoding: 'u32', bytes: 4 },
    { name: 'payloadLength', encoding: 'u64', bytes: 8 },
  ]);
});

test('serializes and hashes every valid segment byte for byte', () => {
  const descriptor = load(DESCRIPTOR);
  const vectors = load(VECTORS);
  expect(vectors.validSegments.map(({ name }) => name)).toEqual([
    'minimal-operational',
    'all-anyvalue-arms',
    'omitted-resource-logs',
    'omitted-scope-logs',
    'omitted-log-records',
  ]);
  for (const vector of vectors.validSegments) {
    const payload = Buffer.from(vector.payloadHex, 'hex');
    const result = serializeHeader(descriptor, vector.fields, payload);
    expect(result.zeroHeader.toString('hex')).toBe(
      vector.expectedZeroHeaderHex
    );
    expect(result.hash.toString('hex')).toBe(vector.expectedHashHex);
    expect(result.header.toString('hex')).toBe(vector.expectedHeaderHex);
    expect(classifySegment(descriptor, result.header, payload)).toBe('valid');
  }
});

test('classifies every corruption and version vector fail closed', () => {
  const descriptor = load(DESCRIPTOR);
  const vectors = load(VECTORS);
  const names = new Set();
  for (const vector of vectors.invalidSegments) {
    expect(names.has(vector.name)).toBe(false);
    names.add(vector.name);
    expect(
      classifySegment(
        descriptor,
        Buffer.from(vector.headerHex, 'hex'),
        Buffer.from(vector.payloadHex, 'hex')
      )
    ).toBe(vector.expected);
  }
  expect(names).toEqual(
    new Set([
      'payload-bit-flip',
      'immutable-header-bit-flip',
      'hash-slot-bit-flip',
      'truncated-header',
      'truncated-payload',
      'payload-length-mismatch',
      'unknown-header-version',
      'empty-tenant-identifier',
      'oversized-tenant-length',
      'non-ascii-tenant-identifier',
      'hidden-trailing-header-byte',
      'record-count-mismatch',
      'wrong-magic',
      'empty-stream-identifier',
      'oversized-stream-length',
      'non-ascii-stream-identifier',
      'empty-source-epoch',
      'oversized-source-epoch-length',
      'non-ascii-source-epoch',
      'non-array-resource-logs',
      'non-object-resource-logs-entry',
      'non-array-scope-logs',
      'non-object-scope-logs-entry',
      'non-array-log-records',
    ])
  );
});

test('pins every declared signed and unsigned decimal boundary', () => {
  const descriptor = load(DESCRIPTOR);
  const vectors = load(VECTORS);
  expect(vectors.numericCases.map(({ name }) => name)).toEqual([
    'u16-zero',
    'u16-one',
    'u16-max',
    'u16-over',
    'u16-negative',
    'u32-zero',
    'u32-middle',
    'u32-max',
    'u32-over',
    'u32-negative',
    'u64-zero',
    'u64-above-js-safe',
    'u64-max',
    'u64-over',
    'u64-negative',
    'i64-min-under',
    'i64-min',
    'i64-negative-one',
    'i64-zero',
    'i64-above-js-safe',
    'i64-max',
    'i64-max-over',
    'leading-zero',
    'negative-zero',
    'non-ascii-digit',
  ]);
  for (const vector of vectors.numericCases) {
    expect(decimalInRange(vector.value, vector.signed, vector.bits)).toBe(
      vector.valid
    );
  }
  for (const vector of vectors.identifierCases) {
    expect(
      identifierRawValid(descriptor, Buffer.from(vector.rawHex, 'hex'))
    ).toBe(vector.valid);
  }
  expect(vectors.identifierCases.map(({ name }) => name)).toEqual([
    'one-byte',
    'maximum-128-bytes',
    'empty',
    'disallowed-first-byte',
    'disallowed-later-byte',
    'non-ascii',
    'decomposed-unicode',
    'malformed-utf8',
    'over-128-bytes',
  ]);
});

test('keeps OTLP interoperability separate from strict unknown-field refusal', () => {
  const descriptor = load(DESCRIPTOR);
  const vectors = load(VECTORS);
  const levels = new Set();
  for (const vector of vectors.unknownFieldCases) {
    const original = requestContaining(vector.message, JSON.parse(vector.json));
    expect(unknownFields(descriptor, vector.message, vector.json)).toEqual([
      vector.unknownField,
    ]);
    expect(strictUnknownPaths(descriptor, original)).toHaveLength(1);
    const normalized = baseDecode(descriptor, original);
    expect(normalized).toEqual(withoutKey(original, vector.unknownField));
    expect(strictUnknownPaths(descriptor, normalized)).toEqual([]);
    levels.add(vector.message);
  }
  expect(levels).toEqual(new Set(Object.keys(descriptor.otlp.messages)));
});

test('pins OTLP integer, enum, AnyValue, base64, and duplicate-key semantics', () => {
  const descriptor = load(DESCRIPTOR);
  const vectors = load(VECTORS);
  expect(vectors.otlpSemanticCases.map(({ name }) => name)).toEqual([
    'timestamp-above-js-safe',
    'timestamp-maximum',
    'timestamp-json-number',
    'timestamp-overflow',
    'observed-timestamp-maximum',
    'observed-timestamp-json-number',
    'flags-u32-maximum',
    'flags-fractional',
    'flags-negative',
    'flags-overflow',
    'dropped-count-zero',
    'dropped-count-string',
    'severity-integer',
    'severity-symbolic',
    'severity-fractional',
    'severity-out-of-range',
    'any-string',
    'any-boolean',
    'any-integer',
    'any-double',
    'any-bytes',
    'any-array',
    'any-kvlist',
    'any-array-non-array-values',
    'any-array-extra-container-field',
    'any-kvlist-extra-container-field',
    'any-kvlist-duplicate-key',
    'any-kvlist-malformed-entry',
    'any-nested-invalid-arm',
    'any-missing-arm',
    'any-multiple-arms',
    'any-integer-overflow',
    'any-invalid-base64',
    'any-non-finite-spelling',
    'duplicate-object-key',
    'duplicate-escaped-equivalent-key',
    'same-key-in-separate-objects',
  ]);
  for (const vector of vectors.otlpSemanticCases) {
    expect(otlpSemanticCaseValid(descriptor, vector)).toBe(vector.valid);
  }
});

test('ships deterministic document and manifest generators', () => {
  expect(fs.existsSync(path.join(ROOT, 'scripts/render-wire-doc.mjs'))).toBe(
    true
  );
  expect(
    fs.existsSync(path.join(ROOT, 'scripts/build-wire-contract-manifest.mjs'))
  ).toBe(true);
});
