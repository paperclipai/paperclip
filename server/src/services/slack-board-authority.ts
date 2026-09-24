import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import {
  chatActions,
  chatExternalPrincipals,
  chatIdentityLinks,
  companyMemberships,
  heartbeatRuns,
  issueComments,
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
  const userId = source.comment.authorType === "user"
    ? source.comment.authorUserId
    : source.run?.responsibleUserId;
  if (!userId) return true;
  const [receipt] = await db
    .select({ payload: chatActions.payload })
    .from(chatActions)
    .where(and(
      eq(chatActions.companyId, endpoint.companyId),
      eq(chatActions.endpointId, endpoint.id),
      eq(chatActions.conversationId, conversation.id),
      eq(chatActions.kind, "slack_board_message"),
      eq(sql<string>`${chatActions.payload}->>'userId'`, userId),
      eq(sql<string>`${chatActions.payload}->>'issueId'`, publication.issueId),
      ...(source.comment.authorType === "user"
        ? [eq(sql<string>`${chatActions.payload}->>'commentId'`, source.comment.id)]
        : []),
    ))
    .orderBy(desc(chatActions.createdAt))
    .limit(1);
  if (!receipt) return true;
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
