import {
  awaitingHumanNotificationOutbox,
  issueThreadInteractions,
  issues,
  type Db,
} from "@paperclipai/db";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import type { LogActivityInput } from "./activity-log.js";
import { awaitingHumanSettingsService } from "./awaiting-human-settings.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

export function isClosedIssueStatus(status: string | null | undefined): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

export async function queueResolvedInteractionContinuationWakeup(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  interaction: Pick<
    IssueThreadInteraction,
    "id" | "kind" | "status" | "continuationPolicy" | "sourceCommentId" | "sourceRunId"
  >;
  actor: { actorType: "user" | "agent" | "system"; actorId: string };
  source: string;
}): Promise<void> {
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

  await input.heartbeat.wakeup(input.issue.assigneeAgentId, {
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
  externalMessageId?: string | null;
  externalEventId?: string | null;
};

async function advanceToFinalApprovalReview(input: {
  db: Db;
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
  actor: { actorType: "user" | "agent" | "system"; actorId: string; agentId?: string | null };
}) {
  if (input.interaction.kind !== "request_confirmation") return false;
  const interaction = input.interaction;
  if (interaction.status !== "accepted" || interaction.payload.approvalStage === "final") {
    return false;
  }

  const settings = await awaitingHumanSettingsService(input.db).get(input.issue.companyId);
  const primaryReviewerUserId = settings.provider === "clickup"
    ? settings.providerConfig?.primaryReviewerUserId?.trim()
    : null;
  const secondaryReviewerUserId = settings.provider === "clickup"
    ? settings.providerConfig?.secondaryReviewerUserId?.trim()
    : null;
  if (!settings.enabled || !primaryReviewerUserId || !secondaryReviewerUserId) return false;

  const finalIdempotencyKey = `approval-final:${interaction.id}`;
  const finalPayload = {
    ...interaction.payload,
    approvalStage: "final" as const,
    requiresSecondReview: true,
    priorApprovalInteractionId: interaction.id,
  };
  const transition = await input.db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const [issueRow] = await txDb
      .select()
      .from(issues)
      .where(eq(issues.id, input.issue.id))
      .limit(1);
    if (!issueRow || issueRow.status !== "awaiting_human") return null;

    await txDb
      .update(issueThreadInteractions)
      .set({
        payload: {
          ...interaction.payload,
          approvalStage: "primary",
          requiresSecondReview: true,
        },
        updatedAt: new Date(),
      })
      .where(eq(issueThreadInteractions.id, interaction.id));

    const [createdFinalInteraction] = await txDb
      .insert(issueThreadInteractions)
      .values({
        companyId: issueRow.companyId,
        issueId: issueRow.id,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: interaction.continuationPolicy,
        idempotencyKey: finalIdempotencyKey,
        sourceCommentId: interaction.sourceCommentId ?? null,
        sourceRunId: interaction.sourceRunId ?? null,
        title: interaction.title ?? null,
        summary: interaction.summary ?? null,
        createdByAgentId: interaction.createdByAgentId ?? null,
        createdByUserId: interaction.createdByUserId ?? null,
        payload: finalPayload,
      })
      .onConflictDoNothing()
      .returning();
    const finalInteraction = createdFinalInteraction ?? await txDb
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, issueRow.companyId),
        eq(issueThreadInteractions.issueId, issueRow.id),
        eq(issueThreadInteractions.idempotencyKey, finalIdempotencyKey),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!finalInteraction) {
      throw new Error("Failed to create final approval interaction");
    }

    const issuePathId = issueRow.identifier ?? issueRow.id;
    const notification = {
      title: `${issuePathId} needs final approval`,
      summary: interaction.summary ?? interaction.payload.prompt,
      link: `/issues/${issuePathId}`,
      cta: "Reply with Approve, Reject, or Change followed by feedback.",
      labels: ["awaiting_human", "request_confirmation", "final_approval"],
      kind: "request_confirmation",
      interactionId: finalInteraction.id,
      body: [
        interaction.payload.prompt,
        interaction.payload.detailsMarkdown ?? null,
      ].filter(Boolean).join("\n\n"),
      approvalContext: {
        approvalName: interaction.payload.approvalName ?? null,
        approvalStage: "final" as const,
        requiresSecondReview: true,
      },
      target: {
        label: interaction.payload.target?.label ?? null,
        href: interaction.payload.target?.href ?? null,
      },
    };
    await txDb
      .insert(awaitingHumanNotificationOutbox)
      .values({
        companyId: issueRow.companyId,
        issueId: issueRow.id,
        dedupeKey: `interaction:${finalInteraction.id}`,
        handoffKind: "request_confirmation",
        status: "pending",
        notification,
        reviewFile: null,
      })
      .onConflictDoNothing();

    return { issueRow, finalInteraction, notification };
  });
  if (!transition) return false;
  const { issueRow, finalInteraction, notification } = transition;

  await input.logActivity(input.db, {
    companyId: issueRow.companyId,
    actorType: input.actor.actorType,
    actorId: input.actor.actorId,
    agentId: input.actor.agentId ?? null,
    action: "issue.awaiting_human.approval_stage_advanced",
    entityType: "issue",
    entityId: issueRow.id,
    details: {
      previousInteractionId: interaction.id,
      interactionId: finalInteraction.id,
      approvalStage: "final",
      primaryReviewerUserId,
      secondaryReviewerUserId,
      notification,
    },
  });

  return { finalInteractionId: finalInteraction.id };
}

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
    ...(input.metadata?.externalMessageId ? { externalMessageId: input.metadata.externalMessageId } : {}),
    ...(input.metadata?.externalEventId ? { externalEventId: input.metadata.externalEventId } : {}),
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

  const advanced = await advanceToFinalApprovalReview(input);
  if (advanced) {
    return advanced;
  }

  await queueResolvedInteractionContinuationWakeup({
    heartbeat: input.heartbeat,
    issue: continuationWakeIssue,
    interaction: input.interaction,
    actor: input.actor,
    source: input.source,
  });
  return false;
}
