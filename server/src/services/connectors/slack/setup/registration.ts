import { createAgentAvatarPool } from "../../../agent-avatar-pool.js";
import type { AgentAvatarRequest } from "../../../agent-avatars.js";
import { and, eq } from "drizzle-orm";
import { agents, chatEndpoints, chatSlackRegistrations, toolConnections, type Db } from "@paperclipai/db";
import { slackRegistrationErrorMessage, type SlackRegistrationState, type SlackAvatarState, type SlackAccountState, isProvisionedSlackSetup } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../../../../errors.js";
import { accessService } from "../../../access.js";
import { logActivity } from "../../../activity-log.js";
import { instanceSettingsService } from "../../../instance-settings.js";
import { secretService } from "../../../secrets.js";
import { writeConnectionCredential } from "../../../connection-credentials.js";
import type { CredentialMutationLeaseGuard } from "../../../chat-credential-mutation-lease.js";

export interface SlackSetupActor { userId: string; sessionId: string | null; bypassPermissionCheck: boolean }
export type Registration = typeof chatSlackRegistrations.$inferSelect;


export { object, providerFailure, knownProviderErrors } from "./provider-client.js";
import { object } from "./provider-client.js";

export function slackRegistrationProjection(row: Registration): SlackRegistrationState {
  return {
    status: row.status === "creating" && Date.now() - row.updatedAt.getTime() > 60_000 ? "uncertain" : row.status,
    appId: row.appId,
    ...(row.managerGrantId ? { managerGrantId: row.managerGrantId } : {}),
    managementUrl: row.appId ? `https://api.slack.com/apps/${encodeURIComponent(row.appId)}` : "https://api.slack.com/apps",
    errorCode: row.status === "creating" && Date.now() - row.updatedAt.getTime() > 60_000 ? "slack_creation_uncertain" : row.errorCode,
  };
}

