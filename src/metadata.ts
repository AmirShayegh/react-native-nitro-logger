import type { LogMetadata } from './types';
import { UNREADABLE_VALUE } from './privacy';

/**
 * Copies caller metadata with per-property isolation, for the one place a
 * snapshot is genuinely required: a scope's defaults, captured once at
 * construction so later mutation of the caller's object cannot change what
 * future messages report.
 *
 * Caller objects are untrusted. A Proxy with a throwing `ownKeys` trap
 * yields `undefined` — the whole object is dropped, payload-free. A throwing
 * property getter keeps the key but substitutes {@link UNREADABLE_VALUE}, so
 * redaction still sees the key, rejects it, and counts it; dropping the key
 * here would make it disappear from `droppedMetadataCount` entirely.
 *
 * The copy has a null prototype. Plain-object assignment would route a
 * `__proto__` key through `Object.prototype`'s legacy setter, silently
 * losing that value and letting a JS caller reshape the snapshot.
 *
 * Call-site metadata is deliberately NOT snapshotted — it goes to
 * `redactMetadata` as a source so its keys are validated before any value
 * is read.
 */
export function safeSnapshotMetadata(
  metadata: LogMetadata | undefined
): LogMetadata | undefined {
  if (!metadata) return undefined;
  let keys: string[];
  try {
    keys = Object.keys(metadata);
  } catch {
    return undefined;
  }
  const result: LogMetadata = Object.create(null);
  let count = 0;
  for (const key of keys) {
    let value: LogMetadata[string];
    try {
      const read = metadata[key] as LogMetadata[string] | undefined;
      // An `undefined` value is a rejected value, not an absent key. Skipping
      // it here would make the key vanish before redaction could count it,
      // so scope defaults would under-report drops that direct metadata
      // reports correctly.
      value = read === undefined ? UNREADABLE_VALUE : read;
    } catch {
      value = UNREADABLE_VALUE;
    }
    result[key] = value;
    count += 1;
  }
  return count > 0 ? result : undefined;
}
