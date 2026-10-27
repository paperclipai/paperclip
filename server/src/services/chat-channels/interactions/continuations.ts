import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  agentWakeupRequests,
  chatActions,
  chatEndpoints,
  chatMessageLinks,
  issues,
} from "@paperclipai/db";

import { isUniqueViolation } from "../../../db-errors.js";

import { logger } from "../../../middleware/logger.js";

import {
  type IssueAssignmentWakeupDeps,
} from "../../issue-assignment-wakeup.js";

import { issueThreadInteractionService } from "../../issue-thread-interactions.js";

type InteractionContinuationsOptions = {
  heartbeat: IssueAssignmentWakeupDeps;
  redactError: (error: unknown) => string;
  CONFIRMATION_WAKEUP_RETRY_BACKOFF_MS: number;
};

export function createChatInteractionContinuations(db: Db, options: InteractionContinuationsOptions) {
  const { redactError, CONFIRMATION_WAKEUP_RETRY_BACKOFF_MS } = options;


  async function processPendingInteractionWakeups(
    limit = 100,
  ): Promise<number> {
    const staleBefore = new Date(Date.now() - 30_000);
    const retryBefore = new Date(
      Date.now() - CONFIRMATION_WAKEUP_RETRY_BACKOFF_MS,
    );
    const candidates = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.kind, "interaction_wakeup"),
          or(
            and(
              eq(chatActions.status, "issued"),
              or(
                isNull(chatActions.result),
                lte(chatActions.updatedAt, retryBefore),
              ),
            ),
            and(
              eq(chatActions.status, "processing"),
              lte(chatActions.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .orderBy(asc(chatActions.updatedAt), asc(chatActions.id))
      .limit(limit);
    let processed = 0;
    for (const candidate of candidates) {
      const [claimed] = await db
        .update(chatActions)
        .set({ status: "processing", updatedAt: new Date() })
        .where(
          and(
            eq(chatActions.id, candidate.id),
            or(
              and(
                eq(chatActions.status, "issued"),
                or(
                  isNull(chatActions.result),
                  lte(chatActions.updatedAt, retryBefore),
                ),
              ),
              and(
                eq(chatActions.status, "processing"),
                lte(chatActions.updatedAt, staleBefore),
              ),
            ),
          ),
        )
        .returning();
      if (!claimed) continue;
      const payload = claimed.payload;
      const requestedByActorType =
        payload.requestedByActorType === "user" ||
        payload.requestedByActorType === "agent" ||
        payload.requestedByActorType === "system"
          ? payload.requestedByActorType
          : typeof payload.requestedByUserId === "string"
            ? "user"
            : null;
      const requestedByActorId =
        typeof payload.requestedByActorId === "string"
          ? payload.requestedByActorId
          : typeof payload.requestedByUserId === "string"
            ? payload.requestedByUserId
            : null;
      if (
        payload.version !== 1 ||
        typeof payload.interactionId !== "string" ||
        typeof payload.interactionKind !== "string" ||
        !["accepted", "rejected", "answered", "cancelled", "failed"].includes(
          String(payload.interactionStatus),
        ) ||
        typeof payload.issueId !== "string" ||
        typeof payload.agentId !== "string" ||
        !requestedByActorType ||
        !requestedByActorId
      ) {
        await db
          .update(chatActions)
          .set({
            status: "failed",
            result: { code: "interaction_wakeup_payload_invalid" },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, claimed.id),
              eq(chatActions.status, "processing"),
            ),
          );
        continue;
      }
      const currentIssue = await db
        .select({
          assigneeAgentId: issues.assigneeAgentId,
          status: issues.status,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, claimed.companyId),
            eq(issues.id, payload.issueId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const currentInteraction = currentIssue
        ? (
            await issueThreadInteractionService(db).listForIssue(
              payload.issueId,
            )
          ).find((interaction) => interaction.id === payload.interactionId)
        : null;
      if (
        !currentIssue ||
        !currentInteraction ||
        currentInteraction.companyId !== claimed.companyId ||
        currentInteraction.kind !== payload.interactionKind ||
        currentInteraction.status !== payload.interactionStatus ||
        currentIssue.assigneeAgentId !== payload.agentId ||
        currentIssue.status === "done" ||
        currentIssue.status === "cancelled"
      ) {
        await db
          .update(chatActions)
          .set({
            status: "processed",
            result: { code: "interaction_wakeup_no_longer_applicable" },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, claimed.id),
              eq(chatActions.status, "processing"),
            ),
          );
        processed += 1;
        continue;
      }
      const idempotencyKey = `interaction:${payload.interactionId}:${payload.interactionStatus}`;
      try {
        const sourceCommentId = currentInteraction.sourceCommentId ?? null;
        const sourceRunId = currentInteraction.sourceRunId ?? null;
        // A resolved interaction is still part of the originating external
        // turn. Preserve one verified inbound comment edge on the continuation
        // run so queued/working/failure milestones return to this exact
        // endpoint and conversation instead of disappearing as an internal
        // automation run.
        const chatOrigin = claimed.conversationId
          ? await db
              .select({
                commentId: chatMessageLinks.commentId,
                provider: chatEndpoints.provider,
              })
              .from(chatEndpoints)
              .innerJoin(
                chatMessageLinks,
                and(
                  eq(chatMessageLinks.companyId, chatEndpoints.companyId),
                  eq(chatMessageLinks.endpointId, chatEndpoints.id),
                ),
              )
              .where(
                and(
                  eq(chatEndpoints.companyId, claimed.companyId),
                  eq(chatEndpoints.id, claimed.endpointId),
                  eq(chatMessageLinks.conversationId, claimed.conversationId),
                  eq(chatMessageLinks.direction, "inbound"),
                  isNotNull(chatMessageLinks.commentId),
                ),
              )
              .orderBy(
                desc(chatMessageLinks.createdAt),
                desc(chatMessageLinks.id),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
        const wakeCommentId = sourceCommentId ?? chatOrigin?.commentId ?? null;
        const existing = await db
          .select({
            agentId: agentWakeupRequests.agentId,
            id: agentWakeupRequests.id,
          })
          .from(agentWakeupRequests)
          .where(
            and(
              eq(agentWakeupRequests.companyId, claimed.companyId),
              eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
              notInArray(agentWakeupRequests.status, [
                "skipped",
                "failed",
                "cancelled",
              ]),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const queuedRun = !existing
          ? await options.heartbeat.wakeup(payload.agentId, {
              source: "automation",
              triggerDetail: "system",
              reason: "issue_commented",
              payload: {
                issueId: payload.issueId,
                interactionId: payload.interactionId,
                interactionKind: payload.interactionKind,
                interactionStatus: payload.interactionStatus,
                sourceCommentId,
                sourceRunId,
                ...(wakeCommentId
                  ? {
                      wakeCommentId,
                      wakeCommentIds: [wakeCommentId],
                    }
                  : {}),
                ...(payload.planReviewInteraction &&
                typeof payload.planReviewInteraction === "object"
                  ? { planReviewInteraction: payload.planReviewInteraction }
                  : {}),
                mutation: "interaction",
              },
              idempotencyKey,
              allowRunCoalescing: false,
              requestedByActorType,
              requestedByActorId,
              contextSnapshot: {
                issueId: payload.issueId,
                taskId: payload.issueId,
                interactionId: payload.interactionId,
                interactionKind: payload.interactionKind,
                interactionStatus: payload.interactionStatus,
                sourceCommentId,
                sourceRunId,
                ...(payload.planReviewInteraction &&
                typeof payload.planReviewInteraction === "object"
                  ? { planReviewInteraction: payload.planReviewInteraction }
                  : {}),
                wakeReason: "issue_commented",
                source: chatOrigin
                  ? `chat:${chatOrigin.provider}`
                  : "external_chat.interaction.resolve",
                ...(wakeCommentId
                  ? {
                      wakeCommentId,
                      wakeCommentIds: [wakeCommentId],
                    }
                  : {}),
                ...(payload.forceFreshSession === true
                  ? { forceFreshSession: true }
                  : {}),
                ...(typeof payload.workspaceRefreshReason === "string"
                  ? {
                      workspaceRefreshReason: payload.workspaceRefreshReason,
                    }
                  : {}),
              },
            })
          : null;
        const durable =
          existing ??
          (await db
            .select({
              agentId: agentWakeupRequests.agentId,
              id: agentWakeupRequests.id,
            })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, claimed.companyId),
                eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
                notInArray(agentWakeupRequests.status, [
                  "skipped",
                  "failed",
                  "cancelled",
                ]),
              ),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null));
        if (!queuedRun && !durable) {
          await db
            .update(chatActions)
            .set({
              status: "issued",
              result: { code: "interaction_wakeup_deferred" },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, claimed.id),
                eq(chatActions.status, "processing"),
              ),
            );
          continue;
        }
        await db
          .update(chatActions)
          .set({
            status: "processed",
            result: {
              code: durable
                ? durable.agentId === payload.agentId
                  ? "interaction_wakeup_already_durable"
                  : "interaction_wakeup_coalesced_after_reassignment"
                : "interaction_wakeup_queued",
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, claimed.id),
              eq(chatActions.status, "processing"),
            ),
          );
        processed += 1;
      } catch (error) {
        const durable = isUniqueViolation(error)
          ? await db
              .select({
                agentId: agentWakeupRequests.agentId,
                id: agentWakeupRequests.id,
              })
              .from(agentWakeupRequests)
              .where(
                and(
                  eq(agentWakeupRequests.companyId, claimed.companyId),
                  eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
                  notInArray(agentWakeupRequests.status, [
                    "skipped",
                    "failed",
                    "cancelled",
                  ]),
                ),
              )
              .limit(1)
              .then((rows) => rows[0] ?? null)
          : null;
        const previousResult =
          claimed.result && typeof claimed.result === "object"
            ? (claimed.result as Record<string, unknown>)
            : {};
        const previousAttempts =
          typeof previousResult.attemptCount === "number" &&
          Number.isInteger(previousResult.attemptCount) &&
          previousResult.attemptCount >= 0
            ? previousResult.attemptCount
            : 0;
        const attemptCount = previousAttempts + 1;
        await db
          .update(chatActions)
          .set({
            status: durable ? "processed" : "issued",
            result: {
              code: durable
                ? durable.agentId === payload.agentId
                  ? "interaction_wakeup_already_durable"
                  : "interaction_wakeup_coalesced_after_reassignment"
                : "interaction_wakeup_failed",
              ...(!durable ? { attemptCount } : {}),
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, claimed.id),
              eq(chatActions.status, "processing"),
            ),
          );
        if (!durable) {
          logger.warn(
            {
              endpointId: claimed.endpointId,
              interactionId: payload.interactionId,
              attemptCount,
              error: redactError(error),
            },
            "failed to queue external interaction continuation wake",
          );
        }
      }
    }
    return processed;
  }
  return { processPendingInteractionWakeups };
}
