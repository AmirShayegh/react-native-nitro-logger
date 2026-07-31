import type { LogMetadata } from './types';
import {
  DROPPED_COUNT_KEY,
  UNREADABLE_VALUE,
  isValidMetadataKey,
} from './privacy';

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
 * **A key that cannot survive redaction has its value left unread.** A
 * malformed key, or the reserved `droppedMetadataCount`, is stored as
 * {@link UNREADABLE_VALUE} without the property ever being touched. That is
 * the whole point of validating first, and until 0.3.0 this loop did not do it:
 * `redactMetadata` was careful never to run a getter behind a rejected key,
 * and then the snapshot ran it anyway, at construction, before redaction had
 * seen anything. A scope built with a `patient.name` getter that phones home
 * fired it whether or not a single message was ever logged.
 *
 * Stored rather than skipped, for the same reason a throwing getter is: the key
 * must still reach redaction to be counted. Skipping would make scope defaults
 * under-report drops that call-site metadata reports correctly.
 *
 * **What cannot move here: the catalog.** `metadataKeyCatalog` intersects at
 * any time, so a key approved when a scope was constructed can be unapproved
 * by the time it emits. The catalog is therefore applied at emit and only
 * there, which means the honest form of the guarantee is: *a getter behind a
 * malformed or reserved key never runs; a getter behind an unapproved one runs
 * once, here, at construction.*
 *
 * The copy has a null prototype. Plain-object assignment would route a
 * `__proto__` key through `Object.prototype`'s legacy setter, silently
 * losing that value and letting a JS caller reshape the snapshot.
 *
 * Call-site metadata is deliberately NOT snapshotted — it goes to
 * `redactMetadata` as a source so its keys are validated, against the catalog
 * too, before any value is read.
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
    if (key === DROPPED_COUNT_KEY || !isValidMetadataKey(key)) {
      // Nothing this key holds can ever be rendered, so nothing reads it.
      value = UNREADABLE_VALUE;
    } else {
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
    }
    result[key] = value;
    count += 1;
  }
  return count > 0 ? result : undefined;
}
