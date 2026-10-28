import { createGitHubPublicationPolicy } from "../github/publication-policy.js";

import type { EndpointRow, DbTransaction, DbOrTransaction, LifecycleRuntimeFence } from "../runtime-types.js";
import { createChatFailedRunRetry } from "../failed-run-retry.js";

import { notifyChatPublicationWork } from "../../chat-work-notifications.js";

import { type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import { authorizeSlackBoardPublication } from "../../slack-board-authority.js";

import { slackPublicationAllowed } from "../../connectors/slack-access.js";

import {
  and,
  eq,
  gt,
  inArray,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatEndpointResources,
  chatPublications,
  heartbeatRuns,
  issueComments,
} from "@paperclipai/db";

import {
  authorizeNativeChatReviewPresentation,
  NativeChatReviewPresentationContentionError,
} from "../../native-runtime/native-chat-review-presentation.js";
import { isExternalChatWaitAuthorizationContention } from "../../native-runtime/chat-attachment-reuse.js";

import { isExplicitOperatorPublication } from "./policy.js";
import { attachmentFailureNoticeFence } from "./policy.js";
import type { createChatPublicationTaskControl } from "./task-control.js";
type ConversationRow = typeof chatConversations.$inferSelect;
type PublicationAuthorizationOptions = {
  authorizeInboundWakePublication: (tx: DbOrTransaction, publication: typeof chatPublications.$inferSelect) => Promise<boolean>;
  authorizeRetainedChatSourcePublication: (tx: DbOrTransaction, publication: typeof chatPublications.$inferSelect) => Promise<boolean>;
  fetchImpl: typeof globalThis.fetch;
  githubCurrentOmissionPreparedText: ReturnType<typeof createGitHubPublicationPolicy>["githubCurrentOmissionPreparedText"];
  hasCommittedTaskControlCompletion: ReturnType<typeof createChatPublicationTaskControl>["hasCommittedTaskControlCompletion"];
  lockCurrentPrincipalAuthorization: (tx: DbOrTransaction, endpoint: EndpointRow, principalId: string) => Promise<{ allowed: boolean; userId?: string | null }>;
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: typeof chatEndpointResources.$inferSelect | null | undefined) => boolean;
  resolveCredentials: (endpoint: EndpointRow, tx?: DbOrTransaction) => Promise<Record<string, string>>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  FailedChatRetryPublicationReadError: ReturnType<typeof createChatFailedRunRetry>["FailedChatRetryPublicationReadError"];
};
export function createChatPublicationAuthorization(db: Db, options: PublicationAuthorizationOptions) {
  const { authorizeInboundWakePublication, authorizeRetainedChatSourcePublication, fetchImpl, githubCurrentOmissionPreparedText, hasCommittedTaskControlCompletion, lockCurrentPrincipalAuthorization, nonDirectDestinationAllowed, resolveCredentials, runtimeCallbackEndpoint, FailedChatRetryPublicationReadError } = options;


  async function claimPublicationTransportAuthorization(input: {
    credentialLease: CredentialMutationLeaseGuard;
    endpoint: EndpointRow;
    publication: typeof chatPublications.$inferSelect;
    runtimeContext: LifecycleRuntimeFence;
  }): Promise<{
    authorizationActionId: string | null;
    conversation: ConversationRow;
    endpoint: EndpointRow;
    preparedText: string | null;
  } | null> {
    return db.transaction(async (tx) => {
      await input.credentialLease.assertOwned(tx);
      const currentPublication = await tx
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.id, input.publication.id),
            eq(chatPublications.state, "streaming"),
            eq(chatPublications.attempts, input.publication.attempts + 1),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!currentPublication) return null;
      try {
        if (
          !(await authorizeRetainedChatSourcePublication(tx, input.publication))
        )
          return null;
      } catch (error) {
        if (error instanceof NativeChatReviewPresentationContentionError)
          throw error;
        throw new FailedChatRetryPublicationReadError();
      }
      const attachmentFailureFence = attachmentFailureNoticeFence(
        input.publication.idempotencyKey,
      );
      if (
        attachmentFailureFence &&
        (attachmentFailureFence.generation !==
          input.runtimeContext.generation ||
          attachmentFailureFence.credentialFingerprint !==
            input.runtimeContext.credentialFingerprint)
      ) {
        return null;
      }
      const endpoint = await runtimeCallbackEndpoint(
        tx,
        input.publication.endpointId,
        input.runtimeContext,
        ["verifying", "active"],
      );
      const conversation = endpoint
        ? await tx
            .select()
            .from(chatConversations)
            .where(
              and(
                eq(chatConversations.companyId, endpoint.companyId),
                eq(chatConversations.endpointId, endpoint.id),
                eq(chatConversations.id, input.publication.conversationId),
                inArray(chatConversations.state, [
                  "active",
                  "waiting",
                  "completed",
                ]),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      const resource =
        endpoint && conversation?.resourceId && !conversation.isDirectMessage
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
      const attachmentFailureNoticeSuperseded =
        attachmentFailureFence && conversation
          ? await tx
              .select({ id: chatConversations.id })
              .from(chatConversations)
              .where(
                and(
                  eq(chatConversations.companyId, conversation.companyId),
                  eq(chatConversations.endpointId, conversation.endpointId),
                  eq(
                    chatConversations.externalThreadId,
                    conversation.externalThreadId,
                  ),
                  gt(
                    chatConversations.sessionGeneration,
                    conversation.sessionGeneration,
                  ),
                ),
              )
              .limit(1)
              .then((rows) => rows.length > 0)
          : false;
      const isTaskControl =
        input.publication.idempotencyKey.startsWith("control:");
      const providerVisibleCompletion =
        conversation?.state === "completed" &&
        !isExplicitOperatorPublication(input.publication) &&
        (await hasCommittedTaskControlCompletion(conversation.id, tx));
      const authorizationAction =
        endpoint && isTaskControl
          ? await tx
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.companyId, endpoint.companyId),
                  eq(chatActions.endpointId, endpoint.id),
                  eq(chatActions.conversationId, conversation?.id ?? ""),
                  eq(chatActions.kind, "task_control_authorization"),
                  eq(
                    chatActions.providerActionId,
                    `task-control-authorization:${input.publication.id}`,
                  ),
                  eq(chatActions.status, "issued"),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null)
          : null;
      const destinationAllowed =
        endpoint !== null &&
        conversation !== null &&
        (endpoint.provider !== "slack" || await slackPublicationAllowed(tx, endpoint.companyId, endpoint.id, input.publication.issueId, conversation.externalConversationId, null)) &&
        (conversation.isDirectMessage
          ? endpoint.allowDirectMessages
          : nonDirectDestinationAllowed(endpoint, resource));
      if (
        !endpoint ||
        !conversation ||
        (attachmentFailureFence &&
          ((conversation.state !== "active" &&
            conversation.state !== "waiting") ||
            attachmentFailureNoticeSuperseded)) ||
        providerVisibleCompletion ||
        (isTaskControl && !authorizationAction?.principalId) ||
        !destinationAllowed
      ) {
        return null;
      }
      let authorizationActionId: string | null = null;
      if (endpoint.provider === "slack") {
        const credentials = await resolveCredentials(endpoint, tx);
        if (!await authorizeSlackBoardPublication(tx, endpoint, conversation, input.publication, credentials.botToken ?? "", fetchImpl)) return null;
      }
      if (
        input.publication.idempotencyKey.startsWith("wake:") &&
        !(await authorizeInboundWakePublication(tx, input.publication))
      )
        return null;
      // A native response alongside an older completion review has its own
      // narrow authorization. Recheck that exact proof, review and original
      // requester at the transport claim, including file publications whose
      // comment is the run's earlier internal attachment-selection comment.
      if (
        input.publication.commentId &&
        !isExplicitOperatorPublication(input.publication)
      ) {
        const [origin] = await tx
          .select({
            runId: heartbeatRuns.id,
            resultJson: heartbeatRuns.resultJson,
          })
          .from(issueComments)
          .innerJoin(
            heartbeatRuns,
            and(
              eq(heartbeatRuns.id, issueComments.createdByRunId),
              eq(heartbeatRuns.companyId, issueComments.companyId),
            ),
          )
          .where(
            and(
              eq(issueComments.id, input.publication.commentId),
              eq(issueComments.companyId, endpoint.companyId),
              eq(issueComments.issueId, input.publication.issueId),
            ),
          )
          .limit(1);
        if (
          origin?.resultJson?.finalizationReasonCode ===
          "governed_response_waiting"
        ) {
          try {
            if (
              !(await authorizeNativeChatReviewPresentation(
                tx as unknown as Db,
                {
                  companyId: endpoint.companyId,
                  issueId: input.publication.issueId,
                  runId: origin.runId,
                  resultJson: origin.resultJson,
                  destination: {
                    endpointId: endpoint.id,
                    conversationId: conversation.id,
                  },
                },
                "nonblocking",
              ))
            )
              return null;
          } catch (error) {
            if (isExternalChatWaitAuthorizationContention(error))
              throw new NativeChatReviewPresentationContentionError();
            throw error;
          }
        }
      }
      const preparedText = await githubCurrentOmissionPreparedText(
        tx,
        input.publication,
        endpoint,
      );
      if (preparedText === false) return null;
      if (authorizationAction?.principalId) {
        const authorization = await lockCurrentPrincipalAuthorization(
          tx,
          endpoint,
          authorizationAction.principalId,
        );
        if (!authorization.allowed) return null;
        const [claimedAuthorization] = await tx
          .update(chatActions)
          .set({
            status: "processing",
            result: {
              attempts: input.publication.attempts + 1,
              authorizedUserId: authorization.userId,
              credentialFingerprint: input.runtimeContext.credentialFingerprint,
              runtimeGeneration: input.runtimeContext.generation,
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, authorizationAction.id),
              eq(chatActions.status, "issued"),
            ),
          )
          .returning({ id: chatActions.id });
        if (!claimedAuthorization) return null;
        authorizationActionId = claimedAuthorization.id;
      }
      if (preparedText !== null) {
        // Persist the exact provider text before I/O. A retry must reuse this
        // body, not accumulate links or regenerate it from changed settings.
        await notifyChatPublicationWork(tx);
        await tx
          .update(chatPublications)
          .set({
            payload: { ...input.publication.payload, text: preparedText },
          })
          .where(eq(chatPublications.id, input.publication.id));
      }
      await input.credentialLease.assertOwned(tx);
      // The publication's streaming row plus the optional authorization action
      // are the durable transport claim. Their database locks are released
      // before provider I/O. The renewable credential lease intentionally
      // remains held so reconnect and reach mutations linearize after this
      // committed authorization snapshot and transport attempt.
      return {
        authorizationActionId,
        conversation,
        endpoint,
        preparedText,
      };
    });
  }
  return { claimPublicationTransportAuthorization };
}
