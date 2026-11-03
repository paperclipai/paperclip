import { notifyChatContinuationWork, type ChatContinuationScope } from "../../chat-continuation-notifications.js";
import { DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { registerScopedDeadlineWork } from "../../scoped-deadline-work.js";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  sql,
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
  preparePublications: (scope: { companyId: string; endpointId: string; conversationId: string }, canContinue: () => boolean) => Promise<unknown>;
  redactError: (error: unknown) => string;
  CONFIRMATION_WAKEUP_RETRY_BACKOFF_MS: number;
};

export function createChatInteractionContinuations(db: Db, options: InteractionContinuationsOptions) {
  const { redactError, CONFIRMATION_WAKEUP_RETRY_BACKOFF_MS } = options;


  async function processPendingInteractionWakeups(
    limit = 100,
    actionId?: string,
    preparePublications = false,
    canContinue: () => boolean = () => true,
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
          actionId ? eq(chatActions.id, actionId) : undefined,
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
      if (preparePublications && candidate.conversationId) {
        await options.preparePublications({ companyId: candidate.companyId,
          endpointId: candidate.endpointId, conversationId: candidate.conversationId }, canContinue);
      }
      if (!canContinue()) break;
      const writeAction = <T>(write: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => PromiseLike<T>) =>
        db.transaction(async tx => {
          await notifyChatContinuationWork(tx, { companyId: candidate.companyId, actionId: candidate.id });
          return write(tx);
        });
      const [claimed] = await writeAction(tx => tx
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
        .returning());
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
        await writeAction(tx => tx
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
          ));
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
        await writeAction(tx => tx
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
          ));
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
          await writeAction(tx => tx
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
            ));
          continue;
        }
        await writeAction(tx => tx
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
          ));
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
        await writeAction(tx => tx
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
          ));
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
  function registerInteractionContinuationWork(
    coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
    canRun: () => boolean,
  ) {
    type Entry = { id: string; companyId: string; issueId: string | null; dueAt: number };
    const selection = {
      id: chatActions.id, companyId: chatActions.companyId,
      issueId: sql<string | null>`${chatActions.payload}->>'issueId'`,
      status: chatActions.status, result: chatActions.result, updatedAt: chatActions.updatedAt,
    };
    const entry = (row: { id: string; companyId: string; issueId: string | null; status: string;
      result: unknown; updatedAt: Date }): Entry => ({
      id: row.id, companyId: row.companyId, issueId: row.issueId,
      dueAt: row.status === "processing" ? row.updatedAt.getTime() + 30_000
        : row.result === null ? 0 : row.updatedAt.getTime() + CONFIRMATION_WAKEUP_RETRY_BACKOFF_MS,
    });
    return registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.chatInteractionContinuations,
      decodeScope: (hint: string): ChatContinuationScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (value: Entry, scope?: ChatContinuationScope) => !scope ||
        (value.companyId === scope.companyId && (!scope.actionId || value.id === scope.actionId) &&
          (!scope.issueId || value.issueId === scope.issueId)),
      load: async (scope?: ChatContinuationScope, signal?: AbortSignal): Promise<Entry[]> => {
        const entries: Entry[] = [];
        let cursor: { companyId: string; id: string } | undefined;
        while (!signal?.aborted) {
          const rows = await db.select(selection).from(chatActions).where(and(
            sql`${chatActions.kind} = 'interaction_wakeup' AND ${chatActions.status} IN ('issued', 'processing')`,
            scope ? eq(chatActions.companyId, scope.companyId) : undefined,
            scope?.actionId ? eq(chatActions.id, scope.actionId) : undefined,
            scope?.issueId ? eq(sql<string>`${chatActions.payload}->>'issueId'`, scope.issueId) : undefined,
            cursor ? sql`(${chatActions.companyId}, ${chatActions.id}) > (${cursor.companyId}, ${cursor.id})` : undefined,
          )).orderBy(asc(chatActions.companyId), asc(chatActions.id)).limit(100);
          entries.push(...rows.map(entry));
          if (rows.length < 100) return entries;
          cursor = rows[rows.length - 1];
        }
        throw signal?.reason ?? new Error("Interaction continuation recovery stopped");
      },
      check: async (value: Entry, signal?: AbortSignal) => {
        await processPendingInteractionWakeups(1, value.id, true, () => canRun() && !signal?.aborted);
        const [current] = await db.select(selection).from(chatActions).where(and(
          eq(chatActions.id, value.id), inArray(chatActions.status, ["issued", "processing"]),
        ));
        return current ? entry(current) : null;
      },
    }, canRun);
  }
  return { processPendingInteractionWakeups, registerInteractionContinuationWork };
}
