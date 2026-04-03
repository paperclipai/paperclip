import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

type IssueAssignmentWakeupIssue = {
  id: string;
  assigneeAgentId: string | null;
  status: string;
  executionRunId?: string | null;
};

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

export function getIssueAssignmentWakeupSuppressionReason(issue: IssueAssignmentWakeupIssue) {
  if (!issue.assigneeAgentId) return "unassigned";
  if (issue.status === "backlog") return "backlog";
  if (issue.status === "blocked") return "blocked";
  if (issue.status === "done") return "done";
  if (issue.status === "cancelled") return "cancelled";
  if (issue.executionRunId) return "execution_already_locked";
  return null;
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: IssueAssignmentWakeupIssue;
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  const suppressionReason = getIssueAssignmentWakeupSuppressionReason(input.issue);
  if (suppressionReason) {
    logger.debug(
      { issueId: input.issue.id, suppressionReason },
      "suppressed assignment wakeup for issue",
    );
    return;
  }
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
