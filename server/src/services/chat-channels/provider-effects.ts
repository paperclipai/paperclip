import { notifyChatEndpointConfiguration } from "./configuration-work-notifications.js";
import { notifyChatConnectionHealth } from "./connection-health-notifications.js";
import { createTelegramCallbackNoticeAuthority } from "./telegram/callback-notices.js";

import { slackThreadChannelId } from "./slack/messages.js";

import type { EndpointRow, DbTransaction, DbOrTransaction, LifecycleRuntimeFence } from "./runtime-types.js";

import { baseTeamsConversationId } from "./microsoft-teams/resources.js";

import { dueChatAction, PROVIDER_EFFECT_STALE_MS } from "../chat-action-work.js";

import { notifyChatDeliveryWork, notifyChatActionWork } from "../chat-work-notifications.js";

import type { ChatEndpointRuntime } from "../voice/voice-runtime.js";

import { chatCredentialMutationLease } from "../chat-credential-mutation-lease.js";

import { projectSafeChatPublicationText } from "../chat-publication-projection.js";

import { PhotonChatAdapter } from "../photon/adapter.js";

import {
  and,
  asc,
  eq,
  inArray,
  lte,
  sql,
} from "drizzle-orm";

import {
  teamsConversationId,
} from "../chat-control-chronology.js";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatProvider,
} from "@paperclipai/shared";

import {
  parseTelegramCallbackReceipt,
  telegramCallbackThreadId,
  TELEGRAM_PRIVATE_ACTION_UNAVAILABLE,
  type TelegramCallbackReceipt,
} from "../chat-telegram-ephemeral.js";

import { logger } from "../../middleware/logger.js";
import { redactSensitiveText } from "../../redaction.js";

import { classifyChatPublicationError } from "../chat-publication-errors.js";

import type {
  Thread,
} from "chat";

import type { EndpointRecord } from "./runtime-types.js";

type ProviderEffectTarget = {
  post: Thread["post"];
  postEphemeral?: Thread["postEphemeral"];
};
type ProviderEffectPayload = {
  version: 1;
  effect: "thread_message" | "ephemeral_message" | "telegram_callback_notice";
  telegramCallback?: TelegramCallbackReceipt;
  telegramAuthorizationSha256?: string;
  authorizationMode?: "principal" | "safe_notice";
  threadId: string;
  userId?: string;
  text: string;
  fallbackText?: string;
  settleDelivery: boolean;
  completeConversationId?: string;
  resourceId?: string;
  runtimeGeneration: number;
  credentialFingerprint: string;
};

function providerEffectPayload(
  payload: Record<string, unknown>,
): ProviderEffectPayload | null {
  if (
    payload.version !== 1 ||
    (payload.effect !== "thread_message" &&
      payload.effect !== "ephemeral_message" &&
      payload.effect !== "telegram_callback_notice") ||
    typeof payload.threadId !== "string" ||
    !payload.threadId ||
    typeof payload.text !== "string" ||
    !payload.text ||
    typeof payload.settleDelivery !== "boolean" ||
    typeof payload.runtimeGeneration !== "number" ||
    !Number.isSafeInteger(payload.runtimeGeneration) ||
    typeof payload.credentialFingerprint !== "string"
  ) {
    return null;
  }
  if (
    payload.effect === "ephemeral_message" &&
    (typeof payload.userId !== "string" || !payload.userId)
  ) {
    return null;
  }
  for (const key of [
    "authorizationMode",
    "userId",
    "fallbackText",
    "completeConversationId",
    "resourceId",
  ] as const) {
    const value = payload[key];
    if (value !== undefined && (typeof value !== "string" || !value)) {
      return null;
    }
  }
  if (
    payload.authorizationMode !== undefined &&
    payload.authorizationMode !== "principal" &&
    payload.authorizationMode !== "safe_notice"
  ) {
    return null;
  }
  if (payload.effect === "telegram_callback_notice") {
    const receipt = parseTelegramCallbackReceipt(payload.telegramCallback);
    if (
      !receipt ||
      payload.authorizationMode !== "safe_notice" ||
      payload.text !== TELEGRAM_PRIVATE_ACTION_UNAVAILABLE ||
      payload.threadId !== telegramCallbackThreadId(receipt) ||
      payload.userId !== receipt.receiverUserId ||
      payload.settleDelivery !== false ||
      payload.fallbackText !== undefined ||
      payload.completeConversationId !== undefined ||
      typeof payload.telegramAuthorizationSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(payload.telegramAuthorizationSha256)
    )
      return null;
  } else if (
    payload.telegramCallback !== undefined ||
    payload.telegramAuthorizationSha256 !== undefined
  )
    return null;
  return payload as ProviderEffectPayload;
}
export type { ProviderEffectTarget, ProviderEffectPayload };
export { providerEffectPayload };

type ProviderEffectsOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  invalidateRuntime: (endpointId: string) => Promise<boolean>;
  lockCurrentPrincipalAuthorization: (tx: DbOrTransaction, endpoint: EndpointRow, principalId: string) => Promise<{ allowed: boolean }>;
  redactError: (error: unknown) => string;
  MAX_ERROR_TEXT: number;
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: typeof chatEndpointResources.$inferSelect | null | undefined) => boolean;
  lockTelegramCallbackNoticeAuthority: ReturnType<typeof createTelegramCallbackNoticeAuthority>["lockTelegramCallbackNoticeAuthority"];
};

export function createProviderEffects(db: Db, options: ProviderEffectsOptions) {
  const { endpointRecord, runtimeCallbackEndpoint, withCredentialMutationLease, runtimeFor, invalidateRuntime, lockCurrentPrincipalAuthorization, redactError, MAX_ERROR_TEXT, nonDirectDestinationAllowed, lockTelegramCallbackNoticeAuthority } = options;


  async function stageProviderEffect(
    database: DbOrTransaction,
    input: {
      endpoint: EndpointRow;
      deliveryId?: string | null;
      conversationId?: string | null;
      principalId?: string | null;
      providerActionId: string;
      payload: Omit<
        ProviderEffectPayload,
        "runtimeGeneration" | "credentialFingerprint"
      >;
      runtimeContext: LifecycleRuntimeFence;
    },
  ) {
    await notifyChatActionWork(database, "provider_effect");
    const [inserted] = await database
      .insert(chatActions)
      .values({
        companyId: input.endpoint.companyId,
        endpointId: input.endpoint.id,
        deliveryId: input.deliveryId ?? null,
        conversationId: input.conversationId ?? null,
        principalId: input.principalId ?? null,
        kind: "provider_effect",
        providerActionId: input.providerActionId,
        payload: {
          ...input.payload,
          runtimeGeneration: input.runtimeContext.generation,
          credentialFingerprint: input.runtimeContext.credentialFingerprint,
        },
        status: "received",
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    return database
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.endpointId, input.endpoint.id),
          eq(chatActions.providerActionId, input.providerActionId),
          eq(chatActions.kind, "provider_effect"),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  function providerEffectDisposition(
    error: unknown,
    attempt: number,
    providerEffectCompleted: boolean,
  ) {
    if (!providerEffectCompleted)
      return classifyChatPublicationError(error, attempt);
    return {
      kind: "delivery_unknown" as const,
      reason:
        "Provider effect completed, but Paperclip could not confirm its durable result",
    };
  }

  async function finalizeProviderEffectFailure(input: {
    action: typeof chatActions.$inferSelect;
    endpoint: EndpointRow;
    payload: ProviderEffectPayload;
    disposition: ReturnType<typeof providerEffectDisposition>;
    attempt: number;
  }): Promise<boolean> {
    const failure = redactSensitiveText(input.disposition.reason).slice(
      0,
      MAX_ERROR_TEXT,
    );
    const retryable = input.disposition.kind === "retry";
    const retryAt =
      input.disposition.kind === "retry"
        ? new Date(Date.now() + input.disposition.retryAfterMs)
        : null;
    let invalidateCurrentRuntime = false;
    const finalized = await db.transaction(async (tx) => {
      // Admission locks the endpoint before its delivery. Keep that order
      // when failure settlement also needs to change endpoint/resource health.
      const currentEndpoint =
        input.disposition.kind === "endpoint_attention" ||
        input.disposition.kind === "resource_unavailable"
          ? await runtimeCallbackEndpoint(
              tx,
              input.endpoint.id,
              {
                generation: input.payload.runtimeGeneration,
                credentialFingerprint: input.payload.credentialFingerprint,
              },
              ["verifying", "active"],
            )
          : null;
      await notifyChatActionWork(tx, "provider_effect");
      const [ownedAction] = await tx
        .update(chatActions)
        .set({
          status:
            input.disposition.kind === "delivery_unknown"
              ? "delivery_unknown"
              : "failed",
          result: {
            code: `provider_effect_${input.disposition.kind}`,
            attempts: input.attempt,
            redactedError: failure,
            retryable,
            retryAt: retryAt?.toISOString() ?? null,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, input.action.id),
            eq(chatActions.status, "processing"),
            sql`(${chatActions.result}->>'attempts')::int = ${input.attempt}`,
          ),
        )
        .returning({ id: chatActions.id });
      if (!ownedAction) return false;
      if (input.payload.settleDelivery && input.action.deliveryId) {
        await notifyChatDeliveryWork(tx);
        await tx
          .update(chatDeliveries)
          .set({
            state: retryable ? "retry" : "failed",
            nextAttemptAt: retryAt,
            redactedError:
              input.disposition.kind === "delivery_unknown"
                ? `Provider response is unconfirmed: ${failure}`.slice(
                    0,
                    MAX_ERROR_TEXT,
                  )
                : failure,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatDeliveries.id, input.action.deliveryId),
              eq(chatDeliveries.state, "processing"),
            ),
          );
      }
      if (input.disposition.kind === "endpoint_attention" && currentEndpoint) {
        await notifyChatEndpointConfiguration(tx, currentEndpoint);
        await tx
          .update(chatEndpoints)
          .set({
            status: "attention",
            healthMessage: "Provider credentials or permissions need attention",
            lastError: failure,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, currentEndpoint.id));
        await notifyChatConnectionHealth(tx, currentEndpoint);
        await tx
          .update(toolConnections)
          .set({
            healthStatus: "failed",
            healthMessage: "Provider credentials or permissions need attention",
            lastError: failure,
            healthCheckedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, currentEndpoint.connectionId));
        invalidateCurrentRuntime = true;
      } else if (
        input.disposition.kind === "resource_unavailable" &&
        input.payload.resourceId &&
        currentEndpoint
      ) {
        await tx
          .update(chatEndpointResources)
          .set({ availability: "unavailable", updatedAt: new Date() })
          .where(
            and(
              eq(chatEndpointResources.id, input.payload.resourceId),
              eq(chatEndpointResources.endpointId, currentEndpoint.id),
            ),
          );
      }
      return true;
    });
    if (finalized && invalidateCurrentRuntime) {
      await invalidateRuntime(input.endpoint.id).catch(() => undefined);
    }
    return finalized;
  }

  async function quarantineStaleProviderEffect(
    action: typeof chatActions.$inferSelect,
  ) {
    const payload = providerEffectPayload(action.payload);
    const failure =
      "Provider delivery could not be confirmed after the worker stopped. The effect will not be replayed automatically.";
    await db.transaction(async (tx) => {
      await notifyChatActionWork(tx, "provider_effect");
      const [quarantined] = await tx
        .update(chatActions)
        .set({
          status: "delivery_unknown",
          result: {
            code: "provider_effect_delivery_unknown",
            redactedError: failure,
            retryable: false,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
            eq(chatActions.updatedAt, action.updatedAt),
            sql`(${chatActions.result}->>'attempts')::int = ${
              typeof action.result?.attempts === "number"
                ? action.result.attempts
                : -1
            }`,
            lte(
              chatActions.updatedAt,
              new Date(Date.now() - PROVIDER_EFFECT_STALE_MS),
            ),
          ),
        )
        .returning({ id: chatActions.id });
      if (quarantined && payload?.settleDelivery && action.deliveryId) {
        await notifyChatDeliveryWork(tx);
        await tx
          .update(chatDeliveries)
          .set({
            state: "failed",
            nextAttemptAt: null,
            redactedError: failure,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatDeliveries.id, action.deliveryId),
              eq(chatDeliveries.state, "processing"),
            ),
          );
      }
    });
  }

  function providerEffectThreadResourceId(
    provider: ChatProvider,
    threadId: string,
  ): string | null {
    if (provider === "slack") {
      return (
        slackThreadChannelId(threadId) ??
        (!threadId.includes(":") ? threadId : null)
      );
    }
    if (provider === "telegram") {
      return /^telegram:([^:]+)/.exec(threadId)?.[1] ?? null;
    }
    if (provider === "github") {
      return /^github:([^:]+)/.exec(threadId)?.[1]?.toLowerCase() ?? null;
    }
    if (provider === "discord") {
      return /^discord:[^:]+:([^:]+)/.exec(threadId)?.[1] ?? null;
    }
    const conversationId = teamsConversationId(threadId);
    return conversationId ? baseTeamsConversationId(conversationId) : null;
  }

  async function lockCurrentProviderEffectAuthorization(
    tx: DbTransaction,
    action: typeof chatActions.$inferSelect,
    endpoint: EndpointRow,
    payload: ProviderEffectPayload,
  ): Promise<boolean> {
    if (payload.effect === "telegram_callback_notice") {
      const receipt = parseTelegramCallbackReceipt(payload.telegramCallback);
      if (!receipt || !action.deliveryId) return false;
      const delivery = await tx
        .select()
        .from(chatDeliveries)
        .where(
          and(
            eq(chatDeliveries.id, action.deliveryId),
            eq(chatDeliveries.companyId, action.companyId),
            eq(chatDeliveries.endpointId, action.endpointId),
            eq(chatDeliveries.state, "filtered"),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      const retained =
        delivery &&
        parseTelegramCallbackReceipt(delivery.normalizedEvent.telegramCallback);
      if (
        !delivery ||
        delivery.principalId !== action.principalId ||
        retained?.sourceSha256 !== receipt.sourceSha256 ||
        delivery.normalizedEvent.telegramAuthorizationSha256 !==
          payload.telegramAuthorizationSha256
      )
        return false;
      return (
        (await lockTelegramCallbackNoticeAuthority(
          tx,
          endpoint,
          receipt,
          action.principalId,
        )) === payload.telegramAuthorizationSha256
      );
    }
    const conversation = action.conversationId
      ? await tx
          .select()
          .from(chatConversations)
          .where(
            and(
              eq(chatConversations.companyId, endpoint.companyId),
              eq(chatConversations.endpointId, endpoint.id),
              eq(chatConversations.id, action.conversationId),
              inArray(chatConversations.state, ["active", "waiting"]),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null)
      : null;
    if (action.conversationId && !conversation) return false;
    const inferredResourceId = providerEffectThreadResourceId(
      endpoint.provider,
      payload.threadId,
    );
    const resource = await tx
      .select()
      .from(chatEndpointResources)
      .where(
        and(
          eq(chatEndpointResources.companyId, endpoint.companyId),
          eq(chatEndpointResources.endpointId, endpoint.id),
          payload.resourceId || conversation?.resourceId
            ? eq(
                chatEndpointResources.id,
                payload.resourceId ?? conversation!.resourceId!,
              )
            : inferredResourceId
              ? eq(chatEndpointResources.providerResourceId, inferredResourceId)
              : sql`false`,
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    const slackChannelId =
      endpoint.provider === "slack"
        ? slackThreadChannelId(payload.threadId)
        : null;
    const isDirectMessage =
      conversation?.isDirectMessage === true ||
      resource?.type === "direct_message" ||
      Boolean(slackChannelId && /^D[A-Z0-9]+$/i.test(slackChannelId));
    const destinationAllowed = isDirectMessage
      ? endpoint.allowDirectMessages
      : nonDirectDestinationAllowed(endpoint, resource);
    if (payload.authorizationMode === "safe_notice") return true;
    if (!destinationAllowed) return false;
    if (!action.principalId) return false;
    return (
      await lockCurrentPrincipalAuthorization(tx, endpoint, action.principalId)
    ).allowed;
  }

  async function cancelUnauthorizedProviderEffect(
    tx: DbTransaction,
    action: typeof chatActions.$inferSelect,
    attempt: number,
  ): Promise<boolean> {
    await notifyChatActionWork(tx, "provider_effect");
    const [cancelled] = await tx
      .update(chatActions)
      .set({
        status: "cancelled",
        result: {
          attempts: attempt,
          code: "provider_effect_no_longer_authorized",
        },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatActions.id, action.id),
          eq(chatActions.status, "processing"),
          sql`(${chatActions.result}->>'attempts')::int = ${attempt}`,
        ),
      )
      .returning({ id: chatActions.id });
    if (!cancelled) return false;
    if (action.deliveryId) {
      await notifyChatDeliveryWork(tx);
      await tx
        .update(chatDeliveries)
        .set({
          state: "filtered",
          processedAt: new Date(),
          nextAttemptAt: null,
          redactedError:
            "Provider reply was suppressed because current chat authorization changed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatDeliveries.id, action.deliveryId),
            eq(chatDeliveries.state, "processing"),
          ),
        );
    }
    return true;
  }

  async function processProviderEffect(
    actionId: string,
    liveTarget?: ProviderEffectTarget,
  ): Promise<"processed" | "pending" | "failed" | "delivery_unknown"> {
    const initial = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "provider_effect"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!initial) return "failed";
    const initialEndpoint = await endpointRecord(initial.endpointId);
    if (!initialEndpoint) return "failed";

    const processClaimedEffect = async () => {
      let action = await db
        .select()
        .from(chatActions)
        .where(eq(chatActions.id, actionId))
        .then((rows) => rows[0] ?? null);
      if (!action) return "failed";
      const payload = providerEffectPayload(action.payload);
      if (!payload) {
        await db.transaction(async (tx) => {
          await notifyChatActionWork(tx, "provider_effect");
          return tx
            .update(chatActions)
            .set({
              status: "failed",
              result: { code: "provider_effect_payload_invalid" },
              updatedAt: new Date(),
            })
            .where(eq(chatActions.id, action.id));
        });
        return "failed";
      }
      if (action.status === "processed") return "processed";
      if (action.status === "delivery_unknown") return "delivery_unknown";
      if (action.status === "processing") {
        if (action.updatedAt > new Date(Date.now() - PROVIDER_EFFECT_STALE_MS))
          return "pending";
        await quarantineStaleProviderEffect(action);
        return "delivery_unknown";
      }
      if (action.status === "failed") {
        if (action.result?.retryable !== true) return "failed";
        const retryAt =
          typeof action.result.retryAt === "string"
            ? new Date(action.result.retryAt)
            : null;
        if (retryAt && retryAt > new Date()) return "pending";
      } else if (action.status !== "received") {
        return "failed";
      }

      const attempt =
        (typeof action.result?.attempts === "number"
          ? action.result.attempts
          : 0) + 1;
      const record = await endpointRecord(action.endpointId);
      let providerEffectCompleted = false;
      try {
        if (!record) {
          throw Object.assign(
            new Error("Chat endpoint is unavailable for this provider effect"),
            { code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED" },
          );
        }
        return await withCredentialMutationLease(
          record.endpoint,
          async (credentialLease) => {
            const claim = await db.transaction(async (tx) => {
              await credentialLease.assertOwned(tx);
              const currentAction = await tx
                .select()
                .from(chatActions)
                .where(
                  and(
                    eq(chatActions.id, action!.id),
                    eq(chatActions.kind, "provider_effect"),
                    eq(chatActions.status, action!.status),
                  ),
                )
                .for("update")
                .then((rows) => rows[0] ?? null);
              if (!currentAction) return null;
              const currentEndpoint = await runtimeCallbackEndpoint(
                tx,
                currentAction.endpointId,
                {
                  generation: payload.runtimeGeneration,
                  credentialFingerprint: payload.credentialFingerprint,
                },
                ["verifying", "active"],
              );
              const authorized = currentEndpoint
                ? await lockCurrentProviderEffectAuthorization(
                    tx,
                    currentAction,
                    currentEndpoint,
                    payload,
                  )
                : false;
              await notifyChatActionWork(tx, "provider_effect");
              const [transportClaim] = await tx
                .update(chatActions)
                .set({
                  status: "processing",
                  result: { attempts: attempt },
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatActions.id, currentAction.id),
                    eq(chatActions.status, currentAction.status),
                  ),
                )
                .returning();
              if (!transportClaim) return null;
              if (!currentEndpoint || !authorized) {
                const cancelled = await cancelUnauthorizedProviderEffect(
                  tx,
                  transportClaim,
                  attempt,
                );
                if (!cancelled) {
                  throw new Error(
                    "Provider effect ownership changed before authorization cancellation",
                  );
                }
                return { outcome: "cancelled" as const };
              }
              await credentialLease.assertOwned(tx);
              return {
                action: transportClaim,
                endpoint: currentEndpoint,
                outcome: "claimed" as const,
              };
            });
            if (!claim) return "pending";
            if (claim.outcome === "cancelled") return "failed";
            action = claim.action;

            // `processing` is the durable, single-owner transport claim and
            // authorization linearization point. Its transaction has committed
            // before provider I/O begins. The renewable credential lease keeps
            // runtime identity stable without holding database row locks.
            let sent: { id: string; threadId: string } | null = null;
            if (payload.effect === "telegram_callback_notice") {
              sent = await (
                await runtimeFor(claim.endpoint)
              ).sendTelegramCallbackNotice(
                payload.telegramCallback!,
                payload.text,
              );
            } else {
              const target =
                liveTarget ??
                (await runtimeFor(claim.endpoint)).thread(payload.threadId);
              if (payload.effect === "ephemeral_message") {
                if (!target.postEphemeral) {
                  if (!payload.fallbackText) {
                    throw Object.assign(
                      new Error("Provider does not support ephemeral messages"),
                      { code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED" },
                    );
                  }
                  sent = await target.post(payload.fallbackText);
                } else {
                  try {
                    sent = await target.postEphemeral(
                      payload.userId!,
                      payload.text,
                      { fallbackToDM: false },
                    );
                  } catch (error) {
                    if (
                      !payload.fallbackText ||
                      classifyChatPublicationError(error, attempt).kind !==
                        "failed"
                    ) {
                      throw error;
                    }
                  }
                  if (!sent && payload.fallbackText) {
                    sent = await target.post(payload.fallbackText);
                  }
                }
              } else if (claim.endpoint.provider === "imessage-photon") {
                const adapter = (await runtimeFor(claim.endpoint)).getProviderAdapter();
                if (!(adapter instanceof PhotonChatAdapter)) throw new Error("Photon runtime unavailable");
                const receipt = await adapter.publish(payload.threadId, `effect:${action.id}`, projectSafeChatPublicationText(payload.text), {
                  assertCurrent: async () => { await credentialLease.assertOwned(); },
                });
                sent = { id: receipt.id, threadId: payload.threadId };
              } else {
                sent = await target.post(payload.text);
              }
            }
            if (!sent) {
              throw Object.assign(
                new Error("Provider did not accept the message"),
                { code: "CHAT_PROVIDER_PRETRANSPORT_REJECTED" },
              );
            }
            providerEffectCompleted = true;
            await db.transaction(async (tx) => {
              await credentialLease.assertOwned(tx);
              // A duplicate webhook holds the endpoint while waiting for the
              // delivery's unique-index entry. Lock this endpoint first too,
              // before settling the action/conversation/delivery, so neither
              // transaction can wait on a row already held by the other.
              const currentEndpoint = await runtimeCallbackEndpoint(
                tx,
                claim.endpoint.id,
                {
                  generation: payload.runtimeGeneration,
                  credentialFingerprint: payload.credentialFingerprint,
                },
                ["verifying", "active"],
              );
              await notifyChatActionWork(tx, "provider_effect");
              const [completed] = await tx
                .update(chatActions)
                .set({
                  status: "processed",
                  result: {
                    attempts: attempt,
                    providerMessageId: sent.id,
                    threadId: sent.threadId,
                    ...(payload.effect === "telegram_callback_notice"
                      ? {
                          code:
                            payload.telegramCallback?.chatType === "private"
                              ? "telegram_private_api_accepted"
                              : "telegram_ephemeral_api_accepted",
                        }
                      : {}),
                  },
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatActions.id, action!.id),
                    eq(chatActions.status, "processing"),
                    sql`(${chatActions.result}->>'attempts')::int = ${attempt}`,
                  ),
                )
                .returning({ id: chatActions.id });
              if (!completed) {
                throw new Error(
                  "Provider effect ownership changed before commit",
                );
              }
              if (payload.completeConversationId) {
                await tx
                  .update(chatConversations)
                  .set({ state: "completed", updatedAt: new Date() })
                  .where(
                    and(
                      eq(chatConversations.id, payload.completeConversationId),
                      eq(chatConversations.endpointId, claim.endpoint.id),
                      inArray(chatConversations.state, ["active", "waiting"]),
                    ),
                  );
              }
              if (payload.settleDelivery && action!.deliveryId) {
                await notifyChatDeliveryWork(tx);
                const [settled] = await tx
                  .update(chatDeliveries)
                  .set({
                    state: "processed",
                    processedAt: new Date(),
                    nextAttemptAt: null,
                    redactedError: null,
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(chatDeliveries.id, action!.deliveryId),
                      eq(chatDeliveries.state, "processing"),
                    ),
                  )
                  .returning({ id: chatDeliveries.id });
                if (!settled) {
                  throw new Error(
                    "Provider effect delivery ownership changed before commit",
                  );
                }
              }
              if (currentEndpoint) {
                await tx
                  .update(chatEndpoints)
                  .set({ lastEventAt: new Date(), updatedAt: new Date() })
                  .where(eq(chatEndpoints.id, currentEndpoint.id));
              }
              await credentialLease.assertOwned(tx);
            });
            return "processed";
          },
        );
      } catch (error) {
        const disposition = providerEffectDisposition(
          error,
          attempt,
          providerEffectCompleted,
        );
        try {
          await finalizeProviderEffectFailure({
            action,
            endpoint: record?.endpoint ?? initialEndpoint.endpoint,
            payload,
            disposition,
            attempt,
          });
        } catch (finalizationError) {
          if (disposition.kind === "delivery_unknown") {
            throw Object.assign(
              new Error(
                "Provider effect is ambiguous and its durable quarantine failed",
                { cause: finalizationError },
              ),
              { code: "CHAT_PROVIDER_EFFECT_AMBIGUOUS" },
            );
          }
          throw finalizationError;
        }
        throw error;
      }
    };
    return processClaimedEffect();
  }

  async function processPendingProviderEffects(limit = 25) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - PROVIDER_EFFECT_STALE_MS);
    const actions = await db
      .select()
      .from(chatActions)
      .where(dueChatAction("provider_effect", now.getTime()))
      .orderBy(asc(chatActions.createdAt))
      .limit(limit);
    for (const action of actions) {
      if (action.status === "processing" && action.updatedAt <= staleBefore) {
        await quarantineStaleProviderEffect(action);
        continue;
      }
      try {
        await processProviderEffect(action.id);
      } catch (error) {
        logger.warn(
          {
            endpointId: action.endpointId,
            actionId: action.id,
            error: redactError(error),
          },
          "chat provider effect reconciliation failed",
        );
      }
    }
    return actions.length;
  }
  return { stageProviderEffect, processProviderEffect, processPendingProviderEffects };
}
