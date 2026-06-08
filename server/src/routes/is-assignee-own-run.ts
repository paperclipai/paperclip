export interface IsAssigneeOwnRunActor {
  actorType: "agent" | "board" | "user" | string;
  actorId: string;
  runId?: string | null;
}

export interface IsAssigneeOwnRunIssue {
  assigneeAgentId?: string | null;
  checkoutRunId?: string | null;
  executionRunId?: string | null;
}

/**
 * Returns true when `actor` is the assignee of `issue` itself, OR when the
 * actor is acting under the assignee's currently-active checkout or execution
 * run (covers sub-agent / proxy posts authored on behalf of the assignee).
 *
 * Used to suppress phantom self-wakes (`issue_commented`, `issue_status_changed`)
 * that would otherwise re-fire the same agent's heartbeat in a loop.
 */
export function isAssigneeOwnRun(input: {
  actor: IsAssigneeOwnRunActor;
  issue: IsAssigneeOwnRunIssue;
}): boolean {
  const { actor, issue } = input;
  const assigneeId = issue.assigneeAgentId;
  if (!assigneeId) return false;
  if (actor.actorType !== "agent") return false;
  if (actor.actorId === assigneeId) return true;
  const runId = actor.runId;
  if (!runId) return false;
  return runId === issue.checkoutRunId || runId === issue.executionRunId;
}
