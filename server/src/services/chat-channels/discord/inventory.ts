import {
  listDiscordBotChannels,
} from "../../chat-discord.js";

import type { PreparedProviderInventory } from "../runtime-types.js";

export async function prepareDiscordInventory(credentials: Record<string,string>, fetchImpl: typeof fetch): Promise<PreparedProviderInventory> {
  return {
    credentials,
    inventory: await listDiscordBotChannels({
      botUserId: credentials.applicationId,
      botToken: credentials.botToken,
      fetch: fetchImpl,
      guildId: credentials.guildId,
    }),
  };
}
