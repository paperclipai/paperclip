import { notifyChatReceiver } from "../runtime/receiver-work-notifications.js";
import { notifyDiscordCommandRegistration } from "./command-work-notifications.js";
import type { EndpointRow, DbTransaction, RuntimeContext, LifecycleRuntimeFence, InternalSetupState } from "../runtime-types.js";

import { notifyChatEndpointWork } from "../../chat-work-notifications.js";

import {
  and,
  eq,
  inArray,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatEndpointSetupState,
} from "@paperclipai/shared";

import {
  type DiscordGatewayCallbackEvent,
} from "../../chat-sdk-runtime.js";

import {
  type ChatProviderLifecycleEffect,
} from "../../chat-provider-lifecycle.js";

import type { EndpointRecord } from "../runtime-types.js";

type DiscordGatewayEventsOptions = {
  ensureDiscordGatewayRuntimeIsCurrent: (endpointId: string, context: RuntimeContext) => Promise<boolean>;
  discordGatewayRuntimeIsCurrent: (endpointId: string, context: RuntimeContext) => boolean;
  runtimeCallbackRecord: (endpointId: string, context: RuntimeContext, statuses: EndpointRow["status"][]) => Promise<EndpointRecord | null>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  applyProviderLifecycleEffect: (endpoint: EndpointRow, effect: ChatProviderLifecycleEffect, context?: RuntimeContext) => Promise<boolean>;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  discordGatewayEventBarrier?: (event: DiscordGatewayCallbackEvent) => Promise<void>;
};

