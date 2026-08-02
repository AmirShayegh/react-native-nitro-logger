import type {
  Descriptor,
  EventDefinition,
  NormalizedSchema,
  PrimitiveDescriptor,
} from './descriptors';
import type {
  AnalyticsGrammarConstraint,
  AnalyticsGrammarEnumConstraint,
  AnalyticsGrammarEvent,
  AnalyticsGrammarIntegerConstraint,
  AnalyticsGrammarNamedStringConstraint,
  AnalyticsGrammarProperty,
  AnalyticsGrammarV1,
} from './grammar-format';
import { GRAMMAR_V1_LIMITS } from './grammar-format';
import {
  freezeRecord,
  protectedArray,
  protectedRecord,
} from './protected-json';

type Writable<Value> = {
  -readonly [Key in keyof Value]: Value[Key];
};

function mergeRange(
  source: readonly string[],
  target: string[],
  start: number,
  leftEnd: number,
  rightEnd: number
): void {
  let left = start;
  let right = leftEnd;
  let output = start;

  while (left < leftEnd || right < rightEnd) {
    if (
      right >= rightEnd ||
      (left < leftEnd && source[left]! <= source[right]!)
    ) {
      target[output] = source[left]!;
      left += 1;
    } else {
      target[output] = source[right]!;
      right += 1;
    }
    output += 1;
  }
}

function sortedKeys(value: object): string[] {
  const ownKeys = Reflect.ownKeys(value);
  let source: string[] = [];
  for (let sourceIndex = 0; sourceIndex < ownKeys.length; sourceIndex += 1) {
    const key = ownKeys[sourceIndex]!;
    if (typeof key !== 'string') {
      throw new TypeError('GRAMMAR_SCHEMA_INVARIANT');
    }
    source[sourceIndex] = key;
  }

  let target: string[] = [];
  for (let width = 1; width < source.length; width *= 2) {
    for (let start = 0; start < source.length; start += width * 2) {
      const leftEnd = Math.min(start + width, source.length);
      const rightEnd = Math.min(start + width * 2, source.length);
      mergeRange(source, target, start, leftEnd, rightEnd);
    }

    const previousSource = source;
    source = target;
    target = previousSource;
  }
  return source;
}

function primitiveOf(descriptor: Descriptor): PrimitiveDescriptor {
  return descriptor.kind === 'optional' ? descriptor.value : descriptor;
}

function memberReferences(descriptor: Descriptor): number {
  const primitive = primitiveOf(descriptor);
  return primitive.kind === 'integer' ? 0 : primitive.values.length;
}

function enumConstraint(
  descriptor: Extract<PrimitiveDescriptor, { readonly kind: 'enum' }>
): AnalyticsGrammarEnumConstraint {
  const constraint =
    protectedRecord<Writable<AnalyticsGrammarEnumConstraint>>();
  constraint.type = 'enum';
  constraint.values = protectedArray(descriptor.values);
  return freezeRecord(constraint);
}

function integerConstraint(
  descriptor: Extract<PrimitiveDescriptor, { readonly kind: 'integer' }>
): AnalyticsGrammarIntegerConstraint {
  const constraint =
    protectedRecord<Writable<AnalyticsGrammarIntegerConstraint>>();
  constraint.type = 'integer';
  constraint.minimum = descriptor.min;
  constraint.maximum = descriptor.max;
  return freezeRecord(constraint);
}

function namedStringConstraint(
  descriptor: Extract<PrimitiveDescriptor, { readonly kind: 'named-string' }>
): AnalyticsGrammarNamedStringConstraint {
  const constraint =
    protectedRecord<Writable<AnalyticsGrammarNamedStringConstraint>>();
  constraint.type = 'named-string';
  constraint.registry = descriptor.registry;
  constraint.values = protectedArray(descriptor.values);
  return freezeRecord(constraint);
}

function mapConstraint(
  descriptor: Descriptor,
  constraints: WeakMap<object, AnalyticsGrammarConstraint>
): AnalyticsGrammarConstraint {
  const primitive = primitiveOf(descriptor);
  const existing = constraints.get(primitive);
  if (existing) return existing;

  const constraint =
    primitive.kind === 'enum'
      ? enumConstraint(primitive)
      : primitive.kind === 'integer'
        ? integerConstraint(primitive)
        : namedStringConstraint(primitive);
  constraints.set(primitive, constraint);
  return constraint;
}

function mapProperty(
  name: string,
  descriptor: Descriptor,
  constraints: WeakMap<object, AnalyticsGrammarConstraint>
): AnalyticsGrammarProperty {
  const property = protectedRecord<Writable<AnalyticsGrammarProperty>>();
  property.name = name;
  property.required = descriptor.kind !== 'optional';
  property.constraint = mapConstraint(descriptor, constraints);
  return freezeRecord(property);
}

function mapEvent(
  name: string,
  properties: Readonly<Record<string, Descriptor>>,
  constraints: WeakMap<object, AnalyticsGrammarConstraint>,
  counts: { properties: number; members: number }
): AnalyticsGrammarEvent {
  const propertyKeys = sortedKeys(properties);
  const mappedProperties: AnalyticsGrammarProperty[] = [];

  for (let index = 0; index < propertyKeys.length; index += 1) {
    const propertyName = propertyKeys[index]!;
    const descriptor = properties[propertyName]!;
    counts.properties += 1;
    counts.members += memberReferences(descriptor);
    if (counts.properties > GRAMMAR_V1_LIMITS.maxProperties) {
      throw new TypeError('GRAMMAR_PROPERTY_LIMIT');
    }
    if (counts.members > GRAMMAR_V1_LIMITS.maxMemberReferences) {
      throw new TypeError('GRAMMAR_MEMBER_REFERENCE_LIMIT');
    }
    mappedProperties[index] = mapProperty(
      propertyName,
      descriptor,
      constraints
    );
  }

  const event = protectedRecord<Writable<AnalyticsGrammarEvent>>();
  event.name = name;
  event.additionalProperties = false;
  event.properties = protectedArray(mappedProperties);
  return freezeRecord(event);
}

/** Map one trusted normalized schema into the protected v1 JSON graph. */
export function mapGrammarV1<Definition extends EventDefinition>(
  schema: NormalizedSchema<Definition>
): AnalyticsGrammarV1 {
  const eventKeys = sortedKeys(schema);
  if (eventKeys.length > GRAMMAR_V1_LIMITS.maxEvents) {
    throw new TypeError('GRAMMAR_EVENT_LIMIT');
  }

  const constraints = new WeakMap<object, AnalyticsGrammarConstraint>();
  const counts = { properties: 0, members: 0 };
  const mappedEvents: AnalyticsGrammarEvent[] = [];
  for (let index = 0; index < eventKeys.length; index += 1) {
    const eventName = eventKeys[index]!;
    mappedEvents[index] = mapEvent(
      eventName,
      schema[eventName]! as Readonly<Record<string, Descriptor>>,
      constraints,
      counts
    );
  }

  const grammar = protectedRecord<Writable<AnalyticsGrammarV1>>();
  grammar.artifact = 'react-native-nitro-logger/analytics-grammar';
  grammar.formatVersion = 1;
  grammar.additionalEvents = false;
  grammar.events = protectedArray(mappedEvents);
  return freezeRecord(grammar);
}
