#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const descriptor = JSON.parse(
  fs.readFileSync(path.join(root, 'spec/wire/v1/contract.json'), 'utf8')
);
const auth = JSON.parse(
  fs.readFileSync(path.join(root, 'spec/wire/v1/auth-contract.json'), 'utf8')
);
const resolution = JSON.parse(
  fs.readFileSync(path.join(root, 'spec/wire/v1/resolution-table.json'), 'utf8')
);
const envelope = JSON.parse(
  fs.readFileSync(
    path.join(root, 'spec/wire/v1/envelope-contract.json'),
    'utf8'
  )
);
const envelopeVectors = JSON.parse(
  fs.readFileSync(path.join(root, 'spec/wire/v1/envelope-vectors.json'), 'utf8')
);
const documentPath = path.join(root, 'docs/WIRE.md');

function table(headers, rows) {
  for (const row of rows) {
    if (
      row.length !== headers.length ||
      row.some(
        (cell) =>
          cell === undefined ||
          cell === null ||
          String(cell).includes('undefined')
      )
    ) {
      throw new Error(
        `generated table ${headers.join('/')} has an invalid cell`
      );
    }
  }
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function transactionResult(row) {
  if (row.responseAfter) return `response after \`${row.responseAfter}\``;
  if (row.outage) return `outage: \`${row.outage}\``;
  if (row.lostResponse && row.requires) {
    return `requires ${row.requires.map((value) => `\`${value}\``).join(', ')}; lost response: \`${row.lostResponse}\``;
  }
  throw new Error(`transaction row ${row.id} has no response or outage rule`);
}

