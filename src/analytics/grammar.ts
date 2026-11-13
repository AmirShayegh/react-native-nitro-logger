import { utf8Length } from '../utf8';
import type { EventDefinition, NormalizedSchema } from './descriptors';
import type { AnalyticsGrammarV1 } from './grammar-format';
import { GRAMMAR_V1_LIMITS } from './grammar-format';
import { mapGrammarV1 } from './grammar-mapper';
import { serializeProtectedJSON } from './protected-json';

export interface GrammarEmission {
  readonly grammar: AnalyticsGrammarV1;
  readonly grammarJSON: string;
}

/** Emit the protected document and the only bytes later registration may use. */
export function emitGrammar<Definition extends EventDefinition>(
  schema: NormalizedSchema<Definition>
): GrammarEmission {
  const grammar = mapGrammarV1(schema);
  const grammarJSON = serializeProtectedJSON(grammar);
  if (utf8Length(grammarJSON) > GRAMMAR_V1_LIMITS.maxJSONBytes) {
    throw new TypeError('GRAMMAR_SIZE_LIMIT');
  }
  return Object.freeze({ grammar, grammarJSON });
}
