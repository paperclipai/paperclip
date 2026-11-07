import type { Db } from "@paperclipai/db";
import type { EndpointRow, RuntimeContext } from "../runtime-types.js";
import { readRegisteredDiscordCommandRegistration } from "../../chat-discord-command-registration-store.js";

export async function prepareDiscordRuntimeCommand(db: Db, endpoint: EndpointRow, context: Pick<RuntimeContext, "discordCommandId">): Promise<void> {
          const discordCommands =
            endpoint.provider === "discord" &&
            endpoint.botExternalId &&
            endpoint.providerAccountId
              ? await readRegisteredDiscordCommandRegistration(db, {
                  companyId: endpoint.companyId,
                  endpointId: endpoint.id,
                  applicationId: endpoint.botExternalId,
                  guildId: endpoint.providerAccountId,
                })
              : null;
          context.discordCommandId =
            discordCommands && endpoint.capabilities.slashCommands
              ? discordCommands.receipt.commandId
              : undefined;
}
