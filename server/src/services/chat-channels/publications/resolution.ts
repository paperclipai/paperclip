import { notifyVoicePublication } from "../../voice/voice-reply-notifications.js";
import { providerEffectPayload } from "../provider-effects.js";
import { notifyChatDeliveryWork, notifyChatPublicationWork, notifyChatActionWork } from "../../chat-work-notifications.js";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatActions, chatConversations, chatDeliveries, chatEndpoints, chatPublications, chatTeamsFileTransfers, issueThreadInteractions } from "@paperclipai/db";
import { conflict, notFound } from "../../../errors.js";
import { logActivity } from "../../activity-log.js";
import type { EndpointRecord } from "../runtime-types.js";
import type { chatCredentialMutationLease } from "../../chat-credential-mutation-lease.js";
import type { createTeamsFileDelivery } from "../microsoft-teams/file-delivery.js";
import type { createChatPublicationTaskControl } from "./task-control.js";
import type { createChatPublicationQueue } from "./queue.js";
import type { createProviderEffects } from "../provider-effects.js";
import { resolveTeamsFilePublication } from "../microsoft-teams/file-resolution.js";
import { recordPhotonPublicationRetry } from "../imessage-photon/publication-retry.js";
import { resolveSlackFileReceipt } from "../slack/file-receipt-resolution.js";
type ResolutionOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  teamsTransferProtocol: ReturnType<typeof createTeamsFileDelivery>["teamsTransferProtocol"];
  commitTaskControlCompletion: ReturnType<typeof createChatPublicationTaskControl>["commitTaskControlCompletion"];
  processPendingPublications: ReturnType<typeof createChatPublicationQueue>["processPendingPublications"];
  processProviderEffect: ReturnType<typeof createProviderEffects>["processProviderEffect"];
};
export function createChatPublicationResolution(db: Db, options: ResolutionOptions) {
  const { endpointRecord, withCredentialMutationLease, teamsTransferProtocol, commitTaskControlCompletion, processPendingPublications, processProviderEffect } = options;
  async function replayPublication(endpointId: string, publicationId: string) {
    const publication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.endpointId, endpointId),
          eq(chatPublications.id, publicationId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!publication) throw notFound("Publication not found");
    if (publication.state !== "failed") {
      throw conflict("Only a failed publication can be replayed", {
        code:
          publication.state === "delivery_unknown"
            ? "chat_publication_resolution_required"
            : "chat_publication_not_replayable",
      });
    }
    const interactionId = publication.payload.interactionId;
    const isInteractionPrompt =
      Boolean(interactionId) &&
      publication.idempotencyKey ===
      `interaction:${interactionId}:${publication.endpointId}`;
    if (isInteractionPrompt) {
      if (!publication.issueId || !interactionId) {
        throw conflict(
          "This interaction prompt is missing its authoritative task binding and cannot be replayed safely",
          { code: "chat_terminal_interaction_publication_not_replayable" },
        );
      }
      const interaction = await db
        .select({ status: issueThreadInteractions.status })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.id, interactionId),
            eq(issueThreadInteractions.companyId, publication.companyId),
            eq(issueThreadInteractions.issueId, publication.issueId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!interaction || interaction.status !== "pending") {
        throw conflict(
          "A resolved interaction prompt cannot be replayed into the provider",
          { code: "chat_terminal_interaction_publication_not_replayable" },
        );
      }
    }
    const claimed = await db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, publication.companyId),
            eq(chatPublications.endpointId, endpointId),
            eq(chatPublications.id, publication.id),
          ),
        )
        .for("update")
        .then((rows) => rows[0]);
      if (
        !current ||
        current.state !== publication.state ||
        current.attempts !== publication.attempts
      )
        return [];
      // Lock the publication before checking the transfer lane: issue() takes
      // the same lock, so a concurrent consent/upload cannot slip into replay.
      const transfer = await tx
        .select({ id: chatTeamsFileTransfers.id })
        .from(chatTeamsFileTransfers)
        .where(
          and(
            eq(chatTeamsFileTransfers.companyId, current.companyId),
            eq(chatTeamsFileTransfers.publicationId, current.id),
          ),
        )
        .then((rows) => rows[0]);
      if (transfer)
        throw conflict(
          "File delivery requires a stage-specific operator resolution",
          {
            code: "chat_file_transfer_resolution_required",
          },
        );
      await notifyChatPublicationWork(tx, current);
      return tx
        .update(chatPublications)
        .set({
          state: "retry",
          nextAttemptAt: new Date(),
          redactedError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatPublications.id, publication.id),
            eq(chatPublications.state, publication.state),
            eq(chatPublications.attempts, publication.attempts),
          ),
        )
        .returning({ id: chatPublications.id });
    });
    if (!claimed.length) {
      throw conflict("This publication is already being replayed", {
        code: "chat_publication_replay_conflict",
      });
    }
    await processPendingPublications(1);
  }

  async function resolvePublication(
    endpointId: string,
    publicationId: string,
    action: "mark_delivered" | "retry_anyway" | "cancel",
    userId: string,
    fileTransfer?: {
      phase: import("@paperclipai/shared").ChatFileTransferPhase;
      version: number;
    },
  ) {
    const initialRecord = await endpointRecord(endpointId);
    if (!initialRecord) throw notFound("Chat endpoint not found");
    await withCredentialMutationLease(
      initialRecord.endpoint,
      (credentialLease) =>
        db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          const publication = await tx
            .select()
            .from(chatPublications)
            .where(
              and(
                eq(chatPublications.endpointId, endpointId),
                eq(chatPublications.id, publicationId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!publication) throw notFound("Publication not found");
          if (await resolveTeamsFilePublication(tx, { endpointId, publication, action, userId, credentialLease, fileTransfer }, teamsTransferProtocol)) return;
          if (publication.state !== "delivery_unknown") {
            throw conflict(
              "Only an unconfirmed publication needs an operator resolution",
              {
                code: "chat_publication_resolution_not_required",
              },
            );
          }

          const interactionId = publication.payload.interactionId;
          const isInteractionPrompt =
            Boolean(interactionId) &&
            publication.idempotencyKey ===
            `interaction:${interactionId}:${publication.endpointId}`;
          if (action === "retry_anyway" && isInteractionPrompt) {
            if (!publication.issueId || !interactionId) {
              throw conflict(
                "This interaction prompt is missing its authoritative task binding and cannot be retried safely",
                {
                  code: "chat_terminal_interaction_publication_not_replayable",
                },
              );
            }
            const interaction = await tx
              .select({ status: issueThreadInteractions.status })
              .from(issueThreadInteractions)
              .where(
                and(
                  eq(issueThreadInteractions.id, interactionId),
                  eq(issueThreadInteractions.companyId, publication.companyId),
                  eq(issueThreadInteractions.issueId, publication.issueId),
                ),
              )
              .then((rows) => rows[0] ?? null);
            if (!interaction || interaction.status !== "pending") {
              throw conflict(
                "A resolved interaction prompt cannot be retried with stale provider actions; mark it delivered or cancel it instead",
                {
                  code: "chat_terminal_interaction_publication_not_replayable",
                },
              );
            }
          }

          if (
            initialRecord.endpoint.provider === "imessage-photon" &&
            action === "retry_anyway"
          ) { await recordPhotonPublicationRetry(tx, endpointId, publication, userId); }
          const now = new Date();
          await notifyChatPublicationWork(tx, publication);
          await notifyVoicePublication(tx, initialRecord.endpoint, publication.conversationId);
          await tx
            .update(chatPublications)
            .set(
              action === "mark_delivered"
                ? {
                  state: "published",
                  publishedAt: now,
                  nextAttemptAt: null,
                  redactedError: null,
                  updatedAt: now,
                }
                : action === "retry_anyway"
                  ? {
                    state: "retry",
                    nextAttemptAt: now,
                    redactedError: null,
                    updatedAt: now,
                  }
                  : {
                    state: "cancelled",
                    nextAttemptAt: null,
                    redactedError:
                      "Cancelled by an operator after an unconfirmed provider delivery",
                    updatedAt: now,
                  },
            )
            .where(
              and(
                eq(chatPublications.id, publication.id),
                eq(chatPublications.state, "delivery_unknown"),
              ),
            );
          await resolveSlackFileReceipt(tx, publication, action, now);
          if (publication.idempotencyKey.startsWith("control:")) {
            await tx
              .update(chatActions)
              .set({
                status:
                  action === "mark_delivered"
                    ? "processed"
                    : action === "retry_anyway"
                      ? "issued"
                      : "cancelled",
                result: {
                  code:
                    action === "mark_delivered"
                      ? "task_control_marked_delivered_by_operator"
                      : action === "retry_anyway"
                        ? "task_control_retry_requested"
                        : "task_control_cancelled_by_operator",
                },
                updatedAt: now,
              })
              .where(
                and(
                  eq(chatActions.endpointId, publication.endpointId),
                  eq(
                    chatActions.providerActionId,
                    `task-control-authorization:${publication.id}`,
                  ),
                  inArray(chatActions.status, [
                    "issued",
                    "processing",
                    "delivery_unknown",
                  ]),
                ),
              );
          }
          if (action === "mark_delivered") {
            await tx
              .update(chatEndpoints)
              .set({ lastPublicationAt: now, updatedAt: now })
              .where(eq(chatEndpoints.id, endpointId));
            await commitTaskControlCompletion(
              tx as unknown as Db,
              publication,
              now,
            );
          }
          await logActivity(tx as unknown as Db, {
            companyId: publication.companyId,
            actorType: "user",
            actorId: userId,
            action: `chat.publication_${action}`,
            entityType: "chat_publication",
            entityId: publication.id,
            issueId: publication.issueId,
            details: {
              endpointId,
              conversationId: publication.conversationId,
              previousState: "delivery_unknown",
              nextState:
                action === "mark_delivered"
                  ? "published"
                  : action === "retry_anyway"
                    ? "retry"
                    : "cancelled",
              duplicateRiskAccepted: action === "retry_anyway",
            },
          });
          await credentialLease.assertOwned(tx);
        }),
    );
    await processPendingPublications();
  }

  async function resolveProviderEffect(
    endpointId: string,
    actionId: string,
    resolution: "mark_delivered" | "retry_anyway" | "cancel",
    userId: string,
  ) {
    const initialRecord = await endpointRecord(endpointId);
    if (!initialRecord) throw notFound("Chat endpoint not found");

    if (resolution === "retry_anyway") {
      await withCredentialMutationLease(
        initialRecord.endpoint,
        async (credentialLease) => {
          const currentRecord = await endpointRecord(endpointId);
          if (
            !currentRecord ||
            !["verifying", "active"].includes(currentRecord.endpoint.status)
          ) {
            throw conflict(
              "The chat connection must be active before retrying this provider reply",
              {
                code: "chat_action_endpoint_unavailable",
              },
            );
          }
          await db.transaction(async (tx) => {
            await credentialLease.assertOwned(tx);
            const action = await tx
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, endpointId),
                  eq(chatActions.id, actionId),
                  eq(chatActions.kind, "provider_effect"),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null);
            if (!action) throw notFound("Provider action not found");
            if (action.status !== "delivery_unknown") {
              throw conflict(
                "Only an unconfirmed provider action needs operator resolution",
                {
                  code: "chat_action_resolution_not_required",
                },
              );
            }
            const payload = providerEffectPayload(action.payload);
            if (!payload) {
              throw conflict("This provider action cannot be retried safely", {
                code: "chat_action_retry_context_missing",
              });
            }
            const delivery =
              payload.settleDelivery && action.deliveryId
                ? await tx
                  .select({ state: chatDeliveries.state })
                  .from(chatDeliveries)
                  .where(
                    and(
                      eq(chatDeliveries.endpointId, endpointId),
                      eq(chatDeliveries.id, action.deliveryId),
                    ),
                  )
                  .for("update")
                  .then((rows) => rows[0] ?? null)
                : null;
            if (payload.settleDelivery && action.deliveryId) {
              if (!delivery || delivery.state !== "failed") {
                throw conflict(
                  "The provider action's delivery is no longer awaiting resolution",
                  {
                    code: "chat_action_delivery_resolution_conflict",
                  },
                );
              }
              await notifyChatDeliveryWork(tx);
              await tx
                .update(chatDeliveries)
                .set({
                  state: "processing",
                  nextAttemptAt: null,
                  redactedError: null,
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatDeliveries.id, action.deliveryId),
                    eq(chatDeliveries.state, "failed"),
                  ),
                );
            }
            const now = new Date();
            await notifyChatActionWork(tx, "provider_effect");
            const [claimed] = await tx
              .update(chatActions)
              .set({
                status: "received",
                result: {
                  ...(action.result ?? {}),
                  code: "provider_effect_retry_requested",
                  retryable: false,
                  retryAt: null,
                },
                updatedAt: now,
              })
              .where(
                and(
                  eq(chatActions.id, action.id),
                  eq(chatActions.status, "delivery_unknown"),
                ),
              )
              .returning({ id: chatActions.id });
            if (!claimed) {
              throw conflict("This provider action is already being resolved", {
                code: "chat_action_resolution_conflict",
              });
            }
            await logActivity(tx as unknown as Db, {
              companyId: action.companyId,
              actorType: "user",
              actorId: userId,
              action: "chat.provider_effect_retry_anyway",
              entityType: "chat_action",
              entityId: action.id,
              details: {
                endpointId,
                conversationId: action.conversationId,
                deliveryId: action.deliveryId,
                previousState: "delivery_unknown",
                nextState: "received",
                duplicateRiskAccepted: true,
              },
            });
          });
        },
      );
      // The audited retry request is durable before the new transport claim.
      // Do not keep the endpoint mutation lease across provider I/O.
      await processProviderEffect(actionId);
      return;
    }

    await withCredentialMutationLease(
      initialRecord.endpoint,
      (credentialLease) =>
        db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          const action = await tx
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpointId),
                eq(chatActions.id, actionId),
                eq(chatActions.kind, "provider_effect"),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!action) throw notFound("Provider action not found");
          if (action.status !== "delivery_unknown") {
            throw conflict(
              "Only an unconfirmed provider action needs operator resolution",
              {
                code: "chat_action_resolution_not_required",
              },
            );
          }
          const payload = providerEffectPayload(action.payload);
          if (!payload) {
            throw conflict("This provider action cannot be resolved safely", {
              code: "chat_action_resolution_context_missing",
            });
          }
          const delivery =
            payload.settleDelivery && action.deliveryId
              ? await tx
                .select({ state: chatDeliveries.state })
                .from(chatDeliveries)
                .where(
                  and(
                    eq(chatDeliveries.endpointId, endpointId),
                    eq(chatDeliveries.id, action.deliveryId),
                  ),
                )
                .for("update")
                .then((rows) => rows[0] ?? null)
              : null;
          if (
            payload.settleDelivery &&
            action.deliveryId &&
            (!delivery || delivery.state !== "failed")
          ) {
            throw conflict(
              "The provider action's delivery is no longer awaiting resolution",
              {
                code: "chat_action_delivery_resolution_conflict",
              },
            );
          }

          const now = new Date();
          const nextStatus =
            resolution === "mark_delivered" ? "processed" : "cancelled";
          await notifyChatActionWork(tx, "provider_effect");
          const [resolved] = await tx
            .update(chatActions)
            .set({
              status: nextStatus,
              result: {
                ...(action.result ?? {}),
                code:
                  resolution === "mark_delivered"
                    ? "provider_effect_marked_delivered_by_operator"
                    : "provider_effect_cancelled_by_operator",
                retryable: false,
                retryAt: null,
              },
              updatedAt: now,
            })
            .where(
              and(
                eq(chatActions.id, action.id),
                eq(chatActions.status, "delivery_unknown"),
              ),
            )
            .returning({ id: chatActions.id });
          if (!resolved) {
            throw conflict("This provider action is already being resolved", {
              code: "chat_action_resolution_conflict",
            });
          }
          if (payload.settleDelivery && action.deliveryId) {
            await notifyChatDeliveryWork(tx);
            await tx
              .update(chatDeliveries)
              .set(
                resolution === "mark_delivered"
                  ? {
                    state: "processed",
                    processedAt: now,
                    nextAttemptAt: null,
                    redactedError: null,
                    updatedAt: now,
                  }
                  : {
                    state: "filtered",
                    processedAt: now,
                    nextAttemptAt: null,
                    redactedError:
                      "Cancelled by an operator after an unconfirmed provider reply",
                    updatedAt: now,
                  },
              )
              .where(
                and(
                  eq(chatDeliveries.id, action.deliveryId),
                  eq(chatDeliveries.state, "failed"),
                ),
              );
          }
          if (resolution === "mark_delivered") {
            if (payload.completeConversationId) {
              await tx
                .update(chatConversations)
                .set({ state: "completed", updatedAt: now })
                .where(
                  and(
                    eq(chatConversations.id, payload.completeConversationId),
                    eq(chatConversations.endpointId, endpointId),
                  ),
                );
            }
            await tx
              .update(chatEndpoints)
              .set({ lastEventAt: now, updatedAt: now })
              .where(eq(chatEndpoints.id, endpointId));
          }
          await logActivity(tx as unknown as Db, {
            companyId: action.companyId,
            actorType: "user",
            actorId: userId,
            action: `chat.provider_effect_${resolution}`,
            entityType: "chat_action",
            entityId: action.id,
            details: {
              endpointId,
              conversationId: action.conversationId,
              deliveryId: action.deliveryId,
              completeConversationId: payload.completeConversationId ?? null,
              previousState: "delivery_unknown",
              nextState: nextStatus,
              duplicateRiskAccepted: false,
            },
          });
          await credentialLease.assertOwned(tx);
        }),
    );
  }
  return { replayPublication, resolvePublication, resolveProviderEffect };
}
