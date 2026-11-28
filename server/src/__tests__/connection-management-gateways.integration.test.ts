import { createToolGatewayService } from "../services/tool-gateway.js";
import { commitToolActionReview } from "../services/tool-action-review.js";
import { googleWorkspaceSelectedScopes, defaultGitHubReviewPolicy, SLACK_CHAT_BOT_SCOPES, SLACK_BOT_TOOL_SCOPES } from "@paperclipai/shared";
import { createHash, randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { createServer } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createDb, authUsers, activityLog, agentApiKeys, companies, companySecrets, companySecretVersions, chatConversations, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, toolPolicies, toolRateLimitCounters, connectionGrants, connectionGrantMembers, connectionGrantDelegations, toolAccessAuditEvents, toolOauthStates, issueThreadInteractions, connectionIntentDeliveries, agents, companyMemberships, heartbeatRuns, issues, principalPermissionGrants, projects, toolApplications, toolConnections, toolConnectionInstalls, aiConnectionPools, toolMcpGateways, toolMcpGatewayTokens, toolActionRequests, toolCatalogEntries, toolInvocations, toolCallEvents, toolProfileEntries, toolProfiles, toolProfileBindings, plugins, adapterAuthSessions, environments, routines, chatGitHubReviews } from "@paperclipai/db";
import { findSatisfiedToolConnection, satisfiedConnectionIntentService } from "../services/satisfied-connection-intents.js";
import { connectionManagementService, continuingConnectionManagement } from "../services/connection-management.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { redactRunnerApiPayloads } from "../services/native-runtime/runner-api-log-redaction.js";
import * as remoteEndpointGuard from "../services/remote-http-endpoint-guard.js";
import * as remoteHttpFetch from "../services/remote-http-fetch.js";
import * as runIdentity from "../services/run-identity.js";
import * as connectionManagementModule from "../services/connection-management.js";
import * as localBrowserLogin from "../services/local-ai-browser-login.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { agentService } from "../services/agents.js";
import { accessService } from "../services/access.js";
import { secretService } from "../services/secrets.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import type { AuthorizationActor } from "../services/authorization.js";
import type { ConnectionManagementResource } from "../services/connection-management-policy.js";

