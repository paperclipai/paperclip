/**
 * Strip PostgreSQL-incompatible null bytes (\u0000 / 0x00) from values
 * before inserting into TEXT or JSONB columns.
 *
 * PostgreSQL rejects null bytes in both TEXT and JSONB with:
 *   - "unsupported Unicode escape sequence"
 *   - "invalid byte sequence for encoding UTF8: 0x00"
 *
 * This is needed because some adapters (notably Gemini) may emit null bytes
 * in their stdout.
 */
export function stripNullBytes<T>(value: T): T {
  if (typeof value === "string") {
    // eslint-disable-next-line no-control-regex
    return value.replace(/\x00/g, "") as T;
  }
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stripNullBytes) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stripNullBytes(v);
    }
    return out as T;
  }
  return value;
}
