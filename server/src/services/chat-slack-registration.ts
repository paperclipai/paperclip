import { createAgentAvatarPool } from "./agent-avatar-pool.js";
import type { AgentAvatarRequest } from "./agent-avatars.js";
import { removeSlackRegistration } from "./chat-slack-registration-cleanup.js";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, like, sql } from "drizzle-orm";
import { agents, chatEndpoints, chatSlackRegistrations, companies, toolConnections, toolOauthStates, type Db } from "@paperclipai/db";
import { resolveAgentAppearance, buildSlackAppManifest, slackAppConfigurationSchema, slackRegistrationErrorMessage, type SlackRegistrationInput, type SlackRegistrationState, type SlackAvatarState, type SlackAccountState } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "./instance-settings.js";
import { secretService } from "./secrets.js";
import { writeConnectionCredential } from "./connection-credentials.js";
import type { CredentialMutationLeaseGuard } from "./chat-credential-mutation-lease.js";

export interface SlackSetupActor { userId: string; sessionId: string | null; bypassPermissionCheck: boolean }
type Registration = typeof chatSlackRegistrations.$inferSelect;
const prefix = "slack-install.";
const timeoutMs = 20_000;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const providerFailure = (code: string) => unprocessable(slackRegistrationErrorMessage(code), { code });
const knownProviderErrors: Record<string, string> = {
  invalid_auth: "slack_configuration_token_invalid", token_expired: "slack_configuration_token_invalid",
  token_revoked: "slack_configuration_token_invalid", not_authed: "slack_configuration_token_invalid",
  invalid_manifest: "slack_manifest_invalid", invalid_app: "slack_manifest_invalid",
  ratelimited: "slack_setup_rate_limited", no_permission: "slack_setup_permission_denied",
  missing_scope: "slack_setup_permission_denied", not_allowed_token_type: "slack_configuration_token_invalid",
};

export function slackRegistrationProjection(row: Registration): SlackRegistrationState {
  return {
    status: row.status === "creating" && Date.now() - row.updatedAt.getTime() > 60_000 ? "uncertain" : row.status,
    appId: row.appId,
    managementUrl: row.appId ? `https://api.slack.com/apps/${encodeURIComponent(row.appId)}` : "https://api.slack.com/apps",
    errorCode: row.status === "creating" && Date.now() - row.updatedAt.getTime() > 60_000 ? "slack_creation_uncertain" : row.errorCode,
  };
}

