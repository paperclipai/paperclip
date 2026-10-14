import { CAPABILITIES } from "../provider-catalog.js";

import { and, eq } from "drizzle-orm";
import { chatEndpoints, toolConnections } from "@paperclipai/db";
import { readRegisteredDiscordCommandRegistration } from "../../chat-discord-command-registration-store.js";
import type { Db } from "@paperclipai/db";
import type { EndpointRow, EndpointRecord, RuntimeContext } from "../runtime-types.js";
import type { ChatRuntime } from "../../chat-runtime.js";
import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";
import type { createDiscordCommands } from "./commands.js";
import type { createChatMessageLifecycle } from "../inbound/lifecycle.js";
import type { ToolCredentialSecretRef } from "@paperclipai/shared";
type ReconciliationOptions = {
  reconcileDiscordCommands: ReturnType<typeof createDiscordCommands>["reconcileDiscordCommands"];
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  runtimeContexts: WeakMap<object, RuntimeContext>;
  invalidateRuntime: (endpointId: string) => Promise<boolean>;
  runtimeFor: (endpoint: EndpointRow, options: { requireDiscordOwnership: boolean }) => Promise<ChatEndpointRuntime>;
  runtime: Pick<ChatRuntime, "get">;
  runtimeCallbackEndpoint: Parameters<typeof createChatMessageLifecycle>[1]["runtimeCallbackEndpoint"];
  credentialFingerprint: (refs: ToolCredentialSecretRef[]) => string;
  discordGatewayRuntimeIsCurrent: (endpointId: string, context: RuntimeContext) => boolean;
};
export function createDiscordRuntimeReconciliation(db: Db, options: ReconciliationOptions) {
  const { reconcileDiscordCommands, endpointRecord, runtimeContexts, invalidateRuntime, runtimeFor, runtime, runtimeCallbackEndpoint, credentialFingerprint, discordGatewayRuntimeIsCurrent } = options;
  async function reconcileDiscordRuntime(endpointId: string, instance: ChatEndpointRuntime) {
    await reconcileDiscordCommands(endpointId);
    const afterCommands = await endpointRecord(endpointId);
    const desiredCommands =
      afterCommands?.endpoint.capabilities.slashCommands &&
        afterCommands.endpoint.botExternalId &&
        afterCommands.endpoint.providerAccountId
        ? await readRegisteredDiscordCommandRegistration(db, {
          companyId: afterCommands.endpoint.companyId,
          endpointId: endpointId,
          applicationId: afterCommands.endpoint.botExternalId,
          guildId: afterCommands.endpoint.providerAccountId,
        })
        : null;
    if (
      afterCommands &&
      desiredCommands &&
      runtimeContexts.get(instance as object)?.discordCommandId !==
      desiredCommands.receipt.commandId
    ) {
      await invalidateRuntime(endpointId);
      instance = await runtimeFor(afterCommands.endpoint, {
        requireDiscordOwnership: true,
      });
    }
    const context = runtimeContexts.get(instance as object);
    if (
      CAPABILITIES.discord.modals &&
      context &&
      runtime.get(endpointId) === instance
    ) {
      // Existing connected endpoints acquire the new implementation
      // capability only after the pinned runtime initialized successfully.
      // No reconnect, policy/reach change, credential rotation, or runtime
      // generation change is needed: its Discord handler is registered
      // even while the persisted capability remains disabled.
      await db.transaction(async (tx) => {
        const current = await runtimeCallbackEndpoint(
          tx,
          endpointId,
          context,
          ["verifying", "active", "attention"],
        );
        if (
          !current ||
          current.provider !== "discord" ||
          current.capabilities.modals === true ||
          runtime.get(endpointId) !== instance
        )
          return;
        const connection = await tx
          .select({
            enabled: toolConnections.enabled,
            status: toolConnections.status,
            refs: toolConnections.credentialSecretRefs,
          })
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.companyId, current.companyId),
              eq(toolConnections.id, current.connectionId),
            ),
          )
          .for("no key update")
          .then((rows) => rows[0]);
        if (
          !connection?.enabled ||
          connection.status !== "active" ||
          credentialFingerprint(connection.refs) !==
          context.credentialFingerprint ||
          runtime.get(endpointId) !== instance ||
          !discordGatewayRuntimeIsCurrent(endpointId, context)
        )
          return;
        await tx
          .update(chatEndpoints)
          .set({ capabilities: { ...current.capabilities, modals: true } })
          .where(
            and(
              eq(chatEndpoints.companyId, current.companyId),
              eq(chatEndpoints.id, current.id),
            ),
          );
      });
    }
  }
  return { reconcileDiscordRuntime };
}