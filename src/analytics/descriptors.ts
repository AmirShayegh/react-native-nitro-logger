import { registerConstraintLookup } from '../constraints';
import { utf8Length } from '../utf8';
import type {
  EnumConstraint,
  IntegerConstraint,
  NamedStringConstraint,
  PrimitiveConstraint,
} from '../constraints';

export interface EnumDescriptor<
  Values extends readonly string[] = readonly string[],
> extends EnumConstraint {
  readonly values: Values;
}

export interface IntegerDescriptor extends IntegerConstraint {}

export interface NamedStringDescriptor<
  Registry extends string = string,
  Values extends readonly string[] = readonly string[],
> extends NamedStringConstraint {
  readonly registry: Registry;
  readonly values: Values;
}

export type PrimitiveDescriptor =
  EnumDescriptor | IntegerDescriptor | NamedStringDescriptor;

export interface OptionalDescriptor<
  Inner extends PrimitiveDescriptor = PrimitiveDescriptor,
> {
  readonly kind: 'optional';
  readonly value: Inner;
}

export type Descriptor = PrimitiveDescriptor | OptionalDescriptor;
export type EventDefinition = Readonly<
  Record<string, Readonly<Record<string, Descriptor>>>
>;
export type NormalizedSchema<Definition extends EventDefinition> = {
  readonly [Event in keyof Definition]: {
    readonly [Property in keyof Definition[Event]]: Definition[Event][Property];
  };
};

const descriptors = new WeakSet<object>();
export const STRUCTURAL_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
export const MAX_CONSTRAINT_MEMBERS = 4096;
export const MAX_CONSTRAINT_MEMBER_BYTES = 256;

function registered<const Value extends object>(value: Value): Readonly<Value> {
  descriptors.add(value);
  if (
    'kind' in value &&
    (value.kind === 'enum' || value.kind === 'named-string')
  ) {
    registerConstraintLookup(value as unknown as EnumDescriptor);
  }
  return Object.freeze(value);
}

function validateUnicodeScalars(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('INVALID_CONSTRAINT_MEMBER');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('INVALID_CONSTRAINT_MEMBER');
    }
  }
}

function validateMembers(
  values: readonly unknown[]
): asserts values is readonly string[] {
  if (values.length === 0) throw new TypeError('EMPTY_CONSTRAINT');
  if (values.length > MAX_CONSTRAINT_MEMBERS) {
    throw new TypeError('CONSTRAINT_TOO_LARGE');
  }

  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError('INVALID_CONSTRAINT_MEMBER');
    }
    validateUnicodeScalars(value);
    if (utf8Length(value) > MAX_CONSTRAINT_MEMBER_BYTES) {
      throw new TypeError('CONSTRAINT_MEMBER_TOO_LARGE');
    }
    if (seen.has(value)) throw new TypeError('DUPLICATE_CONSTRAINT_MEMBER');
    seen.add(value);
  }
}

/** Define an exact, non-empty set of allowed string values. */
export function oneOf<const Values extends readonly string[]>(
  ...values: Values
): EnumDescriptor<Values> {
  validateMembers(values);
  const copy = Object.freeze([...values]) as unknown as Values;
  return registered({ kind: 'enum', values: copy }) as EnumDescriptor<Values>;
}

function readIntegerBounds(bounds: unknown): readonly [number, number] {
  try {
    if (bounds === null || typeof bounds !== 'object') {
      throw new TypeError('INVALID_INTEGER_BOUNDS');
    }
    const minDescriptor = Object.getOwnPropertyDescriptor(bounds, 'min');
    const maxDescriptor = Object.getOwnPropertyDescriptor(bounds, 'max');
    if (
      !minDescriptor ||
      !maxDescriptor ||
      !('value' in minDescriptor) ||
      !('value' in maxDescriptor)
    ) {
      throw new TypeError('INVALID_INTEGER_BOUNDS');
    }
    return [minDescriptor.value, maxDescriptor.value] as readonly [
      number,
      number,
    ];
  } catch {
    throw new TypeError('INVALID_INTEGER_BOUNDS');
  }
}

/** Define an inclusive, finite integer range. */
export function int(bounds: {
  readonly min: number;
  readonly max: number;
}): IntegerDescriptor {
  const [min, max] = readIntegerBounds(bounds);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min > max) {
    throw new TypeError('INVALID_INTEGER_BOUNDS');
  }
  return registered({ kind: 'integer', min, max }) as IntegerDescriptor;
}

/** Define an exact string set owned by a named application registry. */
export function namedString<
  const Registry extends string,
  const Values extends readonly string[],
>(
  registry: Registry,
  ...values: Values
): NamedStringDescriptor<Registry, Values> {
  if (typeof registry !== 'string' || !STRUCTURAL_NAME.test(registry)) {
    throw new TypeError('INVALID_REGISTRY_NAME');
  }
  validateMembers(values);
  const copy = Object.freeze([...values]) as unknown as Values;
  return registered({
    kind: 'named-string',
    registry,
    values: copy,
  }) as NamedStringDescriptor<Registry, Values>;
}

/** Define the application screen-name registry used by screen-view events. */
export function screenName<const Values extends readonly string[]>(
  ...values: Values
): NamedStringDescriptor<'screen', Values> {
  return namedString('screen', ...values);
}

/** Mark one schema property as optional while retaining its exact value type. */
export function optional<const Inner extends PrimitiveDescriptor>(
  value: Inner
): OptionalDescriptor<Inner> {
  if (!descriptors.has(value) || (value as Descriptor).kind === 'optional') {
    throw new TypeError('INVALID_DESCRIPTOR');
  }
  return registered({ kind: 'optional', value }) as OptionalDescriptor<Inner>;
}

export function isRegisteredDescriptor(value: unknown): value is Descriptor {
  return value !== null && typeof value === 'object' && descriptors.has(value);
}

function copyPrimitiveDescriptor(
  value: PrimitiveDescriptor
): PrimitiveDescriptor {
  if (value.kind === 'integer') {
    return registered({ kind: 'integer', min: value.min, max: value.max });
  }
  if (value.kind === 'enum') {
    return registered({
      kind: 'enum',
      values: Object.freeze([...value.values]),
    });
  }
  return registered({
    kind: 'named-string',
    registry: value.registry,
    values: Object.freeze([...value.values]),
  });
}

export function copyDescriptor(
  value: Descriptor,
  copies = new WeakMap<object, Descriptor>()
): Descriptor {
  const existing = copies.get(value);
  if (existing) return existing;

  const copy: Descriptor =
    value.kind === 'optional'
      ? Object.freeze({
          kind: 'optional',
          value: copyDescriptor(value.value, copies) as PrimitiveDescriptor,
        })
      : copyPrimitiveDescriptor(value);
  copies.set(value, copy);
  return copy;
}

export function primitiveConstraint(
  descriptor: Descriptor
): PrimitiveConstraint {
  return descriptor.kind === 'optional' ? descriptor.value : descriptor;
}
