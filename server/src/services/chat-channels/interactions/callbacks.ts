import { slackQuestionFormValidationError } from "../slack/question-forms.js";
import { chatInteractionForm, chatItemVerdicts } from "../../chat-interaction-forms.js";
import { createDiscordQuestionForms } from "../discord/question-forms.js";

import { createProviderEffects, type ProviderEffectPayload } from "../provider-effects.js";
import { createTelegramCallbackNoticeAuthority } from "../telegram/callback-notices.js";

import type { EndpointRow, DbTransaction, DbOrTransaction, RuntimeContext, LifecycleRuntimeFence } from "../runtime-types.js";

import { notifyChatDeliveryWork, notifyChatPublicationWork } from "../../chat-work-notifications.js";

import {
  createHash,
} from "node:crypto";
import {
  and,
  eq,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatMessageLinks,
  chatPublications,
  issues,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatAdapterCapabilities,
  ChatProvider,
  SafeChatPublicationPayload,
  IssueThreadInteraction,
} from "@paperclipai/shared";

import {
  readTelegramCallbackProvenance,
  telegramCallbackThreadId,
  TELEGRAM_PRIVATE_ACTION_UNAVAILABLE,
} from "../../chat-telegram-ephemeral.js";

import {
  forbidden,
} from "../../../errors.js";
import { logger } from "../../../middleware/logger.js";

import {
  type ChatSdkCallbackEvent,
} from "../../chat-sdk-runtime.js";
import type {
  ChatSdkStatePersistence,
} from "../../chat-sdk-state.js";
import {
  logActivity,
} from "../../activity-log.js";

import { projectSafeChatPublication } from "../../chat-publication-projection.js";

import {
  discordQuestionFormCorrectionModal,
  discordQuestionFormDenialResponse,
  discordQuestionFormThreadId,
  isDiscordQuestionFormCorrectionId,
  loadDiscordQuestionFormCorrection,
} from "../../chat-discord-question-forms.js";

import {
  enqueueTerminalIssueInteractionChatPublications,
  nativeChatQuestion,
  nativeChatMultiQuestion,
  nativeChatCustomQuestion,
  TELEGRAM_CALLBACK_DATA_LIMIT_BYTES,
  telegramChatSdkCallbackData,
} from "../../chat-interaction-publications.js";

import { classifyChatPublicationError } from "../../chat-publication-errors.js";

import { issueThreadInteractionService } from "../../issue-thread-interactions.js";
import {
  questionResponseDeliveryService,
} from "../../question-response-delivery.js";
import {
  chatQuestionFormDenialResponse,
  chatQuestionFormValidationResponse,
  claimChatQuestionFormSubmission,
  completeChatQuestionFormSubmission,
  isChatQuestionFormOpenActionId,
  loadChatQuestionFormSubmissionToken,
  resolveChatQuestionFormOpen,
  validateChatQuestionFormSubmission,
} from "../../chat-question-forms.js";

import type {
  ActionEvent,
  Author,
  ModalResponse,
  ModalSubmitEvent,
  Thread,
} from "chat";

import type { EndpointRecord } from "../runtime-types.js";
import { createChatConfirmationActions } from "./confirmation-actions.js";
type ResourceRow = typeof chatEndpointResources.$inferSelect;
type PrincipalResolution = { principal: typeof chatExternalPrincipals.$inferSelect; userId: string | null; linkedDenied: boolean };
type InteractionCallbacksOptions = {
  heartbeat: import("../../issue-assignment-wakeup.js").IssueAssignmentWakeupDeps;
  CAPABILITIES: Record<ChatProvider, ChatAdapterCapabilities>;
  MAX_ERROR_TEXT: number;
  actionThreadMatchesConversation: (provider: ChatProvider, actionThreadId: string, conversationThreadId: string) => boolean;
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: ResourceRow | null | undefined) => boolean;
  sameTeamsThreadIdentity: (left: string, right: string) => boolean;
  ensurePrincipal: (endpoint: EndpointRow, author: Author, raw?: unknown) => Promise<PrincipalResolution>;
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  runtimeCallbackRecord: (endpointId: string, context: RuntimeContext, statuses: EndpointRow["status"][]) => Promise<EndpointRecord | null>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  requireCurrentExternalActionAuthorization: (tx: DbTransaction, input: { conversationId: string; endpointId: string; expectedUserId: string; principalId: string; runtimeContext: LifecycleRuntimeFence }) => Promise<void>;
  isExternalActionAuthorizationChange: (error: unknown) => boolean;
  recordCurrentMicrosoftTeamsRoute: (endpoint: EndpointRow, context: RuntimeContext, threadId: string, raw: unknown) => Promise<void>;
  lockTelegramCallbackNoticeAuthority: ReturnType<typeof createTelegramCallbackNoticeAuthority>["lockTelegramCallbackNoticeAuthority"];
  stageProviderEffect: ReturnType<typeof createProviderEffects>["stageProviderEffect"];
  scheduleProviderEffect: (actionId: string, thread?: Thread<unknown, unknown>) => void;
  invalidateRuntime: (endpointId: string) => Promise<boolean>;
  redactError: (error: unknown) => string;
  persistence: ChatSdkStatePersistence;
  questionResponses: Pick<ReturnType<typeof questionResponseDeliveryService>, "deliver">;
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  processPendingPublications: () => Promise<unknown>;
  confirmationResolutionPersistBarrier?: () => Promise<void>;
  questionFormOpenAuthorizationBarrier?: () => Promise<void>;
  questionResolutionPersistBarrier?: () => Promise<void>;
};

