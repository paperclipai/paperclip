import { chatConnectionTransport } from "./provider-catalog.js";
import type { ConnectionManagementContext } from "../connection-management.js";
import { slackSetupState } from "./slack/setup.js";
import { assertChatExecutionDefaultsAccess } from "../chat-execution-defaults.js";

import type { EndpointRow } from "./runtime-types.js";

import { chatCredentialMutationLease } from "../chat-credential-mutation-lease.js";

import { slackChatRegistrationService, slackRegistrationProjection } from "../chat-slack-registration.js";
import { chatSlackRegistrations } from "@paperclipai/db";

import { defaultSlackAppConfiguration } from "@paperclipai/shared";
import {
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  and,
  desc,
  eq,
  ne,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  agents,
  chatEndpoints,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatAdapterCapabilities,
  ChatEndpoint,
  ChatProvider,
  CreateChatEndpointInput,
  UpdateChatEndpointInput,
} from "@paperclipai/shared";
import {
  isAgentStatusInvokable,
  isUuidLike,
} from "@paperclipai/shared";

import {
  badRequest,
  conflict,
  notFound,
  unprocessable,
} from "../../errors.js";

import {
  logActivity,
} from "../activity-log.js";

import type { EndpointRecord } from "./runtime-types.js";
type ChatEndpointsOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  CAPABILITIES: Record<ChatProvider, ChatAdapterCapabilities>;
  PROVIDER_LABELS: Record<ChatProvider, string>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  getPublicBaseUrl: () => string | null;
  getWebhookPublicBaseUrl: () => string | null;
  slackRegistration: Pick<ReturnType<typeof slackChatRegistrationService>, "cleanup" | "managerGrants">;
};
export function createChatEndpoints(db: Db, options: ChatEndpointsOptions) {
  const { endpointRecord, CAPABILITIES, PROVIDER_LABELS, withCredentialMutationLease, getPublicBaseUrl, getWebhookPublicBaseUrl } = options;


function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function providerSetupState(
  endpoint: Pick<
    EndpointRow,
    | "provider"
    | "providerAccountId"
    | "publicId"
    | "status"
    | "setup"
    | "botUsername"
  >,
  publicBaseUrl: string | null,
  assignedAgentName?: string | null,
) {
  const path = endpoint.provider === "speko" ? `/api/voice-webhooks/${endpoint.publicId}/tools` : `/api/chat-webhooks/${endpoint.publicId}/${endpoint.provider}`;
  const webhookUrl = publicBaseUrl ? `${publicBaseUrl}${path}` : null;
  const step = endpoint.status === "active" ? "complete" : endpoint.setup.step;
  const rotationId: unknown = Reflect.get(endpoint.setup, "credentialRotationId");
  switch (endpoint.provider) {
    case "speko":
      return { step, providerUrl: "https://platform.speko.ai/", webhookUrl } as const;
    case "imessage-photon": return { step, providerUrl: "https://photon.codes/", testStartedAt: endpoint.setup.testStartedAt } as const;
    case "agentmail": return endpoint.setup;
    case "slack": {
      return slackSetupState({ endpoint, webhookUrl, step, assignedAgentName });
    }
    case "github":
      return {
        step,
        github: endpoint.setup.github,
        testStartedAt: endpoint.setup.testStartedAt,
        testSkipped: endpoint.setup.testSkipped,
        authorizationUrl: "https://github.com/settings/apps/new",
        providerUrl: "https://github.com/settings/installations",
        webhookUrl,
        webhookVerifiedAt: endpoint.setup.webhookVerifiedAt ?? null,
        credentialRotationId: typeof rotationId === "string" && isUuidLike(rotationId) ? rotationId : null,
      } as const;
    case "discord":
      return {
        step,
        authorizationUrl: "https://discord.com/developers/applications",
        providerUrl: endpoint.providerAccountId
          ? `https://discord.com/channels/${encodeURIComponent(endpoint.providerAccountId)}`
          : "https://discord.com/channels/@me",
        webhookUrl,
      } as const;
    case "microsoft-teams":
      return {
        step,
        authorizationUrl: "https://dev.teams.microsoft.com/apps",
        providerUrl: "https://teams.microsoft.com/",
        messagingEndpoint: webhookUrl,
      } as const;
    case "telegram":
      return {
        step,
        providerUrl: endpoint.botUsername
          ? `https://t.me/${encodeURIComponent(endpoint.botUsername)}`
          : "https://t.me/BotFather",
        webhookUrl,
      } as const;
  }
}

  function serializeEndpoint(
    row: Awaited<ReturnType<typeof endpointRecord>>,
  ): ChatEndpoint {
    if (!row) throw notFound("Chat endpoint not found");
    const endpoint = row.endpoint;
    return {
      id: endpoint.id,
      companyId: endpoint.companyId,
      connectionId: endpoint.connectionId,
      publicationMode: endpoint.publicationMode,
      externalExecutionPolicy: endpoint.externalExecutionPolicy,
      provider: endpoint.provider,
      publicId: endpoint.publicId,
      status: endpoint.status,
      deploymentMode: endpoint.deploymentMode,
      assignedAgentId: endpoint.assignedAgentId,
      assignedAgentName: row.assignedAgentName,
      sponsorUserId: endpoint.sponsorUserId,
      providerAccountId: endpoint.providerAccountId,
      providerAccountLabel: endpoint.providerAccountLabel,
      botExternalId: endpoint.botExternalId,
      botUsername: endpoint.botUsername,
      botLabel: endpoint.botDisplayName ?? row.assignedAgentName,
      botAvatarUrl: endpoint.botAvatarUrl,
      communicationInstructions: endpoint.communicationInstructions,
      executionDefaults: endpoint.executionDefaults,
      ...(endpoint.provider === "imessage-photon" && endpoint.botExternalId ? { photonAllocation: endpoint.botExternalId.startsWith("photon-project:") ? "shared" as const : "dedicated" as const } : {}),
      allowDirectMessages: endpoint.allowDirectMessages,
      requireAtMention: endpoint.requireAtMention,
      allowGroupChats: endpoint.allowGroupChats,
      allowUnlinkedPeople: endpoint.allowUnlinkedPeople,
      replyMode: "subscribed",
      capabilities: endpoint.capabilities,
      setup: {
        ...providerSetupState(
          endpoint,
          getWebhookPublicBaseUrl(),
          row.assignedAgentName,
        ),
        ...(endpoint.provider === "github"
          ? {
              webhookSecretConfigured: row.credentialSecretRefs.some(
                (ref) => ref.configPath === "credentials.webhookSecret",
              ),
            }
          : endpoint.provider === "speko" ? {
              webhookSecretConfigured: row.credentialSecretRefs.some(
                (ref) => ref.configPath === "credentials.signingSecret",
              ),
            } : {}),
      },
      healthMessage: endpoint.healthMessage,
      lastError: endpoint.lastError,
      lastActivityAt: iso(endpoint.lastEventAt),
      lastPublicationAt: iso(endpoint.lastPublicationAt),
      activatedAt: iso(endpoint.activatedAt),
      createdAt: endpoint.createdAt.toISOString(),
      updatedAt: endpoint.updatedAt.toISOString(),
    };
  }

  async function list(companyId: string) {
    const rows = await db
      .select({
        endpoint: chatEndpoints,
        assignedAgentName: agents.name,
        connectionName: toolConnections.name,
        applicationId: toolConnections.applicationId,
        credentialSecretRefs: toolConnections.credentialSecretRefs,
      })
      .from(chatEndpoints)
      .innerJoin(
        agents,
        and(
          eq(agents.id, chatEndpoints.assignedAgentId),
          eq(agents.companyId, chatEndpoints.companyId),
        ),
      )
      .innerJoin(
        toolConnections,
        and(
          eq(toolConnections.id, chatEndpoints.connectionId),
          eq(toolConnections.companyId, chatEndpoints.companyId),
        ),
      )
      .where(
        and(
          eq(chatEndpoints.companyId, companyId),
          ne(chatEndpoints.status, "archived"),
        ),
      )
      .orderBy(desc(chatEndpoints.updatedAt));
    return rows.map((row) => serializeEndpoint(row));
  }

  async function get(endpointId: string) {
    const result = serializeEndpoint(await endpointRecord(endpointId));
    if (result.provider === "slack") {
      const [registration] = await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, endpointId));
      result.setup.slackRegistration = registration ? slackRegistrationProjection(registration) : undefined;
      const publicOrigin = getPublicBaseUrl();
      result.setup.slackOAuthCallbackUri = publicOrigin ? `${publicOrigin}/api/chat-slack/oauth/callback` : null;
    }
    return result;
  }

  async function create(
    companyId: string,
    input: CreateChatEndpointInput,
    actorUserId?: string | null,
    managementContext?: ConnectionManagementContext,
  ) {
    await managementContext?.reauthorize();
    if ((input.provider as string) === "agentmail") throw badRequest("Use the email inbox setup API for AgentMail");
    if ((input.slackApp || input.slackSetupMethod) && input.provider !== "slack") throw unprocessable("Slack app details only apply to Slack connections");
    if (input.slackSetupMethod === "managed" && options.slackRegistration.managerGrants.defaultMethod() !== "managed") throw conflict("Managed Slack setup is unavailable");
    const agent = await db
      .select({ id: agents.id, name: agents.name, status: agents.status })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.id, input.assignedAgentId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!agent)
      throw unprocessable("The selected agent does not belong to this company");
    if (!isAgentStatusInvokable(agent.status)) {
      throw unprocessable(
        "The selected agent must be active before it can be connected to chat",
        {
          code: "chat_agent_not_invokable",
        },
      );
    }

    const endpointId = randomUUID();
    const publicId = randomBytes(32).toString("base64url");
    const applicationId = input.applicationId ?? randomUUID();
    const connectionId = randomUUID();
    const suffix = endpointId.slice(0, 8);
    const name = (
      input.name?.trim() || `${PROVIDER_LABELS[input.provider]} — ${agent.name}`
    ).slice(0, 145);
    await managementContext?.reauthorize();
      await db.transaction(async (tx) => {
      if (input.applicationId) {
        const application = await tx
          .select({
            id: toolApplications.id,
            applicationKey: toolApplications.applicationKey,
            metadata: toolApplications.metadata,
            status: toolApplications.status,
          })
          .from(toolApplications)
          .where(
            and(
              eq(toolApplications.companyId, companyId),
              eq(toolApplications.id, input.applicationId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!application) throw notFound("App not found");
        const sourceTemplateKey =
          typeof application.metadata.sourceTemplateKey === "string"
            ? application.metadata.sourceTemplateKey
            : null;
        if (
          application.status === "archived" ||
          (application.applicationKey !== input.provider &&
            sourceTemplateKey !== input.provider)
        ) {
          throw unprocessable(
            `The selected App is not the ${PROVIDER_LABELS[input.provider]} connector`,
          );
        }
      } else {
        await tx.insert(toolApplications).values({
          id: applicationId,
          companyId,
          applicationKey: `chat:${input.provider}:${endpointId}`,
          name: `${name} ${suffix}`,
          description: `People talk to ${agent.name} through ${PROVIDER_LABELS[input.provider]}.`,
          type: "chat",
          status: "draft",
          metadata: { sourceTemplateKey: input.provider, purpose: "channel" },
          ownerUserId: actorUserId ?? null,
        });
      }
      await tx.insert(toolConnections).values({
        id: connectionId,
        companyId,
        applicationId,
        name,
        uid: `chat-${input.provider}-${endpointId}`,
        connectionKind: "managed",
        connectionPurpose: "channel",
        ownership: "customer",
        transport: chatConnectionTransport(input.provider),
        authKind: "api_key",
        credentialPolicy: "shared",
        status: "draft",
        enabled: false,
        config: { provider: input.provider },
        transportConfig: {},
        createdByUserId: actorUserId ?? null,
      });
      await tx.insert(chatEndpoints).values({
        id: endpointId,
        companyId,
        connectionId,
        provider: input.provider,
        publicId,
        assignedAgentId: agent.id,
        sponsorUserId: actorUserId ?? null,
        // Group chat is a broad Teams reach grant rather than a discovered
        // destination toggle. Keep it closed until the operator explicitly
        // enables that surface, even when this process is running against a
        // database created before the column default was hardened.
        requireAtMention: input.provider === "slack",
        allowGroupChats: !["microsoft-teams", "speko"].includes(input.provider),
        allowUnlinkedPeople: !["slack", "imessage-photon", "speko"].includes(input.provider),
        capabilities: CAPABILITIES[input.provider],
        setup: {
          step: "provider_setup",
          ...(input.provider === "slack"
            ? { slackApp: input.slackApp ?? defaultSlackAppConfiguration(agent.name),
                command: (input.slackApp ?? defaultSlackAppConfiguration(agent.name)).command, slackSetupMethod: input.slackSetupMethod ?? options.slackRegistration.managerGrants.defaultMethod() }
            : {}),
        },
      });
    });
    await logActivity(db, {
      companyId,
      ...(managementContext?.audit ?? { actorType: "user" as const, actorId: actorUserId ?? "board" }),
      action: "chat_endpoint.created",
      entityType: "tool_connection",
      entityId: connectionId,
      details: {
        endpointId,
        provider: input.provider,
        assignedAgentId: agent.id,
      },
    });
    return get(endpointId);
  }

  async function update(
    endpointId: string,
    input: UpdateChatEndpointInput,
    actorUserId?: string | null,
    managementContext?: ConnectionManagementContext,
  ) {
    await managementContext?.reauthorize();
    const initial = await endpointRecord(endpointId);
    if (!initial) throw notFound("Chat endpoint not found");
    if (initial.endpoint.provider === "agentmail" && Object.keys(input).some((key) => key !== "executionDefaults")) throw badRequest("Use the email inbox API for AgentMail");
    await withCredentialMutationLease(
      initial.endpoint,
      async (credentialLease) => {
        // Reach changes share the provider-transport lane with publications.
        // Once a disable returns, no send that sampled the previous grant can
        // still begin or finish behind it.
        const existing = await endpointRecord(endpointId);
        if (!existing) throw notFound("Chat endpoint not found");
        const values: Partial<typeof chatEndpoints.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (input.communicationInstructions !== undefined) {
          if (existing.endpoint.provider !== "slack") {
            throw unprocessable("Communication instructions are currently supported for Slack connections");
          }
          values.communicationInstructions = input.communicationInstructions;
        }
        if (input.slackSetupMethod === "managed" && options.slackRegistration.managerGrants.defaultMethod() !== "managed") throw conflict("Managed Slack setup is unavailable");
        if (input.slackSetupMethod && (existing.endpoint.provider !== "slack" || existing.endpoint.botExternalId || existing.endpoint.status !== "draft")) {
          throw conflict("Setup method can only change before connecting the app");
        }
        if (input.slackApp || input.slackSetupMethod) {
          const [registration] = await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, endpointId));
          if (registration && (registration.managerGrantId || registration.status !== "failed")) {
            if (registration.managerGrantId || input.slackSetupMethod === "managed" || input.slackApp || input.slackSetupMethod === "automatic") throw conflict("Slack app details are locked after creation starts");
            // Manual recovery fences pending authorization under the same credential lease.
            await options.slackRegistration.cleanup(endpointId, credentialLease);
          }
        }
        if (input.slackSetupMethod) {
          values.setup = { ...existing.endpoint.setup, slackSetupMethod: input.slackSetupMethod };
        }
        if (input.slackApp) {
          if (existing.endpoint.provider !== "slack") {
            throw unprocessable("Slack app details only apply to Slack connections");
          }
          if (existing.endpoint.status !== "draft" || existing.endpoint.botExternalId) {
            throw conflict("Slack app details can only be edited before connecting the app");
          }
          values.setup = {
            ...(values.setup ?? existing.endpoint.setup),
            slackApp: input.slackApp,
            command: input.slackApp.command,
          };
        }
        if (input.allowDirectMessages !== undefined)
          values.allowDirectMessages = input.allowDirectMessages;
        if (input.requireAtMention !== undefined) {
          if (existing.endpoint.provider !== "slack")
            throw unprocessable("Require at-mention only applies to Slack connections");
          values.requireAtMention = input.requireAtMention;
        }
        if (input.allowGroupChats && existing.endpoint.provider === "imessage-photon" && (!existing.endpoint.botExternalId || existing.endpoint.botExternalId.startsWith("photon-project:")))
          throw unprocessable("Photon shared channels support direct messages only; groups require a dedicated channel");
        if (input.allowGroupChats !== undefined)
          values.allowGroupChats = input.allowGroupChats;
        if (input.allowUnlinkedPeople !== undefined)
          values.allowUnlinkedPeople = input.allowUnlinkedPeople;
        await managementContext?.reauthorize();
      await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          if (input.executionDefaults !== undefined) {
            await assertChatExecutionDefaultsAccess(db, {
              companyId: existing.endpoint.companyId,
              assigneeAgentId: values.assignedAgentId ?? existing.endpoint.assignedAgentId,
              actor: managementContext?.actor ?? { type: "board", userId: actorUserId, source: actorUserId ? "session" : "local_implicit" },
              defaults: input.executionDefaults,
            }, tx);
            values.executionDefaults = input.executionDefaults;
          }
          await tx
            .update(chatEndpoints)
            .set(values)
            .where(eq(chatEndpoints.id, endpointId));
          await logActivity(tx as unknown as Db, {
            companyId: existing.endpoint.companyId,
            ...(managementContext?.audit ?? { actorType: "user" as const, actorId: actorUserId ?? "board" }),
            action: "chat_endpoint.updated",
            entityType: "tool_connection",
            entityId: existing.endpoint.connectionId,
            details: { endpointId, fields: Object.keys(input) },
          });
          await credentialLease.assertOwned(tx);
        });
      },
    );
    return get(endpointId);
  }
  return { list, get, create, update };
}
