import {
  unprocessable,
} from "../../../errors.js";

import {
  verifyDiscordBot,
} from "../../chat-discord.js";

import type { VerifiedProviderIdentity } from "../runtime-types.js";

export async function verifyDiscordCredentials(
  credentials: Record<string, string>,
  fetchImpl: typeof fetch,
  redactError: (error: unknown) => string,
): Promise<VerifiedProviderIdentity> {
  const identity = await verifyDiscordBot({
    applicationId: credentials.applicationId,
    botToken: credentials.botToken,
    fetch: fetchImpl,
    guildId: credentials.guildId,
  }).catch((error) => {
    throw unprocessable(redactError(error), {
      code: "chat_provider_permissions_missing",
      provider: "discord",
    });
  });
  return identity;
}
