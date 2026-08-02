import {
  copyDescriptor,
  isRegisteredDescriptor,
  STRUCTURAL_NAME,
} from './descriptors';
import type {
  Descriptor,
  EventDefinition,
  NormalizedSchema,
} from './descriptors';

type SchemaErrorCode =
  | 'EMPTY_EVENT_DEFINITION'
  | 'INVALID_DESCRIPTOR'
  | 'INVALID_EVENT_DEFINITION'
  | 'INVALID_EVENT_NAME'
  | 'INVALID_EVENT_PROPERTIES'
  | 'INVALID_PROPERTY_DEFINITION'
  | 'INVALID_PROPERTY_NAME';

const schemaErrors = new WeakMap<object, SchemaErrorCode>();

function fail(code: SchemaErrorCode): never {
  const error = new TypeError(code);
  schemaErrors.set(error, code);
  throw error;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor || !('value' in descriptor)) {
    fail('INVALID_PROPERTY_DEFINITION');
  }
  return descriptor.value;
}

function normalizeProperties(
  value: unknown,
  descriptorCopies: WeakMap<object, Descriptor>
): Readonly<Record<string, Descriptor>> {
  if (!plainRecord(value)) fail('INVALID_EVENT_PROPERTIES');
  const normalized = Object.create(null) as Record<string, Descriptor>;

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !STRUCTURAL_NAME.test(key)) {
      fail('INVALID_PROPERTY_NAME');
    }
    const descriptor = ownDataValue(value, key);
    if (!isRegisteredDescriptor(descriptor)) fail('INVALID_DESCRIPTOR');
    normalized[key] = copyDescriptor(descriptor, descriptorCopies);
  }
  return Object.freeze(normalized);
}

function normalizeEvents(
  definition: Record<string, unknown>
): Readonly<Record<string, Readonly<Record<string, Descriptor>>>> {
  const eventKeys = Reflect.ownKeys(definition);
  if (eventKeys.length === 0) fail('EMPTY_EVENT_DEFINITION');
  const normalized = Object.create(null) as Record<
    string,
    Readonly<Record<string, Descriptor>>
  >;
  const descriptorCopies = new WeakMap<object, Descriptor>();

  for (const key of eventKeys) {
    if (typeof key !== 'string' || !STRUCTURAL_NAME.test(key)) {
      fail('INVALID_EVENT_NAME');
    }
    const descriptor = Object.getOwnPropertyDescriptor(definition, key);
    if (!descriptor || !('value' in descriptor)) {
      fail('INVALID_EVENT_DEFINITION');
    }
    normalized[key] = normalizeProperties(descriptor.value, descriptorCopies);
  }
  return Object.freeze(normalized);
}

export function normalizeDefinition<const Definition extends EventDefinition>(
  definition: Definition
): NormalizedSchema<Definition> {
  try {
    if (!plainRecord(definition)) fail('INVALID_EVENT_DEFINITION');
    return normalizeEvents(definition) as NormalizedSchema<Definition>;
  } catch (error) {
    const code =
      error !== null && typeof error === 'object'
        ? schemaErrors.get(error)
        : undefined;
    throw new TypeError(code ?? 'INVALID_EVENT_DEFINITION');
  }
}