const generated = {
  'contract-pin': table(
    ['Item', 'Pinned value'],
    [
      ['Contract version', String(descriptor.contractVersion)],
      ['Header version', String(descriptor.header.version)],
      [
        'OpenTelemetry Protocol specification',
        descriptor.upstream.otlpSpecification,
      ],
      [
        'OpenTelemetry protobuf definitions',
        descriptor.upstream.protobufDefinitions,
      ],
      ['Byte order', descriptor.header.byteOrder],
      ['Digest', descriptor.header.hash.toUpperCase()],
    ]
  ),
  'header-layout': table(
    ['Order', 'Field', 'Encoding', 'Size / bound', 'Hash rule'],
    descriptor.header.fields.map((field, index) => [
      String(index),
      `\`${field.name}\``,
      `\`${field.encoding}\`${field.lengthPrefix ? ` + \`${field.lengthPrefix}\` length` : ''}`,
      field.bytes ? `${field.bytes} bytes` : `1–${field.maxBytes} bytes`,
      field.zeroWhenHashing
        ? '32 zero bytes while hashing'
        : 'exact persisted bytes',
    ])
  ),
  'otlp-inventory': table(
    ['Message', 'Allowed v1 fields'],
    Object.entries(descriptor.otlp.messages).map(([message, fields]) => [
      `\`${message}\``,
      fields.map((field) => `\`${field}\``).join(', '),
    ])
  ),
  'auth-scope': table(
    ['Order', 'Scope field', 'Comparison'],
    auth.scope.fields.map((field, index) => [
      String(index),
      `\`${field}\``,
      auth.scope.comparison,
    ])
  ),
  'auth-operations': table(
    ['Operation', 'Method and path', 'Authority', 'Idempotency'],
    Object.values(auth.operations).map(({ operation, request }) => [
      `\`${operation}\``,
      `\`${request.method} ${request.path}\``,
      `\`${request.authorization}\``,
      request.idempotencyField
        ? `\`${request.idempotencyField}\``
        : 'exact manifest key',
    ])
  ),
  'manifest-contract': table(
    ['Property', 'Pinned value'],
    [
      [
        'Key',
        auth.segmentManifest.key.map((field) => `\`${field}\``).join(', '),
      ],
      ['Payload stored', String(auth.segmentManifest.payloadStored)],
      [
        'Acceptance-epoch independent',
        String(auth.segmentManifest.acceptanceEpochIndependent),
      ],
      [
        'Registration authority',
        `\`${auth.segmentManifest.registrationAuthorization}\``,
      ],
      ['Upload semantics', `\`${auth.segmentManifest.uploadSemantics}\``],
      ['Same ID / same hash', `\`${auth.segmentManifest.sameIdSameHash}\``],
      [
        'Same ID / different hash',
        `\`${auth.segmentManifest.sameIdDifferentHash}\``,
      ],
    ]
  ),
  'gateway-resolution': table(
    ['Order', 'Row', 'When', 'Result'],
    resolution.resolutionRows.map((row, index) => [
      String(index),
      `\`${row.id}\``,
      Object.entries(row.when)
        .map(([key, value]) => `\`${key}=${value}\``)
        .join(', '),
      `\`${row.expected.action}\``,
    ])
  ),
  'transaction-boundaries': table(
    ['Boundary', 'Atomic state', 'Commit rule', 'Response / outage rule'],
    resolution.transactionRows.map((row) => [
      `\`${row.id}\``,
      row.state.length
        ? row.state.map((value) => `\`${value}\``).join(', ')
        : 'none',
      `\`${row.commit}\``,
      transactionResult(row),
    ])
  ),
  'lifecycle-boundary': table(
    ['Item', 'Pinned values'],
    [
      [
        'Linearized mutations',
        resolution.linearizedMutations
          .map((value) => `\`${value}\``)
          .join(', '),
      ],
      [
        'Lifecycle transitions',
        resolution.lifecycleTransitions
          .map((value) => `\`${value}\``)
          .join(', '),
      ],
      ['Mutation wins', `\`${resolution.linearization.mutationWins}\``],
      ['Transition wins', `\`${resolution.linearization.transitionWins}\``],
      [
        'Ledger replay exception',
        `\`${resolution.linearization.ledgerReplayException}\``,
      ],
    ]
  ),
  'ack-envelope': table(
    ['Property', 'Pinned value'],
    [
      ['HTTP status', String(envelope.response.httpStatus)],
      ['Content-Type', envelope.response.contentType],
      ['Cache-Control', envelope.response.cacheControl],
      ['Maximum response body', `${envelope.response.maximumBodyBytes} bytes`],
      ['Version', envelope.response.version],
      ['Field order', envelope.response.fields.join(', ')],
      ['Accepted action', envelope.response.outcomes.accepted.clientAction],
      ['Rejected action', envelope.response.outcomes.rejected.clientAction],
      ['Fallback', envelope.nonterminalDefault],
    ]
  ),
  'ack-response-matrix': table(
    ['Case', 'Terminal', 'Client action', 'Does not prove'],
    envelopeVectors.cases.map((vector) => [
      vector.id,
      String(vector.expected.terminal),
      vector.expected.action,
      vector.doesNotProve,
    ])
  ),
};

function replaceBlock(document, name, body) {
  const begin = `<!-- BEGIN GENERATED:${name} -->`;
  const end = `<!-- END GENERATED:${name} -->`;
  const start = document.indexOf(begin);
  const finish = document.indexOf(end);
  if (start < 0 || finish < 0 || finish < start) {
    throw new Error(`docs/WIRE.md has no well-formed ${name} generated block`);
  }
  return `${document.slice(0, start + begin.length)}\n${body}\n${document.slice(finish)}`;
}

let document = fs.readFileSync(documentPath, 'utf8');
for (const [name, body] of Object.entries(generated)) {
  document = replaceBlock(document, name, body);
}

if (process.argv.includes('--check')) {
  const current = fs.readFileSync(documentPath, 'utf8');
  if (current !== document) {
    console.error(
      'FAIL: docs/WIRE.md generated blocks do not match v1 contract artifacts'
    );
    process.exit(1);
  }
  console.log(
    'ok:   docs/WIRE.md generated blocks match v1 contract artifacts'
  );
} else {
  const temporary = `${documentPath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, document, { flag: 'wx' });
    fs.renameSync(temporary, documentPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
