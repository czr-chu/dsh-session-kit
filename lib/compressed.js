/**
 * dsh-session-kit — compressed ("structure kept, payloads bounded") session log.
 *
 * `full` keeps every byte and `compact` keeps only the conversation spine.
 * Compressed sits between them: every event keeps its type, `seq`, `time` and
 * order (so the result stays a legal v4 log with dense seq and intact
 * turn/step pairing), while streamed deltas are emptied and oversized strings
 * are truncated with an explicit marker.
 *
 * What this module changes:
 *  - `stream`, `chunks` and `deltas` arrays become `[]` — the message/tool
 *    structure stays, the incremental stream is dropped;
 *  - strings longer than `maxStringBytes` are cut and suffixed with a marker
 *    that records the original length;
 *  - when an event is still larger than `maxEventBytes` after truncation, the
 *    string budget is halved and the event is pruned again, so shapes (arrays,
 *    required keys) never break.
 * What it never changes: event types, event count, order, `seq`, `time`, and
 * every header field. Import therefore needs no special case; the archive is a
 * normal v4 log with a `session.compressed.v<n>.jsonl` name.
 *
 * Losses to expect: streamed reasoning/incremental output, and the tail of any
 * very large tool result, tool argument or message body. See
 * `docs/decisions/0001-compressed-export-mode.md`.
 *
 * @module dsh-session-kit/compressed
 */

/** Default budgets; callers may override both through the options object. */
export const COMPRESSED_DEFAULTS = Object.freeze({
  /** Longest single string kept, in UTF-8 bytes. */
  maxStringBytes: 8 * 1024,
  /** Target size for one event's JSON encoding, in UTF-8 bytes. */
  maxEventBytes: 16 * 1024,
});

/** Keys whose array payload is dropped (`[]`) instead of truncated. */
const DELTA_KEYS = new Set(['stream', 'chunks', 'deltas']);

/** True for a plain JSON object (never an array or null). */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** UTF-8 byte length of a string. */
function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Cut a string to a byte budget on code-point boundaries, appending a marker
 * that records the original length. Short strings are returned unchanged.
 * @param {string} value - candidate string.
 * @param {number} limit - byte budget; 0 disables truncation.
 * @returns {string} original or truncated string.
 */
function truncateString(value, limit) {
  if (limit <= 0 || byteLength(value) <= limit) return value;
  const marker = `\n…[dsh-session-kit compressed: 已截断，原长 ${[...value].length} 字符，上限 ${limit} 字节]`;
  const budget = Math.max(0, limit - byteLength(marker));
  let kept = '';
  let used = 0;
  for (const char of value) {
    const size = byteLength(char);
    if (used + size > budget) break;
    kept += char;
    used += size;
  }
  return kept + marker;
}

/**
 * Recursively prune one JSON value: strings are truncated, delta arrays are
 * emptied, arrays and objects keep their shape and key order.
 * @param {unknown} value - JSON value from an event payload.
 * @param {{maxStringBytes: number}} limits - active budgets.
 * @returns {unknown} pruned copy.
 */
function pruneValue(value, limits) {
  if (typeof value === 'string') return truncateString(value, limits.maxStringBytes);
  if (Array.isArray(value)) return value.map((member) => pruneValue(member, limits));
  if (!isRecord(value)) return value;
  const out = {};
  for (const [key, member] of Object.entries(value)) {
    if (DELTA_KEYS.has(key) && Array.isArray(member)) {
      out[key] = [];
      continue;
    }
    out[key] = pruneValue(member, limits);
  }
  return out;
}

/**
 * Prune one event, tightening the string budget when the first pass is still
 * over `maxEventBytes`. The event envelope (`type`, `seq`, `time`, other
 * fields) is copied unchanged.
 * @param {object} event - one canonical event.
 * @param {{maxStringBytes: number, maxEventBytes: number}} limits - budgets.
 * @returns {object} pruned event with the same envelope.
 */
function pruneEvent(event, limits) {
  const original = isRecord(event) ? event : {};
  const base = { ...original };
  let stringLimit = limits.maxStringBytes;
  let data = pruneValue(isRecord(original.data) ? original.data : {}, { maxStringBytes: stringLimit });
  let candidate = { ...base, data };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (byteLength(JSON.stringify(candidate)) <= limits.maxEventBytes) return candidate;
    stringLimit = Math.floor(stringLimit / 2);
    if (stringLimit < 256) return candidate;
    data = pruneValue(isRecord(original.data) ? original.data : {}, { maxStringBytes: stringLimit });
    candidate = { ...base, data };
  }
  return candidate;
}

/**
 * Normalize caller options, rejecting values that would make the transform
 * either a no-op or destructive.
 * @param {{maxStringBytes?: number, maxEventBytes?: number}} options - overrides.
 * @returns {{maxStringBytes: number, maxEventBytes: number}} resolved budgets.
 */
function resolveLimits(options) {
  const resolved = { ...COMPRESSED_DEFAULTS };
  for (const key of ['maxStringBytes', 'maxEventBytes']) {
    const value = options?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`compressSession 的 ${key} 必须是正整数`);
    }
    resolved[key] = value;
  }
  return resolved;
}

/**
 * Build one compressed, standalone, importable v4 log from a full session log.
 *
 * The header is cloned verbatim: compressed keeps the session's identity and
 * lineage fields, unlike `compactSession`, which rebuilds a root header.
 * @param {{header: object, events: ReadonlyArray<object>}} log - one full session log.
 * @param {{maxStringBytes?: number, maxEventBytes?: number}} [options] - budgets.
 * @returns {{header: object, events: Array<object>}} the compressed log.
 * @throws {TypeError} when the input is not a session log.
 */
export function compressSession({ header, events } = {}, options = {}) {
  if (!isRecord(header) || typeof header.id !== 'string' || header.id === '') {
    throw new TypeError('compressSession 需要带 id 的会话头对象');
  }
  if (!Array.isArray(events)) throw new TypeError('compressSession 需要事件数组');
  const limits = resolveLimits(options);
  return { header: structuredClone(header), events: events.map((event) => pruneEvent(event, limits)) };
}
