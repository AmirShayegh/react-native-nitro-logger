const fs = require('node:fs');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const { hasNoDuplicateKeys } = require('./helpers/wireContract');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT = path.join(ROOT, 'spec/wire/v1/envelope-contract.json');
const VECTORS = path.join(ROOT, 'spec/wire/v1/envelope-vectors.json');

const REQUIRED_CASE_IDS = [
  'gateway-accepted',
  'gateway-rejected',
  'gateway-accepted-at-response-limit',
  'response-body-over-limit',
  'proxy-404-json',
  'proxy-500-html',
  'proxy-envelope-less-at-alarm-threshold',
  'unauthorized-401-first',
  'unauthorized-401-after-refresh',
  'request-too-large-413',
  'resource-exhausted-429-retry-after',
  'resource-exhausted-429-malformed-retry-after',
  'unavailable-503-retry-after',
  'network-error',
  'timeout',
  'generic-gateway-error-envelope',
  'malformed-json',
  'duplicate-key',
  'extra-field',
  'missing-field',
  'legacy-epoch-alias',
  'missing-content-type',
  'wrong-content-type',
  'ambiguous-content-type',
  'duplicate-identical-content-type',
  'mixed-case-duplicate-content-type',
  'missing-cache-control',
  'wrong-cache-control',
  'duplicate-identical-cache-control',
  'mixed-case-duplicate-cache-control',
  'mismatched-segment-id',
  'mismatched-content-hash',
  'stale-epoch',
  'unsupported-version',
  'unsupported-status',
  'accepted-with-reason',
  'rejected-with-null-reason',
  'unsupported-rejection-reason',
  'noncanonical-uppercase-identity',
  'valid-body-wrong-http-status',
];

function load(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function classifyEnvelope(contract, context, vector) {
  const response = vector.response;
  if (
    !response ||
    Array.isArray(response) ||
    typeof response !== 'object' ||
    response.status !== contract.response.httpStatus
  ) {
    return false;
  }
  const headerValues = (name) => {
    const values = [];
    for (const [key, value] of Object.entries(response.headers ?? {})) {
      if (key.toLowerCase() !== name.toLowerCase()) continue;
      if (!Array.isArray(value)) return null;
      values.push(...value);
    }
    return values;
  };
  const contentTypes = headerValues('Content-Type');
  const cacheControls = headerValues('Cache-Control');
  if (
    !Array.isArray(contentTypes) ||
    contentTypes.length !== 1 ||
    contentTypes[0] !== contract.response.contentType ||
    !Array.isArray(cacheControls) ||
    cacheControls.length !== 1 ||
    cacheControls[0] !== contract.response.cacheControl ||
    typeof response.body !== 'string' ||
    Buffer.byteLength(response.body, 'utf8') >
      contract.response.maximumBodyBytes ||
    !hasNoDuplicateKeys(response.body)
  ) {
    return false;
  }
  let body;
  try {
    body = JSON.parse(response.body);
  } catch {
    return false;
  }
  if (
    !body ||
    Array.isArray(body) ||
    typeof body !== 'object' ||
    JSON.stringify(Object.keys(body)) !==
      JSON.stringify(contract.response.fields) ||
    body.version !== contract.response.version
  ) {
    return false;
  }
  const canonicalHex = (value, bytes) =>
    typeof value === 'string' &&
    new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value);
  const canonicalEpoch =
    typeof body.acceptanceEpoch === 'string' &&
    [...body.acceptanceEpoch].every(
      (character) => character.codePointAt(0) <= 0x7f
    ) &&
    body.acceptanceEpoch.length >=
      contract.response.acceptanceEpoch.minimumBytes &&
    body.acceptanceEpoch.length <=
      contract.response.acceptanceEpoch.maximumBytes;
  if (
    !canonicalHex(body.segmentId, contract.response.segmentId.bytes) ||
    !canonicalHex(body.contentHash, contract.response.contentHash.bytes) ||
    !canonicalEpoch ||
    body.segmentId !== context.segmentId ||
    body.contentHash !== context.contentHash ||
    body.acceptanceEpoch !== context.latestKnownAcceptanceEpoch
  ) {
    return false;
  }
  return (
    (body.status === 'accepted' &&
      body.reasonCode === contract.response.outcomes.accepted.reasonCode) ||
    (body.status === 'rejected' &&
      contract.response.outcomes.rejected.reasonCodes.includes(body.reasonCode))
  );
}

