import type {
  LogMetadata,
  LogPrimitive,
  LogValue,
  RedactedMetadata,
} from './types';

/**
 * The privacy layer, deliberately a single module.
 *
 * Marker inspection and redaction live together so that payload recovery
 * stays closure-private. If `inspectMarker` were exported, anyone could deep
 * import the compiled module and read back a `priv()` payload in production,
 * which would defeat the whole no-reveal contract regardless of what the
 * package entry point re-exports. Nothing here that can return a payload
 * crosses the module boundary.
 */

/** What a redacted value renders as in a log line. */
export const PRIVATE_PLACEHOLDER = '<private>';

/** What a marker renders as if it is stringified directly (interpolated into
 * a message, spread, inspected). Never the payload — a marker leaking its
 * value through `String()` would defeat the whole contract. */
const MARKER_PLACEHOLDER = '<redacted>';

/**
 * Metadata keys are structural, never data. Anything outside this shape is
 * a sign a value was used as a key — the classic `patient123: …` leak.
 *
 * The enforcing RegExp is module-private and only its source is exported. A
 * shared RegExp object is mutable: a consumer could assign an own `test`
 * method or call `RegExp.prototype.compile` on it and silently disable key
 * validation for the whole process. Callers that want to pre-check a key
 * build their own from {@link METADATA_KEY_PATTERN_SOURCE}.
 */
const METADATA_KEY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Source text of the key rule, for callers that want their own RegExp. */
export const METADATA_KEY_PATTERN_SOURCE = '^[A-Za-z0-9._-]{1,64}$';

/**
 * Whether a key may carry a value at all.
 *
 * Exported module-to-module, **not** through the package barrel: the string
 * form of the rule is the public surface ({@link METADATA_KEY_PATTERN_SOURCE}),
 * and a shared predicate would be one more thing a consumer could come to
 * depend on. `safeSnapshotMetadata` needs it so a scope snapshot can refuse a
 * key before it reads the getter behind it — the same order `redactMetadata`
 * keeps, and the reason that order is worth anything.
 */
export function isValidMetadataKey(key: string): boolean {
  return METADATA_KEY_PATTERN.test(key);
}

/** Reserved key carrying the fixed diagnostic: how many entries this call
 * dropped. A count only — never which keys, never why, never the values. */
export const DROPPED_COUNT_KEY = 'droppedMetadataCount';

/** Upper bound on catalog size. A hostile or accidental infinite iterable
 * must not be able to hang the JS thread inside a logging config call. */
export const MAX_CATALOG_SIZE = 4096;

declare const publicBrand: unique symbol;
declare const privateBrand: unique symbol;

/** A value explicitly marked safe to render. Opaque: the payload lives in a
 * module-private WeakMap, never on the object. */
export interface PublicValue {
  readonly [publicBrand]: true;
}

/** A value explicitly marked sensitive. Renders as `<private>` outside dev. */
export interface PrivateValue {
  readonly [privateBrand]: true;
}

// Membership in these maps is the ONLY proof that an object is a marker.
// A foreign lookalike — same shape, same toString — fails naturally because
// it was never registered here, and no code outside this module can register
// one. WeakMaps also keep the payload unreachable: there is no enumerable
// field to spread, stringify, or inspect.
const publicPayloads = new WeakMap<object, LogPrimitive>();
const privatePayloads = new WeakMap<object, LogPrimitive>();
const invalidMarkers = new WeakSet<object>();

/**
 * Exactly the primitives the pipeline can render. Objects, arrays, proxies,
 * functions, symbols, null/undefined, NaN and the infinities are all
 * rejected — an object payload is the classic way PHI slips into a log.
 */
function isLogPrimitive(value: unknown): value is LogPrimitive {
  const kind = typeof value;
  return (
    kind === 'string' ||
    kind === 'boolean' ||
    (kind === 'number' && Number.isFinite(value))
  );
}

