import { notifyChatConnectionHealth } from "./connection-health-notifications.js";
import type { ConnectionManagementContext } from "../connection-management.js";
import { CHAT_HUMAN_CREDENTIAL_FIELDS } from "./credentials.js";
import { preparePhotonConfiguration, createPhotonConfiguration } from "./imessage-photon/setup.js";
import { slackRuntimeConfig } from "./slack/setup.js";
import { createTelegramSetup } from "./telegram/setup.js";
import { createGitHubSetup } from "./github/setup.js";
import { createSpekoSetup } from "./speko/setup.js";
import { createGitHubAppSetup } from "./github/app-setup.js";

import type { VerifiedProviderIdentity } from "./runtime-types.js";

import { preservesProvisionedSlackVerification } from "./slack/callback-verification.js";

import { createDiscordCommands } from "./discord/commands.js";

import { createTelegramMaintenance } from "./telegram/maintenance.js";
import type { EndpointRow, RuntimeContext, InternalSetupState } from "./runtime-types.js";

import { createChatResourceReconciliation } from "./resource-reconciliation.js";

import { notifyChatDeliveryWork, notifyChatEndpointWork } from "../chat-work-notifications.js";

import type { ChatEndpointRuntime } from "../voice/voice-runtime.js";

import { chatCredentialMutationLease, type CredentialMutationLeaseGuard } from "../chat-credential-mutation-lease.js";

import { slackChatRegistrationService } from "../chat-slack-registration.js";

import {
  and,
  eq,
  inArray,
  isNull,
  ne,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatEndpoint,
  ChatEndpointSetupState,
  ChatProvider,
  ConfigureChatEndpointInput,
} from "@paperclipai/shared";

import {
  MAX_ATTACHMENT_BYTES,
} from "../../attachment-types.js";

import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../../errors.js";

import {
  type ResolvedChatSdkProviderConfig,
} from "../chat-sdk-runtime.js";
import {
  logActivity,
} from "../activity-log.js";

