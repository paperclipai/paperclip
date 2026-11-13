import type { DbOrTransaction } from "../runtime-types.js";
import { hasChatRunOwnedProviderInteraction } from "../../chat-interaction-arbitration.js";
import { notifyChatPublicationWork } from "../../chat-work-notifications.js";
import type { SafeChatPublicationPayload } from "@paperclipai/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { chatMessageLinks, chatPublications, fastResponseRequests, heartbeatRuns, issueComments, type Db } from "@paperclipai/db";

export async function slackPublicProgressReceiptToReplace(
  db: Db,
  publication: typeof chatPublications.$inferSelect,
  runId: string,
): Promise<string | null> {
  if (!publication.idempotencyKey.includes(":native:public:")) return null;
  const [receipt] = await db.select({ providerMessageId: chatPublications.providerMessageId })
    .from(fastResponseRequests)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, publication.companyId),
      sql`${fastResponseRequests.sourceCommentId}::text = coalesce(${heartbeatRuns.contextSnapshot}->>'wakeCommentId', ${heartbeatRuns.contextSnapshot}->>'commentId')`))
    .innerJoin(chatPublications, and(eq(chatPublications.companyId, publication.companyId),
      eq(chatPublications.commentId, fastResponseRequests.commentId), eq(chatPublications.endpointId, publication.endpointId),
      eq(chatPublications.conversationId, publication.conversationId), eq(chatPublications.issueId, publication.issueId), eq(chatPublications.state, "published")))
    .innerJoin(chatMessageLinks, and(eq(chatMessageLinks.publicationId, chatPublications.id),
      eq(chatMessageLinks.companyId, publication.companyId), eq(chatMessageLinks.endpointId, publication.endpointId),
      eq(chatMessageLinks.conversationId, publication.conversationId), eq(chatMessageLinks.direction, "outbound"),
      eq(chatMessageLinks.providerMessageId, chatPublications.providerMessageId)))
    .where(and(eq(fastResponseRequests.companyId, publication.companyId), eq(fastResponseRequests.endpointId, publication.endpointId),
      eq(fastResponseRequests.conversationId, publication.conversationId)))
    .limit(1);
  return receipt?.providerMessageId ?? null;
}

export function slackAnswerNeedsFreshReply(
  publication: Pick<typeof chatPublications.$inferSelect, "commentId">,
  payload: SafeChatPublicationPayload,
): boolean {
  return Boolean(publication.commentId) && payload.progressState === undefined;
}

export function isSlackPublicProgress(publication: Pick<typeof chatPublications.$inferSelect, "idempotencyKey">) {
  return publication.idempotencyKey.includes(":native:public:");
}

export async function slackPublicProgressSupersessionReason(
  db: Db, publication: typeof chatPublications.$inferSelect, runId: string,
): Promise<string | null> {
  if (!isSlackPublicProgress(publication)) return null;
  if (await hasChatRunOwnedProviderInteraction(db, { companyId: publication.companyId, issueId: publication.issueId, runId })) {
    return "Run progress was superseded by its provider interaction";
  }
  const [answer] = await db.select({ id: chatPublications.id }).from(chatPublications)
    .innerJoin(issueComments, and(eq(issueComments.id, chatPublications.commentId), eq(issueComments.companyId, publication.companyId)))
    .where(and(eq(chatPublications.companyId, publication.companyId), eq(chatPublications.endpointId, publication.endpointId),
      eq(chatPublications.conversationId, publication.conversationId), eq(chatPublications.issueId, publication.issueId),
      eq(issueComments.createdByRunId, runId), eq(issueComments.authorType, "agent"),
      sql`${chatPublications.payload}->>'progressState' is null`,
      inArray(chatPublications.state, ["pending", "retry", "streaming", "published", "delivery_unknown"]))).limit(1);
  return answer ? "Run progress was superseded by its authored answer" : null;
}

