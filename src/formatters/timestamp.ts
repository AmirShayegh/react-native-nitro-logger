/** Local-time `HH:mm:ss.SSS`, matching SwiftLogger's console timestamp.
 * Takes epoch milliseconds (see `LogEntry.timestamp`); plain Date getters +
 * zero-pad — none of the Swift version's caching is needed, these are cheap
 * in JS. */
export function formatTime(epochMs: number): string {
  const date = new Date(epochMs);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}