function createMarker(): object {
  const marker = {};
  const hide = (key: PropertyKey, value: unknown): void => {
    Object.defineProperty(marker, key, {
      value,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  };
  const placeholder = (): string => MARKER_PLACEHOLDER;
  // Non-enumerable, so `{...marker}` and `Object.keys(marker)` see nothing.
  hide('toString', placeholder);
  hide('toJSON', placeholder);
  hide(Symbol.toPrimitive, placeholder);
  hide(Symbol.for('nodejs.util.inspect.custom'), placeholder);
  hide(Symbol.toStringTag, 'RedactedLogValue');
  return Object.freeze(marker);
}

/**
 * Mark a value safe to render even under a `'private'` privacy default.
 *
 * The payload is validated here AND again at emit: `pub(patient as any)`
 * must not smuggle an object past the primitive check. An invalid payload
 * does not throw — logging never crashes the caller — it produces a marker
 * that is dropped at emit and counted in the fixed diagnostic.
 */
export function pub(value: LogPrimitive): PublicValue {
  const marker = createMarker();
  if (isLogPrimitive(value)) {
    publicPayloads.set(marker, value);
  } else {
    invalidMarkers.add(marker);
  }
  return marker as PublicValue;
}

/** Mark a value sensitive: renders as `<private>` outside dev builds, even
 * under a `'public'` privacy default. Same fail-closed validation as `pub`. */
export function priv(value: LogPrimitive): PrivateValue {
  const marker = createMarker();
  if (isLogPrimitive(value)) {
    privatePayloads.set(marker, value);
  } else {
    invalidMarkers.add(marker);
  }
  return marker as PrivateValue;
}

/**
 * Stands in for a value that could not be read when a snapshot was taken —
 * a getter that threw while a scope was being constructed.
 *
 * It is registered as an invalid marker, so redaction drops it and counts
 * it like any other rejected value. Without it the key would vanish at
 * snapshot time and never appear in `droppedMetadataCount`, which is the
 * one thing a silent drop must never do. It carries no payload.
 */
export const UNREADABLE_VALUE: LogValue = (() => {
  const marker = createMarker();
  invalidMarkers.add(marker);
  return marker as LogValue;
})();

type MarkerInspection =
  | { readonly kind: 'public'; readonly payload: LogPrimitive }
  | { readonly kind: 'private'; readonly payload: LogPrimitive }
  | { readonly kind: 'invalid' };

/**
 * Module-private by design — see the note at the top of this file.
 *
 * One probe per map rather than `has` followed by `get`. `undefined` from
 * `get` means absent and can mean nothing else: `pub`/`priv` call `set` only
 * after `isLogPrimitive` has passed, and `isLogPrimitive(undefined)` is
 * false, so no registered marker holds `undefined`. The `has` was asking a
 * question the `get` already answered.
 *
 * The re-validation below is NOT the same kind of redundancy and stays.
 * Construction validated the payload; this validates it again at emit,
 * which is the stated contract — the WeakMap is module-private but the
 * check is what makes "validated at construction AND at emit" true rather
 * than a claim about code nobody re-reads.
 */
function inspectMarker(value: unknown): MarkerInspection | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as object;

  const publicPayload = publicPayloads.get(candidate);
  if (publicPayload !== undefined) {
    return isLogPrimitive(publicPayload)
      ? { kind: 'public', payload: publicPayload }
      : { kind: 'invalid' };
  }
  const privatePayload = privatePayloads.get(candidate);
  if (privatePayload !== undefined) {
    return isLogPrimitive(privatePayload)
      ? { kind: 'private', payload: privatePayload }
      : { kind: 'invalid' };
  }
  if (invalidMarkers.has(candidate)) return { kind: 'invalid' };
  return null;
}

// The reveal branch exists only in dev builds. Metro substitutes a literal
// for `__DEV__`, so in a release bundle the whole block — sentinel string
// included — is dead code and gets stripped. M7's CI job greps the release
// bundle for the sentinel to prove it.
let revealBranchSentinel = '';

/** True when private values may render as themselves: dev builds only.
 * There is deliberately no runtime switch to turn this on in production. */
function privateRevealAllowed(): boolean {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    revealBranchSentinel = '__NITRO_LOGGER_PRIVATE_REVEAL__';
    return true;
  }
  return false;
}

