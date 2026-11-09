import { createGitHubMessageProvenance } from "../github/message-provenance.js";
import { createDiscordRootThreads } from "../discord/root-threads.js";

import type { EndpointRow, RuntimeContext, InboundRuntimeContext } from "../runtime-types.js";

import {
  telegramDeliveryHasZeroMessageId,
} from "../telegram/messages.js";

import { notifyChatDeliveryWork } from "../../chat-work-notifications.js";

import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";

import type { GitHubReviewEventContext, GitHubIssueEventContext, GitHubReviewPolicy } from "@paperclipai/shared";

import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  and,
  eq,
  inArray,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import {
  externalThreadIdentityCondition,
} from "../../chat-control-chronology.js";

import type { Db } from "@paperclipai/db";

import {
  chatDeliveries,
  chatEndpointLeases,
  chatEndpoints,
} from "@paperclipai/db";

import {
  normalizeContentType,
} from "../../../attachment-types.js";

import { logger } from "../../../middleware/logger.js";

import {
  type ChatSdkMessageCallbackEvent,
} from "../../chat-sdk-runtime.js";

import { isExternalChatWaitAuthorizationContention } from "../../native-runtime/chat-attachment-reuse.js";

import {
  restoreGitHubAttachmentLimitOmissions,
} from "../../chat-github-attachments.js";

