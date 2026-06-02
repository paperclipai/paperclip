/** Normalize drizzle execute() result to a row array (pg returns {rows}, some drivers return array). */
export function rows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}
