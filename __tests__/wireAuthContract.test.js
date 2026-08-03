const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  evaluateResolution,
  evaluateVector,
} = require('./helpers/wireAuthContract');

const ROOT = path.resolve(__dirname, '..');
const V1 = path.join(ROOT, 'spec/wire/v1');
const AUTH = path.join(V1, 'auth-contract.json');
const VECTORS = path.join(V1, 'auth-vectors.json');
const RESOLUTION = path.join(V1, 'resolution-table.json');

function load(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('publishes the three versioned A12/A13 contract artifacts', () => {
  expect(
    [AUTH, VECTORS, RESOLUTION].map((file) =>
      path.relative(ROOT, file).replaceAll(path.sep, '/')
    )
  ).toEqual([
    'spec/wire/v1/auth-contract.json',
    'spec/wire/v1/auth-vectors.json',
    'spec/wire/v1/resolution-table.json',
  ]);
  for (const file of [AUTH, VECTORS, RESOLUTION]) {
    expect(fs.existsSync(file)).toBe(true);
  }
});

test('pins the delivery-only capability scope and secret handling', () => {
  const contract = load(AUTH);
  expect(createHash('sha256').update(fs.readFileSync(AUTH)).digest('hex')).toBe(
    '50209450c1c742ca218b5b4e2fe1232888dc4764f1e3cab5e6c1a1198f75a38b'
  );
  expect(contract.contractVersion).toBe(1);
  expect(contract.scope).toEqual({
    comparison: 'exact',
    fields: [
      'tenantId',
      'analyticsStream',
      'installId',
      'subjectScope',
      'identityGeneration',
      'consentGeneration',
    ],
  });
  expect(contract.deliveryCapability.credentialId).toEqual({
    bits: 128,
    encoding: 'lowercase-hex',
    source: 'csprng',
  });
  expect(contract.deliveryCapability.bearerSecret).toEqual({
    bits: 256,
    encoding: 'base64url-no-padding',
    source: 'csprng',
  });
  expect(contract.deliveryCapability.presentation).toEqual({
    header: 'Authorization',
    scheme: 'NitroDelivery',
    transport: 'tls',
    urlsForbidden: true,
  });
  expect(contract.deliveryCapability.authority).toEqual([
    'exchange-self',
    'deliver-manifested-segment',
  ]);
  expect(contract.deliveryCapability.forbiddenAuthority).toEqual([
    'collect',
    'identify-or-bind',
    'manifest-register',
    'scope-change',
    'deadline-extension',
    'root-rotation',
  ]);
  expect(contract.deliveryCapability.serverStorage).toEqual({
    secret: 'verifier-only',
    comparison: 'constant-time',
    recoverableResponses: 'encrypted-at-rest',
  });
  expect(contract.deliveryCapability.deviceStorage).toBe(
    'secure-platform-storage'
  );
  expect(contract.deliveryCapability.rawCredentialLogging).toBe(false);
  expect(contract.namespaceRefusals).toEqual({
    publicReason: 'refused',
    internalReasonsAllowed: true,
    includes: [
      'credential',
      'tenant',
      'binding',
      'subject',
      'scope',
      'generation',
      'manifest',
      'deadline',
      'identity-conflict',
    ],
  });
  expect(contract.resourceControls).toEqual({
    beforeAuthentication: ['global', 'source-address'],
    afterAuthentication: ['credential', 'binding', 'tenant'],
    operations: [
      'capability-mint',
      'capability-exchange',
      'manifest-registration',
      'upload-acceptance',
    ],
    boundedConcurrency: true,
    publicThrottleIndistinguishable: true,
  });
  expect(contract.audit).toEqual({
    fields: [
      'timestamp',
      'operation',
      'internalResult',
      'authenticatedNamespaceHash',
      'credentialHash',
      'bindingHash',
      'segmentHash',
    ],
    forbiddenFields: [
      'bearerSecret',
      'payload',
      'rawSubjectId',
      'rawCredentialId',
    ],
    identifierHash: 'keyed',
    successAdmission: 'same-transaction-outbox',
    refusalAdmission: 'bounded-durable-wal',
    refusalOverflow: 'non-droppable-aggregate-loss-signal',
    idempotentlyKeyed: true,
    publication: 'durable-retry',
    authorizationOnAuditFailure: 'fail-closed',
  });
});

test('pins mint, exchange, and registration envelopes and retry semantics', () => {
  const operations = load(AUTH).operations;
  expect(Object.keys(operations)).toEqual([
    'capabilityMint',
    'capabilityExchange',
    'manifestRegister',
  ]);
  expect(operations.capabilityMint).toEqual({
    operation: 'capability-mint',
    request: {
      method: 'POST',
      path: '/v1/delivery-capabilities:mint',
      contentType: 'application/json',
      authorization: 'live-session-or-tenant-backend',
      idempotencyField: 'mintId',
      requiredFields: ['contractVersion', 'operation', 'mintId', 'scope'],
      forbiddenFields: [
        'credentialId',
        'bearerSecret',
        'issuedAt',
        'expiresAt',
        'deliveryDeadline',
      ],
    },
    response: {
      status: 201,
      requiredFields: [
        'contractVersion',
        'operation',
        'credentialId',
        'bearerSecret',
        'issuedAt',
        'expiresAt',
        'deliveryDeadline',
      ],
    },
    serverDerivedScope: true,
  });
  expect(operations.capabilityExchange).toEqual({
    operation: 'capability-exchange',
    request: {
      method: 'POST',
      path: '/v1/delivery-capabilities:exchange',
      contentType: 'application/json',
      authorization: 'delivery-capability',
      idempotencyField: 'exchangeId',
      requiredFields: ['contractVersion', 'operation', 'exchangeId'],
      forbiddenFields: ['scope', 'expiresAt', 'deliveryDeadline'],
    },
    response: {
      status: 200,
      requiredFields: [
        'contractVersion',
        'operation',
        'credentialId',
        'bearerSecret',
        'issuedAt',
        'expiresAt',
        'deliveryDeadline',
      ],
    },
  });
  expect(operations.manifestRegister).toEqual({
    operation: 'manifest-register',
    request: {
      method: 'POST',
      path: '/v1/segment-manifests',
      contentType: 'application/json',
      authorization: 'live-session',
      requiredFields: [
        'contractVersion',
        'operation',
        'segmentId',
        'contentHash',
        'scope',
      ],
      forbiddenFields: ['payload', 'acceptanceEpoch'],
    },
    response: {
      status: 201,
      idempotentStatus: 200,
      requiredFields: [
        'contractVersion',
        'operation',
        'segmentId',
        'contentHash',
      ],
    },
  });
  expect(load(AUTH).publicResponses).toEqual({
    success: { statusClass: '2xx', schemaRequired: true },
    refused: {
      status: 403,
      contentType: 'application/json',
      body: {
        requiredFields: ['contractVersion', 'operation', 'code'],
        additionalFields: false,
        contractVersion: 1,
        operation: 'echo-request-operation',
        code: 'refused',
      },
      retryable: false,
      indistinguishable: true,
      terminalOnlyWhenSchemaMatches: true,
      malformedClassification: 'indeterminate',
    },
    throttled: {
      status: 429,
      code: 'throttled',
      retryable: true,
      retryAfter: {
        encoding: 'delta-seconds',
        minimum: 1,
        maximum: 60,
        deadlineCapped: true,
        malformedIsIndeterminate: true,
      },
    },
    indeterminate: {
      cases: ['transport', '5xx', 'proxy-html', 'malformed-contract-response'],
      retryable: true,
      sameIdempotencyIdRequired: true,
    },
  });
  expect(load(AUTH).compatibility).toEqual({
    unknownContractVersion: 'refused',
    unknownOperation: 'refused',
    unknownRequestField: 'refused',
    additionalResponseField: 'malformed-contract-response',
  });
});

test('defines root mint replay, single-root, deadline, and generation rules', () => {
  const lifecycle = load(AUTH).lifecycle;
  expect(lifecycle.rootMint).toEqual({
    serverDerivedScope: true,
    oneActiveRootPerBindingGeneration: true,
    exactMintRetryReplaysResponse: true,
    differentMintIdRefused: true,
    rotationOperation: 'forbidden-in-v1',
    replacementRequiresNewBindingGeneration: true,
  });
  expect(lifecycle.exchange).toMatchObject({
    predecessorUse: 'once',
    exactRetryReplaysResponse: true,
    differentExchangeIdRefused: true,
    restoredPredecessorRefused: true,
    successorDeadline: 'unchanged-binding-delivery-deadline',
  });
  expect(lifecycle.overrides).toEqual([
    'tenant-disabled',
    'binding-disabled',
    'subject-deleted',
    'consent-revoked',
    'generation-changed',
    'delivery-deadline-reached',
  ]);
});

test('keeps the A13 manifest epoch-independent and exercise-not-spend', () => {
  const manifest = load(AUTH).segmentManifest;
  expect(manifest.key).toEqual([
    ...load(AUTH).scope.fields,
    'segmentId',
    'contentHash',
  ]);
  expect(manifest.payloadStored).toBe(false);
  expect(manifest.acceptanceEpochIndependent).toBe(true);
  expect(manifest.registrationAuthorization).toBe('live-session');
  expect(manifest.scopeDerivation).toBe('server');
  expect(manifest.deliveryCapabilityMayRegister).toBe(false);
  expect(manifest.uploadSemantics).toBe('exercise-not-spend');
  expect(manifest.sameIdSameHash).toBe('idempotent');
  expect(manifest.sameIdDifferentHash).toBe('refused');
});

test('publishes exhaustive auth vectors without copying resolution rows', () => {
  const contract = load(AUTH);
  const vectors = load(VECTORS);
  expect(vectors.contractVersion).toBe(1);
  expect(Object.keys(vectors.vectorSets)).toEqual([
    'scope',
    'mint',
    'exchange',
    'registration',
    'responses',
    'resourceControls',
    'audit',
    'lifecycleRaces',
    'crashRecovery',
  ]);
  for (const [name, rows] of Object.entries(vectors.vectorSets)) {
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row).toHaveProperty('expected');
      expect(row).not.toHaveProperty('resolutionSteps');
      expect(evaluateVector(contract, name, row)).toBe(row.expected);
    }
  }
  expect(vectors.resolutionRowRefs).toEqual(
    load(RESOLUTION).resolutionRows.map((row) => row.id)
  );
  const table = load(RESOLUTION);
  const expectedRaces = table.linearizedMutations.flatMap((mutation) =>
    table.lifecycleTransitions.flatMap((transition) =>
      ['mutation', 'transition'].map(
        (winner) => `${mutation}|${transition}|${winner}`
      )
    )
  );
  expect(
    vectors.vectorSets.lifecycleRaces.map(
      ({ input }) => `${input.mutation}|${input.transition}|${input.winner}`
    )
  ).toEqual(expectedRaces);

  const missingScope = clone(vectors.vectorSets.scope[0]);
  delete missingScope.input.presented.tenantId;
  expect(evaluateVector(contract, 'scope', missingScope)).toBe('refuse');
  const malformedRace = clone(vectors.vectorSets.lifecycleRaces[0]);
  malformedRace.input.transition = 'unknown-transition';
  expect(evaluateVector(contract, 'lifecycleRaces', malformedRace)).toBe(
    'invalid-vector'
  );
  const malformedCrash = clone(vectors.vectorSets.crashRecovery[1]);
  delete malformedCrash.input.sameMintIdRetry;
  expect(evaluateVector(contract, 'crashRecovery', malformedCrash)).toBe(
    'invalid-vector'
  );
});

