import type { Db } from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import type { LogActivityInput } from "./activity-log.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

export function isClosedIssueStatus(status: string | null | undefined): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

export function queueResolvedInteractionContinuationWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  interaction: Pick<
    IssueThreadInteraction,
    "id" | "kind" | "status" | "continuationPolicy" | "sourceCommentId" | "sourceRunId"
  >;
  actor: { actorType: "user" | "agent" | "system"; actorId: string };
  source: string;
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

  void input.heartbeat.wakeup(input.issue.assigneeAgentId, {
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
    requestedByActorType: input.actor.actorType,
    requestedByActorId: input.actor.actorId,
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
    },
  }).catch((err) => logger.warn({
    err,
    issueId: input.issue.id,
    interactionId: input.interaction.id,
    agentId: input.issue.assigneeAgentId,
  }, "failed to wake assignee on issue interaction resolution"));
}

type IssueWakeTarget = {
  id: string;
  assigneeAgentId: string | null;
  assigneeUserId?: string | null;
  status: string;
};

type ResolutionMetadata = {
  resolutionSource?: string | null;
  clickupMessageId?: string | null;
  clickupReaction?: string | null;
};

export async function finalizeAcceptedInteractionResolution(input: {
  db: Db;
  heartbeat: IssueAssignmentWakeupDeps;
  logActivity: (db: Db, input: LogActivityInput) => Promise<void>;
  issue: {
    id: string;
    companyId: string;
    identifier?: string | null;
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId?: string | null;
  };
  interaction: IssueThreadInteraction;
  createdIssues: IssueWakeTarget[];
  continuationIssue?: IssueWakeTarget | null;
  actor: { actorType: "user" | "agent" | "system"; actorId: string; agentId?: string | null; runId?: string | null };
  source: string;
  metadata?: ResolutionMetadata;
}) {
  const continuationWakeIssue = input.continuationIssue ?? input.issue;
  const resolutionDetails = {
    ...(input.metadata?.resolutionSource ? { resolutionSource: input.metadata.resolutionSource } : {}),
    ...(input.metadata?.clickupMessageId ? { clickupMessageId: input.metadata.clickupMessageId } : {}),
    ...(input.metadata?.clickupReaction ? { clickupReaction: input.metadata.clickupReaction } : {}),
  };

  await input.logActivity(input.db, {
    companyId: input.issue.companyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    agentId: input.actor.agentId ?? null,
    runId: input.actor.runId ?? null,
    action: input.interaction.status === "expired"
      ? "issue.thread_interaction_expired"
      : "issue.thread_interaction_accepted",
    entityType: "issue",
    entityId: input.issue.id,
    details: {
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      createdTaskCount:
        input.interaction.kind === "suggest_tasks"
          ? (input.interaction.result?.createdTasks?.length ?? 0)
          : 0,
      skippedTaskCount:
        input.interaction.kind === "suggest_tasks"
          ? (input.interaction.result?.skippedClientKeys?.length ?? 0)
          : 0,
      ...resolutionDetails,
    },
  });

  if (input.continuationIssue) {
    await input.logActivity(input.db, {
      companyId: input.issue.companyId,
      actorType: input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId ?? null,
      runId: input.actor.runId ?? null,
      action: "issue.updated",
      entityType: "issue",
      entityId: input.issue.id,
      details: {
        identifier: input.issue.identifier ?? null,
        status: input.continuationIssue.status,
        assigneeAgentId: input.continuationIssue.assigneeAgentId ?? null,
        assigneeUserId: input.continuationIssue.assigneeUserId ?? null,
        source: "request_confirmation_accept",
        interactionId: input.interaction.id,
        ...resolutionDetails,
        _previous: {
          status: input.issue.status,
          assigneeAgentId: input.issue.assigneeAgentId ?? null,
          assigneeUserId: input.issue.assigneeUserId ?? null,
        },
      },
    });
  }

  for (const createdIssue of input.createdIssues) {
    void queueIssueAssignmentWakeup({
      heartbeat: input.heartbeat,
      issue: createdIssue,
      reason: "issue_assigned",
      mutation: "interaction_accept",
      contextSource: "issue.interaction.accept",
      requestedByActorType: input.actor.actorType,
      requestedByActorId: input.actor.actorId,
    });
  }

  queueResolvedInteractionContinuationWakeup({
    heartbeat: input.heartbeat,
    issue: continuationWakeIssue,
    interaction: input.interaction,
    actor: input.actor,
    source: input.source,
  });
}
