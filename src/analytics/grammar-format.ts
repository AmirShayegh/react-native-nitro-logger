/** Exact string-set constraint serialized into an analytics grammar. */
export interface AnalyticsGrammarEnumConstraint {
  readonly type: 'enum';
  readonly values: readonly string[];
}

/** Inclusive safe-integer constraint serialized into an analytics grammar. */
export interface AnalyticsGrammarIntegerConstraint {
  readonly type: 'integer';
  readonly minimum: number;
  readonly maximum: number;
}

/** Named exact string-set constraint serialized into an analytics grammar. */
export interface AnalyticsGrammarNamedStringConstraint {
  readonly type: 'named-string';
  readonly registry: string;
  readonly values: readonly string[];
}

/** One portable property constraint in a v1 analytics grammar. */
export type AnalyticsGrammarConstraint =
  | AnalyticsGrammarEnumConstraint
  | AnalyticsGrammarIntegerConstraint
  | AnalyticsGrammarNamedStringConstraint;

/** One closed property entry in a v1 analytics grammar. */
export interface AnalyticsGrammarProperty {
  readonly name: string;
  readonly required: boolean;
  readonly constraint: AnalyticsGrammarConstraint;
}

/** One closed event entry in a v1 analytics grammar. */
export interface AnalyticsGrammarEvent {
  readonly name: string;
  readonly additionalProperties: false;
  readonly properties: readonly AnalyticsGrammarProperty[];
}

/** Canonical, closed-world analytics grammar format emitted by this release. */
export interface AnalyticsGrammarV1 {
  readonly artifact: 'react-native-nitro-logger/analytics-grammar';
  readonly formatVersion: 1;
  readonly additionalEvents: false;
  readonly events: readonly AnalyticsGrammarEvent[];
}

/** The latest analytics grammar format understood by this client. */
export type AnalyticsGrammar = AnalyticsGrammarV1;

export const GRAMMAR_V1_LIMITS = Object.freeze({
  maxEvents: 256,
  maxProperties: 2048,
  maxMemberReferences: 16_384,
  maxJSONBytes: 1024 * 1024,
});
