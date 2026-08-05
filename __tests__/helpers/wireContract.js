/* global BigInt, Buffer, TextDecoder */
/* eslint-disable no-bitwise */

const { createHash } = require('node:crypto');

const HASH_BYTES = 32;

function parseUnsigned(value, bits, name) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) {
    throw new Error(`${name} is not a canonical unsigned decimal`);
  }
  const parsed = BigInt(value);
  const maximum = (1n << BigInt(bits)) - 1n;
  if (parsed > maximum) {
    throw new Error(`${name} exceeds u${bits}`);
  }
  return parsed;
}

function unsignedBytes(value, bits, name) {
  const parsed = parseUnsigned(value, bits, name);
  const out = Buffer.alloc(bits / 8);
  if (bits === 16) out.writeUInt16BE(Number(parsed));
  else if (bits === 32) out.writeUInt32BE(Number(parsed));
  else if (bits === 64) out.writeBigUInt64BE(parsed);
  else throw new Error(`unsupported integer width ${bits}`);
  return out;
}

function identifierBytes(value, descriptor, name) {
  const bytes = Buffer.from(value, 'utf8');
  const rule = descriptor.identifiers;
  if (
    bytes.length === 0 ||
    bytes.length > rule.maxBytes ||
    !new RegExp(rule.pattern).test(value) ||
    [...value].some((character) => character.codePointAt(0) > 0x7f)
  ) {
    throw new Error(`${name} violates the v1 identifier grammar`);
  }
  return Buffer.concat([
    unsignedBytes(bytes.length, 16, `${name}Length`),
    bytes,
  ]);
}

function headerParts(descriptor, fields, hash) {
  return [
    Buffer.from(descriptor.header.magicHex, 'hex'),
    unsignedBytes(descriptor.header.version, 16, 'headerVersion'),
    Buffer.alloc(4),
    Buffer.from(fields.segmentIdHex, 'hex'),
    hash,
    identifierBytes(fields.tenantId, descriptor, 'tenantId'),
    identifierBytes(fields.streamId, descriptor, 'streamId'),
    identifierBytes(fields.sourceEpoch, descriptor, 'sourceEpoch'),
    unsignedBytes(fields.schemaVersion, 32, 'schemaVersion'),
    unsignedBytes(fields.consentGeneration, 64, 'consentGeneration'),
    unsignedBytes(fields.recordCount, 32, 'recordCount'),
    unsignedBytes(fields.payloadLength, 64, 'payloadLength'),
  ];
}

function serializeHeader(descriptor, fields, payload) {
  if (!/^[0-9a-f]{32}$/.test(fields.segmentIdHex)) {
    throw new Error('segmentIdHex must be 16 lowercase bytes');
  }
  const zeroParts = headerParts(descriptor, fields, Buffer.alloc(HASH_BYTES));
  const headerLength = zeroParts.reduce((sum, part) => sum + part.length, 0);
  zeroParts[2] = unsignedBytes(headerLength, 32, 'headerLength');
  const zeroHeader = Buffer.concat(zeroParts);
  const hash = createHash('sha256').update(zeroHeader).update(payload).digest();
  const finalParts = headerParts(descriptor, fields, hash);
  finalParts[2] = unsignedBytes(headerLength, 32, 'headerLength');
  return { header: Buffer.concat(finalParts), zeroHeader, hash };
}

function parseV1Header(descriptor, header) {
  const magic = Buffer.from(descriptor.header.magicHex, 'hex');
  let cursor = magic.length + 2 + 4 + 16 + HASH_BYTES;
  const identifiers = [];
  for (let index = 0; index < 3; index += 1) {
    if (cursor + 2 > header.length) return null;
    const length = header.readUInt16BE(cursor);
    cursor += 2;
    if (length === 0 || length > descriptor.identifiers.maxBytes) return null;
    if (cursor + length > header.length) return null;
    const bytes = header.subarray(cursor, cursor + length);
    if (!identifierRawValid(descriptor, bytes)) return null;
    identifiers.push(bytes);
    cursor += length;
  }
  if (cursor + 4 + 8 + 4 + 8 !== header.length) return null;
  const schemaVersion = header.readUInt32BE(cursor);
  cursor += 4;
  const consentGeneration = header.readBigUInt64BE(cursor);
  cursor += 8;
  const recordCount = header.readUInt32BE(cursor);
  cursor += 4;
  const payloadLength = header.readBigUInt64BE(cursor);
  cursor += 8;
  if (cursor !== header.length) return null;
  return {
    identifiers,
    schemaVersion,
    consentGeneration,
    recordCount,
    payloadLength,
  };
}

