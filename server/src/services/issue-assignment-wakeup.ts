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
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}

function isClosedIssueStatus(status: string | null | undefined): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Wake an issue's assignee after one of its thread interactions is resolved
 * (accepted / rejected / answered), honoring the interaction's continuation
 * policy. Shared by the REST interaction routes and the in-process plugin-SDK
 * resolve methods so both paths resume the assignee identically.
 */
export function queueResolvedInteractionContinuationWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  interaction: {
    id: string;
    kind: string;
    status: string;
    continuationPolicy: string;
    sourceCommentId?: string | null;
    sourceRunId?: string | null;
  };
  actor?: { actorType: "user" | "agent"; actorId: string };
  source: string;
  forceFreshSession?: boolean;
  workspaceRefreshReason?: string | null;
}) {
  if (
    input.interaction.continuationPolicy !== "wake_assignee"
    && input.interaction.continuationPolicy !== "wake_assignee_on_accept"
  ) return;
  if (
    input.interaction.continuationPolicy === "wake_assignee_on_accept"
    && input.interaction.status !== "accepted"
  ) return;
  if (input.interaction.status === "expired") return;
  if (!input.issue.assigneeAgentId || isClosedIssueStatus(input.issue.status)) return;

  const forceFreshSession = input.forceFreshSession === true;
  const workspaceRefreshReason = readNonEmptyString(input.workspaceRefreshReason);
  return input.heartbeat.wakeup(input.issue.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: {
      issueId: input.issue.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      mutation: "interaction",
    },
    requestedByActorType: input.actor?.actorType ?? "system",
    requestedByActorId: input.actor?.actorId ?? null,
    contextSnapshot: {
      issueId: input.issue.id,
      taskId: input.issue.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      wakeReason: "issue_commented",
      source: input.source,
      ...(forceFreshSession ? { forceFreshSession: true } : {}),
      ...(workspaceRefreshReason ? { workspaceRefreshReason } : {}),
    },
  }).catch((err) => logger.warn({
    err,
    issueId: input.issue.id,
    interactionId: input.interaction.id,
    agentId: input.issue.assigneeAgentId,
  }, "failed to wake assignee on issue interaction resolution"));
}
