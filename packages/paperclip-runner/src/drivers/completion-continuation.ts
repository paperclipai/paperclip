/** Fill provider bookkeeping only from a fresh, run-bound server read. */
export async function resolveCompletionContinuation(
  value: unknown,
  runId: string,
  readTaskContext?: () => Promise<unknown>,
): Promise<unknown> {
  const report = object(value);
  const supplied = object(report.continuation);
  if (report.reportedWorkDisposition !== "yielded" || (report.continuation != null && supplied.kind !== "same_agent")) return value;
  const response = readTaskContext ? await readTaskContext() : null;
  const text = object(response).type === "inputText" ? object(response).text : response;
  let context: Record<string, unknown>;
  try { context = object(typeof text === "string" ? JSON.parse(text) : text); }
  catch { context = {}; }
  const task = object(context.activeTask);
  const continuation = object(context.completionContinuation);
  if (object(context.run).id !== runId || task.executionRunId !== runId ||
      !["monitor", "same_agent"].includes(String(continuation.kind)) ||
      typeof continuation.summary !== "string" || !continuation.summary.trim() ||
      typeof continuation.idempotencyKey !== "string" || !continuation.idempotencyKey.trim()) {
    throw new Error("Cannot yield without a continuation: no eligible saved monitor or workspace continuation exists on this task. Save a monitor for a deferred check, provide an explicit response_wake for a real response wait, or continue the unfinished work. Do not repeat completed actions.");
  }
  if (report.continuation != null && (continuation.kind !== "same_agent" || supplied.summary !== continuation.summary ||
      supplied.idempotencyKey !== continuation.idempotencyKey)) {
    throw new Error("The supplied workspace continuation does not match current server-owned task state. Read the current task context and preserve its authority.");
  }
  return { ...report, continuation: { kind: continuation.kind, summary: continuation.summary, idempotencyKey: continuation.idempotencyKey } };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