function payloadRecordCount(payload) {
  try {
    const request = JSON.parse(payload.toString('utf8'));
    const resources = request.resourceLogs ?? [];
    if (!Array.isArray(resources)) return null;
    let count = 0;
    for (const resource of resources) {
      if (!resource || typeof resource !== 'object' || Array.isArray(resource))
        return null;
      const scopes = resource.scopeLogs ?? [];
      if (!Array.isArray(scopes)) return null;
      for (const scope of scopes) {
        if (!scope || typeof scope !== 'object' || Array.isArray(scope))
          return null;
        const records = scope.logRecords ?? [];
        if (!Array.isArray(records)) return null;
        count += records.length;
      }
    }
    return count;
  } catch {
    return null;
  }
}

function classifySegment(descriptor, header, payload) {
  const magic = Buffer.from(descriptor.header.magicHex, 'hex');
  if (
    header.length < magic.length + 2 ||
    !header.subarray(0, magic.length).equals(magic)
  ) {
    return 'malformed';
  }
  const version = header.readUInt16BE(magic.length);
  if (version !== descriptor.header.version) return 'unsupportedHeaderVersion';
  if (header.length < magic.length + 6) return 'malformed';
  const declaredLength = header.readUInt32BE(magic.length + 2);
  if (declaredLength !== header.length) return 'malformed';
  const hashOffset = magic.length + 2 + 4 + 16;
  if (header.length < hashOffset + HASH_BYTES) return 'malformed';
  const parsed = parseV1Header(descriptor, header);
  if (!parsed || parsed.payloadLength !== BigInt(payload.length))
    return 'malformed';
  const persisted = header.subarray(hashOffset, hashOffset + HASH_BYTES);
  const zeroHeader = Buffer.from(header);
  zeroHeader.fill(0, hashOffset, hashOffset + HASH_BYTES);
  const actual = createHash('sha256')
    .update(zeroHeader)
    .update(payload)
    .digest();
  if (!persisted.equals(actual)) return 'contentHashMismatch';
  const records = payloadRecordCount(payload);
  return records !== null && parsed.recordCount === records
    ? 'valid'
    : 'malformed';
}

function decimalInRange(value, signed, bits) {
  if (!/^-?(0|[1-9][0-9]*)$/.test(String(value)) || String(value) === '-0')
    return false;
  const parsed = BigInt(value);
  if (signed) {
    const half = 1n << BigInt(bits - 1);
    return parsed >= -half && parsed <= half - 1n;
  }
  return parsed >= 0n && parsed <= (1n << BigInt(bits)) - 1n;
}

function unknownFields(descriptor, message, json) {
  const value = JSON.parse(json);
  const allowed = new Set(descriptor.otlp.messages[message]);
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort();
}

function walkOtlp(descriptor, message, value, path, onUnknown, copy) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const allowed = new Set(descriptor.otlp.messages[message]);
  const children = descriptor.otlp.children[message] ?? {};
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (!allowed.has(key)) {
      onUnknown(`${path}.${key}`);
      continue;
    }
    const relation = children[key];
    if (relation && relation.repeated && Array.isArray(child)) {
      result[key] = child.map((entry, index) =>
        walkOtlp(
          descriptor,
          relation.message,
          entry,
          `${path}.${key}[${index}]`,
          onUnknown,
          copy
        )
      );
    } else if (relation && !relation.repeated) {
      result[key] = walkOtlp(
        descriptor,
        relation.message,
        child,
        `${path}.${key}`,
        onUnknown,
        copy
      );
    } else {
      result[key] = child;
    }
  }
  return copy ? result : value;
}

function strictUnknownPaths(descriptor, request) {
  const paths = [];
  walkOtlp(
    descriptor,
    'ExportLogsServiceRequest',
    request,
    '$',
    (path) => paths.push(path),
    false
  );
  return paths.sort();
}

function baseDecode(descriptor, request) {
  return walkOtlp(
    descriptor,
    'ExportLogsServiceRequest',
    request,
    '$',
    () => {},
    true
  );
}

function identifierRawValid(descriptor, raw) {
  if (raw.length === 0 || raw.length > descriptor.identifiers.maxBytes)
    return false;
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return false;
  }
  return (
    Buffer.byteLength(decoded, 'utf8') === raw.length &&
    [...decoded].every((character) => character.codePointAt(0) <= 0x7f) &&
    new RegExp(descriptor.identifiers.pattern).test(decoded)
  );
}

