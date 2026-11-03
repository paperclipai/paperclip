import type { EndpointRow, DbTransaction, DbOrTransaction, RuntimeContext, LifecycleRuntimeFence } from "../runtime-types.js";

import { chatCredentialMutationLease, type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import {
  and,
  desc,
  eq,
  gt,
} from "drizzle-orm";

import {
  readChatControlChronology,
} from "../../chat-control-chronology.js";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatEndpointLeases,
  chatEndpointResources,
  chatEndpoints,
  issues,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatEndpointSetupState,
  SafeChatPublicationPayload,
  ToolCredentialSecretRef,
} from "@paperclipai/shared";

import {
  conflict,
  notFound,
} from "../../../errors.js";
import { logger } from "../../../middleware/logger.js";

import {
  type ChatSdkCallbackEvent,
  type DiscordNativeCommandResponse,
} from "../../chat-sdk-runtime.js";
import {
  parseDiscordNativeCommand,
  parseDiscordNativeCommandReceipt,
  type DiscordNativeCommandTarget,
} from "../../chat-discord-native-commands.js";

import {
  logActivity,
} from "../../activity-log.js";

import { projectSafeChatPublication } from "../../chat-publication-projection.js";

import {
  readRegisteredDiscordCommandRegistration,
  reconcileStoredDiscordCommandRegistration,
} from "../../chat-discord-command-registration-store.js";

import type {
  Author,
  SlashCommandEvent,
} from "chat";

import type { EndpointRecord } from "../runtime-types.js";

type DiscordCommandsOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  runtimeContextForRecord: (record: EndpointRecord) => RuntimeContext;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  credentialFingerprint: (refs: ToolCredentialSecretRef[]) => string;
  resolveCredentialRefs: (endpoint: EndpointRow, refs: ToolCredentialSecretRef[], database?: DbOrTransaction) => Promise<Record<string, string>>;
  fetchImpl: typeof fetch;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  runtimeCallbackRecord: (endpointId: string, context: RuntimeContext, statuses: EndpointRow["status"][]) => Promise<EndpointRecord | null>;
  ensurePrincipal: (endpoint: EndpointRow, author: Author, raw?: unknown) => Promise<{ principal: { id: string }; userId: string | null }>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: typeof chatEndpointResources.$inferSelect | null | undefined) => boolean;
  lockCurrentPrincipalAuthorization: (tx: DbOrTransaction, endpoint: EndpointRow, principalId: string) => Promise<{ allowed: boolean; userId: string | null }>;
  getDiscordGatewayOwnership: (endpointId: string) => { leaseKey: string; token: string } | undefined;
  discordGatewayRuntimeIsCurrent: (endpointId: string, context: RuntimeContext) => boolean;
  stageAuthorizedTaskControlPublication: (tx: DbOrTransaction, input: { companyId: string; conversationId: string; endpointId: string; idempotencyKey: string; issueId: string; payload: SafeChatPublicationPayload; principalId: string }) => Promise<{ id: string }>;
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  processPendingPublications: () => Promise<unknown>;
};

