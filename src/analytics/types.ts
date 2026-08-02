import type { PrivateValue, PublicValue } from '../privacy';
import type { LogPrimitive } from '../types';
import type {
  EnumDescriptor,
  EventDefinition,
  IntegerDescriptor,
  NamedStringDescriptor,
  NormalizedSchema,
  OptionalDescriptor,
} from './descriptors';

type DescriptorPrimitive<Value> =
  Value extends OptionalDescriptor<infer Inner>
    ? DescriptorPrimitive<Inner>
    : Value extends EnumDescriptor<infer Values>
      ? Values[number]
      : Value extends NamedStringDescriptor<string, infer Values>
        ? Values[number]
        : Value extends IntegerDescriptor
          ? number
          : never;

type AcceptedValue<Value> =
  DescriptorPrimitive<Value> extends infer Primitive
    ? Primitive extends LogPrimitive
      ? Primitive | PublicValue<Primitive> | PrivateValue<Primitive>
      : never
    : never;

type OptionalKeys<Properties> = {
  [Key in keyof Properties]-?: Properties[Key] extends OptionalDescriptor
    ? Key
    : never;
}[keyof Properties];

type RequiredKeys<Properties> = Exclude<
  keyof Properties,
  OptionalKeys<Properties>
>;

type Simplify<Value> = { [Key in keyof Value]: Value[Key] } & {};

type PropertiesFromDefinition<Properties> = Simplify<
  {
    readonly [Key in RequiredKeys<Properties>]: AcceptedValue<Properties[Key]>;
  } & {
    readonly [Key in OptionalKeys<Properties>]?: AcceptedValue<Properties[Key]>;
  }
>;

declare const artifactDefinition: unique symbol;

/** An immutable schema plus the runtime validator derived from it. */
export interface EventArtifact<
  Definition extends EventDefinition = EventDefinition,
> {
  readonly schema: NormalizedSchema<Definition>;
  readonly [artifactDefinition]: Definition;
  validate(
    eventName: unknown,
    properties: unknown
  ): ValidationResult<EventArtifact<Definition>>;
}

type DefinitionOf<Artifact> =
  Artifact extends EventArtifact<infer Definition> ? Definition : never;

/** Exact event-name union inferred from a `defineEvents()` artifact. */
export type EventName<Artifact> = Extract<keyof DefinitionOf<Artifact>, string>;

/** Exact property object inferred for one event in an artifact. */
export type EventProperties<Artifact, Name extends EventName<Artifact>> =
  DefinitionOf<Artifact> extends infer Definition extends EventDefinition
    ? PropertiesFromDefinition<Definition[Extract<Name, keyof Definition>]>
    : never;

type ValidationSuccess<Artifact> = {
  [Name in EventName<Artifact>]: {
    readonly ok: true;
    readonly eventName: Name;
    readonly properties: EventProperties<Artifact, Name>;
  };
}[EventName<Artifact>];

type ValidationFailure =
  | { readonly ok: false; readonly code: 'UNKNOWN_EVENT' }
  | { readonly ok: false; readonly code: 'INVALID_CONTAINER' }
  | { readonly ok: false; readonly code: 'EXTRA_PROPERTY' }
  | {
      readonly ok: false;
      readonly code: 'MISSING_PROPERTY' | 'INVALID_VALUE';
      readonly property: string;
    };

/** Closed success/failure result returned by the runtime validator. */
export type ValidationResult<Artifact> =
  ValidationSuccess<Artifact> | ValidationFailure;