function anyValueValid(descriptor, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const arms = descriptor.otlp.anyValueArms.filter((arm) =>
    Object.prototype.hasOwnProperty.call(value, arm)
  );
  if (arms.length !== 1 || Object.keys(value).length !== 1) return false;
  const arm = arms[0];
  const payload = value[arm];
  if (arm === 'stringValue') return typeof payload === 'string';
  if (arm === 'boolValue') return typeof payload === 'boolean';
  if (arm === 'intValue')
    return typeof payload === 'string' && decimalInRange(payload, true, 64);
  if (arm === 'doubleValue')
    return typeof payload === 'number' && Number.isFinite(payload);
  if (arm === 'bytesValue') {
    return (
      typeof payload === 'string' &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        payload
      ) &&
      Buffer.from(payload, 'base64').toString('base64') === payload
    );
  }
  if (arm === 'arrayValue') {
    return (
      payload &&
      typeof payload === 'object' &&
      Object.keys(payload).length === 1 &&
      Array.isArray(payload.values) &&
      payload.values.every((entry) => anyValueValid(descriptor, entry))
    );
  }
  if (arm === 'kvlistValue') {
    if (
      !payload ||
      typeof payload !== 'object' ||
      Object.keys(payload).length !== 1 ||
      !Array.isArray(payload.values)
    ) {
      return false;
    }
    const keys = new Set();
    return payload.values.every((entry) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        Object.keys(entry).sort().join(',') !== 'key,value' ||
        typeof entry.key !== 'string' ||
        keys.has(entry.key) ||
        !anyValueValid(descriptor, entry.value)
      ) {
        return false;
      }
      keys.add(entry.key);
      return true;
    });
  }
  return false;
}

function hasNoDuplicateKeys(json) {
  let cursor = 0;
  const whitespace = () => {
    while (/\s/.test(json[cursor] ?? '')) cursor += 1;
  };
  const stringToken = () => {
    const start = cursor;
    if (json[cursor] !== '"') throw new Error('expected string');
    cursor += 1;
    while (cursor < json.length) {
      if (json[cursor] === '\\') cursor += 2;
      else if (json[cursor++] === '"')
        return JSON.parse(json.slice(start, cursor));
    }
    throw new Error('unterminated string');
  };
  const value = () => {
    whitespace();
    if (json[cursor] === '{') {
      cursor += 1;
      whitespace();
      const keys = new Set();
      if (json[cursor] === '}') {
        cursor += 1;
        return true;
      }
      while (cursor < json.length) {
        const key = stringToken();
        if (keys.has(key)) return false;
        keys.add(key);
        whitespace();
        if (json[cursor++] !== ':') throw new Error('expected colon');
        if (!value()) return false;
        whitespace();
        const separator = json[cursor++];
        if (separator === '}') return true;
        if (separator !== ',') throw new Error('expected object separator');
        whitespace();
      }
      throw new Error('unterminated object');
    }
    if (json[cursor] === '[') {
      cursor += 1;
      whitespace();
      if (json[cursor] === ']') {
        cursor += 1;
        return true;
      }
      while (cursor < json.length) {
        if (!value()) return false;
        whitespace();
        const separator = json[cursor++];
        if (separator === ']') return true;
        if (separator !== ',') throw new Error('expected array separator');
      }
      throw new Error('unterminated array');
    }
    if (json[cursor] === '"') {
      stringToken();
      return true;
    }
    const start = cursor;
    while (cursor < json.length && !/[\s,}\]]/.test(json[cursor])) cursor += 1;
    JSON.parse(json.slice(start, cursor));
    return true;
  };
  try {
    const valid = value();
    whitespace();
    return valid && cursor === json.length;
  } catch {
    return false;
  }
}

function otlpSemanticCaseValid(descriptor, vector) {
  if (vector.kind === 'duplicateKey') {
    return hasNoDuplicateKeys(vector.json);
  }
  const value = JSON.parse(vector.json);
  if (
    vector.kind === 'timeUnixNano' ||
    vector.kind === 'observedTimeUnixNano'
  ) {
    const field = vector.kind;
    return (
      typeof value[field] === 'string' &&
      decimalInRange(value[field], false, 64)
    );
  }
  if (vector.kind === 'u32') {
    const number = value[vector.field];
    return Number.isInteger(number) && number >= 0 && number <= 4294967295;
  }
  if (vector.kind === 'severityNumber') {
    return (
      Number.isInteger(value.severityNumber) &&
      value.severityNumber >= descriptor.otlp.severityNumber.minimum &&
      value.severityNumber <= descriptor.otlp.severityNumber.maximum
    );
  }
  if (vector.kind === 'AnyValue') return anyValueValid(descriptor, value);
  return false;
}

module.exports = {
  baseDecode,
  classifySegment,
  decimalInRange,
  hasNoDuplicateKeys,
  identifierRawValid,
  otlpSemanticCaseValid,
  serializeHeader,
  strictUnknownPaths,
  unknownFields,
};
