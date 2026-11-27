export const MODEL_HIDDEN_RUN_ID_KEYS: ReadonlySet<string> = new Set([
  "runId",
  "baseRunId",
  "createdByRunId",
  "executionRunId",
  "failedRunId",
  "interruptedRunId",
  "previousContextRunId",
  "previousRunId",
  "producerRunId",
  "requestedSourceRunId",
  "requeueSourceRunId",
  "resolvedByRunId",
  "resumeSourceRunId",
  "retryOfRunId",
  "reviewerRunId",
  "sourceRunId",
]);

export type ModelFacingValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Date
  | ModelFacingValue[]
  | { [key: string]: ModelFacingValue };

export type ModelFacingObject = { [key: string]: ModelFacingValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function withoutModelHiddenRunIds(value: unknown): ModelFacingValue {
  if (Array.isArray(value)) return value.map((item) => withoutModelHiddenRunIds(item));
  if (!isPlainObject(value)) return value as ModelFacingValue;
  const projected: ModelFacingObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!MODEL_HIDDEN_RUN_ID_KEYS.has(key)) {
      projected[key] = withoutModelHiddenRunIds(entry);
    } else if (key === "createdByRunId" && entry && value.authorType === "user") {
      projected[key] = true;
    }
  }
  return projected;
}

export function modelFacingObject(value: Record<string, unknown>): ModelFacingObject {
  return withoutModelHiddenRunIds(value) as ModelFacingObject;
}
