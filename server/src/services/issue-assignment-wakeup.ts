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
  requestedByActorRunId?: string | null;
  rethrowOnError?: boolean;
}) {
  if (issueAssignmentWakeupSkipReason(input)) return;
  const assigneeAgentId = input.issue.assigneeAgentId;
  if (!assigneeAgentId) return;

  return input.heartbeat
    .wakeup(assigneeAgentId, {
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

export function issueAssignmentWakeupSkipReason(input: {
  issue: { assigneeAgentId: string | null; status: string };
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  requestedByActorRunId?: string | null;
}) {
  if (!input.issue.assigneeAgentId) return "no_agent_assignee";
  if (input.issue.status === "backlog") return "assigned_backlog";
  if (
    input.requestedByActorType === "agent" &&
    Boolean(input.requestedByActorRunId) &&
    input.requestedByActorId === input.issue.assigneeAgentId
  ) {
    return "self_assignment";
  }
  return null;
}
