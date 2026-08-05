'use strict';

const { TextEncoder: Utf8Encoder } = require('util');

const stringifyJSON = JSON.stringify;
const ownKeys = Reflect.ownKeys;
const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const hasOwnProperty = Object.prototype.hasOwnProperty;
const functionToString = Function.prototype.toString;
const utf8Encoder = new Utf8Encoder();

const ARTIFACT = 'react-native-nitro-logger/analytics-grammar';
const STRUCTURAL_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const LIMITS = Object.freeze({
  maxEvents: 256,
  maxProperties: 2048,
  maxMemberReferences: 16_384,
  maxJSONBytes: 1024 * 1024,
  maxMemberBytes: 256,
});

function invalid() {
  throw new TypeError('INVALID_EVENT_LINT_ARTIFACT');
}

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return true;
  if (getPrototypeOf(prototype) !== null) return false;
  const constructor = getOwnPropertyDescriptor(prototype, 'constructor');
  return (
    !!constructor &&
    'value' in constructor &&
    typeof constructor.value === 'function' &&
    functionToString.call(constructor.value) ===
      'function Object() { [native code] }'
  );
}

function plainArray(value) {
  if (!Array.isArray(value)) return false;
  const prototype = getPrototypeOf(value);
  if (prototype === Array.prototype) return true;
  if (!prototype) return false;
  const objectPrototype = getPrototypeOf(prototype);
  if (!objectPrototype || getPrototypeOf(objectPrototype) !== null)
    return false;
  const constructor = getOwnPropertyDescriptor(prototype, 'constructor');
  return (
    !!constructor &&
    'value' in constructor &&
    typeof constructor.value === 'function' &&
    functionToString.call(constructor.value) ===
      'function Array() { [native code] }'
  );
}

function dataValue(recordValue, key) {
  if (!plainRecord(recordValue)) invalid();
  const descriptor = getOwnPropertyDescriptor(recordValue, key);
  if (!descriptor || !('value' in descriptor)) invalid();
  return descriptor.value;
}

function exactRecord(recordValue, fields) {
  if (!plainRecord(recordValue)) invalid();
  const keys = ownKeys(recordValue);
  if (keys.length !== fields.length) invalid();
  for (const key of keys) {
    if (typeof key !== 'string') invalid();
    let known = false;
    for (let index = 0; index < fields.length; index += 1) {
      if (fields[index] === key) known = true;
    }
    if (!known) invalid();
  }
}

function denseArray(value, maximum) {
  if (!plainArray(value) || value.length > maximum) invalid();
  const copied = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) invalid();
    copied[index] = descriptor.value;
  }
  for (const key of ownKeys(value)) {
    if (key === 'length' || key === 'toJSON') continue;
    if (
      typeof key !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(key) ||
      Number(key) >= value.length
    ) {
      invalid();
    }
  }
  return copied;
}

function protectedArray(values) {
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    result[index] = values[index];
  }
  Object.defineProperty(result, 'toJSON', {
    configurable: false,
    enumerable: false,
    value: null,
    writable: false,
  });
  return Object.freeze(result);
}

function record(fields) {
  const result = Object.create(null);
  for (const [key, value] of fields) result[key] = value;
  return Object.freeze(result);
}

function wellFormed(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function member(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !wellFormed(value) ||
    utf8Encoder.encode(value).length > LIMITS.maxMemberBytes
  ) {
    invalid();
  }
  return value;
}

function structuralName(value) {
  if (typeof value !== 'string' || !STRUCTURAL_NAME.test(value)) invalid();
  return value;
}

function stringMembers(value, counts) {
  const values = denseArray(value, LIMITS.maxMemberReferences);
  if (values.length === 0) invalid();
  counts.members += values.length;
  if (counts.members > LIMITS.maxMemberReferences) invalid();
  const copied = [];
  const unique = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const valueAtIndex = member(values[index]);
    if (unique.has(valueAtIndex)) invalid();
    unique.add(valueAtIndex);
    copied[index] = valueAtIndex;
  }
  return protectedArray(copied);
}

function snapshotConstraint(value, counts) {
  if (!plainRecord(value)) invalid();
  const type = dataValue(value, 'type');
  if (type === 'enum') {
    exactRecord(value, ['type', 'values']);
    return record([
      ['type', 'enum'],
      ['values', stringMembers(dataValue(value, 'values'), counts)],
    ]);
  }
  if (type === 'named-string') {
    exactRecord(value, ['type', 'registry', 'values']);
    return record([
      ['type', 'named-string'],
      ['registry', structuralName(dataValue(value, 'registry'))],
      ['values', stringMembers(dataValue(value, 'values'), counts)],
    ]);
  }
  if (type === 'integer') {
    exactRecord(value, ['type', 'minimum', 'maximum']);
    const minimum = dataValue(value, 'minimum');
    const maximum = dataValue(value, 'maximum');
    if (
      !Number.isSafeInteger(minimum) ||
      !Number.isSafeInteger(maximum) ||
      minimum > maximum
    ) {
      invalid();
    }
    return record([
      ['type', 'integer'],
      ['minimum', minimum],
      ['maximum', maximum],
    ]);
  }
  invalid();
}

