const stringifyJSON = JSON.stringify;

/** Construct a fixed-key record that cannot inherit serialization behavior. */
export function protectedRecord<Value extends object>(): Value {
  return Object.create(null) as Value;
}

/** Copy and freeze a dense array with an own, non-callable `toJSON` shadow. */
export function protectedArray<Value>(
  source: readonly Value[]
): readonly Value[] {
  const result: Value[] = [];
  for (let index = 0; index < source.length; index += 1) {
    result[index] = source[index]!;
  }
  Object.defineProperty(result, 'toJSON', {
    configurable: false,
    enumerable: false,
    value: null,
    writable: false,
  });
  return Object.freeze(result);
}

/** Freeze a completed protected record without widening its public shape. */
export function freezeRecord<Value extends object>(
  value: Value
): Readonly<Value> {
  return Object.freeze(value);
}

/** Serialize a protected graph using the module-captured JSON intrinsic. */
export function serializeProtectedJSON(value: object): string {
  const serialized = stringifyJSON(value);
  if (typeof serialized !== 'string') {
    throw new TypeError('GRAMMAR_SERIALIZATION_FAILURE');
  }
  return serialized;
}
