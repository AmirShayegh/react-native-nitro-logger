export type PrimitiveValue = string | number | boolean;

export interface EnumConstraint {
  readonly kind: 'enum';
  readonly values: readonly string[];
}

export interface IntegerConstraint {
  readonly kind: 'integer';
  readonly min: number;
  readonly max: number;
}

export interface NamedStringConstraint {
  readonly kind: 'named-string';
  readonly registry: string;
  readonly values: readonly string[];
}

export type PrimitiveConstraint =
  EnumConstraint | IntegerConstraint | NamedStringConstraint;

const memberLookups = new WeakMap<object, ReadonlySet<string>>();

/** Attach a private constant-time lookup without changing the artifact IR. */
export function registerConstraintLookup(
  constraint: EnumConstraint | NamedStringConstraint
): void {
  memberLookups.set(constraint, new Set(constraint.values));
}

/** The primitive contract shared by privacy markers and schema validation. */
export function isLogPrimitive(value: unknown): value is PrimitiveValue {
  const kind = typeof value;
  return (
    kind === 'string' ||
    kind === 'boolean' ||
    (kind === 'number' && Number.isFinite(value))
  );
}

/** Match a primitive against the normalized, dependency-neutral constraint. */
export function matchesPrimitiveConstraint(
  value: unknown,
  constraint: PrimitiveConstraint
): value is PrimitiveValue {
  if (!isLogPrimitive(value)) return false;

  switch (constraint.kind) {
    case 'enum':
    case 'named-string':
      return (
        typeof value === 'string' &&
        (memberLookups.get(constraint)?.has(value) ??
          constraint.values.includes(value))
      );
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= constraint.min &&
        value <= constraint.max
      );
  }
}
