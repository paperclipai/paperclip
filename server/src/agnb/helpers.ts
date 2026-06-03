/** Normalize drizzle execute() result to a row array (pg returns {rows}, some drivers return array). */
export function rows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

/**
 * Build a Postgres array literal string for binding as a single param + cast,
 * e.g. `${pgTextArray(arr)}::text[]`. Avoids drizzle's `sql` tag spreading a JS
 * array into comma-separated params (which breaks an inline `::text[]` cast).
 */
export function pgTextArray(items: readonly string[]): string {
  return `{${items.map((s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}
