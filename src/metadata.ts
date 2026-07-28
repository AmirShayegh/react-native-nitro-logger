import type { LogMetadata } from './types';

/**
 * Copies caller metadata with per-property isolation. Caller objects are
 * untrusted: a Proxy with a throwing `ownKeys` trap yields `undefined`
 * (payload-free — the whole object is dropped), and a throwing property
 * getter drops only that key. Logging must never crash the app.
 *
 * The copy has a null prototype. Plain-object assignment would route a
 * `__proto__` key through `Object.prototype`'s legacy setter, silently
 * losing that value and letting a JS caller reshape the snapshot.
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
    let value: LogMetadata[string] | undefined;
    try {
      value = metadata[key];
    } catch {
      continue;
    }
    if (value === undefined) continue;
    result[key] = value;
    count += 1;
  }
  return count > 0 ? result : undefined;
}
