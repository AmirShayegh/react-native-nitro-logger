import { matchesPrimitiveConstraint } from '../constraints';
import { validateMarkerForConstraint } from '../privacy';
import type {
  Descriptor,
  EventDefinition,
  NormalizedSchema,
} from './descriptors';
import { primitiveConstraint } from './descriptors';
import type { EventArtifact, ValidationResult } from './types';

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function acceptsValue(value: unknown, descriptor: Descriptor): boolean {
  const constraint = primitiveConstraint(descriptor);
  const marker = validateMarkerForConstraint(value, constraint);
  if (marker !== 'not-marker') return marker === 'valid';
  return matchesPrimitiveConstraint(value, constraint);
}

function immutableSnapshot(
  eventSchema: Readonly<Record<string, Descriptor>>,
  values: ReadonlyMap<string, unknown>
): Readonly<Record<string, unknown>> {
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const property of Object.keys(eventSchema)) {
    if (!values.has(property)) continue;
    Object.defineProperty(snapshot, property, {
      value: values.get(property),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(snapshot);
}

function validateProperties<Definition extends EventDefinition>(
  eventName: string,
  eventSchema: Readonly<Record<string, Descriptor>>,
  properties: unknown
): ValidationResult<EventArtifact<Definition>> {
  try {
    if (!plainRecord(properties)) {
      return { ok: false, code: 'INVALID_CONTAINER' };
    }

    const values = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(properties)) {
      const descriptor = Object.getOwnPropertyDescriptor(properties, key);
      if (!descriptor || !('value' in descriptor)) {
        return { ok: false, code: 'INVALID_CONTAINER' };
      }
      if (typeof key !== 'string' || !hasOwn(eventSchema, key)) {
        return { ok: false, code: 'EXTRA_PROPERTY' };
      }
      values.set(key, descriptor.value);
    }

    for (const property of Object.keys(eventSchema)) {
      const descriptor = eventSchema[property];
      if (!descriptor) return { ok: false, code: 'INVALID_CONTAINER' };
      if (!values.has(property)) {
        if (descriptor.kind === 'optional') continue;
        return { ok: false, code: 'MISSING_PROPERTY', property };
      }
      if (!acceptsValue(values.get(property), descriptor)) {
        return { ok: false, code: 'INVALID_VALUE', property };
      }
    }

    return {
      ok: true,
      eventName,
      properties: immutableSnapshot(eventSchema, values),
    } as ValidationResult<EventArtifact<Definition>>;
  } catch {
    return { ok: false, code: 'INVALID_CONTAINER' };
  }
}

export function createValidator<Definition extends EventDefinition>(
  schema: NormalizedSchema<Definition>
): EventArtifact<Definition>['validate'] {
  return (eventName: unknown, properties: unknown) => {
    if (typeof eventName !== 'string' || !hasOwn(schema, eventName)) {
      return { ok: false, code: 'UNKNOWN_EVENT' };
    }
    return validateProperties<Definition>(
      eventName,
      schema[eventName] as Readonly<Record<string, Descriptor>>,
      properties
    );
  };
}
