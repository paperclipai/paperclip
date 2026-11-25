export const MODEL_HIDDEN_RUN_ID_KEYS: ReadonlySet<string> = new Set([
  "runId",
  "createdByRunId",
  "sourceRunId",
  "baseRunId",
  "interruptedRunId",
  "retryOfRunId",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function withoutModelHiddenRunIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutModelHiddenRunIds(item)) as T;
  if (!isPlainObject(value)) return value;
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!MODEL_HIDDEN_RUN_ID_KEYS.has(key)) {
      projected[key] = withoutModelHiddenRunIds(entry);
    } else if (key === "createdByRunId" && entry && value.authorType === "user") {
      projected[key] = true;
    }
  }
  return projected as T;
}
