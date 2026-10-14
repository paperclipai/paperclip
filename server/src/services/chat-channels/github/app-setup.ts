import type { VerifiedProviderIdentity } from "../runtime-types.js";

import { createSetupProbes } from "../setup-probes.js";

import type { EndpointRow } from "../runtime-types.js";

import { createChatResourceReconciliation } from "../resource-reconciliation.js";

import { chatCredentialMutationLease, type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import { chatGitHubRegistrations } from "@paperclipai/db";

import { githubChatWizardService } from "../../chat-github-wizard.js";
import { registerGitHubBotCloudIngress } from "../../chat-github-cloud-ingress.js";
import { githubChatRegistrationService } from "../../chat-github-registration.js";

import { githubAppJwt } from "../../chat-github-client.js";

import {
  and,
  eq,
  inArray,
  isNull,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatEndpointResources,
  chatEndpoints,
} from "@paperclipai/db";
import type {
  ChatEndpoint,
  ChatProvider,
  ConfigureChatEndpointInput,
  ToolCredentialSecretRef,
  UpdateChatEndpointInput,
} from "@paperclipai/shared";

import {
  HttpError,
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../../../errors.js";

import {
  logActivity,
} from "../../activity-log.js";

import {
  listGitHubAppWebhookDeliveries,
  requestGitHubAppWebhookRedelivery,
} from "../../chat-github-webhook-config.js";

import type { EndpointRecord, PreparedProviderInventory } from "../runtime-types.js";

type GitHubAppSetupOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  normalizedCredentials: (endpoint: EndpointRow, supplied: Record<string, string> | undefined) => Promise<Record<string, string>>;
  verifyCredentials: (provider: ChatProvider, credentials: Record<string, string>) => Promise<VerifiedProviderIdentity>;
  nativeBotIdentityMatches: (provider: ChatProvider, current: VerifiedProviderIdentity, incoming: VerifiedProviderIdentity) => boolean;
  assertNativeBotIdentityAvailable: (endpoint: EndpointRow, identity: VerifiedProviderIdentity) => Promise<void>;
  isNativeBotIdentityUniqueViolation: (error: unknown) => boolean;
  nativeBotIdentityConflict: (provider: ChatProvider) => HttpError;
  persistCredentials: (endpoint: EndpointRow, credentials: Record<string, string>, lease: CredentialMutationLeaseGuard, actorUserId?: string | null) => Promise<ToolCredentialSecretRef[]>;
  resolveCredentials: (endpoint: EndpointRow) => Promise<Record<string, string>>;
  fetchImpl: typeof fetch;
  get: (endpointId: string) => Promise<ChatEndpoint>;
  getPublicBaseUrl: () => string | null;
  getWebhookPublicBaseUrl: () => string | null;
  prepareProviderInventory: (endpoint: EndpointRow, credentials: Record<string, string>) => Promise<PreparedProviderInventory>;
  reconcileProviderResourceRows: ReturnType<typeof createChatResourceReconciliation>["reconcileProviderResourceRows"];
  listResources: ReturnType<typeof createChatResourceReconciliation>["listResources"];
  replaceResources: ReturnType<typeof createChatResourceReconciliation>["replaceResources"];
  update: (endpointId: string, input: UpdateChatEndpointInput, actorUserId?: string | null) => Promise<ChatEndpoint>;
  configure: (endpointId: string, input: ConfigureChatEndpointInput, actorUserId?: string | null) => Promise<ChatEndpoint>;
  test: ReturnType<typeof createSetupProbes>["test"];
  githubWizardOrigin?: string | null;
  handleWebhook: (publicId: string, provider: "github", request: Request) => Promise<Response>;
};

export function createGitHubAppSetup(db: Db, options: GitHubAppSetupOptions) {
  const { endpointRecord, withCredentialMutationLease, normalizedCredentials, verifyCredentials, nativeBotIdentityMatches, assertNativeBotIdentityAvailable, isNativeBotIdentityUniqueViolation, nativeBotIdentityConflict, persistCredentials, resolveCredentials, fetchImpl, get, getPublicBaseUrl, getWebhookPublicBaseUrl, prepareProviderInventory, reconcileProviderResourceRows, listResources, replaceResources, update, configure, test, handleWebhook } = options;


  async function storeGitHubApp(endpointId: string, userId: string, credentials: Record<string, string>, source: "manifest" | "existing_app" = "existing_app") {
    const initial = await endpointRecord(endpointId);
    if (!initial || initial.endpoint.provider !== "github") throw notFound("GitHub bot not found");
    await withCredentialMutationLease(initial.endpoint, async credentialLease => {
      const record = await endpointRecord(endpointId);
      if (!record || ["archived", "active", "paused"].includes(record.endpoint.status)) throw conflict("Use the reconnect flow for an existing active bot");
      const normalized = await normalizedCredentials(record.endpoint, credentials);
      const identity = await verifyCredentials("github", normalized);
      if (record.endpoint.botExternalId && !nativeBotIdentityMatches("github", record.endpoint, identity)) throw conflict("This App belongs to a different bot. Create a new connection instead.");
      await assertNativeBotIdentityAvailable(record.endpoint, identity);
      // Claim the globally unique App identity before writing credentials.
      // A losing concurrent registration must never persist usable secrets.
      if (!record.endpoint.botExternalId) {
        try {
          await db.transaction(async tx => {
            await credentialLease.assertOwned(tx);
            const [current] = await tx.select({ setup: chatEndpoints.setup }).from(chatEndpoints).where(eq(chatEndpoints.id, endpointId)).for("update");
            const [resource] = await tx.select({ id: chatEndpointResources.id }).from(chatEndpointResources).where(eq(chatEndpointResources.endpointId, endpointId)).limit(1);
            // A fresh manual App has no registration session. Record its first
            // import before vault writes so interrupted credential storage can resume.
            const initialImport = !current?.setup.github?.repositorySelectionSaved && !resource;
            const claimed = await tx.update(chatEndpoints).set({ status: "attention", botExternalId: identity.botExternalId, botUsername: identity.botUsername, providerAccountId: identity.providerAccountId, providerAccountLabel: identity.providerAccountLabel,
              setup: sql`jsonb_set(${chatEndpoints.setup}, '{github}', coalesce(${chatEndpoints.setup}->'github', '{}'::jsonb) || ${JSON.stringify({ initialSetupPending: true, ...(initialImport ? { initialRepositoryImportPending: true } : {}) })}::jsonb)`,
              healthMessage: "Complete GitHub App setup", updatedAt: new Date() }).where(and(eq(chatEndpoints.id, endpointId), isNull(chatEndpoints.botExternalId))).returning({ id: chatEndpoints.id });
            if (claimed.length !== 1) throw conflict("The bot changed during registration");
          });
        } catch (error) {
          if (isNativeBotIdentityUniqueViolation(error)) throw nativeBotIdentityConflict("github");
          throw error;
        }
      }
      await persistCredentials(record.endpoint, normalized, credentialLease, userId);
      const slug = identity.botUsername?.replace(/\[bot\]$/, "");
      if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw unprocessable("GitHub did not identify this App");
      await db.transaction(async tx => {
        await credentialLease.assertOwned(tx);
        const [current] = await tx.select({ setup: chatEndpoints.setup, status: chatEndpoints.status }).from(chatEndpoints).where(eq(chatEndpoints.id, endpointId)).for("update");
        if (!current || ["archived", "active", "paused"].includes(current.status)) throw conflict("Use the reconnect flow for an existing active bot");
        await tx.update(chatEndpoints).set({
          status: "attention", botExternalId: identity.botExternalId, botUsername: identity.botUsername,
          botDisplayName: identity.botLabel, providerAccountId: identity.providerAccountId, providerAccountLabel: identity.providerAccountLabel,
          setup: { ...current.setup, github: { ...current.setup.github, appOwnerType: identity.githubOwnerType, appOwnerLogin: identity.githubOwnerLogin, stage: "install", appSlug: slug, installationUrl: `https://github.com/apps/${slug}/installations/new`, registrationStatus: "completed" } },
          healthMessage: "Install the App on GitHub to continue", updatedAt: new Date(),
        }).where(eq(chatEndpoints.id, endpointId));
        if (source === "existing_app") {
          // Explicit recovery uses the existing-App identity path. Only drop the
          // manifest requirement after the same App's credentials are vaulted;
          // leave registration incomplete so advance repairs and verifies delivery.
          await tx.update(chatGitHubRegistrations).set({
            handoff: sql`${chatGitHubRegistrations.handoff} - 'manifestClaimId'`,
          }).where(and(
            eq(chatGitHubRegistrations.companyId, record.endpoint.companyId),
            eq(chatGitHubRegistrations.endpointId, endpointId),
            eq(chatGitHubRegistrations.userId, userId),
            inArray(chatGitHubRegistrations.status, ["pending", "exchanging", "failed"]),
            sql`${chatGitHubRegistrations.handoff} ? 'manifestClaimId'`,
          ));
        }
        await logActivity(tx as unknown as Db, { companyId: record.endpoint.companyId, actorType: "user", actorId: userId, action: "chat_github.app_connected", entityType: "tool_connection", entityId: record.endpoint.connectionId, details: { endpointId, appId: identity.botExternalId } });
      });
    });
    // Manifest registration can send its ping before the credential exchange
    // returns. Request a provider-signed replay after vaulting the secret.
    const stored = await endpointRecord(endpointId);
    const credentialsNow = await resolveCredentials(stored!.endpoint);
    try {
      const appToken = githubAppJwt(credentialsNow.appId, credentialsNow.privateKey);
      const history = await listGitHubAppWebhookDeliveries({ fetch: fetchImpl, appToken });
      const ping = history.deliveries.find(delivery => delivery.event === "ping");
      if (ping) await requestGitHubAppWebhookRedelivery({ fetch: fetchImpl, appToken, deliveryId: ping.id });
    } catch {
      // Registration succeeded. The verify screen exposes signed-delivery
      // recovery rather than reporting credentials as failed or exchanging again.
    }
    return get(endpointId);
  }

  const githubRegistration = githubChatRegistrationService(db, {
    publicOrigin: () => getPublicBaseUrl(), webhookOrigin: () => getWebhookPublicBaseUrl(), fetch: fetchImpl,
    storeApp: async (endpointId, userId, app) => { await storeGitHubApp(endpointId, userId, { appId: app.appId, privateKey: app.privateKey, webhookSecret: app.webhookSecret, ...(app.clientId ? { clientId: app.clientId } : {}), ...(app.clientSecret ? { clientSecret: app.clientSecret } : {}) }, "manifest"); },
  });

  async function refreshGitHubRepositories(endpointId: string, userId: string) {
    const initial = await endpointRecord(endpointId);
    if (!initial || initial.endpoint.provider !== "github") throw notFound("GitHub bot not found");
    await withCredentialMutationLease(initial.endpoint, async lease => {
      const record = await endpointRecord(endpointId);
      if (!record) throw notFound("GitHub bot not found");
      const credentials = await resolveCredentials(record.endpoint);
      const prepared = await prepareProviderInventory(record.endpoint, credentials);
      if (prepared.credentials.installationId !== credentials.installationId) await persistCredentials(record.endpoint, prepared.credentials, lease, userId);
      if (prepared.inventory) await reconcileProviderResourceRows(record.endpoint, prepared.inventory, lease);
      await lease.assertOwned();
      await db.update(chatEndpoints).set({ setup: { ...record.endpoint.setup, github: { ...record.endpoint.setup.github, stage: "repositories", managementUrl: prepared.managementUrl } }, updatedAt: new Date() }).where(eq(chatEndpoints.id, endpointId));
    });
    return listResources(endpointId);
  }

  const githubWizard = githubChatWizardService(db, {
    origin: () => getPublicBaseUrl() ?? options.githubWizardOrigin ?? null, fetch: fetchImpl, startDirect: githubRegistration.start, completeDirect: githubRegistration.complete, resumeDirect: githubRegistration.resumeRegistration,
    storeApp: (id, userId, credentials) => storeGitHubApp(id, userId, credentials, "manifest"),
    storeCredentials: async (id, userId, additional) => {
      const record = await endpointRecord(id);
      if (!record || record.endpoint.provider !== "github") throw notFound("GitHub bot not found");
      await withCredentialMutationLease(record.endpoint, async lease => {
        const current = await endpointRecord(id);
        if (!current || ["archived", "revoked", "paused"].includes(current.endpoint.status)) throw conflict("GitHub App is unavailable");
        const credentials = await resolveCredentials(current.endpoint);
        await persistCredentials(current.endpoint, { ...credentials, ...additional }, lease, userId);
      });
    },
    refreshRepositories: refreshGitHubRepositories, resources: listResources, replaceResources,
    configure: async (id, userId) => {
      await update(id, { allowGroupChats: true }, userId);
      return configure(id, { action: "configure" }, userId);
    },
    finish: (id, userId) => test(id, { optionalSlackTestForUser: userId }),
  });
  const unregisterGitHubCloudIngress = registerGitHubBotCloudIngress(
    db,
    async (endpoint, request) => {
      const record = await endpointRecord(endpoint.id);
      if (
        !record ||
        record.endpoint.companyId !== endpoint.companyId ||
        record.endpoint.connectionId !== endpoint.connectionId ||
        record.endpoint.assignedAgentId !== endpoint.assignedAgentId ||
        record.endpoint.setup.github?.cloudRegistrationId !==
          endpoint.setup.github?.cloudRegistrationId
      )
        throw forbidden("GitHub Cloud event binding changed");
      // A manifest ping may arrive before its webhook verifier reaches the vault.
      // Keep the sealed delivery queued until the stack can authenticate it.
      if (!record.credentialSecretRefs.some((ref) => ref.configPath === "credentials.webhookSecret"))
        throw conflict("GitHub webhook credentials are not ready");
      // Preserve the exact provider payload and signature. Authentication, lifecycle
      // checks and durable admission all run in the stack's canonical ingress.
      const response = await handleWebhook(
        record.endpoint.publicId,
        "github",
        request,
      );
      if ([400, 401, 403, 404, 413, 422].includes(response.status)) return; // Discard hostile transport without retrying it indefinitely.
      if (!response.ok)
        throw conflict("GitHub Cloud ingress could not be durably accepted");
    },
  );
  return { storeGitHubApp, githubRegistration, refreshGitHubRepositories, githubWizard, unregisterGitHubCloudIngress };
}
