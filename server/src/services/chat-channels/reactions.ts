import type { EndpointRow, DbTransaction, DbOrTransaction, RuntimeContext, LifecycleRuntimeFence, InboundRuntimeContext } from "./runtime-types.js";

import {
  stableExternalPrincipalId,
} from "./message-lifecycle.js";

import { notifyChatDeliveryWork } from "../chat-work-notifications.js";

import {
  createHash,
} from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import {
  externalThreadIdentityCondition,
} from "../chat-control-chronology.js";

import type { Db } from "@paperclipai/db";

import {
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatMessageLinks,
  chatPublications,
} from "@paperclipai/db";
import type {
  ChatEventKind,
  ChatProvider,
} from "@paperclipai/shared";

import { logger } from "../../middleware/logger.js";

import {
  type ChatSdkCallbackEvent,
} from "../chat-sdk-runtime.js";

import type {
  Author,
  ReactionEvent,
} from "chat";

import type { EndpointRecord } from "./runtime-types.js";
import { slackThreadChannelId } from "./slack/messages.js";

// Reactions can beat the transaction that persists a just-sent provider
// message link. Keep that narrow gap durable, but never retain an unbound
// reaction indefinitely or let it enter the ordinary inbound-message FIFO.
const REACTION_LINK_RETRY_DELAY_MS = 250;
const REACTION_LINK_MAX_DELAY_MS = 5_000;
const REACTION_LINK_MAX_ATTEMPTS = 20;
const REACTION_LINK_MAX_AGE_MS = 2 * 60_000;
type DeliveryRow = typeof chatDeliveries.$inferSelect;
type ConversationRow = typeof chatConversations.$inferSelect;

type InboundReactionsOptions = {
  lockCurrentPrincipalAuthorization: (tx: DbOrTransaction, endpoint: EndpointRow, principalId: string) => Promise<{ allowed: boolean }>;
  runtimeCallbackRecord: (endpointId: string, context: RuntimeContext, statuses: EndpointRow["status"][]) => Promise<EndpointRecord | null>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  ensurePrincipal: (endpoint: EndpointRow, author: Author, raw?: unknown) => Promise<{ principal: { id: string } }>;
  durableExternalThreadIdentity: (threadId: string) => string;
  recordCurrentMicrosoftTeamsRoute: (endpoint: EndpointRow, context: InboundRuntimeContext | undefined, threadId: string, raw: unknown) => Promise<void>;
  lifecycleRuntimeFence: (delivery: DeliveryRow) => LifecycleRuntimeFence | null;
  deliveryReady: (delivery: DeliveryRow, now: Date) => boolean;
  redactError: (error: unknown) => string;
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: typeof chatEndpointResources.$inferSelect | null | undefined) => boolean;
  reactionLinkPreflightBarrier?: () => Promise<void>;
  reactionReplayEndpointLockBarrier?: () => Promise<void>;
  reactionReplayConversationLockBarrier?: () => Promise<void>;
};

