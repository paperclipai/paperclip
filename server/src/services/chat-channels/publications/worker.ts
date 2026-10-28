import { notifyVoicePublication } from "../../voice/voice-reply-notifications.js";
import { createGitHubPublicationPolicy } from "../github/publication-policy.js";

import { createTeamsFileDelivery } from "../microsoft-teams/file-delivery.js";

import { createReceiptReactions } from "../receipt-reactions.js";

import { createTelegramPublicationDrafts } from "../telegram/publication-drafts.js";
import { createSlackFileReceipts } from "../slack/file-receipts.js";

import { createTelegramMaintenance } from "../telegram/maintenance.js";
import type { EndpointRow, DbOrTransaction, RuntimeContext } from "../runtime-types.js";

import { createChatPublicationReplacement } from "../publication-replacement.js";

import { notifyChatPublicationWork } from "../../chat-work-notifications.js";

import {
  stageReceiptReactionRemovals,
} from "../../chat-receipt-reactions.js";

import { chatCredentialMutationLease, CREDENTIAL_MUTATION_LEASE_TTL_MS, type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import { slackExplicitPublicationDuplicate } from "../../connectors/slack-publication.js";

import { PhotonError } from "../../photon/cloud.js";

import {
  randomUUID,
} from "node:crypto";
import {
  and,
  eq,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatEndpointLeases,
  chatEndpointResources,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  chatTeamsFileTransfers,
  issueThreadInteractions,
} from "@paperclipai/db";
import type {
  ChatAdapterCapabilities,
  ChatProvider,
  SafeChatPublicationPayload,
} from "@paperclipai/shared";

import {
  isTelegramDraftStopped,
} from "../../chat-telegram-draft-stop.js";

import { logger } from "../../../middleware/logger.js";

import {
  renderPublicationTransportText,
} from "../../chat-publication-text-parts.js";

import {
  stageSlackSessionSync,
} from "../../chat-slack-session-outbox.js";

import { classifyChatPublicationError } from "../../chat-publication-errors.js";
import {
  parseInboundWakePublicationKey,
} from "../../chat-inbound-wakeup-publications.js";

import {
  shouldStreamSafePublicationText,
} from "../../chat-publication-stream.js";

import { publicationTransportOrderKey } from "./order.js";
import { isExplicitOperatorPublication } from "./policy.js";
import type { EndpointRecord } from "../runtime-types.js";
import type { createChatPublicationAuthorization } from "./authorization.js";
import type { createChatPublicationTaskControl } from "./task-control.js";
import type { createChatPublicationFailures } from "./failures.js";
import type { createChatPublicationPreparation } from "./preparation.js";
import type { createChatPublicationTransport } from "./transport.js";
type PublicationWorkerOptions = Pick<ReturnType<typeof createChatPublicationReplacement>, "runOwnershipMilestoneSupersessionReason" | "runPublicationToReplace" | "receiptReactionCompletionRunId" | "inboundWakePublicationToReplace" | "interactionResolutionPublicationToReplace" | "interactionPromptPublicationToReplace" | "progressSupersededByFastResponse" | "runProgressSupersededByPublishedInteraction" | "taskStatusPublicationToReplace" | "closeProgressToReplace"> & {
  CAPABILITIES: Record<ChatProvider, ChatAdapterCapabilities>;
  authorizeRetainedChatSourcePublication: (tx: DbOrTransaction, publication: typeof chatPublications.$inferSelect) => Promise<boolean>;
  claimPublicationTransportAuthorization: ReturnType<typeof createChatPublicationAuthorization>["claimPublicationTransportAuthorization"];
  commitTaskControlCompletion: ReturnType<typeof createChatPublicationTaskControl>["commitTaskControlCompletion"];
  currentTaskControlPayload: ReturnType<typeof createChatPublicationTaskControl>["currentTaskControlPayload"];
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  ensureDurablePublicationTransport: ReturnType<typeof createChatPublicationPreparation>["ensureDurablePublicationTransport"];
  finalizePublicationFailure: ReturnType<typeof createChatPublicationFailures>["finalizePublicationFailure"];
  hasCommittedTaskControlCompletion: ReturnType<typeof createChatPublicationTaskControl>["hasCommittedTaskControlCompletion"];
  hasTelegramStopSubscription: ReturnType<typeof createTelegramMaintenance>["hasTelegramStopSubscription"];
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: typeof chatEndpointResources.$inferSelect | null | undefined) => boolean;
  postSafePublication: ReturnType<typeof createChatPublicationTransport>["postSafePublication"];
  processReceiptReaction: ReturnType<typeof createReceiptReactions>["processReceiptReaction"];
  recordSlackFileUploadReceipt: ReturnType<typeof createSlackFileReceipts>["recordSlackFileUploadReceipt"];
  redactError: (error: unknown) => string;
  reserveTelegramPublicationDraft: ReturnType<typeof createTelegramPublicationDrafts>["reserveTelegramPublicationDraft"];
  runtimeContextForRecord: (record: EndpointRecord) => RuntimeContext;
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  settleGitHubAutomaticPublication: ReturnType<typeof createGitHubPublicationPolicy>["settleGitHubAutomaticPublication"];
  stageSlackFilePublicationSuccess: ReturnType<typeof createSlackFileReceipts>["stageSlackFilePublicationSuccess"];
  tryProcessTeamsFilePublication: ReturnType<typeof createTeamsFileDelivery>["tryProcessTeamsFilePublication"];
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
};
export function createChatPublicationWorker(db: Db, options: PublicationWorkerOptions) {
  const { CAPABILITIES, authorizeRetainedChatSourcePublication, claimPublicationTransportAuthorization, closeProgressToReplace, commitTaskControlCompletion, currentTaskControlPayload, endpointRecord, ensureDurablePublicationTransport, finalizePublicationFailure, hasCommittedTaskControlCompletion, hasTelegramStopSubscription, inboundWakePublicationToReplace, interactionPromptPublicationToReplace, interactionResolutionPublicationToReplace, nonDirectDestinationAllowed, postSafePublication, processReceiptReaction, progressSupersededByFastResponse, recordSlackFileUploadReceipt, redactError, reserveTelegramPublicationDraft, runOwnershipMilestoneSupersessionReason, runProgressSupersededByPublishedInteraction, runPublicationToReplace, runtimeContextForRecord, scheduleMessageProcessing, settleGitHubAutomaticPublication, stageSlackFilePublicationSuccess, taskStatusPublicationToReplace, tryProcessTeamsFilePublication, withCredentialMutationLease, receiptReactionCompletionRunId } = options;


  async function stageTerminalReceiptReactionRemovals(
    tx: Db,
    input: {
      endpoint: EndpointRow;
      publication: typeof chatPublications.$inferSelect;
      payload: SafeChatPublicationPayload;
      runtimeContext: RuntimeContext;
      closedProgressRunId?: string;
    },
  ): Promise<string[]> {
    if (
      !["discord", "slack", "telegram", "github"].includes(input.endpoint.provider)
    ) return [];
    const runId = input.closedProgressRunId ??
      (await receiptReactionCompletionRunId(tx, input.publication, input.payload));
    if (!runId) return [];
    return stageReceiptReactionRemovals(tx, {
      endpoint: input.endpoint,
      binding: input.publication,
      runId,
      runtimeContext: input.runtimeContext,
    });
  }

  async function settlePublicationPreparationFailure(
    publication: typeof chatPublications.$inferSelect,
    error: unknown,
  ): Promise<boolean> {
    const attempts = publication.attempts + 1;
    const classified = classifyChatPublicationError(error, attempts);
    // No provider I/O has started at this boundary. Unknown transport or
    // database failures are therefore safe to retry; only a definite local
    // validation rejection (or repeated exhaustion) is terminal.
    const terminal = classified.kind === "failed" || attempts >= 5;
    const retryAfterMs =
      classified.kind === "retry"
        ? classified.retryAfterMs
        : Math.min(60_000, 2 ** Math.max(0, attempts) * 1_000);
    const result = await db.transaction(async (tx) => {
      await notifyChatPublicationWork(tx);
      const [settled] = await tx
        .update(chatPublications)
        .set({
          state: terminal ? "failed" : "retry",
          attempts,
          nextAttemptAt: terminal ? null : new Date(Date.now() + retryAfterMs),
          redactedError: terminal
            ? "Publication payload could not be prepared for provider delivery"
            : "Publication preparation failed before provider delivery",
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
      if (!settled) return false;
      if (terminal && publication.idempotencyKey.startsWith("control:")) {
        await tx
          .update(chatActions)
          .set({
            status: "cancelled",
            result: {
              code: "task_control_publication_invalid",
              attempts,
              retryable: false,
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
              eq(chatActions.status, "issued"),
            ),
          );
      }
      return true;
    });
    if (result) {
      logger.warn(
        {
          endpointId: publication.endpointId,
          publicationId: publication.id,
          error: redactError(error),
          terminal,
        },
        "chat publication preparation failed",
      );
    }
    return result;
  }

  async function withPublicationAttemptLease(
    publication: typeof chatPublications.$inferSelect,
    operation: (lease: CredentialMutationLeaseGuard) => Promise<void>,
  ): Promise<void> {
    // A scheduled sweep may overlap a slow provider call (also on a standby
    // server). Claim and exact-attempt ownership must become visible together:
    // endpoint-wide activity is not evidence that this publication is alive.
    const token = randomUUID();
    const leaseKey = `publication:${publication.id}:${publication.attempts + 1}`;
    const now = new Date();
    const owned = and(
      eq(chatEndpointLeases.companyId, publication.companyId),
      eq(chatEndpointLeases.endpointId, publication.endpointId),
      eq(chatEndpointLeases.leaseKey, leaseKey),
      eq(chatEndpointLeases.token, token),
    );
    const claimed = await db.transaction(async (tx) => {
      // Transfer issuance locks this same publication. Check after acquiring
      // that lock, not through a pre-lock snapshot that could miss a new lane.
      const current = await tx
        .select({ id: chatPublications.id })
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, publication.companyId),
            eq(chatPublications.id, publication.id),
            eq(chatPublications.state, publication.state),
            eq(chatPublications.attempts, publication.attempts),
          ),
        )
        .for("update")
        .then((rows) => rows[0]);
      if (!current) return false;
      const transfer = await tx
        .select({ id: chatTeamsFileTransfers.id })
        .from(chatTeamsFileTransfers)
        .where(
          and(
            eq(chatTeamsFileTransfers.companyId, publication.companyId),
            eq(chatTeamsFileTransfers.publicationId, current.id),
          ),
        )
        .then((rows) => rows[0]);
      if (transfer) return false;
      await notifyChatPublicationWork(tx);
      const [row] = await tx
        .update(chatPublications)
        .set({
          state: "streaming",
          attempts: publication.attempts + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(chatPublications.id, publication.id),
            eq(chatPublications.state, publication.state),
            eq(chatPublications.attempts, publication.attempts),
          ),
        )
        .returning({ id: chatPublications.id });
      if (!row) return false;
      await tx.insert(chatEndpointLeases).values({
        companyId: publication.companyId,
        endpointId: publication.endpointId,
        leaseKey,
        token,
        expiresAt: new Date(now.getTime() + CREDENTIAL_MUTATION_LEASE_TTL_MS),
      });
      return true;
    });
    if (!claimed) return;
    let leaseLoss: Error | null = null;
    const assertOwned: CredentialMutationLeaseGuard["assertOwned"] = async (
      database = db,
    ) => {
      if (leaseLoss) throw leaseLoss;
      try {
        // Use a savepoint when the caller already owns a transaction. The
        // decision clock is sampled only after the lease row lock resolves;
        // an UPDATE predicate using a pre-lock clock can revive expired work.
        await database.transaction(async (tx) => {
          const current = await tx
            .select({ expiresAt: chatEndpointLeases.expiresAt })
            .from(chatEndpointLeases)
            .where(owned)
            .for("update")
            .then((rows) => rows[0] ?? null);
          const checkedAt = new Date();
          if (
            leaseLoss ||
            !current ||
            current.expiresAt.getTime() <= checkedAt.getTime()
          ) {
            throw new Error("Publication attempt lease is no longer owned");
          }
          await tx
            .update(chatEndpointLeases)
            .set({
              expiresAt: new Date(
                checkedAt.getTime() + CREDENTIAL_MUTATION_LEASE_TTL_MS,
              ),
              updatedAt: checkedAt,
            })
            .where(owned);
        });
      } catch (error) {
        leaseLoss = Object.assign(
          new Error(
            "Chat publication attempt ownership was lost before completion",
            { cause: error },
          ),
          { code: "CHAT_PUBLICATION_LEASE_LOST" },
        );
        throw leaseLoss;
      }
    };
    let renewal: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (renewal || leaseLoss) return;
      renewal = assertOwned()
        .catch(() => undefined)
        .finally(() => {
          renewal = null;
        });
    }, CREDENTIAL_MUTATION_LEASE_TTL_MS / 3);
    timer.unref?.();
    try {
      await operation({ assertOwned });
    } finally {
      clearInterval(timer);
      await renewal;
      await db.delete(chatEndpointLeases).where(owned);
    }
  }

  async function processSelectedPublication(
    selectedPublication: typeof chatPublications.$inferSelect,
  ): Promise<void> {
    if (await settleGitHubAutomaticPublication(selectedPublication)) return;
    let publication: typeof chatPublications.$inferSelect;
    try {
      publication =
        await ensureDurablePublicationTransport(selectedPublication);
    } catch (error) {
      try {
        await settlePublicationPreparationFailure(selectedPublication, error);
      } catch (settlementError) {
        logger.error(
          {
            endpointId: selectedPublication.endpointId,
            publicationId: selectedPublication.id,
            error: redactError(settlementError),
          },
          "could not durably settle chat publication preparation failure",
        );
      }
      return;
    }
    const explicitSlackDelivery = await slackExplicitPublicationDuplicate(db, publication);
    if (explicitSlackDelivery === "unresolved") {
      // Keep the durable publication pending until the explicit send is settled;
      // a missing provider receipt does not authorize a duplicate.
      return;
    }
    if (explicitSlackDelivery === "delivered") {
      await db.transaction(async (tx) => {
        await notifyChatPublicationWork(tx);
        return tx.update(chatPublications).set({ state: "cancelled", redactedError: "Identical response already delivered by Slack tool", updatedAt: new Date() }).where(and(eq(chatPublications.id, publication.id), inArray(chatPublications.state, ["pending", "retry"])))
;
      });
      return;
    }
    const earlierOpenPublication = await db
      .select({ id: chatPublications.id })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.conversationId, publication.conversationId),
          or(
            lt(chatPublications.createdAt, publication.createdAt),
            and(
              eq(chatPublications.createdAt, publication.createdAt),
              lt(
                publicationTransportOrderKey(chatPublications),
                publication.payload.transportPart?.orderKey ?? publication.id,
              ),
            ),
          ),
          inArray(chatPublications.state, [
            "pending",
            "retry",
            "streaming",
            "delivery_unknown",
          ]),
        ),
      )
      .limit(1)
      .then((result) => result[0] ?? null);
    if (earlierOpenPublication) return;
    if (await tryProcessTeamsFilePublication(publication)) return;
    await withPublicationAttemptLease(publication, async (publicationLease) => {
      let providerAccepted = false;
      let publicationRuntimeContext: RuntimeContext | null = null;
      let failureHandledWithinCredentialLease = false;
      let slackFileReceiptActionId: string | null = null;
      const settlePublicationFailure = async (
        error: unknown,
        credentialLease?: CredentialMutationLeaseGuard,
      ) => {
        try {
          await finalizePublicationFailure(
            publication,
            error,
            providerAccepted,
            publicationRuntimeContext,
            credentialLease ?? publicationLease,
          );
        } catch (finalizationError) {
          // If the provider accepted the message, a failed receipt write
          // must remain streaming until the stale scan quarantines it. A
          // later lifecycle mutation must not turn this into an implicit
          // replay or allow a stale failure to overwrite the new runtime.
          logger.error(
            {
              endpointId: publication.endpointId,
              publicationId: publication.id,
              error: redactError(finalizationError),
            },
            "could not durably finalize chat publication failure",
          );
        }
      };
      try {
        const recordForLease = await endpointRecord(publication.endpointId);
        if (!recordForLease)
          throw new Error("Chat publication binding is unavailable");
        const currentPublicationRuntimeContext =
          runtimeContextForRecord(recordForLease);
        publicationRuntimeContext = currentPublicationRuntimeContext;
        const [endpoint, conversation] = await Promise.all([
          db
            .select()
            .from(chatEndpoints)
            .where(eq(chatEndpoints.id, publication.endpointId))
            .then((result) => result[0] ?? null),
          db
            .select()
            .from(chatConversations)
            .where(eq(chatConversations.id, publication.conversationId))
            .then((result) => result[0] ?? null),
        ]);
        if (!endpoint || !conversation)
          throw new Error("Chat publication binding is unavailable");
        const providerVisibleCompletion =
          conversation.state === "completed" &&
          !isExplicitOperatorPublication(publication) &&
          (await hasCommittedTaskControlCompletion(conversation.id));
        if (endpoint.status === "paused" || endpoint.status === "attention") {
          await publicationLease.assertOwned();
          await db.transaction(async (tx) => {
            await notifyChatPublicationWork(tx);
            return tx
              .update(chatPublications)
              .set({
                state: "pending",
                attempts: publication.attempts,
                // Pause can race the eligibility read. The query excludes
                // inactive endpoints on the next pass, so retain only the
                // original provider deadline rather than delaying Resume.
                nextAttemptAt: publication.nextAttemptAt,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatPublications.id, publication.id),
                  eq(chatPublications.state, "streaming"),
                  eq(chatPublications.attempts, publication.attempts + 1),
                ),
              );
          });
          return;
        }
        // The setup conversation is a real end-to-end test: once provider
        // credentials are verified, its safe agent response must be able to
        // reach the provider before the operator confirms the final wizard
        // step. Draft, paused, revoked, and archived endpoints remain closed.
        if (
          !["active", "verifying"].includes(endpoint.status) ||
          ["unavailable", "endpoint_removed"].includes(conversation.state) ||
          providerVisibleCompletion
        ) {
          await publicationLease.assertOwned();
          await db.transaction(async (tx) => {
            await notifyChatPublicationWork(tx);
            return tx
              .update(chatPublications)
              .set({
                state: "cancelled",
                redactedError: providerVisibleCompletion
                  ? "Conversation was completed before delivery"
                  : "External destination is no longer active",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatPublications.id, publication.id),
                  eq(chatPublications.state, "streaming"),
                  eq(chatPublications.attempts, publication.attempts + 1),
                ),
              );
          });
          return;
        }
        if (conversation.isDirectMessage) {
          if (!endpoint.allowDirectMessages) {
            await publicationLease.assertOwned();
            await db.transaction(async (tx) => {
              await notifyChatPublicationWork(tx);
              return tx
                .update(chatPublications)
                .set({
                  state: "cancelled",
                  redactedError: "Direct messages are disabled in Paperclip",
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatPublications.id, publication.id),
                    eq(chatPublications.state, "streaming"),
                    eq(chatPublications.attempts, publication.attempts + 1),
                  ),
                );
            });
            return;
          }
        } else {
          const resource = conversation.resourceId
            ? await db
                .select()
                .from(chatEndpointResources)
                .where(
                  and(
                    eq(chatEndpointResources.id, conversation.resourceId),
                    eq(chatEndpointResources.endpointId, endpoint.id),
                    eq(chatEndpointResources.companyId, endpoint.companyId),
                  ),
                )
                .then((result) => result[0] ?? null)
            : null;
          if (!nonDirectDestinationAllowed(endpoint, resource)) {
            await publicationLease.assertOwned();
            await db.transaction(async (tx) => {
              await notifyChatPublicationWork(tx);
              return tx
                .update(chatPublications)
                .set({
                  state: "cancelled",
                  redactedError: "Destination is disabled in Paperclip",
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatPublications.id, publication.id),
                    eq(chatPublications.state, "streaming"),
                    eq(chatPublications.attempts, publication.attempts + 1),
                  ),
                );
            });
            return;
          }
        }
        const interactionId = publication.payload.interactionId;
        const isInteractionPrompt =
          Boolean(interactionId) &&
          publication.idempotencyKey ===
            `interaction:${interactionId}:${publication.endpointId}`;
        if (isInteractionPrompt && publication.issueId) {
          const currentInteraction = await db
            .select({ status: issueThreadInteractions.status })
            .from(issueThreadInteractions)
            .where(
              and(
                eq(issueThreadInteractions.id, interactionId!),
                eq(issueThreadInteractions.companyId, publication.companyId),
                eq(issueThreadInteractions.issueId, publication.issueId),
              ),
            )
            .then((result) => result[0] ?? null);
          if (!currentInteraction || currentInteraction.status !== "pending") {
            await publicationLease.assertOwned();
            await db.transaction(async (tx) => {
              await notifyChatPublicationWork(tx);
              return tx
                .update(chatPublications)
                .set({
                  state: "cancelled",
                  attempts: publication.attempts,
                  nextAttemptAt: null,
                  redactedError: "Interaction resolved before provider delivery",
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatPublications.id, publication.id),
                    eq(chatPublications.state, "streaming"),
                    eq(chatPublications.attempts, publication.attempts + 1),
                  ),
                );
            });
            return;
          }
        }
        // Milestone selection and insertion can overlap across sweeps. An old
        // snapshot inserted after newer attention must not overwrite it simply
        // because it now occupies the next FIFO slot.
        const progressSupersessionReason =
          (await runOwnershipMilestoneSupersessionReason(publication)) ??
          ((await progressSupersededByFastResponse(publication)) ? "Acknowledged by contextual fast response" : null) ??
          ((await runProgressSupersededByPublishedInteraction(publication))
            ? "Run progress was superseded by its provider interaction"
            : null);
        if (progressSupersessionReason) {
          await publicationLease.assertOwned();
          await db.transaction(async (tx) => {
            await notifyChatPublicationWork(tx);
            return tx
              .update(chatPublications)
              .set({
                state: "cancelled",
                attempts: publication.attempts,
                nextAttemptAt: null,
                redactedError: progressSupersessionReason,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatPublications.id, publication.id),
                  eq(chatPublications.state, "streaming"),
                  eq(chatPublications.attempts, publication.attempts + 1),
                ),
              );
          });
          return;
        }
        // Status is sampled when it reaches the head of the provider lane,
        // not when the command was admitted. If an already-streaming final
        // publication won the race, this reply reflects Paperclip's latest
        // authoritative task state after that earlier send commits.
        let payload = await currentTaskControlPayload(publication);
        await withCredentialMutationLease(
          recordForLease.endpoint,
          async (credentialGuard) => {
            const credentialLease: CredentialMutationLeaseGuard = {
              assertOwned: async (database = db) => {
                await credentialGuard.assertOwned(database);
                await publicationLease.assertOwned(database);
              },
            };
            try {
              if (await settleGitHubAutomaticPublication(publication, credentialLease)) return;
              // A prior failure's provider ID may have been reused while this
              // worker waited for the endpoint lane. Select against current
              // outbound links only after owning that lane, before the final
              // source authorization claim and provider I/O.
              const closedProgress = await closeProgressToReplace(
                publication,
                endpoint,
              );
              const replaceProviderMessageId = endpoint.provider !== "imessage-photon" && CAPABILITIES[endpoint.provider]
                .messageEdits
                ? (closedProgress?.providerMessageId ??
                  (await interactionResolutionPublicationToReplace(
                    publication,
                    payload,
                  )) ??
                  (await interactionPromptPublicationToReplace(
                    publication,
                    payload,
                  )) ??
                  (await runPublicationToReplace(publication, payload)) ??
                  (await inboundWakePublicationToReplace(
                    publication,
                    payload,
                  )) ??
                  (await taskStatusPublicationToReplace(publication, payload)))
                : null;
              const authorizationClaim =
                await claimPublicationTransportAuthorization({
                  credentialLease,
                  endpoint: recordForLease.endpoint,
                  publication,
                  runtimeContext: currentPublicationRuntimeContext,
                });
              if (!authorizationClaim) {
                await db.transaction(async (tx) => {
                  await credentialLease.assertOwned(tx);
                  await notifyChatPublicationWork(tx);
                  await tx
                    .update(chatPublications)
                    .set({
                      state: "cancelled",
                      nextAttemptAt: null,
                      redactedError:
                        "Task control requester or destination is no longer authorized",
                      updatedAt: new Date(),
                    })
                    .where(
                      and(
                        eq(chatPublications.id, publication.id),
                        eq(chatPublications.state, "streaming"),
                        eq(chatPublications.attempts, publication.attempts + 1),
                      ),
                    );
                  await tx
                    .update(chatActions)
                    .set({
                      status: "cancelled",
                      result: {
                        code: "task_control_authorization_changed",
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
                        eq(chatActions.status, "issued"),
                      ),
                    );
                  await credentialLease.assertOwned(tx);
                });
                return;
              }
              // The durable claim above is the authorization linearization
              // point. Provider I/O runs without a database transaction or
              // row lock. The renewable lease preserves credential/runtime
              // identity until conditional settlement.
              if (authorizationClaim.preparedText !== null)
                payload = { ...payload, text: authorizationClaim.preparedText };
              const telegramDraft =
                authorizationClaim.endpoint.provider === "telegram" &&
                authorizationClaim.conversation.isDirectMessage &&
                !replaceProviderMessageId &&
                !payload.transportPart &&
                !payload.card &&
                !payload.attachmentIds?.length &&
                shouldStreamSafePublicationText(
                  renderPublicationTransportText(payload),
                ) &&
                (await hasTelegramStopSubscription(
                  authorizationClaim.endpoint,
                  currentPublicationRuntimeContext,
                ))
                  ? await reserveTelegramPublicationDraft({
                      endpoint: authorizationClaim.endpoint,
                      conversation: authorizationClaim.conversation,
                      publication,
                      text: renderPublicationTransportText(payload),
                      credentialLease,
                      runtimeContext: currentPublicationRuntimeContext,
                    })
                  : null;
              const sent = await postSafePublication({
                endpoint: authorizationClaim.endpoint,
                conversation: authorizationClaim.conversation,
                publication,
                payload,
                replaceProviderMessageId,
                telegramDraftControl: telegramDraft?.control,
                beforePhotonWrite: () => db.transaction(async (tx) => {
                  await credentialLease.assertOwned(tx);
                  if (!(await authorizeRetainedChatSourcePublication(tx, publication))) throw new PhotonError("rejected", "Publication source authorization changed");
                }),
                onSlackFileUploadAccepted: async (receipt) => {
                  // uploadV2 has completed at this point. Mark acceptance
                  // before the durable callback so a local write failure is
                  // still quarantined and can never trigger an implicit upload.
                  providerAccepted = true;
                  slackFileReceiptActionId = await recordSlackFileUploadReceipt(
                    {
                      credentialLease,
                      endpoint: authorizationClaim.endpoint,
                      conversation: authorizationClaim.conversation,
                      publication,
                      receipt,
                      runtimeContext: currentPublicationRuntimeContext,
                    },
                  );
                },
              });
              if (isTelegramDraftStopped(sent)) {
                // Only the durable stop transaction can produce this outcome.
                // It settled this exact publication; never fabricate a provider
                // receipt, complete its task, or enqueue a retry from this path.
                if (!telegramDraft)
                  throw new Error("Unexpected Telegram draft stop result");
                const stopped = await db
                  .select({ id: chatActions.id })
                  .from(chatActions)
                  .innerJoin(
                    chatPublications,
                    and(
                      eq(chatPublications.id, publication.id),
                      eq(chatPublications.state, "cancelled"),
                      eq(chatPublications.attempts, publication.attempts + 1),
                    ),
                  )
                  .where(
                    and(
                      eq(chatActions.id, telegramDraft.actionId),
                      eq(chatActions.status, "cancelled"),
                      sql`${chatActions.result}->>'phase' = 'stopped'`,
                    ),
                  );
                if (stopped.length !== 1)
                  throw new Error(
                    "Telegram draft stop was not durably committed",
                  );
                return;
              }
              providerAccepted = true;
              // A resolved SDK call is not a usable delivery receipt. Teams,
              // for example, returns an empty ID for an empty HTTP success
              // body. Preserve uncertainty instead of publishing a broken
              // message link or automatically sending the content again.
              if (
                typeof sent?.id !== "string" ||
                !sent.id ||
                sent.id.length > 2048 ||
                sent.id.trim() !== sent.id ||
                /[\u0000-\u001f\u007f]/.test(sent.id)
              ) {
                throw new Error(
                  "Provider did not return a usable message receipt",
                );
              }
              const { authorizationActionId } = authorizationClaim;
              const receiptRemovalActionIds: string[] = [];
              await db.transaction(async (tx) => {
                await credentialLease.assertOwned(tx);
                const committedAt = new Date();
                await notifyChatPublicationWork(tx);
                await notifyVoicePublication(tx, authorizationClaim.endpoint, publication.conversationId);
                const [completedPublication] = await tx
                  .update(chatPublications)
                  .set({
                    state: "published",
                    payload,
                    providerMessageId: sent.id,
                    publishedAt: committedAt,
                    redactedError: null,
                    updatedAt: committedAt,
                  })
                  .where(
                    and(
                      eq(chatPublications.id, publication.id),
                      eq(chatPublications.state, "streaming"),
                      eq(chatPublications.attempts, publication.attempts + 1),
                    ),
                  )
                  .returning({ id: chatPublications.id });
                if (!completedPublication) {
                  throw new Error(
                    "Chat publication ownership changed before commit",
                  );
                }
                if (telegramDraft) {
                  const completedDraft = await tx
                    .update(chatActions)
                    .set({
                      status: "processed",
                      result: {
                        phase: "published",
                        providerMessageId: sent.id,
                      },
                      updatedAt: committedAt,
                    })
                    .where(
                      and(
                        eq(chatActions.id, telegramDraft.actionId),
                        eq(chatActions.status, "processing"),
                        sql`${chatActions.result}->>'phase' = 'final_sending'`,
                      ),
                    )
                    .returning({ id: chatActions.id });
                  if (completedDraft.length !== 1)
                    throw new Error(
                      "Telegram final draft ownership changed before commit",
                    );
                }
                if (slackFileReceiptActionId) {
                  const [completedReceipt] = await tx
                    .update(chatActions)
                    .set({
                      status: "processed",
                      result: {
                        code: "slack_file_upload_identity_confirmed",
                        attempts: 1,
                      },
                      updatedAt: committedAt,
                    })
                    .where(
                      and(
                        eq(chatActions.id, slackFileReceiptActionId),
                        eq(chatActions.kind, "slack_file_upload_receipt"),
                        eq(chatActions.status, "received"),
                        sql`(${chatActions.payload}->>'publicationId')::uuid = ${publication.id}`,
                        sql`(${chatActions.payload}->>'publicationAttempt')::int = ${publication.attempts + 1}`,
                      ),
                    )
                    .returning({ id: chatActions.id });
                  if (!completedReceipt) {
                    throw new Error(
                      "Slack file upload receipt ownership changed before commit",
                    );
                  }
                }
                if (slackFileReceiptActionId) {
                  await stageSlackFilePublicationSuccess(tx, {
                    committedAt,
                    endpoint: authorizationClaim.endpoint,
                    publication,
                    providerMessageId: sent.id,
                    runtimeContext: currentPublicationRuntimeContext,
                    stageSessionSync:
                      !isExplicitOperatorPublication(publication) &&
                      !publication.idempotencyKey.startsWith("control:status:"),
                  });
                } else {
                  // A queue notice references its causal inbound comment for
                  // authorization, but is not an authored copy of that comment.
                  // Reactions/readers must not attribute bot status to the user.
                  const linkedCommentId = parseInboundWakePublicationKey(
                    publication.idempotencyKey,
                  )
                    ? null
                    : publication.commentId;
                  const messageLinkInsert = tx.insert(chatMessageLinks).values({
                    companyId: publication.companyId,
                    endpointId: publication.endpointId,
                    conversationId: publication.conversationId,
                    publicationId: publication.id,
                    commentId: linkedCommentId,
                    providerMessageId: sent.id,
                    direction: "outbound",
                  });
                  if (replaceProviderMessageId) {
                    await messageLinkInsert.onConflictDoUpdate({
                      target: [
                        chatMessageLinks.endpointId,
                        chatMessageLinks.conversationId,
                        chatMessageLinks.providerMessageId,
                      ],
                      set: {
                        publicationId: publication.id,
                        commentId: linkedCommentId,
                      },
                    });
                  } else {
                    await messageLinkInsert.onConflictDoNothing();
                  }
                  await tx
                    .update(chatEndpoints)
                    .set({
                      lastPublicationAt: committedAt,
                      updatedAt: committedAt,
                    })
                    .where(
                      and(
                        eq(chatEndpoints.id, authorizationClaim.endpoint.id),
                        inArray(chatEndpoints.status, ["verifying", "active"]),
                        sql`coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0) = ${currentPublicationRuntimeContext.generation}`,
                      ),
                    );
                }
                if (authorizationActionId) {
                  const processedAuthorization = await tx
                    .update(chatActions)
                    .set({
                      status: "processed",
                      result: { code: "task_control_authorized_and_sent" },
                      updatedAt: committedAt,
                    })
                    .where(
                      and(
                        eq(chatActions.id, authorizationActionId),
                        eq(chatActions.status, "processing"),
                        sql`(${chatActions.result}->>'attempts')::int = ${publication.attempts + 1}`,
                      ),
                    )
                    .returning({ id: chatActions.id });
                  if (!processedAuthorization.length) {
                    throw new Error(
                      "Task-control authorization ownership changed before commit",
                    );
                  }
                }
                await commitTaskControlCompletion(
                  tx as unknown as Db,
                  publication,
                  committedAt,
                );
                if (
                  !slackFileReceiptActionId &&
                  authorizationClaim.endpoint.provider === "slack" &&
                  !isExplicitOperatorPublication(publication) &&
                  !parseInboundWakePublicationKey(publication.idempotencyKey) &&
                  !publication.idempotencyKey.startsWith("control:status:")
                ) {
                  await stageSlackSessionSync(tx, {
                    companyId: publication.companyId,
                    endpointId: publication.endpointId,
                    conversationId: publication.conversationId,
                    runtimeGeneration:
                      currentPublicationRuntimeContext.generation,
                    credentialFingerprint:
                      currentPublicationRuntimeContext.credentialFingerprint,
                  });
                }
                receiptRemovalActionIds.push(
                  ...(await stageTerminalReceiptReactionRemovals(
                    tx as unknown as Db,
                    {
                      endpoint: authorizationClaim.endpoint,
                      publication,
                      payload,
                      runtimeContext: currentPublicationRuntimeContext,
                      closedProgressRunId: closedProgress?.runId,
                    },
                  )),
                );
                await credentialLease.assertOwned(tx);
              });
              // Receipt cleanup is non-critical provider I/O. Dispatch it
              // after the terminal reply and durable action commit so a
              // slow reaction endpoint cannot hold the publication lane.
              // If this process stops first, the action outbox resumes the
              // idempotent removal on a later reconciliation sweep.
              for (const actionId of receiptRemovalActionIds) {
                scheduleMessageProcessing(() =>
                  processReceiptReaction(actionId),
                );
              }
            } catch (error) {
              // Authentication, membership, and destination failures mutate
              // endpoint/runtime state. Settle them before releasing the
              // credential lease so a concurrent reconnect or provider
              // recovery cannot be overwritten by this stale attempt.
              failureHandledWithinCredentialLease = true;
              // If ownership was already lost, leave the publication in its
              // conservative streaming state for quarantine. Mutating health
              // from this obsolete runtime would overwrite the new owner.
              await settlePublicationFailure(error, credentialLease);
            }
          },
        );
      } catch (error) {
        if (!failureHandledWithinCredentialLease)
          await settlePublicationFailure(error);
      }
    });
  }
  return { processSelectedPublication, stageTerminalReceiptReactionRemovals };
}
