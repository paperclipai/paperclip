import { prepareSlackInventory } from "./slack/inventory.js";
import { prepareGitHubInventory } from "./github/inventory.js";
import { prepareDiscordInventory } from "./discord/inventory.js";
import type { VerifiedProviderIdentity } from "./runtime-types.js";
import { verifySlackCredentials } from "./slack/credentials.js";
import { verifyDiscordCredentials } from "./discord/credentials.js";
import { verifyTelegramCredentials } from "./telegram/credentials.js";
import { verifyGitHubCredentials } from "./github/credentials.js";
import { verifySpekoCredentials } from "./speko/credentials.js";
import { verifyTeamsCredentials } from "./microsoft-teams/credentials.js";
import { createPhotonCredentialChecks } from "./imessage-photon/credentials.js";

import type { EndpointRow, DbOrTransaction } from "./runtime-types.js";

import { type CredentialMutationLeaseGuard } from "../chat-credential-mutation-lease.js";

import { photonSharedScope } from "../photon/cloud.js";

import { photonChannelConfigurationSchema } from "@paperclipai/shared";

import {
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  and,
  eq,
  inArray,
  ne,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatEndpoints,
  companySecretBindings,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatProvider,
  ToolCredentialSecretRef,
} from "@paperclipai/shared";

import { isUniqueViolation } from "../../db-errors.js";

import {
  conflict,
  notFound,
  unprocessable,
} from "../../errors.js";
import { logger } from "../../middleware/logger.js";

import { type ChatProviderInventoryResult } from "../chat-provider-inventory.js";

import {
  normalizeMicrosoftTeamsCredentialIds,
} from "../chat-teams-credentials.js";

import { secretService } from "../secrets.js";

