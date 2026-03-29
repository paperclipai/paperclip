import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  const normalizedIssueStatus = typeof input.issue.status === "string"
    ? input.issue.status.trim().toLowerCase()
    : "";
  const normalizedAssigneeAgentId = typeof input.issue.assigneeAgentId === "string"
    ? input.issue.assigneeAgentId.trim().toLowerCase()
    : null;
  const normalizedRequestedByActorId = typeof input.requestedByActorId === "string"
    ? input.requestedByActorId.trim().toLowerCase()
    : null;
  if (
    !input.issue.assigneeAgentId ||
    normalizedIssueStatus === "backlog" ||
    normalizedIssueStatus === "done" ||
    normalizedIssueStatus === "cancelled"
  ) return;
  if (
    input.requestedByActorType === "agent" &&
    normalizedRequestedByActorId &&
    normalizedAssigneeAgentId &&
    normalizedRequestedByActorId === normalizedAssigneeAgentId
  ) {
    return;
  }

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issue.id, source: input.contextSource },
    })
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