export function createDiscordCommands(db: Db, options: DiscordCommandsOptions) {
  const { endpointRecord, runtimeContextForRecord, runtimeGeneration, credentialFingerprint, resolveCredentialRefs, fetchImpl, withCredentialMutationLease, runtimeCallbackRecord, ensurePrincipal, runtimeCallbackEndpoint, nonDirectDestinationAllowed, lockCurrentPrincipalAuthorization, getDiscordGatewayOwnership, discordGatewayRuntimeIsCurrent, stageAuthorizedTaskControlPublication, scheduleMessageProcessing, processPendingPublications } = options;


  async function reconcileDiscordCommands(
    endpointId: string,
    existingLease?: CredentialMutationLeaseGuard,
    force = false,
  ): Promise<void> {
    const initial = await endpointRecord(endpointId);
    if (!initial || initial.endpoint.provider !== "discord") return;
    const reconcile = async (lease: CredentialMutationLeaseGuard) => {
      const record = await endpointRecord(endpointId);
      if (
        !record ||
        record.endpoint.provider !== "discord" ||
        !["verifying", "active", "attention"].includes(
          record.endpoint.status,
        ) ||
        !record.endpoint.botExternalId ||
        !record.endpoint.providerAccountId
      )
        return;
      const scope = {
        companyId: record.endpoint.companyId,
        endpointId,
        applicationId: record.endpoint.botExternalId,
        guildId: record.endpoint.providerAccountId,
      };
      const fence = runtimeContextForRecord(record);
      const authorize = async (tx: DbTransaction) => {
        const endpoint = await tx
          .select()
          .from(chatEndpoints)
          .where(
            and(
              eq(chatEndpoints.companyId, scope.companyId),
              eq(chatEndpoints.id, scope.endpointId),
            ),
          )
          .for("no key update")
          .then((rows) => rows[0]);
        if (
          !endpoint ||
          endpoint.provider !== "discord" ||
          !["verifying", "active", "attention"].includes(endpoint.status) ||
          endpoint.botExternalId !== scope.applicationId ||
          endpoint.providerAccountId !== scope.guildId ||
          runtimeGeneration(endpoint.setup) !== fence.generation
        )
          throw conflict("Discord command registration authority changed");
        const connection = await tx
          .select()
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.companyId, scope.companyId),
              eq(toolConnections.id, endpoint.connectionId),
            ),
          )
          .for("no key update")
          .then((rows) => rows[0]);
        if (
          !connection?.enabled ||
          connection.status !== "active" ||
          credentialFingerprint(connection.credentialSecretRefs) !==
            fence.credentialFingerprint
        )
          throw conflict("Discord command registration authority changed");
        await lease.assertOwned(tx);
      };
      const setCapability = async (tx: DbTransaction, registered: boolean) => {
        const current = await tx
          .select()
          .from(chatEndpoints)
          .where(
            and(
              eq(chatEndpoints.companyId, scope.companyId),
              eq(chatEndpoints.id, endpointId),
            ),
          )
          .then((rows) => rows[0]);
        if (!current) throw notFound("Chat endpoint not found");
        if (
          current.capabilities.slashCommands === registered &&
          current.capabilities.ephemeralMessages === registered
        )
          return;
        await tx
          .update(chatEndpoints)
          .set({
            capabilities: {
              ...current.capabilities,
              slashCommands: registered,
              ephemeralMessages: registered,
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatEndpoints.companyId, scope.companyId),
              eq(chatEndpoints.id, endpointId),
            ),
          );
        await logActivity(tx as unknown as Db, {
          companyId: scope.companyId,
          actorType: "system",
          actorId: "system",
          action: registered
            ? "chat_endpoint.commands_registered"
            : "chat_endpoint.commands_unavailable",
          entityType: "tool_connection",
          entityId: current.connectionId,
          details: { endpointId, provider: "discord" },
        });
      };
      await lease.assertOwned();
      const credentials = await resolveCredentialRefs(
        record.endpoint,
        record.credentialSecretRefs,
      );
      if (
        credentials.applicationId !== scope.applicationId ||
        credentials.guildId !== scope.guildId
      )
        throw conflict("Discord command registration identity changed");
      const result = await reconcileStoredDiscordCommandRegistration(db, {
        scope,
        runtimeFence: {
          generation: fence.generation,
          credentialFingerprint: fence.credentialFingerprint,
        },
        botToken: credentials.botToken,
        fetch: fetchImpl,
        authorize,
        force,
        onState: async (tx, state) =>
          setCapability(tx, state.phase === "registered"),
      });
      if (result.kind === "deferred") return;
      await db.transaction(async (tx) => {
        await authorize(tx);
        const registered =
          result.kind === "registered"
            ? await readRegisteredDiscordCommandRegistration(tx, scope)
            : null;
        await setCapability(tx, registered !== null);
        await lease.assertOwned(tx);
      });
    };
    try {
      if (existingLease) await reconcile(existingLease);
      else await withCredentialMutationLease(initial.endpoint, reconcile);
    } catch {
      // Commands are additive. Do not fail an otherwise working mention/thread
      // connection or expose provider errors/tokens when registration is busy.
      logger.warn(
        { endpointId },
        "Discord command registration remains unconfirmed",
      );
    }
  }

  async function handleDiscordNativeCommand(
    event: ChatSdkCallbackEvent<SlashCommandEvent>,
    runtimeContext: RuntimeContext,
  ): Promise<DiscordNativeCommandResponse> {
    const denied: DiscordNativeCommandResponse = { kind: "denied" };
    const record = await runtimeCallbackRecord(
      event.endpointId,
      runtimeContext,
      ["active"],
    );
    if (
      !record ||
      record.endpoint.provider !== "discord" ||
      record.endpoint.capabilities.slashCommands !== true ||
      event.transport !== "discord_gateway" ||
      runtimeContext.discordGatewayOwned !== true
    )
      return denied;
    const scope = {
      companyId: record.endpoint.companyId,
      endpointId: record.endpoint.id,
      applicationId: record.endpoint.botExternalId ?? "",
      guildId: record.endpoint.providerAccountId ?? "",
    };
    const invocation = parseDiscordNativeCommand(event, scope);
    if (!invocation) return denied;
    const initialRegistration = await readRegisteredDiscordCommandRegistration(
      db,
      scope,
    );
    if (
      initialRegistration?.receipt.commandId !== invocation.registeredCommandId
    )
      return denied;
    const principal = await ensurePrincipal(
      record.endpoint,
      event.event.user,
      event.event.raw,
    );
    const authorityChanged = new Error("Discord command authority changed");
    let publish = false;
    try {
      const response = await db.transaction(
        async (tx): Promise<DiscordNativeCommandResponse> => {
          const endpoint = await runtimeCallbackEndpoint(
            tx,
            scope.endpointId,
            runtimeContext,
            ["active"],
          );
          if (
            !endpoint ||
            endpoint.companyId !== scope.companyId ||
            endpoint.provider !== "discord" ||
            endpoint.botExternalId !== scope.applicationId ||
            endpoint.providerAccountId !== scope.guildId ||
            endpoint.capabilities.slashCommands !== true
          )
            return denied;
          const connection = await tx
            .select()
            .from(toolConnections)
            .where(
              and(
                eq(toolConnections.companyId, scope.companyId),
                eq(toolConnections.id, endpoint.connectionId),
              ),
            )
            .for("no key update")
            .then((rows) => rows[0] ?? null);
          if (
            !connection ||
            !connection.enabled ||
            connection.status !== "active" ||
            credentialFingerprint(connection.credentialSecretRefs) !==
              runtimeContext.credentialFingerprint
          )
            return denied;
          const registration = await readRegisteredDiscordCommandRegistration(
            tx,
            scope,
            true,
          );
          if (
            registration?.receipt.commandId !== invocation.registeredCommandId
          )
            return denied;
          const providerActionId = `discord-native-command:${invocation.interactionId}`;
          const prior = await tx
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.companyId, scope.companyId),
                eq(chatActions.endpointId, scope.endpointId),
                eq(chatActions.providerActionId, providerActionId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          const receipt = prior
            ? parseDiscordNativeCommandReceipt(prior, invocation, scope)
            : null;
          if (
            prior &&
            (!receipt ||
              receipt.principalId !== principal.principal.id ||
              receipt.runtimeFence.generation !== runtimeContext.generation ||
              receipt.runtimeFence.credentialFingerprint !==
                runtimeContext.credentialFingerprint)
          )
            return denied;
          // A replay selects only its original target, including a completed
          // generation. Never reinterpret an old close as a new task's command.
          const conversation = receipt
            ? receipt.target
              ? await tx
                  .select()
                  .from(chatConversations)
                  .where(
                    and(
                      eq(chatConversations.companyId, scope.companyId),
                      eq(chatConversations.endpointId, scope.endpointId),
                      eq(chatConversations.id, receipt.target.conversationId),
                    ),
                  )
                  .for("update")
                  .then((rows) => rows[0] ?? null)
              : null
            : invocation.sourceKind !== "guild_channel"
              ? await tx
                  .select()
                  .from(chatConversations)
                  .where(
                    and(
                      eq(chatConversations.companyId, scope.companyId),
                      eq(chatConversations.endpointId, scope.endpointId),
                      eq(
                        chatConversations.externalConversationId,
                        invocation.channelId,
                      ),
                      eq(
                        chatConversations.externalThreadId,
                        invocation.threadId,
                      ),
                    ),
                  )
                  .orderBy(desc(chatConversations.sessionGeneration))
                  .limit(1)
                  .for("update")
                  .then((rows) => rows[0] ?? null)
              : null;
          if (
            (receipt?.target && !conversation) ||
            (conversation &&
              (conversation.externalConversationId !== invocation.channelId ||
                conversation.externalThreadId !== invocation.threadId ||
                conversation.isDirectMessage !==
                  (invocation.sourceKind === "direct_message") ||
                !["active", "waiting", "completed"].includes(
                  conversation.state,
                ) ||
                (receipt?.target &&
                  (conversation.issueId !== receipt.target.issueId ||
                    conversation.sessionGeneration !==
                      receipt.target.sessionGeneration))))
          )
            return denied;
          const resource =
            invocation.sourceKind === "direct_message"
              ? null
              : await tx
                  .select()
                  .from(chatEndpointResources)
                  .where(
                    and(
                      eq(chatEndpointResources.companyId, scope.companyId),
                      eq(chatEndpointResources.endpointId, scope.endpointId),
                      eq(
                        chatEndpointResources.providerResourceId,
                        invocation.providerResourceId,
                      ),
                    ),
                  )
                  .for("update")
                  .then((rows) => rows[0] ?? null);
          if (
            invocation.sourceKind === "direct_message"
              ? !endpoint.allowDirectMessages
              : !nonDirectDestinationAllowed(endpoint, resource) ||
                (conversation && conversation.resourceId !== resource?.id)
          )
            return denied;
          const authorization = await lockCurrentPrincipalAuthorization(
            tx,
            endpoint,
            principal.principal.id,
          );
          if (
            !authorization.allowed ||
            authorization.userId !== principal.userId
          )
            return denied;
          const issue = conversation
            ? await tx
                .select()
                .from(issues)
                .where(
                  and(
                    eq(issues.companyId, scope.companyId),
                    eq(issues.id, conversation.issueId),
                  ),
                )
                .for("share")
                .then((rows) => rows[0] ?? null)
            : null;
          if (conversation && !issue) return denied;
          const ownership = getDiscordGatewayOwnership(scope.endpointId);
          if (
            !ownership ||
            !discordGatewayRuntimeIsCurrent(scope.endpointId, runtimeContext)
          )
            return denied;
          const lease = await tx
            .select()
            .from(chatEndpointLeases)
            .where(
              and(
                eq(chatEndpointLeases.companyId, scope.companyId),
                eq(chatEndpointLeases.endpointId, scope.endpointId),
                eq(chatEndpointLeases.leaseKey, ownership.leaseKey),
                eq(chatEndpointLeases.token, ownership.token),
                gt(chatEndpointLeases.expiresAt, new Date()),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (
            !lease ||
            !discordGatewayRuntimeIsCurrent(scope.endpointId, runtimeContext)
          )
            return denied;
          if (receipt)
            return { kind: "accepted", content: receipt.result.content };
          const target: DiscordNativeCommandTarget | null = conversation
            ? {
                conversationId: conversation.id,
                issueId: conversation.issueId,
                sessionGeneration: conversation.sessionGeneration,
              }
            : null;
          const active =
            conversation &&
            issue &&
            ["active", "waiting"].includes(conversation.state) &&
            (invocation.sourceKind !== "direct_message" ||
              !["done", "cancelled"].includes(issue.status));
          let content: string;
          let publicationId: string | null = null;
          if (invocation.command === "status") {
            content =
              issue && (invocation.sourceKind !== "direct_message" || active)
                ? `${issue.identifier}: ${issue.title} — ${issue.status}${conversation?.state === "completed" ? " (conversation closed)" : ""}`.slice(
                    0,
                    2000,
                  )
                : invocation.sourceKind === "guild_channel"
                  ? "Open the Discord task thread to view its Paperclip status."
                  : "No task is active in this conversation.";
          } else if (
            invocation.command === "new" &&
            invocation.sourceKind !== "direct_message"
          ) {
            content =
              "Open a new Discord thread by mentioning this agent in a new channel message. This thread stays bound to its current Paperclip task.";
          } else if (!active || !conversation || !issue) {
            content =
              invocation.sourceKind === "direct_message"
                ? "No task is active. Send a message to start a new Paperclip task."
                : "No active task is bound here. Open its Discord thread to manage it.";
          } else if (
            (await readChatControlChronology(
              tx,
              record.endpoint,
              {
                id: conversation.externalThreadId,
                channelId: conversation.externalConversationId,
              },
              {
                receivedAt: new Date(),
                normalizedEvent: {
                  message: { providerMessageId: invocation.interactionId },
                },
              },
            )) === "before_or_unproven"
          ) {
            content =
              "This command predates an already completed chat control. Send a new command for the current conversation.";
          } else {
            const publicText =
              invocation.command === "new"
                ? "Send your request to start a new Paperclip task."
                : invocation.sourceKind === "direct_message"
                  ? "This chat conversation is closed. Send another message to start a new task."
                  : "This chat conversation is closed. A later message here will continue the same Paperclip task.";
            const publication = await stageAuthorizedTaskControlPublication(
              tx,
              {
                companyId: scope.companyId,
                endpointId: scope.endpointId,
                conversationId: conversation.id,
                issueId: issue.id,
                principalId: principal.principal.id,
                idempotencyKey: `control:${invocation.command}:discord:${scope.endpointId}:${invocation.interactionId}`,
                payload: projectSafeChatPublication({
                  classification: "external",
                  source: "task_control",
                  text: publicText,
                }),
              },
            );
            publicationId = publication.id;
            content = `${invocation.command === "new" ? "New-task" : "Close"} request recorded. Watch this conversation for confirmation.`;
          }
          const inserted = await tx
            .insert(chatActions)
            .values({
              companyId: scope.companyId,
              endpointId: scope.endpointId,
              conversationId: target?.conversationId ?? null,
              principalId: principal.principal.id,
              kind: "discord_native_command",
              providerActionId,
              payload: {
                version: 1,
                invocation,
                runtimeFence: {
                  generation: runtimeContext.generation,
                  credentialFingerprint: runtimeContext.credentialFingerprint,
                },
                target,
              },
              status: "processed",
              result: {
                kind: "discord_native_command_recorded",
                content,
                publicationId,
              },
            })
            .onConflictDoNothing()
            .returning({ id: chatActions.id });
          if (!inserted.length) throw authorityChanged;
          await logActivity(tx as unknown as Db, {
            companyId: scope.companyId,
            actorType: authorization.userId ? "user" : "system",
            actorId: authorization.userId ?? `chat:${principal.principal.id}`,
            action: "chat.discord_command_recorded",
            entityType: "chat_endpoint",
            entityId: scope.endpointId,
            details: {
              command: invocation.command,
              interactionId: invocation.interactionId,
              conversationId: target?.conversationId ?? null,
              sessionGeneration: target?.sessionGeneration ?? null,
              publicationId,
            },
          });
          // No network work is performed under these locks. A stop while any DB
          // await was in flight rolls back the command and its staged outbox row.
          if (
            !discordGatewayRuntimeIsCurrent(scope.endpointId, runtimeContext) ||
            lease.expiresAt.getTime() <= Date.now()
          )
            throw authorityChanged;
          publish = publicationId !== null;
          return { kind: "accepted", content };
        },
      );
      if (publish)
        scheduleMessageProcessing(async () => {
          await processPendingPublications();
        });
      return response;
    } catch (error) {
      if (error === authorityChanged) return denied;
      throw error;
    }
  }
  return { reconcileDiscordCommands, handleDiscordNativeCommand };
}