type ChatCredentialsOptions = {
  secrets: ReturnType<typeof secretService>;
  PROVIDER_LABELS: Record<ChatProvider, string>;
  REQUIRED_CREDENTIALS: Record<Exclude<ChatProvider, "github">, readonly string[]>;
  PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS: number;
  fetchImpl: typeof globalThis.fetch;
  redactError: (error: unknown) => string;
  credentialFingerprint: (refs: ToolCredentialSecretRef[]) => string;
  verifyPhotonCredentials: ReturnType<typeof createPhotonCredentialChecks>["verifyPhotonCredentials"];
};
export function createChatCredentials(db: Db, options: ChatCredentialsOptions) {
  const { secrets, PROVIDER_LABELS, REQUIRED_CREDENTIALS, PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS, fetchImpl, redactError, credentialFingerprint, verifyPhotonCredentials } = options;


  async function normalizedCredentials(
    endpoint: EndpointRow,
    supplied: Record<string, string> | undefined,
  ) {
    const values = await resolveCredentials(endpoint).catch(
      () => ({}) as Record<string, string>,
    );
    for (const [key, rawValue] of Object.entries(supplied ?? {})) {
      if (typeof rawValue === "string" && rawValue.trim())
        values[key] = key === "privateKey" ? rawValue : rawValue.trim();
    }
    if (endpoint.provider === "telegram" && !values.webhookSecret) {
      values.webhookSecret = randomBytes(32).toString("hex");
    }
    const required =
      endpoint.provider === "github"
        ? ["appId", "privateKey", "webhookSecret"]
        : REQUIRED_CREDENTIALS[endpoint.provider];
    const missing = required.filter((key) => !values[key]);
    if (missing.length > 0) {
      throw unprocessable(
        `Missing required ${PROVIDER_LABELS[endpoint.provider]} credentials: ${missing.join(", ")}`,
      );
    }
    return endpoint.provider === "microsoft-teams"
      ? normalizeMicrosoftTeamsCredentialIds(values)
      : values;
  }

  async function verifyCredentials(
    provider: ChatProvider,
    credentials: Record<string, string>,
  ): Promise<VerifiedProviderIdentity> {
    if (provider === "imessage-photon") return verifyPhotonCredentials(credentials);
    if (provider === "slack") return verifySlackCredentials(credentials, fetchImpl, PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS);
    if (provider === "discord") return verifyDiscordCredentials(credentials, fetchImpl, redactError);
    if (provider === "telegram") return verifyTelegramCredentials(credentials, fetchImpl, PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS);
    if (provider === "github") return verifyGitHubCredentials(credentials, fetchImpl, PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS);
    if (provider === "speko") return verifySpekoCredentials(credentials, fetchImpl);
    return verifyTeamsCredentials(credentials, fetchImpl, PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS);
  }

  function nativeBotIdentityKey(
    provider: ChatProvider,
    identity: VerifiedProviderIdentity,
  ): string | null {
    const account = identity.providerAccountId?.trim().toLowerCase();
    const bot = identity.botExternalId?.trim().toLowerCase();
    if (provider === "github" || provider === "discord") {
      if (bot) return `${provider}:app:${bot}`;
      return null;
    }
    if (!account || !bot) return null;
    return `${provider}:${account}:${bot}`;
  }

  function providerUsesGlobalApplicationIdentity(
    provider: ChatProvider,
  ): boolean {
    return (
      provider === "github" ||
      provider === "discord" ||
      provider === "microsoft-teams" || provider === "imessage-photon"
    );
  }

  function nativeBotIdentityMatches(
    provider: ChatProvider,
    current: VerifiedProviderIdentity,
    incoming: VerifiedProviderIdentity,
  ): boolean {
    const currentKey = nativeBotIdentityKey(provider, current);
    return (
      currentKey !== null &&
      currentKey === nativeBotIdentityKey(provider, incoming)
    );
  }

  function legacyGitHubLabelsMatchVerifiedCredentials(
    current: VerifiedProviderIdentity,
    verified: VerifiedProviderIdentity,
  ): boolean {
    return (
      !current.botExternalId &&
      Boolean(verified.botExternalId) &&
      current.providerAccountId?.trim().toLowerCase() ===
        verified.providerAccountId?.trim().toLowerCase() &&
      current.botUsername?.trim().toLowerCase() ===
        verified.botUsername?.trim().toLowerCase()
    );
  }

  async function assertNativeBotIdentityAvailable(
    endpoint: EndpointRow,
    identity: VerifiedProviderIdentity,
  ): Promise<void> {
    const key = nativeBotIdentityKey(endpoint.provider, identity);
    if (!key) {
      throw unprocessable(
        `${PROVIDER_LABELS[endpoint.provider]} did not return a stable native bot identity`,
      );
    }
    const candidates = await db
      .select({
        id: chatEndpoints.id,
        companyId: chatEndpoints.companyId,
        assignedAgentId: chatEndpoints.assignedAgentId,
        providerAccountId: chatEndpoints.providerAccountId,
        botExternalId: chatEndpoints.botExternalId,
        botUsername: chatEndpoints.botUsername,
      })
      .from(chatEndpoints)
      .where(
        and(
          providerUsesGlobalApplicationIdentity(endpoint.provider)
            ? undefined
            : eq(chatEndpoints.companyId, endpoint.companyId),
          eq(chatEndpoints.provider, endpoint.provider),
          ne(chatEndpoints.id, endpoint.id),
          endpoint.provider === "imessage-photon" ? ne(chatEndpoints.status, "archived") : inArray(chatEndpoints.status, [
            "verifying",
            "active",
            "paused",
            "attention",
          ]),
        ),
      );
    const conflictEndpoint = candidates.find((candidate) => {
      if (!providerUsesGlobalApplicationIdentity(endpoint.provider)) {
        return nativeBotIdentityKey(endpoint.provider, candidate) === key;
      }
      const candidateAppId = candidate.botExternalId?.trim().toLowerCase();
      const incomingAppId = identity.botExternalId?.trim().toLowerCase();
      if (candidateAppId && incomingAppId)
        return candidateAppId === incomingAppId;
      return (
        candidate.providerAccountId?.trim().toLowerCase() ===
          identity.providerAccountId?.trim().toLowerCase() &&
        candidate.botUsername?.trim().toLowerCase() ===
          identity.botUsername?.trim().toLowerCase()
      );
    });
    if (conflictEndpoint) {
      throw conflict(
        `This ${PROVIDER_LABELS[endpoint.provider]} bot already represents another Paperclip agent connection`,
        conflictEndpoint.companyId === endpoint.companyId
          ? {
              code: "chat_bot_identity_in_use",
              endpointId: conflictEndpoint.id,
              assignedAgentId: conflictEndpoint.assignedAgentId,
            }
          : { code: "chat_bot_identity_in_use" },
      );
    }
  }

  function isNativeBotIdentityUniqueViolation(error: unknown): boolean {
    return (
      isUniqueViolation(error, "chat_endpoints_photon_number_uq") ||
      isUniqueViolation(error, "chat_endpoints_live_bot_external_uq") ||
      isUniqueViolation(error, "chat_endpoints_live_discord_bot_external_uq") ||
      isUniqueViolation(
        error,
        "chat_endpoints_live_global_app_bot_external_uq",
      ) ||
      isUniqueViolation(error, "chat_endpoints_live_bot_username_uq")
    );
  }

  function nativeBotIdentityConflict(provider: ChatProvider) {
    return conflict(
      `This ${PROVIDER_LABELS[provider]} bot already represents another Paperclip agent connection`,
      { code: "chat_bot_identity_in_use" },
    );
  }

  async function persistCredentials(
    endpoint: EndpointRow,
    credentials: Record<string, string>,
    credentialLease: CredentialMutationLeaseGuard,
    actorUserId?: string | null,
  ) {
    await credentialLease.assertOwned();
    const previousRefs = await db
      .select({ refs: toolConnections.credentialSecretRefs })
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, endpoint.companyId),
          eq(toolConnections.id, endpoint.connectionId),
        ),
      )
      .then((rows) => rows[0]?.refs ?? []);
    const refs: ToolCredentialSecretRef[] = [];
    try {
      for (const [key, value] of Object.entries(credentials)) {
        if (endpoint.provider === "imessage-photon" && key !== "projectSecret") continue;
        await credentialLease.assertOwned();
        const suffix = randomUUID();
        const secret = await secrets.create(
          endpoint.companyId,
          {
            name: `chat.${endpoint.provider}.${endpoint.id.slice(0, 8)}.${key}.${suffix.slice(0, 8)}`,
            key: `CHAT_${endpoint.provider.replaceAll("-", "_")}_${endpoint.id.replaceAll("-", "_")}_${key}_${suffix}`.toUpperCase(),
            provider: "local_encrypted",
            managedMode: "paperclip_managed",
            value,
            description: `${PROVIDER_LABELS[endpoint.provider]} channel credential for endpoint ${endpoint.id}`,
          },
          { userId: actorUserId ?? undefined },
        );
        refs.push({
          secretId: secret.id,
          versionSelector: "latest",
          configPath: `credentials.${key}`,
          required: true,
          label: key,
          projectionClass: "unclassified",
        });
        await credentialLease.assertOwned();
      }
      await db.transaction(async (tx) => {
        await credentialLease.assertOwned(tx);
        const current = await tx
          .select({ refs: toolConnections.credentialSecretRefs })
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.companyId, endpoint.companyId),
              eq(toolConnections.id, endpoint.connectionId),
            ),
          )
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current) throw notFound("Chat connection not found");
        if (
          credentialFingerprint(current.refs) !==
          credentialFingerprint(previousRefs)
        ) {
          throw conflict("Chat credentials changed during rotation", {
            code: "chat_endpoint_credentials_changed",
          });
        }
        await tx
          .delete(companySecretBindings)
          .where(
            and(
              eq(companySecretBindings.companyId, endpoint.companyId),
              eq(companySecretBindings.targetType, "tool_connection"),
              eq(companySecretBindings.targetId, endpoint.connectionId),
            ),
          );
        if (refs.length > 0) {
          await tx.insert(companySecretBindings).values(
            refs.map((ref) => ({
              companyId: endpoint.companyId,
              secretId: ref.secretId,
              targetType: "tool_connection",
              targetId: endpoint.connectionId,
              configPath: ref.configPath,
              versionSelector: String(ref.versionSelector ?? "latest"),
              required: ref.required,
              label: ref.label ?? null,
              projectionClass: ref.projectionClass ?? "unclassified",
              projectionAllowlistKey: ref.projectionAllowlistKey ?? null,
            })),
          );
        }
        await tx
          .update(toolConnections)
          .set({ credentialSecretRefs: refs, updatedAt: new Date() })
          .where(eq(toolConnections.id, endpoint.connectionId));
        await credentialLease.assertOwned(tx);
      });
    } catch (error) {
      // A lost database acknowledgement can be ambiguous even when the
      // transaction committed. Delete only secrets proven unbound after the
      // failure; when that proof cannot be read, leak safely for later cleanup
      // instead of deleting a possibly-authoritative credential.
      const boundSecretIds =
        refs.length === 0
          ? new Set<string>()
          : await db
              .select({ secretId: companySecretBindings.secretId })
              .from(companySecretBindings)
              .where(
                and(
                  eq(companySecretBindings.companyId, endpoint.companyId),
                  inArray(
                    companySecretBindings.secretId,
                    refs.map((ref) => ref.secretId),
                  ),
                ),
              )
              .then((rows) => new Set(rows.map((row) => row.secretId)))
              .catch(() => null);
      if (boundSecretIds) {
        await Promise.allSettled(
          refs
            .filter((ref) => !boundSecretIds.has(ref.secretId))
            .map((ref) => secrets.remove(ref.secretId)),
        );
      }
      throw error;
    }
    const currentIds = new Set(refs.map((ref) => ref.secretId));
    const retired = previousRefs.filter((ref) => !currentIds.has(ref.secretId));
    const results = await Promise.allSettled(
      retired.map((ref) => secrets.remove(ref.secretId)),
    );
    if (results.some((result) => result.status === "rejected")) {
      logger.warn(
        { endpointId: endpoint.id },
        "chat credential rotation left an unbound retired secret for later cleanup",
      );
    }
    return refs;
  }

  async function clearCredentials(
    endpoint: EndpointRow,
    credentialLease: CredentialMutationLeaseGuard,
  ) {
    let refs: ToolCredentialSecretRef[] = [];
    await db.transaction(async (tx) => {
      await credentialLease.assertOwned(tx);
      const current = await tx
        .select({ refs: toolConnections.credentialSecretRefs })
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.companyId, endpoint.companyId),
            eq(toolConnections.id, endpoint.connectionId),
          ),
        )
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!current) throw notFound("Chat connection not found");
      refs = current.refs;
      await tx
        .delete(companySecretBindings)
        .where(
          and(
            eq(companySecretBindings.companyId, endpoint.companyId),
            eq(companySecretBindings.targetType, "tool_connection"),
            eq(companySecretBindings.targetId, endpoint.connectionId),
          ),
        );
      await tx
        .update(toolConnections)
        .set({ credentialSecretRefs: [], updatedAt: new Date() })
        .where(eq(toolConnections.id, endpoint.connectionId));
      await credentialLease.assertOwned(tx);
    });
    const results = await Promise.allSettled(
      refs.map((ref) => secrets.remove(ref.secretId)),
    );
    if (results.some((result) => result.status === "rejected")) {
      logger.warn(
        { endpointId: endpoint.id },
        "chat endpoint removal left an unbound retired secret for later cleanup",
      );
    }
  }

  async function resolveCredentialRefs(
    endpoint: EndpointRow,
    refs: ToolCredentialSecretRef[],
    database: DbOrTransaction = db,
  ): Promise<Record<string, string>> {
    const values: Record<string, string> = {};
    for (const ref of refs) {
      const key = ref.configPath.replace(/^credentials\./, "");
      values[key] = await (database === db ? secrets : secretService(database as Db)).resolveSecretValue(
        endpoint.companyId,
        ref.secretId,
        ref.versionSelector ?? "latest",
        {
          consumerType: "tool_connection",
          consumerId: endpoint.connectionId,
          configPath: ref.configPath,
          actorType: "system",
          actorId: null,
        },
      );
    }
    return values;
  }

  async function resolveCredentials(
    endpoint: EndpointRow,
    database: DbOrTransaction = db,
    secretKeys?: readonly string[],
  ): Promise<Record<string, string>> {
    const connection = await database
      .select({ refs: toolConnections.credentialSecretRefs, config: toolConnections.config })
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, endpoint.companyId),
          eq(toolConnections.id, endpoint.connectionId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!connection) throw notFound("Chat connection not found");
    const refs = secretKeys
      ? connection.refs.filter(ref => secretKeys.includes(ref.configPath.replace(/^credentials\./, "")))
      : connection.refs;
    const values = await resolveCredentialRefs(endpoint, refs, database);
    if (endpoint.provider === "imessage-photon") {
      const configuration = photonChannelConfigurationSchema.parse(connection.config.photon);
      return { ...values, ...configuration, lineId: configuration.allocation === "shared" ? photonSharedScope(configuration.projectId) : configuration.lineId };
    }
    return values;
  }

  async function prepareProviderInventory(
    endpoint: EndpointRow,
    credentials: Record<string, string>,
  ): Promise<{
    credentials: Record<string, string>;
    inventory: ChatProviderInventoryResult | null;
    managementUrl?: string;
  }> {
    try {
      if (endpoint.provider === "slack") return await prepareSlackInventory(credentials, fetchImpl);
      if (endpoint.provider === "github") return await prepareGitHubInventory(credentials, fetchImpl);
      if (endpoint.provider === "discord") return await prepareDiscordInventory(credentials, fetchImpl);
      return { credentials, inventory: null };
    } catch (error) {
      throw unprocessable(redactError(error), {
        code: "chat_provider_inventory_failed",
      });
    }
  }
  return { normalizedCredentials, verifyCredentials, nativeBotIdentityMatches, legacyGitHubLabelsMatchVerifiedCredentials, assertNativeBotIdentityAvailable, isNativeBotIdentityUniqueViolation, nativeBotIdentityConflict, persistCredentials, clearCredentials, resolveCredentialRefs, resolveCredentials, prepareProviderInventory };
}