test('publishes the v1 ingest acknowledgement contract library-first', () => {
  expect(fs.existsSync(CONTRACT)).toBe(true);
  expect(fs.existsSync(VECTORS)).toBe(true);
  const contract = load(CONTRACT);
  expect(contract).toEqual({
    contractVersion: 1,
    protocol: 'ingest-acknowledgement',
    response: {
      httpStatus: 200,
      contentType: 'application/vnd.nitro-logger.ack+json; version=1',
      cacheControl: 'no-store',
      maximumBodyBytes: 4096,
      fields: [
        'version',
        'segmentId',
        'contentHash',
        'status',
        'reasonCode',
        'acceptanceEpoch',
      ],
      version: '1',
      segmentId: { encoding: 'lowercase-hex', bytes: 16 },
      contentHash: { encoding: 'lowercase-hex', bytes: 32 },
      acceptanceEpoch: {
        encoding: 'ascii',
        minimumBytes: 1,
        maximumBytes: 128,
      },
      outcomes: {
        accepted: {
          reasonCode: null,
          clientAction: 'unlink-accepted',
        },
        rejected: {
          reasonCodes: ['SEGMENT_REJECTED'],
          clientAction: 'account-and-unlink-rejected',
        },
      },
    },
    terminalPredicate: [
      'single-http-response',
      'exact-http-status',
      'single-exact-content-type',
      'single-exact-cache-control',
      'response-body-within-limit',
      'strict-json-object',
      'exact-field-inventory',
      'supported-version',
      'canonical-identities',
      'segment-id-match',
      'content-hash-match',
      'latest-known-epoch-match',
      'valid-status-reason-pair',
    ],
    nonterminalDefault: 'retain-and-backoff',
  });
});

test('locks every client response-matrix row against fixture omission', () => {
  const vectors = load(VECTORS);
  expect(vectors.vectorVersion).toBe(1);
  expect(vectors.cases.map(({ id }) => id)).toEqual(REQUIRED_CASE_IDS);
  expect(new Set(vectors.cases.map(({ id }) => id)).size).toBe(
    REQUIRED_CASE_IDS.length
  );
  for (const vector of vectors.cases) {
    expect(typeof vector.doesNotProve).toBe('string');
    expect(vector.doesNotProve.length).toBeGreaterThan(0);
  }
});