import { createSlackSetupClient } from "./provider-client.js";
export type SlackSetupOptions = {
  managed?: { enabled: boolean; broker: import("../../../paperclip-cloud-connector.js").PaperclipCloudConnector };
  publicOrigin: () => string | null;
  webhookOrigin: () => string | null;
  fetch?: typeof fetch;
  renderAvatar?: (request: AgentAvatarRequest) => Promise<Buffer>;
  withLock: <T>(endpointId: string, work: (lease: CredentialMutationLeaseGuard) => Promise<T>) => Promise<T>;
  runtimeSigningSecret: (endpointId: string) => Promise<string>;
  runtimeBotToken: (endpointId: string) => Promise<string>;
  canWelcome: (endpointId: string, account: SlackAccountState) => Promise<boolean>;
  linkInstaller: (endpointId: string, user: Record<string, unknown>, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) => Promise<void>;
  configure: (endpointId: string, credentials: Record<string, string>, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) => Promise<unknown>;
};
export function createSlackRegistrationStore(db: Db, options: SlackSetupOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const vault = secretService(db);
  let avatarPool: ReturnType<typeof createAgentAvatarPool> | undefined;
  function origin(value: string | null) {
    if (!value) throw badRequest("Configure a public HTTPS URL before creating a Slack app");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw badRequest("Slack setup requires a configured public HTTPS origin");
    return url.origin;
  }
  const callbackUri = () => `${origin(options.publicOrigin())}/api/chat-slack/oauth/callback`;
  async function registration(endpointId: string) {
    return (await db.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, endpointId)))[0];
  }
  async function endpoint(endpointId: string, actor: SlackSetupActor) {
    if (!(await instanceSettingsService(db).getExperimental()).enableChatConnectors) throw forbidden("Chat connectors are disabled");
    const [row] = await db.select({ endpoint: chatEndpoints, connection: toolConnections, agentName: agents.name, agentAppearance: agents.appearance })
      .from(chatEndpoints).innerJoin(toolConnections, and(eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatEndpoints.companyId)))
      .innerJoin(agents, and(eq(agents.id, chatEndpoints.assignedAgentId), eq(agents.companyId, chatEndpoints.companyId)))
      .where(and(eq(chatEndpoints.id, endpointId), eq(chatEndpoints.provider, "slack")));
    if (!row || row.endpoint.status === "archived" || row.connection.status === "archived") throw notFound("Slack connection not found");
    if (!actor.bypassPermissionCheck && !await accessService(db).hasPermission(row.endpoint.companyId, "user", actor.userId, "tools:manage_connections"))
      throw forbidden("Missing permission: tools:manage_connections");
    return row;
  }
  function assertOrigins(row: Registration, publicId: string) {
    if (row.callbackUri !== callbackUri()) throw conflict("The Paperclip URL changed. Restore its configured address or update the Slack app and use manual setup.");
    const expected = `${origin(options.webhookOrigin())}/api/chat-webhooks/${publicId}/slack`;
    if (object(object(row.manifest.settings).event_subscriptions).request_url !== expected)
      throw conflict("The Slack webhook address changed. Restore its configured address or update the Slack app and use manual setup.");
  }
  async function audit(row: Registration, actor: SlackSetupActor, action: string, code?: string) {
    await logActivity(db, { companyId: row.companyId, actorType: "user", actorId: actor.userId,
      action: `chat_slack.${action}`, entityType: "chat_endpoint", entityId: row.endpointId,
      details: { endpointId: row.endpointId, appId: row.appId, ...(code ? { code } : {}) } });
  }
  const api = createSlackSetupClient(fetchImpl);
  async function saveSecrets(row: Registration, values: Record<string, string>, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard,
    patch: Partial<Registration> = {}, account?: SlackAccountState) {
    await db.transaction(async tx => {
      await lease.assertOwned(tx);
      const current = (await tx.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, row.endpointId)).for("update"))[0];
      if (!current || current.requestId !== row.requestId || current.status === "removed") throw conflict("Slack setup changed. Resume the saved connection.");
      const ids = { ...current.secretIds };
      for (const [key, value] of Object.entries(values)) {
        const result = await writeConnectionCredential(tx, { companyId: row.companyId, connectionName: "Slack app registration",
          configPath: `slack_registration.${key}`, label: key, value, actor: { userId: actor.userId },
          ...(ids[key] ? { existingRef: { secretId: ids[key], configPath: `slack_registration.${key}` } } : {}) });
        ids[key] = result.secret.id;
      }
      await tx.update(chatSlackRegistrations).set({ ...patch, secretIds: ids, updatedAt: new Date() }).where(eq(chatSlackRegistrations.endpointId, row.endpointId));
      if (account) {
        const saved = (await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, row.endpointId), eq(chatEndpoints.companyId, row.companyId))).for("update"))[0];
        if (!saved || saved.status === "archived") throw conflict("Slack setup changed");
        // Reauthorization never changes an established personal account binding.
        if (saved.setup.slackAccount?.status !== "linked") await tx.update(chatEndpoints).set({ setup: { ...saved.setup, slackAccount: account }, updatedAt: new Date() }).where(eq(chatEndpoints.id, row.endpointId));
      }
      await lease.assertOwned(tx);
    });
  }
  async function readSecret(row: Registration, key: string) {
    if (!row.secretIds[key]) throw conflict("Slack setup credentials are unavailable. Resume the saved connection.");
    return vault.resolveSecretValue(row.companyId, row.secretIds[key], "latest", {
      accessContext: { consumerType: "system", consumerId: `slack-registration:${row.endpointId}`, configPath: `slack_registration.${key}`, actorType: "system" },
    });
  }
  async function setFailure(row: Registration, status: Registration["status"], code: string, lease: CredentialMutationLeaseGuard) {
    await lease.assertOwned();
    await db.update(chatSlackRegistrations).set({ status, errorCode: code, updatedAt: new Date() })
      .where(and(eq(chatSlackRegistrations.endpointId, row.endpointId), eq(chatSlackRegistrations.requestId, row.requestId)));
  }
  async function saveAvatar(row: Registration, avatar: SlackAvatarState, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    await endpoint(row.endpointId, actor);
    await db.transaction(async tx => {
      await lease.assertOwned(tx);
      const current = (await tx.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, row.endpointId)).for("update"))[0];
      if (!current || current.requestId !== row.requestId || current.status === "removed") throw conflict("Slack setup changed. Resume the saved connection.");
      const saved = (await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, row.endpointId), eq(chatEndpoints.companyId, row.companyId))).for("update"))[0];
      if (!saved || saved.status === "archived" || !isProvisionedSlackSetup(saved.setup.slackSetupMethod)) throw conflict("Slack setup changed. Resume the saved connection.");
      await tx.update(chatEndpoints).set({ setup: { ...saved.setup, slackAvatar: avatar }, updatedAt: new Date() })
        .where(and(eq(chatEndpoints.id, row.endpointId), eq(chatEndpoints.companyId, row.companyId)));
      await lease.assertOwned(tx);
    });
  }
  const renderAvatar = (request: AgentAvatarRequest) => (options.renderAvatar ?? (avatarPool ??= createAgentAvatarPool()).render)(request);
  return { db, options, origin, callbackUri, registration, endpoint, assertOrigins, audit, api, saveSecrets, readSecret, setFailure, saveAvatar, renderAvatar,
    close: async () => { await avatarPool?.close(); } };
}
export type SlackRegistrationStore = ReturnType<typeof createSlackRegistrationStore>;