export function slackChatRegistrationService(db: Db, options: {
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
}) {
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
  async function api(method: string, fields: Record<string, string> | FormData, bearer?: string) {
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { ...(fields instanceof FormData ? {} : { "content-type": "application/x-www-form-urlencoded" }), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: fields instanceof FormData ? fields : new URLSearchParams(fields),
    });
    const result = object(await response.json());
    if (!response.ok || result.ok !== true) {
      const code = knownProviderErrors[String(result.error)] ?? (response.status === 429 ? "slack_setup_rate_limited" : "slack_provider_failure");
      throw providerFailure(code);
    }
    return result;
  }
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
      if (!saved || saved.status === "archived" || saved.setup.slackSetupMethod !== "automatic") throw conflict("Slack setup changed. Resume the saved connection.");
      await tx.update(chatEndpoints).set({ setup: { ...saved.setup, slackAvatar: avatar }, updatedAt: new Date() })
        .where(and(eq(chatEndpoints.id, row.endpointId), eq(chatEndpoints.companyId, row.companyId)));
      await lease.assertOwned(tx);
    });
  }
  async function create(endpointId: string, actor: SlackSetupActor, input: SlackRegistrationInput) {
    return options.withLock(endpointId, async lease => {
      const current = await endpoint(endpointId, actor);
      const previous = await registration(endpointId);
      if (previous?.status === "removed") throw conflict("This registration was removed. Continue the selected manual setup.");
      if (previous?.appId) {
        if (previous.errorCode === "slack_manifest_update_pending") {
          await configureManifest(previous, actor, input.credentials.configurationToken, lease);
        }
        return;
      }
      if (previous?.requestId === input.requestId) return;
      if (previous && ["creating", "uncertain"].includes(previous.status) && !input.confirmedNoAppCreated) {
        await setFailure(previous, "uncertain", "slack_creation_uncertain", lease);
        return;
      }
      if (current.endpoint.status !== "draft" || current.endpoint.botExternalId || current.endpoint.setup.slackSetupMethod !== "automatic")
        throw conflict("Automatic creation is only available for a new Slack connection");
      const app = slackAppConfigurationSchema.parse(current.endpoint.setup.slackApp);
      const redirect = callbackUri();
      const manifest = buildSlackAppManifest({ app, agentName: current.agentName,
        webhookUrl: `${origin(options.webhookOrigin())}/api/chat-webhooks/${current.endpoint.publicId}/slack`, redirectUri: redirect });
      // Slack cannot authenticate a challenge until its creation response gives us
      // the signing secret. Add event subscriptions only after that secret is durable.
      const { event_subscriptions: _events, ...creationSettings } = manifest.settings;
      const creationManifest = { ...manifest, settings: creationSettings };
      try { await api("apps.manifest.validate", { manifest: JSON.stringify(manifest) }, input.credentials.configurationToken); }
      catch (error) {
        if (error instanceof Error && "status" in error) throw error;
        throw providerFailure("slack_provider_failure");
      }
      // No provider creation has happened until this intent is durable.
      await endpoint(endpointId, actor);
      await lease.assertOwned();
      const values = { companyId: current.endpoint.companyId, requestId: input.requestId, status: "creating" as const,
        manifest, manifestHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"), callbackUri: redirect,
        createdByUserId: actor.userId, errorCode: null, updatedAt: new Date() };
      const [row] = await db.insert(chatSlackRegistrations).values({ endpointId, ...values })
        .onConflictDoUpdate({ target: chatSlackRegistrations.endpointId, set: values }).returning();
      await audit(row, actor, "creation_started");
      let createdAppId: string;
      try {
        const result = await api("apps.manifest.create", { manifest: JSON.stringify(creationManifest) }, input.credentials.configurationToken);
        const credentials = object(result.credentials);
        if (typeof result.app_id !== "string" || !/^A[A-Z0-9]+$/.test(result.app_id)
          || typeof credentials.client_id !== "string" || !/^\d+\.\d+$/.test(credentials.client_id)
          || typeof credentials.client_secret !== "string" || !credentials.client_secret
          || typeof credentials.signing_secret !== "string" || !credentials.signing_secret)
          throw new Error("Incomplete Slack creation response");
        await endpoint(endpointId, actor);
        await saveSecrets(row, { signingSecret: credentials.signing_secret, clientSecret: credentials.client_secret }, actor, lease,
          { appId: result.app_id, clientId: credentials.client_id, status: "install", errorCode: "slack_manifest_update_pending" });
        createdAppId = result.app_id;
      } catch (error) {
        // Only documented rejection responses prove that creation did not happen.
        const code = object(object(error).details).code;
        const rejected = typeof code === "string" && Object.values(knownProviderErrors).includes(code);
        await setFailure(row, rejected ? "failed" : "uncertain", rejected ? code : "slack_creation_uncertain", lease);
        await audit(row, actor, "creation_failed", rejected ? code : "slack_creation_uncertain");
        return;
      }
      // The app and credentials are durable before optional icon provisioning.
      // A retry/restart always reuses this app, even if icon upload is interrupted.
      const created = { ...row, appId: createdAppId };
      if (!await configureManifest(created, actor, input.credentials.configurationToken, lease)) return;
      await saveAvatar(created, { status: "pending" }, actor, lease);
      let avatar: SlackAvatarState;
      try {
        await endpoint(endpointId, actor);
        await lease.assertOwned();
        // Cloud ingress requires a tenant session. Send the preset PNG bytes so
        // Slack does not need to fetch an authenticated Paperclip URL.
        const render = options.renderAvatar ?? (avatarPool ??= createAgentAvatarPool()).render;
        const png = await render({ appearance: resolveAgentAppearance(current.agentAppearance, current.endpoint.assignedAgentId),
          size: 512, scale: 1, pose: "rest", muted: false, background: "paperclip-dark" });
        await endpoint(endpointId, actor);
        await lease.assertOwned();
        const upload = new FormData();
        upload.set("app_id", createdAppId);
        upload.set("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "agent-avatar.png");
        await api("apps.icon.set", upload, input.credentials.configurationToken);
        avatar = { status: "uploaded", uploadedAt: new Date().toISOString() };
      } catch {
        // Provider echoes (including tokens) never become saved state or activity.
        avatar = { status: "failed", errorCode: "slack_avatar_upload_failed" };
      }
      await saveAvatar(created, avatar, actor, lease);
      try { await audit(created, actor, avatar.status === "uploaded" ? "avatar_uploaded" : "avatar_upload_failed", avatar.status === "failed" ? avatar.errorCode : undefined); }
      catch { logger.warn({ endpointId, appId: createdAppId }, "Slack avatar activity could not be recorded"); }
      // An audit outage cannot change the saved creation outcome.
      try { await audit({ ...row, appId: createdAppId }, actor, "app_created"); }
      catch { logger.warn({ endpointId, appId: createdAppId }, "Slack app creation activity could not be recorded"); }
    });
  }
  async function configureManifest(row: Registration, actor: SlackSetupActor, configurationToken: string, lease: CredentialMutationLeaseGuard) {
    const current = await endpoint(row.endpointId, actor);
    if (current.endpoint.status !== "draft" || current.endpoint.setup.slackSetupMethod !== "automatic")
      throw conflict("Resume the saved Slack connection before configuring its app");
    assertOrigins(row, current.endpoint.publicId);
    await lease.assertOwned();
    try {
      await api("apps.manifest.update", { app_id: row.appId!, manifest: JSON.stringify(row.manifest) }, configurationToken);
    } catch {
      // The pending marker was saved with the app secrets before dispatch. Retrying
      // the same manifest is safe even when Slack's response was lost.
      await audit(row, actor, "manifest_update_failed", "slack_manifest_update_pending");
      return false;
    }
    await endpoint(row.endpointId, actor);
    await lease.assertOwned();
    await db.update(chatSlackRegistrations).set({ errorCode: null, updatedAt: new Date() })
      .where(and(eq(chatSlackRegistrations.endpointId, row.endpointId), eq(chatSlackRegistrations.requestId, row.requestId)));
    await audit(row, actor, "manifest_updated");
    return true;
  }
  async function install(endpointId: string, actor: SlackSetupActor) {
    return options.withLock(endpointId, async lease => {
      const current = await endpoint(endpointId, actor);
      const row = await registration(endpointId);
      if (!row?.appId || !row.clientId || row.status === "removed") throw conflict("Create this Slack app before installing it");
      if (row.errorCode === "slack_manifest_update_pending") throw conflict("Finish configuring the saved Slack app before installing it");
      if (current.endpoint.setup.slackSetupMethod !== "automatic" || current.endpoint.status === "paused") throw conflict("Resume this connection before installing it");
      assertOrigins(row, current.endpoint.publicId);
      const state = `${prefix}${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      const scopes = object(object(row.manifest.oauth_config).scopes).bot as string[];
      await db.transaction(async tx => {
        await lease.assertOwned(tx);
        await tx.delete(toolOauthStates).where(and(eq(toolOauthStates.connectionId, current.connection.id), like(toolOauthStates.state, `${prefix}%`)));
        await tx.insert(toolOauthStates).values({ state, companyId: row.companyId, connectionId: current.connection.id,
          codeVerifier: JSON.stringify({ endpointId, requestId: row.requestId, appId: row.appId, callbackUri: row.callbackUri,
            endpointStatus: current.endpoint.status, runtimeGeneration: object(current.endpoint.setup).runtimeGeneration ?? 0 }),
          createdByActorType: "user", createdByActorId: actor.userId, createdBySessionId: actor.sessionId,
          requestedScopes: scopes, expiresAt });
        await tx.update(chatSlackRegistrations).set({ errorCode: null, updatedAt: new Date() }).where(eq(chatSlackRegistrations.endpointId, endpointId));
      });
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.search = new URLSearchParams({ client_id: row.clientId, scope: scopes.join(","), state, redirect_uri: row.callbackUri,
        ...(row.workspaceId ? { team: row.workspaceId } : {}) }).toString();
      await audit(row, actor, "installation_started");
      return { authorizationUrl: url.toString(), expiresAt: expiresAt.toISOString() };
    });
  }
  async function expiredReturn(state: string, actor: SlackSetupActor) {
    if (!/^slack-install\.[A-Za-z0-9_-]{43}$/.test(state)) return null;
    const [attempt] = await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state));
    if (!attempt || attempt.expiresAt.getTime() > Date.now() || attempt.createdByActorId !== actor.userId || attempt.createdBySessionId !== actor.sessionId) return null;
    const binding = object(JSON.parse(attempt.codeVerifier));
    const current = await endpoint(String(binding.endpointId), actor);
    return options.withLock(current.endpoint.id, async lease => {
      const latest = await endpoint(current.endpoint.id, actor);
      const row = await registration(current.endpoint.id);
      if (!row || row.status === "removed" || row.requestId !== binding.requestId || row.companyId !== attempt.companyId || latest.connection.id !== attempt.connectionId
        || latest.endpoint.setup.slackSetupMethod !== "automatic" || row.appId !== binding.appId || row.callbackUri !== binding.callbackUri) return null;
      assertOrigins(row, latest.endpoint.publicId);
      await lease.assertOwned();
      await db.delete(toolOauthStates).where(eq(toolOauthStates.state, state));
      await setFailure(row, row.status, "slack_install_expired", lease);
      await audit(row, actor, "installation_failed", "slack_install_expired");
      return returnPath(row.endpointId);
    });
  }
  async function pending(state: string, actor: SlackSetupActor) {
    if (!/^slack-install\.[A-Za-z0-9_-]{43}$/.test(state)) throw badRequest("Invalid Slack authorization state");
    const [attempt] = await db.select().from(toolOauthStates).where(and(eq(toolOauthStates.state, state), gt(toolOauthStates.expiresAt, new Date())));
    if (!attempt || attempt.createdByActorId !== actor.userId || attempt.createdBySessionId !== actor.sessionId)
      throw forbidden("Slack authorization expired or belongs to another session. Resume setup and install again.");
    const binding = object(JSON.parse(attempt.codeVerifier));
    const current = await endpoint(String(binding.endpointId), actor);
    const row = await registration(current.endpoint.id);
    if (!row || row.status === "removed" || current.endpoint.setup.slackSetupMethod !== "automatic"
      || current.endpoint.status === "paused"
      || current.endpoint.status === "revoked" && binding.endpointStatus !== "revoked"
      || binding.runtimeGeneration !== (object(current.endpoint.setup).runtimeGeneration ?? 0)
      || row.requestId !== binding.requestId || row.appId !== binding.appId || row.callbackUri !== binding.callbackUri
      || row.callbackUri !== callbackUri() || attempt.companyId !== row.companyId || attempt.connectionId !== current.connection.id)
      throw conflict("Slack setup changed. Resume the saved connection and install again.");
    assertOrigins(row, current.endpoint.publicId);
    return { attempt, current, row };
  }
  async function saveAccount(row: Registration, account: SlackAccountState, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    await endpoint(row.endpointId, actor);
    await db.transaction(async tx => {
      await lease.assertOwned(tx);
      const saved = (await tx.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, row.endpointId), eq(chatEndpoints.companyId, row.companyId))).for("update"))[0];
      const registrationNow = (await tx.select().from(chatSlackRegistrations).where(eq(chatSlackRegistrations.endpointId, row.endpointId)))[0];
      if (!saved || saved.status === "archived" || registrationNow?.status === "removed" || registrationNow?.requestId !== row.requestId) throw conflict("Slack setup changed");
      await tx.update(chatEndpoints).set({ setup: { ...saved.setup, slackAccount: account }, updatedAt: new Date() }).where(eq(chatEndpoints.id, row.endpointId));
      await lease.assertOwned(tx);
    });
  }
  async function linkAccount(row: Registration, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    const current = await endpoint(row.endpointId, actor);
    const account = current.endpoint.setup.slackAccount;
    if (!account) throw providerFailure("slack_install_account_missing");
    if (account.status === "linked") return;
    const token = row.secretIds.botToken ? await readSecret(row, "botToken") : await options.runtimeBotToken(row.endpointId);
    const user = object((await api("users.info", { user: account.externalUserId }, token)).user);
    if (user.id !== account.externalUserId || user.team_id !== row.workspaceId || user.is_bot !== false || user.is_app_user === true || user.deleted !== false) throw providerFailure("slack_install_account_missing");
    await endpoint(row.endpointId, actor);
    await options.linkInstaller(row.endpointId, user, { ...actor, userId: account.paperclipUserId }, lease);
    await saveAccount(row, { ...account, status: "linked" }, actor, lease);
    try { await audit(row, actor, "account_linked"); }
    catch { logger.warn({ endpointId: row.endpointId, appId: row.appId }, "Slack account activity could not be recorded"); }
  }
  async function sendSetupMessage(row: Registration, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard, kind: "welcome" | "verification") {
    const current = await endpoint(row.endpointId, actor);
    const account = current.endpoint.setup.slackAccount;
    if (!account || account.status !== "linked") return;
    if (kind === "verification" && (!current.endpoint.setup.webhookVerifiedAt || ["pending", "sending"].includes(account.welcomeStatus))) return;
    const field = kind === "welcome" ? "welcomeStatus" : "verificationStatus";
    const status = account[field] ?? "pending";
    if (status === "sending") {
      await saveAccount(row, { ...account, [field]: "uncertain" }, actor, lease);
      return; // Never replay an ambiguous dispatch after a process restart.
    }
    if (status !== "pending") return;
    await saveAccount(row, { ...account, [field]: "sending" }, actor, lease);
    let result: SlackAccountState;
    try {
      await endpoint(row.endpointId, actor);
      await lease.assertOwned();
      if (!await options.canWelcome(row.endpointId, account)) throw forbidden("Slack account access changed");
      const sent = await api("chat.postMessage", { channel: account.dmChannelId ?? account.externalUserId,
        text: kind === "verification" ? "Your Slack connection is working! Now ask me a question about your Paperclip instance."
          : `Hi, I’m ${current.agentName}. Your Slack account is connected to Paperclip.`,
        unfurl_links: "false", unfurl_media: "false" }, await options.runtimeBotToken(row.endpointId));
      if (typeof sent.channel !== "string" || !/^D[A-Z0-9]+$/.test(sent.channel)) throw new Error("Incomplete message response");
      result = { ...account, [field]: "sent", dmChannelId: sent.channel };
    } catch (error) {
      result = { ...account, [field]: error instanceof Error && "status" in error ? "failed" : "uncertain" };
    }
    await saveAccount(row, result, actor, lease);
    try { await audit(row, actor, `${kind}_${result[field] === "sent" ? "sent" : "failed"}`); }
    catch { logger.warn({ endpointId: row.endpointId, appId: row.appId }, "Slack setup message activity could not be recorded"); }
  }
  async function welcome(row: Registration, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    await sendSetupMessage(row, actor, lease, "welcome");
    await sendSetupMessage(row, actor, lease, "verification");
  }
  async function notifyVerified(endpointId: string) {
    return options.withLock(endpointId, async lease => {
      const row = await registration(endpointId);
      if (!row || row.status !== "configured") return;
      const [saved] = await db.select({ setup: chatEndpoints.setup, status: chatEndpoints.status }).from(chatEndpoints).where(eq(chatEndpoints.id, endpointId));
      const account = saved?.setup.slackAccount;
      if (!account || !["verifying", "active"].includes(saved.status)) return;
      await sendSetupMessage(row, { userId: account.paperclipUserId, sessionId: null, bypassPermissionCheck: false }, lease, "verification");
    });
  }
  async function processPendingVerificationMessages(limit = 25) {
    const pending = await db.select({ endpointId: chatEndpoints.id }).from(chatEndpoints)
      .innerJoin(chatSlackRegistrations, and(eq(chatSlackRegistrations.endpointId, chatEndpoints.id), eq(chatSlackRegistrations.companyId, chatEndpoints.companyId)))
      .where(and(eq(chatSlackRegistrations.status, "configured"), inArray(chatEndpoints.status, ["verifying", "active"]),
        sql`${chatEndpoints.setup}->'slackAccount'->>'verificationStatus' in ('pending', 'sending')`)).limit(limit);
    for (const row of pending) {
      try { await notifyVerified(row.endpointId); }
      catch { logger.warn({ endpointId: row.endpointId }, "Slack verification message could not be processed"); }
    }
  }
  async function resumeLocked(endpointId: string, actor: SlackSetupActor, lease: CredentialMutationLeaseGuard) {
    const current = await endpoint(endpointId, actor);
    const row = await registration(endpointId);
    if (!row || row.status === "removed") throw conflict("Slack registration is unavailable");
    if (row.status === "configured") { await cleanupStaged(endpointId, lease); await welcome(row, actor, lease); return; }
    if (row.status !== "credentials_saved") throw conflict("Install this Slack app before connecting it");
    try {
      assertOrigins(row, current.endpoint.publicId);
      const botToken = await readSecret(row, "botToken");
      const auth = await api("auth.test", {}, botToken);
      if (auth.team_id !== row.workspaceId || auth.user_id !== row.botUserId) throw providerFailure("slack_install_identity_mismatch");
      await options.configure(endpointId, { botToken, signingSecret: row.secretIds.signingSecret
        ? await readSecret(row, "signingSecret") : await options.runtimeSigningSecret(endpointId) }, actor, {
          assertOwned: async database => {
            await lease.assertOwned(database);
            await endpoint(endpointId, actor);
            assertOrigins(row, current.endpoint.publicId);
          },
        });
      await linkAccount(row, actor, lease);
    } catch (error) {
      const code = object(object(error).details).code;
      const safeCode = code === "slack_install_account_missing" ? code : code === "chat_identity_link_conflict" || code === "chat_identity_already_linked" ? "slack_install_account_conflict" : code === "slack_install_identity_mismatch" || code === "chat_bot_identity_changed"
        ? "slack_install_identity_mismatch" : code === "chat_provider_permissions_missing" ? "slack_install_scopes_missing"
        : code === "chat_bot_identity_in_use" ? "slack_bot_already_connected" : "slack_configuration_incomplete";
      await setFailure(row, "credentials_saved", safeCode, lease);
      await audit(row, actor, "configuration_failed", safeCode);
      return;
    }
    await lease.assertOwned();
    await db.update(chatSlackRegistrations).set({ status: "configured", errorCode: null, updatedAt: new Date() }).where(eq(chatSlackRegistrations.endpointId, endpointId));
    // Runtime now owns a separate vaulted copy. Keep the registration IDs until
    // deletion succeeds so cleanup itself is retryable.
    await cleanupStaged(endpointId, lease);
    try { await audit(row, actor, "installation_completed"); }
    catch { logger.warn({ endpointId, appId: row.appId }, "Slack installation activity could not be recorded"); }
    await welcome(row, actor, lease);
  }
  async function cleanupStaged(endpointId: string, lease: CredentialMutationLeaseGuard) {
    const row = await registration(endpointId);
    if (!row || row.status !== "configured") return;
    const ids = { ...row.secretIds };
    for (const key of ["botToken", "signingSecret"]) {
      if (ids[key]) { await lease.assertOwned(); await vault.remove(ids[key]); delete ids[key]; }
    }
    await lease.assertOwned();
    await db.update(chatSlackRegistrations).set({ secretIds: ids }).where(eq(chatSlackRegistrations.endpointId, endpointId));
  }
  async function complete(state: string, code: string | null, error: string | null, actor: SlackSetupActor) {
    const before = await pending(state, actor);
    return options.withLock(before.row.endpointId, async lease => {
      const { row, attempt, current } = await pending(state, actor);
      const [claimed] = await db.delete(toolOauthStates).where(and(eq(toolOauthStates.state, state), gt(toolOauthStates.expiresAt, new Date()))).returning();
      if (!claimed) throw conflict("This Slack authorization was already used");
      if (error) {
        const failureCode = error === "access_denied" ? "slack_install_declined" : "slack_install_failed";
        await setFailure(row, row.status, failureCode, lease);
        await audit(row, actor, "installation_failed", failureCode);
        return row.endpointId;
      }
      try {
        if (!code || code.length > 4096) throw providerFailure("slack_install_failed");
        const result = await api("oauth.v2.access", { code, client_id: row.clientId!, client_secret: await readSecret(row, "clientSecret"), redirect_uri: row.callbackUri });
        const teamId = object(result.team).id;
        const installerId = object(result.authed_user).id;
        if (result.app_id !== row.appId || result.token_type !== "bot" || typeof result.access_token !== "string" || !result.access_token.startsWith("xoxb-")
          || typeof teamId !== "string" || !/^T[A-Z0-9]+$/.test(teamId) || typeof result.bot_user_id !== "string" || !/^[UW][A-Z0-9]+$/.test(result.bot_user_id)
          || row.workspaceId && row.workspaceId !== teamId || row.botUserId && row.botUserId !== result.bot_user_id)
          throw providerFailure("slack_install_identity_mismatch");
        const granted = new Set(String(result.scope ?? "").split(","));
        if ((attempt.requestedScopes ?? []).some(scope => !granted.has(scope))) throw providerFailure("slack_install_scopes_missing");
        if (current.endpoint.providerAccountId && current.endpoint.providerAccountId !== teamId
          || current.endpoint.botExternalId && current.endpoint.botExternalId !== result.bot_user_id)
          throw providerFailure("slack_install_identity_mismatch");
        if (typeof installerId !== "string" || !/^[UW][A-Z0-9]+$/.test(installerId) || installerId === result.bot_user_id) throw providerFailure("slack_install_account_missing");
        await endpoint(row.endpointId, actor);
        // Reauthorization reuses the runtime signing secret after staging was cleaned.
        await saveSecrets(row, { botToken: result.access_token }, actor, lease,
          { status: "credentials_saved", workspaceId: teamId, botUserId: result.bot_user_id, errorCode: null },
          { externalUserId: installerId, paperclipUserId: actor.userId, status: "pending", welcomeStatus: "pending" });
      } catch (failure) {
        const code = object(object(failure).details).code;
        const safeCode = typeof code === "string" && code.startsWith("slack_install_") ? code : "slack_install_failed";
        await setFailure(row, row.status, safeCode, lease);
        await audit(row, actor, "installation_failed", safeCode);
        return row.endpointId;
      }
      await resumeLocked(row.endpointId, actor, lease);
      return row.endpointId;
    });
  }
  const cleanup = (endpointId: string, lease: CredentialMutationLeaseGuard) => removeSlackRegistration(db, endpointId, lease);
  async function returnPath(endpointId: string) {
    const [row] = await db.select({ prefix: companies.issuePrefix }).from(chatEndpoints)
      .innerJoin(companies, eq(companies.id, chatEndpoints.companyId)).where(eq(chatEndpoints.id, endpointId));
    if (!row) throw notFound("Slack connection not found");
    return `/${encodeURIComponent(row.prefix)}/apps/chat/connect?provider=slack&resume=${encodeURIComponent(endpointId)}`;
  }
  return { create, install, pending, expiredReturn, complete, cleanup, returnPath, registration, notifyVerified, processPendingVerificationMessages,
    close: async () => { await avatarPool?.close(); },
    resume: (endpointId: string, actor: SlackSetupActor) => options.withLock(endpointId, lease => resumeLocked(endpointId, actor, lease)) };
}