function snapshotProperty(value, counts, names) {
  exactRecord(value, ['name', 'required', 'constraint']);
  const name = structuralName(dataValue(value, 'name'));
  if (names.has(name)) invalid();
  names.add(name);
  const required = dataValue(value, 'required');
  if (typeof required !== 'boolean') invalid();
  counts.properties += 1;
  if (counts.properties > LIMITS.maxProperties) invalid();
  return record([
    ['name', name],
    ['required', required],
    ['constraint', snapshotConstraint(dataValue(value, 'constraint'), counts)],
  ]);
}

function snapshotEvent(value, counts, names) {
  exactRecord(value, ['name', 'additionalProperties', 'properties']);
  const name = structuralName(dataValue(value, 'name'));
  if (names.has(name)) invalid();
  names.add(name);
  if (dataValue(value, 'additionalProperties') !== false) invalid();
  const properties = denseArray(
    dataValue(value, 'properties'),
    LIMITS.maxProperties
  );
  const propertyNames = new Set();
  const copied = [];
  for (let index = 0; index < properties.length; index += 1) {
    copied[index] = snapshotProperty(properties[index], counts, propertyNames);
  }
  return record([
    ['name', name],
    ['additionalProperties', false],
    ['properties', protectedArray(copied)],
  ]);
}

function doSnapshotLintArtifact(value) {
  exactRecord(value, ['formatVersion', 'grammar']);
  if (dataValue(value, 'formatVersion') !== 1) invalid();
  const grammar = dataValue(value, 'grammar');
  exactRecord(grammar, [
    'artifact',
    'formatVersion',
    'additionalEvents',
    'events',
  ]);
  if (
    dataValue(grammar, 'artifact') !== ARTIFACT ||
    dataValue(grammar, 'formatVersion') !== 1 ||
    dataValue(grammar, 'additionalEvents') !== false
  ) {
    invalid();
  }

  const events = denseArray(dataValue(grammar, 'events'), LIMITS.maxEvents);
  if (events.length === 0) invalid();
  const counts = { properties: 0, members: 0 };
  const eventNames = new Set();
  const copiedEvents = [];
  for (let index = 0; index < events.length; index += 1) {
    copiedEvents[index] = snapshotEvent(events[index], counts, eventNames);
  }
  const copiedGrammar = record([
    ['artifact', ARTIFACT],
    ['formatVersion', 1],
    ['additionalEvents', false],
    ['events', protectedArray(copiedEvents)],
  ]);
  const serialized = stringifyJSON(copiedGrammar);
  if (
    typeof serialized !== 'string' ||
    utf8Encoder.encode(serialized).length > LIMITS.maxJSONBytes
  ) {
    invalid();
  }
  return Object.freeze({ formatVersion: 1, grammar: copiedGrammar });
}

function snapshotLintArtifact(value) {
  try {
    return doSnapshotLintArtifact(value);
  } catch {
    invalid();
  }
}

function hasOwn(recordValue, key) {
  return hasOwnProperty.call(recordValue, key);
}

function compileConstraint(constraint) {
  if (constraint.type === 'integer') return constraint;

  const members = Object.create(null);
  for (const value of constraint.values) members[value] = true;
  const fields = [
    ['type', constraint.type],
    ['members', Object.freeze(members)],
  ];
  if (constraint.type === 'named-string') {
    fields.splice(1, 0, ['registry', constraint.registry]);
  }
  return record(fields);
}

function compileProperty(property) {
  return record([
    ['name', property.name],
    ['required', property.required],
    ['constraint', compileConstraint(property.constraint)],
  ]);
}

const compiledArtifacts = new WeakMap();

function compileLintArtifact(value) {
  if (value === null || typeof value !== 'object') invalid();
  const cached = compiledArtifacts.get(value);
  if (cached) return cached;

  const snapshot = snapshotLintArtifact(value);
  const events = Object.create(null);
  for (const grammarEvent of snapshot.grammar.events) {
    const propertiesByName = Object.create(null);
    for (const property of grammarEvent.properties) {
      propertiesByName[property.name] = compileProperty(property);
    }
    events[grammarEvent.name] = Object.freeze({
      grammarEvent,
      propertiesByName: Object.freeze(propertiesByName),
    });
  }
  const compiled = Object.freeze({
    artifact: snapshot,
    events: Object.freeze(events),
  });
  compiledArtifacts.set(value, compiled);
  compiledArtifacts.set(snapshot, compiled);
  return compiled;
}

module.exports = {
  LIMITS,
  compileLintArtifact,
  hasOwn,
  snapshotLintArtifact,
};
