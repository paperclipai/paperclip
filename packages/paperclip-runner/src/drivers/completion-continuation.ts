/** Fill provider bookkeeping only from a fresh, run-bound server read. */
export async function resolveCompletionContinuation(
  value: unknown,
  runId: string,
  readTaskContext?: () => Promise<unknown>,
): Promise<unknown> {
  const report = object(value);
  if (report.reportedWorkDisposition !== "yielded" || report.continuation != null) return value;
  const response = readTaskContext ? await readTaskContext() : null;
  const text = object(response).type === "inputText" ? object(response).text : response;
  let context: Record<string, unknown>;
  try { context = object(typeof text === "string" ? JSON.parse(text) : text); }
  catch { context = {}; }
  const task = object(context.activeTask);
  const continuation = object(context.completionContinuation);
  if (object(context.run).id !== runId || task.executionRunId !== runId ||
      continuation.kind !== "monitor" ||
      typeof continuation.summary !== "string" || !continuation.summary.trim() ||
      typeof continuation.idempotencyKey !== "string" || !continuation.idempotencyKey.trim()) {
    throw new Error("Cannot yield without a continuation: no eligible saved monitor exists on this task. Save a monitor with set_task_monitor, provide an explicit response_wake for a real response wait, or continue the unfinished work. Do not repeat completed actions.");
  }
  return { ...report, continuation: { kind: "monitor", summary: continuation.summary, idempotencyKey: continuation.idempotencyKey } };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