export function createChatInteractionCallbacks(db: Db, options: InteractionCallbacksOptions) {
  const { CAPABILITIES, MAX_ERROR_TEXT, actionThreadMatchesConversation, nonDirectDestinationAllowed, sameTeamsThreadIdentity, ensurePrincipal, endpointRecord, runtimeCallbackRecord, runtimeCallbackEndpoint, requireCurrentExternalActionAuthorization, isExternalActionAuthorizationChange, recordCurrentMicrosoftTeamsRoute, lockTelegramCallbackNoticeAuthority, stageProviderEffect, scheduleProviderEffect, invalidateRuntime, redactError, persistence, questionResponses, scheduleMessageProcessing, processPendingPublications } = options;
  const { handleDiscordFormCorrection, acceptDiscordQuestionForm } = createDiscordQuestionForms(db, { requireCurrentExternalActionAuthorization, isExternalActionAuthorizationChange, persistence });
  const { reconcileTerminalConfirmationActions, handleChatConfirmation } = createChatConfirmationActions(db, {
    heartbeat: options.heartbeat, requireCurrentExternalActionAuthorization, isExternalActionAuthorizationChange, scheduleMessageProcessing, processPendingPublications,
    get confirmationResolutionPersistBarrier() { return options.confirmationResolutionPersistBarrier; },
  });


  async function denyExternalAction(
    endpoint: EndpointRow,
    event: ChatSdkCallbackEvent<ActionEvent>,
    runtimeContext: LifecycleRuntimeFence,
    safelyKnown: {
      conversationId?: string | null;
      principalId?: string | null;
    } = {},
  ): Promise<void> {
    const telegramCallback =
      endpoint.provider === "telegram" && endpoint.botExternalId
        ? readTelegramCallbackProvenance(event.telegramCallback, {
            companyId: endpoint.companyId,
            endpointId: endpoint.id,
            botUserId: endpoint.botExternalId,
            threadId: event.event.threadId,
            messageId: event.event.messageId,
            userId: event.event.user.userId,
          })
        : null;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          telegramCallback
            ? [
                endpoint.id,
                "telegram_callback_denial",
                telegramCallback.botUserId,
                telegramCallback.callbackId,
              ]
            : [
                endpoint.id,
                event.provider,
                event.event.threadId,
                event.event.messageId,
                event.event.user.userId,
                event.event.actionId,
                event.event.triggerId ?? null,
              ],
        ),
      )
      .digest("hex");
    const providerEventId = `action-denied:${fingerprint}`;
    const processedAt = new Date();
    const actionThread = event.event.thread;
    const effectPayload =
      actionThread &&
      typeof actionThread.postEphemeral === "function" &&
      CAPABILITIES[endpoint.provider].ephemeralMessages
        ? ({
            version: 1,
            effect: "ephemeral_message",
            authorizationMode: "safe_notice",
            threadId: event.event.threadId,
            userId: event.event.user.userId,
            text: "This action is no longer available. Open the linked Paperclip task or ask an operator to link this account.",
            fallbackText: "This Paperclip action is no longer available.",
            settleDelivery: false,
          } as const)
        : null;
    let effect: typeof chatActions.$inferSelect | null = null;
    try {
      effect = await db.transaction(async (tx) => {
        const currentEndpoint = telegramCallback
          ? await runtimeCallbackEndpoint(tx, endpoint.id, runtimeContext, [
              "active",
            ])
          : null;
        const telegramAuthorizationSha256 =
          currentEndpoint && telegramCallback
            ? await lockTelegramCallbackNoticeAuthority(
                tx,
                currentEndpoint,
                telegramCallback,
                safelyKnown.principalId ?? null,
              )
            : null;
        await notifyChatDeliveryWork(tx);
        const [inserted] = await tx
          .insert(chatDeliveries)
          .values({
            companyId: endpoint.companyId,
            endpointId: endpoint.id,
            conversationId: safelyKnown.conversationId ?? null,
            principalId: safelyKnown.principalId ?? null,
            providerEventId,
            deduplicationKey: fingerprint,
            eventKind: "action",
            normalizedEvent: {
              providerEventId,
              kind: "action",
              authorization: { outcome: "denied" },
              ...(telegramCallback
                ? { telegramCallback, telegramAuthorizationSha256 }
                : {}),
            },
            state: "filtered",
            attempts: 1,
            redactedError: "External action denied by Paperclip authorization",
            processedAt,
            updatedAt: processedAt,
          })
          .onConflictDoNothing()
          .returning();
        const notice: Omit<
          ProviderEffectPayload,
          "runtimeGeneration" | "credentialFingerprint"
        > | null =
          telegramCallback && telegramAuthorizationSha256
            ? {
                version: 1,
                effect: "telegram_callback_notice",
                authorizationMode: "safe_notice",
                telegramCallback,
                telegramAuthorizationSha256,
                threadId: telegramCallbackThreadId(telegramCallback),
                userId: telegramCallback.receiverUserId,
                text: TELEGRAM_PRIVATE_ACTION_UNAVAILABLE,
                settleDelivery: false,
              }
            : effectPayload;
        if (!inserted || !notice) return null;
        return stageProviderEffect(tx, {
          endpoint,
          deliveryId: inserted.id,
          conversationId: safelyKnown.conversationId ?? null,
          principalId: safelyKnown.principalId ?? null,
          providerActionId: `provider_effect:${providerEventId}`,
          payload: notice,
          runtimeContext,
        });
      });
    } catch (error) {
      logger.warn(
        {
          endpointId: endpoint.id,
          provider: endpoint.provider,
          error: redactError(error),
        },
        "could not record denied external chat action",
      );
      // Provider retries are useful only while the authoritative denial could
      // not be recorded. Once the filtered delivery exists, a policy denial
      // is a successfully handled webhook and must not be surfaced as a
      // callback failure (which the Chat SDK correctly converts to a 503).
      throw error;
    }
    if (effect && actionThread) {
      // The callback is acknowledged after the authoritative denial and its
      // provider effect are durable. Slow provider I/O runs out of band; a
      // redelivery finds the same action and cannot enqueue another notice.
      scheduleProviderEffect(effect.id, actionThread);
    }
  }

  async function recordModalOpenFailure(
    endpoint: EndpointRow,
    event: ChatSdkCallbackEvent<ActionEvent>,
    runtimeContext: LifecycleRuntimeFence,
    safelyKnown: {
      attemptActionId?: string | null;
      conversationId?: string | null;
      principalId?: string | null;
      resource?: ResourceRow | null;
    },
    error: unknown,
  ): Promise<void> {
    const disposition = classifyChatPublicationError(error, 1);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          endpoint.id,
          event.provider,
          "modal_open",
          event.event.triggerId ?? null,
          event.event.threadId,
          event.event.messageId,
          event.event.user.userId,
          event.event.actionId,
        ]),
      )
      .digest("hex");
    const providerEventId = `modal-open-failed:${fingerprint}`;
    const failure = redactError(error);
    const processedAt = new Date();
    const actionThread = event.event.thread;
    const effectPayload =
      actionThread &&
      typeof actionThread.postEphemeral === "function" &&
      CAPABILITIES[endpoint.provider].ephemeralMessages
        ? ({
            version: 1,
            effect: "ephemeral_message",
            authorizationMode: "safe_notice",
            threadId: event.event.threadId,
            userId: event.event.user.userId,
            text: "Paperclip could not open this form. Try the action again or open the linked Paperclip task.",
            fallbackText: "Paperclip could not open this form.",
            settleDelivery: false,
          } as const)
        : null;
    let effect: typeof chatActions.$inferSelect | null = null;
    let invalidateEndpointRuntime = false;
    try {
      effect = await db.transaction(async (tx) => {
        await notifyChatDeliveryWork(tx);
        const [inserted] = await tx
          .insert(chatDeliveries)
          .values({
            companyId: endpoint.companyId,
            endpointId: endpoint.id,
            conversationId: safelyKnown.conversationId ?? null,
            principalId: safelyKnown.principalId ?? null,
            providerEventId,
            deduplicationKey: fingerprint,
            eventKind: "action",
            normalizedEvent: {
              providerEventId,
              kind: "action",
              modal: {
                phase: "open",
                outcome: "failed",
                disposition: disposition.kind,
              },
            },
            // Modal callbacks are acknowledged after this audit row commits.
            // They must never enter the replayable inbound-delivery queue.
            state: "filtered",
            attempts: 1,
            redactedError: `Provider modal open failed: ${failure}`.slice(
              0,
              MAX_ERROR_TEXT,
            ),
            processedAt,
            updatedAt: processedAt,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) return null;

        if (safelyKnown.attemptActionId) {
          await tx
            .update(chatActions)
            .set({
              status: "failed",
              result: {
                code: `question_form_open_${disposition.kind}`,
                retryable: false,
              },
              updatedAt: processedAt,
            })
            .where(
              and(
                eq(chatActions.id, safelyKnown.attemptActionId),
                eq(chatActions.status, "processing"),
              ),
            );
        }

        if (disposition.kind === "endpoint_attention") {
          const currentEndpoint = await runtimeCallbackEndpoint(
            tx,
            endpoint.id,
            runtimeContext,
            ["active"],
          );
          if (currentEndpoint) {
            await tx
              .update(chatEndpoints)
              .set({
                status: "attention",
                healthMessage:
                  "Provider credentials or permissions need attention",
                lastError: failure,
                updatedAt: processedAt,
              })
              .where(eq(chatEndpoints.id, endpoint.id));
            await tx
              .update(toolConnections)
              .set({
                healthStatus: "failed",
                healthMessage:
                  "Provider credentials or permissions need attention",
                lastError: failure,
                healthCheckedAt: processedAt,
                updatedAt: processedAt,
              })
              .where(eq(toolConnections.id, endpoint.connectionId));
            invalidateEndpointRuntime = true;
          }
        } else if (
          disposition.kind === "resource_unavailable" &&
          safelyKnown.resource
        ) {
          await tx
            .update(chatEndpointResources)
            .set({ availability: "unavailable", updatedAt: processedAt })
            .where(
              and(
                eq(chatEndpointResources.companyId, endpoint.companyId),
                eq(chatEndpointResources.endpointId, endpoint.id),
                eq(chatEndpointResources.id, safelyKnown.resource.id),
              ),
            );
        }

        if (!effectPayload) return null;
        return stageProviderEffect(tx, {
          endpoint,
          deliveryId: inserted.id,
          conversationId: safelyKnown.conversationId ?? null,
          principalId: safelyKnown.principalId ?? null,
          providerActionId: `provider_effect:${providerEventId}`,
          payload: effectPayload,
          runtimeContext,
        });
      });
    } catch (auditError) {
      logger.warn(
        {
          endpointId: endpoint.id,
          provider: endpoint.provider,
          error: redactError(auditError),
        },
        "could not record external chat modal-open failure",
      );
      throw auditError;
    }
    if (effect && actionThread) scheduleProviderEffect(effect.id, actionThread);
    if (invalidateEndpointRuntime) {
      await invalidateRuntime(endpoint.id).catch(() => undefined);
    }
  }

  async function recordModalSubmitDenial(
    endpoint: EndpointRow,
    event: ChatSdkCallbackEvent<ModalSubmitEvent>,
    input: {
      code: string;
      conversationId?: string | null;
      principalId?: string | null;
    },
    database: DbOrTransaction = db,
  ): Promise<void> {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          endpoint.id,
          event.provider,
          "modal_submit",
          event.event.callbackId,
          event.event.viewId,
          event.event.user.userId,
          input.code,
        ]),
      )
      .digest("hex");
    const providerEventId = `modal-submit-denied:${fingerprint}`;
    const processedAt = new Date();
    try {
      await database
        .insert(chatDeliveries)
        .values({
          companyId: endpoint.companyId,
          endpointId: endpoint.id,
          conversationId: input.conversationId ?? null,
          principalId: input.principalId ?? null,
          providerEventId,
          deduplicationKey: fingerprint,
          eventKind: "action",
          normalizedEvent: {
            providerEventId,
            kind: "action",
            authorization: { outcome: "denied" },
            modal: {
              phase: "submit",
              outcome: "denied",
              code: input.code,
            },
          },
          state: "filtered",
          attempts: 1,
          redactedError: "External chat modal submission denied by Paperclip",
          processedAt,
          updatedAt: processedAt,
        })
        .onConflictDoNothing();
    } catch (error) {
      logger.warn(
        {
          endpointId: endpoint.id,
          provider: endpoint.provider,
          error: redactError(error),
        },
        "could not record denied external chat modal submission",
      );
      throw error;
    }
  }

  async function handleAction(
    event: ChatSdkCallbackEvent<ActionEvent>,
    runtimeContext: RuntimeContext,
  ) {
    const record = await runtimeCallbackRecord(
      event.endpointId,
      runtimeContext,
      ["active"],
    );
    if (!record) {
      throw forbidden("This chat action is not a current Paperclip question");
    }
    const deny = async (safelyKnown?: {
      conversationId?: string | null;
      principalId?: string | null;
    }) => {
      await denyExternalAction(
        record.endpoint,
        event,
        runtimeContext,
        safelyKnown,
      );
      if (
        event.provider === "discord" &&
        event.transport === "discord_gateway"
      ) {
        // Discord renders deferUpdate as a successful click. After the denial
        // audit is durable, surface a transport-only sentinel so the Gateway
        // adapter can withhold that misleading acknowledgement. The runtime,
        // not raw JSON or discord.js methods, supplies the ingress context.
        throw Object.assign(
          new Error("Discord Gateway action was not admitted by Paperclip"),
          { code: "chat_discord_gateway_action_rejected" },
        );
      }
    };
    if (
      record.endpoint.status !== "active" ||
      record.endpoint.provider !== event.provider ||
      record.endpoint.capabilities.actions !== true
    ) {
      return deny();
    }
    const principal = await ensurePrincipal(
      record.endpoint,
      event.event.user,
      event.event.raw,
    );
    // Executable external actions are deliberately stricter than ordinary
    // sponsored-guest messages. They require a current endpoint-scoped link to
    // an active non-viewer Paperclip member, and never run as a guest sponsor.
    if (
      principal.linkedDenied ||
      !principal.userId ||
      principal.principal.kind !== "user" ||
      principal.principal.isBot
    ) {
      return deny({ principalId: principal.principal.id });
    }
    const isCorrection = isDiscordQuestionFormCorrectionId(
      event.event.actionId,
    );
    const correction =
      isCorrection &&
      event.provider === "discord" &&
      event.transport === "discord_gateway"
        ? await loadDiscordQuestionFormCorrection(
            persistence,
            {
              companyId: record.endpoint.companyId,
              endpointId: record.endpoint.id,
            },
            event.event.actionId,
            {
              principalId: principal.principal.id,
              userId: principal.userId,
              externalUserId: event.event.user.userId,
            },
            event.event.threadId,
          )
        : null;
    if (
      isCorrection &&
      (!correction ||
        discordQuestionFormThreadId(event.event.raw) !== event.event.threadId)
    )
      return deny({ principalId: principal.principal.id });
    // The private correction handle selects the original publication, never
    // the new ephemeral error message. It does not bypass any current source,
    // destination, actor, open-token, or pending-interaction check below.
    const sourceActionId = correction?.openActionId ?? event.event.actionId;
    const sourceMessageId =
      correction?.providerMessageId ?? event.event.messageId;
    const actionBinding = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, record.endpoint.companyId),
          eq(chatActions.endpointId, record.endpoint.id),
          inArray(chatActions.kind, [
            "question_answer",
            "question_form_open",
            "confirmation_response",
          ]),
          eq(chatActions.providerActionId, sourceActionId),
        ),
      )
      .then((rows) => (rows.length === 1 ? rows[0]! : null));
    const originalPublicationId = actionBinding?.payload.publicationId;
    const actionInteractionId = actionBinding?.payload.interactionId;
    if (
      correction &&
      (actionBinding?.kind !== "question_form_open" ||
        actionBinding.conversationId !== correction.conversationId ||
        originalPublicationId !== correction.publicationId ||
        actionInteractionId !== correction.interactionId ||
        actionBinding.payload.formActionId !== correction.submitActionId)
    )
      return deny({ principalId: principal.principal.id });
    if (
      !actionBinding?.conversationId ||
      typeof originalPublicationId !== "string" ||
      typeof actionInteractionId !== "string"
    ) {
      return deny({ principalId: principal.principal.id });
    }
    // The opaque provider action is the immutable link to the original
    // publication. Resolve the conversation from that token, then verify the
    // provider's thread independently; never trust a callback message id to
    // select a Paperclip task.
    const conversation = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, record.endpoint.companyId),
          eq(chatConversations.endpointId, record.endpoint.id),
          eq(chatConversations.id, actionBinding.conversationId),
          inArray(chatConversations.state, ["active", "waiting"]),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (
      !conversation ||
      !actionThreadMatchesConversation(
        event.provider,
        event.event.threadId,
        conversation.externalThreadId,
      )
    ) {
      return deny({ principalId: principal.principal.id });
    }
    const safelyKnown = {
      conversationId: conversation.id,
      principalId: principal.principal.id,
    };
    const resource = conversation.resourceId
      ? await db
          .select()
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.companyId, record.endpoint.companyId),
              eq(chatEndpointResources.endpointId, record.endpoint.id),
              eq(chatEndpointResources.id, conversation.resourceId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const resourceAllowed = conversation.isDirectMessage
      ? record.endpoint.allowDirectMessages
      : nonDirectDestinationAllowed(record.endpoint, resource);
    if (!resourceAllowed) return deny(safelyKnown);

    let originalPublication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, record.endpoint.companyId),
          eq(chatPublications.endpointId, record.endpoint.id),
          eq(chatPublications.conversationId, conversation.id),
          eq(chatPublications.issueId, conversation.issueId),
          eq(chatPublications.id, originalPublicationId),
          inArray(chatPublications.state, ["published", "delivery_unknown"]),
          or(
            isNull(chatPublications.providerMessageId),
            eq(chatPublications.providerMessageId, sourceMessageId),
          ),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!originalPublication) return deny(safelyKnown);
    if (
      correction &&
      (originalPublication.state !== "published" ||
        originalPublication.providerMessageId !== correction.providerMessageId)
    )
      return deny(safelyKnown);
    if (!originalPublication.providerMessageId) {
      const reconciledPublication = await db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.id, originalPublicationId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (
          !current ||
          current.companyId !== record.endpoint.companyId ||
          current.endpointId !== record.endpoint.id ||
          current.conversationId !== conversation.id ||
          current.issueId !== conversation.issueId ||
          !["published", "delivery_unknown"].includes(current.state) ||
          (current.providerMessageId !== null &&
            current.providerMessageId !== event.event.messageId)
        ) {
          return null;
        }
        const occupied = await tx
          .select({ publicationId: chatMessageLinks.publicationId })
          .from(chatMessageLinks)
          .where(
            and(
              eq(chatMessageLinks.endpointId, record.endpoint.id),
              eq(chatMessageLinks.conversationId, conversation.id),
              eq(chatMessageLinks.providerMessageId, event.event.messageId),
              eq(chatMessageLinks.direction, "outbound"),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (occupied && occupied.publicationId !== current.id) return null;
        const reconciledAt = new Date();
        await notifyChatPublicationWork(tx);
        const [reconciled] = await tx
          .update(chatPublications)
          .set({
            state: "published",
            providerMessageId: event.event.messageId,
            publishedAt: current.publishedAt ?? reconciledAt,
            nextAttemptAt: null,
            redactedError: null,
            updatedAt: reconciledAt,
          })
          .where(
            and(
              eq(chatPublications.id, current.id),
              inArray(chatPublications.state, [
                "published",
                "delivery_unknown",
              ]),
              isNull(chatPublications.providerMessageId),
            ),
          )
          .returning();
        if (!reconciled) return null;
        await tx
          .insert(chatMessageLinks)
          .values({
            companyId: current.companyId,
            endpointId: current.endpointId,
            conversationId: current.conversationId,
            publicationId: current.id,
            commentId: current.commentId,
            providerMessageId: event.event.messageId,
            direction: "outbound",
          })
          .onConflictDoNothing();
        const linked = await tx
          .select({ publicationId: chatMessageLinks.publicationId })
          .from(chatMessageLinks)
          .where(
            and(
              eq(chatMessageLinks.endpointId, record.endpoint.id),
              eq(chatMessageLinks.conversationId, conversation.id),
              eq(chatMessageLinks.providerMessageId, event.event.messageId),
              eq(chatMessageLinks.direction, "outbound"),
            ),
          )
          .then((rows) => rows[0] ?? null);
        return linked?.publicationId === reconciled.id ? reconciled : null;
      });
      if (!reconciledPublication) return deny(safelyKnown);
      originalPublication = reconciledPublication;
    }
    const messageBinding = await db
      .select({
        link: chatMessageLinks,
        linkedPublication: chatPublications,
      })
      .from(chatMessageLinks)
      .innerJoin(
        chatPublications,
        and(
          eq(chatPublications.companyId, chatMessageLinks.companyId),
          eq(chatPublications.endpointId, chatMessageLinks.endpointId),
          eq(chatPublications.conversationId, chatMessageLinks.conversationId),
          eq(chatPublications.id, chatMessageLinks.publicationId),
        ),
      )
      .where(
        and(
          eq(chatMessageLinks.companyId, record.endpoint.companyId),
          eq(chatMessageLinks.endpointId, record.endpoint.id),
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.providerMessageId, sourceMessageId),
          eq(chatMessageLinks.direction, "outbound"),
          eq(chatPublications.issueId, conversation.issueId),
          eq(chatPublications.state, "published"),
          eq(chatPublications.providerMessageId, sourceMessageId),
        ),
      )
      .then((rows) => (rows.length === 1 ? rows[0]! : null));
    if (!messageBinding) return deny(safelyKnown);
    const linkedPayload = messageBinding.linkedPublication
      .payload as SafeChatPublicationPayload;
    const linkStillAuthoritative =
      messageBinding.link.publicationId === originalPublicationId ||
      (messageBinding.linkedPublication.idempotencyKey ===
        `interaction-resolution:${actionInteractionId}:${record.endpoint.id}` &&
        linkedPayload.interactionId === actionInteractionId);
    if (!originalPublication || !linkStillAuthoritative) {
      return deny(safelyKnown);
    }
    const issued = {
      publication: originalPublication,
      link: messageBinding.link,
      conversation,
    };

    const payload = issued.publication.payload as SafeChatPublicationPayload;
    if (event.provider === "telegram") {
      const raw = event.event.raw;
      const callbackData =
        raw && typeof raw === "object" && "data" in raw
          ? (raw as { data?: unknown }).data
          : null;
      if (
        typeof callbackData !== "string" ||
        Buffer.byteLength(callbackData, "utf8") >
          TELEGRAM_CALLBACK_DATA_LIMIT_BYTES ||
        callbackData !== telegramChatSdkCallbackData(event.event.actionId) ||
        event.event.value !== undefined
      ) {
        return deny(safelyKnown);
      }
    }
    if (
      !payload.interactionId ||
      (!correction &&
        event.provider !== "telegram" &&
        event.event.value !== payload.interactionId) ||
      !(payload.card?.actions?.some(
        (action) => action.type === "callback" && action.actionId === sourceActionId,
      ) || payload.card?.selection?.options.some(option => option.actionId === sourceActionId) ||
        payload.card?.selection?.multiple && payload.card.selection.actionId === sourceActionId)
    ) {
      return deny(safelyKnown);
    }

    const interaction = (
      await issueThreadInteractionService(db).listForIssue(conversation.issueId)
    ).find((candidate) => candidate.id === payload.interactionId);
    if (
      !interaction ||
      interaction.companyId !== record.endpoint.companyId ||
      interaction.issueId !== conversation.issueId
    ) {
      return deny(safelyKnown);
    }
    if (interaction.status !== "pending") {
      if (correction) return deny(safelyKnown);
      const completedAction = await db
        .select()
        .from(chatActions)
        .where(
          and(
            eq(chatActions.companyId, record.endpoint.companyId),
            eq(chatActions.endpointId, record.endpoint.id),
            eq(chatActions.conversationId, conversation.id),
            eq(chatActions.providerActionId, event.event.actionId),
            eq(chatActions.principalId, principal.principal.id),
            eq(chatActions.status, "processed"),
          ),
        )
        .then((rows) => rows[0] ?? null);
      const completedPayload = completedAction?.payload;
      const completedResult = completedAction?.result;
      const completedResultMatches =
        completedResult?.interactionId === interaction.id &&
        completedResult?.interactionStatus === interaction.status &&
        (interaction.kind !== "request_confirmation" ||
          completedResult.code ===
            "confirmation_resolution_committed_by_provider");
      if (
        completedAction &&
        completedResultMatches &&
        completedPayload?.publicationId === issued.publication.id &&
        completedPayload?.interactionId === interaction.id &&
        completedPayload?.messageId === event.event.messageId &&
        completedPayload?.actionId === event.event.actionId
      ) {
        await recordCurrentMicrosoftTeamsRoute(
          record.endpoint,
          runtimeContext,
          event.event.threadId,
          event.event.raw,
        );
        return;
      }
      return deny(safelyKnown);
    }
    if (interaction.kind === "request_confirmation" || event.provider === "slack" && (interaction.kind === "request_checkbox_confirmation" || interaction.kind === "suggest_tasks" || interaction.kind === "connection_intent")) {
      return handleChatConfirmation({ record, event, runtimeContext, conversation, principal: { ...principal, userId: principal.userId }, issued, interaction, deny, safelyKnown });
    }
    const formInteraction = chatInteractionForm(interaction, event.provider);
    if (!formInteraction) return deny(safelyKnown);
    if (isChatQuestionFormOpenActionId(sourceActionId)) {
      if (
        event.provider !== "slack" &&
        event.provider !== "microsoft-teams" &&
        !(
          event.provider === "discord" &&
          event.transport === "discord_gateway" &&
          record.endpoint.capabilities.modals === true
        )
      ) {
        return deny(safelyKnown);
      }
      await options.questionFormOpenAuthorizationBarrier?.();
      let providerAttempted = false;
      let attemptActionId: string | null = null;
      try {
        const attemptProviderActionId = event.event.triggerId
          ? `question_form_open_attempt:${createHash("sha256")
              .update(
                JSON.stringify([
                  record.endpoint.id,
                  event.provider,
                  event.event.triggerId,
                ]),
              )
              .digest("hex")}`
          : null;
        const preflight = await db.transaction(async (tx) => {
          await requireCurrentExternalActionAuthorization(tx, {
            conversationId: conversation.id,
            endpointId: record.endpoint.id,
            expectedUserId: principal.userId!,
            principalId: principal.principal.id,
            runtimeContext,
          });
          const resolved = await resolveChatQuestionFormOpen(tx, {
            companyId: record.endpoint.companyId,
            endpointId: record.endpoint.id,
            conversationId: conversation.id,
            interaction: formInteraction,
            openActionId: sourceActionId,
          });
          if (!resolved || resolved.publicationId !== issued.publication.id) {
            return { kind: "denied" as const };
          }
          if (!attemptProviderActionId) {
            return {
              kind: "ready" as const,
              attemptActionId: null,
              resolved,
            };
          }
          const [attempt] = await tx
            .insert(chatActions)
            .values({
              companyId: record.endpoint.companyId,
              endpointId: record.endpoint.id,
              conversationId: conversation.id,
              principalId: principal.principal.id,
              kind: "question_form_open_attempt",
              providerActionId: attemptProviderActionId,
              payload: { version: 1 },
              status: "processing",
            })
            .onConflictDoNothing()
            .returning({ id: chatActions.id });
          return attempt
            ? {
                kind: "ready" as const,
                attemptActionId: attempt.id,
                resolved,
              }
            : { kind: "duplicate" as const };
        });
        if (preflight.kind === "denied") return deny(safelyKnown);
        if (preflight.kind === "duplicate") {
          if (event.provider === "discord") {
            // A prior attempt may have consumed Discord's single response.
            // A fresh handler has no showModal closure state for that attempt;
            // do not turn its processing/failed receipt into a success ACK.
            throw Object.assign(
              new Error("Discord modal response was already attempted"),
              { code: "chat_discord_gateway_modal_response_indeterminate" },
            );
          }
          await recordCurrentMicrosoftTeamsRoute(
            record.endpoint,
            runtimeContext,
            event.event.threadId,
            event.event.raw,
          );
          return;
        }
        attemptActionId = preflight.attemptActionId;

        await recordCurrentMicrosoftTeamsRoute(
          record.endpoint,
          runtimeContext,
          event.event.threadId,
          event.event.raw,
        );

        // A provider modal open can take seconds and can outlive Slack's
        // trigger. The final Paperclip authorization snapshot above commits
        // before transport starts so provider latency never holds endpoint,
        // destination, identity-link, or membership row locks.
        const modal = correction
          ? discordQuestionFormCorrectionModal(
              preflight.resolved.modal,
              correction,
            )
          : preflight.resolved.modal;
        if (!modal) return deny(safelyKnown);
        providerAttempted = true;
        const opened = await event.event.openModal(modal);
        if (!opened) {
          await recordModalOpenFailure(
            record.endpoint,
            event,
            runtimeContext,
            { ...safelyKnown, attemptActionId, resource },
            new Error("Provider did not confirm the modal open"),
          );
          if (event.provider === "discord") return deny(safelyKnown);
          return;
        }
        if (attemptActionId) {
          const [settledAttempt] = await db
            .update(chatActions)
            .set({
              status: "processed",
              result: { code: "question_form_opened" },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, attemptActionId),
                eq(chatActions.status, "processing"),
              ),
            )
            .returning({ id: chatActions.id });
          if (!settledAttempt) {
            throw new Error(
              "Question-form modal ownership changed after provider acceptance",
            );
          }
        }
      } catch (error) {
        if (isExternalActionAuthorizationChange(error)) {
          return deny(safelyKnown);
        }
        if (!providerAttempted) throw error;
        await recordModalOpenFailure(
          record.endpoint,
          event,
          runtimeContext,
          { ...safelyKnown, attemptActionId, resource },
          error,
        );
        if (event.provider === "discord") return deny(safelyKnown);
        // The provider attempt is now a durable, non-replayable Activity row.
        // Acknowledge the callback so Chat SDK does not turn a definite denial
        // or an ambiguous modal open into a duplicate retry loop.
        return;
      }
      return;
    }

    const action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, record.endpoint.companyId),
          eq(chatActions.endpointId, record.endpoint.id),
          eq(chatActions.conversationId, conversation.id),
          eq(chatActions.kind, "question_answer"),
          eq(chatActions.providerActionId, event.event.actionId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!action || action.status !== "issued") return deny(safelyKnown);
    const tokenPayload = action.payload;
    const tokenExpiresAt =
      typeof tokenPayload.expiresAt === "string"
        ? Date.parse(tokenPayload.expiresAt)
        : Number.NaN;
    if (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= Date.now()) {
      await db
        .update(chatActions)
        .set({
          status: "expired",
          result: { code: "question_action_token_expired" },
          updatedAt: new Date(),
        })
        .where(
          and(eq(chatActions.id, action.id), eq(chatActions.status, "issued")),
        );
      return deny(safelyKnown);
    }
    if (
      tokenPayload.version !== 1 ||
      tokenPayload.publicationId !== issued.publication.id ||
      tokenPayload.interactionId !== payload.interactionId ||
      typeof tokenPayload.questionId !== "string" ||
      (typeof tokenPayload.optionId !== "string" && !Array.isArray(tokenPayload.selectionOptions))
    ) {
      return deny(safelyKnown);
    }

    if (interaction.kind !== "ask_user_questions") return deny(safelyKnown);
    const multiple = event.provider === "slack" && Array.isArray(tokenPayload.selectionOptions);
    const question = multiple ? nativeChatMultiQuestion(interaction) : nativeChatQuestion(interaction, event.provider === "slack" ? 100 : undefined) ?? (event.provider === "slack" ? nativeChatCustomQuestion(interaction) : null);
    if (!question || question.id !== tokenPayload.questionId) return deny(safelyKnown);
    const selected = multiple ? event.selectionValues : undefined;
    if (multiple && (!selected || new Set(selected).size !== selected.length)) return deny(safelyKnown);
    const optionIds = multiple ? selected!.map(value => {
      const mapping = (tokenPayload.selectionOptions as Array<{ value?: unknown; optionId?: unknown }>).find(item => item.value === value);
      return typeof mapping?.optionId === "string" ? mapping.optionId : null;
    }) : [tokenPayload.optionId as string];
    const selectedOptions = optionIds.map(id => question.options.find(option => option.id === id));
    if (selectedOptions.some(option => !option)) return deny(safelyKnown);
    if (multiple && !optionIds.length && question.required !== false) {
      await event.event.thread?.postEphemeral(event.event.user, { markdown: "Choose at least one option, then select Submit answer." }, { fallbackToDM: false });
      return;
    }
    const answerLabel = selectedOptions.map(option => option!.label).join("; ") || "No options selected";

    await options.questionResolutionPersistBarrier?.();

    const issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, record.endpoint.companyId),
          eq(issues.id, conversation.issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!issue) return deny(safelyKnown);
    try {
      const answered = await issueThreadInteractionService(db).answerQuestions(
        issue,
        interaction.id,
        {
          answers: [{ questionId: question.id, optionIds: optionIds as string[] }],
        },
        { userId: principal.userId },
        {
          beforeResolveInTransaction: async (tx: DbTransaction) => {
            await requireCurrentExternalActionAuthorization(tx, {
              conversationId: conversation.id,
              endpointId: record.endpoint.id,
              expectedUserId: principal.userId!,
              principalId: principal.principal.id,
              runtimeContext,
            });
          },
          afterResolveInTransaction: async (tx: DbTransaction, resolved: IssueThreadInteraction) => {
            const [completed] = await tx
              .update(chatActions)
              .set({
                principalId: principal.principal.id,
                status: "processed",
                payload: {
                  ...tokenPayload,
                  messageId: event.event.messageId,
                  actionId: event.event.actionId,
                  value: event.event.value ?? null,
                  ...(multiple ? { selectionValues: selected } : {}),
                },
                result: {
                  interactionId: resolved.id,
                  interactionStatus: resolved.status,
                },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.id, action.id),
                  eq(chatActions.status, "issued"),
                ),
              )
              .returning({ id: chatActions.id });
            if (!completed) {
              throw new Error(
                "External question action ownership changed before commit",
              );
            }
            await tx
              .update(chatActions)
              .set({
                status: "expired",
                result: { code: "interaction_resolved_by_sibling_action" },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.companyId, issue.companyId),
                  eq(chatActions.endpointId, record.endpoint.id),
                  eq(chatActions.conversationId, conversation.id),
                  eq(chatActions.kind, "question_answer"),
                  eq(chatActions.status, "issued"),
                  ne(chatActions.id, action.id),
                  eq(
                    sql<string>`${chatActions.payload}->>'interactionId'`,
                    resolved.id,
                  ),
                ),
              );
            await logActivity(tx as unknown as Db, {
              companyId: issue.companyId,
              actorType: "user",
              actorId: principal.userId!,
              action: "issue.thread_interaction_answered",
              entityType: "issue",
              entityId: issue.id,
              details: {
                source: "external_chat",
                endpointId: record.endpoint.id,
                provider: record.endpoint.provider,
                conversationId: conversation.id,
                publicationId: issued.publication.id,
                providerMessageId: event.event.messageId,
                interactionId: resolved.id,
                interactionKind: resolved.kind,
                interactionStatus: resolved.status,
                resolutionActorKind: "user",
                answeredQuestionCount: 1,
              },
            });
            await notifyChatPublicationWork(tx);
            await tx
              .insert(chatPublications)
              .values({
                companyId: issue.companyId,
                endpointId: record.endpoint.id,
                conversationId: conversation.id,
                issueId: issue.id,
                idempotencyKey: `interaction-resolution:${resolved.id}:${record.endpoint.id}`,
                payload: projectSafeChatPublication({
                  classification: "external",
                  source: "issue_interaction",
                  text: `Answered: ${answerLabel}.`,
                  interaction: {
                    id: resolved.id,
                    card: {
                      kind: "question",
                      title: question.prompt,
                      body: `Answered: ${answerLabel}.`,
                      actions: [],
                    },
                  },
                }),
                state: "pending",
              })
              .onConflictDoNothing();
          },
        },
      );
      scheduleMessageProcessing(async () => {
        await processPendingPublications();
      });
      // The interaction, provider token, and response-delivery receipt are
      // already durable. A provider callback must not wait for agent startup;
      // drain the outbox after acknowledging the provider callback.
      scheduleMessageProcessing(async () => {
        await questionResponses.deliver(answered.id);
      });
    } catch (error) {
      if (isExternalActionAuthorizationChange(error)) {
        return deny(safelyKnown);
      }
      // `answerQuestions` commits the interaction and this action in one
      // transaction, then performs a best-effort issue timestamp touch. If
      // that post-commit touch fails, the provider callback is nevertheless
      // durably complete. Do not corrupt the processed token to `failed` or
      // return a retryable webhook response that turns Telegram's redelivery
      // into a misleading stale-action notice.
      try {
        const raceResult = await db.transaction(async (tx) => {
          const currentAction = await tx
            .select({ status: chatActions.status })
            .from(chatActions)
            .where(eq(chatActions.id, action.id))
            .then((rows) => rows[0] ?? null);
          const currentInteraction = (
            await issueThreadInteractionService(
              tx as unknown as Db,
            ).listForIssue(issue.id)
          ).find((candidate) => candidate.id === interaction.id);
          if (currentInteraction && currentInteraction.status !== "pending") {
            await tx
              .update(chatActions)
              .set({
                status: "expired",
                result: { code: "interaction_resolved_elsewhere" },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.id, action.id),
                  inArray(chatActions.status, ["issued", "processing"]),
                ),
              );
            await enqueueTerminalIssueInteractionChatPublications(
              tx,
              currentInteraction,
            );
            return { actionStatus: currentAction?.status, settledRace: true };
          }
          return { actionStatus: currentAction?.status, settledRace: false };
        });
        if (raceResult.actionStatus === "processed") {
          logger.warn(
            {
              endpointId: record.endpoint.id,
              interactionId: interaction.id,
              error: redactError(error),
            },
            "external chat question resolved but post-commit follow-up failed",
          );
          return;
        }
        if (raceResult.settledRace) {
          scheduleMessageProcessing(async () => {
            await processPendingPublications();
          });
          return;
        }
      } catch (recoveryError) {
        logger.warn(
          {
            endpointId: record.endpoint.id,
            interactionId: interaction.id,
            error: redactError(recoveryError),
          },
          "could not reconcile an external chat question after resolution failed",
        );
      }
      throw error;
    }
    await recordCurrentMicrosoftTeamsRoute(
      record.endpoint,
      runtimeContext,
      event.event.threadId,
      event.event.raw,
    );
  }

  async function handleModalSubmit(
    event: ChatSdkCallbackEvent<ModalSubmitEvent>,
    runtimeContext: RuntimeContext,
  ): Promise<ModalResponse> {
    const denialError = () =>
      forbidden("This chat form is not a current Paperclip question");
    const record = await runtimeCallbackRecord(
      event.endpointId,
      runtimeContext,
      ["active"],
    );
    if (
      !record ||
      record.endpoint.status !== "active" ||
      record.endpoint.provider !== event.provider ||
      record.endpoint.capabilities.modals !== true ||
      (event.provider !== "slack" &&
        event.provider !== "microsoft-teams" &&
        !(
          event.provider === "discord" && event.transport === "discord_gateway"
        ))
    ) {
      const staleRecord =
        record ??
        (await endpointRecord(event.endpointId).then((candidate) =>
          candidate?.endpoint.provider === event.provider ? candidate : null,
        ));
      if (staleRecord) {
        await recordModalSubmitDenial(staleRecord.endpoint, event, {
          code: "chat_modal_runtime_not_current",
        });
      }
      return event.provider === "discord"
        ? discordQuestionFormDenialResponse()
        : chatQuestionFormDenialResponse();
    }
    const deny = async (
      code: string,
      safelyKnown: {
        conversationId?: string | null;
        principalId?: string | null;
      } = {},
      payload?: Parameters<typeof chatQuestionFormDenialResponse>[0],
    ): Promise<ModalResponse> => {
      await recordModalSubmitDenial(record.endpoint, event, {
        code,
        ...safelyKnown,
      });
      return event.provider === "discord"
        ? discordQuestionFormDenialResponse()
        : chatQuestionFormDenialResponse(payload);
    };
    const loaded = await loadChatQuestionFormSubmissionToken(db, {
      callbackId: event.event.callbackId,
      companyId: record.endpoint.companyId,
      endpointId: record.endpoint.id,
      includeProcessed: true,
    });
    if (!loaded) return deny("chat_modal_token_not_current");
    const conversation = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, record.endpoint.companyId),
          eq(chatConversations.endpointId, record.endpoint.id),
          eq(chatConversations.id, loaded.conversationId),
          inArray(chatConversations.state, ["active", "waiting"]),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (
      !conversation ||
      (event.provider === "discord" &&
        discordQuestionFormThreadId(event.event.raw) !==
          conversation.externalThreadId) ||
      (event.event.relatedThread &&
        (event.provider === "microsoft-teams"
          ? !sameTeamsThreadIdentity(
              event.event.relatedThread.id,
              conversation.externalThreadId,
            )
          : event.event.relatedThread.id !== conversation.externalThreadId))
    ) {
      return deny(
        "chat_modal_conversation_not_current",
        {
          conversationId: conversation?.id ?? null,
        },
        loaded.payload,
      );
    }
    const principal = await ensurePrincipal(
      record.endpoint,
      event.event.user,
      event.event.raw,
    );
    if (
      principal.linkedDenied ||
      !principal.userId ||
      principal.principal.kind !== "user" ||
      principal.principal.isBot
    ) {
      return deny(
        "chat_modal_principal_not_authorized",
        {
          conversationId: conversation.id,
          principalId: principal.principal.id,
        },
        loaded.payload,
      );
    }
    const resource = conversation.resourceId
      ? await db
          .select()
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.companyId, record.endpoint.companyId),
              eq(chatEndpointResources.endpointId, record.endpoint.id),
              eq(chatEndpointResources.id, conversation.resourceId),
            ),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const resourceAllowed = conversation.isDirectMessage
      ? record.endpoint.allowDirectMessages
      : nonDirectDestinationAllowed(record.endpoint, resource);
    if (!resourceAllowed) {
      return deny(
        "chat_modal_destination_not_authorized",
        {
          conversationId: conversation.id,
          principalId: principal.principal.id,
        },
        loaded.payload,
      );
    }

    const originalPublication = await db
      .select()
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, record.endpoint.companyId),
          eq(chatPublications.endpointId, record.endpoint.id),
          eq(chatPublications.conversationId, conversation.id),
          eq(chatPublications.issueId, conversation.issueId),
          eq(chatPublications.id, loaded.publicationId),
          eq(chatPublications.state, "published"),
          event.provider !== "discord" && event.event.relatedMessage
            ? eq(
                chatPublications.providerMessageId,
                event.event.relatedMessage.id,
              )
            : undefined,
        ),
      )
      .then((rows) => rows[0] ?? null);
    const providerMessageId =
      (event.provider === "discord"
        ? undefined
        : event.event.relatedMessage?.id) ??
      originalPublication?.providerMessageId ??
      null;
    if (!originalPublication || !providerMessageId) {
      return deny(
        "chat_modal_publication_not_current",
        {
          conversationId: conversation.id,
          principalId: principal.principal.id,
        },
        loaded.payload,
      );
    }
    const currentMessageBinding = await db
      .select({
        link: chatMessageLinks,
        publication: chatPublications,
      })
      .from(chatMessageLinks)
      .innerJoin(
        chatPublications,
        and(
          eq(chatPublications.companyId, chatMessageLinks.companyId),
          eq(chatPublications.endpointId, chatMessageLinks.endpointId),
          eq(chatPublications.conversationId, chatMessageLinks.conversationId),
          eq(chatPublications.id, chatMessageLinks.publicationId),
        ),
      )
      .where(
        and(
          eq(chatMessageLinks.companyId, record.endpoint.companyId),
          eq(chatMessageLinks.endpointId, record.endpoint.id),
          eq(chatMessageLinks.conversationId, conversation.id),
          eq(chatMessageLinks.providerMessageId, providerMessageId),
          eq(chatMessageLinks.direction, "outbound"),
          eq(chatPublications.issueId, conversation.issueId),
          eq(chatPublications.state, "published"),
          eq(chatPublications.providerMessageId, providerMessageId),
        ),
      )
      .then((rows) => (rows.length === 1 ? rows[0]! : null));
    const linkedPayload = currentMessageBinding?.publication.payload as
      | SafeChatPublicationPayload
      | undefined;
    const linkStillAuthoritative =
      currentMessageBinding?.link.publicationId === originalPublication.id ||
      (currentMessageBinding?.publication.idempotencyKey ===
        `interaction-resolution:${loaded.interactionId}:${record.endpoint.id}` &&
        linkedPayload?.interactionId === loaded.interactionId);
    if (!currentMessageBinding || !linkStillAuthoritative) {
      return deny(
        "chat_modal_message_binding_not_current",
        {
          conversationId: conversation.id,
          principalId: principal.principal.id,
        },
        loaded.payload,
      );
    }
    const issued = {
      publication: originalPublication,
      link: currentMessageBinding.link,
    };
    const payload = issued.publication.payload as SafeChatPublicationPayload;
    if (payload.interactionId !== loaded.interactionId) {
      return deny(
        "chat_modal_interaction_binding_not_current",
        {
          conversationId: conversation.id,
          principalId: principal.principal.id,
        },
        loaded.payload,
      );
    }
    const interaction = (
      await issueThreadInteractionService(db).listForIssue(conversation.issueId)
    ).find((candidate) => candidate.id === loaded.interactionId);
    const formInteraction = interaction ? chatInteractionForm(interaction, event.provider) : null;
    const discordReplayAnswersMatch = (
      resolved: typeof interaction,
    ): boolean => {
      if (event.provider !== "discord") return true;
      if (
        resolved?.kind !== "ask_user_questions" ||
        resolved.status !== "answered"
      )
        return false;
      // Parse only for comparison after current token/source/actor checks.
      // This local pending projection cannot reopen or resolve an interaction.
      const submitted = validateChatQuestionFormSubmission({
        callbackId: event.event.callbackId,
        privateMetadata: event.event.privateMetadata,
        interaction: { ...resolved, status: "pending" },
        payload: loaded.payload,
        values: event.event.values,
      });
      return (
        submitted.ok &&
        JSON.stringify(submitted.answers) ===
          JSON.stringify(resolved.result?.answers)
      );
    };
    const isExactProcessedReplay = (
      current: Awaited<ReturnType<typeof loadChatQuestionFormSubmissionToken>>,
    ) =>
      interaction?.companyId === record.endpoint.companyId &&
      interaction.issueId === conversation.issueId &&
      (interaction.kind === "ask_user_questions" || event.provider === "slack" && interaction.kind === "request_item_verdicts") &&
      interaction.status === "answered" &&
      interaction.resolvedByUserId === principal.userId &&
      current?.status === "processed" &&
      current.actionRowId === loaded.actionRowId &&
      current.conversationId === conversation.id &&
      current.publicationId === originalPublication.id &&
      current.interactionId === loaded.interactionId &&
      current.principalId === principal.principal.id &&
      current.result?.code === "question_form_answered" &&
      current.result?.interactionId === loaded.interactionId &&
      discordReplayAnswersMatch(interaction);
    const acceptedResponse = async (): Promise<ModalResponse> => {
      if (event.provider === "discord") {
        return acceptDiscordQuestionForm({ record, event, principal: { ...principal, userId: principal.userId! }, loaded });
      }
      return { action: "clear" };
    };
    if (loaded.status === "processed") {
      if (!isExactProcessedReplay(loaded)) {
        return deny(
          "chat_modal_replay_not_authorized",
          {
            conversationId: conversation.id,
            principalId: principal.principal.id,
          },
          loaded.payload,
        );
      }
      if (event.event.relatedThread) {
        await recordCurrentMicrosoftTeamsRoute(
          record.endpoint,
          runtimeContext,
          event.event.relatedThread.id,
          event.event.raw,
        );
      }
      return acceptedResponse();
    }
    if (
      !interaction ||
      interaction.companyId !== record.endpoint.companyId ||
      interaction.issueId !== conversation.issueId ||
      !formInteraction ||
      interaction.status !== "pending"
    ) {
      // Another callback can commit the same token between the initial token
      // read and this interaction read. Only its exact processed receipt may
      // acknowledge the stale snapshot; an answer by another token or actor
      // does not authorize this form. Recheck current policy under its locks.
      let processedReplay = false;
      if (
        interaction?.companyId === record.endpoint.companyId &&
        interaction.issueId === conversation.issueId &&
        (interaction.kind === "ask_user_questions" || event.provider === "slack" && interaction.kind === "request_item_verdicts") &&
        interaction.status === "answered"
      ) {
        try {
          processedReplay = await db.transaction(async (tx) => {
            await requireCurrentExternalActionAuthorization(tx, {
              conversationId: conversation.id,
              endpointId: record.endpoint.id,
              expectedUserId: principal.userId!,
              principalId: principal.principal.id,
              runtimeContext,
            });
            return isExactProcessedReplay(
              await loadChatQuestionFormSubmissionToken(tx, {
                callbackId: event.event.callbackId,
                companyId: record.endpoint.companyId,
                endpointId: record.endpoint.id,
                includeProcessed: true,
              }),
            );
          });
        } catch (error) {
          if (!isExternalActionAuthorizationChange(error)) throw error;
        }
      }
      if (processedReplay) {
        if (event.event.relatedThread) {
          await recordCurrentMicrosoftTeamsRoute(
            record.endpoint,
            runtimeContext,
            event.event.relatedThread.id,
            event.event.raw,
          );
        }
        return acceptedResponse();
      }
      return deny(
        "chat_modal_interaction_not_pending",
        {
          conversationId: conversation.id,
          principalId: principal.principal.id,
        },
        loaded.payload,
      );
    }
    const validation = validateChatQuestionFormSubmission({
      callbackId: event.event.callbackId,
      privateMetadata: event.event.privateMetadata,
      interaction: formInteraction,
      payload: loaded.payload,
      values: event.event.values,
    });
    if (!validation.ok) {
      if (validation.code === "invalid_form") {
        if (event.provider === "discord") {
          return handleDiscordFormCorrection({ record, event, runtimeContext, conversation, principal: { ...principal, userId: principal.userId }, loaded, originalPublication, providerMessageId, interaction: formInteraction, payload, validation, deny });
        }
        return chatQuestionFormValidationResponse({
          provider: event.provider,
          callbackId: event.event.callbackId,
          privateMetadata: event.event.privateMetadata,
          interaction: formInteraction,
          payload: loaded.payload,
          values: event.event.values,
        });
      }
      return deny(
        `chat_modal_${validation.code}`,
        {
          conversationId: conversation.id,
          principalId: principal.principal.id,
        },
        loaded.payload,
      );
    }
    const issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, record.endpoint.companyId),
          eq(issues.id, conversation.issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!issue) {
      return deny(
        "chat_modal_issue_not_current",
        {
          conversationId: conversation.id,
          principalId: principal.principal.id,
        },
        loaded.payload,
      );
    }
    await options.questionResolutionPersistBarrier?.();
    const itemVerdicts = chatItemVerdicts(interaction, validation.answers, loaded.payload);
    if (itemVerdicts && Object.keys(itemVerdicts.errors).length) return { action: "errors", errors: itemVerdicts.errors };
    let answered: IssueThreadInteraction;
    try {
      const mutationOptions = {
          beforeResolveInTransaction: async (tx: DbTransaction) => {
            await requireCurrentExternalActionAuthorization(tx, {
              conversationId: conversation.id,
              endpointId: event.endpointId,
              expectedUserId: principal.userId!,
              principalId: principal.principal.id,
              runtimeContext,
            });
          },
          afterResolveInTransaction: async (tx: DbTransaction, resolved: IssueThreadInteraction) => {
            const claimed = await claimChatQuestionFormSubmission(tx, {
              actionRowId: loaded.actionRowId,
              principalId: principal.principal.id,
            });
            if (!claimed) throw denialError();
            const completed = await completeChatQuestionFormSubmission(tx, {
              actionRowId: loaded.actionRowId,
              interactionId: resolved.id,
            });
            if (!completed) throw denialError();
            await tx
              .update(chatActions)
              .set({
                status: "expired",
                result: { code: "question_form_submitted" },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.companyId, issue.companyId),
                  eq(chatActions.endpointId, record.endpoint.id),
                  eq(chatActions.conversationId, conversation.id),
                  eq(chatActions.kind, "question_form_open"),
                  eq(chatActions.status, "issued"),
                  eq(
                    sql<string>`${chatActions.payload}->>'interactionId'`,
                    resolved.id,
                  ),
                ),
              );
            await logActivity(tx as unknown as Db, {
              companyId: issue.companyId,
              actorType: "user",
              actorId: principal.userId!,
              action: "issue.thread_interaction_answered",
              entityType: "issue",
              entityId: issue.id,
              details: {
                source: "external_chat_modal",
                endpointId: record.endpoint.id,
                provider: record.endpoint.provider,
                conversationId: conversation.id,
                publicationId: issued.publication.id,
                interactionId: resolved.id,
                interactionKind: resolved.kind,
                interactionStatus: resolved.status,
                resolutionActorKind: "user",
                answeredQuestionCount: validation.answers.length,
              },
            });
          },
      };
      answered = itemVerdicts
        ? (await issueThreadInteractionService(db).submitItemVerdicts(issue, interaction.id, { verdicts: itemVerdicts.verdicts }, { userId: principal.userId }, mutationOptions)).interaction
        : await issueThreadInteractionService(db).answerQuestions(issue, interaction.id, { answers: validation.answers }, { userId: principal.userId }, mutationOptions);
    } catch (error) {
      if (isExternalActionAuthorizationChange(error)) {
        await db.transaction(async (tx) => {
          await tx
            .update(chatActions)
            .set({
              status: "expired",
              result: { code: "chat_action_authorization_changed" },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, loaded.actionRowId),
                eq(chatActions.status, "issued"),
              ),
            );
          await recordModalSubmitDenial(
            record.endpoint,
            event,
            {
              code: "chat_action_authorization_changed",
              conversationId: conversation.id,
              principalId: principal.principal.id,
            },
            tx,
          );
        });
        return event.provider === "discord"
          ? discordQuestionFormDenialResponse()
          : chatQuestionFormDenialResponse(loaded.payload);
      }
      const settledRace = await db.transaction(async (tx) => {
        const currentInteraction = (
          await issueThreadInteractionService(tx as unknown as Db).listForIssue(
            issue.id,
          )
        ).find((candidate) => candidate.id === interaction.id);
        if (!currentInteraction || currentInteraction.status === "pending") {
          return false;
        }
        await enqueueTerminalIssueInteractionChatPublications(
          tx,
          currentInteraction,
        );
        return true;
      });
      if (!settledRace) {
        const status =
          error && typeof error === "object"
            ? (error as { status?: unknown }).status
            : null;
        if (event.provider === "slack") {
          const response = slackQuestionFormValidationError(error, loaded.payload.fields);
          if (response) return response;
        }
        if (status === 403) {
          return deny(
            "chat_modal_resolution_not_authorized",
            {
              conversationId: conversation.id,
              principalId: principal.principal.id,
            },
            loaded.payload,
          );
        }
        throw error;
      }
      scheduleMessageProcessing(async () => {
        await processPendingPublications();
      });
      if (event.provider === "discord") {
        const current = await loadChatQuestionFormSubmissionToken(db, {
          callbackId: event.event.callbackId,
          companyId: record.endpoint.companyId,
          endpointId: record.endpoint.id,
          includeProcessed: true,
        });
        const resolved = (
          await issueThreadInteractionService(db).listForIssue(
            conversation.issueId,
          )
        ).find((candidate) => candidate.id === interaction.id);
        if (
          current?.status !== "processed" ||
          current.actionRowId !== loaded.actionRowId ||
          current.principalId !== principal.principal.id ||
          current.result?.code !== "question_form_answered" ||
          current.result.interactionId !== interaction.id ||
          resolved?.status !== "answered" ||
          resolved.resolvedByUserId !== principal.userId ||
          !discordReplayAnswersMatch(resolved)
        )
          return deny("chat_modal_resolution_committed_elsewhere");
      }
      return acceptedResponse();
    }
    if (event.event.relatedThread) {
      await recordCurrentMicrosoftTeamsRoute(
        record.endpoint,
        runtimeContext,
        event.event.relatedThread.id,
        event.event.raw,
      );
    }
    scheduleMessageProcessing(async () => {
      if (answered.kind === "ask_user_questions") await questionResponses.deliver(answered.id);
      else await processPendingPublications();
    });
    return acceptedResponse();
  }
  return { handleAction, handleModalSubmit, reconcileTerminalConfirmationActions };
}
