import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, like, sql } from "drizzle-orm";
import { chatEndpoints, chatSlackManagerGrants, chatSlackRegistrations, companySecrets, toolOauthStates } from "@paperclipai/db";
import { SLACK_MANAGER_SCOPES, type SlackSetupOptions as SetupChoices } from "@paperclipai/shared";
import { conflict, forbidden } from "../../../../errors.js";
import { getCloudRuntimeIdentity } from "../../../cloud-runtime-identity.js";
import { createPaperclipCloudConnector, paperclipCloudConnectorConfigFromEnv, type PaperclipCloudConnector, type SealedConnectorCredentials } from "../../../paperclip-cloud-connector.js";
import { instanceSettingsService } from "../../../instance-settings.js";
import { accessService } from "../../../access.js";
import { secretService } from "../../../secrets.js";
import { writeConnectionCredential } from "../../../connection-credentials.js";
import { logActivity } from "../../../activity-log.js";
import { object, providerFailure, type SlackRegistrationStore, type SlackSetupActor } from "./registration.js";

export const SLACK_MANAGER_STATE_PREFIX = "slack-manager.";
export function createSlackManagerGrants(store: SlackRegistrationStore) {
  const { db, options, endpoint, origin, api } = store;
  type Database = Parameters<typeof secretService>[0];
  function broker(): PaperclipCloudConnector | null {
    if (options.managed) return options.managed.enabled ? options.managed.broker : null;
    // Open-source instances never contact a hosted service to discover this path.
    if (!getCloudRuntimeIdentity() || process.env.PAPERCLIP_SLACK_MANAGED_SETUP_ENABLED !== "true") return null;
    const config = paperclipCloudConnectorConfigFromEnv();
    return config ? createPaperclipCloudConnector({ config }) : null;
  }
  async function access(companyId: string, actor: SlackSetupActor, database: Database = db) {
    if (!(await instanceSettingsService(database as typeof db).getExperimental()).enableChatConnectors) throw forbidden("Chat connectors are disabled");
    if (!actor.bypassPermissionCheck && !await accessService(database as typeof db).hasPermission(companyId, "user", actor.userId, "tools:manage_connections")) throw forbidden("Missing permission: tools:manage_connections");
  }
  async function available() {
    const client = broker();
    if (!client || !(await instanceSettingsService(db).getExperimental()).enableChatConnectors) return false;
    try { origin(options.publicOrigin()); origin(options.webhookOrigin()); return Boolean(await client.getSlackManagerAppId()); }
    catch { return false; }
  }
  async function requiredBroker() {
    if (!await available()) throw providerFailure("slack_managed_unavailable");
    return broker()!;
  }
  async function choices(companyId: string, actor: SlackSetupActor): Promise<SetupChoices> {
    await access(companyId, actor);
    const managedAvailable = await available();
    const managerAppId = managedAvailable ? await broker()!.getSlackManagerAppId() : null;
    const grants = managedAvailable && managerAppId ? await db.select().from(chatSlackManagerGrants).where(and(eq(chatSlackManagerGrants.companyId, companyId), eq(chatSlackManagerGrants.userId, actor.userId), eq(chatSlackManagerGrants.status, "active"), eq(chatSlackManagerGrants.managerAppId, managerAppId))) : [];
    return { managedAvailable, defaultMethod: managedAvailable ? "managed" : "automatic", workspaces: grants.map(g => ({ grantId: g.id, workspaceId: g.workspaceId, workspaceName: g.workspaceName, userId: g.slackUserId })) };
  }
  const callbackUri = () => `${origin(options.publicOrigin())}/api/chat-slack/managed/oauth/callback`;
  async function authorize(endpointId: string, actor: SlackSetupActor) {
    const client = await requiredBroker();
    return options.withLock(endpointId, async lease => {
      const current = await endpoint(endpointId, actor);
      if (current.endpoint.setup.slackSetupMethod !== "managed") throw conflict("Resume the selected Slack setup method");
      const row = await store.registration(endpointId);
      const revisions = await db.select({ id: chatSlackManagerGrants.id, revision: chatSlackManagerGrants.revision }).from(chatSlackManagerGrants)
        .where(and(eq(chatSlackManagerGrants.companyId, current.endpoint.companyId), eq(chatSlackManagerGrants.userId, actor.userId)));
      const state = `${SLACK_MANAGER_STATE_PREFIX}${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(Date.now() + 10 * 60_000);
      await lease.assertOwned();
      await db.insert(toolOauthStates).values({ state, companyId: current.endpoint.companyId, connectionId: current.connection.id,
        codeVerifier: JSON.stringify({ endpointId, revisions, requestId: row?.requestId ?? null, callbackUri: callbackUri(), webhookOrigin: origin(options.webhookOrigin()), runtimeGeneration: object(current.endpoint.setup).runtimeGeneration ?? 0 }),
        createdByActorType: "user", createdByActorId: actor.userId, createdBySessionId: actor.sessionId, requestedScopes: [...SLACK_MANAGER_SCOPES], expiresAt });
      try { return await client.startAuthorization({ profile: "slack.manager", subject: actor.userId, companyId: current.endpoint.companyId, returnUri: callbackUri(), returnState: state }); }
      catch { await db.delete(toolOauthStates).where(eq(toolOauthStates.state, state)); throw providerFailure("slack_manager_reauthorize"); }
    });
  }
  async function pending(state: string, actor: SlackSetupActor, allowExpired = false) {
    if (!/^slack-manager\.[A-Za-z0-9_-]{43}$/.test(state)) throw forbidden("Invalid Slack authorization state");
    const [attempt] = await db.select().from(toolOauthStates).where(and(eq(toolOauthStates.state, state), ...(allowExpired ? [] : [gt(toolOauthStates.expiresAt, new Date())])));
    if (!attempt || attempt.createdByActorId !== actor.userId || attempt.createdBySessionId !== actor.sessionId) throw forbidden("Slack authorization expired or belongs to another session");
    const binding = object(JSON.parse(attempt.codeVerifier));
    const current = await endpoint(String(binding.endpointId), actor);
    const row = await store.registration(current.endpoint.id);
    if (current.endpoint.setup.slackSetupMethod !== "managed" || current.connection.id !== attempt.connectionId || current.endpoint.companyId !== attempt.companyId
      || ["paused", "revoked"].includes(current.endpoint.status) || row?.status === "removed"
      || (row?.requestId ?? null) !== binding.requestId || binding.callbackUri !== callbackUri() || binding.webhookOrigin !== origin(options.webhookOrigin())
      || binding.runtimeGeneration !== (object(current.endpoint.setup).runtimeGeneration ?? 0)) throw conflict("Slack setup changed. Resume authorization.");
    return { attempt, current, row, binding };
  }
  async function expiredReturn(state: string, actor: SlackSetupActor) {
    const { current, attempt } = await pending(state, actor, true);
    if (attempt.expiresAt.getTime() > Date.now()) return null;
    return options.withLock(current.endpoint.id, async lease => {
      const latest = await pending(state, actor, true);
      await lease.assertOwned();
      await db.delete(toolOauthStates).where(eq(toolOauthStates.state, state));
      await db.update(chatEndpoints).set({ setup: { ...latest.current.endpoint.setup, slackManagerError: "slack_install_expired" } }).where(eq(chatEndpoints.id, current.endpoint.id));
      return current.endpoint.id;
    });
  }
  async function complete(state: string, claimId: string | null, error: string | null, actor: SlackSetupActor) {
    const client = await requiredBroker();
    const before = await pending(state, actor);
    return options.withLock(before.current.endpoint.id, async lease => {
      const { current, row, binding } = await pending(state, actor);
      await lease.assertOwned();
      const [claimed] = await db.delete(toolOauthStates).where(and(eq(toolOauthStates.state, state), gt(toolOauthStates.expiresAt, new Date()))).returning();
      if (!claimed) throw conflict("Slack authorization was already used");
      async function outcome(code: string | null) {
        await lease.assertOwned();
        const latest = await endpoint(current.endpoint.id, actor);
        await db.update(chatEndpoints).set({ setup: { ...latest.endpoint.setup, slackManagerError: code ?? undefined } }).where(eq(chatEndpoints.id, current.endpoint.id));
        if (code) await logActivity(db, { companyId: current.endpoint.companyId, actorType: "user", actorId: actor.userId, action: "chat_slack.manager_authorization_failed", entityType: "chat_endpoint", entityId: current.endpoint.id, details: { code } });
        return current.endpoint.id;
      }
      if (error || !claimId || claimId.length > 4096) return outcome(error === "access_denied" ? "slack_install_declined" : "slack_manager_reauthorize");
      try {
      let grant: SealedConnectorCredentials;
      try { grant = await client.claim({ profile: "slack.manager", subject: actor.userId, companyId: current.endpoint.companyId, claimId, redemptionId: randomUUID() }); }
      catch { throw providerFailure("slack_manager_reauthorize"); }
      const identity = grant.slackManager;
      if (!identity || identity.appId !== await client.getSlackManagerAppId() || !/^A[A-Z0-9]+$/.test(identity.appId) || !/^T[A-Z0-9]+$/.test(identity.workspaceId) || !/^[UW][A-Z0-9]+$/.test(identity.userId) || typeof identity.workspaceName !== "string" || !identity.workspaceName || identity.workspaceName.length > 255) throw providerFailure("slack_manager_reauthorize");
      if (row?.managerGrantId) {
        const existing = await get(row.managerGrantId, current.endpoint.companyId, actor);
        if (existing.managerAppId !== identity.appId || existing.workspaceId !== identity.workspaceId || existing.slackUserId !== identity.userId) throw providerFailure("slack_install_identity_mismatch");
      }
      await endpoint(current.endpoint.id, actor);
      await access(current.endpoint.companyId, actor);
      await db.transaction(async tx => {
        await lease.assertOwned(tx);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager:${current.endpoint.companyId}:${actor.userId}:${identity.appId}:${identity.workspaceId}`}, 0))`);
        const [existing] = await tx.select().from(chatSlackManagerGrants).where(and(eq(chatSlackManagerGrants.companyId, current.endpoint.companyId), eq(chatSlackManagerGrants.userId, actor.userId), eq(chatSlackManagerGrants.managerAppId, identity.appId), eq(chatSlackManagerGrants.workspaceId, identity.workspaceId)));
        if (existing) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${existing.id}`}, 0))`);
          const [latest] = await tx.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, existing.id));
          const revision = Array.isArray(binding.revisions) ? binding.revisions.map(object).find(value => value.id === existing.id)?.revision : undefined;
          if (!latest || latest.revision !== revision) throw conflict("Workspace authorization changed. Start again.");
        }
        const [saved] = await tx.insert(chatSlackManagerGrants).values({ companyId: current.endpoint.companyId, userId: actor.userId, slackUserId: identity.userId, workspaceId: identity.workspaceId, workspaceName: identity.workspaceName, managerAppId: identity.appId })
          .onConflictDoUpdate({ target: [chatSlackManagerGrants.companyId, chatSlackManagerGrants.userId, chatSlackManagerGrants.managerAppId, chatSlackManagerGrants.workspaceId], set: { updatedAt: new Date() } }).returning();
        // A reauthorization must never change which Slack person this grant represents.
        if (saved.slackUserId !== identity.userId) throw conflict("Reconnect using the original Slack account");
        await access(current.endpoint.companyId, actor, tx);
        await save(tx, saved, grant, actor);
        if (row?.managerGrantId === saved.id) {
          await tx.update(chatSlackRegistrations).set({ errorCode: null, updatedAt: new Date() })
            .where(and(eq(chatSlackRegistrations.endpointId, current.endpoint.id), eq(chatSlackRegistrations.managerGrantId, saved.id), eq(chatSlackRegistrations.errorCode, "slack_manager_reauthorize")));
        }
      });
      await logActivity(db, { companyId: current.endpoint.companyId, actorType: "user", actorId: actor.userId, action: "chat_slack.manager_authorized", entityType: "chat_endpoint", entityId: current.endpoint.id, details: { workspaceId: identity.workspaceId, managerAppId: identity.appId } });
      return outcome(null);
      } catch { return outcome("slack_manager_reauthorize"); }
    });
  }
  type Grant = typeof chatSlackManagerGrants.$inferSelect;
  async function get(id: string, companyId: string, actor: SlackSetupActor) {
    await access(companyId, actor);
    return readGrant(db, id, companyId, actor);
  }
  async function readGrant(database: Database, id: string, companyId: string, actor: SlackSetupActor) {
    await access(companyId, actor, database);
    const [grant] = await database.select().from(chatSlackManagerGrants).where(and(eq(chatSlackManagerGrants.id, id), eq(chatSlackManagerGrants.companyId, companyId), eq(chatSlackManagerGrants.userId, actor.userId)));
    if (!grant) throw forbidden("This Slack workspace authorization belongs to another account");
    return grant;
  }
  async function save(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], row: Grant, credentials: SealedConnectorCredentials, actor: SlackSetupActor) {
    if (credentials.tokenType !== "user" || !credentials.accessToken || !credentials.refreshToken || !credentials.accessTokenExpiresAt || !Number.isFinite(Date.parse(credentials.accessTokenExpiresAt)) || Date.parse(credentials.accessTokenExpiresAt) <= Date.now() || credentials.provider !== "slack" || credentials.profile !== "slack.manager" || credentials.subject !== row.userId || credentials.companyId !== row.companyId || SLACK_MANAGER_SCOPES.some(scope => !credentials.scopes.includes(scope))) throw providerFailure("slack_manager_reauthorize");
    const write = (key: string, value: string, secretId: string | null) => writeConnectionCredential(tx, { companyId: row.companyId, ownerUserId: row.userId, actor: { userId: actor.userId }, connectionName: "Slack workspace management", configPath: `slack_manager.${key}`, definitionKey: `slack_manager.${row.id}.${key}`, label: key, value, ...(secretId ? { existingRef: { secretId, configPath: `slack_manager.${key}` } } : {}) });
    const accessToken = await write("access_token", credentials.accessToken, row.accessSecretId);
    const refreshToken = credentials.refreshToken ? await write("refresh_token", credentials.refreshToken, row.refreshSecretId) : null;
    await tx.update(chatSlackManagerGrants).set({ accessSecretId: accessToken.secret.id, refreshSecretId: refreshToken?.secret.id ?? row.refreshSecretId, expiresAt: credentials.accessTokenExpiresAt ? new Date(credentials.accessTokenExpiresAt) : null, status: "active", revision: row.revision + 1, updatedAt: new Date() }).where(eq(chatSlackManagerGrants.id, row.id));
  }
  async function secret(row: Grant, id: string | null, database: Database = db) {
    if (!id) throw providerFailure("slack_manager_reauthorize");
    const [ref] = await database.select().from(companySecrets).where(and(eq(companySecrets.id, id), eq(companySecrets.companyId, row.companyId), eq(companySecrets.scope, "user"), eq(companySecrets.ownerUserId, row.userId)));
    if (!ref?.userSecretDefinitionId) throw providerFailure("slack_manager_reauthorize");
    // Owner-scoped system consumer; the durable grant is its authority, not a tool binding.
    const value = await secretService(database).resolveUserSecretValue(row.companyId, { definitionId: ref.userSecretDefinitionId, responsibleUserId: row.userId }, { consumerType: "system", consumerId: `slack-manager:${row.id}`, actorType: "user", actorId: row.userId, responsibleUserId: row.userId });
    if (!value) throw providerFailure("slack_manager_reauthorize");
    return value.value;
  }
  const tokenRequests = new Map<string, Promise<{ grant: Grant; token: string }>>();
  async function token(id: string, companyId: string, actor: SlackSetupActor) {
    await access(companyId, actor);
    const client = await requiredBroker();
    const managerAppId = await client.getSlackManagerAppId();
    const key = `${companyId}:${actor.userId}:${id}`;
    const running = tokenRequests.get(key);
    if (running) return running;
    const operation = (async () => {
      // Commit the single-use refresh claim before dispatch, without holding a
      // pool connection while another query or the broker needs it.
      const prepared = await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${id}`}, 0))`);
        const grant = await readGrant(tx, id, companyId, actor);
        if (grant.managerAppId !== managerAppId || grant.status !== "active") throw providerFailure("slack_manager_reauthorize");
        if (!grant.expiresAt || grant.expiresAt.getTime() > Date.now() + 60_000) return { grant, token: await secret(grant, grant.accessSecretId, tx) };
        const refreshToken = await secret(grant, grant.refreshSecretId, tx);
        const [claimed] = await tx.update(chatSlackManagerGrants).set({ status: "reauthorize", revision: grant.revision + 1, updatedAt: new Date() }).where(eq(chatSlackManagerGrants.id, id)).returning();
        return { grant: claimed!, refreshToken };
      });
      if ("token" in prepared) return { grant: prepared.grant, token: prepared.token! };
      try {
        const refreshed = await client.refresh({ profile: "slack.manager", subject: actor.userId, companyId, refreshToken: prepared.refreshToken });
        await access(companyId, actor);
        return await db.transaction(async tx => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${id}`}, 0))`);
          const current = await readGrant(tx, id, companyId, actor);
          if (current.status !== "reauthorize" || current.revision !== prepared.grant.revision) throw providerFailure("slack_manager_reauthorize");
          await save(tx, current, refreshed, actor);
          return { grant: await readGrant(tx, id, companyId, actor), token: refreshed.accessToken };
        });
      } catch { throw providerFailure("slack_manager_reauthorize"); }
    })();
    tokenRequests.set(key, operation);
    try { return await operation; } finally { if (tokenRequests.get(key) === operation) tokenRequests.delete(key); }
  }
  async function revoke(id: string, companyId: string, actor: SlackSetupActor) {
    await access(companyId, actor);
    let providerRevoked = true;
    const grant = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${id}`}, 0))`);
      const current = await readGrant(tx, id, companyId, actor);
      await tx.update(chatSlackManagerGrants).set({ status: "revoked", revision: current.revision + 1, updatedAt: new Date() }).where(eq(chatSlackManagerGrants.id, id));
      await tx.delete(toolOauthStates).where(and(eq(toolOauthStates.companyId, companyId), eq(toolOauthStates.createdByActorId, actor.userId), like(toolOauthStates.state, `${SLACK_MANAGER_STATE_PREFIX}%`)));
      const client = broker();
      for (const secretId of [current.accessSecretId, current.refreshSecretId]) if (secretId) {
        try {
          if (!client) throw providerFailure("slack_managed_unavailable");
          await client.revoke({ subject: actor.userId, companyId, profile: "slack.manager", token: await secret(current, secretId, tx) });
        } catch { providerRevoked = false; }
        await secretService(tx).remove(secretId);
      }
      await tx.update(chatSlackManagerGrants).set({ accessSecretId: null, refreshSecretId: null }).where(eq(chatSlackManagerGrants.id, id));
      return current;
    });
    await logActivity(db, { companyId, actorType: "user", actorId: actor.userId, action: "chat_slack.manager_revoked", entityType: "slack_manager_grant", entityId: id, details: { workspaceId: grant.workspaceId, providerRevoked } });
  }
  async function request(id: string, companyId: string, actor: SlackSetupActor, method: string, fields: Record<string, string> | FormData) {
    const authorized = await token(id, companyId, actor);
    const { grant } = authorized;
    // Slack shares a method budget across manager tokens in the same workspace.
    // Persist Retry-After across grants and process restarts; never retry a dispatch.
    const result = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-api:${companyId}:${grant.managerAppId}:${grant.workspaceId}:${method}`}, 0))`);
      // Serialize provider dispatch against refresh/revocation for this personal grant.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`slack-manager-refresh:${id}`}, 0))`);
      const peers = await tx.select().from(chatSlackManagerGrants).where(and(eq(chatSlackManagerGrants.companyId, companyId), eq(chatSlackManagerGrants.managerAppId, grant.managerAppId), eq(chatSlackManagerGrants.workspaceId, grant.workspaceId))).orderBy(chatSlackManagerGrants.id);
      if (peers.some(peer => Date.parse(peer.rateLimits[method] ?? "") > Date.now())) return { error: providerFailure("slack_setup_rate_limited") };
      const current = await readGrant(tx, id, companyId, actor);
      if (current.status !== "active") return { error: providerFailure("slack_manager_reauthorize") };
      try { return { value: await api(method, fields, await secret(current, current.accessSecretId, tx)) }; }
      catch (error) {
        const details = object(object(error).details);
        if (details.code === "slack_setup_rate_limited") {
          const until = new Date(Date.now() + Math.min(Number(details.retryAfterSeconds) || 60, 86_400) * 1000).toISOString();
          for (const peer of peers) await tx.update(chatSlackManagerGrants).set({ rateLimits: sql`${chatSlackManagerGrants.rateLimits} || ${JSON.stringify({ [method]: until })}::jsonb` }).where(eq(chatSlackManagerGrants.id, peer.id));
        }
        if (details.code === "slack_configuration_token_invalid") {
          await tx.update(chatSlackManagerGrants).set({ status: "reauthorize", revision: current.revision + 1, updatedAt: new Date() }).where(eq(chatSlackManagerGrants.id, id));
          return { error: providerFailure("slack_manager_reauthorize") };
        }
        return { error };
      }
    });
    if ("error" in result) throw result.error;
    return result.value!;
  }
  return { choices, available, authorize, pending, expiredReturn, complete, get, token, revoke, request };
}
