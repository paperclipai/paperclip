export const RESULT_TEXT_KEYS = ["summary", "result", "message", "text", "output", "content", "body"];

export function withoutActionResults(value: unknown, actionRequestIds: ReadonlySet<string>): { value: unknown; changed: boolean } {
  let changed = false;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) next[key] = walk(entry);
    if (typeof record.actionRequestId === "string" && actionRequestIds.has(record.actionRequestId)
      && typeof record.resultSummary === "string" && record.resultSummary !== "") {
      next.resultSummary = "";
      changed = true;
    }
    return next;
  };
  const result = walk(value);
  return { value: changed ? result : value, changed };
}

export function withoutResultText(value: Record<string, unknown> | null): { value: Record<string, unknown> | null; changed: boolean } {
  if (!value || typeof value !== "object") return { value, changed: false };
  let changed = false;
  const walk = (node: unknown, topLevel: boolean): unknown => {
    if (Array.isArray(node)) return node.map((entry) => walk(entry, false));
    if (!node || typeof node !== "object") return node;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(node as Record<string, unknown>)) {
      if (RESULT_TEXT_KEYS.includes(key) && typeof entry === "string") {
        if (entry !== "") changed = true;
        if (!topLevel) next[key] = "";
        else if (entry === "") next[key] = entry;
        continue;
      }
      next[key] = walk(entry, false);
    }
    return next;
  };
  const next = walk(value, true) as Record<string, unknown>;
  return { value: changed ? next : value, changed };
}
