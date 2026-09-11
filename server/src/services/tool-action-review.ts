import { and, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import {
  issues,
  issueThreadInteractions,
  toolActionRequests,
  toolCallEvents,
  toolInvocations,
  toolActionDeliveries,
  type Db,
} from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";
import { assertIssueThreadInteractionResolverAudience } from "./issue-thread-interaction-resolution.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";

/** The shared transaction for both task and Connections review decisions. */
export async function commitToolActionReview(
  db: Db,
  input: {
    companyId: string;
    actionRequestId: string;
    issueId?: string;
    interactionId?: string;
    decision: "approved" | "rejected";
    rememberAction?: boolean;
    reason?: string;
    actor: { agentId?: string | null; userId?: string | null };
  },
) {
  if (input.actor.agentId)
    throw forbidden("Only a human can resolve a tool review");
  const [source] = await db
    .select()
    .from(toolActionRequests)
    .where(
      and(
        eq(toolActionRequests.id, input.actionRequestId),
        eq(toolActionRequests.companyId, input.companyId),
      ),
    )
    .limit(1);
  if (!source) throw notFound("Tool action request not found");
  if ((input.issueId || input.interactionId) && (!input.issueId || !input.interactionId || source.issueId !== input.issueId || source.interactionId !== input.interactionId)) {
    throw conflict("Tool action request does not belong to this interaction");
  }
  const publications: ActivityPublication[] = [];
  const result = await db.transaction(async (tx) => {
    const [issue] = source.issueId
      ? await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, source.issueId),
              eq(issues.companyId, input.companyId),
            ),
          )
          .for("update")
      : [];
    const [interaction] = source.interactionId
      ? await tx
          .select()
          .from(issueThreadInteractions)
          .where(
            and(
              eq(issueThreadInteractions.id, source.interactionId),
              eq(issueThreadInteractions.companyId, input.companyId),
            ),
          )
          .for("update")
      : [];
    const [current] = await tx
      .select()
      .from(toolActionRequests)
      .where(
        and(
          eq(toolActionRequests.id, source.id),
          eq(toolActionRequests.companyId, input.companyId),
        ),
      )
      .for("update");
    if (!current) throw notFound("Tool action request not found");
    if (current.status !== "pending") {
      if (
        (input.decision === "approved" &&
          ["approved", "executing", "executed", "failed"].includes(
            current.status,
          )) ||
        current.status === input.decision
      )
        return current;
      throw conflict("This review has already been resolved");
    }
    if (
      source.issueId &&
      (!issue || issue.status === "done" || issue.status === "cancelled")
    )
      throw conflict("This task is closed");
    const [invocation] = await tx
      .select()
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.id, current.invocationId),
          eq(toolInvocations.companyId, input.companyId),
        ),
      )
      .limit(1);
    if (
      !invocation ||
      invocation.issueId !== current.issueId ||
      (current.requestedByAgentId &&
        invocation.agentId !== current.requestedByAgentId)
    )
      throw conflict("Tool invocation context does not match");
    if (current.interactionId) {
      const payload = interaction?.payload as {
        toolAction?: { actionRequestId?: string; invocationId?: string };
      } | null;
      if (
        !interaction ||
        interaction.issueId !== current.issueId ||
        payload?.toolAction?.actionRequestId !== current.id ||
        payload.toolAction.invocationId !== current.invocationId
      )
        throw conflict("Tool review context does not match");
      assertIssueThreadInteractionResolverAudience({
        actor: { type: "user", userId: input.actor.userId ?? "board" },
        interaction,
        governedAction: true,
      });
      if (interaction.status !== "pending")
        throw conflict("This review has already been resolved");
    }
    const [updated] = await tx
      .update(toolActionRequests)
      .set({
        status: input.decision,
        resolvedByUserId: input.actor.userId ?? "board",
        decidedByUserId: input.actor.userId ?? "board",
        decidedAt: sql`clock_timestamp()`,
        resolvedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(toolActionRequests.id, current.id),
          input.decision === "approved"
            ? and(
                isNotNull(toolActionRequests.expiresAt),
                gt(toolActionRequests.expiresAt, sql`clock_timestamp()`),
              )
            : undefined,
        ),
      )
      .returning();
    if (!updated && input.decision === "approved") {
      const [expired] = await tx
        .update(toolActionRequests)
        .set({
          status: "expired",
          resolvedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(toolActionRequests.id, current.id),
            eq(toolActionRequests.status, "pending"),
            isNotNull(toolActionRequests.expiresAt),
            lte(toolActionRequests.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning();
      if (!expired) throw conflict("This review has already been resolved");
      await tx
        .update(toolInvocations)
        .set({
          status: "failed",
          approvalState: "expired",
          idempotencyKey: null,
          errorCode: "action_expired",
          errorMessage: "The approval request expired before authorization.",
          completedAt: expired.resolvedAt ?? expired.updatedAt,
          updatedAt: expired.resolvedAt ?? expired.updatedAt,
        })
        .where(eq(toolInvocations.id, current.invocationId));
      await tx.insert(toolCallEvents).values({
        companyId: input.companyId,
        eventType: "approval_resolved",
        actorType: "user",
        actorId: input.actor.userId ?? "board",
        agentId: invocation.agentId,
        runId: invocation.runId,
        issueId: invocation.issueId,
        gatewayId: invocation.gatewayId,
        gatewayTokenId: invocation.gatewayTokenId,
        gatewayPublicId: invocation.gatewayPublicId,
        clientSubjectType: invocation.clientSubjectType,
        clientSubjectId: invocation.clientSubjectId,
        clientName: invocation.clientName,
        mcpSessionId: invocation.mcpSessionId,
        correlationId: invocation.correlationId,
        applicationId: invocation.applicationId,
        connectionId: invocation.connectionId,
        catalogEntryId: invocation.catalogEntryId,
        invocationId: invocation.id,
        actionRequestId: expired.id,
        toolName: invocation.toolName,
        decision: "require_approval",
        outcome: "timeout",
        reasonCode: "action_expired",
        metadata: {
          expiresAt: expired.expiresAt?.toISOString() ?? null,
          expiredAt: expired.resolvedAt?.toISOString() ?? null,
        },
      });
      return expired;
    }
    if (!updated) throw conflict("This review has already been resolved");
    const now = updated.resolvedAt ?? new Date();
    if (input.rememberAction) {
      if (input.decision !== "approved")
        throw conflict("Only an approval can remember permission");
      await toolAccessPolicyService(
        tx as unknown as Db,
      ).createTrustRuleFromActionRequest({
        companyId: input.companyId,
        actionRequestId: current.id,
        body: { approvalThreshold: 1, priority: 40, argumentMode: "action" },
        actor: { userId: input.actor.userId ?? "board" },
      });
    }
    await tx
      .update(toolInvocations)
      .set({
        approvalState: input.decision,
        ...(input.decision === "rejected"
          ? {
              status: "denied" as const,
              completedAt: now,
              errorCode: "action_declined",
              errorMessage: "The human declined this action.",
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(toolInvocations.id, current.invocationId),
          eq(toolInvocations.companyId, input.companyId),
        ),
      );
    if (interaction && issue) {
      await tx
        .update(issueThreadInteractions)
        .set({
          status: input.decision === "approved" ? "accepted" : "rejected",
          resolvedByUserId: input.actor.userId ?? "board",
          resolvedAt: now,
          updatedAt: now,
          result:
            input.decision === "approved"
              ? {
                  version: 1,
                  outcome: "accepted",
                  toolAction: {
                    version: 1,
                    status: "approved",
                    rememberedAction: input.rememberAction === true,
                    updatedAt: now.toISOString(),
                  },
                }
              : { version: 1, outcome: "rejected", reason: input.reason },
        })
        .where(eq(issueThreadInteractions.id, interaction.id));
      await tx
        .insert(toolActionDeliveries)
        .values({
          companyId: input.companyId,
          actionRequestId: current.id,
          issueId: issue.id,
          interactionId: interaction.id,
        })
        .onConflictDoNothing();
      await logActivity(
        tx as unknown as Db,
        {
          companyId: input.companyId,
          actorType: "user",
          actorId: input.actor.userId ?? "board",
          action:
            input.decision === "approved"
              ? "issue.thread_interaction_accepted"
              : "issue.thread_interaction_rejected",
          entityType: "issue",
          entityId: issue.id,
          details: {
            interactionId: interaction.id,
            actionRequestId: current.id,
            rememberAction: input.rememberAction === true,
          },
        },
        publications,
      );
    }
    return updated;
  });
  for (const publication of publications) publishActivity(publication);
  return result;
}
