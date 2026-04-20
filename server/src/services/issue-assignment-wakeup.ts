import { HttpError } from "../errors.js";
import { logOpsInfo, logOpsWarn } from "../ops-log.js";
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

export interface IssueAssignmentWakeupWarning {
  code: string;
  message: string;
}

export interface IssueAssignmentWakeupResult {
  status: "queued" | "noop" | "warning";
  warning?: IssueAssignmentWakeupWarning;
}

function readHttpErrorCode(error: unknown): string | null {
  if (!(error instanceof HttpError) || !error.details || typeof error.details !== "object") return null;
  const details = error.details as Record<string, unknown>;
  const code = details.code;
  return typeof code === "string" ? code : null;
}

export async function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  wakeupPayload?: Record<string, unknown>;
  wakeupContextSnapshot?: Record<string, unknown>;
  rethrowOnError?: boolean;
}): Promise<IssueAssignmentWakeupResult> {
  if (
    !input.issue.assigneeAgentId ||
    input.issue.status === "backlog" ||
    input.issue.status === "done" ||
    input.issue.status === "cancelled"
  ) {
    return { status: "noop" };
  }

  try {
    await input.heartbeat.wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      ...(input.wakeupPayload ? { payload: { issueId: input.issue.id, mutation: input.mutation, ...input.wakeupPayload } } : {}),
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: {
        issueId: input.issue.id,
        taskId: input.issue.id,
        wakeReason: input.reason,
        source: input.contextSource,
        ...(input.wakeupContextSnapshot ?? {}),
      },
    });
    return { status: "queued" };
  } catch (err) {
    const detailsCode = readHttpErrorCode(err);
    if (isAgentNotInvokableWakeupError(err)) {
      const status = getAgentNotInvokableStatus(err);
      logOpsInfo("heartbeat.wakeup.skipped_not_invokable", {
        issueId: input.issue.id,
        agentId: input.issue.assigneeAgentId,
        reason: input.reason,
        mutation: input.mutation,
        agentStatus: status,
      });
      if (input.rethrowOnError) throw err;
      return {
        status: "warning",
        warning: {
          code: status ?? "agent_not_invokable",
          message:
            status === "paused"
              ? "Assignee is paused and cannot be started right now."
              : status === "terminated" || status === "pending_approval"
                ? `Assignee is ${status.replace("_", " ")} and cannot be started right now.`
                : "Assignee cannot be started right now.",
        },
      };
    }
    const warning: IssueAssignmentWakeupWarning = {
      code: detailsCode ?? "wakeup_failed",
      message:
        err instanceof Error
          ? err.message
          : "Unable to wake assigned agent for this issue update.",
    };
    logOpsWarn("heartbeat.wakeup.failed", {
      issueId: input.issue.id,
      agentId: input.issue.assigneeAgentId,
      reason: input.reason,
      mutation: input.mutation,
      errorCode: detailsCode ?? undefined,
      errorMessage: warning.message,
    });
    if (input.rethrowOnError) throw err;
    return { status: "warning", warning };
  }
}
