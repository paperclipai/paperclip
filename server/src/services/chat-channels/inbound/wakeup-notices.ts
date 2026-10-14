import type { DbOrTransaction } from "../runtime-types.js";
import { notifyChatPublicationWork } from "../../chat-work-notifications.js";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, chatActions, chatDeliveries, chatMessageLinks, chatPublications, issueComments } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { NativeChatReviewPresentationContentionError } from "../../native-runtime/native-chat-review-presentation.js";
import { isExternalChatWaitAuthorizationContention } from "../../native-runtime/chat-attachment-reuse.js";
import { projectSafeChatPublication } from "../../chat-publication-projection.js";
import { inboundWakePublicationKey, inboundWakePublicationText, parseInboundWakePublicationKey, resolveInboundWakeReceipt } from "../../chat-inbound-wakeup-publications.js";
import { inboundWakeScope, type createInboundWakeAuthority } from "./wakeup-authorization.js";
import type { createChatFailedRunRetry } from "../failed-run-retry.js";
type NoticeOptions = {
  authorizeInboundWakeup: ReturnType<typeof createInboundWakeAuthority>["authorizeInboundWakeup"];
  enqueueFailedChatRetryPublications: ReturnType<typeof createChatFailedRunRetry>["enqueueFailedChatRetryPublications"];
  authorizeRetainedChatSourcePublication: (tx: DbOrTransaction, publication: typeof chatPublications.$inferSelect) => Promise<boolean>;
  isExternalActionAuthorizationChange: (error: unknown) => boolean;
  isShuttingDown: () => boolean;
};
export function createInboundWakeNotices(db: Db, options: NoticeOptions) {
  const { authorizeInboundWakeup, enqueueFailedChatRetryPublications, authorizeRetainedChatSourcePublication, isExternalActionAuthorizationChange } = options;
  let inboundWakeNoticeCursor: { createdAt: Date; id: string } | null = null;
  async function currentInboundWakeNotice(
    tx: DbOrTransaction,
    action: typeof chatActions.$inferSelect,
    terminal: boolean,
  ) {
    const identityLock = await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`chat-identity:${action.companyId}:${action.principalId}`}, 0)) as locked`,
    );
    if (!identityLock[0]?.locked)
      throw new NativeChatReviewPresentationContentionError();
    const authorized = await authorizeInboundWakeup(tx, action, {
      nonblocking: true,
      terminal,
    });
    // The policy locks above serialize destination/identity changes. Re-read
    // both receipts under NOWAIT locks: cancellation can update them without
    // taking the policy locks, and must win if it committed first.
    const [delivery] = await tx
      .select()
      .from(chatDeliveries)
      .where(eq(chatDeliveries.id, action.deliveryId!))
      .for("update", { noWait: true });
    const [currentAction] = await tx
      .select()
      .from(chatActions)
      .where(eq(chatActions.id, action.id))
      .for("update", { noWait: true });
    if (
      !currentAction ||
      inboundWakeScope(currentAction) !== inboundWakeScope(action) ||
      !["processed", "failed"].includes(currentAction.status) ||
      !delivery ||
      delivery.state !== "processed" ||
      delivery.companyId !== action.companyId ||
      delivery.endpointId !== action.endpointId ||
      delivery.conversationId !== action.conversationId ||
      delivery.principalId !== action.principalId
    )
      return null;
    const [comment] = await tx
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.id, String(action.payload.commentId)),
          eq(issueComments.companyId, action.companyId),
          eq(issueComments.issueId, authorized.issue.id),
        ),
      )
      .for("share", { noWait: true });
    if (
      !comment ||
      (comment.deletedAt && !terminal) ||
      comment.authorUserId !==
      (action.payload.requestedByActorType === "user"
        ? action.payload.requestedByActorId
        : null)
    )
      return null;
    const [receipt] = await tx
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, action.id))
      .for("update", { noWait: true });
    const ownerId =
      receipt?.payload?.coalescedIntoWakeupRequestId ?? receipt?.id;
    if (typeof ownerId !== "string" || !isUuidLike(ownerId)) return null;
    const owner =
      ownerId === receipt?.id
        ? receipt
        : await tx
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, ownerId))
          .for("update", { noWait: true })
          .then((rows) => rows[0]);
    const resolved = resolveInboundWakeReceipt(
      currentAction,
      receipt ?? null,
      owner ?? null,
      terminal && comment.deletedAt !== null,
    );
    return resolved ? { ...resolved, ...authorized } : null;
  }

  async function inboundQueueNoticeStillVisible(
    tx: DbOrTransaction,
    publication: typeof chatPublications.$inferSelect,
  ) {
    if (publication.state !== "published" || !publication.providerMessageId)
      return false;
    const [link] = await tx
      .select({ id: chatMessageLinks.id })
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.companyId, publication.companyId),
          eq(chatMessageLinks.endpointId, publication.endpointId),
          eq(chatMessageLinks.conversationId, publication.conversationId),
          eq(chatMessageLinks.publicationId, publication.id),
          eq(chatMessageLinks.providerMessageId, publication.providerMessageId),
          eq(chatMessageLinks.direction, "outbound"),
          isNull(chatMessageLinks.commentId),
        ),
      )
      .for("update", { noWait: true });
    return Boolean(link);
  }

  async function enqueueInboundWakeupPublications(limit = 50): Promise<number> {
    if (options.isShuttingDown()) return 0;
    const retryInserted = await enqueueFailedChatRetryPublications(limit);
    const owner = alias(agentWakeupRequests, "chat_notice_owner");
    const cursor = inboundWakeNoticeCursor;
    const sourceRemoved = sql`exists (select 1 from issue_comments removed_comment
      where removed_comment.company_id = ${chatActions.companyId}
        and removed_comment.issue_id::text = ${chatActions.payload}->>'issueId'
        and removed_comment.id::text = ${chatActions.payload}->>'commentId'
        and removed_comment.deleted_at is not null)`;
    const hasVisibleQueue = sql`exists (select 1 from chat_publications queued_notice
      join chat_message_links visible_queue on visible_queue.publication_id = queued_notice.id
        and visible_queue.company_id = queued_notice.company_id
        and visible_queue.endpoint_id = queued_notice.endpoint_id
        and visible_queue.conversation_id = queued_notice.conversation_id
        and visible_queue.provider_message_id = queued_notice.provider_message_id
        and visible_queue.direction = 'outbound' and visible_queue.comment_id is null
      where queued_notice.company_id = ${chatActions.companyId}
        and queued_notice.comment_id::text = ${chatActions.payload}->>'commentId'
        and queued_notice.state = 'published'
        and queued_notice.idempotency_key = 'wake:' || ${owner.id}::text || ':queued:' ||
          ${chatActions.endpointId}::text || ':' || ${chatActions.conversationId}::text)`;
    // A bounded keyset sweep, not an in-memory work queue. Advancing even past
    // revoked candidates prevents an inaccessible old message starving others.
    const candidates = await db
      .select({ action: chatActions })
      .from(chatActions)
      .innerJoin(
        agentWakeupRequests,
        eq(agentWakeupRequests.id, chatActions.id),
      )
      .innerJoin(
        owner,
        sql`${owner.id}::text = coalesce(${agentWakeupRequests.payload}->>'coalescedIntoWakeupRequestId', ${agentWakeupRequests.id}::text)`,
      )
      .where(
        and(
          eq(chatActions.kind, "inbound_wakeup"),
          inArray(chatActions.status, ["processed", "failed"]),
          eq(owner.companyId, chatActions.companyId),
          or(
            and(
              isNull(owner.runId),
              inArray(owner.status, [
                "deferred_issue_execution",
                "cancelled",
                "failed",
                "skipped",
              ]),
            ),
            and(sourceRemoved, hasVisibleQueue),
          ),
          sql`(( ${owner.status} = 'deferred_issue_execution'
          and ${agentWakeupRequests.status} not in ('cancelled','failed','skipped') and not (${sourceRemoved}))
          or ${hasVisibleQueue})`,
          cursor
            ? sql`(${chatActions.createdAt}, ${chatActions.id}) > (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
          sql`not exists (select 1 from chat_publications notice
          where notice.company_id = ${chatActions.companyId}
            and notice.idempotency_key = 'wake:' || ${owner.id}::text || ':' ||
              (case when ${sourceRemoved} then 'removed' when ${owner.status} = 'deferred_issue_execution'
                and ${agentWakeupRequests.status} not in ('cancelled','failed','skipped')
                then 'queued' else 'not_started' end) || ':' ||
              ${chatActions.endpointId}::text || ':' || ${chatActions.conversationId}::text)`,
        ),
      )
      .orderBy(asc(chatActions.createdAt), asc(chatActions.id))
      .limit(Math.max(1, Math.min(limit, 200)));
    const last = candidates.at(-1)?.action;
    inboundWakeNoticeCursor =
      candidates.length >= Math.max(1, Math.min(limit, 200)) && last
        ? { createdAt: last.createdAt, id: last.id }
        : null;
    let inserted = retryInserted;
    for (const { action } of candidates) {
      try {
        inserted += await db.transaction(async (tx) => {
          const [receipt] = await tx
            .select()
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.id, action.id));
          const ownerId =
            receipt?.payload?.coalescedIntoWakeupRequestId ?? receipt?.id;
          if (
            typeof ownerId !== "string" ||
            !isUuidLike(ownerId) ||
            !action.conversationId
          )
            return 0;
          const queuedKey = inboundWakePublicationKey(
            ownerId,
            "queued",
            action.endpointId,
            action.conversationId,
          );
          const [prior] = await tx
            .select()
            .from(chatPublications)
            .where(
              and(
                eq(chatPublications.companyId, action.companyId),
                eq(chatPublications.idempotencyKey, queuedKey),
              ),
            );
          // Only the exact original notice may be retired; never post a failure
          // notice for input which never received a provider queue acknowledgement.
          if (
            prior &&
            (prior.state !== "published" ||
              prior.commentId !== action.payload.commentId)
          )
            return 0;
          const context = await currentInboundWakeNotice(
            tx,
            action,
            Boolean(prior),
          );
          if (
            !context ||
            context.ownerId !== ownerId ||
            context.state === "promoted" ||
            (context.state !== "queued" && !prior) ||
            (context.state === "queued" && prior)
          )
            return 0;
          if (prior && !(await inboundQueueNoticeStillVisible(tx, prior)))
            return 0;
          await notifyChatPublicationWork(tx);
          const rows = await tx
            .insert(chatPublications)
            .values({
              companyId: action.companyId,
              endpointId: action.endpointId,
              conversationId: action.conversationId,
              issueId: context.issue.id,
              commentId: String(action.payload.commentId),
              idempotencyKey: inboundWakePublicationKey(
                ownerId,
                context.state,
                action.endpointId,
                action.conversationId,
              ),
              payload: projectSafeChatPublication({
                classification: "external",
                source: "safe_milestone",
                text: inboundWakePublicationText(context.state),
                progressState: context.state === "queued" ? "queued" : "failed",
              }),
            })
            .onConflictDoNothing()
            .returning({ id: chatPublications.id });
          return rows.length;
        });
      } catch (error) {
        if (
          !isExternalActionAuthorizationChange(error) &&
          !isExternalChatWaitAuthorizationContention(error) &&
          !(error instanceof NativeChatReviewPresentationContentionError)
        )
          throw error;
      }
    }
    return inserted;
  }

  async function authorizeInboundWakePublication(
    tx: DbOrTransaction,
    publication: typeof chatPublications.$inferSelect,
  ) {
    const key = parseInboundWakePublicationKey(publication.idempotencyKey);
    if (key) {
      const [retry] = await tx
        .select({ kind: chatActions.kind })
        .from(chatActions)
        .where(
          and(
            eq(chatActions.id, key.wakeId),
            eq(chatActions.companyId, publication.companyId),
          ),
        );
      if (retry?.kind === "failed_run_retry")
        return authorizeRetainedChatSourcePublication(tx, publication);
    }
    if (
      !key ||
      key.endpointId !== publication.endpointId ||
      key.conversationId !== publication.conversationId ||
      !publication.commentId
    )
      return false;
    const actions = await tx
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, publication.companyId),
          eq(chatActions.endpointId, publication.endpointId),
          eq(chatActions.conversationId, publication.conversationId),
          eq(chatActions.kind, "inbound_wakeup"),
          sql`${chatActions.payload}->>'issueId' = ${publication.issueId}`,
          sql`${chatActions.payload}->>'commentId' = ${publication.commentId}`,
        ),
      )
      .limit(2);
    if (actions.length !== 1) return false;
    if (key.state !== "queued") {
      const [prior] = await tx
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, publication.companyId),
            eq(chatPublications.commentId, publication.commentId),
            eq(chatPublications.state, "published"),
            eq(
              chatPublications.idempotencyKey,
              inboundWakePublicationKey(
                key.wakeId,
                "queued",
                key.endpointId,
                key.conversationId,
              ),
            ),
          ),
        );
      if (!prior || !(await inboundQueueNoticeStillVisible(tx, prior)))
        return false;
    }
    try {
      const context = await currentInboundWakeNotice(
        tx,
        actions[0]!,
        key.state !== "queued",
      );
      return context?.ownerId === key.wakeId && context.state === key.state;
    } catch (error) {
      if (isExternalActionAuthorizationChange(error)) return false;
      if (isExternalChatWaitAuthorizationContention(error))
        throw new NativeChatReviewPresentationContentionError();
      throw error;
    }
  }
  return { enqueueInboundWakeupPublications, authorizeInboundWakePublication };
}
