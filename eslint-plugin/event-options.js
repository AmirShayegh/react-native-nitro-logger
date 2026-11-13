'use strict';

const { types: utilTypes } = require('node:util');

const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const isProxy = utilTypes.isProxy;
const functionToString = Function.prototype.toString;

const EVENT_METHODS = new Set(['track']);
const ANALYTICS_FACTORY_NAMES = new Set(['createAnalytics']);
const PRIVACY_WRAPPER_NAMES = new Set(['priv', 'pub']);

const DEFAULT_ANALYTICS_NAMES = ['analytics'];
const DEFAULT_ANALYTICS_MODULES = ['react-native-nitro-logger/analytics'];
const DEFAULT_PRIVACY_MODULES = ['react-native-nitro-logger'];

const EVENT_OPTION_PROPERTIES = {
  lintArtifact: { type: 'object' },
  analyticsNames: {
    type: 'array',
    items: { type: 'string', minLength: 1 },
    minItems: 1,
    uniqueItems: true,
  },
  analyticsModules: {
    type: 'array',
    items: { type: 'string', minLength: 1 },
    minItems: 1,
    uniqueItems: true,
  },
  privacyModules: {
    type: 'array',
    items: { type: 'string', minLength: 1 },
    minItems: 1,
    uniqueItems: true,
  },
};
const EVENT_CONFIGURATION_KEYS = Object.freeze(
  Object.keys(EVENT_OPTION_PROPERTIES).filter((name) => name !== 'lintArtifact')
);

const configuredSets = new WeakMap();
const ruleOptionSnapshots = new WeakMap();

function invalidEventOptions() {
  throw new TypeError('INVALID_EVENT_LINT_OPTIONS');
}

function plainRecord(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    isProxy(value)
  ) {
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
  if (!Array.isArray(value) || isProxy(value)) return false;
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

function denseStringList(value) {
  if (!plainArray(value)) invalidEventOptions();
  const lengthDescriptor = getOwnPropertyDescriptor(value, 'length');
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 1
  ) {
    invalidEventOptions();
  }

  const length = lengthDescriptor.value;
  const keys = ownKeys(value);
  if (keys.length !== length + 1) invalidEventOptions();
  const unique = new Set();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = getOwnPropertyDescriptor(value, String(index));
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length === 0 ||
      unique.has(descriptor.value)
    ) {
      invalidEventOptions();
    }
    unique.add(descriptor.value);
    result[index] = descriptor.value;
  }
  for (const key of keys) {
    if (key === 'length') continue;
    if (
      typeof key !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(key) ||
      Number(key) >= length
    ) {
      invalidEventOptions();
    }
  }
  return Object.freeze(result);
}

function snapshotOptionsRecord(options, includeArtifact) {
  if (!plainRecord(options)) invalidEventOptions();

  const allowed = new Set(EVENT_CONFIGURATION_KEYS);
  if (includeArtifact) allowed.add('lintArtifact');
  const snapshot = Object.create(null);
  let artifactPresent = false;
  for (const key of ownKeys(options)) {
    if (typeof key !== 'string' || !allowed.has(key)) invalidEventOptions();
    const descriptor = getOwnPropertyDescriptor(options, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      invalidEventOptions();
    }
    if (key === 'lintArtifact') {
      artifactPresent = true;
      snapshot.lintArtifact = descriptor.value;
    } else {
      snapshot[key] = denseStringList(descriptor.value);
    }
  }
  if (includeArtifact && !artifactPresent) invalidEventOptions();
  return Object.freeze(snapshot);
}

function snapshotEventOptions(options) {
  try {
    return snapshotOptionsRecord(options, false);
  } catch {
    invalidEventOptions();
  }
}

function singleRuleOption(options) {
  if (!plainArray(options)) invalidEventOptions();
  const length = getOwnPropertyDescriptor(options, 'length');
  const option = getOwnPropertyDescriptor(options, '0');
  if (
    !length ||
    !('value' in length) ||
    length.value !== 1 ||
    ownKeys(options).length !== 2 ||
    !option ||
    !option.enumerable ||
    !('value' in option)
  ) {
    invalidEventOptions();
  }
  return option.value;
}

function eventRuleOptions(context) {
  const cached = ruleOptionSnapshots.get(context);
  if (cached) return cached;
  try {
    const snapshot = snapshotOptionsRecord(
      singleRuleOption(context.options),
      true
    );
    ruleOptionSnapshots.set(context, snapshot);
    return snapshot;
  } catch {
    invalidEventOptions();
  }
}

function configuredSet(context, name, defaults) {
  let perContext = configuredSets.get(context);
  if (!perContext) {
    perContext = Object.create(null);
    configuredSets.set(context, perContext);
  }
  if (perContext[name]) return perContext[name];
  const configured = eventRuleOptions(context)[name];
  const result = new Set(configured ?? defaults);
  perContext[name] = result;
  return result;
}

function analyticsNames(context) {
  return configuredSet(context, 'analyticsNames', DEFAULT_ANALYTICS_NAMES);
}

function analyticsModules(context) {
  return configuredSet(context, 'analyticsModules', DEFAULT_ANALYTICS_MODULES);
}

function privacyModules(context) {
  return configuredSet(context, 'privacyModules', DEFAULT_PRIVACY_MODULES);
}

module.exports = {
  ANALYTICS_FACTORY_NAMES,
  DEFAULT_ANALYTICS_MODULES,
  DEFAULT_ANALYTICS_NAMES,
  DEFAULT_PRIVACY_MODULES,
  EVENT_METHODS,
  EVENT_CONFIGURATION_KEYS,
  EVENT_OPTION_PROPERTIES,
  PRIVACY_WRAPPER_NAMES,
  analyticsModules,
  analyticsNames,
  eventRuleOptions,
  privacyModules,
  snapshotEventOptions,
};
