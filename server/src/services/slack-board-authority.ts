import { and, desc, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import {
  chatActions,
  chatExternalPrincipals,
  chatIdentityLinks,
  companyMemberships,
  heartbeatRuns,
  issueComments,
  runIdentityContexts,
  type chatEndpoints,
  type chatConversations,
  type chatPublications,
  type Db,
} from "@paperclipai/db";
import { HttpError } from "../errors.js";
import { authorizeSlackChannel } from "./connectors/slack-access.js";
import { slackClient } from "./connectors/slack-client.js";

type Reader = Pick<Db, "select">;
type Endpoint = typeof chatEndpoints.$inferSelect;

export async function slackBoardAuthor(db: Reader, endpoint: Endpoint, userId: string) {
  const links = await db
    .select({ principal: chatExternalPrincipals })
    .from(chatIdentityLinks)
    .innerJoin(chatExternalPrincipals, and(
      eq(chatExternalPrincipals.id, chatIdentityLinks.principalId),
      eq(chatExternalPrincipals.companyId, endpoint.companyId),
      eq(chatExternalPrincipals.provider, "slack"),
      eq(chatExternalPrincipals.providerAccountId, endpoint.providerAccountId ?? ""),
      eq(chatExternalPrincipals.isBot, false),
    ))
    .innerJoin(companyMemberships, and(
      eq(companyMemberships.companyId, endpoint.companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.status, "active"),
      ne(companyMemberships.membershipRole, "viewer"),
    ))
    .where(and(
      eq(chatIdentityLinks.companyId, endpoint.companyId),
      eq(chatIdentityLinks.endpointId, endpoint.id),
      eq(chatIdentityLinks.paperclipUserId, userId),
      eq(chatIdentityLinks.status, "linked"),
      isNull(chatIdentityLinks.revokedAt),
    ))
    .limit(2);
  return links.length === 1 ? links[0]!.principal : null;
}

/** Recheck the author of a durable Board receipt immediately before transport.
 * The source comment/run supplies identity; publication text never does. */
export async function authorizeSlackBoardPublication(
  db: Reader,
  endpoint: Endpoint,
  conversation: typeof chatConversations.$inferSelect,
  publication: typeof chatPublications.$inferSelect,
  botToken: string,
  fetchImpl: typeof fetch,
) {
  if (!publication.commentId) return true;
  const [source] = await db
    .select({ comment: issueComments, run: heartbeatRuns })
    .from(issueComments)
    .leftJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, issueComments.createdByRunId),
      eq(heartbeatRuns.companyId, endpoint.companyId),
    ))
    .where(and(
      eq(issueComments.id, publication.commentId),
      eq(issueComments.companyId, endpoint.companyId),
      eq(issueComments.issueId, publication.issueId),
    ));
  if (!source) return false;
  let userId = source.comment.authorUserId;
  let commentIds = [source.comment.id];
  if (source.comment.authorType !== "user") {
    if (!source.run) return true;
    // Use immutable attribution as of this response, not the run's mutable
    // current user or a newer Board receipt on the same task. Recovery contexts
    // inherit their original message through parentContextId.
    let [identity] = await db.select().from(runIdentityContexts).where(and(
      eq(runIdentityContexts.companyId, endpoint.companyId),
      eq(runIdentityContexts.runId, source.run.id),
      eq(runIdentityContexts.status, "accepted"),
      lte(runIdentityContexts.createdAt, source.comment.createdAt),
    )).orderBy(desc(runIdentityContexts.revision)).limit(1);
    userId = identity?.responsibleUserId ?? source.run.responsibleUserId;
    commentIds = [];
    for (let depth = 0; identity && depth < 32; depth++) {
      if (identity.responsibleUserId !== userId) break;
      if (identity.messageId) { commentIds.push(identity.messageId); break; }
      if (!identity.parentContextId) break;
      [identity] = await db.select().from(runIdentityContexts).where(and(
        eq(runIdentityContexts.id, identity.parentContextId),
        eq(runIdentityContexts.companyId, endpoint.companyId),
        eq(runIdentityContexts.status, "accepted"),
      )).limit(1);
    }
    if (!commentIds.length) {
      const snapshot = source.run.contextSnapshot ?? {};
      commentIds = [snapshot.wakeCommentId, snapshot.commentId, ...(Array.isArray(snapshot.wakeCommentIds) ? snapshot.wakeCommentIds : [])]
        .filter((id): id is string => typeof id === "string");
    }
  }
  if (!userId || !commentIds.length) return true;
  const [receipt] = await db
    .select({ payload: chatActions.payload, status: chatActions.status })
    .from(chatActions)
    .where(and(
      eq(chatActions.companyId, endpoint.companyId),
      eq(chatActions.endpointId, endpoint.id),
      eq(chatActions.conversationId, conversation.id),
      eq(chatActions.kind, "slack_board_message"),
      eq(sql<string>`${chatActions.payload}->>'userId'`, userId),
      eq(sql<string>`${chatActions.payload}->>'issueId'`, publication.issueId),
      inArray(sql<string>`${chatActions.payload}->>'commentId'`, commentIds),
    ))
    .orderBy(desc(chatActions.createdAt))
    .limit(1);
  if (!receipt) return true;
  if (receipt.status === "cancelled") return false;
  if (source.comment.deletedAt) return false;
  const principal = await slackBoardAuthor(db, endpoint, userId);
  if (!principal || receipt.payload.principalId !== principal.id || !botToken) return false;
  try {
    await authorizeSlackChannel(
      { endpoint, slackUserId: principal.externalId },
      slackClient(botToken, fetchImpl),
      conversation.externalConversationId.replace(/^slack:/, ""),
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return false;
    throw error;
  }
  return true;
}
