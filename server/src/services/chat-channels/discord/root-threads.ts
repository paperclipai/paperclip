import type { EndpointRow, DbTransaction, DbOrTransaction, RuntimeContext, LifecycleRuntimeFence, InboundRuntimeContext } from "../runtime-types.js";

import { notifyChatDeliveryWork } from "../../chat-work-notifications.js";

import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";

import { chatCredentialMutationLease } from "../../chat-credential-mutation-lease.js";

import {
  createHash,
} from "node:crypto";
import {
  and,
  eq,
  inArray,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  companyMemberships,
} from "@paperclipai/db";

import {
  conflict,
} from "../../../errors.js";
import { logger } from "../../../middleware/logger.js";

import {
  DiscordAdapterCompatibilityError,
  type ChatSdkMessageCallbackEvent,
  type DiscordRootMentionAdmissionEvent,
} from "../../chat-sdk-runtime.js";

import { classifyChatPublicationError } from "../../chat-publication-errors.js";

import type {
  Message,
  Thread,
} from "chat";

type DeliveryRow = typeof chatDeliveries.$inferSelect;

type DiscordRootThreadsOptions = {
  ensureDiscordGatewayRuntimeIsCurrent: (endpointId: string, context: RuntimeContext) => Promise<boolean>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  lockCurrentPrincipalAuthorization: (tx: DbOrTransaction, endpoint: EndpointRow, principalId: string) => Promise<{ allowed: boolean; linkedDenied: boolean }>;
  processMessage: (endpoint: EndpointRow, thread: Thread, message: Message, trigger: ChatSdkMessageCallbackEvent["trigger"], ingressOnly?: boolean, recoveredProviderUrl?: string | null, runtimeContext?: InboundRuntimeContext, providerUpdateId?: number, admittedDeliveryId?: string | null, receiptReactionSupported?: boolean, preauthorizedUserId?: string | null, deferDrainUntilFollowup?: boolean) => Promise<void>;
  redactError: (error: unknown) => string;
  scheduleConversationDrain: (endpointId: string, threadId: string) => void;
  lifecycleRuntimeFence: (delivery: DeliveryRow) => LifecycleRuntimeFence | null;
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  DISCORD_ROOT_THREAD_CONFIRMATION_DELAY_MS: number;
  discordRootThreadTransportBarrier?: () => Promise<void>;
};