/** @internal Test/CI hook — non-empty only once the dev reveal branch ran.
 * Returns a build-time marker, never a payload. */
export function __revealBranchSentinel(): string {
  return revealBranchSentinel;
}

// ── Configuration ───────────────────────────────────────────────────────────

export type PrivacyDefault = 'public' | 'private';

export interface PrivacySettings {
  /** `'private'` redacts bare values outside dev; `'public'` renders them. */
  readonly privacyDefault: PrivacyDefault;
  /** Kill switch: redact every value regardless of marker or build type. */
  readonly redactAll: boolean;
  /** Approved metadata keys. Undefined means "no catalog configured". */
  readonly keyCatalog: ReadonlySet<string> | undefined;
}

/**
 * Coerce a caller-supplied privacy default. TypeScript's union is not a
 * runtime guarantee — JS callers, JSON config, and `any` all reach here — so
 * anything that is not exactly `'public'` or `'private'` resolves to
 * `'private'`. Ambiguity must never resolve toward disclosure.
 */
export function normalizePrivacyDefault(value: unknown): PrivacyDefault {
  return value === 'public' ? 'public' : 'private';
}

/**
 * Build a catalog from caller-supplied input without trusting it. A
 * non-iterable, an iterator that throws mid-way, a non-string entry, or an
 * iterable longer than {@link MAX_CATALOG_SIZE} all yield an empty set: the
 * caller's tighten-only intent is honored in the safest possible direction,
 * and a runaway iterable cannot hang the JS thread.
 */
export function buildCatalog(keys: unknown): Set<string> {
  const result = new Set<string>();
  if (keys === null || typeof keys !== 'object') return result;
  try {
    // Bound on entries CONSUMED, not on set size: an iterator that yields
    // the same valid key forever never grows the set, so a size-based bound
    // would spin the JS thread indefinitely.
    let consumed = 0;
    for (const key of keys as Iterable<unknown>) {
      if (++consumed > MAX_CATALOG_SIZE) return new Set();
      if (typeof key !== 'string' || !isValidMetadataKey(key)) {
        return new Set();
      }
      result.add(key);
    }
  } catch {
    return new Set();
  }
  return result;
}

/**
 * Whether an unconfigured catalog blocks everything.
 *
 * Under a `'private'` default — the telehealth/strict profile — the catalog
 * is mandatory and fail-closed: rejecting computed keys is not enough, since
 * a literal key like `patient123` is still PHI. With no catalog configured,
 * no key is approved and all metadata drops. That is deliberate; it forces
 * the app to declare its keys rather than failing open.
 */
function catalogRequired(settings: PrivacySettings): boolean {
  return settings.privacyDefault === 'private';
}

// ── Redaction ───────────────────────────────────────────────────────────────

/**
 * "This value does not go out", as a value rather than a wrapper.
 *
 * A unique Symbol, module-private, so it cannot equal anything a caller can
 * put in metadata — which is what lets {@link resolveValue} return the
 * payload itself instead of allocating a `{ kind, value }` object per key.
 *
 * The reason it is a Symbol and not `undefined` or `null` is the mistake it
 * makes unavailable. A resolution tested with `if (!resolution)` would drop
 * `0`, `false` and `''` — all legitimate, all things a logger is asked to
 * record, and all silently missing from the output with the dropped-count
 * dutifully incremented. `=== DROP` cannot express that bug.
 */
const DROP: unique symbol = Symbol('privacy.drop');

type Resolution = LogPrimitive | typeof DROP;

/** Record which source owns each of its keys, without reading any value. */
function claimKeys(
  owner: Map<string, Record<string, unknown>>,
  source: LogMetadata | undefined
): void {
  if (!source) return;
  let keys: string[];
  try {
    keys = Object.keys(source);
  } catch {
    return;
  }
  for (const key of keys) {
    owner.set(key, source as Record<string, unknown>);
  }
}

