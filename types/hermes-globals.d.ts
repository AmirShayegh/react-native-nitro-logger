/**
 * Globals Hermes provides that React Native's TypeScript types do not yet
 * declare.
 *
 * `TextEncoder` shipped in Hermes in February 2024 (facebook/hermes commits
 * 8fb0496 "Add TextEncoder class", 7f9d9d5 "Add TextEncoder.prototype
 * .encode()", 3863a36 "…encodeInto()"), so it is present in the Hermes of
 * every React Native this package supports — the floor is 0.78, cut a year
 * later. The batcher encodes each batch with it exactly once
 * (`src/destinations/Batcher.ts`).
 *
 * `TextDecoder` is declared for the TEST double only
 * (`__tests__/helpers/MemoryFileSink.ts`, running under Node, which has it);
 * nothing under `src/` may use it, because Hermes at the floor does not
 * ship it.
 *
 * Declared at exactly the surface this repository uses, nothing more. This
 * file is compiler input, not part of the published types — declaration
 * emit never re-emits a `.d.ts` input — so consumers see none of it. If a
 * future react-native types package declares these, TypeScript will report
 * duplicate identifiers here; delete this file then.
 */
declare class TextEncoder {
  /** Always a fresh, non-shared allocation — hence `<ArrayBuffer>`. */
  encode(input?: string): Uint8Array<ArrayBuffer>;
}

declare class TextDecoder {
  decode(input?: ArrayBuffer | ArrayBufferView): string;
}