import type {
  Attachment,
  Message,
  Thread,
} from "chat";
import { DELIVERY_PROCESSING_STALE_MS, deliveryContentWasRedacted, setupDestinationActivationSuppressed, normalizedDeliveryThreadId, normalizedLifecycleTargetEventId, normalizedLifecycleEffect, deliveryReady, conversationDeliveryOrder, pendingInboundWakeupCondition, lifecycleRuntimeFence } from "./delivery-ledger.js";
import type { createChatMessageLifecycle } from "./lifecycle.js";
import type { LiveInboundMessage } from "../runtime-types.js";
type DeliveryRow = typeof chatDeliveries.$inferSelect;
type ConversationDeliveryQueueOptions = {
  DELIVERY_DRAIN_LIMIT: number;
  DELIVERY_LEASE_TTL_MS: number;
  discordRootThreadPending: ReturnType<typeof createDiscordRootThreads>["discordRootThreadPending"];
  reconcileDiscordRootThread: ReturnType<typeof createDiscordRootThreads>["reconcileDiscordRootThread"];
  durableExternalThreadIdentity: (threadId: string) => string;
  liveInboundMessages: Map<string, LiveInboundMessage>;
  processInboundWakeup: (deliveryId: string) => Promise<boolean>;
  processLifecycleDelivery: ReturnType<typeof createChatMessageLifecycle>["processLifecycleDelivery"];
  processMessage: (endpoint: EndpointRow, thread: Thread, message: Message, trigger: ChatSdkMessageCallbackEvent["trigger"], ingressOnly?: boolean, recoveredProviderUrl?: string | null, runtimeContext?: InboundRuntimeContext, providerUpdateId?: number, admittedDeliveryId?: string | null, receiptReactionSupported?: boolean, preauthorizedUserId?: string | null, deferDrainUntilFollowup?: boolean, suppressSetupDestinationActivation?: boolean, slackSlashControl?: boolean) => Promise<void>;
  redactError: (error: unknown) => string;
  runtimeContexts: WeakMap<object, RuntimeContext>;
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  settleRejectedInboundWakeups: (onlyDeliveryId?: string) => Promise<unknown>;
  sanitizeFilename: (value: string | undefined) => string | null;
  githubManualMessages: WeakMap<object, { policy: GitHubReviewPolicy; revision: number; event: "mention" | "comment" }>;
  githubAutomaticMessages: WeakMap<object, { context: GitHubReviewEventContext; revision: number; policy: GitHubReviewPolicy }>;
  githubIssueMessages: WeakMap<object, { context: GitHubIssueEventContext; revision: number; policy: GitHubReviewPolicy }>;
  conversationDrainKey: (endpointId: string, threadId: string) => string;
  conversationLeaseRenewalIntervalMs?: number;
  renewConversationDeliveryLease?: (input: { endpointId: string; leaseKey: string; token: string; expiresAt: Date }) => Promise<boolean>;
};
export function createChatConversationDeliveryQueue(db: Db, options: ConversationDeliveryQueueOptions) {
  const { DELIVERY_DRAIN_LIMIT, DELIVERY_LEASE_TTL_MS, discordRootThreadPending, reconcileDiscordRootThread, durableExternalThreadIdentity, liveInboundMessages, processInboundWakeup, processLifecycleDelivery, processMessage, redactError, runtimeContexts, runtimeFor, settleRejectedInboundWakeups, sanitizeFilename, githubManualMessages, githubAutomaticMessages, githubIssueMessages, conversationDrainKey } = options;
  const { restoreGitHubMessageProvenance } = createGitHubMessageProvenance({ githubManualMessages, githubAutomaticMessages, githubIssueMessages });


  async function earliestOpenConversationDelivery(
    endpointId: string,
    threadId: string,
  ): Promise<DeliveryRow | null> {
    const externalThreadId = sql<string>`${chatDeliveries.normalizedEvent}->'conversation'->>'externalThreadId'`;
    const candidate = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpointId),
          or(
            inArray(chatDeliveries.state, ["received", "retry", "processing"]),
            and(
              eq(chatDeliveries.state, "processed"),
              pendingInboundWakeupCondition(),
            ),
          ),
          notInArray(chatDeliveries.eventKind, [
            "reaction_added",
            "reaction_removed",
          ]),
          externalThreadIdentityCondition(externalThreadId, threadId),
        ),
      )
      .orderBy(...conversationDeliveryOrder())
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!candidate) return null;

    // A lifecycle callback can reach Paperclip before its create callback. If
    // the root becomes durable while the lifecycle row is waiting, always
    // return that exact dependency first even when a coarse or malformed
    // provider timestamp would otherwise put the edit/delete at the head.
    const targetProviderEventId = normalizedLifecycleTargetEventId(candidate);
    if (!targetProviderEventId) return candidate;
    return db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          eq(chatDeliveries.endpointId, endpointId),
          eq(chatDeliveries.providerEventId, targetProviderEventId),
          inArray(chatDeliveries.state, ["received", "retry", "processing"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? candidate);
  }

  async function acquireConversationDeliveryLease(input: {
    companyId: string;
    endpointId: string;
    threadId: string;
  }): Promise<{ leaseKey: string; token: string } | null> {
    const now = new Date();
    const token = randomUUID();
    const leaseKey = `inbound:${createHash("sha256").update(durableExternalThreadIdentity(input.threadId)).digest("hex")}`;
    const expiresAt = new Date(now.getTime() + DELIVERY_LEASE_TTL_MS);
    const inserted = await db
      .insert(chatEndpointLeases)
      .values({
        companyId: input.companyId,
        endpointId: input.endpointId,
        leaseKey,
        token,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: chatEndpointLeases.id });
    if (inserted.length > 0) return { leaseKey, token };
    const reclaimed = await db
      .update(chatEndpointLeases)
      .set({ token, expiresAt, updatedAt: now })
      .where(
        and(
          eq(chatEndpointLeases.companyId, input.companyId),
          eq(chatEndpointLeases.endpointId, input.endpointId),
          eq(chatEndpointLeases.leaseKey, leaseKey),
          lte(chatEndpointLeases.expiresAt, now),
        ),
      )
      .returning({ id: chatEndpointLeases.id });
    return reclaimed.length > 0 ? { leaseKey, token } : null;
  }

  async function releaseConversationDeliveryLease(input: {
    endpointId: string;
    leaseKey: string;
    token: string;
  }): Promise<void> {
    await db
      .delete(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.endpointId, input.endpointId),
          eq(chatEndpointLeases.leaseKey, input.leaseKey),
          eq(chatEndpointLeases.token, input.token),
        ),
      );
  }

  function messageFromDelivery(
    delivery: DeliveryRow,
    thread: Thread,
    endpointRuntime: ChatEndpointRuntime,
  ): {
    message: Message;
    receiptReactionSupported: boolean;
    suppressSetupDestinationActivation: boolean;
    trigger: ChatSdkMessageCallbackEvent["trigger"];
    providerUrl: string | null;
  } | null {
    if (telegramDeliveryHasZeroMessageId(delivery, endpointRuntime.provider))
      return null;
    const normalized = delivery.normalizedEvent as {
      acknowledgement?: { receiptReactionSupported?: unknown };
      kind?: unknown;
      trigger?: unknown;
      principal?: {
        externalId?: unknown;
        displayName?: unknown;
        handle?: unknown;
      };
      message?: {
        providerMessageId?: unknown;
        sourceProviderMessageId?: unknown;
        text?: unknown;
        mentionedBot?: unknown;
        attachments?: Array<{
          name?: unknown;
          mimeType?: unknown;
          size?: unknown;
          recovery?: unknown;
        }>;
        attachmentLimitOmissions?: unknown;
        photonReply?: { guid?: unknown; part?: unknown };
      };
      conversation?: { providerUrl?: unknown };
    };
    const providerMessageId = normalized.message?.providerMessageId;
    const externalId = normalized.principal?.externalId;
    if (typeof providerMessageId !== "string" || typeof externalId !== "string")
      return null;
    const isTeams = endpointRuntime.provider === "microsoft-teams";
    const referenceOnlyTeamsAttachments = isTeams && !thread.isDM;
    const originFence = lifecycleRuntimeFence(delivery);
    const storedAttachments = normalized.message?.attachments ?? [];
    const attachments = (
      isTeams ? storedAttachments.slice(0, 20) : storedAttachments
    )
      .map((attachment) => {
        if (!attachment || typeof attachment !== "object") return null;
        const rehydrated =
          attachment.recovery &&
          (!referenceOnlyTeamsAttachments ||
            (typeof attachment.recovery === "object" &&
              attachment.recovery !== null &&
              "locator" in attachment.recovery &&
              typeof attachment.recovery.locator === "object" &&
              attachment.recovery.locator !== null &&
              "kind" in attachment.recovery.locator &&
              attachment.recovery.locator.kind === "teams_inline_image"))
            ? endpointRuntime.rehydrateAttachment(attachment.recovery, {
                threadId: thread.id,
                messageId: typeof normalized.message?.sourceProviderMessageId === "string" ? normalized.message.sourceProviderMessageId : providerMessageId,
                runtimeGeneration: originFence?.generation,
                credentialFingerprint: originFence?.credentialFingerprint,
                principalExternalId: externalId,
                isDirectMessage: thread.isDM,
              })
            : null;
        if (rehydrated) return rehydrated;
        if (
          isTeams ||
          endpointRuntime.provider === "imessage-photon" ||
          (endpointRuntime.provider === "telegram" &&
            typeof attachment.recovery === "object" &&
            attachment.recovery !== null &&
            "locator" in attachment.recovery &&
            typeof attachment.recovery.locator === "object" &&
            attachment.recovery.locator !== null &&
            "kind" in attachment.recovery.locator &&
            attachment.recovery.locator.kind === "telegram_media")
        ) {
          // Non-personal references and personal files whose safe download
          // capability did not survive restart still belong to this input.
          // Keep bounded metadata so ingestion records an explicit omission;
          // never persist bearer URLs or fabricate a download capability.
          // Even a legacy URL locator cannot enable non-personal downloads.
          // A Telegram media locator which fails its exact source proof also
          // remains an unavailable input, never an empty attachment-free turn.
          return {
            type: "file",
            name:
              sanitizeFilename(
                typeof attachment.name === "string"
                  ? attachment.name
                  : undefined,
              ) ?? undefined,
            mimeType: normalizeContentType(
              typeof attachment.mimeType === "string"
                ? attachment.mimeType
                : undefined,
            ).slice(0, 255),
            size:
              typeof attachment.size === "number" &&
              Number.isSafeInteger(attachment.size) &&
              attachment.size >= 0
                ? attachment.size
                : undefined,
          } as Attachment;
        }
        return null;
      })
      .filter((attachment): attachment is Attachment => Boolean(attachment));
    const message = {
      id: providerMessageId,
      threadId: thread.id,
      text:
        typeof normalized.message?.text === "string"
          ? normalized.message.text
          : "",
      formatted: { type: "root", children: [] },
      raw:
        endpointRuntime.provider === "imessage-photon" &&
        typeof normalized.message?.photonReply?.guid === "string"
          ? {
              replyTargetGuid: normalized.message.photonReply.guid,
              threadOriginatorPart: normalized.message.photonReply.part,
            }
          : endpointRuntime.provider === "github" && typeof normalized.message?.sourceProviderMessageId === "string"
            ? { githubSourceMessageId: normalized.message.sourceProviderMessageId } : {},
      author: {
        userId: externalId,
        userName:
          typeof normalized.principal?.handle === "string"
            ? normalized.principal.handle
            : externalId,
        fullName:
          typeof normalized.principal?.displayName === "string"
            ? normalized.principal.displayName
            : externalId,
        isBot: false,
        isMe: false,
        isSystem: false,
      },
      metadata: { dateSent: delivery.receivedAt, edited: false },
      attachments,
      links: [],
      isMention: normalized.message?.mentionedBot === true,
    } as unknown as Message;
    restoreGitHubMessageProvenance(delivery, endpointRuntime, message);
    if (
      endpointRuntime.provider === "github" ||
      endpointRuntime.provider === "imessage-photon"
    ) {
      restoreGitHubAttachmentLimitOmissions(
        message,
        normalized.message?.attachmentLimitOmissions,
      );
    }
    const normalizedTrigger = normalized.trigger;
    const trigger: ChatSdkMessageCallbackEvent["trigger"] =
      normalizedTrigger === "direct_message" ||
      normalizedTrigger === "mention" ||
      normalizedTrigger === "subscribed_message" ||
      normalizedTrigger === "unaddressed_message"
        ? normalizedTrigger
        : normalized.kind === "direct_message"
          ? "direct_message"
          : normalized.kind === "mention"
            ? "mention"
            : "subscribed_message";
    return {
      message,
      // Legacy deliveries all originated from native provider messages and
      // therefore retain the historical default.
      receiptReactionSupported:
        normalized.acknowledgement?.receiptReactionSupported !== false,
      suppressSetupDestinationActivation: setupDestinationActivationSuppressed(
        delivery.normalizedEvent,
      ),
      trigger,
      providerUrl:
        typeof normalized.conversation?.providerUrl === "string"
          ? normalized.conversation.providerUrl
          : null,
    };
  }

  /**
   * Drain one external conversation in durable receipt order. The database
   * lease is endpoint + thread scoped, so separate server processes can work
   * on different conversations concurrently but can never mutate the same
   * Paperclip task from two inbound turns at once.
   */
  async function drainConversationDeliveries(
    endpointId: string,
    threadId: string,
  ): Promise<boolean> {
    const endpoint = await db
      .select()
      .from(chatEndpoints)
      .where(eq(chatEndpoints.id, endpointId))
      .then((rows) => rows[0] ?? null);
    if (!endpoint) return false;
    if (endpoint.status === "paused" || endpoint.status === "attention")
      return false;

    const lease = await acquireConversationDeliveryLease({
      companyId: endpoint.companyId,
      endpointId,
      threadId,
    });
    if (!lease) return false;

    let leaseOwned = true;
    let renewal: Promise<void> | null = null;
    const renewTimer = setInterval(
      () => {
        if (!leaseOwned || renewal) return;
        const expiresAt = new Date(Date.now() + DELIVERY_LEASE_TTL_MS);
        renewal = Promise.resolve()
          .then(async () => {
            const renewed = options.renewConversationDeliveryLease
              ? await options.renewConversationDeliveryLease({
                  endpointId,
                  leaseKey: lease.leaseKey,
                  token: lease.token,
                  expiresAt,
                })
              : await db
                  .update(chatEndpointLeases)
                  .set({ expiresAt, updatedAt: new Date() })
                  .where(
                    and(
                      eq(chatEndpointLeases.endpointId, endpointId),
                      eq(chatEndpointLeases.leaseKey, lease.leaseKey),
                      eq(chatEndpointLeases.token, lease.token),
                    ),
                  )
                  .returning({ id: chatEndpointLeases.id })
                  .then((rows) => rows.length > 0);
            if (!renewed) leaseOwned = false;
          })
          .catch((error) => {
            // A failed renewal has unknown durability. Stop this local drain at
            // the next delivery boundary so another worker can never overlap
            // later turns after the original lease expires or is reclaimed.
            leaseOwned = false;
            logger.warn(
              { endpointId, error: redactError(error) },
              "could not renew external chat conversation lease",
            );
          })
          .finally(() => {
            renewal = null;
          });
      },
      options.conversationLeaseRenewalIntervalMs ?? DELIVERY_LEASE_TTL_MS / 3,
    );
    renewTimer.unref?.();

    try {
      for (
        let processed = 0;
        processed < DELIVERY_DRAIN_LIMIT;
        processed += 1
      ) {
        if (!leaseOwned) break;
        const delivery = await earliestOpenConversationDelivery(
          endpointId,
          threadId,
        );
        if (!delivery || !deliveryReady(delivery, new Date())) break;
        if (delivery.state === "processed") {
          if (!(await processInboundWakeup(delivery.id))) break;
          continue;
        }
        if (telegramDeliveryHasZeroMessageId(delivery, endpoint.provider)) {
          const filtered = await db
            .transaction(async (tx) => {
              // Do not round-trip a PostgreSQL microsecond timestamp through
              // JS Date for a CAS. Lock the exact receipt, then revalidate the
              // current source and claim before changing it. A competing live
              // claim is a retry boundary, not permission to settle its work.
              const [current] = await tx
                .select()
                .from(chatDeliveries)
                .where(
                  and(
                    eq(chatDeliveries.id, delivery.id),
                    eq(chatDeliveries.companyId, endpoint.companyId),
                    eq(chatDeliveries.endpointId, endpoint.id),
                  ),
                )
                .for("update", { noWait: true });
              const filteredAt = new Date();
              if (
                !current ||
                current.state !== delivery.state ||
                current.eventKind !== delivery.eventKind ||
                !["received", "retry", "processing"].includes(current.state) ||
                normalizedDeliveryThreadId(current) !== threadId ||
                !deliveryReady(current, filteredAt) ||
                !telegramDeliveryHasZeroMessageId(current, endpoint.provider)
              )
                return false;
              await notifyChatDeliveryWork(tx);
              const changed = await tx
                .update(chatDeliveries)
                .set({
                  state: "filtered",
                  nextAttemptAt: null,
                  processedAt: filteredAt,
                  updatedAt: filteredAt,
                  redactedError:
                    "Telegram message ID zero cannot authorize ordinary work",
                })
                .where(eq(chatDeliveries.id, current.id))
                .returning({ id: chatDeliveries.id });
              return changed.length === 1;
            })
            .catch((error: unknown) => {
              if (isExternalChatWaitAuthorizationContention(error))
                return false;
              throw error;
            });
          if (!filtered) break;
          // Retain original evidence/comments; filtering adds no user content
          // and cannot hydrate attachments, invoke commands, or send feedback.
          await settleRejectedInboundWakeups(delivery.id);
          liveInboundMessages.delete(delivery.id);
          continue;
        }
        if (endpoint.status === "archived" || endpoint.status === "revoked") {
          await db.transaction(async (tx) => {
            await notifyChatDeliveryWork(tx);
            return tx
              .update(chatDeliveries)
              .set({
                state: "filtered",
                redactedError: "Connection was removed before processing",
                processedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(chatDeliveries.id, delivery.id));
          });
          liveInboundMessages.delete(delivery.id);
          continue;
        }

        if (
          endpoint.provider === "discord" &&
          discordRootThreadPending(delivery)
        ) {
          // This is the only recovery path for the narrow crash window after
          // pre-admission but before Chat's ordinary callback. A successful
          // read proves the root thread exists; an explicit 404/410 proves it
          // does not. Ambiguous transport and auth failures remain retryable.
          if (await reconcileDiscordRootThread(endpoint, delivery, threadId)) {
            continue;
          }
          break;
        }

        const live = liveInboundMessages.get(delivery.id);
        try {
          if (
            delivery.eventKind === "message_updated" ||
            delivery.eventKind === "message_deleted" ||
            delivery.eventKind === "message_restored"
          ) {
            await processLifecycleDelivery(endpoint, delivery);
          } else if (live) {
            await processMessage(
              endpoint,
              live.thread,
              live.message,
              live.trigger,
              false,
              live.providerUrl,
              live.runtimeContext,
              undefined,
              delivery.id,
              live.receiptReactionSupported,
              undefined,
              false,
              setupDestinationActivationSuppressed(delivery.normalizedEvent),
            );
          } else {
            if (deliveryContentWasRedacted(delivery.normalizedEvent)) {
              const filteredAt = new Date();
              await db.transaction(async (tx) => {
                await notifyChatDeliveryWork(tx);
                return tx
                  .update(chatDeliveries)
                  .set({
                    state: "filtered",
                    principalId: null,
                    nextAttemptAt: null,
                    processedAt: filteredAt,
                    redactedError:
                      "Provisional Teams setup reply could not be hydrated from a current provider event",
                    updatedAt: filteredAt,
                  })
                  .where(
                    and(
                      eq(chatDeliveries.id, delivery.id),
                      inArray(chatDeliveries.state, [
                        "received",
                        "retry",
                        "processing",
                      ]),
                    ),
                  );
              });
              continue;
            }
            const endpointRuntime = await runtimeFor(endpoint);
            const deliveryRuntimeFence = lifecycleRuntimeFence(delivery);
            const currentRuntimeContext = runtimeContexts.get(
              endpointRuntime as object,
            );
            const thread = endpointRuntime.thread(threadId);
            const reconstructed = messageFromDelivery(
              delivery,
              thread,
              endpointRuntime,
            );
            if (!reconstructed) {
              await db.transaction(async (tx) => {
                await notifyChatDeliveryWork(tx);
                return tx
                  .update(chatDeliveries)
                  .set({
                    state: "failed",
                    redactedError: "Normalized delivery is incomplete",
                    updatedAt: new Date(),
                  })
                  .where(eq(chatDeliveries.id, delivery.id));
              });
              continue;
            }
            await processMessage(
              endpoint,
              thread,
              reconstructed.message,
              reconstructed.trigger,
              false,
              reconstructed.providerUrl,
              deliveryRuntimeFence
                ? {
                    ...deliveryRuntimeFence,
                    endpointRuntime,
                  }
                : currentRuntimeContext,
              undefined,
              delivery.id,
              reconstructed.receiptReactionSupported,
              undefined,
              false,
              reconstructed.suppressSetupDestinationActivation,
            );
          }
        } catch (error) {
          logger.warn(
            {
              endpointId,
              deliveryId: delivery.id,
              error: redactError(error),
            },
            "external chat delivery will retry in receipt order",
          );
        }

        const state = await db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(eq(chatDeliveries.id, delivery.id))
          .then((rows) => rows[0]?.state ?? null);
        if (
          state === "processed" ||
          state === "filtered" ||
          state === "failed"
        ) {
          if (state !== "processed")
            await settleRejectedInboundWakeups(delivery.id);
          liveInboundMessages.delete(delivery.id);
          continue;
        }
        // A retry delay or another still-live processing claim is a strict
        // head-of-line barrier; later replies may not overtake it.
        break;
      }
    } finally {
      clearInterval(renewTimer);
      await renewal;
      await releaseConversationDeliveryLease({ endpointId, ...lease });
    }

    const next = await earliestOpenConversationDelivery(endpointId, threadId);
    if (next?.state === "processed") {
      const [ready] = await db
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.id, next.id),
            pendingInboundWakeupCondition(true),
          ),
        )
        .limit(1);
      return Boolean(ready);
    }
    return Boolean(next && deliveryReady(next, new Date()));
  }

  async function nextInboundDeliveryAt(): Promise<number | null> {
    const rows = await db.select({ delivery: {
      id: chatDeliveries.id, endpointId: chatDeliveries.endpointId, providerEventId: chatDeliveries.providerEventId,
      state: chatDeliveries.state, eventKind: chatDeliveries.eventKind,
      // Retain scheduling metadata only, not message bodies or attachment data.
      normalizedEvent: sql<DeliveryRow["normalizedEvent"]>`jsonb_build_object(
        'conversation', ${chatDeliveries.normalizedEvent}->'conversation',
        'lifecycle', ${chatDeliveries.normalizedEvent}->'lifecycle',
        'message', jsonb_build_object(
          'targetProviderEventId', ${chatDeliveries.normalizedEvent}->'message'->'targetProviderEventId',
          'admissionDependencyEventId', ${chatDeliveries.normalizedEvent}->'message'->'admissionDependencyEventId'))`,
    }, at: sql<string | null>`case
      when ${chatDeliveries.state} = 'processing' then ${chatDeliveries.updatedAt} + ${DELIVERY_PROCESSING_STALE_MS} * interval '1 millisecond'
      when ${chatDeliveries.state} = 'processed' then (
        select min(case when a.status = 'processing' then a.updated_at + ${DELIVERY_PROCESSING_STALE_MS} * interval '1 millisecond'
          else coalesce((a.result->>'retryAt')::timestamptz, now()) end)
        from chat_actions a where a.delivery_id = chat_deliveries.id
          and a.company_id = chat_deliveries.company_id and a.endpoint_id = chat_deliveries.endpoint_id
          and a.kind = 'inbound_wakeup' and a.status in ('issued', 'processing'))
      else coalesce(${chatDeliveries.nextAttemptAt}, now()) end` })
      .from(chatDeliveries).where(and(
        sql`not exists (select 1 from chat_endpoints e where e.id = ${chatDeliveries.endpointId} and e.provider = 'agentmail')`,
        // Provider lifecycle receipts can restore an unavailable endpoint.
        // The ordinary conversation drain still waits for operator resume.
        or(sql`${chatDeliveries.normalizedEvent}->'lifecycle' is not null`,
          sql`not exists (select 1 from chat_endpoints e where e.id = ${chatDeliveries.endpointId} and e.status in ('paused', 'attention'))`),
        or(inArray(chatDeliveries.state, ["received", "retry", "processing"]),
          and(eq(chatDeliveries.state, "processed"), pendingInboundWakeupCondition())),
      )).orderBy(...conversationDeliveryOrder());
    // Only an ordered conversation head can run. Reaction and provider
    // lifecycle receipts are independent; lifecycle edits may select their
    // exact admission dependency before the chronologically earliest row.
    const byEvent = new Map(rows.map(row => [`${row.delivery.endpointId}:${row.delivery.providerEventId}`, row]));
    const conversations = new Set<string>();
    let next: number | null = null;
    for (let row of rows) {
      const delivery = row.delivery;
      const threadId = normalizedDeliveryThreadId(delivery);
      if (threadId && !normalizedLifecycleEffect(delivery) && !["reaction_added", "reaction_removed"].includes(delivery.eventKind)) {
        const key = conversationDrainKey(delivery.endpointId, threadId);
        if (conversations.has(key)) continue;
        conversations.add(key);
        const dependency = normalizedLifecycleTargetEventId(delivery);
        const target = dependency ? byEvent.get(`${delivery.endpointId}:${dependency}`) : undefined;
        if (target && ["received", "retry", "processing"].includes(target.delivery.state)) row = target;
      }
      if (row.at !== null) {
        const at = new Date(row.at).getTime();
        next = next === null ? at : Math.min(next, at);
      }
    }
    return next;
  }
  return { drainConversationDeliveries, nextInboundDeliveryAt };
}
