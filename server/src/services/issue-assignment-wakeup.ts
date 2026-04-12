import { logger } from "../middleware/logger.js";
import { getAgentNotInvokableStatus, isAgentNotInvokableWakeupError } from "./wakeup-errors.js";

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
  if (
    !input.issue.assigneeAgentId ||
    input.issue.status === "backlog" ||
    input.issue.status === "done" ||
    input.issue.status === "cancelled"
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
      contextSnapshot: {
        issueId: input.issue.id,
        taskId: input.issue.id,
        wakeReason: input.reason,
        source: input.contextSource,
      },
    })
    .catch((err) => {
      if (isAgentNotInvokableWakeupError(err)) {
        logger.debug(
          { err, issueId: input.issue.id, agentStatus: getAgentNotInvokableStatus(err) },
          "skipping assignee wakeup because agent is not invokable",
        );
        if (input.rethrowOnError) throw err;
        return null;
      }
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
