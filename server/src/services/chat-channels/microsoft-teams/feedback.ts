import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatExternalPrincipals,
  chatMessageLinks,
  chatPublications,
  issueComments,
  issues,
} from "@paperclipai/db";
import { logger } from "../../../middleware/logger.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "../../activity-log.js";
import { externalThreadIdentityCondition } from "../../chat-control-chronology.js";
import type { ChatSdkCallbackEvent } from "../../chat-sdk-runtime.js";
import { normalizeMicrosoftTeamsExternalPrincipalId } from "../../chat-teams-credentials.js";
import { notifyChatDeliveryWork } from "../../chat-work-notifications.js";
import { feedbackService } from "../../feedback.js";
import { nonDirectDestinationAllowed } from "../inbound/surfaces.js";
import type { PublicationTransportInput } from "../publications/types.js";
import type {
  DbOrTransaction,
  DbTransaction,
  EndpointRecord,
  EndpointRow,
  LifecycleRuntimeFence,
  RuntimeContext,
} from "../runtime-types.js";
import type { TeamsFeedbackEvent } from "./feedback-loop.js";

const TEAMS_FEEDBACK_SETTLEMENT_WINDOW_MS = 2 * 60_000;

type TeamsFeedbackVoteOptions = {
  runtimeCallbackRecord: (
    endpointId: string,
    context: RuntimeContext,
    statuses: EndpointRow["status"][],
  ) => Promise<EndpointRecord | null>;
  runtimeCallbackEndpoint: (
    tx: DbTransaction,
    endpointId: string,
    context: LifecycleRuntimeFence,
    statuses: EndpointRow["status"][],
  ) => Promise<EndpointRow | null>;
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
  const {
    runtimeCallbackRecord,
    runtimeCallbackEndpoint,
    lockCurrentPrincipalAuthorization,
  } = options;
  const feedback = feedbackService(db);

  async function ratedAgentComment(
    tx: DbTransaction,
    endpoint: EndpointRow,
    event: TeamsFeedbackEvent,
  ) {
    return tx
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
      .for("share", { of: [chatConversations, issueComments] })
      .then((rows) => rows[0] ?? null);
  }

  async function settlementPending(
    tx: DbTransaction,
    endpoint: EndpointRow,
    event: TeamsFeedbackEvent,
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: chatPublications.id })
      .from(chatPublications)
      .innerJoin(
        chatConversations,
        and(
          eq(chatConversations.companyId, chatPublications.companyId),
          eq(chatConversations.endpointId, chatPublications.endpointId),
          eq(chatConversations.id, chatPublications.conversationId),
        ),
      )
      .innerJoin(
        issueComments,
        and(
          eq(issueComments.companyId, chatPublications.companyId),
          eq(issueComments.id, chatPublications.commentId),
        ),
      )
      .where(
        and(
          eq(chatPublications.companyId, endpoint.companyId),
          eq(chatPublications.endpointId, endpoint.id),
          eq(chatPublications.state, "streaming"),
          gt(
            chatPublications.updatedAt,
            new Date(Date.now() - TEAMS_FEEDBACK_SETTLEMENT_WINDOW_MS),
          ),
          isNotNull(issueComments.authorAgentId),
          isNull(issueComments.deletedAt),
          externalThreadIdentityCondition(
            sql<string>`${chatConversations.externalThreadId}`,
            event.threadId,
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async function recordInvokeReceipt(
    tx: DbTransaction,
    endpoint: EndpointRow,
    conversationId: string,
    principalId: string,
    event: TeamsFeedbackEvent,
  ): Promise<boolean> {
    const providerEventId = `teams-feedback:${event.activityId}`;
    const processedAt = new Date();
    await notifyChatDeliveryWork(tx);
    const [receipt] = await tx
      .insert(chatDeliveries)
      .values({
        companyId: endpoint.companyId,
        endpointId: endpoint.id,
        conversationId,
        principalId,
        providerEventId,
        deduplicationKey: createHash("sha256")
          .update(providerEventId)
          .digest("hex"),
        eventKind: "action",
        normalizedEvent: { providerEventId, kind: "action" },
        state: "processed",
        attempts: 1,
        processedAt,
        updatedAt: processedAt,
      })
      .onConflictDoNothing()
      .returning({ id: chatDeliveries.id });
    return Boolean(receipt);
  }

  async function feedbackPrincipal(
    endpoint: EndpointRow,
    event: TeamsFeedbackEvent,
  ): Promise<{ id: string } | null> {
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
    return principal ?? null;
  }

  async function voteAuthor(
    tx: DbTransaction,
    endpoint: EndpointRow,
    conversation: typeof chatConversations.$inferSelect,
    principalId: string,
  ): Promise<{ authorUserId: string; linked: boolean } | null> {
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
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
    const destinationAllowed = conversation.isDirectMessage
      ? endpoint.allowDirectMessages
      : nonDirectDestinationAllowed(endpoint, resource);
    if (!destinationAllowed) return null;
    const authorization = await lockCurrentPrincipalAuthorization(
      tx,
      endpoint,
      principalId,
    );
    if (!authorization.allowed) return null;
    return authorization.userId
      ? { authorUserId: authorization.userId, linked: true }
      : { authorUserId: `chat:${principalId}`, linked: false };
  }

  async function recordTeamsFeedback(
    callback: ChatSdkCallbackEvent<TeamsFeedbackEvent>,
    context: RuntimeContext,
  ): Promise<"retry" | void> {
    if (callback.provider !== "microsoft-teams") return;
    const record = await runtimeCallbackRecord(callback.endpointId, context, [
      "active",
    ]);
    if (!record || record.endpoint.provider !== "microsoft-teams") return;
    const principal = await feedbackPrincipal(record.endpoint, callback.event);
    if (!principal) return;
    const publications: ActivityPublication[] = [];
    const outcome = await db.transaction(async (tx) => {
      const endpoint = await runtimeCallbackEndpoint(
        tx,
        callback.endpointId,
        context,
        ["active"],
      );
      if (!endpoint || endpoint.provider !== "microsoft-teams") return;
      const target = await ratedAgentComment(tx, endpoint, callback.event);
      if (!target) {
        return (await settlementPending(tx, endpoint, callback.event))
          ? ("retry" as const)
          : undefined;
      }
      const author = await voteAuthor(
        tx,
        endpoint,
        target.conversation,
        principal.id,
      );
      if (!author) return;
      if (
        !(await recordInvokeReceipt(
          tx,
          endpoint,
          target.conversation.id,
          principal.id,
          callback.event,
        ))
      )
        return;
      const result = await feedback.saveIssueVoteInTransaction(tx, {
        issueId: target.issueId,
        targetType: "issue_comment",
        targetId: target.commentId,
        vote: callback.event.vote,
        reason: callback.event.reason,
        authorUserId: author.authorUserId,
        allowSharing: false,
        recordSharingConsent: false,
      });
      await logActivity(
        tx as unknown as Db,
        {
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
        },
        publications,
      );
    });
    for (const publication of publications) publishActivity(publication);
    return outcome;
  }

  async function handleTeamsFeedback(
    callback: ChatSdkCallbackEvent<TeamsFeedbackEvent>,
    context: RuntimeContext,
  ): Promise<"retry" | void> {
    try {
      return await recordTeamsFeedback(callback, context);
    } catch (error) {
      logger.warn(
        { err: error, endpointId: callback.endpointId },
        "Teams feedback vote was not recorded",
      );
    }
  }

  return { handleTeamsFeedback };
}