export function createDiscordRootThreads(db: Db, options: DiscordRootThreadsOptions) {
  const { ensureDiscordGatewayRuntimeIsCurrent, withCredentialMutationLease, runtimeCallbackEndpoint, lockCurrentPrincipalAuthorization, processMessage, redactError, scheduleConversationDrain, lifecycleRuntimeFence, runtimeFor, DISCORD_ROOT_THREAD_CONFIRMATION_DELAY_MS } = options;


  async function admitDiscordRootMention(
    configuredEndpoint: EndpointRow,
    event: DiscordRootMentionAdmissionEvent,
    context: RuntimeContext,
  ): Promise<boolean> {
    if (
      !(await ensureDiscordGatewayRuntimeIsCurrent(
        configuredEndpoint.id,
        context,
      ))
    ) {
      return false;
    }
    return withCredentialMutationLease(
      configuredEndpoint,
      async (credentialLease) => {
        const threadId = `discord:${event.guildId}:${event.channelId}:${event.messageId}`;
        const providerEventId = `${threadId}:${event.messageId}`;
        const allowed = await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          const endpoint = await runtimeCallbackEndpoint(
            tx,
            configuredEndpoint.id,
            context,
            ["verifying", "active"],
          );
          const existing = await tx
            .select({ state: chatDeliveries.state })
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.endpointId, configuredEndpoint.id),
                eq(chatDeliveries.providerEventId, providerEventId),
              ),
            )
            .then((rows) => rows[0] ?? null);
          if (
            existing &&
            ["processed", "filtered", "failed"].includes(existing.state)
          )
            return false;

          let reason: string | null = null;
          if (!endpoint || endpoint.providerAccountId !== event.guildId) {
            reason = "Connection is not active";
          }
          const resource = endpoint
            ? await tx
                .select()
                .from(chatEndpointResources)
                .where(
                  and(
                    eq(chatEndpointResources.endpointId, endpoint.id),
                    eq(chatEndpointResources.type, "channel"),
                    eq(
                      chatEndpointResources.providerResourceId,
                      event.channelId,
                    ),
                  ),
                )
                .for("update")
                .then((rows) => rows[0] ?? null)
            : null;
          const enabledCount =
            endpoint?.status === "verifying"
              ? await tx
                  .select({ count: sql<number>`count(*)::int` })
                  .from(chatEndpointResources)
                  .where(
                    and(
                      eq(chatEndpointResources.endpointId, endpoint.id),
                      eq(chatEndpointResources.type, "channel"),
                      eq(chatEndpointResources.enabled, true),
                      eq(chatEndpointResources.availability, "available"),
                    ),
                  )
                  .then((rows) => rows[0]?.count ?? 0)
              : 0;
          const setupDestination =
            endpoint?.status === "verifying" &&
            enabledCount === 0 &&
            resource?.availability === "available";
          if (
            !reason &&
            !(
              endpoint?.allowGroupChats &&
              resource?.availability === "available" &&
              (resource.enabled || setupDestination)
            )
          ) {
            reason = "Destination is not enabled in Paperclip";
          }

          if (!reason && endpoint) {
            const principal = await tx
              .select({ id: chatExternalPrincipals.id })
              .from(chatExternalPrincipals)
              .where(
                and(
                  eq(chatExternalPrincipals.companyId, endpoint.companyId),
                  eq(chatExternalPrincipals.provider, "discord"),
                  eq(chatExternalPrincipals.providerAccountId, event.guildId),
                  eq(chatExternalPrincipals.externalId, event.userId),
                ),
              )
              .then((rows) => rows[0] ?? null);
            let allowed: boolean;
            let linkedDenied = false;
            if (principal) {
              const authorization = await lockCurrentPrincipalAuthorization(
                tx,
                endpoint,
                principal.id,
              );
              allowed = authorization.allowed;
              linkedDenied = authorization.linkedDenied;
            } else if (!endpoint.allowUnlinkedPeople) {
              allowed = false;
            } else if (!endpoint.sponsorUserId) {
              allowed = true;
            } else {
              const sponsor = await tx
                .select({
                  status: companyMemberships.status,
                  membershipRole: companyMemberships.membershipRole,
                })
                .from(companyMemberships)
                .where(
                  and(
                    eq(companyMemberships.companyId, endpoint.companyId),
                    eq(companyMemberships.principalType, "user"),
                    eq(companyMemberships.principalId, endpoint.sponsorUserId),
                  ),
                )
                .for("update")
                .then((rows) => rows[0] ?? null);
              allowed =
                sponsor?.status === "active" &&
                sponsor.membershipRole !== "viewer";
            }
            if (!allowed) {
              reason = linkedDenied
                ? "Linked Paperclip account is not currently permitted"
                : endpoint.allowUnlinkedPeople
                  ? "Endpoint sponsor can no longer authorize external guests"
                  : "External identity must be linked to a Paperclip account";
            }
          }
          if (!reason) {
            await credentialLease.assertOwned(tx);
            return true;
          }

          const filteredAt = new Date();
          const normalizedEvent = {
            providerEventId,
            kind: "mention",
            trigger: "mention",
            resource: {
              type: "channel",
              providerResourceId: event.channelId,
            },
            conversation: { externalThreadId: threadId },
            message: { providerMessageId: event.messageId },
            filtering: { contentRetained: false, providerThreadCreated: false },
          };
          await notifyChatDeliveryWork(tx);
          await tx
            .insert(chatDeliveries)
            .values({
              companyId: configuredEndpoint.companyId,
              endpointId: configuredEndpoint.id,
              providerEventId,
              deduplicationKey: createHash("sha256")
                .update(providerEventId)
                .digest("hex"),
              eventKind: "mention",
              normalizedEvent,
              state: "filtered",
              redactedError: reason,
              processedAt: filteredAt,
            })
            .onConflictDoUpdate({
              target: [
                chatDeliveries.endpointId,
                chatDeliveries.providerEventId,
              ],
              set: {
                normalizedEvent,
                principalId: null,
                state: "filtered",
                nextAttemptAt: null,
                redactedError: reason,
                processedAt: filteredAt,
                updatedAt: filteredAt,
              },
            });
          await tx
            .update(chatEndpoints)
            .set({ lastEventAt: filteredAt, updatedAt: filteredAt })
            .where(eq(chatEndpoints.id, configuredEndpoint.id));
          await credentialLease.assertOwned(tx);
          return false;
        });
        if (!allowed || !event.message || !context.endpointRuntime) {
          return false;
        }
        const thread = context.endpointRuntime.thread(event.threadId);
        await processMessage(
          configuredEndpoint,
          thread,
          event.message,
          "mention",
          true,
          null,
          context,
          undefined,
          null,
          true,
          undefined,
          true,
        );
        const staged = await db
          .select({ state: chatDeliveries.state })
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, configuredEndpoint.id),
              eq(chatDeliveries.providerEventId, providerEventId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (
          !staged ||
          !["received", "retry", "processing"].includes(staged.state)
        ) {
          return false;
        }

        await options.discordRootThreadTransportBarrier?.();
        await credentialLease.assertOwned();
        if (
          !(await ensureDiscordGatewayRuntimeIsCurrent(
            configuredEndpoint.id,
            context,
          ))
        ) {
          return false;
        }
        try {
          await context.endpointRuntime.ensureDiscordRootThread({
            channelId: event.channelId,
            content: event.message.text,
            messageId: event.messageId,
          });
        } catch (error) {
          // The durable provisional receipt owns recovery. Do not let a
          // transient REST failure escape the Gateway event handler or ask the
          // adapter to create the same thread outside Paperclip's lifecycle
          // fence.
          logger.warn(
            {
              endpointId: configuredEndpoint.id,
              error: redactError(error),
              providerEventId,
            },
            "Discord root thread creation will be retried from the durable receipt",
          );
          return false;
        }
        const promoted = await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          const current = await runtimeCallbackEndpoint(
            tx,
            configuredEndpoint.id,
            context,
            ["verifying", "active"],
          );
          if (!current) return false;
          await notifyChatDeliveryWork(tx);
          const [row] = await tx
            .update(chatDeliveries)
            .set({
              state: "received",
              normalizedEvent: sql`${chatDeliveries.normalizedEvent} - 'providerThreadPending'`,
              nextAttemptAt: null,
              redactedError: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatDeliveries.endpointId, configuredEndpoint.id),
                eq(chatDeliveries.providerEventId, providerEventId),
                eq(chatDeliveries.state, "retry"),
                sql`${chatDeliveries.normalizedEvent}->>'providerThreadPending' = 'true'`,
              ),
            )
            .returning({ id: chatDeliveries.id });
          await credentialLease.assertOwned(tx);
          return Boolean(row);
        });
        if (promoted)
          scheduleConversationDrain(configuredEndpoint.id, threadId);
        // Paperclip created the provider thread inside its credential/reach
        // lease. Returning false prevents the adapter from creating it again;
        // the durable drain owns the remaining task mutation.
        return false;
      },
    );
  }

  function discordRootThreadPending(
    delivery: Pick<DeliveryRow, "normalizedEvent">,
  ): boolean {
    return (
      Boolean(delivery.normalizedEvent) &&
      typeof delivery.normalizedEvent === "object" &&
      !Array.isArray(delivery.normalizedEvent) &&
      (delivery.normalizedEvent as { providerThreadPending?: unknown })
        .providerThreadPending === true
    );
  }

  async function reconcileDiscordRootThread(
    endpoint: EndpointRow,
    delivery: DeliveryRow,
    threadId: string,
  ): Promise<boolean> {
    try {
      const normalized = delivery.normalizedEvent as {
        message?: { providerMessageId?: unknown; text?: unknown };
        resource?: { providerResourceId?: unknown };
      };
      const discordThreadParts = threadId.split(":");
      const channelId =
        discordThreadParts[0] === "discord" && discordThreadParts.length >= 4
          ? discordThreadParts[2]
          : normalized.resource?.providerResourceId;
      const messageId = normalized.message?.providerMessageId;
      if (typeof channelId !== "string" || typeof messageId !== "string") {
        throw new DiscordAdapterCompatibilityError(
          "the provisional root receipt is missing its channel or message id",
        );
      }
      const runtimeFence = lifecycleRuntimeFence(delivery);
      if (!runtimeFence) {
        throw new DiscordAdapterCompatibilityError(
          "the provisional root receipt is missing its runtime fence",
        );
      }
      return await withCredentialMutationLease(
        endpoint,
        async (credentialLease) => {
          const currentEndpoint = await db.transaction(async (tx) => {
            await credentialLease.assertOwned(tx);
            const current = await runtimeCallbackEndpoint(
              tx,
              endpoint.id,
              runtimeFence,
              ["verifying", "active"],
            );
            await credentialLease.assertOwned(tx);
            return current;
          });
          if (!currentEndpoint) {
            throw conflict(
              "Discord root thread credentials or connection state changed before recovery",
              { code: "chat_endpoint_runtime_superseded" },
            );
          }
          const endpointRuntime = await runtimeFor(currentEndpoint);
          await credentialLease.assertOwned();
          await endpointRuntime.ensureDiscordRootThread({
            channelId,
            messageId,
            content:
              typeof normalized.message?.text === "string"
                ? normalized.message.text
                : "Paperclip task",
          });
          return await db.transaction(async (tx) => {
            await credentialLease.assertOwned(tx);
            const current = await runtimeCallbackEndpoint(
              tx,
              endpoint.id,
              runtimeFence,
              ["verifying", "active"],
            );
            if (!current) return false;
            await notifyChatDeliveryWork(tx);
            const [promoted] = await tx
              .update(chatDeliveries)
              .set({
                state: "received",
                normalizedEvent: sql`${chatDeliveries.normalizedEvent} - 'providerThreadPending'`,
                nextAttemptAt: null,
                redactedError: null,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatDeliveries.id, delivery.id),
                  eq(chatDeliveries.state, "retry"),
                  sql`${chatDeliveries.normalizedEvent}->>'providerThreadPending' = 'true'`,
                ),
              )
              .returning({ id: chatDeliveries.id });
            await credentialLease.assertOwned(tx);
            return Boolean(promoted);
          });
        },
      );
    } catch (error) {
      const disposition = classifyChatPublicationError(
        error,
        delivery.attempts + 1,
      );
      const terminal =
        disposition.kind === "resource_unavailable" ||
        disposition.kind === "failed";
      const retryAfterMs =
        disposition.kind === "retry"
          ? disposition.retryAfterMs
          : DISCORD_ROOT_THREAD_CONFIRMATION_DELAY_MS;
      const now = new Date();
      await db.transaction(async (tx) => {
        if (disposition.kind === "resource_unavailable") {
          const fence = lifecycleRuntimeFence(delivery);
          const normalized = delivery.normalizedEvent as {
            resource?: { providerResourceId?: unknown };
          };
          const providerResourceId = normalized.resource?.providerResourceId;
          const current = fence
            ? await runtimeCallbackEndpoint(tx, endpoint.id, fence, [
                "verifying",
                "active",
                "attention",
              ])
            : null;
          const resource =
            current && typeof providerResourceId === "string"
              ? await tx
                  .select({ id: chatEndpointResources.id })
                  .from(chatEndpointResources)
                  .where(
                    and(
                      eq(chatEndpointResources.companyId, current.companyId),
                      eq(chatEndpointResources.endpointId, current.id),
                      eq(
                        chatEndpointResources.providerResourceId,
                        providerResourceId,
                      ),
                    ),
                  )
                  .for("update")
                  .then((rows) => rows[0] ?? null)
              : null;
          if (resource) {
            await tx
              .update(chatEndpointResources)
              .set({ availability: "unavailable", updatedAt: now })
              .where(eq(chatEndpointResources.id, resource.id));
            await tx
              .update(chatConversations)
              .set({ state: "unavailable", updatedAt: now })
              .where(
                and(
                  eq(chatConversations.companyId, current!.companyId),
                  eq(chatConversations.endpointId, current!.id),
                  eq(chatConversations.resourceId, resource.id),
                  inArray(chatConversations.state, ["active", "waiting"]),
                ),
              );
          }
        }
        await notifyChatDeliveryWork(tx);
        await tx
          .update(chatDeliveries)
          .set({
            state: terminal ? "filtered" : "retry",
            attempts: delivery.attempts + 1,
            nextAttemptAt: terminal
              ? null
              : new Date(now.getTime() + retryAfterMs),
            processedAt: terminal ? now : null,
            redactedError: terminal
              ? "Discord thread creation was not confirmed"
              : redactError(error),
            updatedAt: now,
          })
          .where(
            and(
              eq(chatDeliveries.id, delivery.id),
              eq(chatDeliveries.state, "retry"),
              sql`${chatDeliveries.normalizedEvent}->>'providerThreadPending' = 'true'`,
            ),
          );
      });
      return false;
    }
  }
  return { admitDiscordRootMention, discordRootThreadPending, reconcileDiscordRootThread };
}