const completionMarker = ":slack-progress-close:";

export async function slackProgressCompletionTarget(
  db: Db, publication: typeof chatPublications.$inferSelect,
): Promise<string | null | undefined> {
  if (!publication.idempotencyKey.includes(completionMarker)) return undefined;
  const targetId = publication.idempotencyKey.split(completionMarker)[1];
  const [target] = await db.select({ providerMessageId: chatPublications.providerMessageId })
    .from(chatPublications)
    .innerJoin(chatMessageLinks, and(eq(chatMessageLinks.publicationId, chatPublications.id),
      eq(chatMessageLinks.companyId, publication.companyId), eq(chatMessageLinks.endpointId, publication.endpointId),
      eq(chatMessageLinks.conversationId, publication.conversationId), eq(chatMessageLinks.direction, "outbound"),
      eq(chatMessageLinks.providerMessageId, chatPublications.providerMessageId)))
    .where(and(sql`${chatPublications.id}::text = ${targetId}`, eq(chatPublications.companyId, publication.companyId),
      eq(chatPublications.endpointId, publication.endpointId), eq(chatPublications.conversationId, publication.conversationId),
      eq(chatPublications.issueId, publication.issueId), eq(chatPublications.state, "published"), isNull(chatPublications.commentId),
      sql`starts_with(${chatPublications.idempotencyKey}, ${`run:${publication.idempotencyKey.split(":")[1]}:working:${publication.endpointId}`})`,
      sql`${chatPublications.payload}->>'progressState' in ('queued', 'working')`)).limit(1);
  return target?.providerMessageId ?? null;
}

export async function enqueueSlackProgressCompletion(db: DbOrTransaction, answer: typeof chatPublications.$inferSelect) {
  if (!answer.commentId) return;
  const [comment] = await db.select({ runId: issueComments.createdByRunId }).from(issueComments)
    .where(and(eq(issueComments.id, answer.commentId), eq(issueComments.companyId, answer.companyId),
      eq(issueComments.issueId, answer.issueId), eq(issueComments.authorType, "agent")));
  if (!comment?.runId) return;
  const baseKey = `run:${comment.runId}:working:${answer.endpointId}`;
  const targets = await db.select({ id: chatPublications.id, key: chatPublications.idempotencyKey })
    .from(chatPublications)
    .innerJoin(chatMessageLinks, and(eq(chatMessageLinks.publicationId, chatPublications.id),
      eq(chatMessageLinks.companyId, answer.companyId), eq(chatMessageLinks.endpointId, answer.endpointId),
      eq(chatMessageLinks.conversationId, answer.conversationId), eq(chatMessageLinks.direction, "outbound"),
      eq(chatMessageLinks.providerMessageId, chatPublications.providerMessageId)))
    .where(and(eq(chatPublications.companyId, answer.companyId), eq(chatPublications.endpointId, answer.endpointId),
      eq(chatPublications.conversationId, answer.conversationId), eq(chatPublications.issueId, answer.issueId),
      eq(chatPublications.state, "published"), isNull(chatPublications.commentId),
      sql`${chatPublications.payload}->>'progressState' in ('queued', 'working')`,
      sql`(${chatPublications.idempotencyKey} = ${baseKey} or starts_with(${chatPublications.idempotencyKey}, ${`${baseKey}:native:`}))`));
  for (const target of targets) {
    if (isSlackPublicProgress({ idempotencyKey: target.key })) continue;
    await notifyChatPublicationWork(db, answer);
    await db.insert(chatPublications).values({ companyId: answer.companyId, endpointId: answer.endpointId,
      conversationId: answer.conversationId, issueId: answer.issueId,
      idempotencyKey: `run:${comment.runId}:completed:${answer.endpointId}${completionMarker}${target.id}`,
      payload: { text: "Response sent.", progressState: "completed" }, state: "pending",
    }).onConflictDoNothing();
  }
}
