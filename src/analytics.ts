import type { EventDefinition } from './analytics/descriptors';
import { emitGrammar } from './analytics/grammar';
import { GRAMMAR_V1_LIMITS } from './analytics/grammar-format';
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
  AnalyticsGrammar,
  AnalyticsGrammarConstraint,
  AnalyticsGrammarEnumConstraint,
  AnalyticsGrammarEvent,
  AnalyticsGrammarIntegerConstraint,
  AnalyticsGrammarNamedStringConstraint,
  AnalyticsGrammarProperty,
  AnalyticsGrammarV1,
} from './analytics/grammar-format';
export type {
  AnalyticsLintArtifactV1,
  EventArtifact,
  EventName,
  EventProperties,
  ValidationResult,
} from './analytics/types';

/** Build the immutable type/runtime artifact from one event definition. */
export function defineEvents<const Definition extends EventDefinition>(
  definition: Definition
): EventArtifact<Definition> {
  const schema = normalizeDefinition(definition, GRAMMAR_V1_LIMITS);
  const { grammar, grammarJSON } = emitGrammar(schema);
  const lint = Object.freeze({ formatVersion: 1 as const, grammar });
  return Object.freeze({
    schema,
    grammar,
    grammarJSON,
    lint,
    validate: createValidator(schema),
  }) as EventArtifact<Definition>;
}
