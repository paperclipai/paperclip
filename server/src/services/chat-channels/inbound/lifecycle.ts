import type { EndpointRow, DbTransaction, DbOrTransaction, RuntimeContext, LifecycleRuntimeFence, InboundRuntimeContext } from "../runtime-types.js";

import {
  MAX_INBOUND_TEXT,
  type LifecycleActor,
  lifecycleActorFromAuthor,
} from "../message-lifecycle.js";
import {
  telegramMessageSequence,
} from "../telegram/messages.js";
import {
  slackLifecycleFilesDigest,
} from "../slack/messages.js";
import {
  discordLifecycleFilesDigest,
} from "../discord/messages.js";

import { notifyChatDeliveryWork } from "../../chat-work-notifications.js";

import {
  createHash,
} from "node:crypto";
import {
  and,
  desc,
  eq,
  inArray,
  lte,
  ne,
  sql,
} from "drizzle-orm";

import {
  externalThreadIdentityCondition,
  teamsConversationId,
} from "../../chat-control-chronology.js";

import type { Db } from "@paperclipai/db";

import {
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatMessageLinks,
} from "@paperclipai/db";
import type {
  ChatProvider,
} from "@paperclipai/shared";

import { normalizeTelegramRichMessage } from "../../chat-telegram-rich-intake.js";

import {
  notFound,
} from "../../../errors.js";

import {
  type ChatSdkCallbackEvent,
  type ChatSdkMessageUpdatedCallbackEvent,
} from "../../chat-sdk-runtime.js";

import { issueService } from "../../issues.js";

