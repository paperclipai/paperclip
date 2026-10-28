/** A terminal child does not mean the parent has processed its completion wake. */
export function continuationInitialReady(interactions: ReadonlyArray<{ kind?: unknown; status?: unknown }>): boolean {
  return interactions.some((i) => i.kind === "ask_user_questions" && i.status === "pending");
}

/** A successful click can return before the form POST commits. Do not accept
 * the original paused run as the result of the answer we just submitted. */
export function continuationAnswerCommitted(interactions: ReadonlyArray<{ id?: unknown; status?: unknown }>, interactionId?: string): boolean {
  return !interactionId || interactions.some(i => i.id === interactionId && i.status === "answered");
}


/** Run completion precedes task-lock release. Observe both before taking a
 * checkpoint, even when the terminal run status is stable across many polls. */
export function continuationCheckpointReady(input: {
  issue: { status: string; executionRunId?: string | null };
  runs: ReadonlyArray<{ id: string; status: string; runtimeMode?: string }>;
  interactions: ReadonlyArray<{ id?: unknown; kind?: unknown; status?: unknown;
    sourceRunId?: unknown; payload?: { runtimeRequestId?: unknown } }>;
}): boolean {
  if (!input.runs.length) return false;
  const active = input.runs.filter(run => ["running", "queued"].includes(run.status));
  const pending = input.interactions.filter(i => i.status === "pending");
  if (active.length === 0) {
    const waiting = pending.some(i => ["ask_user_questions", "request_confirmation", "request_approval"].includes(String(i.kind)));
    return input.issue.executionRunId === null && (!waiting || input.issue.status === "in_review");
  }
  if (active.length !== 1) return false;
  const run = active[0];
  return run.status === "running" && run.runtimeMode === "native" &&
    input.issue.executionRunId === run.id && ["in_progress", "in_review"].includes(input.issue.status) &&
    pending.some(i => i.kind === "ask_user_questions" && typeof i.id === "string" && !!i.id.trim() &&
      i.sourceRunId === run.id && typeof i.payload?.runtimeRequestId === "string" && !!i.payload.runtimeRequestId.trim());
}
