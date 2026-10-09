import { isProvisionedSlackSetup } from "@paperclipai/shared";
import { createSlackManagerGrants } from "./manager-grants.js";
import { createManagedSlackSetup } from "./managed.js";
import { randomBytes } from "node:crypto";
import { and, eq, gt, like } from "drizzle-orm";
import { chatEndpoints, chatSlackRegistrations, companies, toolOauthStates, type Db } from "@paperclipai/db";
import { badRequest, conflict, forbidden, notFound } from "../../../../errors.js";
import { removeSlackRegistration } from "../../../chat-slack-registration-cleanup.js";
import type { CredentialMutationLeaseGuard } from "../../../chat-credential-mutation-lease.js";
import { object, providerFailure, createSlackRegistrationStore, type SlackSetupOptions, type SlackSetupActor } from "./registration.js";
import { createCustomerOwnedSetup } from "./customer-owned.js";
import { createSlackCompletion } from "./completion.js";
const prefix = "slack-install.";
export function slackChatRegistrationService(db: Db, options: SlackSetupOptions) {
  const store = createSlackRegistrationStore(db, options);
  const { endpoint, registration, assertOrigins, callbackUri, audit, api, readSecret, setFailure, saveSecrets } = store;
  const provisioner = createCustomerOwnedSetup(store);
  const { create } = provisioner;
  const completion = createSlackCompletion(store);
  const { resumeLocked, notifyVerified, processPendingVerificationMessages } = completion;
  const managerGrants = createSlackManagerGrants(store);
  const managed = createManagedSlackSetup(store, managerGrants, provisioner, completion, install);
  async function install(endpointId: string, actor: SlackSetupActor) {
    return options.withLock(endpointId, async lease => {
      const current = await endpoint(endpointId, actor);
      const row = await registration(endpointId);
      if (!row?.appId || !row.clientId || row.status === "removed") throw conflict("Create this Slack app before installing it");
      if (row.errorCode === "slack_manifest_update_pending") throw conflict("Finish configuring the saved Slack app before installing it");
      if (!isProvisionedSlackSetup(current.endpoint.setup.slackSetupMethod) || current.endpoint.status === "paused") throw conflict("Resume this connection before installing it");
      if (row.managerGrantId) await managerGrants.token(row.managerGrantId, row.companyId, actor);
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
        await tx.update(chatSlackRegistrations).set({ errorCode: row.managerGrantId ? row.errorCode : null, updatedAt: new Date() }).where(eq(chatSlackRegistrations.endpointId, endpointId));
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
        || !isProvisionedSlackSetup(latest.endpoint.setup.slackSetupMethod) || row.appId !== binding.appId || row.callbackUri !== binding.callbackUri) return null;
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
    if (!row || row.status === "removed" || !isProvisionedSlackSetup(current.endpoint.setup.slackSetupMethod)
      || current.endpoint.status === "paused"
      || current.endpoint.status === "revoked" && binding.endpointStatus !== "revoked"
      || binding.runtimeGeneration !== (object(current.endpoint.setup).runtimeGeneration ?? 0)
      || row.requestId !== binding.requestId || row.appId !== binding.appId || row.callbackUri !== binding.callbackUri
      || row.callbackUri !== callbackUri() || attempt.companyId !== row.companyId || attempt.connectionId !== current.connection.id)
      throw conflict("Slack setup changed. Resume the saved connection and install again.");
    if (row.managerGrantId) await managerGrants.token(row.managerGrantId, row.companyId, actor);
    assertOrigins(row, current.endpoint.publicId);
    return { attempt, current, row };
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
        if (row.managerGrantId) {
          const grant = await managerGrants.get(row.managerGrantId, row.companyId, actor);
          if (grant.status !== "active" || installerId !== grant.slackUserId || teamId !== grant.workspaceId) throw providerFailure("slack_install_identity_mismatch");
        }
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
  return { create, managerGrants, managed, install, pending, expiredReturn, complete, cleanup, returnPath, registration, notifyVerified, processPendingVerificationMessages,
    close: store.close,
    resume: (endpointId: string, actor: SlackSetupActor) => options.withLock(endpointId, async lease => {
      const row = await registration(endpointId);
      if (row?.managerGrantId) await managerGrants.token(row.managerGrantId, row.companyId, actor);
      return resumeLocked(endpointId, actor, lease);
    }) };
}
