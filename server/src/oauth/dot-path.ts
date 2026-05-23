const BLOCKED = new Set(["__proto__", "prototype", "constructor"]);

export function getByPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined) return null;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (BLOCKED.has(part)) return null;
    if (current === null || current === undefined) return null;
    if (typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current ?? null;
}
