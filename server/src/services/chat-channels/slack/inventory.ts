import type { EndpointRow, EndpointRecord } from "../runtime-types.js";

import { slackResourceLabelIsFallback } from "./resources.js";

import {
  and,
  eq,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatEndpointResources,
} from "@paperclipai/db";

import { getSlackBotChannel, listSlackBotChannels } from "../../chat-provider-inventory.js";

import type { PreparedProviderInventory } from "../runtime-types.js";

export async function prepareSlackInventory(credentials: Record<string,string>, fetchImpl: typeof fetch): Promise<PreparedProviderInventory> {
  return {
    credentials,
    inventory: await listSlackBotChannels({
      botToken: credentials.botToken,
      fetch: fetchImpl,
    }),
  };
}


type SlackInventoryOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  resolveCredentials: (endpoint: EndpointRow) => Promise<Record<string, string>>;
  fetchImpl: typeof fetch;
};

export function createSlackInventory(db: Db, options: SlackInventoryOptions) {
  const { endpointRecord, resolveCredentials, fetchImpl } = options;


  async function hydrateSlackResourceLabel(
    endpointId: string,
    providerResourceId: string,
  ): Promise<void> {
    const record = await endpointRecord(endpointId);
    if (
      !record ||
      record.endpoint.provider !== "slack" ||
      record.endpoint.status === "archived" ||
      record.endpoint.status === "revoked"
    ) {
      return;
    }
    const credentials = await resolveCredentials(record.endpoint);
    const resource = await getSlackBotChannel({
      botToken: credentials.botToken,
      channelId: providerResourceId,
      fetch: fetchImpl,
    });
    if (
      !resource ||
      slackResourceLabelIsFallback(providerResourceId, resource.label)
    )
      return;
    await db
      .update(chatEndpointResources)
      .set({ label: resource.label, updatedAt: new Date() })
      .where(
        and(
          eq(chatEndpointResources.companyId, record.endpoint.companyId),
          eq(chatEndpointResources.endpointId, endpointId),
          eq(chatEndpointResources.type, "channel"),
          eq(chatEndpointResources.providerResourceId, providerResourceId),
          eq(chatEndpointResources.availability, "available"),
        ),
      );
  }
  return { hydrateSlackResourceLabel };
}
