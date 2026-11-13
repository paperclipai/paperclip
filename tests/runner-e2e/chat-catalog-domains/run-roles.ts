/**
 * Run accounting by role instead of raw count. A case admits a run above its
 * minimum only when the run is a product-caused continuation of declared work:
 * the assignee of a task woken by a comment that a named run saved on that task,
 * or the CEO's completion follow-up after a chat-created task finished. Anything
 * else stays extra work and must still fail the case.
 */
export interface RoleRun {
  id: string; agentId?: string | null; status?: string; issueId?: string | null; nativeIssueId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
}
export interface RoleComment { id: string; issueId?: string | null; companyId?: string | null; authorAgentId?: string | null; createdByRunId?: string | null }

export function runIssueId(run: RoleRun): string | undefined {
  const value = run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.issueId;
  return typeof value === "string" && value ? value : undefined;
}
/** The run's agent was woken on `issueId` by the exact comment it names, and a
 * run in `causeRunIds` saved that comment on the same task. */
export function commentWokenRun(run: RoleRun, input: { agentId: string; issueId: string; comments: RoleComment[]; causeRunIds: readonly string[] }): boolean {
  const commentId = run.contextSnapshot?.commentId ?? run.contextSnapshot?.wakeCommentId;
  if (run.agentId !== input.agentId || runIssueId(run) !== input.issueId || typeof commentId !== "string") return false;
  return input.comments.some(row => row.id === commentId && row.issueId === input.issueId && !!row.createdByRunId && input.causeRunIds.includes(row.createdByRunId));
}
/** Comment-woken continuations of `agentId` on `issueId`, at most one per causing run. Undefined when any
 * causing run woke the agent more than once (duplicate or runaway work). */
export function commentWokenContinuations(runs: RoleRun[], input: Parameters<typeof commentWokenRun>[1]): RoleRun[] | undefined {
  const admitted = runs.filter(run => commentWokenRun(run, input));
  const byCause = new Map<string, number>();
  for (const run of admitted) {
    const commentId = String(run.contextSnapshot?.commentId ?? run.contextSnapshot?.wakeCommentId);
    const cause = input.comments.find(row => row.id === commentId)!.createdByRunId!;
    byCause.set(cause, (byCause.get(cause) ?? 0) + 1);
  }
  return [...byCause.values()].every(count => count === 1) ? admitted : undefined;
}
/** The product's automatic follow-up on the source chat after its delegated task completed. */
export function chatCompletionFollowUp(run: RoleRun, input: { leadId: string; sourceId: string; taskId: string }): boolean {
  const snapshot = run.contextSnapshot ?? {};
  const wake = (snapshot.paperclipWake ?? {}) as Record<string, unknown>;
  const updates = Array.isArray(snapshot.chatCompletionUpdates) ? snapshot.chatCompletionUpdates : wake.chatCompletionUpdates;
  return run.agentId === input.leadId && runIssueId(run) === input.sourceId && snapshot.wakeReason === "chat_task_completed"
    && Array.isArray(updates) && updates.length > 0 && updates.every(row => (row as { id?: string } | null)?.id === input.taskId);
}
