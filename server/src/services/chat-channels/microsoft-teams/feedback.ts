import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatConversations,
  chatEndpointResources,
  chatExternalPrincipals,
  chatMessageLinks,
  issueComments,
  issues,
} from "@paperclipai/db";
import { logger } from "../../../middleware/logger.js";
import { logActivity } from "../../activity-log.js";
import { externalThreadIdentityCondition } from "../../chat-control-chronology.js";
import type { ChatSdkCallbackEvent } from "../../chat-sdk-runtime.js";
import { normalizeMicrosoftTeamsExternalPrincipalId } from "../../chat-teams-credentials.js";
import { feedbackService } from "../../feedback.js";
import { nonDirectDestinationAllowed } from "../inbound/surfaces.js";
import type { PublicationTransportInput } from "../publications/types.js";
import type {
  DbOrTransaction,
  EndpointRecord,
  EndpointRow,
  RuntimeContext,
} from "../runtime-types.js";
import type { TeamsFeedbackEvent } from "./feedback-loop.js";

type TeamsFeedbackVoteOptions = {
  runtimeCallbackRecord: (
    endpointId: string,
    context: RuntimeContext,
    statuses: EndpointRow["status"][],
  ) => Promise<EndpointRecord | null>;
  lockCurrentPrincipalAuthorization: (
    tx: DbOrTransaction,
    endpoint: EndpointRow,
    principalId: string,
  ) => Promise<{ allowed: boolean; userId: string | null }>;
};

export async function teamsFeedbackLoopPublication(
  db: DbOrTransaction,
  input: Pick<PublicationTransportInput, "endpoint" | "publication" | "payload">,
): Promise<boolean> {
  const { endpoint, publication, payload } = input;
  if (
    endpoint.provider !== "microsoft-teams" ||
    !publication.commentId ||
    payload.progressState !== undefined ||
    payload.card !== undefined ||
    payload.interactionId !== undefined ||
    (payload.attachmentIds?.length ?? 0) > 0
  )
    return false;
  const rows = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, publication.companyId),
        eq(issueComments.id, publication.commentId),
        isNotNull(issueComments.authorAgentId),
        isNull(issueComments.deletedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export function createTeamsFeedbackVotes(
  db: Db,
  options: TeamsFeedbackVoteOptions,
) {
  const { runtimeCallbackRecord, lockCurrentPrincipalAuthorization } = options;
  const feedback = feedbackService(db);

  async function ratedAgentComment(
    endpoint: EndpointRow,
    event: TeamsFeedbackEvent,
  ) {
    return db
      .select({
        commentId: issueComments.id,
        issueId: issues.id,
        issueIdentifier: issues.identifier,
        conversation: chatConversations,
      })
      .from(chatMessageLinks)
      .innerJoin(
        chatConversations,
        and(
          eq(chatConversations.companyId, chatMessageLinks.companyId),
          eq(chatConversations.endpointId, chatMessageLinks.endpointId),
          eq(chatConversations.id, chatMessageLinks.conversationId),
        ),
      )
      .innerJoin(
        issueComments,
        and(
          eq(issueComments.companyId, chatMessageLinks.companyId),
          eq(issueComments.id, chatMessageLinks.commentId),
        ),
      )
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, issueComments.companyId),
          eq(issues.id, issueComments.issueId),
        ),
      )
      .where(
        and(
          eq(chatMessageLinks.companyId, endpoint.companyId),
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.providerMessageId, event.replyToId),
          eq(chatMessageLinks.direction, "outbound"),
          isNotNull(chatMessageLinks.commentId),
          isNotNull(issueComments.authorAgentId),
          isNull(issueComments.deletedAt),
          externalThreadIdentityCondition(
            sql<string>`${chatConversations.externalThreadId}`,
            event.threadId,
          ),
        ),
      )
      .orderBy(desc(chatConversations.sessionGeneration))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function voteAuthor(
    endpoint: EndpointRow,
    conversation: typeof chatConversations.$inferSelect,
    event: TeamsFeedbackEvent,
  ): Promise<{ authorUserId: string; linked: boolean } | null> {
    const [principal] = await db
      .select({ id: chatExternalPrincipals.id })
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.companyId, endpoint.companyId),
          eq(chatExternalPrincipals.provider, endpoint.provider),
          eq(
            chatExternalPrincipals.providerAccountId,
            endpoint.providerAccountId ?? "unknown",
          ),
          eq(
            chatExternalPrincipals.externalId,
            normalizeMicrosoftTeamsExternalPrincipalId(
              event.aadObjectId,
              event.userId,
            ),
          ),
        ),
      )
      .limit(1);
    if (!principal) return null;
    return db.transaction(async (tx) => {
      const resource =
        conversation.resourceId && !conversation.isDirectMessage
          ? await tx
              .select()
              .from(chatEndpointResources)
              .where(
                and(
                  eq(chatEndpointResources.companyId, endpoint.companyId),
                  eq(chatEndpointResources.endpointId, endpoint.id),
                  eq(chatEndpointResources.id, conversation.resourceId),
                ),
              )
              .then((rows) => rows[0] ?? null)
          : null;
      const destinationAllowed = conversation.isDirectMessage
        ? endpoint.allowDirectMessages
        : nonDirectDestinationAllowed(endpoint, resource);
      if (!destinationAllowed) return null;
      const authorization = await lockCurrentPrincipalAuthorization(
        tx,
        endpoint,
        principal.id,
      );
      if (!authorization.allowed) return null;
      return authorization.userId
        ? { authorUserId: authorization.userId, linked: true }
        : { authorUserId: `chat:${principal.id}`, linked: false };
    });
  }

  async function recordTeamsFeedback(
    callback: ChatSdkCallbackEvent<TeamsFeedbackEvent>,
    context: RuntimeContext,
  ): Promise<void> {
    if (callback.provider !== "microsoft-teams") return;
    const record = await runtimeCallbackRecord(callback.endpointId, context, [
      "active",
    ]);
    if (!record || record.endpoint.provider !== "microsoft-teams") return;
    const endpoint = record.endpoint;
    const target = await ratedAgentComment(endpoint, callback.event);
    if (!target) return;
    const author = await voteAuthor(
      endpoint,
      target.conversation,
      callback.event,
    );
    if (!author) return;
    const result = await feedback.saveIssueVote({
      issueId: target.issueId,
      targetType: "issue_comment",
      targetId: target.commentId,
      vote: callback.event.vote,
      reason: callback.event.reason,
      authorUserId: author.authorUserId,
      allowSharing: false,
      recordSharingConsent: false,
    });
    await logActivity(db, {
      companyId: endpoint.companyId,
      actorType: author.linked ? "user" : "system",
      actorId: author.authorUserId,
      action: "issue.feedback_vote_saved",
      entityType: "issue",
      entityId: target.issueId,
      details: {
        identifier: target.issueIdentifier,
        targetType: result.vote.targetType,
        targetId: result.vote.targetId,
        vote: result.vote.vote,
        hasReason: Boolean(result.vote.reason),
        sharingEnabled: result.sharingEnabled,
        source: "chat:microsoft-teams",
        endpointId: endpoint.id,
      },
    });
  }

  async function handleTeamsFeedback(
    callback: ChatSdkCallbackEvent<TeamsFeedbackEvent>,
    context: RuntimeContext,
  ): Promise<void> {
    try {
      await recordTeamsFeedback(callback, context);
    } catch (error) {
      logger.warn(
        { err: error, endpointId: callback.endpointId },
        "Teams feedback vote was not recorded",
      );
    }
  }

  return { handleTeamsFeedback };
}
