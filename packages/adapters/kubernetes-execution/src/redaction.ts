export interface Redactor {
  redact(input: string): string;
  values(): readonly string[];
}

export function createRedactor(values: ReadonlyArray<string | undefined | null>): Redactor {
  const set = new Set<string>();
  for (const v of values) {
    if (typeof v === "string" && v.length >= 8) set.add(v);
  }
  // Sort longest-first so we don't redact a substring before its enclosing string.
  const sorted = [...set].sort((a, b) => b.length - a.length);
  return {
    values() { return sorted; },
    redact(input: string) {
      let out = input;
      for (const v of sorted) {
        if (v.length === 0) continue;
        // Escape regex metacharacters
        const pattern = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        out = out.replace(pattern, "<redacted>");
      }
      return out;
    },
  };
}

export const noopRedactor: Redactor = {
  redact: (s) => s,
  values: () => [],
};
