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
      skipIssueLock?: boolean;
    },
  ) => Promise<unknown>;
}

function isClosedIssueStatus(status: string | null | undefined): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

type WakeFailure = {
  status?: unknown;
  message?: unknown;
  details?: unknown;
};

function isNonInvokableAssignmentWakeFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const failure = err as WakeFailure;
  if (failure.status !== 409) return false;

  const message = typeof failure.message === "string" ? failure.message.toLowerCase() : "";
  if (message.startsWith("agent is not invokable")) {
    return true;
  }

  const details = failure.details;
  if (!details || typeof details !== "object") return false;

  const reason = typeof (details as { reason?: unknown }).reason === "string"
    ? String((details as { reason?: unknown }).reason).toLowerCase()
    : "";
  const invalidOrgChain = (details as { invalidOrgChain?: unknown }).invalidOrgChain === true;
  return invalidOrgChain || reason.length > 0;
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  taskKey?: string | null;
  rethrowOnError?: boolean;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog" || isClosedIssueStatus(input.issue.status)) {
    return;
  }

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: {
        issueId: input.issue.id,
        mutation: input.mutation,
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: {
        issueId: input.issue.id,
        source: input.contextSource,
        ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      },
      skipIssueLock: input.mutation === "update",
    })
    .catch((err) => {
      if (isNonInvokableAssignmentWakeFailure(err)) {
        logger.info(
          { err, issueId: input.issue.id, assigneeAgentId: input.issue.assigneeAgentId },
          "skipping assignment wake for non-invokable assignee",
        );
      } else {
        logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      }
      if (input.rethrowOnError) throw err;
      return null;
    });
}