import type {
  MessageDeletedEvent,
} from "chat";
import { normalizedDeliveryThreadId, lifecycleRuntimeFence } from "./delivery-ledger.js";
type DeliveryRow = typeof chatDeliveries.$inferSelect;
type MessageLifecycleOptions = {
  DELIVERY_PROCESSING_STALE_MS: number;
  ORPHAN_FOLLOW_UP_GRACE_MS: number;
  ORPHAN_FOLLOW_UP_MAX_ATTEMPTS: number;
  INGRESS_REORDER_WINDOW_MS: Partial<Record<ChatProvider, number>>;
  issuesSvc: ReturnType<typeof issueService>;
  lockCurrentPrincipalAuthorization: (tx: DbOrTransaction, endpoint: EndpointRow, principalId: string) => Promise<{ allowed: boolean; linkedDenied: boolean; userId?: string | null }>;
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: typeof chatEndpointResources.$inferSelect | null | undefined) => boolean;
  redactError: (error: unknown) => string;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  sameTeamsThreadIdentity: (left: string, right: string) => boolean;
  durableExternalThreadIdentity: (threadId: string) => string;
  recordCurrentMicrosoftTeamsRoute: (endpoint: EndpointRow, context: InboundRuntimeContext | undefined, threadId: string, raw: unknown, recordAcceptedActivity?: boolean) => Promise<void>;
  conversationDrainKey: (endpointId: string, threadId: string) => string;
  scheduleConversationDrain: (endpointId: string, threadId: string, scheduledAt?: number) => void;
  scheduledConversationDrains: Map<string, number>;
  drainConversationDeliveries: (endpointId: string, threadId: string) => Promise<boolean>;
  ensureDiscordGatewayRuntimeIsCurrent: (endpointId: string, context: RuntimeContext) => Promise<boolean>;
  deferWebhookProcessing?: boolean;
};
export function createChatMessageLifecycle(db: Db, options: MessageLifecycleOptions) {
  const { DELIVERY_PROCESSING_STALE_MS, ORPHAN_FOLLOW_UP_GRACE_MS, ORPHAN_FOLLOW_UP_MAX_ATTEMPTS, INGRESS_REORDER_WINDOW_MS, issuesSvc, lockCurrentPrincipalAuthorization, nonDirectDestinationAllowed, redactError, runtimeCallbackEndpoint, sameTeamsThreadIdentity, durableExternalThreadIdentity, recordCurrentMicrosoftTeamsRoute, conversationDrainKey, scheduleConversationDrain, scheduledConversationDrains, drainConversationDeliveries, ensureDiscordGatewayRuntimeIsCurrent } = options;


  async function conversationForThread(endpointId: string, threadId: string) {
    const exact = await db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.endpointId, endpointId),
          eq(chatConversations.externalThreadId, threadId),
        ),
      )
      .orderBy(desc(chatConversations.sessionGeneration))
      .then((rows) => rows[0] ?? null);
    if (exact || !threadId.startsWith("teams:")) return exact;

    // Before Paperclip made Teams route state independent, the adapter
    // embedded the mutable Bot Connector serviceUrl in every thread id. Read
    // those rows by the immutable conversation id so a regional route change
    // continues the same task. New rows use the canonical route-free id.
    if (!teamsConversationId(threadId)) return null;
    return db
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.endpointId, endpointId),
          externalThreadIdentityCondition(
            sql<string>`${chatConversations.externalThreadId}`,
            threadId,
          ),
        ),
      )
      .orderBy(desc(chatConversations.sessionGeneration))
      .then(
        (rows) =>
          rows.find((row) =>
            sameTeamsThreadIdentity(row.externalThreadId, threadId),
          ) ?? null,
      );
  }

  async function recordLifecycleDelivery(
    input: {
      actor?: LifecycleActor;
      isBotMessage?: true;
      endpointId: string;
      threadId: string;
      messageId: string;
      eventKind: "message_updated" | "message_deleted" | "message_restored";
      text: string;
      providerEventId?: string;
      providerMessageSequence?: number | null;
      providerSentAt?: string | null;
      providerUpdateId?: number | null;
      raw?: unknown;
      revision?: string | null;
      admissionDependencyEventId?: string;
    },
    runtimeContext?: RuntimeContext,
    githubSourceMapped = false,
  ) {
    if (!githubSourceMapped && input.threadId.startsWith("github:") && /^[1-9][0-9]*$/.test(input.messageId)) {
      const requests = await db.select({ id: chatDeliveries.id, messageId: sql<string>`${chatDeliveries.normalizedEvent}->'message'->>'providerMessageId'` })
        .from(chatDeliveries).innerJoin(chatEndpoints, and(eq(chatEndpoints.id, chatDeliveries.endpointId), eq(chatEndpoints.companyId, chatDeliveries.companyId)))
        .where(and(eq(chatDeliveries.endpointId, input.endpointId), eq(chatEndpoints.provider, "github"),
          inArray(chatDeliveries.eventKind, ["mention", "message", "direct_message"]),
          input.admissionDependencyEventId ? ne(chatDeliveries.providerEventId, input.admissionDependencyEventId) : undefined,
          sql`${chatDeliveries.normalizedEvent}->'message'->>'sourceProviderMessageId' = ${input.messageId}`,
          sql`${chatDeliveries.normalizedEvent}->'conversation'->>'externalThreadId' = ${input.threadId}`));
      if (requests.length) {
        for (const request of requests) await recordLifecycleDelivery({ ...input, messageId: request.messageId,
          providerEventId: `${input.providerEventId ?? `${input.eventKind}:${input.threadId}:${input.messageId}:${input.revision ?? "once"}`}:${request.id}` }, runtimeContext, true);
        return;
      }
    }
    const durableThreadId = durableExternalThreadIdentity(input.threadId);
    const providerEventId =
      input.providerEventId ??
      `${input.eventKind}:${durableThreadId}:${input.messageId}:${input.revision ?? "once"}`;
    const targetProviderEventId = `${durableThreadId}:${input.messageId}`;
    const admission = await db.transaction(async (tx) => {
      const endpoint = await tx
        .select()
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, input.endpointId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!endpoint) throw notFound("Chat endpoint not found");
      if (
        runtimeContext &&
        !(await runtimeCallbackEndpoint(tx, endpoint.id, runtimeContext, [
          "verifying",
          "active",
        ]))
      )
        return null;
      // A provider has already authenticated this callback. During setup the
      // message can belong to the test conversation, so retain its correction.
      // Paused or unhealthy connections acknowledge late callbacks without
      // mutating the bound task or causing provider retry storms.
      if (endpoint.status !== "verifying" && endpoint.status !== "active")
        return null;
      const reorderWindow = INGRESS_REORDER_WINDOW_MS[endpoint.provider];
      const scheduledAt =
        options.deferWebhookProcessing === true && reorderWindow
          ? (scheduledConversationDrains.get(
              conversationDrainKey(input.endpointId, input.threadId),
            ) ?? Date.now() + reorderWindow)
          : null;
      await notifyChatDeliveryWork(tx);
      const [delivery] = await tx
        .insert(chatDeliveries)
        .values({
          companyId: endpoint.companyId,
          endpointId: input.endpointId,
          providerEventId,
          deduplicationKey: createHash("sha256")
            .update(providerEventId)
            .digest("hex"),
          eventKind: input.eventKind,
          normalizedEvent: {
            providerEventId,
            kind: input.eventKind,
            ...(runtimeContext
              ? {
                  runtimeContext: {
                    credentialFingerprint: runtimeContext.credentialFingerprint,
                    generation: runtimeContext.generation,
                  },
                }
              : {}),
            ...(input.actor ? { principal: input.actor } : {}),
            conversation: { externalThreadId: input.threadId },
            message: {
              providerMessageId: input.messageId,
              targetProviderEventId,
              ...(input.admissionDependencyEventId ? { admissionDependencyEventId: input.admissionDependencyEventId } : {}),
              ...(endpoint.provider === "github" && input.isBotMessage === true
                ? { isBotMessage: true }
                : {}),
              providerMessageSequence: input.providerMessageSequence ?? null,
              providerSentAt: input.providerSentAt ?? null,
              providerUpdateId: input.providerUpdateId ?? null,
              text: input.text,
            },
          },
          state: "received",
          nextAttemptAt: scheduledAt ? new Date(scheduledAt) : null,
        })
        .onConflictDoNothing()
        .returning();
      if (delivery) return { delivery, endpoint, scheduledAt };
      const existing = await tx
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, input.endpointId),
            eq(chatDeliveries.providerEventId, providerEventId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      return existing ? { delivery: existing, endpoint, scheduledAt } : null;
    });
    if (admission) {
      // Lifecycle callbacks can carry a new regional Bot Connector route. Keep
      // that provider-authenticated route current even when processing is
      // deferred, but deliberately omit the raw activity here. Lifecycle
      // callbacks never populate the adapter's user cache; the admitted root
      // message already established the principal metadata they must match.
      await recordCurrentMicrosoftTeamsRoute(
        admission.endpoint,
        runtimeContext,
        input.threadId,
        input.raw,
        false,
      );
    }
    if (
      !admission ||
      admission.delivery.state === "processed" ||
      admission.delivery.state === "filtered" ||
      admission.delivery.state === "failed"
    )
      return;
    if (options.deferWebhookProcessing === true) {
      scheduleConversationDrain(
        input.endpointId,
        input.threadId,
        admission.scheduledAt ?? Date.now(),
      );
      return;
    }
    await drainConversationDeliveries(input.endpointId, input.threadId);
  }

  function lifecycleMessageFromDelivery(delivery: DeliveryRow): {
    actor: LifecycleActor | null;
    isBotMessage: boolean;
    messageId: string;
    providerSentAt: string | null;
    targetProviderEventId: string;
    text: string;
    threadId: string;
  } | null {
    if (
      delivery.eventKind !== "message_updated" &&
      delivery.eventKind !== "message_deleted" &&
      delivery.eventKind !== "message_restored"
    )
      return null;
    const normalized = delivery.normalizedEvent as {
      principal?: {
        displayName?: unknown;
        externalId?: unknown;
        handle?: unknown;
      };
      message?: {
        isBotMessage?: unknown;
        providerMessageId?: unknown;
        providerSentAt?: unknown;
        targetProviderEventId?: unknown;
        text?: unknown;
      };
    };
    const messageId = normalized.message?.providerMessageId;
    const targetProviderEventId = normalized.message?.targetProviderEventId;
    const providerSentAt = normalized.message?.providerSentAt;
    const text = normalized.message?.text;
    const threadId = normalizedDeliveryThreadId(delivery);
    const externalId = normalized.principal?.externalId;
    const actor =
      typeof externalId === "string" && externalId
        ? {
            externalId,
            displayName:
              typeof normalized.principal?.displayName === "string"
                ? normalized.principal.displayName
                : externalId,
            handle:
              typeof normalized.principal?.handle === "string"
                ? normalized.principal.handle
                : externalId,
          }
        : null;
    return typeof messageId === "string" &&
      typeof targetProviderEventId === "string" &&
      typeof text === "string" &&
      threadId !== null
      ? {
          actor,
          isBotMessage: normalized.message?.isBotMessage === true,
          messageId,
          providerSentAt:
            typeof providerSentAt === "string" ? providerSentAt : null,
          targetProviderEventId,
          text,
          threadId,
        }
      : null;
  }

  async function processLifecycleDelivery(
    endpoint: EndpointRow,
    candidate: DeliveryRow,
  ): Promise<void> {
    const lifecycle = lifecycleMessageFromDelivery(candidate);
    if (!lifecycle) {
      await db.transaction(async (tx) => {
        await notifyChatDeliveryWork(tx);
        return tx
          .update(chatDeliveries)
          .set({
            state: "failed",
            redactedError: "Normalized lifecycle delivery is incomplete",
            updatedAt: new Date(),
          })
          .where(eq(chatDeliveries.id, candidate.id));
      });
      return;
    }

    const now = new Date();
    const staleBefore = new Date(now.getTime() - DELIVERY_PROCESSING_STALE_MS);
    const claimConditions = [
      eq(chatDeliveries.id, candidate.id),
      eq(chatDeliveries.state, candidate.state),
    ];
    if (candidate.state === "processing")
      claimConditions.push(lte(chatDeliveries.updatedAt, staleBefore));
    const [activeDelivery] = await db.transaction(async (tx) => {
      await notifyChatDeliveryWork(tx);
      return tx
        .update(chatDeliveries)
        .set({
          state: "processing",
          attempts: candidate.attempts + 1,
          nextAttemptAt: null,
          redactedError: null,
          updatedAt: now,
        })
        .where(and(...claimConditions))
        .returning();
    });
    if (!activeDelivery) return;

    try {
      await db.transaction(async (tx) => {
        const admittedRuntimeContext = lifecycleRuntimeFence(activeDelivery);
        const currentEndpoint = admittedRuntimeContext
          ? await runtimeCallbackEndpoint(
              tx,
              endpoint.id,
              admittedRuntimeContext,
              ["verifying", "active"],
            )
          : null;
        if (!admittedRuntimeContext || !currentEndpoint) {
          const filteredAt = new Date();
          await notifyChatDeliveryWork(tx);
          await tx
            .update(chatDeliveries)
            .set({
              state: "filtered",
              nextAttemptAt: null,
              processedAt: filteredAt,
              redactedError:
                "Message lifecycle callback belonged to a superseded runtime",
              updatedAt: filteredAt,
            })
            .where(
              and(
                eq(chatDeliveries.id, activeDelivery.id),
                eq(chatDeliveries.state, "processing"),
              ),
            );
          return;
        }
        let githubBotSourceEdit = false;
        if (
          currentEndpoint.provider === "github" &&
          activeDelivery.eventKind === "message_updated"
        ) {
          // Bot callbacks can arrive before the outbound publication commits
          // its message link. The Boolean comes only from GitHub's verified
          // sender/comment-author type, never from comment text. Legacy rows
          // lack it, so also recognize exact already-published outbound links.
          const linkedMessages = await tx
            .select({ direction: chatMessageLinks.direction })
            .from(chatMessageLinks)
            .innerJoin(
              chatConversations,
              and(
                eq(chatConversations.id, chatMessageLinks.conversationId),
                eq(chatConversations.companyId, chatMessageLinks.companyId),
                eq(chatConversations.endpointId, chatMessageLinks.endpointId),
              ),
            )
            .where(
              and(
                eq(chatMessageLinks.companyId, currentEndpoint.companyId),
                eq(chatMessageLinks.endpointId, currentEndpoint.id),
                eq(chatMessageLinks.providerMessageId, lifecycle.messageId),
                eq(chatConversations.externalThreadId, lifecycle.threadId),
              ),
            );
          const outbound = linkedMessages.some(
            (row) => row.direction === "outbound",
          );
          // A bot editor can change an already-admitted human source. That
          // authenticated change revokes the old source, but never admits the
          // bot's new content. Unknown/self/outbound updates remain suppressed.
          githubBotSourceEdit =
            lifecycle.isBotMessage &&
            !outbound &&
            linkedMessages.some((row) => row.direction === "inbound");
          if (outbound || (lifecycle.isBotMessage && !githubBotSourceEdit)) {
            const filteredAt = new Date();
            await notifyChatDeliveryWork(tx);
            await tx
              .update(chatDeliveries)
              .set({
                state: "filtered",
                principalId: null,
                nextAttemptAt: null,
                processedAt: filteredAt,
                updatedAt: filteredAt,
                redactedError:
                  "Provider bot or outbound message updates do not create inbound work",
                normalizedEvent: {
                  providerEventId:
                    activeDelivery.normalizedEvent.providerEventId ??
                    activeDelivery.providerEventId,
                  kind: activeDelivery.eventKind,
                  conversation: { externalThreadId: lifecycle.threadId },
                  message: {
                    providerMessageId: lifecycle.messageId,
                    targetProviderEventId: lifecycle.targetProviderEventId,
                  },
                  filtering: { contentRetained: false },
                },
              })
              .where(
                and(
                  eq(chatDeliveries.id, activeDelivery.id),
                  eq(chatDeliveries.state, "processing"),
                ),
              );
            return;
          }
        }
        if (
          activeDelivery.eventKind === "message_updated" ||
          activeDelivery.eventKind === "message_deleted" ||
          activeDelivery.eventKind === "message_restored"
        ) {
          const latestDeleteTransition = await tx
            .select({
              eventKind: chatDeliveries.eventKind,
              providerSentAt: sql<
                string | null
              >`nullif(${chatDeliveries.normalizedEvent}->'message'->>'providerSentAt', '')`,
            })
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.companyId, activeDelivery.companyId),
                eq(chatDeliveries.endpointId, endpoint.id),
                inArray(chatDeliveries.eventKind, [
                  "message_deleted",
                  "message_restored",
                ]),
                eq(chatDeliveries.state, "processed"),
                externalThreadIdentityCondition(
                  sql<string>`${chatDeliveries.normalizedEvent}->'conversation'->>'externalThreadId'`,
                  lifecycle.threadId,
                ),
                sql`${chatDeliveries.normalizedEvent}->'message'->>'targetProviderEventId' = ${lifecycle.targetProviderEventId}`,
              ),
            )
            .orderBy(
              desc(
                sql`coalesce(nullif(${chatDeliveries.normalizedEvent}->'message'->>'providerSentAt', '')::timestamptz, ${chatDeliveries.processedAt})`,
              ),
              desc(sql`case ${chatDeliveries.eventKind}
                when 'message_restored' then 2
                when 'message_deleted' then 1
                else 0
              end`),
              desc(chatDeliveries.processedAt),
              desc(chatDeliveries.id),
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);
          const latestTransitionAt = latestDeleteTransition?.providerSentAt
            ? Date.parse(latestDeleteTransition.providerSentAt)
            : Number.NaN;
          const incomingTransitionAt = lifecycle.providerSentAt
            ? Date.parse(lifecycle.providerSentAt)
            : Number.NaN;
          const incomingTransitionIsStale =
            latestDeleteTransition !== null &&
            Number.isFinite(latestTransitionAt) &&
            Number.isFinite(incomingTransitionAt) &&
            (incomingTransitionAt < latestTransitionAt ||
              (incomingTransitionAt === latestTransitionAt &&
                activeDelivery.eventKind === "message_deleted" &&
                latestDeleteTransition.eventKind === "message_restored"));
          const editTargetsDeletedMessage =
            activeDelivery.eventKind === "message_updated" &&
            latestDeleteTransition?.eventKind === "message_deleted";
          const editPredatesRestore =
            activeDelivery.eventKind === "message_updated" &&
            latestDeleteTransition?.eventKind === "message_restored" &&
            Number.isFinite(latestTransitionAt) &&
            Number.isFinite(incomingTransitionAt) &&
            incomingTransitionAt < latestTransitionAt;
          if (
            incomingTransitionIsStale ||
            editTargetsDeletedMessage ||
            editPredatesRestore
          ) {
            const filteredAt = new Date();
            await notifyChatDeliveryWork(tx);
            await tx
              .update(chatDeliveries)
              .set({
                state: "filtered",
                normalizedEvent: {
                  providerEventId:
                    activeDelivery.normalizedEvent.providerEventId ??
                    activeDelivery.providerEventId,
                  kind: activeDelivery.eventKind,
                  conversation: { externalThreadId: lifecycle.threadId },
                  message: {
                    providerMessageId: lifecycle.messageId,
                    targetProviderEventId: lifecycle.targetProviderEventId,
                  },
                  filtering: { contentRetained: false },
                },
                principalId: null,
                nextAttemptAt: null,
                processedAt: filteredAt,
                redactedError: editTargetsDeletedMessage
                  ? "Message edit arrived after the provider message was deleted"
                  : "Message lifecycle callback was older than the current provider state",
                updatedAt: filteredAt,
              })
              .where(
                and(
                  eq(chatDeliveries.id, activeDelivery.id),
                  eq(chatDeliveries.state, "processing"),
                ),
              );
            return;
          }
        }
        const originalDelivery = await tx
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(
                chatDeliveries.providerEventId,
                lifecycle.targetProviderEventId,
              ),
            ),
          )
          .then((rows) => rows[0] ?? null);
        const linkedTargets = await tx
          .select({
            conversationId: chatConversations.id,
            externalThreadId: chatConversations.externalThreadId,
            issueId: chatConversations.issueId,
          })
          .from(chatMessageLinks)
          .innerJoin(
            chatConversations,
            and(
              eq(chatConversations.companyId, chatMessageLinks.companyId),
              eq(chatConversations.id, chatMessageLinks.conversationId),
            ),
          )
          .where(
            and(
              eq(chatMessageLinks.endpointId, endpoint.id),
              eq(chatMessageLinks.providerMessageId, lifecycle.messageId),
              eq(chatMessageLinks.direction, "inbound"),
            ),
          )
          .orderBy(desc(chatConversations.sessionGeneration))
          .then((rows) => rows);
        const linkedTarget =
          linkedTargets.find((candidate) =>
            currentEndpoint.provider === "microsoft-teams"
              ? sameTeamsThreadIdentity(
                  candidate.externalThreadId,
                  lifecycle.threadId,
                )
              : candidate.externalThreadId === lifecycle.threadId,
          ) ?? null;

        if (!linkedTarget) {
          const originalIsOpen =
            originalDelivery !== null &&
            ["received", "processing", "retry"].includes(
              originalDelivery.state,
            );
          const waitForRoot =
            originalIsOpen ||
            activeDelivery.attempts <= ORPHAN_FOLLOW_UP_MAX_ATTEMPTS;
          const resolutionAt = new Date();
          await notifyChatDeliveryWork(tx);
          await tx
            .update(chatDeliveries)
            .set(
              waitForRoot
                ? {
                    state: "retry",
                    nextAttemptAt: new Date(
                      resolutionAt.getTime() + ORPHAN_FOLLOW_UP_GRACE_MS,
                    ),
                    redactedError: originalIsOpen
                      ? "Waiting for the original message to finish processing"
                      : "Waiting briefly for the original message",
                    updatedAt: resolutionAt,
                  }
                : {
                    state: "filtered",
                    nextAttemptAt: null,
                    redactedError:
                      "Original message was not admitted to this conversation",
                    processedAt: resolutionAt,
                    updatedAt: resolutionAt,
                  },
            )
            .where(
              and(
                eq(chatDeliveries.id, activeDelivery.id),
                eq(chatDeliveries.state, "processing"),
              ),
            );
          return;
        }

        const currentConversation = await tx
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.companyId, currentEndpoint.companyId),
              eq(chatConversations.endpointId, currentEndpoint.id),
              eq(chatConversations.id, linkedTarget.conversationId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        const currentResource =
          currentConversation?.resourceId &&
          !currentConversation.isDirectMessage
            ? await tx
                .select()
                .from(chatEndpointResources)
                .where(
                  and(
                    eq(
                      chatEndpointResources.companyId,
                      currentEndpoint.companyId,
                    ),
                    eq(chatEndpointResources.endpointId, currentEndpoint.id),
                    eq(
                      chatEndpointResources.id,
                      currentConversation.resourceId,
                    ),
                  ),
                )
                .for("update")
                .then((rows) => rows[0] ?? null)
            : null;
        const retainSourceInvalidation = async (
          principalId: string | null,
          reason: string,
        ): Promise<boolean> => {
          if (
            !currentConversation ||
            activeDelivery.eventKind !== "message_updated"
          )
            return false;
          const invalidatedAt = new Date();
          // Provider authentication proves the exact source changed. The
          // editor's current Paperclip rights govern admitting new content,
          // not whether a later regrant can resurrect the stale old source.
          await notifyChatDeliveryWork(tx);
          await tx
            .update(chatDeliveries)
            .set({
              state: "processed",
              conversationId: currentConversation.id,
              principalId,
              normalizedEvent: {
                providerEventId:
                  activeDelivery.normalizedEvent.providerEventId ??
                  activeDelivery.providerEventId,
                kind: activeDelivery.eventKind,
                runtimeContext: {
                  generation: admittedRuntimeContext.generation,
                  credentialFingerprint:
                    admittedRuntimeContext.credentialFingerprint,
                },
                conversation: { externalThreadId: lifecycle.threadId },
                message: {
                  providerMessageId: lifecycle.messageId,
                  targetProviderEventId: lifecycle.targetProviderEventId,
                  providerSentAt: lifecycle.providerSentAt,
                },
                filtering: { contentRetained: false },
              },
              nextAttemptAt: null,
              processedAt: invalidatedAt,
              redactedError: reason,
              updatedAt: invalidatedAt,
            })
            .where(
              and(
                eq(chatDeliveries.id, activeDelivery.id),
                eq(chatDeliveries.state, "processing"),
              ),
            );
          return true;
        };
        if (
          githubBotSourceEdit &&
          (await retainSourceInvalidation(
            null,
            "Provider bot edit invalidated an existing source without admitting bot content",
          ))
        )
          return;

        let lifecyclePrincipalId: string | null = null;
        const requiresLifecycleActorAuthorization =
          (activeDelivery.eventKind === "message_updated" ||
            activeDelivery.eventKind === "message_restored") &&
          (lifecycle.actor !== null ||
            currentEndpoint.provider === "github" ||
            currentEndpoint.provider === "telegram" ||
            currentEndpoint.provider === "microsoft-teams");
        if (requiresLifecycleActorAuthorization) {
          const lifecyclePrincipal = lifecycle.actor
            ? await tx
                .select({
                  id: chatExternalPrincipals.id,
                  isBot: chatExternalPrincipals.isBot,
                  kind: chatExternalPrincipals.kind,
                })
                .from(chatExternalPrincipals)
                .where(
                  and(
                    eq(
                      chatExternalPrincipals.companyId,
                      currentEndpoint.companyId,
                    ),
                    eq(
                      chatExternalPrincipals.provider,
                      currentEndpoint.provider,
                    ),
                    eq(
                      chatExternalPrincipals.providerAccountId,
                      currentEndpoint.providerAccountId ?? "unknown",
                    ),
                    eq(
                      chatExternalPrincipals.externalId,
                      lifecycle.actor.externalId,
                    ),
                  ),
                )
                .for("update")
                .then((rows) => rows[0] ?? null)
            : null;
          const authorization =
            lifecyclePrincipal &&
            lifecyclePrincipal.kind === "user" &&
            !lifecyclePrincipal.isBot
              ? await lockCurrentPrincipalAuthorization(
                  tx,
                  currentEndpoint,
                  lifecyclePrincipal.id,
                )
              : null;
          const authorizedPrincipalId = authorization?.allowed
            ? (lifecyclePrincipal?.id ?? null)
            : null;
          if (!authorizedPrincipalId) {
            if (
              await retainSourceInvalidation(
                lifecyclePrincipal?.id ?? null,
                "Provider edit invalidation retained without admitting content from an unauthorized actor",
              )
            )
              return;
            const filteredAt = new Date();
            await notifyChatDeliveryWork(tx);
            await tx
              .update(chatDeliveries)
              .set({
                principalId: lifecyclePrincipal?.id ?? null,
                state: "filtered",
                normalizedEvent: {
                  providerEventId:
                    activeDelivery.normalizedEvent.providerEventId ??
                    activeDelivery.providerEventId,
                  kind: activeDelivery.eventKind,
                  conversation: { externalThreadId: lifecycle.threadId },
                  message: {
                    providerMessageId: lifecycle.messageId,
                    targetProviderEventId: lifecycle.targetProviderEventId,
                  },
                  filtering: { contentRetained: false },
                },
                nextAttemptAt: null,
                processedAt: filteredAt,
                redactedError:
                  "External message actor is no longer authorized for lifecycle events",
                updatedAt: filteredAt,
              })
              .where(
                and(
                  eq(chatDeliveries.id, activeDelivery.id),
                  eq(chatDeliveries.state, "processing"),
                ),
              );
            return;
          }
          lifecyclePrincipalId = authorizedPrincipalId;
        }

        const destinationAllowed =
          currentConversation !== null &&
          ["active", "waiting"].includes(currentConversation.state) &&
          (currentConversation.isDirectMessage
            ? currentEndpoint.allowDirectMessages
            : nonDirectDestinationAllowed(currentEndpoint, currentResource));
        if (!destinationAllowed) {
          const filteredAt = new Date();
          // A verified deletion or authorized edit still revokes the exactly
          // linked source while reach is disabled. Re-enabling access must not
          // revive stale files. Keep only the invalidation, never the new
          // content: no task comment, attachment import or wake is allowed.
          const retainInvalidation =
            currentConversation !== null &&
            (activeDelivery.eventKind === "message_deleted" ||
              (activeDelivery.eventKind === "message_updated" &&
                lifecyclePrincipalId !== null));
          await notifyChatDeliveryWork(tx);
          await tx
            .update(chatDeliveries)
            .set({
              state: retainInvalidation ? "processed" : "filtered",
              ...(retainInvalidation
                ? {
                    conversationId: currentConversation.id,
                    principalId: lifecyclePrincipalId,
                  }
                : {}),
              normalizedEvent: {
                providerEventId:
                  activeDelivery.normalizedEvent.providerEventId ??
                  activeDelivery.providerEventId,
                kind: activeDelivery.eventKind,
                ...(retainInvalidation
                  ? {
                      runtimeContext: {
                        generation: admittedRuntimeContext.generation,
                        credentialFingerprint:
                          admittedRuntimeContext.credentialFingerprint,
                      },
                    }
                  : {}),
                conversation: { externalThreadId: lifecycle.threadId },
                message: {
                  providerMessageId: lifecycle.messageId,
                  targetProviderEventId: lifecycle.targetProviderEventId,
                  ...(retainInvalidation
                    ? { providerSentAt: lifecycle.providerSentAt }
                    : {}),
                },
                filtering: { contentRetained: false },
              },
              nextAttemptAt: null,
              processedAt: filteredAt,
              redactedError: retainInvalidation
                ? activeDelivery.eventKind === "message_deleted"
                  ? "Provider deletion retained without task content while destination access is disabled"
                  : "Provider edit invalidation retained without task content while destination access is disabled"
                : "Destination is no longer enabled for message lifecycle events",
              updatedAt: filteredAt,
            })
            .where(
              and(
                eq(chatDeliveries.id, activeDelivery.id),
                eq(chatDeliveries.state, "processing"),
              ),
            );
          return;
        }

        await issuesSvc.addComment(
          linkedTarget.issueId,
          lifecycle.text,
          {},
          { authorType: "system" },
          tx,
        );
        await notifyChatDeliveryWork(tx);
        await tx
          .update(chatDeliveries)
          .set({
            conversationId: linkedTarget.conversationId,
            principalId: lifecyclePrincipalId,
            state: "processed",
            processedAt: new Date(),
            redactedError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatDeliveries.id, activeDelivery.id),
              eq(chatDeliveries.state, "processing"),
            ),
          );
      });
    } catch (error) {
      const terminal = activeDelivery.attempts >= 5;
      await db.transaction(async (tx) => {
        await notifyChatDeliveryWork(tx);
        return tx
          .update(chatDeliveries)
          .set({
            state: terminal ? "failed" : "retry",
            nextAttemptAt: terminal
              ? null
              : new Date(
                  Date.now() +
                    Math.min(60_000, 1000 * 2 ** activeDelivery.attempts),
                ),
            redactedError: redactError(error),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatDeliveries.id, activeDelivery.id),
              eq(chatDeliveries.state, "processing"),
            ),
          );
      });
      throw error;
    }
  }

  async function handleMessageUpdated(
    event: ChatSdkMessageUpdatedCallbackEvent,
    runtimeContext: RuntimeContext,
  ) {
    if (
      event.provider === "discord" &&
      !(await ensureDiscordGatewayRuntimeIsCurrent(
        event.endpointId,
        runtimeContext,
      ))
    ) {
      return;
    }
    const text = `An external message was edited:\n\n${event.message.text.slice(0, MAX_INBOUND_TEXT)}`;
    const telegramRich =
      event.provider === "telegram"
        ? normalizeTelegramRichMessage(event.message.raw)
        : null;
    await recordLifecycleDelivery(
      {
        actor: lifecycleActorFromAuthor(
          event.provider,
          event.message.author,
          event.message.raw,
        ),
        endpointId: event.endpointId,
        threadId: event.thread.id,
        messageId: event.message.id,
        eventKind: "message_updated",
        text,
        providerMessageSequence:
          event.provider === "telegram"
            ? telegramMessageSequence(event.message.raw)
            : null,
        providerSentAt:
          (
            event.message.metadata.editedAt ?? event.message.metadata.dateSent
          )?.toISOString() ?? null,
        raw: event.message.raw,
        revision: `${event.message.metadata.editedAt?.toISOString() ?? "unknown"}:${createHash("sha256").update(event.message.text).digest("hex")}${event.provider === "slack" ? `:${slackLifecycleFilesDigest(event.message.raw)}` : event.provider === "discord" ? `:${discordLifecycleFilesDigest(event.message.raw)}` : telegramRich ? `:${telegramRich.mediaDigest}` : ""}`,
      },
      runtimeContext,
    );
  }

  async function handleMessageDeleted(
    event: ChatSdkCallbackEvent<MessageDeletedEvent>,
    runtimeContext: RuntimeContext,
  ) {
    if (
      event.provider === "discord" &&
      !(await ensureDiscordGatewayRuntimeIsCurrent(
        event.endpointId,
        runtimeContext,
      ))
    ) {
      return;
    }
    await recordLifecycleDelivery(
      {
        endpointId: event.endpointId,
        threadId: event.event.threadId,
        messageId: event.event.messageId,
        eventKind: "message_deleted",
        text: "An external message in this conversation was deleted.",
        providerSentAt: event.event.deletedAt?.toISOString() ?? null,
        raw: event.event.raw,
        revision: event.event.deletedAt?.toISOString() ?? null,
      },
      runtimeContext,
    );
  }
  return { conversationForThread, recordLifecycleDelivery, processLifecycleDelivery, handleMessageUpdated, handleMessageDeleted };
}
