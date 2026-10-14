import { isOutboundAttachmentHydrationError, isOutboundAttachmentValidationError } from "../outbound-attachments.js";

import type { EndpointRow, DbTransaction, LifecycleRuntimeFence } from "../runtime-types.js";
import { createChatFailedRunRetry } from "../failed-run-retry.js";

import { notifyChatPublicationWork } from "../../chat-work-notifications.js";

import { type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import {
  and,
  eq,
  inArray,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  chatPublications,
  toolConnections,
} from "@paperclipai/db";

import { logger } from "../../../middleware/logger.js";
import { redactSensitiveText } from "../../../redaction.js";

import {
  NativeChatReviewPresentationContentionError,
} from "../../native-runtime/native-chat-review-presentation.js";

import { projectSafeChatPublication } from "../../chat-publication-projection.js";
import { safeChatTaskUrl } from "../../chat-task-url.js";

import { classifyChatPublicationError } from "../../chat-publication-errors.js";

import { ATTACHMENT_FAILURE_NOTICE_PREFIX, definiteAttachmentProviderRejection, attachmentFailureKind } from "./policy.js";
type PublicationFailuresOptions = {
  FailedChatRetryPublicationReadError: ReturnType<typeof createChatFailedRunRetry>["FailedChatRetryPublicationReadError"];
  MAX_ERROR_TEXT: number;
  getTaskBaseUrl: () => string | null | undefined;
  invalidateRuntime: (endpointId: string) => Promise<boolean>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
};
export function createChatPublicationFailures(db: Db, options: PublicationFailuresOptions) {
  const { FailedChatRetryPublicationReadError, MAX_ERROR_TEXT, getTaskBaseUrl, invalidateRuntime, runtimeCallbackEndpoint } = options;


  async function finalizePublicationFailure(
    publication: typeof chatPublications.$inferSelect,
    error: unknown,
    providerAccepted = false,
    runtimeContext?: LifecycleRuntimeFence | null,
    credentialLease?: CredentialMutationLeaseGuard,
  ): Promise<boolean> {
    const attempts = publication.attempts + 1;
    const disposition = providerAccepted
      ? {
          kind: "delivery_unknown" as const,
          reason:
            "Provider accepted the publication, but Paperclip could not confirm its durable result",
        }
      : error instanceof NativeChatReviewPresentationContentionError
        ? { kind: "retry" as const, retryAfterMs: 250, reason: error.message }
        : error instanceof FailedChatRetryPublicationReadError
          ? {
              kind: "retry" as const,
              retryAfterMs: 1_000,
              reason: error.message,
            }
          : isOutboundAttachmentValidationError(error)
            ? {
                kind: "failed" as const,
                reason: error.message,
              }
            : isOutboundAttachmentHydrationError(error)
              ? {
                  kind: "retry" as const,
                  retryAfterMs: Math.min(
                    60_000,
                    2 ** Math.max(0, attempts) * 1_000,
                  ),
                  reason: error.message,
                }
              : classifyChatPublicationError(error, attempts);
    const failure = redactSensitiveText(disposition.reason).slice(
      0,
      MAX_ERROR_TEXT,
    );
    // Provider-directed rate limits are not delivery failures. Keep the
    // durable publication retryable for the provider's full interval instead
    // of exhausting the five-attempt transport budget while flood control is
    // still active.
    const terminalRetry =
      disposition.kind === "retry" &&
      disposition.providerRateLimit !== true &&
      attempts >= 5;
    const attachmentFailure = attachmentFailureKind(publication.payload);
    const attachmentFailureRuntimeContext =
      !providerAccepted &&
      disposition.kind === "failed" &&
      runtimeContext &&
      attachmentFailure &&
      definiteAttachmentProviderRejection(error)
        ? runtimeContext
        : null;
    let invalidateCurrentRuntime = false;
    const finalized = await db.transaction(async (tx) => {
      await credentialLease?.assertOwned(tx);
      const state =
        disposition.kind === "retry" && !terminalRetry
          ? "retry"
          : disposition.kind === "delivery_unknown"
            ? "delivery_unknown"
            : disposition.kind === "resource_unavailable"
              ? "cancelled"
              : "failed";
      await notifyChatPublicationWork(tx);
      const [ownedPublication] = await tx
        .update(chatPublications)
        .set({
          state,
          nextAttemptAt:
            disposition.kind === "retry" && !terminalRetry
              ? new Date(Date.now() + disposition.retryAfterMs)
              : null,
          redactedError: failure,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatPublications.id, publication.id),
            eq(chatPublications.state, "streaming"),
            eq(chatPublications.attempts, attempts),
          ),
        )
        .returning({ id: chatPublications.id });
      if (!ownedPublication) return false;

      if (publication.idempotencyKey.startsWith("control:")) {
        await tx
          .update(chatActions)
          .set({
            status:
              state === "delivery_unknown"
                ? "delivery_unknown"
                : state === "cancelled"
                  ? "cancelled"
                  : "issued",
            result: {
              code:
                state === "delivery_unknown"
                  ? "task_control_delivery_unknown"
                  : state === "cancelled"
                    ? "task_control_destination_unavailable"
                    : "task_control_transport_failed",
              attempts,
              retryable: state === "retry",
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.endpointId, publication.endpointId),
              eq(
                chatActions.providerActionId,
                `task-control-authorization:${publication.id}`,
              ),
              eq(chatActions.status, "processing"),
              sql`(${chatActions.result}->>'attempts')::int = ${attempts}`,
            ),
          );
      }

      const currentEndpoint =
        runtimeContext &&
        (disposition.kind === "endpoint_attention" ||
          disposition.kind === "resource_unavailable")
          ? await runtimeCallbackEndpoint(
              tx,
              publication.endpointId,
              runtimeContext,
              ["verifying", "active"],
            )
          : null;

      if (disposition.kind === "endpoint_attention" && currentEndpoint) {
        await tx
          .update(chatEndpoints)
          .set({
            status: "attention",
            healthMessage: "Provider credentials or permissions need attention",
            lastError: failure,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, currentEndpoint.id));
        await tx
          .update(toolConnections)
          .set({
            status: "disabled",
            enabled: false,
            healthStatus: "degraded",
            healthMessage: "Provider credentials or permissions need attention",
            lastError: failure,
            healthCheckedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, currentEndpoint.connectionId));
        invalidateCurrentRuntime = true;
      } else if (
        disposition.kind === "resource_unavailable" &&
        currentEndpoint
      ) {
        const binding = await tx
          .select({ resourceId: chatConversations.resourceId })
          .from(chatConversations)
          .where(eq(chatConversations.id, publication.conversationId))
          .then((result) => result[0] ?? null);
        await tx
          .update(chatConversations)
          .set({ state: "unavailable", updatedAt: new Date() })
          .where(
            and(
              eq(chatConversations.id, publication.conversationId),
              eq(chatConversations.endpointId, currentEndpoint.id),
            ),
          );
        if (binding?.resourceId) {
          await tx
            .update(chatEndpointResources)
            .set({ availability: "unavailable", updatedAt: new Date() })
            .where(
              and(
                eq(chatEndpointResources.id, binding.resourceId),
                eq(chatEndpointResources.endpointId, currentEndpoint.id),
              ),
            );
        }
      }

      if (attachmentFailureRuntimeContext && attachmentFailure) {
        const noticeEndpoint = await runtimeCallbackEndpoint(
          tx,
          publication.endpointId,
          attachmentFailureRuntimeContext,
          ["verifying", "active"],
        );
        const noticeConversation = noticeEndpoint
          ? await tx
              .select({
                id: chatConversations.id,
                state: chatConversations.state,
              })
              .from(chatConversations)
              .where(
                and(
                  eq(chatConversations.companyId, publication.companyId),
                  eq(chatConversations.endpointId, publication.endpointId),
                  eq(chatConversations.id, publication.conversationId),
                  inArray(chatConversations.state, ["active", "waiting"]),
                ),
              )
              .for("no key update")
              .then((rows) => rows[0] ?? null)
          : null;
        const providerCanSendTextNotice =
          noticeEndpoint &&
          ["slack", "discord", "telegram"].includes(noticeEndpoint.provider) &&
          (attachmentFailure.provider === null ||
            noticeEndpoint.provider === attachmentFailure.provider);
        if (providerCanSendTextNotice && noticeConversation) {
          const taskUrl = safeChatTaskUrl(
            getTaskBaseUrl(),
            publication.issueId,
          );
          const noticeText =
            attachmentFailure.kind === "generated_response"
              ? "Paperclip could not send the response attachment. The complete response remains on its Paperclip task for an operator to retry."
              : "Paperclip could not send an attachment. The file remains on its Paperclip task for an operator to retry.";
          const idempotencyKey = `${ATTACHMENT_FAILURE_NOTICE_PREFIX}${publication.id}:${attachmentFailureRuntimeContext.generation}:${attachmentFailureRuntimeContext.credentialFingerprint}`;
          await notifyChatPublicationWork(tx);
          await tx
            .insert(chatPublications)
            .values({
              companyId: publication.companyId,
              endpointId: publication.endpointId,
              conversationId: publication.conversationId,
              issueId: publication.issueId,
              commentId: null,
              idempotencyKey,
              payload: projectSafeChatPublication({
                classification: "external",
                source: "safe_milestone",
                text: taskUrl
                  ? `${noticeText} Open task: ${taskUrl}`
                  : noticeText,
              }),
              state: "pending",
            })
            .onConflictDoNothing();
        }
      }

      await credentialLease?.assertOwned(tx);
      return true;
    });
    if (finalized && invalidateCurrentRuntime) {
      await credentialLease?.assertOwned();
      await invalidateRuntime(publication.endpointId).catch(() => undefined);
    }
    if (finalized) {
      logger.warn(
        {
          endpointId: publication.endpointId,
          publicationId: publication.id,
          error: failure,
          disposition: disposition.kind,
        },
        "chat publication failed",
      );
    }
    return finalized;
  }
  return { finalizePublicationFailure };
}