test('pins gateway resolution order and immutable ledger replay', () => {
  const table = load(RESOLUTION);
  expect(table.contractVersion).toBe(1);
  expect(table.evaluationOrder).toEqual([
    'validate-credential-and-scope',
    'consult-current-epoch-ledger',
    'resolve-immutable-ledger-outcome',
    'require-live-binding-and-manifest',
    'commit-inbox-ledger-audit',
  ]);
  expect(table.resolutionRows.map((row) => row.id)).toEqual([
    'credential-or-scope-invalid',
    'ledger-same-id-same-hash',
    'ledger-same-id-different-hash',
    'no-ledger-binding-inactive',
    'no-ledger-manifest-missing',
    'no-ledger-live-manifest-match',
    'post-rebuild-deleted-binding',
  ]);
  const replay = table.resolutionRows.find(
    (row) => row.id === 'ledger-same-id-same-hash'
  );
  expect(replay.expected).toEqual({
    action: 'replay-recorded-outcome',
    inboxInsert: false,
    projection: false,
    bindingRequired: false,
    manifestRequired: false,
  });
  for (const row of table.resolutionRows) {
    expect(evaluateResolution(row.when)).toBe(row.expected.action);
  }
});

test('pins transaction, lifecycle race, and durable audit boundaries', () => {
  const table = load(RESOLUTION);
  expect(table.transactionRows.map((row) => row.id)).toEqual([
    'manifest-registration',
    'acceptance-inbox-ledger-audit',
    'acknowledgement-emission',
    'audit-publication',
  ]);
  expect(table.transactionRows).toEqual([
    {
      id: 'manifest-registration',
      state: ['exact-manifest-record', 'success-audit-intent'],
      commit: 'atomic-before-or-with-acceptance',
      responseAfter: 'durable-commit',
    },
    {
      id: 'acceptance-inbox-ledger-audit',
      state: [
        'inbox-bytes',
        'same-epoch-ledger-outcome',
        'success-audit-intent',
      ],
      commit: 'single-acceptance-boundary',
      responseAfter: 'durable-commit',
    },
    {
      id: 'acknowledgement-emission',
      state: [],
      commit: 'none',
      requires: [
        'durable-inbox',
        'durable-ledger-outcome',
        'durable-audit-intent',
      ],
      lostResponse: 'replay-ledger-outcome',
    },
    {
      id: 'audit-publication',
      state: ['published-audit-event'],
      commit: 'idempotent-outbox-delivery',
      requires: ['durable-audit-intent'],
      outage: 'queue-and-retry',
    },
  ]);
  expect(table.linearizedMutations).toEqual([
    'capability-mint',
    'capability-exchange',
    'manifest-registration',
    'upload-acceptance',
  ]);
  expect(table.lifecycleTransitions).toEqual([
    'subject-deletion',
    'consent-revocation',
    'tenant-or-binding-disable',
    'generation-change',
    'delivery-deadline',
  ]);
  expect(table.audit.success).toMatchObject({
    admission: 'same-transaction-outbox',
    idempotentlyKeyed: true,
    responseRequiresDurableIntent: true,
  });
  expect(table.audit.refusal).toMatchObject({
    authorization: 'fail-closed',
    admission: 'bounded-durable-wal',
    overflow: 'non-droppable-aggregate-loss-signal',
    publicResponseUnchanged: true,
  });
  const wire = fs.readFileSync(path.join(ROOT, 'docs/WIRE.md'), 'utf8');
  expect(wire).not.toMatch(/\|\s*undefined\s*\|/);
  expect(wire).toContain('lost response: `replay-ledger-outcome`');
});
