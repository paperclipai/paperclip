import { and, eq, inArray } from "drizzle-orm";
import { chatConversations, chatEndpointResources, chatEndpoints, type Db } from "@paperclipai/db";

import type { ConnectionManagementContext } from "../../connection-management.js";
import type { chatCredentialMutationLease } from "../../chat-credential-mutation-lease.js";
import type { createChatResourceReconciliation } from "../resource-reconciliation.js";
import type { EndpointRecord, EndpointRow, PreparedProviderInventory } from "../runtime-types.js";

import { conflict, notFound } from "../../../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "../../activity-log.js";

type DiscordChannelRefreshOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  resolveCredentials: (endpoint: EndpointRow) => Promise<Record<string, string>>;
  prepareProviderInventory: (endpoint: EndpointRow, credentials: Record<string, string>) => Promise<PreparedProviderInventory>;
  reconcileProviderResourceRows: ReturnType<typeof createChatResourceReconciliation>["reconcileProviderResourceRows"];
  listResources: ReturnType<typeof createChatResourceReconciliation>["listResources"];
};

export function createDiscordChannelRefresh(db: Db, options: DiscordChannelRefreshOptions) {
  const { endpointRecord, withCredentialMutationLease, resolveCredentials, prepareProviderInventory, reconcileProviderResourceRows, listResources } = options;

  // Re-reads the Discord Bot REST channel inventory and reconciles it into stored destinations.
  async function refreshDiscordChannels(endpointId: string, userId: string | null, managementContext?: ConnectionManagementContext) {
    await managementContext?.reauthorize();
    const initial = await endpointRecord(endpointId);
    if (!initial || initial.endpoint.provider !== "discord") throw notFound("Discord bot not found");
    await withCredentialMutationLease(initial.endpoint, async lease => {
      const record = await endpointRecord(endpointId);
      if (!record) throw notFound("Discord bot not found");
      if (["archived", "paused"].includes(record.endpoint.status)) throw conflict("Resume the Discord bot before refreshing its channels");
      const credentials = await resolveCredentials(record.endpoint);
      const prepared = await prepareProviderInventory(record.endpoint, credentials);
      await managementContext?.reauthorize();
      if (prepared.inventory) await reconcileProviderResourceRows(record.endpoint, prepared.inventory, lease);
      await lease.assertOwned();
      await logActivity(db, {
        companyId: record.endpoint.companyId,
        ...(managementContext?.audit ?? (userId ? { actorType: "user" as const, actorId: userId } : { actorType: "system" as const, actorId: "system" })),
        action: "chat_discord.channels_refreshed", entityType: "tool_connection", entityId: record.endpoint.connectionId,
        details: { endpointId, channelCount: prepared.inventory?.resources.length ?? 0 },
      });
    });
    return listResources(endpointId);
  }

  // Deletes a disabled channel Discord no longer reports, detaching its conversation history.
  async function removeUnavailableDiscordChannel(endpointId: string, resourceId: string, userId: string | null, managementContext?: ConnectionManagementContext) {
    await managementContext?.reauthorize();
    const initial = await endpointRecord(endpointId);
    if (!initial || initial.endpoint.provider !== "discord") throw notFound("Discord bot not found");
    await withCredentialMutationLease(initial.endpoint, async lease => {
      const publications: ActivityPublication[] = [];
      await db.transaction(async tx => {
        await lease.assertOwned(tx);
        const [endpoint] = await tx.select({ companyId: chatEndpoints.companyId, connectionId: chatEndpoints.connectionId })
          .from(chatEndpoints)
          .where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.companyId, initial.endpoint.companyId)))
          .for("no key update");
        if (!endpoint) throw notFound("Discord bot not found");
        const [resource] = await tx.select().from(chatEndpointResources)
          .where(and(
            eq(chatEndpointResources.companyId, endpoint.companyId),
            eq(chatEndpointResources.endpointId, endpointId),
            eq(chatEndpointResources.id, resourceId),
            eq(chatEndpointResources.type, "channel"),
          ))
          .for("update");
        if (!resource) throw notFound("Discord channel not found");
        if (resource.availability === "available" || resource.enabled)
          throw conflict("Only a disabled channel that Discord no longer reports can be removed", { code: "chat_resource_removal_refused", resourceId });
        const conversationScope = and(
          eq(chatConversations.companyId, endpoint.companyId),
          eq(chatConversations.endpointId, endpointId),
          eq(chatConversations.resourceId, resourceId),
        );
        const now = new Date();
        await tx.update(chatConversations).set({ state: "unavailable", updatedAt: now })
          .where(and(conversationScope, inArray(chatConversations.state, ["active", "waiting"])));
        const detached = await tx.update(chatConversations).set({ resourceId: null, updatedAt: now })
          .where(conversationScope).returning({ id: chatConversations.id });
        await tx.delete(chatEndpointResources).where(eq(chatEndpointResources.id, resourceId));
        await logActivity(tx as unknown as Db, {
          companyId: endpoint.companyId,
          ...(managementContext?.audit ?? (userId ? { actorType: "user" as const, actorId: userId } : { actorType: "system" as const, actorId: "system" })),
          action: "chat_discord.channel_removed", entityType: "tool_connection", entityId: endpoint.connectionId,
          details: {
            endpointId, resourceId, providerResourceId: resource.providerResourceId, label: resource.label,
            availability: resource.availability, detachedConversationCount: detached.length,
          },
        }, publications);
        await lease.assertOwned(tx);
      });
      for (const publication of publications) publishActivity(publication);
    });
    return listResources(endpointId);
  }

  return { refreshDiscordChannels, removeUnavailableDiscordChannel };
}