export function createDiscordGatewayEvents(db: Db, options: DiscordGatewayEventsOptions) {
  const { ensureDiscordGatewayRuntimeIsCurrent, discordGatewayRuntimeIsCurrent, runtimeCallbackRecord, runtimeCallbackEndpoint, applyProviderLifecycleEffect, runtimeGeneration } = options;


  function discordGatewayFailureDetail(
    event: DiscordGatewayCallbackEvent["event"],
  ): string {
    if (event.type === "guild_removed") {
      return "Discord bot was removed from the configured server";
    }
    if (event.type === "guild_unavailable") {
      return "Discord server is temporarily unavailable; reconnecting";
    }
    if (event.type === "disconnected") {
      return `Discord Gateway disconnected${event.code === undefined ? "" : ` (code ${event.code})`}; reconnecting`;
    }
    if (event.type === "failure") {
      const code = event.error.code ?? event.error.status;
      return `Discord Gateway failed${code === undefined ? "" : ` (${String(code).slice(0, 64)})`}; ${event.fatal ? "credentials or privileged intents need attention" : "reconnecting"}`;
    }
    return "Discord Gateway connection needs attention";
  }

  function handleDiscordGatewayEvent(
    callback: DiscordGatewayCallbackEvent,
    context: RuntimeContext,
  ): Promise<void> {
    const pending = (context.discordGatewayEventQueue ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => processDiscordGatewayEvent(callback, context));
    context.discordGatewayEventQueue = pending;
    return pending;
  }

  async function processDiscordGatewayEvent(
    callback: DiscordGatewayCallbackEvent,
    context: RuntimeContext,
  ): Promise<void> {
    if (
      !(await ensureDiscordGatewayRuntimeIsCurrent(
        callback.endpointId,
        context,
      ))
    )
      return;
    if (callback.sequence <= (context.discordGatewaySequence ?? 0)) return;
    context.discordGatewaySequence = callback.sequence;
    await options.discordGatewayEventBarrier?.(callback);
    const record = await runtimeCallbackRecord(callback.endpointId, context, [
      "verifying",
      "active",
      "attention",
    ]);
    if (!record || record.endpoint.provider !== "discord") return;
    const event = callback.event;
    if (event.type === "channel_removed") {
      await applyProviderLifecycleEffect(
        record.endpoint,
        {
          kind: "resource",
          provider: "discord",
          providerEventId: `gateway:channel_removed:${event.channelId}`,
          providerResourceId: event.channelId,
          resourceType: "channel",
          label: event.label?.trim() || event.channelId,
          availability: "removed",
          metadata: { source: "discord_gateway" },
        },
        context,
      );
      return;
    }

    await db.transaction(async (tx) => {
      const current = await runtimeCallbackEndpoint(
        tx,
        callback.endpointId,
        context,
        ["verifying", "active", "attention"],
      );
      if (
        !current ||
        current.provider !== "discord" ||
        !discordGatewayRuntimeIsCurrent(callback.endpointId, context)
      ) {
        return;
      }
      const now = new Date();
      if (event.type === "connecting") {
        if (current.status === "attention") {
          await notifyChatReceiver(tx, current);
          await notifyDiscordCommandRegistration(tx, { kind: "endpoint", id: current.id });
        }
        await tx
          .update(chatEndpoints)
          .set({
            healthMessage: "Discord Gateway connecting",
            lastError: null,
            lastEventAt: now,
            updatedAt: now,
          })
          .where(eq(chatEndpoints.id, current.id));
        await tx
          .update(toolConnections)
          .set({
            healthStatus: "unchecked",
            healthMessage: "Discord Gateway connecting",
            lastError: null,
            healthCheckedAt: now,
            updatedAt: now,
          })
          .where(eq(toolConnections.id, current.connectionId));
        return;
      }
      if (event.type === "ready" || event.type === "guild_available") {
        const gatewayOwnedAttention =
          current.status === "attention" &&
          current.healthMessage?.startsWith("Discord ") === true;
        if (current.status === "attention" && !gatewayOwnedAttention) return;
        const status =
          current.setup.step === "complete" ? "active" : "verifying";
        await notifyChatReceiver(tx, current);
        await notifyDiscordCommandRegistration(tx, { kind: "endpoint", id: current.id });
        if (status !== current.status) await notifyChatEndpointWork(tx, current.connectionId, current.companyId);
        await tx
          .update(chatEndpoints)
          .set({
            status,
            healthMessage:
              status === "active"
                ? "Connected"
                : "Waiting for a test conversation",
            lastError: null,
            lastEventAt: now,
            updatedAt: now,
          })
          .where(eq(chatEndpoints.id, current.id));
        await tx
          .update(toolConnections)
          .set({
            status: "active",
            enabled: true,
            healthStatus: "healthy",
            healthMessage: "Connected",
            lastError: null,
            healthCheckedAt: now,
            updatedAt: now,
          })
          .where(eq(toolConnections.id, current.connectionId));
        return;
      }

      await notifyChatReceiver(tx, current);
      await notifyDiscordCommandRegistration(tx, { kind: "endpoint", id: current.id });
      const detail = discordGatewayFailureDetail(event);
      const transientGuildOutage = event.type === "guild_unavailable";
      const terminal =
        event.type === "guild_removed" ||
        ((event.type === "failure" || event.type === "disconnected") &&
          event.fatal);
      await tx
        .update(chatEndpoints)
        .set({
          status: transientGuildOutage
            ? current.status
            : event.type === "guild_removed"
              ? "revoked"
              : "attention",
          healthMessage: detail,
          lastError: detail,
          lastEventAt: now,
          ...(terminal
            ? {
                setup: {
                  ...current.setup,
                  runtimeGeneration: runtimeGeneration(current.setup) + 1,
                } as InternalSetupState,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(chatEndpoints.id, current.id));
      await tx
        .update(toolConnections)
        .set({
          status: terminal ? "disabled" : "active",
          enabled: !terminal,
          healthStatus: event.type === "guild_removed" ? "failed" : "degraded",
          healthMessage: detail,
          lastError: detail,
          healthCheckedAt: now,
          updatedAt: now,
        })
        .where(eq(toolConnections.id, current.connectionId));
      if (event.type === "guild_removed") {
        await tx
          .update(chatEndpointResources)
          .set({ availability: "unavailable", updatedAt: now })
          .where(
            and(
              eq(chatEndpointResources.companyId, current.companyId),
              eq(chatEndpointResources.endpointId, current.id),
            ),
          );
        await tx
          .update(chatConversations)
          .set({ state: "unavailable", updatedAt: now })
          .where(
            and(
              eq(chatConversations.companyId, current.companyId),
              eq(chatConversations.endpointId, current.id),
              inArray(chatConversations.state, ["active", "waiting"]),
            ),
          );
      }
    });
  }
  return { handleDiscordGatewayEvent };
}