export function createInboundReactions(db: Db, options: InboundReactionsOptions) {
  const { lockCurrentPrincipalAuthorization, runtimeCallbackRecord, runtimeCallbackEndpoint, ensurePrincipal, durableExternalThreadIdentity, recordCurrentMicrosoftTeamsRoute, lifecycleRuntimeFence, deliveryReady, redactError, nonDirectDestinationAllowed } = options;


  function reactionConversationThreadCondition(
    provider: ChatProvider,
    threadId: string,
  ): SQL | undefined {
    const exact = externalThreadIdentityCondition(
      sql<string>`${chatConversations.externalThreadId}`,
      threadId,
    );
    const slackDmChannel =
      provider === "slack" ? slackThreadChannelId(threadId) : null;
    return slackDmChannel && /^D[A-Z0-9-]*$/i.test(slackDmChannel)
      ? or(
          exact,
          and(
            eq(chatConversations.isDirectMessage, true),
            eq(chatConversations.externalThreadId, `slack:${slackDmChannel}:`),
          ),
        )
      : exact;
  }

  async function reactionConversationForMessage(
    database: DbOrTransaction,
    endpoint: EndpointRow,
    threadId: string,
    providerMessageId: string,
    direction?: "outbound",
  ): Promise<ConversationRow | null> {
    return database
      .select({ conversation: chatConversations })
      .from(chatMessageLinks)
      .innerJoin(
        chatConversations,
        and(
          eq(chatConversations.companyId, chatMessageLinks.companyId),
          eq(chatConversations.endpointId, chatMessageLinks.endpointId),
          eq(chatConversations.id, chatMessageLinks.conversationId),
        ),
      )
      .where(
        and(
          eq(chatMessageLinks.companyId, endpoint.companyId),
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.providerMessageId, providerMessageId),
          direction ? eq(chatMessageLinks.direction, direction) : undefined,
          reactionConversationThreadCondition(endpoint.provider, threadId),
        ),
      )
      .orderBy(desc(chatConversations.sessionGeneration))
      .limit(1)
      .then((rows) => rows[0]?.conversation ?? null);
  }

  async function lockReactionConversationForMessage(
    tx: DbTransaction,
    endpoint: EndpointRow,
    threadId: string,
    providerMessageId: string,
    direction?: "outbound",
  ): Promise<ConversationRow | null> {
    const candidate = await reactionConversationForMessage(
      tx,
      endpoint,
      threadId,
      providerMessageId,
      direction,
    );
    if (!candidate) return null;
    const current = await tx
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, endpoint.companyId),
          eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.id, candidate.id),
        ),
      )
      // Publication settlement inserts the outbound message link before it
      // updates the endpoint. NO KEY UPDATE serializes state changes while
      // remaining compatible with that link's conversation FK KEY SHARE.
      .for("no key update")
      .then((rows) => rows[0] ?? null);
    if (
      !current ||
      !(current.isDirectMessage
        ? ["active", "waiting", "completed"].includes(current.state)
        : ["active", "waiting"].includes(current.state))
    ) {
      return null;
    }
    const linkStillExists = await tx
      .select({ id: chatMessageLinks.id })
      .from(chatMessageLinks)
      .where(
        and(
          eq(chatMessageLinks.companyId, endpoint.companyId),
          eq(chatMessageLinks.endpointId, endpoint.id),
          eq(chatMessageLinks.conversationId, current.id),
          eq(chatMessageLinks.providerMessageId, providerMessageId),
          direction ? eq(chatMessageLinks.direction, direction) : undefined,
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
    return linkStillExists ? current : null;
  }

  async function streamingReactionConversation(
    database: DbOrTransaction,
    endpoint: EndpointRow,
    threadId: string,
  ): Promise<ConversationRow | null> {
    const candidates = await database
      .selectDistinct({
        conversation: chatConversations,
        sessionGeneration: chatConversations.sessionGeneration,
      })
      .from(chatConversations)
      .innerJoin(
        chatPublications,
        and(
          eq(chatPublications.companyId, chatConversations.companyId),
          eq(chatPublications.endpointId, chatConversations.endpointId),
          eq(chatPublications.conversationId, chatConversations.id),
        ),
      )
      .where(
        and(
          eq(chatConversations.companyId, endpoint.companyId),
          eq(chatConversations.endpointId, endpoint.id),
          or(
            inArray(chatConversations.state, ["active", "waiting"]),
            and(
              eq(chatConversations.isDirectMessage, true),
              eq(chatConversations.state, "completed"),
            ),
          ),
          reactionConversationThreadCondition(endpoint.provider, threadId),
          eq(chatPublications.state, "streaming"),
        ),
      )
      .orderBy(desc(chatConversations.sessionGeneration))
      .limit(2);
    if (candidates.length !== 1) return null;
    return candidates[0]!.conversation;
  }

  async function lockStreamingReactionConversation(
    tx: DbTransaction,
    endpoint: EndpointRow,
    threadId: string,
  ): Promise<ConversationRow | null> {
    const candidate = await streamingReactionConversation(
      tx,
      endpoint,
      threadId,
    );
    if (!candidate) return null;
    const current = await tx
      .select()
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.companyId, endpoint.companyId),
          eq(chatConversations.endpointId, endpoint.id),
          eq(chatConversations.id, candidate.id),
          or(
            inArray(chatConversations.state, ["active", "waiting"]),
            and(
              eq(chatConversations.isDirectMessage, true),
              eq(chatConversations.state, "completed"),
            ),
          ),
        ),
      )
      // Keep the same lock strength/order as the exact-link path above so an
      // in-flight message-link insert cannot deadlock reaction admission.
      .for("no key update")
      .then((rows) => rows[0] ?? null);
    if (!current) return null;
    const stillStreaming = await tx
      .select({ id: chatPublications.id })
      .from(chatPublications)
      .where(
        and(
          eq(chatPublications.companyId, endpoint.companyId),
          eq(chatPublications.endpointId, endpoint.id),
          eq(chatPublications.conversationId, current.id),
          eq(chatPublications.state, "streaming"),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0);
    return stillStreaming ? current : null;
  }

  async function authorizeReactionConversation(
    tx: DbTransaction,
    endpoint: EndpointRow,
    conversation: ConversationRow,
    principalId: string,
  ): Promise<boolean> {
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
    if (!destinationAllowed) return false;
    return (await lockCurrentPrincipalAuthorization(tx, endpoint, principalId))
      .allowed;
  }

  async function handleReaction(
    event: ChatSdkCallbackEvent<ReactionEvent>,
    runtimeContext: RuntimeContext,
  ) {
    const record = await runtimeCallbackRecord(
      event.endpointId,
      runtimeContext,
      ["active"],
    );
    if (
      !record ||
      record.endpoint.status !== "active" ||
      record.endpoint.provider !== event.provider ||
      record.endpoint.capabilities.reactions !== true ||
      event.event.user.isMe ||
      event.event.user.isBot === true ||
      event.event.user.isSystem
    ) {
      return;
    }
    // A DM can have a newer task generation while this reaction still belongs
    // to an older linked message. Resolve its exact lineage before choosing a
    // generation; never attach it to the latest task merely sharing the chat.
    // A just-sent provider message can be visible before its publication/link
    // transaction commits. Only that exact thread's streaming publication is
    // enough evidence to stage an otherwise-unbound reaction for replay.
    let conversation = await reactionConversationForMessage(
      db,
      record.endpoint,
      event.event.threadId,
      event.event.messageId,
    );
    await options.reactionLinkPreflightBarrier?.();
    const plausibleStreamingConversation = conversation
      ? null
      : await streamingReactionConversation(
          db,
          record.endpoint,
          event.event.threadId,
        );
    if (!conversation && !plausibleStreamingConversation) {
      // Settlement can commit between the first exact-link lookup and the
      // streaming-publication lookup. Recheck the durable link before treating
      // the callback as an arbitrary unknown message.
      conversation = await reactionConversationForMessage(
        db,
        record.endpoint,
        event.event.threadId,
        event.event.messageId,
      );
      if (!conversation) return;
    }

    const principal = await ensurePrincipal(
      record.endpoint,
      event.event.user,
      event.event.raw,
    );
    let rawFingerprint: string;
    try {
      rawFingerprint = createHash("sha256")
        .update(JSON.stringify(event.event.raw ?? null))
        .digest("hex")
        .slice(0, 24);
    } catch {
      rawFingerprint = "unavailable";
    }
    const eventKind: ChatEventKind = event.event.added
      ? "reaction_added"
      : "reaction_removed";
    const providerEventId = [
      eventKind,
      durableExternalThreadIdentity(event.event.threadId),
      event.event.messageId,
      stableExternalPrincipalId(
        record.endpoint.provider,
        event.event.user,
        event.event.raw,
      ),
      event.event.rawEmoji,
      rawFingerprint,
    ].join(":");
    const normalizedEvent = {
      providerEventId,
      kind: eventKind,
      conversation: { externalThreadId: event.event.threadId },
      message: { providerMessageId: event.event.messageId },
      reaction: {
        emoji: event.event.emoji.name,
        rawEmoji: event.event.rawEmoji,
        added: event.event.added,
      },
      runtimeContext: {
        generation: runtimeContext.generation,
        credentialFingerprint: runtimeContext.credentialFingerprint,
      },
    };
    const admitted = await db.transaction(async (tx) => {
      const currentEndpoint = await runtimeCallbackEndpoint(
        tx,
        event.endpointId,
        runtimeContext,
        ["active"],
      );
      if (!currentEndpoint) return false;
      const linkedConversation = await lockReactionConversationForMessage(
        tx,
        currentEndpoint,
        event.event.threadId,
        event.event.messageId,
      );
      const currentConversation =
        linkedConversation ??
        (await lockStreamingReactionConversation(
          tx,
          currentEndpoint,
          event.event.threadId,
        ));
      if (
        !currentConversation ||
        !(await authorizeReactionConversation(
          tx,
          currentEndpoint,
          currentConversation,
          principal.principal.id,
        ))
      ) {
        return false;
      }
      const now = new Date();
      if (linkedConversation) {
        const expiryCutoff = new Date(now.getTime() - REACTION_LINK_MAX_AGE_MS);
        const hasOutboundLink = await tx
          .select({ id: chatMessageLinks.id })
          .from(chatMessageLinks)
          .where(
            and(
              eq(chatMessageLinks.companyId, currentEndpoint.companyId),
              eq(chatMessageLinks.endpointId, currentEndpoint.id),
              eq(chatMessageLinks.conversationId, linkedConversation.id),
              eq(chatMessageLinks.providerMessageId, event.event.messageId),
              eq(chatMessageLinks.direction, "outbound"),
            ),
          )
          .limit(1)
          .then((rows) => rows.length > 0);
        await notifyChatDeliveryWork(tx);
        const reconciled = hasOutboundLink
          ? await tx
              .update(chatDeliveries)
              .set({
                conversationId: linkedConversation.id,
                state: "processed",
                attempts: sql`${chatDeliveries.attempts} + 1`,
                nextAttemptAt: null,
                processedAt: now,
                redactedError: null,
                updatedAt: now,
              })
              .where(
                and(
                  eq(chatDeliveries.endpointId, currentEndpoint.id),
                  eq(chatDeliveries.providerEventId, providerEventId),
                  inArray(chatDeliveries.state, ["received", "retry"]),
                  gt(chatDeliveries.receivedAt, expiryCutoff),
                  lt(chatDeliveries.attempts, REACTION_LINK_MAX_ATTEMPTS),
                  sql`${chatDeliveries.normalizedEvent}->'runtimeContext'->>'generation' = ${String(runtimeContext.generation)}`,
                  sql`${chatDeliveries.normalizedEvent}->'runtimeContext'->>'credentialFingerprint' = ${runtimeContext.credentialFingerprint}`,
                ),
              )
              .returning({ id: chatDeliveries.id })
          : [];
        if (reconciled.length > 0) return true;
        await notifyChatDeliveryWork(tx);
        const expired = await tx
          .update(chatDeliveries)
          .set({
            state: "filtered",
            nextAttemptAt: null,
            processedAt: now,
            redactedError:
              "Reaction target did not become linked before replay expiry",
            updatedAt: now,
          })
          .where(
            and(
              eq(chatDeliveries.endpointId, currentEndpoint.id),
              eq(chatDeliveries.providerEventId, providerEventId),
              inArray(chatDeliveries.state, ["received", "retry"]),
              or(
                lte(chatDeliveries.receivedAt, expiryCutoff),
                gte(chatDeliveries.attempts, REACTION_LINK_MAX_ATTEMPTS),
              ),
              sql`${chatDeliveries.normalizedEvent}->'runtimeContext'->>'generation' = ${String(runtimeContext.generation)}`,
              sql`${chatDeliveries.normalizedEvent}->'runtimeContext'->>'credentialFingerprint' = ${runtimeContext.credentialFingerprint}`,
            ),
          )
          .returning({ id: chatDeliveries.id });
        if (expired.length > 0) return false;
      }
      await notifyChatDeliveryWork(tx);
      const inserted = await tx
        .insert(chatDeliveries)
        .values({
          companyId: currentEndpoint.companyId,
          endpointId: currentEndpoint.id,
          conversationId: linkedConversation?.id ?? null,
          principalId: principal.principal.id,
          providerEventId,
          deduplicationKey: createHash("sha256")
            .update(providerEventId)
            .digest("hex"),
          eventKind,
          normalizedEvent,
          state: linkedConversation ? "processed" : "received",
          attempts: linkedConversation ? 1 : 0,
          nextAttemptAt: linkedConversation
            ? null
            : new Date(now.getTime() + REACTION_LINK_RETRY_DELAY_MS),
          processedAt: linkedConversation ? now : null,
        })
        .onConflictDoNothing()
        .returning({ id: chatDeliveries.id });
      if (inserted.length > 0) return true;
      return tx
        .select({ id: chatDeliveries.id })
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.endpointId, currentEndpoint.id),
            eq(chatDeliveries.providerEventId, providerEventId),
            inArray(chatDeliveries.state, ["received", "retry", "processed"]),
          ),
        )
        .limit(1)
        .then((rows) => rows.length > 0);
    });
    if (admitted) {
      await recordCurrentMicrosoftTeamsRoute(
        record.endpoint,
        runtimeContext,
        event.event.threadId,
        event.event.raw,
      );
    }
  }

  function normalizedPendingReaction(delivery: DeliveryRow): {
    added: boolean;
    emoji: string;
    messageId: string;
    rawEmoji: string;
    runtimeContext: LifecycleRuntimeFence;
    threadId: string;
  } | null {
    if (
      delivery.eventKind !== "reaction_added" &&
      delivery.eventKind !== "reaction_removed"
    ) {
      return null;
    }
    const normalized = delivery.normalizedEvent;
    if (
      !normalized ||
      typeof normalized !== "object" ||
      Array.isArray(normalized)
    ) {
      return null;
    }
    const value = normalized as Record<string, unknown>;
    const conversation = value.conversation;
    const message = value.message;
    const reaction = value.reaction;
    const runtimeContext = lifecycleRuntimeFence(delivery);
    if (
      !conversation ||
      typeof conversation !== "object" ||
      Array.isArray(conversation) ||
      !message ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      !reaction ||
      typeof reaction !== "object" ||
      Array.isArray(reaction) ||
      !runtimeContext
    ) {
      return null;
    }
    const threadId = (conversation as Record<string, unknown>).externalThreadId;
    const messageId = (message as Record<string, unknown>).providerMessageId;
    const reactionRecord = reaction as Record<string, unknown>;
    const added = reactionRecord.added;
    const emoji = reactionRecord.emoji;
    const rawEmoji = reactionRecord.rawEmoji;
    return typeof threadId === "string" &&
      threadId.length > 0 &&
      typeof messageId === "string" &&
      messageId.length > 0 &&
      typeof added === "boolean" &&
      added === (delivery.eventKind === "reaction_added") &&
      typeof emoji === "string" &&
      emoji.length > 0 &&
      typeof rawEmoji === "string" &&
      rawEmoji.length > 0
      ? { added, emoji, messageId, rawEmoji, runtimeContext, threadId }
      : null;
  }

  async function processPendingReactionDelivery(
    candidate: DeliveryRow,
  ): Promise<void> {
    const reaction = normalizedPendingReaction(candidate);
    if (!reaction || !candidate.principalId) {
      const now = new Date();
      await db.transaction(async (tx) => {
        await notifyChatDeliveryWork(tx);
        return tx
          .update(chatDeliveries)
          .set({
            state: "failed",
            nextAttemptAt: null,
            processedAt: now,
            redactedError: "Normalized reaction delivery is incomplete",
            updatedAt: now,
          })
          .where(
            and(
              eq(chatDeliveries.id, candidate.id),
              inArray(chatDeliveries.state, ["received", "retry"]),
            ),
          );
      });
      return;
    }
    const principalId = candidate.principalId;

    await db.transaction(async (tx) => {
      const currentEndpoint = await runtimeCallbackEndpoint(
        tx,
        candidate.endpointId,
        reaction.runtimeContext,
        ["active"],
      );
      let conversation: ConversationRow | null = null;
      let disposition:
        | { kind: "processed"; conversationId: string }
        | { kind: "retry" }
        | { kind: "filtered"; reason: string };

      if (!currentEndpoint) {
        disposition = {
          kind: "filtered",
          reason: "Reaction callback belonged to an unavailable runtime",
        };
      } else {
        await options.reactionReplayEndpointLockBarrier?.();
        conversation = await lockReactionConversationForMessage(
          tx,
          currentEndpoint,
          reaction.threadId,
          reaction.messageId,
          "outbound",
        );
        if (conversation) {
          await options.reactionReplayConversationLockBarrier?.();
        }
        if (conversation) {
          disposition = (await authorizeReactionConversation(
            tx,
            currentEndpoint,
            conversation,
            principalId,
          ))
            ? { kind: "processed", conversationId: conversation.id }
            : {
                kind: "filtered",
                reason:
                  "Reaction destination or principal is no longer authorized",
              };
        } else {
          conversation = await lockStreamingReactionConversation(
            tx,
            currentEndpoint,
            reaction.threadId,
          );
          if (conversation) {
            await options.reactionReplayConversationLockBarrier?.();
          }
          if (!conversation) {
            disposition = {
              kind: "filtered",
              reason: "Reaction target was not linked to a sent message",
            };
          } else {
            disposition = (await authorizeReactionConversation(
              tx,
              currentEndpoint,
              conversation,
              principalId,
            ))
              ? { kind: "retry" }
              : {
                  kind: "filtered",
                  reason:
                    "Reaction destination or principal is no longer authorized",
                };
          }
        }
      }

      // Endpoint, conversation, destination and identity locks are acquired
      // before the delivery row so pause/revoke and replay use one lock order.
      const locked = await tx
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.id, candidate.id),
            inArray(chatDeliveries.state, ["received", "retry"]),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      // Authorization locks may wait behind a concurrent lifecycle mutation.
      // Sample the expiry clock only after this delivery is exclusively held.
      const decisionAt = new Date();
      if (!locked || !deliveryReady(locked, decisionAt)) return;
      const lockedReaction = normalizedPendingReaction(locked);
      if (
        !lockedReaction ||
        lockedReaction.runtimeContext.generation !==
          reaction.runtimeContext.generation ||
        lockedReaction.runtimeContext.credentialFingerprint !==
          reaction.runtimeContext.credentialFingerprint
      ) {
        disposition = {
          kind: "filtered",
          reason: "Reaction delivery identity changed before replay",
        };
      }

      const nextAttempts = locked.attempts + 1;
      const expired =
        decisionAt.getTime() - locked.receivedAt.getTime() >=
        REACTION_LINK_MAX_AGE_MS;
      if (expired || locked.attempts >= REACTION_LINK_MAX_ATTEMPTS) {
        disposition = {
          kind: "filtered",
          reason: "Reaction target did not become linked before replay expiry",
        };
      }
      if (disposition.kind === "retry" && !expired) {
        if (nextAttempts < REACTION_LINK_MAX_ATTEMPTS) {
          const delay = Math.min(
            REACTION_LINK_RETRY_DELAY_MS *
              2 ** Math.min(Math.max(locked.attempts, 0), 5),
            REACTION_LINK_MAX_DELAY_MS,
          );
          await notifyChatDeliveryWork(tx);
          await tx
            .update(chatDeliveries)
            .set({
              state: "retry",
              attempts: nextAttempts,
              nextAttemptAt: new Date(decisionAt.getTime() + delay),
              redactedError: "Waiting for the sent message link",
              updatedAt: decisionAt,
            })
            .where(
              and(
                eq(chatDeliveries.id, locked.id),
                eq(chatDeliveries.state, locked.state),
                eq(chatDeliveries.attempts, locked.attempts),
              ),
            );
          return;
        }
        disposition = {
          kind: "filtered",
          reason: "Reaction target did not become linked before retry expiry",
        };
      } else if (disposition.kind === "retry") {
        disposition = {
          kind: "filtered",
          reason: "Reaction target did not become linked before age expiry",
        };
      }

      const processedAt = new Date();
      await notifyChatDeliveryWork(tx);
      await tx
        .update(chatDeliveries)
        .set(
          disposition.kind === "processed"
            ? {
                conversationId: disposition.conversationId,
                state: "processed",
                attempts: nextAttempts,
                nextAttemptAt: null,
                processedAt,
                redactedError: null,
                updatedAt: processedAt,
              }
            : {
                state: "filtered",
                attempts: nextAttempts,
                nextAttemptAt: null,
                processedAt,
                redactedError: disposition.reason,
                updatedAt: processedAt,
              },
        )
        .where(
          and(
            eq(chatDeliveries.id, locked.id),
            eq(chatDeliveries.state, locked.state),
            eq(chatDeliveries.attempts, locked.attempts),
          ),
        );
    });
  }

  async function processPendingReactionDeliveries(
    limit: number,
    onlyDeliveryId?: string,
  ): Promise<number> {
    const now = new Date();
    const candidates = await db
      .select()
      .from(chatDeliveries)
      .where(
        and(
          sql`not exists (select 1 from chat_endpoints e where e.id = ${chatDeliveries.endpointId} and e.provider = 'agentmail')`,
          onlyDeliveryId ? eq(chatDeliveries.id, onlyDeliveryId) : undefined,
          inArray(chatDeliveries.eventKind, [
            "reaction_added",
            "reaction_removed",
          ]),
          or(
            and(
              eq(chatDeliveries.state, "received"),
              or(
                isNull(chatDeliveries.nextAttemptAt),
                lte(chatDeliveries.nextAttemptAt, now),
              ),
            ),
            and(
              eq(chatDeliveries.state, "retry"),
              or(
                isNull(chatDeliveries.nextAttemptAt),
                lte(chatDeliveries.nextAttemptAt, now),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(chatDeliveries.receivedAt), asc(chatDeliveries.id))
      .limit(limit);
    for (const candidate of candidates) {
      try {
        await processPendingReactionDelivery(candidate);
      } catch (error) {
        logger.warn(
          {
            endpointId: candidate.endpointId,
            deliveryId: candidate.id,
            error: redactError(error),
          },
          "chat reaction-link reconciliation failed",
        );
      }
    }
    return candidates.length;
  }
  return { handleReaction, processPendingReactionDeliveries };
}
