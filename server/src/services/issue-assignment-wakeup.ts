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

interface IssueWakeContextIssue {
  id: string;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  assigneeAgentId?: string | null;
  status?: string | null;
}

export function buildIssueWakeContextSnapshot(
  issue: IssueWakeContextIssue,
  contextSource: string,
  extra: Record<string, unknown> = {},
) {
  const title = typeof issue.title === "string" && issue.title.trim().length > 0 ? issue.title.trim() : null;
  const description =
    typeof issue.description === "string" && issue.description.trim().length > 0
      ? issue.description.trim()
      : null;
  const identifier =
    typeof issue.identifier === "string" && issue.identifier.trim().length > 0
      ? issue.identifier.trim()
      : null;

  return {
    issueId: issue.id,
    taskId: issue.id,
    ...(title ? { taskTitle: title, issueTitle: title } : {}),
    ...(description ? { taskBody: description, issueDescription: description } : {}),
    ...(identifier ? { issueIdentifier: identifier } : {}),
    source: contextSource,
    ...extra,
  };
}

export function queueIssueAssignmentWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: IssueWakeContextIssue & {
    assigneeAgentId: string | null;
    status: string;
  };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  return queueIssueWakeup({
    ...input,
    source: "assignment",
    triggerDetail: "system",
    payload: { issueId: input.issue.id, mutation: input.mutation },
  });
}

export function queueIssueWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: {
    id: string;
    identifier?: string | null;
    title?: string | null;
    description?: string | null;
    assigneeAgentId: string | null;
    status: string;
  };
  source?: WakeupSource;
  triggerDetail?: WakeupTriggerDetail;
  reason: string;
  contextSource: string;
  payload?: Record<string, unknown> | null;
  contextExtra?: Record<string, unknown>;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: input.source ?? "automation",
      triggerDetail: input.triggerDetail ?? "system",
      reason: input.reason,
      payload: input.payload ?? { issueId: input.issue.id },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: buildIssueWakeContextSnapshot(input.issue, input.contextSource, input.contextExtra),
    })
    .catch((err) => {
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
