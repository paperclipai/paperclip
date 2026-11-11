import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, chatMessageLinks, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { withQueuedCommentIdsInWakePayload } from "../../../services/issue-queued-comment-queue.js";

// A reviewed chat run attests exactly one conversation. A wake records its
// conversation in `chatConversationId`, but a wake can also hold messages of
// a conversation it does not record: the work-intent outbox saves unanswered
// chat messages as a plain comment wake. These checks compare the
// conversations of the messages themselves, so a batch never holds messages
// of two conversations. Comments with no inbound chat link (board comments)
// belong to no conversation and batch as before.

const DEFERRED_WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const CHAT_CONVERSATION_ID_KEY = "chatConversationId";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

/**
 * SQL predicate on a deferred `agent_wakeup_requests` row: none of its queued
 * messages is an inbound chat message of a conversation other than
 * `conversationId`.
 */
export function deferredWakeHoldsNoOtherConversation(companyId: string, conversationId: string): SQL {
  const ids = sql`${agentWakeupRequests.payload} -> ${DEFERRED_WAKE_CONTEXT_KEY}::text -> 'wakeCommentIds'`;
  return sql`not exists (
    select 1 from ${chatMessageLinks}
    where ${chatMessageLinks.companyId} = ${companyId}
      and ${chatMessageLinks.direction} = 'inbound'
      and ${chatMessageLinks.conversationId}::text <> ${conversationId}
      and ${chatMessageLinks.commentId} = any(array(
        select queued.id::uuid
        from jsonb_array_elements_text(case when jsonb_typeof(${ids}) = 'array' then ${ids} else '[]'::jsonb end) as queued(id)
        where queued.id ~ ${UUID_PATTERN}
      ))
  )`;
}

/** The ids among `commentIds` that are inbound chat messages of a conversation other than `conversationId`. */
export async function otherConversationCommentIds(
  tx: Db,
  input: { companyId: string; conversationId: string; commentIds: string[] },
): Promise<string[]> {
  const queryable = input.commentIds.filter((id) => isUuidLike(id));
  if (queryable.length === 0) return [];
  const rows = await tx
    .selectDistinct({ commentId: chatMessageLinks.commentId })
    .from(chatMessageLinks)
    .where(and(
      eq(chatMessageLinks.companyId, input.companyId),
      eq(chatMessageLinks.direction, "inbound"),
      inArray(chatMessageLinks.commentId, queryable),
      ne(sql`${chatMessageLinks.conversationId}::text`, input.conversationId),
    ));
  const other = new Set(rows.map((row) => row.commentId));
  return input.commentIds.filter((id) => other.has(id));
}

/**
 * Upgrade repair for a deferred chat wake that older code merged across two
 * conversations. The messages of other conversations move to their own plain
 * saved wake (the shape the work-intent outbox writes), ordered just before
 * this wake so they keep their place. This wake keeps its id, its recorded
 * conversation and the rest of its messages. When no message of its own
 * conversation is left, the wake keeps its id and becomes a plain saved wake.
 * No message is dropped.
 * Returns true when the wake changed and must be read again.
 */
export async function splitOtherConversationMessages(
  tx: Db,
  row: typeof agentWakeupRequests.$inferSelect,
  input: { companyId: string; issueId: string; conversationId: string; queuedCommentIds: string[]; payload: Record<string, unknown> },
): Promise<boolean> {
  const moved = await otherConversationCommentIds(tx, {
    companyId: input.companyId, conversationId: input.conversationId, commentIds: input.queuedCommentIds,
  });
  if (moved.length === 0) return false;
  const kept = input.queuedCommentIds.filter((id) => !moved.includes(id));
  const now = new Date();
  const deferred = and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, row.id),
    eq(agentWakeupRequests.status, "deferred_issue_execution"));
  if (kept.length === 0) {
    // Every message belongs to another conversation. Keep the wake and its id
    // (an interrupt names the wake by id) and drop only its chat binding, so
    // it runs as plain saved messages.
    const { [CHAT_CONVERSATION_ID_KEY]: _dropped, ...context } = record(input.payload[DEFERRED_WAKE_CONTEXT_KEY]);
    await tx.update(agentWakeupRequests).set({ updatedAt: now,
      payload: withQueuedCommentIdsInWakePayload({ ...input.payload, mutation: "comment",
        [DEFERRED_WAKE_CONTEXT_KEY]: { ...context, source: "issue.comment", wakeReason: "issue_commented" } }, moved) })
      .where(deferred);
    return true;
  }
  const updated = await tx.update(agentWakeupRequests)
    .set({ payload: withQueuedCommentIdsInWakePayload(input.payload, kept), updatedAt: now })
    .where(deferred)
    .returning({ id: agentWakeupRequests.id });
  // Another writer already moved the wake on; its messages stay where they are.
  if (updated.length === 0) return true;
  const latest = moved.at(-1)!;
  await tx.insert(agentWakeupRequests).values({
    companyId: input.companyId, agentId: row.agentId, source: "automation", triggerDetail: "system",
    reason: "issue_commented", status: "deferred_issue_execution",
    requestedByActorType: row.requestedByActorType, requestedByActorId: row.requestedByActorId,
    requestedAt: new Date(row.requestedAt.getTime() - 1), updatedAt: now,
    payload: withQueuedCommentIdsInWakePayload({ issueId: input.issueId, mutation: "comment", commentId: latest,
      [DEFERRED_WAKE_CONTEXT_KEY]: { issueId: input.issueId, taskId: input.issueId, wakeReason: "issue_commented",
        source: "issue.comment", wakeCommentIds: moved, wakeCommentId: latest } }, moved),
  });
  return true;
}
