#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const descriptor = JSON.parse(
  fs.readFileSync(path.join(root, 'spec/wire/v1/contract.json'), 'utf8')
);
const documentPath = path.join(root, 'docs/WIRE.md');

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
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
      'FAIL: docs/WIRE.md generated blocks do not match contract.json'
    );
    process.exit(1);
  }
  console.log('ok:   docs/WIRE.md generated blocks match contract.json');
} else {
  const temporary = `${documentPath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, document, { flag: 'wx' });
    fs.renameSync(temporary, documentPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
