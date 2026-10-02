import { and, eq, sql, inArray } from "drizzle-orm";
import {
  chatActions,
  chatConversations,
  issueComments,
  type chatPublications,
  type Db,
} from "@paperclipai/db";
import { object } from "./slack-client.js";

/** Explicit sends use a separate durable receipt. Suppress an identical automatic
 * final, but retain distinct summaries, questions, blockers and progress. */
export async function slackExplicitPublicationDuplicate(
  db: Db,
  publication: typeof chatPublications.$inferSelect,
) {
  if (
    !publication.commentId ||
    publication.payload.interactionId ||
    publication.payload.progressState ||
    publication.payload.attachmentIds?.length
  )
    return null;
  const [comment] = await db
    .select({
      runId: sql<string>`coalesce(${issueComments.createdByRunId}, ${issueComments.derivedCreatedByRunId})`,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.id, publication.commentId),
        eq(issueComments.companyId, publication.companyId),
        eq(issueComments.issueId, publication.issueId),
      ),
    );
  if (!comment?.runId) return null;
  const [conversation] = await db
    .select()
    .from(chatConversations)
    .where(
      and(
        eq(chatConversations.id, publication.conversationId),
        eq(chatConversations.companyId, publication.companyId),
      ),
    );
  if (!conversation) return null;
  const sends = await db
    .select({ payload: chatActions.payload, status: chatActions.status })
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, publication.companyId),
        eq(chatActions.endpointId, publication.endpointId),
        eq(chatActions.conversationId, publication.conversationId),
        eq(chatActions.kind, "slack_tool_write"),
        inArray(chatActions.status, [
          "processed",
          "received",
          "processing",
          "uncertain",
        ]),
        sql`${chatActions.payload}->'binding'->>'runId' = ${comment.runId}`,
        sql`${chatActions.payload}->>'name' = 'slack_post_message'`,
      ),
    );
  const match = sends.find(({ payload }) => {
    const args = object(payload.args);
    const thread = conversation.externalThreadId.split(":").at(-1);
    return (
      args.channel ===
        conversation.externalConversationId.replace(/^slack:/, "") &&
      args.thread_ts === thread &&
      String(args.text).trim() === publication.payload.text.trim()
    );
  });
  return match
    ? match.status === "processed"
      ? "delivered"
      : "unresolved"
    : null;
}
