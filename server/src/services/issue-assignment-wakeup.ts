import { logger } from "../middleware/logger.js";
import { HttpError } from "../errors.js";

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

function readInvokableConflictStatus(err: unknown): string | null {
  if (!(err instanceof HttpError)) return null;
  if (err.status !== 409 || err.message !== "Agent is not invokable in its current state") return null;
  const details = err.details;
  if (!details || typeof details !== "object") return null;
  const status = (details as { status?: unknown }).status;
  return typeof status === "string" && status.trim().length > 0 ? status : null;
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
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

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
      const assigneeStatus = readInvokableConflictStatus(err);
      if (assigneeStatus) {
        logger.info(
          {
            issueId: input.issue.id,
            assigneeAgentId: input.issue.assigneeAgentId,
            assigneeStatus,
            mutation: input.mutation,
            reason: input.reason,
            contextSource: input.contextSource,
          },
          "skipped assignee wake on issue assignment: assignee not invokable",
        );
        if (input.rethrowOnError) throw err;
        return null;
      }
      logger.warn(
        {
          err,
          issueId: input.issue.id,
          assigneeAgentId: input.issue.assigneeAgentId,
          mutation: input.mutation,
          reason: input.reason,
          contextSource: input.contextSource,
        },
        "failed to wake assignee on issue assignment",
      );
      if (input.rethrowOnError) throw err;
      return null;
    });
}
