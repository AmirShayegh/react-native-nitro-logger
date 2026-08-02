import type { EventDefinition } from './analytics/descriptors';
import { normalizeDefinition } from './analytics/schema';
import type { EventArtifact } from './analytics/types';
import { createValidator } from './analytics/validator';

export {
  int,
  namedString,
  oneOf,
  optional,
  screenName,
} from './analytics/descriptors';
export type {
  EventArtifact,
  EventName,
  EventProperties,
  ValidationResult,
} from './analytics/types';

/** Build the immutable type/runtime artifact from one event definition. */
export function defineEvents<const Definition extends EventDefinition>(
  definition: Definition
): EventArtifact<Definition> {
  const schema = normalizeDefinition(definition);
  return Object.freeze({
    schema,
    validate: createValidator(schema),
  }) as EventArtifact<Definition>;
}