vi.mock("../services/agent-lifecycle-driver.js", () => ({
  createLifecycleDriver: () => ({ requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" }),
}));

vi.mock("../services/chat-channels/github/webhook-recovery-work.js", async importOriginal => {
  const original = await importOriginal<typeof import("../services/chat-channels/github/webhook-recovery-work.js")>();
  return { ...original, registerGitHubWebhookRecoveryWork: (...args: Parameters<typeof original.registerGitHubWebhookRecoveryWork>) =>
    original.registerGitHubWebhookRecoveryWork(args[0], args[1], () => false) };
});

import { createConnectionManagementHarness, type ConnectionManagementLifecycle, type ConnectionManagementProviderHandler, type ConnectionManagementServer } from "./helpers/connection-management-harness.js";

// All requests traverse the assembled server and production bearer middleware.
// No req.actor injection or special permission grants establish access.
describe("connection management gateway tokens, AI accounts, and grant scopes", () => {
  let server!: ConnectionManagementServer;
  let lifecycle!: ConnectionManagementLifecycle;
  let provider: ConnectionManagementProviderHandler | null = null;
  const harness = createConnectionManagementHarness(() => provider);
  beforeAll(() => {
    server = harness.server;
    lifecycle = harness.lifecycle;
  });
  const fixture = () => harness.fixture();

  async function legacyAgentIssuedGatewayToken(f: Awaited<ReturnType<typeof fixture>>, gatewayId: string, name: string) {
    const id = randomUUID(), token = `pcgw_${id}.${randomBytes(32).toString("base64url")}`;
    const [row] = await server.db.insert(toolMcpGatewayTokens).values({ id, companyId: f.companyId, gatewayId, name, tokenHash: createHash("sha256").update(token).digest("hex"),
      tokenPrefix: `pcgw_${id.slice(0, 8)}`, subjectType: "gateway_client", clientLabel: "fixture", allowedActions: ["tools/list", "tools/call", "resources/list", "resources/read", "prompts/list", "prompts/get"],
      responsibleUserId: f.userId, createdByAgentId: f.agentId }).returning();
    return { status: 201, body: { ...row, token } };
  }

  it("lets agents create and revoke gateway client tokens without ever receiving a token value", async () => {
    const f = await fixture();
    const profile = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "gateway-profile", name: "Gateway profile", entries: [] });
    expect(profile, JSON.stringify(profile)).toMatchObject({ status: 201 });
    const gateway = await f.request("POST", `/companies/${f.companyId}/tools/gateways`, { name: "Delegated gateway", slug: "delegated", profileId: profile.body.id });
    expect(gateway, JSON.stringify(gateway)).toMatchObject({ status: 201 });
    const body = { companyId: f.companyId, name: "Fixture client", clientLabel: "fixture", expiresAt: new Date(Date.now() + 3600000).toISOString() };
    const call = (callId: string, operationId: string, pathParams: Record<string, string>, payload: unknown) =>
      f.authority.execute({ tool: "call_api", callId, arguments: { operationId, pathParams, body: payload } }) as Promise<{ status: number; data: Record<string, unknown> }>;
    const tokenValue = /pcgw_[0-9a-f-]{36}\.[A-Za-z0-9_-]+/;
    const [company] = await server.db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, f.companyId));
    const tokensPath = `/${company.issuePrefix}/apps/gateways/${gateway.body.id}/tokens`;
    expect(gateway.body).toMatchObject({ tokensPath, gatewayPath: `/${company.issuePrefix}/apps/gateways/${gateway.body.id}/overview` });

    const created = await call("gateway-client-create", "POST /api/tool-gateway/gateways/{gatewayId}/tokens", { gatewayId: gateway.body.id }, body);
    expect(created, JSON.stringify(created)).toMatchObject({ status: 201, data: { name: "Fixture client", pendingReveal: true, tokensPath,
      tokenPrefix: expect.stringMatching(/^pcgw_[0-9a-f]{8}$/), createdByAgentId: f.agentId, responsibleUserId: f.userId,
      requiredUserAction: { kind: "reveal_credential", userId: f.userId, setupPath: tokensPath, resource: { type: "gateway_token", id: created.data.id, companyId: f.companyId } } } });
    expect(created.data).not.toHaveProperty("token");
    expect(JSON.stringify(created)).not.toMatch(tokenValue);
    const [pending] = await server.db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, created.data.id as string));
    expect(pending).toMatchObject({ pendingReveal: true, createdByAgentId: f.agentId, responsibleUserId: f.userId, subjectType: "gateway_client", revokedAt: null });
    // Agents cannot reveal any value.
    const agentReveal = await call("gateway-client-reveal", "POST /api/tool-gateway/gateway-tokens/{tokenId}/reveal", { tokenId: created.data.id as string }, { companyId: f.companyId });
    expect(agentReveal, JSON.stringify(agentReveal)).toMatchObject({ status: 403, data: { reasonCode: "gateway_token_requires_person" } });
    expect(JSON.stringify(agentReveal)).not.toMatch(tokenValue);
    expect(await f.request("POST", `/tool-gateway/gateway-tokens/${created.data.id}/reveal`, { companyId: f.companyId })).toMatchObject({ status: 403 });

    // The responsible person reveals the value exactly once, and it works.
    const cookie = await server.humanSession(f.userId);
    const reveal = () => fetch(`${server.apiUrl}/api/tool-gateway/gateway-tokens/${created.data.id}/reveal`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify({ companyId: f.companyId }) });
    const revealed = await reveal();
    expect(revealed.status).toBe(200);
    const value = await revealed.json() as { token: string; pendingReveal: boolean; id: string };
    expect(value).toMatchObject({ id: created.data.id, pendingReveal: false, token: expect.stringMatching(new RegExp(`^pcgw_${created.data.id}\\.`)) });
    expect(await reveal()).toMatchObject({ status: 409 });
    expect(await server.db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "tool_gateway.token_revealed"))))
      .toEqual([expect.objectContaining({ actorType: "user", actorId: f.userId, entityId: gateway.body.id, details: { tokenId: created.data.id } })]);
    const use = () => f.request("POST", `/mcp/gateways/${gateway.body.gatewayPublicId}`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, value.token);
    expect(await use()).toMatchObject({ status: 200 });

    // Agents keep delegated revoke.
    const revoked = await call("gateway-client-revoke", "POST /api/tool-gateway/gateway-tokens/{tokenId}/revoke", { tokenId: created.data.id as string }, { companyId: f.companyId });
    expect(revoked, JSON.stringify(revoked)).toMatchObject({ status: 200, data: { id: created.data.id, revokedAt: expect.any(String) } });
    expect((await use()).status).toBeGreaterThanOrEqual(400);

    // A token revoked before reveal never gets a value.
    const unrevealed = await call("gateway-client-create-2", "POST /api/tool-gateway/gateways/{gatewayId}/tokens", { gatewayId: gateway.body.id }, { ...body, name: "Never revealed" });
    expect(unrevealed).toMatchObject({ status: 201 });
    expect(await call("gateway-client-revoke-2", "POST /api/tool-gateway/gateway-tokens/{tokenId}/revoke", { tokenId: unrevealed.data.id as string }, { companyId: f.companyId })).toMatchObject({ status: 200 });
    expect(await fetch(`${server.apiUrl}/api/tool-gateway/gateway-tokens/${unrevealed.data.id}/reveal`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify({ companyId: f.companyId }) }))
      .toMatchObject({ status: 409 });

    // A token that expired before reveal never gets a value.
    const expiring = await call("gateway-client-create-3", "POST /api/tool-gateway/gateways/{gatewayId}/tokens", { gatewayId: gateway.body.id }, { ...body, name: "Expired before reveal" });
    expect(expiring).toMatchObject({ status: 201 });
    await server.db.update(toolMcpGatewayTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(toolMcpGatewayTokens.id, expiring.data.id as string));
    const expiredReveal = await fetch(`${server.apiUrl}/api/tool-gateway/gateway-tokens/${expiring.data.id}/reveal`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify({ companyId: f.companyId }) });
    expect(expiredReveal.status).toBe(409);
    expect(await expiredReveal.json()).toMatchObject({ reasonCode: "gateway_token_expired" });
    const [stillPending] = await server.db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, expiring.data.id as string));
    expect(stillPending).toMatchObject({ pendingReveal: true });

    // Person callers keep receiving the value from create.
    const personal = await fetch(`${server.apiUrl}/api/tool-gateway/gateways/${gateway.body.id}/tokens`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(personal.status).toBe(201);
    expect(await personal.json()).toMatchObject({ token: expect.stringMatching(/^pcgw_/), createdByUserId: f.userId, createdByAgentId: null, pendingReveal: false });
  });

  it("reveals an agent-created gateway token value only to its responsible person", async () => {
    const f = await fixture();
    const profile = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "gateway-profile", name: "Gateway profile", entries: [] });
    const gateway = await f.request("POST", `/companies/${f.companyId}/tools/gateways`, { name: "Delegated gateway", slug: "delegated", profileId: profile.body.id });
    const created = await f.request("POST", `/tool-gateway/gateways/${gateway.body.id}/tokens`, { companyId: f.companyId, name: "Fixture client", clientLabel: "fixture" });
    expect(created, JSON.stringify(created)).toMatchObject({ status: 201, body: { pendingReveal: true } });
    const otherId = `other-admin-${randomUUID()}`;
    await server.db.insert(authUsers).values({ id: otherId, name: "Other admin", email: `${otherId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    const access = accessService(server.db);
    await access.ensureMembership(f.companyId, "user", otherId, "owner", "active");
    await access.ensureRoleDefaultGrants(f.companyId, otherId, "owner", otherId);
    const cookie = await server.humanSession(otherId);
    const reveal = await fetch(`${server.apiUrl}/api/tool-gateway/gateway-tokens/${created.body.id}/reveal`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify({ companyId: f.companyId }) });
    expect(reveal.status).toBe(403);
    expect(await reveal.json()).toMatchObject({ reasonCode: "gateway_token_reveal_requires_responsible_person" });
    const [still] = await server.db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, created.body.id));
    expect(still).toMatchObject({ pendingReveal: true });
  });

  it("keeps durable agent-issued gateway client tokens bound to the issuer and responsible user", async () => {
    const f = await fixture();
    const profile = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "gateway-profile", name: "Gateway profile", entries: [] });
    expect(profile, JSON.stringify(profile)).toMatchObject({ status: 201 });
    const gateway = await f.request("POST", `/companies/${f.companyId}/tools/gateways`, { name: "Delegated gateway", slug: "delegated", profileId: profile.body.id });
    expect(gateway, JSON.stringify(gateway)).toMatchObject({ status: 201 });
    const token = await legacyAgentIssuedGatewayToken(f, gateway.body.id, "Fixture client");
    const [saved] = await server.db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, token.body.id));
    expect(saved).toMatchObject({ createdByAgentId: f.agentId, responsibleUserId: f.userId, subjectType: "gateway_client" });
    const use = () => f.request("POST", `/mcp/gateways/${gateway.body.gatewayPublicId}`, { jsonrpc: "2.0", id: 1, method: "tools/list" }, token.body.token);
    expect(await use()).toMatchObject({ status: 200 });
    await server.db.update(principalPermissionGrants).set({ scope: { purpose: "tool" } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
    expect(await use()).toMatchObject({ status: 200 });
    await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    expect(await use()).toMatchObject({ status: 200 });
    await server.db.update(companyMemberships).set({ status: "suspended" }).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.userId)));
    expect((await use()).status).toBeGreaterThanOrEqual(400);
    await server.db.update(companyMemberships).set({ status: "active" }).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.userId)));
    expect(await use()).toMatchObject({ status: 200 });
    await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
    expect((await use()).status).toBeGreaterThanOrEqual(400);
    // Model the token FK's ON DELETE SET NULL state without deleting the
    // fixture's protected historical activity references to the agent.
    await server.db.update(toolMcpGatewayTokens).set({ createdByAgentId: null }).where(eq(toolMcpGatewayTokens.id, token.body.id));
    const [orphaned] = await server.db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, token.body.id));
    expect(orphaned).toMatchObject({ createdByAgentId: null, responsibleUserId: f.userId });
    expect((await use()).status).toBeGreaterThanOrEqual(400);
  });

  it("requires retained profile authority to clear gateway bindings and connection audiences", async () => {
    const f = await fixture();
    const profile = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "bound-profile", name: "Bound profile", entries: [] });
    expect(profile, JSON.stringify(profile)).toMatchObject({ status: 201 });
    const gateway = await f.request("POST", `/companies/${f.companyId}/tools/gateways`, { name: "Bound gateway", slug: "bound", profileId: profile.body.id, agentId: f.agentId });
    expect(gateway, JSON.stringify(gateway)).toMatchObject({ status: 201, body: { agentId: f.agentId } });
    await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_profiles")));
    expect(await f.request("PATCH", `/tool-gateway/gateways/${gateway.body.id}`, { companyId: f.companyId, agentId: null })).toMatchObject({ status: 403 });
    expect(await f.request("GET", `/companies/${f.companyId}/tools/gateways`)).toMatchObject({ status: 200, body: { gateways: expect.arrayContaining([expect.objectContaining({ id: gateway.body.id, agentId: f.agentId })]) } });
    for (const audience of [{ allAgents: false }, { agentIds: [] }]) {
      expect(await f.request("POST", `/companies/${f.companyId}/ai-connections`, {
        provider: "openai", method: "api_key", name: "No audience authority", apiKey: "unused-fixture-secret", ...audience,
      })).toMatchObject({ status: 403 });
    }
  });

  it("requires access to saved and replacement gateway profiles and project bindings", async () => {
    const f = await fixture();
    const saved = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "saved-scope", name: "Saved scope", entries: [] });
    const replacement = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "replacement-scope", name: "Replacement scope", entries: [] });
    expect(saved.status).toBe(201);
    expect(replacement.status).toBe(201);
    expect(await f.request("POST", `/companies/${f.companyId}/tools/profiles/${saved.body.id}/bind`, { targetType: "project", targetId: f.projectId })).toMatchObject({ status: 201 });
    const gateway = await f.request("POST", `/companies/${f.companyId}/tools/gateways`, { name: "Scoped gateway", slug: "scoped", profileId: saved.body.id });
    expect(gateway.status).toBe(201);
    await server.db.update(principalPermissionGrants).set({ scope: { profileIds: [replacement.body.id] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
    expect(await f.request("PATCH", `/tool-gateway/gateways/${gateway.body.id}`, { companyId: f.companyId, profileId: replacement.body.id })).toMatchObject({ status: 403 });
    // A grant covering both sides permits the same requested change.
    await server.db.update(principalPermissionGrants).set({ scope: { profileIds: [saved.body.id, replacement.body.id] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
    expect(await f.request("PATCH", `/tool-gateway/gateways/${gateway.body.id}`, { companyId: f.companyId, profileId: replacement.body.id })).toMatchObject({ status: 200, body: { profileId: replacement.body.id } });
    expect(await f.request("PATCH", `/tool-gateway/gateways/${gateway.body.id}`, { companyId: f.companyId, projectId: f.projectId })).toMatchObject({ status: 200 });
    const nextProjectId = randomUUID();
    await server.db.insert(projects).values({ id: nextProjectId, companyId: f.companyId, name: "Replacement project" });
    await server.db.update(principalPermissionGrants).set({ scope: { projectIds: [f.projectId] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_profiles")));
    expect(await f.request("PATCH", `/tool-gateway/gateways/${gateway.body.id}`, { companyId: f.companyId, projectId: nextProjectId })).toMatchObject({ status: 403 });
    expect(await f.request("PATCH", `/tool-gateway/gateways/${gateway.body.id}`, { companyId: f.companyId, projectId: null })).toMatchObject({ status: 403 });
    await server.db.update(principalPermissionGrants).set({ scope: { projectIds: [f.projectId, nextProjectId] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_profiles")));
    expect(await f.request("PATCH", `/tool-gateway/gateways/${gateway.body.id}`, { companyId: f.companyId, projectId: nextProjectId })).toMatchObject({ status: 200, body: { projectId: nextProjectId } });
    await server.db.update(principalPermissionGrants).set({ scope: null }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_profiles")));
    expect(await f.request("PATCH", `/tool-gateway/gateways/${gateway.body.id}`, { companyId: f.companyId, projectId: null })).toMatchObject({ status: 200, body: { projectId: null } });
  });

  it("saves an AI account with fixture verification under the user's ownership and agent attribution", async () => {
    const f = await fixture();
    provider = async url => {
      if (url === "https://api.openai.com/v1/models") return Response.json({ data: [] });
      throw new Error("Unexpected AI fixture request");
    };
    registerServerAdapter({ ...getServerAdapter("paperclip_runner"), testEnvironment: async () => ({ adapterType: "paperclip_runner", status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    try {
      const account = await f.request("POST", `/companies/${f.companyId}/ai-connections`, { provider: "openai", method: "api_key", name: "Fixture OpenAI", ownership: "personal", apiKey: "fixture-secret-do-not-return", agentIds: [f.agentId] });
      expect(account, JSON.stringify(account)).toMatchObject({ status: 201 });
      expect(JSON.stringify(account)).not.toContain("fixture-secret-do-not-return");
      const list = await f.request("GET", `/companies/${f.companyId}/ai-connections`);
      expect(list).toMatchObject({ status: 200, body: { currentUserId: f.userId } });
      const [row] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, account.body.connectionId));
      expect(row.createdByUserId).toBe(f.userId);
      const binding = { mode: "delegated", provider: "openai", method: "api_key", ...account.body };
      const bound = await f.request("PATCH", `/agents/${f.agentId}`, { runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false }, aiConnection: binding } });
      expect(bound, JSON.stringify(bound)).toMatchObject({ status: 200 });
      await instanceSettingsService(server.db).updateExperimental({ enableAiConnectionRouters: true });
      const pluginKey = `fixture.router.${f.agentId}`;
      await server.db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "0.1.0", status: "ready", manifestJson: {
        id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Fixture router", description: "Fixture", author: "Tests",
        categories: ["connector"], capabilities: ["ai.connections.route"], aiConnectionRouter: { name: "Fixture pool", description: "Use saved accounts" }, entrypoints: { worker: "worker.js" },
      } });
      const config = { name: "Fixture pool", enabled: true, mode: "round_robin", thresholdPercent: 90,
        members: [{ id: randomUUID(), binding, profile: { provider: "codex", model: "gpt-5.6-sol", effort: "low" } }] };
      const pool = await f.request("POST", `/companies/${f.companyId}/ai-connection-pools`, { pluginKey, config });
      expect(pool, JSON.stringify(pool)).toMatchObject({ status: 200, body: { revision: 1 } });
      const changed = await f.request("POST", `/companies/${f.companyId}/ai-connection-pools`, { pluginKey, id: pool.body.id, expectedRevision: 1, config: { ...config, name: "Changed pool" } });
      expect(changed, JSON.stringify(changed)).toMatchObject({ status: 200, body: { revision: 2 } });
      expect(await f.request("DELETE", `/companies/${f.companyId}/ai-connection-pools/${pool.body.id}`, { expectedRevision: 1 })).toMatchObject({ status: 409 });
      expect(await f.request("DELETE", `/companies/${f.companyId}/ai-connection-pools/${pool.body.id}`, { expectedRevision: 2 })).toMatchObject({ status: 200 });
      await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_profiles")));
      expect(await f.request("POST", `/companies/${f.companyId}/ai-connections`, { provider: "openai", method: "api_key", name: "No sharing authority", ownership: "personal", apiKey: "fixture-secret", agentIds: [f.agentId] })).toMatchObject({ status: 403 });
    } finally { provider = null; unregisterServerAdapter("paperclip_runner"); }
  });

  it("reads only the authorized Anthropic account identity through actual agent authentication", async () => {
    const f = await fixture();
    const account = await aiConnectionService(server.db).save(f.companyId, f.userId, {
      provider: "anthropic", method: "subscription", ownership: "personal", name: "Account identity fixture",
      loginSessionId: "fixture", agentIds: [f.agentId], allAgents: false,
    }, "selected-identity-credential");
    let calls = 0;
    provider = async (url, init) => {
      calls++;
      expect(url).toBe("https://api.anthropic.com/api/oauth/profile");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer selected-identity-credential");
      return Response.json({ account: { uuid: "private-seat", email: "avery@example.test" }, organization: { uuid: "private-org", name: "Example team" } });
    };
    const path = `/companies/${f.companyId}/ai-connections/${account.connectionId}/identity?grantId=${account.grantId}`;
    try {
      for (const token of [f.key.token, f.jwt]) {
        const response = await f.request("GET", path, undefined, token);
        expect(response).toMatchObject({ status: 200, body: { ...account, status: "available", accountLabel: "avery@example.test", organizationLabel: "Example team" } });
        for (const secret of ["selected-identity-credential", "private-seat", "private-org"]) expect(JSON.stringify(response)).not.toContain(secret);
      }
      expect(calls).toBe(2);
      expect((await f.request("GET", path.replace(f.companyId, f.foreignCompanyId))).status).toBe(403);
      expect((await f.request("GET", path.replace(account.grantId, randomUUID()))).status).toBe(404);
      expect(calls).toBe(2);
      await server.db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, account.grantId));
      expect(await f.request("GET", path)).toMatchObject({ status: 200, body: { status: "unavailable", errorCode: "connection_unavailable", accountLabel: null } });
      expect(calls).toBe(2);
    } finally { provider = null; }
  });

  it("filters AI account and pool listings by the agent's resolved connection scope", async () => {
    const f = await fixture();
    provider = async url => {
      if (url === "https://api.openai.com/v1/models") return Response.json({ data: [] });
      throw new Error("Unexpected AI fixture request");
    };
    try {
      const accounts: { connectionId: string; grantId: string }[] = [];
      for (const name of ["Allowed account", "Outside agent scope"]) {
        const account = await f.request("POST", `/companies/${f.companyId}/ai-connections`, { provider: "openai", method: "api_key", name, ownership: "personal", apiKey: `fixture-${name}`, agentIds: [] });
        expect(account, JSON.stringify(account)).toMatchObject({ status: 201 });
        accounts.push(account.body);
      }
      await instanceSettingsService(server.db).updateExperimental({ enableAiConnectionRouters: true });
      const pluginKey = `fixture.scope.${f.agentId}`;
      await server.db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "0.1.0", status: "ready", manifestJson: {
        id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Fixture router", description: "Fixture", author: "Tests",
        categories: ["connector"], capabilities: ["ai.connections.route"], aiConnectionRouter: { name: "Fixture pool", description: "Use saved accounts" }, entrypoints: { worker: "worker.js" },
      } });
      const savedPools: { id: string }[] = [];
      for (const account of accounts) {
        const pool = await f.request("POST", `/companies/${f.companyId}/ai-connection-pools`, { pluginKey, config: { name: `Pool ${account.connectionId}`, enabled: true, mode: "round_robin", thresholdPercent: 90,
          members: [{ id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", ...account }, profile: { provider: "codex", model: "gpt-5.6-sol", effort: "low" } }] } });
        expect(pool, JSON.stringify(pool)).toMatchObject({ status: 200 });
        savedPools.push(pool.body);
      }
      const path = `/companies/${f.companyId}/ai-connections?connectionId=${accounts[0].connectionId}`;
      expect((await f.request("GET", path)).body.connections).toHaveLength(2);
      expect((await f.request("GET", path)).body.pools).toHaveLength(2);
      for (const connectionIds of [[accounts[0].connectionId], [accounts[0].connectionId, ...savedPools.map(pool => pool.id)]]) {
        await server.db.update(principalPermissionGrants).set({ scope: { connectionIds } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
        for (const token of [f.key.token, f.jwt]) {
          const listed = await f.request("GET", path, undefined, token);
          expect(listed, JSON.stringify(listed)).toMatchObject({ status: 200 });
          expect(listed.body.connections.map((account: { id: string }) => account.id)).toEqual([accounts[0].connectionId]);
          expect(listed.body.pools.map((pool: { id: string }) => pool.id)).toEqual(connectionIds.length === 1 ? [] : [savedPools[0].id]);
        }
      }
    } finally { provider = null; }
  });

  it("reuses a saved chat authentication request and resumes only while its authority remains valid", async () => {
    const f = await fixture();
    const created = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "github", assignedAgentId: f.agentId });
    expect(created.status).toBe(201);
    const path = `/chat-endpoints/${created.body.id}/github/identity/start`;
    const first = await f.request("POST", path, {}, f.jwt);
    expect(first, JSON.stringify(first)).toMatchObject({ status: 200, body: { interactionId: expect.any(String) } });
    const retry = await f.request("POST", path, {}, f.jwt);
    expect(retry.body.interactionId).toBe(first.body.interactionId);
    const [intent] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, first.body.interactionId));
    const [task] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(intent).toMatchObject({ addresseeUserId: f.userId, payload: { savedSetup: { endpointId: created.body.id, connectionId: created.body.connectionId } } });
    expect(await findSatisfiedToolConnection(server.db, task, intent)).toBeNull();
    // Healthy App credentials alone do not prove the addressee's identity.
    await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await server.db.update(chatEndpoints).set({ status: "active", providerAccountId: "identity-fixture" }).where(eq(chatEndpoints.id, created.body.id));
    await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
    expect(await findSatisfiedToolConnection(server.db, task, intent)).toBeNull();
    await satisfiedConnectionIntentService(server.db).sweepPending();
    expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, intent.id)))[0].status).toBe("pending");
    expect(await server.db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, intent.id))).toEqual([]);
    const [principal] = await server.db.insert(chatExternalPrincipals).values({ companyId: f.companyId, provider: "github", providerAccountId: "identity-fixture", externalId: "1357" }).returning();
    const [link] = await server.db.insert(chatIdentityLinks).values({ companyId: f.companyId, endpointId: created.body.id, principalId: principal.id, paperclipUserId: f.userId, status: "pending" }).returning();
    for (const status of ["pending", "revoked", "expired"] as const) {
      await server.db.update(chatIdentityLinks).set({ status }).where(eq(chatIdentityLinks.id, link.id));
      expect(await findSatisfiedToolConnection(server.db, task, intent), status).toBeNull();
    }
    await server.db.update(chatIdentityLinks).set({ status: "linked", confirmedAt: new Date() }).where(eq(chatIdentityLinks.id, link.id));
    await server.db.update(chatIdentityLinks).set({ paperclipUserId: randomUUID() }).where(eq(chatIdentityLinks.id, link.id));
    expect(await findSatisfiedToolConnection(server.db, task, intent)).toBeNull();
    await server.db.update(chatIdentityLinks).set({ paperclipUserId: f.userId }).where(eq(chatIdentityLinks.id, link.id));
    await server.db.update(chatExternalPrincipals).set({ providerAccountId: "different-installation" }).where(eq(chatExternalPrincipals.id, principal.id));
    expect(await findSatisfiedToolConnection(server.db, task, intent)).toBeNull();
    await server.db.update(chatExternalPrincipals).set({ providerAccountId: "identity-fixture" }).where(eq(chatExternalPrincipals.id, principal.id));
    expect((await findSatisfiedToolConnection(server.db, task, intent))?.id).toBe(created.body.connectionId);
    expect(await findSatisfiedToolConnection(server.db, { ...task, status: "cancelled" }, intent)).toBeNull();
    await accessService(server.db).ensureMembership(f.companyId, "user", f.userId, "operator", "suspended");
    expect(await findSatisfiedToolConnection(server.db, task, intent)).toBeNull();
    await accessService(server.db).ensureMembership(f.companyId, "user", f.userId, "operator", "active");
    await satisfiedConnectionIntentService(server.db).sweepPending();
    const [delivery] = await server.db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.interactionId, intent.id));
    expect(delivery).toBeDefined();
  });

  it("retains a restricted user's personal self-service without company management or spoofed ownership", async () => {
    const f = await fixture();
    await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalType, "user"), eq(principalPermissionGrants.principalId, f.userId)));
    provider = async url => {
      if (url === "https://api.openai.com/v1/models") return Response.json({ data: [] });
      throw new Error("Unexpected AI fixture request");
    };
    const payload = { provider: "openai", method: "api_key", name: "Personal", ownership: "personal", apiKey: "personal-fixture", agentIds: [], allAgents: false };
    try {
      expect(await f.request("POST", `/companies/${f.companyId}/ai-connections`, { ...payload, ownership: "shared" })).toMatchObject({ status: 403 });
      expect(await f.request("POST", `/companies/${f.companyId}/ai-connections`, { ...payload, responsibleUserId: randomUUID() })).toMatchObject({ status: 403 });
      expect(await f.request("POST", `/companies/${f.companyId}/ai-connections`, payload)).toMatchObject({ status: 201 });
    } finally { provider = null; }
  });

  it("rejects foreign personal metadata, missing responsible users and task-bridge keys", async () => {
    const f = await fixture();
    const created = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Foreign personal fixture", transport: "mcp_remote", authKind: "none", transportConfig: { url: "https://1.1.1.1/mcp" } });
    expect(created.status).toBe(201);
    await server.db.update(toolConnections).set({ credentialPolicy: "per_user", createdByUserId: randomUUID() }).where(eq(toolConnections.id, created.body.id));
    expect(await f.request("GET", `/tool-connections/${created.body.id}`)).toMatchObject({ status: 403 });
    const listed = await f.request("GET", `/companies/${f.companyId}/tools/connections`);
    expect(JSON.stringify(listed.body)).not.toContain("Foreign personal fixture");
    const [policy] = await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Private account rule", policyType: "block", selectors: { connectionIds: [created.body.id] } }).returning();
    expect(JSON.stringify((await f.request("GET", `/companies/${f.companyId}/tools/policies`)).body)).not.toContain(policy.id);
    expect(await f.request("POST", `/companies/${f.companyId}/tools/policies`, { name: "Cannot edit foreign access", policyType: "allow", selectors: { agentId: f.agentId, connectionIds: [created.body.id] } })).toMatchObject({ status: 403 });

    await server.db.update(agentApiKeys).set({ responsibleUserId: null }).where(eq(agentApiKeys.id, f.key.id));
    expect((await f.request("GET", `/companies/${f.companyId}/tools/gallery`)).status).toBeGreaterThanOrEqual(400);
    const g = await fixture();
    await server.db.update(agentApiKeys).set({ scopeConfig: { kind: "task_bridge", parentIssueId: g.issueId } }).where(eq(agentApiKeys.id, g.key.id));
    expect((await g.request("GET", `/companies/${g.companyId}/tools/gallery`)).status).toBeGreaterThanOrEqual(400);
  });

  it("revalidates pending credential promotion after yielding without reviving cancelled work", async () => {
    const f = await fixture();
    const context = await connectionManagementService(server.db).authorize({ type: "agent", companyId: f.companyId,
      agentId: f.agentId, runId: f.runId, onBehalfOfUserId: f.userId }, "connections:configure",
      { type: "connection_management", companyId: f.companyId, purpose: "ai", operation: "login" });
    const continuation = continuingConnectionManagement(context)!;
    await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await expect(context.reauthorize()).rejects.toThrow();
    await expect(continuation.reauthorize()).resolves.toBeUndefined();
    await server.db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    await expect(continuation.reauthorize()).rejects.toThrow();
  });

  it("denies revoked agent grants and user authority, including shadow mode, without backfilling", async () => {
    const f = await fixture();
    await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
    expect(await f.request("GET", `/companies/${f.companyId}/tools/gallery`)).toMatchObject({ status: 403 });
    const g = await fixture();
    await accessService(server.db).ensureMembership(g.companyId, "user", g.userId, "operator", "suspended");
    expect(await g.request("GET", `/companies/${g.companyId}/tools/gallery`)).toMatchObject({ status: 403 });
  });

  it("enforces grant scopes, company isolation, effective trust, and Ask/Plan work modes", async () => {
    const f = await fixture();
    expect(await f.request("GET", `/companies/${f.foreignCompanyId}/tools/gallery`)).toMatchObject({ status: 403 });
    const owned = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Scoped fixture", transport: "mcp_remote", authKind: "none", transportConfig: { url: "https://1.1.1.1/mcp" } });
    expect(owned.status).toBe(201);
    await server.db.update(principalPermissionGrants).set({ scope: { connectionIds: [owned.body.id], purposes: ["tool"], operations: ["GET /tool-connections/:connectionId"] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
    expect(await f.request("GET", `/tool-connections/${owned.body.id}`)).toMatchObject({ status: 200 });
    expect(await f.request("PATCH", `/tool-connections/${owned.body.id}`, { name: "Beyond operation scope" })).toMatchObject({ status: 403 });
    await server.db.update(principalPermissionGrants).set({ scope: { provider: "slack" } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
    expect(await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "github", assignedAgentId: f.agentId })).toMatchObject({ status: 403 });
    const g = await fixture();
    for (const workMode of ["ask", "planning", "skill_test"]) {
      await server.db.update(issues).set({ workMode }).where(eq(issues.id, g.issueId));
      expect(await g.request("POST", `/companies/${g.companyId}/tools/profiles`, { name: "Forbidden" }, g.jwt)).toMatchObject({ status: 403 });
    }
    await server.db.update(issues).set({ workMode: "standard" }).where(eq(issues.id, g.issueId));
    await server.db.update(projects).set({ executionWorkspacePolicy: { authorizationPolicy: { trustPreset: "low_trust_review", lowTrustBoundary: { projectIds: [g.projectId] } } } }).where(eq(projects.id, g.projectId));
    expect(await g.request("POST", `/companies/${g.companyId}/tools/profiles`, { name: "Forbidden trust" }, g.jwt)).toMatchObject({ status: 403 });
    await server.db.update(agents).set({ permissions: { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { mode: "low_trust_review", projectIds: [g.projectId], rootIssueId: g.issueId } } } }).where(eq(agents.id, g.agentId));
    expect(await g.request("POST", `/companies/${g.companyId}/tools/profiles`, { name: "Forbidden agent trust" })).toMatchObject({ status: 403 });
  });
});