function resolveValue(raw: unknown, settings: PrivacySettings): Resolution {
  let visibility: PrivacyDefault;
  let payload: LogPrimitive;

  const marker = inspectMarker(raw);
  if (marker !== null) {
    // A marker whose payload failed validation at construction or here —
    // `pub(someObject as any)` — fails closed rather than rendering.
    if (marker.kind === 'invalid') return DROP;
    visibility = marker.kind;
    payload = marker.payload;
  } else if (isLogPrimitive(raw)) {
    visibility = settings.privacyDefault;
    payload = raw;
  } else {
    // Objects, arrays, proxies, functions, symbols, null, NaN, Infinity.
    return DROP;
  }

  if (settings.redactAll) return PRIVATE_PLACEHOLDER;
  if (visibility === 'public') return payload;
  return privateRevealAllowed() ? payload : PRIVATE_PLACEHOLDER;
}

/**
 * Resolve caller metadata into what destinations may see.
 *
 * Takes metadata as ordered sources — a scope's defaults followed by the
 * call site's — rather than a pre-merged object. Merging eagerly would read
 * every value before any key was checked, which is exactly what this
 * function exists to avoid: precedence is settled per key first, then the
 * winning key is validated, and only a key that survives has its value read.
 * A getter behind a malformed, reserved, or unapproved key therefore never
 * runs *here*, and neither does a getter the call site overrode.
 *
 * Said precisely, because one of the two sources has already been through a
 * snapshot: a getter behind a malformed or reserved key never runs at all —
 * `safeSnapshotMetadata` applies the same key rule before it reads. A getter
 * behind an *unapproved* key is different: the catalog can be tightened at any
 * time, so it cannot be consulted at snapshot time, and a scope default the
 * catalog later rejects has already been read once, at construction. Call-site
 * metadata, which is never snapshotted, is unread in every one of those cases.
 *
 * Every rejection — bad key, throwing getter, unsupported value —
 * increments one count. The count is all that is reported: the diagnostic
 * itself must not become the leak.
 *
 * The result is a frozen null-prototype object. A source whose keys cannot
 * be enumerated at all (a Proxy with a throwing `ownKeys` trap) contributes
 * nothing, since there is no key that could be safely counted or described.
 */
export function redactMetadata(
  scopeMetadata: LogMetadata | undefined,
  callSiteMetadata: LogMetadata | undefined,
  settings: PrivacySettings
): RedactedMetadata | undefined {
  // Two explicit positional sources rather than a collection. A container
  // in the signature would itself be caller-controlled — a hostile array
  // could throw from Symbol.iterator, iterate forever, or be a revoked
  // Proxy — and guarding it is strictly more work than not having one.
  const owner = new Map<string, Record<string, unknown>>();
  claimKeys(owner, scopeMetadata);
  // Second wins on collision: the call site overrides the scope's default.
  claimKeys(owner, callSiteMetadata);
  if (owner.size === 0) return undefined;

  const catalog = settings.keyCatalog;
  const requireCatalog = catalogRequired(settings);

  const result: Record<string, LogPrimitive> = Object.create(null);
  let dropped = 0;

  for (const [key, source] of owner) {
    if (key === DROPPED_COUNT_KEY || !isValidMetadataKey(key)) {
      dropped += 1;
      continue;
    }
    if (catalog !== undefined ? !catalog.has(key) : requireCatalog) {
      dropped += 1;
      continue;
    }

    // Only now — after the key has earned it — is the value touched.
    let raw: unknown;
    try {
      raw = source[key];
    } catch {
      dropped += 1;
      continue;
    }

    // Identity against the sentinel, never truthiness: `0`, `false` and `''`
    // are values this logger is asked to record, not absences.
    const resolution = resolveValue(raw, settings);
    if (resolution === DROP) {
      dropped += 1;
      continue;
    }
    result[key] = resolution;
  }

  if (dropped > 0) result[DROPPED_COUNT_KEY] = dropped;
  return Object.freeze(result);
}