test('pins only complete identity-bound envelopes as terminal', () => {
  const vectors = load(VECTORS);
  const terminal = vectors.cases.filter(({ expected }) => expected.terminal);
  expect(terminal.map(({ id }) => id)).toEqual([
    'gateway-accepted',
    'gateway-rejected',
    'gateway-accepted-at-response-limit',
  ]);
  expect(terminal.map(({ expected }) => expected.action)).toEqual([
    'unlink-accepted',
    'account-and-unlink-rejected',
    'unlink-accepted',
  ]);
  const responseHeaders = {
    'Content-Type': ['application/vnd.nitro-logger.ack+json; version=1'],
    'Cache-Control': ['no-store'],
  };
  expect(terminal.slice(0, 2).map(({ response }) => response)).toEqual([
    {
      status: 200,
      headers: responseHeaders,
      body: '{"version":"1","segmentId":"000102030405060708090a0b0c0d0e0f","contentHash":"79df9df42a61abc0460bca5158d971bdc45bb6c53a4a1dabd7b584656579ac32","status":"accepted","reasonCode":null,"acceptanceEpoch":"acceptance-epoch-v1"}\n',
    },
    {
      status: 200,
      headers: responseHeaders,
      body: '{"version":"1","segmentId":"000102030405060708090a0b0c0d0e0f","contentHash":"79df9df42a61abc0460bca5158d971bdc45bb6c53a4a1dabd7b584656579ac32","status":"rejected","reasonCode":"SEGMENT_REJECTED","acceptanceEpoch":"acceptance-epoch-v1"}\n',
    },
  ]);
  expect(Buffer.byteLength(terminal[2].response.body, 'utf8')).toBe(
    load(CONTRACT).response.maximumBodyBytes
  );
  const overLimit = vectors.cases.find(
    ({ id }) => id === 'response-body-over-limit'
  );
  expect(Buffer.byteLength(overLimit.response.body, 'utf8')).toBe(
    load(CONTRACT).response.maximumBodyBytes + 1
  );
  expect(
    vectors.cases.map((vector) =>
      classifyEnvelope(load(CONTRACT), vectors.context, vector)
    )
  ).toEqual(vectors.cases.map(({ expected }) => expected.terminal));

  const accepted = clone(terminal[0]);
  const bodyMutation = (mutate) => {
    const vector = clone(accepted);
    const body = JSON.parse(vector.response.body);
    mutate(body);
    vector.response.body = `${JSON.stringify(body)}\n`;
    return vector;
  };
  const predicateMutations = [
    (() => {
      const vector = clone(accepted);
      vector.response = [vector.response, vector.response];
      return vector;
    })(),
    (() => {
      const vector = clone(accepted);
      vector.response.status = 201;
      return vector;
    })(),
    (() => {
      const vector = clone(accepted);
      vector.response.headers['content-type'] = ['text/html'];
      return vector;
    })(),
    (() => {
      const vector = clone(accepted);
      vector.response.headers['cache-control'] = ['public'];
      return vector;
    })(),
    (() => {
      const vector = clone(accepted);
      vector.response.body += ' '.repeat(
        load(CONTRACT).response.maximumBodyBytes
      );
      return vector;
    })(),
    (() => {
      const vector = clone(accepted);
      vector.response.body = vector.response.body.replace(
        '"version":"1"',
        '"version":"1","version":"1"'
      );
      return vector;
    })(),
    bodyMutation((body) => {
      body.extra = true;
    }),
    bodyMutation((body) => {
      body.version = '2';
    }),
    bodyMutation((body) => {
      body.segmentId = body.segmentId.toUpperCase();
    }),
    bodyMutation((body) => {
      body.segmentId = `1${body.segmentId.slice(1)}`;
    }),
    bodyMutation((body) => {
      body.contentHash = `8${body.contentHash.slice(1)}`;
    }),
    bodyMutation((body) => {
      body.acceptanceEpoch = 'acceptance-epoch-v0';
    }),
    bodyMutation((body) => {
      body.reasonCode = 'SEGMENT_REJECTED';
    }),
  ];
  expect(predicateMutations).toHaveLength(
    load(CONTRACT).terminalPredicate.length
  );
  for (const vector of predicateMutations) {
    expect(classifyEnvelope(load(CONTRACT), vectors.context, vector)).toBe(
      false
    );
  }
  for (const vector of vectors.cases.filter(
    ({ expected }) => !expected.terminal
  )) {
    expect(vector.expected.terminal).toBe(false);
    expect(vector.expected.action).not.toMatch(/unlink/);
  }
});

test('the inventory assertion is a positive control against a deleted proxy row', () => {
  const vectors = load(VECTORS);
  const mutated = vectors.cases.filter(({ id }) => id !== 'proxy-500-html');
  expect(mutated.map(({ id }) => id)).not.toEqual(REQUIRED_CASE_IDS);
  expect(vectors.cases.map(({ id }) => id)).toEqual(REQUIRED_CASE_IDS);
});
