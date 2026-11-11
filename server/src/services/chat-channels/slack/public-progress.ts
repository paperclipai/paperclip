import { and, eq, sql } from "drizzle-orm";
import { chatMessageLinks, chatPublications, fastResponseRequests, heartbeatRuns, type Db } from "@paperclipai/db";

/** Reuse only the bot receipt for this run's exact accepted source and current
 * conversation. Its current outbound link proves another output has not
 * consumed the message since that receipt was published. */
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