import type { EndpointRecord } from "./runtime-types.js";
import type { createChatCredentials } from "./credentials.js";
type ChatConfigurationOptions = Pick<ReturnType<typeof createChatCredentials>, "normalizedCredentials" | "verifyCredentials" | "nativeBotIdentityMatches" | "legacyGitHubLabelsMatchVerifiedCredentials" | "assertNativeBotIdentityAvailable" | "isNativeBotIdentityUniqueViolation" | "nativeBotIdentityConflict" | "persistCredentials" | "clearCredentials" | "resolveCredentials" | "prepareProviderInventory"> & {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  get: (endpointId: string) => Promise<ChatEndpoint>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  getWebhookPublicBaseUrl: () => string | null;
  invalidateRuntime: (endpointId: string) => Promise<boolean>;
  reconcileProviderResourceRows: ReturnType<typeof createChatResourceReconciliation>["reconcileProviderResourceRows"];
  reconcileDiscordCommands: ReturnType<typeof createDiscordCommands>["reconcileDiscordCommands"];
  runtimeFor: (endpoint: EndpointRow, input?: { requireDiscordOwnership?: boolean; waitForDiscordOwnership?: boolean }) => Promise<ChatEndpointRuntime>;
  runtimeContextForRecord: (record: EndpointRecord) => RuntimeContext;
  stageTelegramMaintenance: ReturnType<typeof createTelegramMaintenance>["stageTelegramMaintenance"];
  processTelegramMaintenance: ReturnType<typeof createTelegramMaintenance>["processTelegramMaintenance"];
  recordTelegramStopSubscription: ReturnType<typeof createTelegramMaintenance>["recordTelegramStopSubscription"];
  fetchImpl: typeof globalThis.fetch;
  redactError: (error: unknown) => string;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  leasedChatProvider: (provider: string) => boolean;
  PROVIDER_LABELS: Record<ChatProvider, string>;
  SUPPLIED_CREDENTIAL_KEYS: Record<ChatProvider, readonly string[]>;
  RECONNECT_CREDENTIAL_KEYS?: Partial<Record<ChatProvider, readonly string[]>>;
  PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS: number;
  isSupportedTelegramWebhookBaseUrl: (url: string | null) => boolean;
  slackRegistration: Pick<ReturnType<typeof slackChatRegistrationService>, "cleanup">;
  githubWizard: Pick<ReturnType<typeof createGitHubAppSetup>["githubWizard"], "repairCloud">;
  nativeBotIdentityClaimBarrier?: () => Promise<void>;
  allowLocalVoiceBoard?: boolean;
};
export function createChatConfiguration(db: Db, options: ChatConfigurationOptions) {
  const { endpointRecord, get, withCredentialMutationLease, getWebhookPublicBaseUrl, invalidateRuntime, nativeBotIdentityMatches, assertNativeBotIdentityAvailable, isNativeBotIdentityUniqueViolation, nativeBotIdentityConflict, legacyGitHubLabelsMatchVerifiedCredentials, normalizedCredentials, verifyCredentials, persistCredentials, clearCredentials, resolveCredentials, prepareProviderInventory, reconcileProviderResourceRows, reconcileDiscordCommands, runtimeFor, runtimeContextForRecord, stageTelegramMaintenance, processTelegramMaintenance, recordTelegramStopSubscription, fetchImpl, redactError, runtimeGeneration, leasedChatProvider, PROVIDER_LABELS, SUPPLIED_CREDENTIAL_KEYS, PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS, isSupportedTelegramWebhookBaseUrl } = options;
  const { persistPhotonConfiguration } = createPhotonConfiguration(db, { invalidateRuntime });
  const { registerTelegramWebhook } = createTelegramSetup(db, { fetchImpl, getWebhookPublicBaseUrl, PROVIDER_CREDENTIAL_CHECK_TIMEOUT_MS, runtimeContextForRecord, recordTelegramStopSubscription, stageTelegramMaintenance, processTelegramMaintenance });
  const { repairGitHubCloudSetup, repairGitHubWebhookSetup } = createGitHubSetup(db, { fetchImpl, getWebhookPublicBaseUrl, get githubWizard() { return options.githubWizard; } });
  const { installSpekoVoiceTools, configureSpekoTools } = createSpekoSetup(db, { fetchImpl, getWebhookPublicBaseUrl, get allowLocalVoiceBoard() { return options.allowLocalVoiceBoard; } });



  async function configure(
    endpointId: string,
    input: ConfigureChatEndpointInput,
    actorUserId?: string | null,
    managementContext?: ConnectionManagementContext,
  ) {
    await managementContext?.reauthorize();
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    if (record.endpoint.provider === "agentmail") throw badRequest("Use the email inbox API for AgentMail");
    if (input.photon && record.endpoint.provider !== "imessage-photon") throw badRequest("Photon configuration is only valid for iMessage Photon");
    const suppliedCredentialKeys = Object.keys(input.credentials ?? {});
    if (suppliedCredentialKeys.length > 0) {
      const credentialAction =
        input.action === "configure" || input.action === "reconnect";
      const allowedKeys = new Set(
        credentialAction
          ? (input.action === "reconnect" ? options.RECONNECT_CREDENTIAL_KEYS?.[record.endpoint.provider] : undefined) ?? SUPPLIED_CREDENTIAL_KEYS[record.endpoint.provider]
          : [],
      );
      const unsupportedKeys = suppliedCredentialKeys.filter(
        (key) => !allowedKeys.has(key),
      );
      if (unsupportedKeys.length > 0) {
        throw unprocessable(
          `Unsupported ${PROVIDER_LABELS[record.endpoint.provider]} credential fields for ${input.action}: ${unsupportedKeys.join(", ")}`,
          {
            code: "chat_endpoint_credentials_invalid",
            provider: record.endpoint.provider,
            action: input.action,
            unsupportedKeys,
          },
        );
      }
      // These keys establish provider authentication or inbound trust. They
      // must come from the human setup step or a verified provider handoff.
      const credentialFields = CHAT_HUMAN_CREDENTIAL_FIELDS.filter(key => suppliedCredentialKeys.includes(key));
      if (managementContext?.actor.type === "agent" && credentialFields.length) {
        throw forbidden("The responsible user must enter provider verification credentials in the saved setup", {
          code: "chat_endpoint_credential_entry_requires_human",
          credentialFields,
        });
      }
    }
    return withCredentialMutationLease(record.endpoint, (credentialLease) =>
      configureWithCredentialLease(
        endpointId,
        input,
        credentialLease,
        actorUserId,
        managementContext,
      ),
    );
  }

  async function configureWithCredentialLease(
    endpointId: string,
    input: ConfigureChatEndpointInput,
    credentialLease: CredentialMutationLeaseGuard,
    actorUserId?: string | null,
    managementContext?: ConnectionManagementContext,
  ) {
    await managementContext?.reauthorize();
    const record = await endpointRecord(endpointId);
    if (!record) throw notFound("Chat endpoint not found");
    const endpoint = record.endpoint;
    if (input.action === "pause") {
      if (endpoint.status !== "active") {
        throw conflict("Only an active chat connection can be paused", {
          code: "chat_endpoint_not_active",
        });
      }
      await managementContext?.reauthorize();
      await db.transaction(async (tx) => {
        await credentialLease.assertOwned(tx);
        const pausedAt = new Date();
        const current = await tx
          .select({ setup: chatEndpoints.setup, status: chatEndpoints.status })
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpoint.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current || current.status !== "active") {
          throw conflict("Only an active chat connection can be paused", {
            code: "chat_endpoint_not_active",
          });
        }
        await notifyChatEndpointWork(tx, endpoint.connectionId, endpoint.companyId);
        await tx
          .update(chatEndpoints)
          .set({
            status: "paused",
            setup: {
              ...current.setup,
              runtimeGeneration: runtimeGeneration(current.setup) + (endpoint.provider === "imessage-photon" ? 0 : 1),
            } as InternalSetupState,
            updatedAt: pausedAt,
          })
          .where(eq(chatEndpoints.id, endpoint.id));
        await notifyChatConnectionHealth(tx, endpoint);
        await tx
          .update(toolConnections)
          .set({ status: "disabled", enabled: false, updatedAt: new Date() })
          .where(eq(toolConnections.id, endpoint.connectionId));
        await notifyChatDeliveryWork(tx);
        await tx
          .update(chatDeliveries)
          .set({
            state: "filtered",
            nextAttemptAt: null,
            redactedError: "Connection was paused before processing",
            processedAt: pausedAt,
            updatedAt: pausedAt,
          })
          .where(
            and(
              endpoint.provider === "imessage-photon" ? sql`false` : undefined,
              eq(chatDeliveries.endpointId, endpoint.id),
              inArray(chatDeliveries.state, ["received", "retry"]),
            ),
          );
        await credentialLease.assertOwned(tx);
      });
      await invalidateRuntime(endpoint.id);
      await logActivity(db, {
        companyId: endpoint.companyId,
        ...(managementContext?.audit ?? { actorType: "user" as const, actorId: actorUserId ?? "board" }),
        action: "chat_endpoint.paused",
        entityType: "tool_connection",
        entityId: endpoint.connectionId,
        details: { endpointId: endpoint.id },
      });
      return get(endpoint.id);
    }
    if (input.action === "resume") {
      if (endpoint.status !== "paused" || endpoint.setup.step !== "complete") {
        throw conflict(
          "Only a previously active chat connection can be resumed",
          {
            code: "chat_endpoint_not_resumable",
          },
        );
      }
      let credentials = await resolveCredentials(endpoint).catch(() => {
        throw conflict("Reconnect the provider credentials before resuming", {
          code: "chat_endpoint_credentials_missing",
        });
      });
      const identity = await verifyCredentials(endpoint.provider, credentials);
      const upgradingLegacyGitHubIdentity =
        endpoint.provider === "github" &&
        !endpoint.botExternalId &&
        legacyGitHubLabelsMatchVerifiedCredentials(endpoint, identity);
      if (
        !upgradingLegacyGitHubIdentity &&
        !nativeBotIdentityMatches(endpoint.provider, endpoint, identity)
      ) {
        throw conflict(
          "The provider credentials now identify a different bot; reconnect this connection instead",
          {
            code: "chat_bot_identity_changed",
          },
        );
      }
      await assertNativeBotIdentityAvailable(endpoint, identity);
      const prepared = await prepareProviderInventory(endpoint, credentials);
      if (
        endpoint.provider === "github" &&
        prepared.credentials.installationId !== credentials.installationId
      ) {
        await persistCredentials(
          endpoint,
          prepared.credentials,
          credentialLease,
          actorUserId,
          managementContext ? async () => managementContext.reauthorize() : undefined,
        );
      }
      credentials = prepared.credentials;
      if (prepared.inventory)
        await reconcileProviderResourceRows(
          endpoint,
          prepared.inventory,
          credentialLease,
        );
      let activatedEndpoint!: EndpointRow;
      try {
        await managementContext?.reauthorize();
      await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          const resumedAt = new Date();
          const current = await tx
            .select()
            .from(chatEndpoints)
            .where(eq(chatEndpoints.id, endpoint.id))
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!current || current.status !== "paused") {
            throw conflict(
              "Only a previously active chat connection can be resumed",
              {
                code: "chat_endpoint_not_resumable",
              },
            );
          }
          // Fail closed for any legacy or racing delivery that remained open
          // while this endpoint was paused. Resume must never execute traffic
          // that Paperclip acknowledged during the inactive interval.
          await notifyChatDeliveryWork(tx);
          await tx
            .update(chatDeliveries)
            .set({
              state: "filtered",
              nextAttemptAt: null,
              redactedError: "Connection was paused when this event arrived",
              processedAt: resumedAt,
              updatedAt: resumedAt,
            })
            .where(
              and(
                endpoint.provider === "imessage-photon" ? sql`false` : undefined,
                eq(chatDeliveries.endpointId, endpoint.id),
                inArray(chatDeliveries.state, ["received", "retry"]),
              ),
            );
          await notifyChatEndpointWork(tx, endpoint.connectionId, endpoint.companyId);
          [activatedEndpoint] = await tx
            .update(chatEndpoints)
            .set({
              status: "active",
              ...(upgradingLegacyGitHubIdentity
                ? { botExternalId: identity.botExternalId }
                : {}),
              healthMessage: "Connected",
              lastError: null,
              setup: {
                ...current.setup,
                ...(endpoint.provider === "imessage-photon" ? { photonIntakeAfter: resumedAt.toISOString() } : {}),
                runtimeGeneration: runtimeGeneration(current.setup) + (endpoint.provider === "imessage-photon" ? 0 : 1),
              } as InternalSetupState,
              updatedAt: resumedAt,
            })
            .where(eq(chatEndpoints.id, endpoint.id))
            .returning();
          await notifyChatConnectionHealth(tx, endpoint);
          await tx
            .update(toolConnections)
            .set({
              status: "active",
              enabled: true,
              healthStatus: "healthy",
              healthMessage: "Connected",
              lastError: null,
              healthCheckedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(toolConnections.id, endpoint.connectionId));
          await credentialLease.assertOwned(tx);
        });
        await invalidateRuntime(endpoint.id);
        if (activatedEndpoint.provider === "discord")
          await reconcileDiscordCommands(endpoint.id, credentialLease, true);
        await runtimeFor(activatedEndpoint, {
          requireDiscordOwnership: leasedChatProvider(activatedEndpoint.provider),
          waitForDiscordOwnership: leasedChatProvider(activatedEndpoint.provider),
        });
      } catch (error) {
        await invalidateRuntime(endpoint.id).catch(() => undefined);
        if (activatedEndpoint) {
          const failure = redactError(error);
          const failedAt = new Date();
          await managementContext?.reauthorize();
          await db.transaction(async (tx) => {
            await credentialLease.assertOwned(tx);
            await notifyChatEndpointWork(tx, endpoint.connectionId, endpoint.companyId);
            await tx
              .update(chatEndpoints)
              .set({
                status: "attention",
                healthMessage: "Provider resume needs attention",
                lastError: failure,
                updatedAt: failedAt,
              })
              .where(
                and(
                  eq(chatEndpoints.id, endpoint.id),
                  eq(chatEndpoints.status, "active"),
                  sql`coalesce((${chatEndpoints.setup}->>'runtimeGeneration')::integer, 0) = ${runtimeGeneration(activatedEndpoint.setup)}`,
                ),
              );
            await notifyChatConnectionHealth(tx, endpoint);
            await tx
              .update(toolConnections)
              .set({
                status: "disabled",
                enabled: false,
                healthStatus: "degraded",
                healthMessage: "Provider resume failed",
                lastError: failure,
                healthCheckedAt: failedAt,
                updatedAt: failedAt,
              })
              .where(eq(toolConnections.id, endpoint.connectionId));
            await notifyChatDeliveryWork(tx);
            await tx
              .update(chatDeliveries)
              .set({
                state: "filtered",
                nextAttemptAt: null,
                redactedError: "Connection activation failed",
                processedAt: failedAt,
                updatedAt: failedAt,
              })
              .where(
                and(
                  eq(chatDeliveries.endpointId, endpoint.id),
                  inArray(chatDeliveries.state, ["received", "retry"]),
                ),
              );
            await credentialLease.assertOwned(tx);
          });
        }
        throw error;
      }
      await logActivity(db, {
        companyId: endpoint.companyId,
        ...(managementContext?.audit ?? { actorType: "user" as const, actorId: actorUserId ?? "board" }),
        action: "chat_endpoint.resumed",
        entityType: "tool_connection",
        entityId: endpoint.connectionId,
        details: { endpointId: endpoint.id },
      });
      return get(endpoint.id);
    }
    if (input.action === "remove") {
      if (endpoint.status === "archived") {
        if (endpoint.provider === "slack") await options.slackRegistration.cleanup(endpoint.id, credentialLease);
        // Archival is the durable ingress fence and intentionally commits
        // before secret-store cleanup. If that cleanup failed, a repeated
        // remove is the recovery operation; once refs are empty, retain the
        // normal already-removed conflict contract.
        if (record.credentialSecretRefs.length > 0) {
          await invalidateRuntime(endpoint.id).catch(() => undefined);
          if (endpoint.provider === "telegram") {
            await credentialLease.assertOwned();
            const action = await stageTelegramMaintenance(
              endpoint,
              "remove_endpoint",
            );
            if (action)
              await processTelegramMaintenance(
                action.id,
                true,
                credentialLease,
              );
          } else {
            await clearCredentials(endpoint, credentialLease);
          }
          return get(endpoint.id);
        }
        throw conflict("This chat connection has already been removed", {
          code: "chat_endpoint_already_removed",
        });
      }
      await managementContext?.reauthorize();
      await db.transaction(async (tx) => {
        await credentialLease.assertOwned(tx);
        const current = await tx
          .select({ setup: chatEndpoints.setup, status: chatEndpoints.status })
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpoint.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current || current.status === "archived") {
          throw conflict("This chat connection has already been removed", {
            code: "chat_endpoint_already_removed",
          });
        }
        await notifyChatEndpointWork(tx, endpoint.connectionId, endpoint.companyId);
        await tx
          .update(chatEndpoints)
          .set({
            status: "archived",
            setup: {
              ...current.setup,
              runtimeGeneration: runtimeGeneration(current.setup) + 1,
            } as InternalSetupState,
            archivedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, endpoint.id));
        await tx
          .update(chatConversations)
          .set({ state: "endpoint_removed", updatedAt: new Date() })
          .where(eq(chatConversations.endpointId, endpoint.id));
        await notifyChatConnectionHealth(tx, endpoint);
        await tx
          .update(toolConnections)
          .set({ status: "archived", enabled: false, updatedAt: new Date() })
          .where(eq(toolConnections.id, endpoint.connectionId));
        const otherConnection = await tx
          .select({ id: toolConnections.id })
          .from(toolConnections)
          .where(
            and(
              eq(toolConnections.companyId, endpoint.companyId),
              eq(toolConnections.applicationId, record.applicationId),
              ne(toolConnections.id, endpoint.connectionId),
              ne(toolConnections.status, "archived"),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!otherConnection) {
          await tx
            .update(toolApplications)
            .set({
              status: "archived",
              archivedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(toolApplications.id, record.applicationId));
        }
        await credentialLease.assertOwned(tx);
      });
      if (endpoint.provider === "slack") await options.slackRegistration.cleanup(endpoint.id, credentialLease);
      await invalidateRuntime(endpoint.id).catch(() => undefined);
      if (endpoint.provider === "telegram") {
        await credentialLease.assertOwned();
        const action = await stageTelegramMaintenance(
          endpoint,
          "remove_endpoint",
        );
        if (action) {
          await processTelegramMaintenance(action.id, true, credentialLease);
        }
      } else {
        await clearCredentials(endpoint, credentialLease);
      }
      return get(endpoint.id);
    }
    if (
      input.action !== "configure" &&
      input.action !== "reconnect" &&
      input.action !== "verify"
    ) {
      throw unprocessable("Unsupported chat endpoint setup action");
    }
    if (!getWebhookPublicBaseUrl() && endpoint.provider !== "discord" && endpoint.provider !== "imessage-photon" && !(endpoint.provider === "github" && endpoint.setup.github?.cloudRegistrationId)) {
      throw unprocessable(
        `A public HTTPS Paperclip URL is required before connecting ${PROVIDER_LABELS[endpoint.provider]}`,
      );
    }
    if (
      endpoint.provider === "telegram" &&
      (input.action === "configure" || input.action === "reconnect") &&
      !isSupportedTelegramWebhookBaseUrl(getWebhookPublicBaseUrl())
    ) {
      throw unprocessable(
        "Telegram webhooks require PAPERCLIP_CHAT_WEBHOOK_PUBLIC_URL to use HTTPS on port 443, 80, 88, or 8443",
        {
          code: "chat_telegram_webhook_url_unsupported",
          provider: "telegram",
          supportedPorts: [443, 80, 88, 8443],
        },
      );
    }
    if (input.action === "verify") {
      if (
        endpoint.provider !== "slack" ||
        endpoint.status !== "verifying" ||
        endpoint.setup.step !== "provider_setup"
      ) {
        throw conflict(
          "Provider verification is not available at this setup step",
          {
            code: "chat_endpoint_invalid_setup_step",
          },
        );
      }
      if (!endpoint.setup.webhookVerifiedAt) {
        throw conflict("Paperclip has not received a verified Slack callback yet", {
          code: "chat_webhook_not_verified",
        });
      }
    } else if (
      input.action === "configure" &&
      !["draft", "attention", "revoked"].includes(endpoint.status) &&
      // GitHub installation discovery can advance the status before the
      // wizard has configured its runtime. Finish that exact setup stage;
      // configured connections still require the explicit reconnect flow.
      !(
        endpoint.provider === "github" &&
        endpoint.status === "verifying" &&
        endpoint.setup.step === "provider_setup"
      )
    ) {
      throw conflict(
        "This connection is already configured; use its reconnect flow if credentials need repair",
        {
          code: "chat_endpoint_already_configured",
        },
      );
    } else if (
      input.action === "reconnect" &&
      !["verifying", "active", "attention", "revoked", "paused"].includes(
        endpoint.status,
      )
    ) {
      throw conflict(
        "This chat connection does not currently need reconnecting",
        {
          code: "chat_endpoint_not_reconnectable",
        },
      );
    }
    if (
      endpoint.provider === "github" &&
      (input.action === "configure" || input.action === "reconnect") &&
      !endpoint.setup.webhookVerifiedAt
    ) {
      throw conflict(
        "GitHub has not delivered a signed webhook ping for this secret yet",
        {
          code: "chat_webhook_not_verified",
        },
      );
    }

    let verifiedCurrentIdentity: VerifiedProviderIdentity = endpoint;
    if (
      input.action === "reconnect" &&
      endpoint.provider === "github" &&
      !endpoint.botExternalId
    ) {
      const storedCredentials = await resolveCredentials(endpoint).catch(() => {
        throw conflict(
          "Reconnect the existing GitHub App credentials before changing them",
          {
            code: "chat_bot_identity_unverifiable",
          },
        );
      });
      const storedIdentity = await verifyCredentials(
        "github",
        storedCredentials,
      );
      if (
        !legacyGitHubLabelsMatchVerifiedCredentials(endpoint, storedIdentity)
      ) {
        throw conflict(
          "The stored credentials no longer verify the GitHub App that owns this connection",
          {
            code: "chat_bot_identity_unverifiable",
          },
        );
      }
      verifiedCurrentIdentity = storedIdentity;
    }

    const previousSpekoSigningSecret = endpoint.provider === "speko"
      ? (await resolveCredentials(endpoint).catch(() => ({} as Record<string, string>))).signingSecret : undefined;
    let credentials =
      input.credentials && Object.keys(input.credentials).length > 0
        ? await normalizedCredentials(endpoint, input.credentials)
        : await resolveCredentials(endpoint).catch(() => {
            throw unprocessable(
              `${PROVIDER_LABELS[endpoint.provider]} credentials are required`,
            );
          });
    await managementContext?.reauthorize();
    if (endpoint.provider === "imessage-photon") {
      credentials = preparePhotonConfiguration(endpoint, input, credentials);
    }
    const identity = await verifyCredentials(endpoint.provider, credentials);
    // Once setup has claimed a provider bot identity, every credential repair
    // must prove that same identity before secrets can be replaced. A process
    // interruption can leave the endpoint in `attention` after the claim but
    // before credential persistence; a repeated first-setup request must not
    // turn that recovery state into an identity-swap escape hatch.
    if (input.action === "reconnect" || Boolean(endpoint.botExternalId)) {
      if (
        !nativeBotIdentityMatches(
          endpoint.provider,
          verifiedCurrentIdentity,
          identity,
        )
      ) {
        throw conflict(
          "The provider credentials identify a different bot; create a new connection for that bot instead",
          { code: "chat_bot_identity_changed" },
        );
      }
    }
    await assertNativeBotIdentityAvailable(endpoint, identity);
    const prepared = await prepareProviderInventory(endpoint, credentials);
    const credentialsChangedByDiscovery =
      endpoint.provider === "github" &&
      prepared.credentials.installationId !== credentials.installationId;
    credentials = prepared.credentials;
    await options.nativeBotIdentityClaimBarrier?.();
    // Claim a fresh provider identity before any newly supplied secrets are
    // persisted. The provider-global unique indexes are the multi-process
    // arbitration boundary when two setup requests both pass the optimistic
    // preflight. A process that stops after this small claim leaves a
    // fail-closed attention endpoint that the same operator can reconnect;
    // it never leaves credentials bound to the losing endpoint.
    if (!endpoint.botExternalId) {
      try {
        await managementContext?.reauthorize();
        const claimed = await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          await notifyChatEndpointWork(tx, endpoint.connectionId, endpoint.companyId);
          const rows = await tx
            .update(chatEndpoints)
            .set({
              status: "attention",
              providerAccountId: identity.providerAccountId ?? null,
              providerAccountLabel: identity.providerAccountLabel ?? null,
              botExternalId: identity.botExternalId ?? null,
              botUsername: identity.botUsername ?? null,
              botDisplayName:
                identity.botLabel ??
                endpoint.botDisplayName ??
                record.assignedAgentName,
              healthMessage: "Provider setup must be completed",
              lastError: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatEndpoints.id, endpoint.id),
                eq(chatEndpoints.status, endpoint.status),
                isNull(chatEndpoints.botExternalId),
              ),
            )
            .returning({ id: chatEndpoints.id });
          await credentialLease.assertOwned(tx);
          return rows;
        });
        if (claimed.length !== 1) {
          throw conflict("This chat connection changed during setup", {
            code: "chat_endpoint_setup_changed",
          });
        }
      } catch (error) {
        if (isNativeBotIdentityUniqueViolation(error)) {
          throw nativeBotIdentityConflict(endpoint.provider);
        }
        throw error;
      }
    }
    if (endpoint.provider === "imessage-photon") {
      await persistPhotonConfiguration(endpoint, credentials, credentialLease);
    }
    if (
      (input.credentials && Object.keys(input.credentials).length > 0) ||
      credentialsChangedByDiscovery
    )
      await persistCredentials(
        endpoint,
        credentials,
        credentialLease,
        actorUserId,
        managementContext ? async () => managementContext.reauthorize() : undefined,
      );
    if (prepared.inventory)
      await reconcileProviderResourceRows(
        endpoint,
        prepared.inventory,
        credentialLease,
      );
    const updatedAt = new Date();
    const waitingForSlackConfiguration =
      endpoint.provider === "slack" &&
      (input.action === "configure" || input.action === "reconnect");
    try {
      await managementContext?.reauthorize();
      await db.transaction(async (tx) => {
        await credentialLease.assertOwned(tx);
        const current = await tx
          .select({ setup: chatEndpoints.setup })
          .from(chatEndpoints)
          .where(eq(chatEndpoints.id, endpoint.id))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current) throw notFound("Chat endpoint not found");
        if (endpoint.provider === "speko") {
        await installSpekoVoiceTools(tx, endpoint, actorUserId);
      }
        const preserveSlackVerification = preservesProvisionedSlackVerification(current.setup, credentials.signingSecret ?? "", `${getWebhookPublicBaseUrl()}/api/chat-webhooks/${endpoint.publicId}/slack`);
        await notifyChatEndpointWork(tx, endpoint.connectionId, endpoint.companyId);
        await tx
          .update(chatEndpoints)
          .set({
            status: "verifying",
            providerAccountId: identity.providerAccountId ?? null,
            providerAccountLabel: identity.providerAccountLabel ?? null,
            botExternalId: identity.botExternalId ?? null,
            botUsername: identity.botUsername ?? null,
            botDisplayName:
              identity.botLabel ??
              endpoint.botDisplayName ??
              record.assignedAgentName,
            healthMessage: waitingForSlackConfiguration
              ? "Finish provider webhook configuration"
              : "Waiting for a test conversation",
            lastError: null,
            lastEventAt: null,
            setup: {
              ...current.setup,
              ...(endpoint.provider === "github" ? { github: { ...current.setup.github, stage: current.setup.github?.stage ?? "connect", appOwnerType: identity.githubOwnerType, appOwnerLogin: identity.githubOwnerLogin } } : {}),
              step: waitingForSlackConfiguration ? "provider_setup" : "test",
              ...(endpoint.provider === "imessage-photon" ? { photonIntakeAfter: (current.setup as InternalSetupState).photonIntakeAfter ?? updatedAt.toISOString() } : {}),
              testStartedAt: waitingForSlackConfiguration
                ? null
                : updatedAt.toISOString(),
              webhookVerifiedAt: waitingForSlackConfiguration
                ? preserveSlackVerification ? (current.setup.webhookVerifiedAt ?? null) : null
                : (current.setup.webhookVerifiedAt ?? null),
              runtimeGeneration: runtimeGeneration(current.setup) + 1,
            } as InternalSetupState,
            updatedAt,
          })
          .where(eq(chatEndpoints.id, endpoint.id));
        await notifyChatConnectionHealth(tx, endpoint);
        await tx
          .update(toolConnections)
          .set({
            status: "active",
            enabled: true,
            healthStatus: "healthy",
            healthMessage: "Provider credentials verified",
            healthCheckedAt: updatedAt,
            updatedAt,
          })
          .where(eq(toolConnections.id, endpoint.connectionId));
        await tx
          .update(toolApplications)
          .set({ status: "active", archivedAt: null, updatedAt })
          .where(eq(toolApplications.id, record.applicationId));
        await credentialLease.assertOwned(tx);
      });
    } catch (error) {
      if (isNativeBotIdentityUniqueViolation(error)) {
        throw nativeBotIdentityConflict(endpoint.provider);
      }
      throw error;
    }
    try {
      const next = await endpointRecord(endpoint.id);
      if (!next) throw notFound("Chat endpoint not found");
      await invalidateRuntime(endpoint.id);
      if (endpoint.provider === "github" && input.action === "reconnect" && endpoint.setup.github?.cloudRegistrationId) {
        await repairGitHubCloudSetup(endpoint, credentialLease, actorUserId);
      }
      if (endpoint.provider === "github" && input.action === "reconnect" && !endpoint.setup.github?.cloudRegistrationId) {
        await repairGitHubWebhookSetup(endpoint, credentials, credentialLease, actorUserId);
      }
      if (next.endpoint.provider === "speko") {
        await configureSpekoTools(endpoint, credentials, credentialLease, previousSpekoSigningSecret);
      }
      if (next.endpoint.provider === "discord")
        await reconcileDiscordCommands(endpoint.id, credentialLease, true);
      await runtimeFor(next.endpoint, {
        requireDiscordOwnership: next.endpoint.provider === "discord",
        waitForDiscordOwnership: next.endpoint.provider === "discord",
      });

      if (endpoint.provider === "telegram" && getWebhookPublicBaseUrl()) {
        await registerTelegramWebhook(endpoint, input, credentials, credentialLease, next);
      }
    } catch (error) {
      const failure = redactError(error);
      await invalidateRuntime(endpoint.id).catch(() => undefined);
      await managementContext?.reauthorize();
      await db.transaction(async (tx) => {
        await credentialLease.assertOwned(tx);
        await notifyChatEndpointWork(tx, endpoint.connectionId, endpoint.companyId);
        await tx
          .update(chatEndpoints)
          .set({
            status: "attention",
            healthMessage: "Provider setup needs attention",
            lastError: failure,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, endpoint.id));
        await notifyChatConnectionHealth(tx, endpoint);
        await tx
          .update(toolConnections)
          .set({
            healthStatus: "degraded",
            healthMessage: "Provider setup failed",
            lastError: failure,
            healthCheckedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, endpoint.connectionId));
        await credentialLease.assertOwned(tx);
      });
      throw unprocessable(failure, { code: "chat_provider_setup_failed" });
    }

    await managementContext?.reauthorize();
      await db.transaction(async (tx) => {
      await credentialLease.assertOwned(tx);
      await logActivity(tx as unknown as Db, {
        companyId: endpoint.companyId,
        ...(managementContext?.audit ?? { actorType: "user" as const, actorId: actorUserId ?? "board" }),
        action:
          input.action === "reconnect"
            ? "chat_endpoint.reconnected"
            : "chat_endpoint.credentials_verified",
        entityType: "tool_connection",
        entityId: endpoint.connectionId,
        details: { endpointId: endpoint.id, provider: endpoint.provider },
      });
      await credentialLease.assertOwned(tx);
    });
    return get(endpoint.id);
  }

  function runtimeConfig(
    endpoint: EndpointRow,
    userName: string,
    credentials: Record<string, string>,
  ): ResolvedChatSdkProviderConfig {
    if (endpoint.provider === "speko") throw conflict("Speko uses the voice runtime");
    if (endpoint.provider === "imessage-photon") return {
      provider: "imessage-photon", userName,
      intakeAfter: Date.parse(String((endpoint.setup as InternalSetupState).photonIntakeAfter ?? endpoint.setup.testStartedAt ?? endpoint.createdAt.toISOString())),
      credentials: { allocation: credentials.allocation === "shared" ? "shared" : "dedicated", projectId: credentials.projectId, lineId: credentials.lineId, projectSecret: credentials.projectSecret, phoneNumber: endpoint.botExternalId! },
    };
    if (endpoint.provider === "slack")
      return slackRuntimeConfig(endpoint, userName, credentials);
    if (endpoint.provider === "telegram")
      return {
        provider: "telegram",
        userName,
        maxDownloadBytes: MAX_ATTACHMENT_BYTES,
        credentials: {
          botToken: credentials.botToken,
          secretToken: credentials.webhookSecret,
        },
      };
    if (endpoint.provider === "discord")
      return {
        provider: "discord",
        userName,
        credentials: {
          applicationId: credentials.applicationId,
          botToken: credentials.botToken,
          guildId: credentials.guildId,
        },
      };
    if (endpoint.provider === "microsoft-teams")
      return {
        provider: "microsoft-teams",
        userName,
        credentials: {
          appId: credentials.clientId,
          appPassword: credentials.clientSecret,
          appTenantId: credentials.tenantId,
          appType: "SingleTenant",
        },
      };
    return {
      provider: "github",
      userName,
      credentials: {
        appId: credentials.appId,
        privateKey: credentials.privateKey,
        installationId: credentials.installationId
          ? Number(credentials.installationId)
          : undefined,
        webhookSecret: credentials.webhookSecret,
      },
    };
  }
  return { configure, configureWithCredentialLease, runtimeConfig };
}
