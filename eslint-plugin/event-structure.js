'use strict';

const {
  resolveObjectLiteral,
  resolveVariable,
  staticStringValue,
  unwrap,
} = require('./shared');
const { hasOwn } = require('./event-artifact');
const { immutableInit } = require('./event-call-analysis');

function resolveEventObjectLiteral(context, node, seen = new Set()) {
  const current = unwrap(node);
  if (!current || current.type !== 'Identifier') {
    return resolveObjectLiteral(context, node);
  }

  const variable = resolveVariable(context, current);
  if (!variable || seen.has(variable)) return null;
  seen.add(variable);
  for (const reference of variable.references) {
    if (reference.init === true) continue;
    if (reference.identifier === current && !reference.isWrite()) continue;
    return null;
  }
  return resolveEventObjectLiteral(context, immutableInit(variable), seen);
}

function propertyKey(property) {
  if (property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal') return String(property.key.value);
  return null;
}

function resolveEventDescriptor(context, call, compiled) {
  if (call.spreadArgs || call.args.length !== 2) {
    return Object.freeze({ error: 'unanalyzable', event: null, name: null });
  }
  const eventName = staticStringValue(context, call.args[0]);
  if (eventName === null) {
    return Object.freeze({ error: 'dynamicEvent', event: null, name: null });
  }
  if (!hasOwn(compiled.events, eventName)) {
    return Object.freeze({
      error: 'unknownEvent',
      event: null,
      name: eventName,
    });
  }
  return Object.freeze({
    error: null,
    event: compiled.events[eventName],
    name: eventName,
  });
}

function propertyIssue(error, node, value) {
  return Object.freeze({ error, node, value });
}

function bindEventProperty(event, property, seen) {
  if (property.type === 'SpreadElement') {
    return propertyIssue('spreadProperty', property, null);
  }
  if (property.computed) {
    return propertyIssue('computedProperty', property.key, property.value);
  }

  const key = propertyKey(property);
  if (key === null) {
    return propertyIssue('computedProperty', property.key, property.value);
  }
  const descriptor = hasOwn(event.propertiesByName, key)
    ? event.propertiesByName[key]
    : null;
  if (seen.has(key)) {
    return Object.freeze({
      descriptor,
      error: 'duplicateProperty',
      key,
      node: property.key,
      value: property.value,
    });
  }
  seen.add(key);
  return Object.freeze({
    descriptor,
    error: descriptor ? null : 'unknownProperty',
    key,
    node: property.key,
    value: property.value,
  });
}

function missingEventProperties(event, seen) {
  const missing = [];
  for (const property of event.grammarEvent.properties) {
    if (property.required && !seen.has(property.name)) missing.push(property);
  }
  return Object.freeze(missing);
}

function bindEventStructure(context, call, compiled) {
  const descriptor = resolveEventDescriptor(context, call, compiled);
  const result = {
    call,
    error: descriptor.error,
    event: descriptor.event,
    eventName: descriptor.name,
    eventNode: call.args[0] ?? call.node,
    missing: Object.freeze([]),
    properties: Object.freeze([]),
    propertiesNode: call.args[1] ?? call.node,
  };
  if (descriptor.error) return Object.freeze(result);

  const object = resolveEventObjectLiteral(context, call.args[1]);
  if (!object) {
    result.error = 'opaqueProperties';
    return Object.freeze(result);
  }

  const seen = new Set();
  const properties = [];
  for (const property of object.properties) {
    properties.push(bindEventProperty(descriptor.event, property, seen));
  }
  result.properties = Object.freeze(properties);
  result.missing = missingEventProperties(descriptor.event, seen);
  return Object.freeze(result);
}

module.exports = { bindEventStructure };
