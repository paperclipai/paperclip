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
describe("connection management delegated policy and profile access", () => {
  let server!: ConnectionManagementServer;
  let lifecycle!: ConnectionManagementLifecycle;
  let provider: ConnectionManagementProviderHandler | null = null;
  const harness = createConnectionManagementHarness(() => provider);
  beforeAll(() => {
    server = harness.server;
    lifecycle = harness.lifecycle;
  });
  const fixture = () => harness.fixture();

  it("completes concurrent run-authenticated profile finishing and policy writes without lock-order failures", async () => {
    const f = await fixture();
    const connection = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Concurrent management", transport: "mcp_remote", authKind: "none", transportConfig: { url: "https://1.1.1.1/mcp" } });
    const policy = await f.request("POST", `/companies/${f.companyId}/tools/policies`, { name: "Concurrent policy", policyType: "allow", selectors: { agentId: f.agentId } });
    expect(policy).toMatchObject({ status: 201 });
    const finishPath = `/companies/${f.companyId}/tools/apps/${connection.body.id}/finish`;
    const finish = { enabledCatalogEntryIds: [], access: { agentIds: [f.agentId] } };
    expect(await f.request("POST", finishPath, finish, f.jwt)).toMatchObject({ status: 200 });
    for (let round = 0; round < 3; round++) {
      const rows = await server.db.select({ id: toolPolicies.id }).from(toolPolicies).where(eq(toolPolicies.companyId, f.companyId));
      const results = await Promise.all([
        f.request("POST", `/companies/${f.companyId}/tools/policies/reorder`, { policyIds: rows.map(row => row.id) }, f.jwt),
        f.request("PATCH", `/companies/${f.companyId}/tools/policies/${policy.body.id}`, { description: `Round ${round}` }, f.jwt),
        f.request("POST", finishPath, finish, f.jwt),
      ]);
      expect([200, 422]).toContain(results[0].status);
      expect(results.slice(1), JSON.stringify(results)).toEqual([expect.objectContaining({ status: 200 }), expect.objectContaining({ status: 200 })]);
    }
    expect((await server.db.select().from(toolPolicies).where(eq(toolPolicies.id, policy.body.id)))[0].description).toBe("Round 2");
  });

  it("checks issue, routine, and gateway profile targets including retained bindings", async () => {
    const f = await fixture();
    const other = (await server.db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, f.companyId))).find(agent => agent.id !== f.agentId)!;
    const profile = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "target-checks", name: "Target checks", entries: [] });
    const gatewayProfile = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "gateway-target", name: "Gateway target", entries: [] });
    const gateway = await f.request("POST", `/companies/${f.companyId}/tools/gateways`, { name: "Target gateway", slug: "binding-target", profileId: gatewayProfile.body.id, agentId: other.id });
    expect(gateway, JSON.stringify(gateway)).toMatchObject({ status: 201 });
    const [issue] = await server.db.insert(issues).values({ companyId: f.companyId, title: "Other agent task", assigneeAgentId: other.id, status: "in_progress", responsibleUserId: f.userId }).returning();
    const [routine] = await server.db.insert(routines).values({ companyId: f.companyId, title: "Other agent routine", assigneeAgentId: other.id, responsibleUserId: f.userId }).returning();
    const [configurationGrant] = await server.db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    await server.db.update(principalPermissionGrants).set({ scope: { ...configurationGrant.scope, targetAgentIds: [f.agentId] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    const path = `/companies/${f.companyId}/tools/profiles/${profile.body.id}`;
    const ownBinding = await f.request("POST", `${path}/bind`, { targetType: "issue", targetId: f.issueId });
    expect(ownBinding, JSON.stringify(ownBinding)).toMatchObject({ status: 201 });
    expect(await f.request("POST", `${path}/unbind`, { targetType: "issue", targetId: f.issueId })).toMatchObject({ status: 200 });
    for (const target of [{ targetType: "project" as const, targetId: f.projectId }, { targetType: "issue" as const, targetId: issue.id }, { targetType: "routine" as const, targetId: routine.id }, { targetType: "gateway" as const, targetId: gateway.body.id }]) {
      expect(await f.request("POST", `${path}/bind`, target), JSON.stringify(target)).toMatchObject({ status: 403 });
      const [saved] = await server.db.insert(toolProfileBindings).values({ ...target, companyId: f.companyId, profileId: profile.body.id }).returning();
      expect(await f.request("PATCH", `/tool-profiles/${profile.body.id}`, { description: "Cannot edit retained target" })).toMatchObject({ status: 403 });
      expect(await f.request("POST", `${path}/unbind`, target)).toMatchObject({ status: 403 });
      await server.db.delete(toolProfileBindings).where(eq(toolProfileBindings.id, saved.id));
    }
    await server.db.update(toolMcpGateways).set({ profileId: profile.body.id }).where(eq(toolMcpGateways.id, gateway.body.id));
    expect(await f.request("PATCH", `/tool-profiles/${profile.body.id}`, { description: "Cannot edit a gateway's retained profile" })).toMatchObject({ status: 403 });
  });

  it("filters GitHub review history and detail by the linked task's private visibility", async () => {
    const f = await fixture();
    const endpoint = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "github", assignedAgentId: f.agentId });
    const [privateIssue] = await server.db.insert(issues).values({ companyId: f.companyId, title: "Private review task", visibility: "private", status: "in_progress", responsibleUserId: randomUUID() }).returning();
    const [visible, hidden] = await server.db.insert(chatGitHubReviews).values([f.issueId, privateIssue.id].map((issueId, index) => ({ companyId: f.companyId, endpointId: endpoint.body.id,
      issueId, repositoryId: "42", repository: "fixture/repo", pullNumber: index + 1, headSha: "b".repeat(40), deliveryId: randomUUID(), configurationRevision: 1,
      policySnapshot: defaultGitHubReviewPolicy(), event: { event: "opened" as const, deliveryId: randomUUID(), repositoryId: "42", repository: "fixture/repo", pullNumber: index + 1,
        title: "Review", body: index ? "Private provider context" : "Public context", baseSha: "a".repeat(40), headSha: "b".repeat(40), baseBranch: "master", author: { id: "1", login: "fixture", isBot: false }, sender: { id: "1", login: "fixture" }, draft: false, labels: [] },
    }))).returning();
    const path = `/chat-endpoints/${endpoint.body.id}/github/reviews`;
    expect((await f.request("GET", path)).body.map((review: { id: string }) => review.id)).toEqual([visible.id]);
    expect(await f.request("GET", `${path}/${visible.id}`)).toMatchObject({ status: 200 });
    expect(await f.request("GET", `${path}/${hidden.id}`)).toMatchObject({ status: 404 });
  });

  it("keeps narrow policy create, update, reorder, and delete within their actual audiences", async () => {
    const f = await fixture();
    const other = (await server.db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, f.companyId))).find(agent => agent.id !== f.agentId)!;
    await server.db.update(principalPermissionGrants).set({ scope: { targetAgentIds: [f.agentId] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    const path = `/companies/${f.companyId}/tools/policies`;
    const created = await f.request("POST", path, { name: "Own target rule", policyType: "allow", selectors: { agentId: f.agentId } });
    expect(created, JSON.stringify(created)).toMatchObject({ status: 201 });
    expect(await f.request("PATCH", `${path}/${created.body.id}`, { description: "Retain the target" })).toMatchObject({ status: 200 });
    expect(await f.request("POST", `${path}/reorder`, { policyIds: [created.body.id] })).toMatchObject({ status: 200 });
    expect(await f.request("PATCH", `${path}/${created.body.id}`, { selectors: {} })).toMatchObject({ status: 403 });
    expect(await f.request("PATCH", `${path}/${created.body.id}`, { selectors: { agentId: other.id } })).toMatchObject({ status: 403 });
    expect(await f.request("POST", path, { name: "Company rule", policyType: "allow", selectors: {} })).toMatchObject({ status: 403 });
    expect(await f.request("DELETE", `${path}/${created.body.id}`)).toMatchObject({ status: 200 });
  });

  it("bounds and deduplicates resource selectors before per-resource database work", async () => {
    const f = await fixture();
    const created = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Bounded selector", transport: "mcp_remote", authKind: "none", transportConfig: { url: "https://1.1.1.1/mcp" } });
    let resourceReads = 0;
    const originalSelect = server.db.select.bind(server.db);
    const select = vi.spyOn(server.db, "select").mockImplementation(((selection: never) => {
      const builder = originalSelect(selection);
      const originalFrom = builder.from.bind(builder);
      builder.from = ((table: never) => {
        if (table === toolConnections || table === toolPolicies || table === toolCatalogEntries) resourceReads++;
        return originalFrom(table);
      }) as typeof builder.from;
      return builder;
    }) as unknown as typeof server.db.select);
    try {
      const path = `/companies/${f.companyId}/tools/policies`;
      const body = { name: "Bounded policy", policyType: "allow", selectors: { agentId: f.agentId, connectionIds: Array(5000).fill(created.body.id) } };
      expect(await f.request("POST", path, body)).toMatchObject({ status: 400 });
      expect(resourceReads).toBe(0);
      expect(await f.request("POST", path, { ...body, selectors: { ...body.selectors, connectionIds: Array(100).fill(created.body.id) } })).toMatchObject({ status: 201 });
      expect(resourceReads).toBeLessThan(20);
      resourceReads = 0;
      await accessService(server.db).ensureMembership(f.companyId, "user", f.userId, "operator", "suspended");
      expect(await f.request("POST", path, { ...body, selectors: { ...body.selectors, connectionIds: Array(100).fill(created.body.id) } })).toMatchObject({ status: 403 });
      expect(resourceReads).toBe(0);
    } finally { select.mockRestore(); }
  });

  it("shares one run capture across a management read without caching authority across requests", async () => {
    const f = await fixture();
    for (let index = 0; index < 5; index++) expect(await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: `Read snapshot ${index}`, transport: "mcp_remote", authKind: "none", transportConfig: { url: "https://1.1.1.1/mcp" } })).toMatchObject({ status: 201 });
    const capture = vi.spyOn(runIdentity, "captureRunIdentity");
    try {
      const listed = await f.request("GET", `/companies/${f.companyId}/tools/connections`, undefined, f.jwt);
      expect(listed).toMatchObject({ status: 200 });
      expect(listed.body.connections).toHaveLength(5);
      expect(capture.mock.calls.length).toBeGreaterThan(0);
      expect(capture.mock.calls.length).toBeLessThanOrEqual(2);
      await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
      expect(await f.request("GET", `/companies/${f.companyId}/tools/connections`, undefined, f.jwt)).toMatchObject({ status: 403 });
    } finally { capture.mockRestore(); }
  });

  it("returns the same missing-resource response for foreign and absent connection IDs", async () => {
    const f = await fixture(), other = await fixture();
    const foreign = await other.request("POST", `/companies/${other.companyId}/tools/connections`, { name: "Other company", transport: "mcp_remote", authKind: "none", transportConfig: { url: "https://1.1.1.1/mcp" } });
    const hidden = await f.request("GET", `/tool-connections/${foreign.body.id}`);
    const absent = await f.request("GET", `/tool-connections/${randomUUID()}`);
    expect(hidden).toMatchObject({ status: 404 });
    expect(absent).toEqual(hidden);
  });

  it("checks existing and proposed provider scope without treating generic metadata as provider authority", async () => {
    const f = await fixture();
    const payload = { name: "Scoped provider", transport: "mcp_remote", authKind: "none", config: { url: "https://1.1.1.1/mcp", provider: "fixture-one" } };
    const created = await f.request("POST", `/companies/${f.companyId}/tools/connections`, payload);
    expect(created.status).toBe(201);
    const untagged = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { ...payload, name: "Untagged", config: { url: "https://1.1.1.1/mcp" } });
    const application = await f.request("POST", `/companies/${f.companyId}/tools/applications`, { name: "Provider app", type: "rest_api", metadata: { sourceTemplateKey: "fixture-one" } });
    expect(application).toMatchObject({ status: 201 });
    await server.db.update(principalPermissionGrants).set({ scope: { providers: ["fixture-one"] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
    expect(await f.request("PATCH", `/tool-connections/${untagged.body.id}`, { name: "Spoofed label", provider: "fixture-one" })).toMatchObject({ status: 403 });
    expect(await f.request("POST", `/companies/${f.companyId}/tools/applications`, { name: "Spoofed application", type: "rest_api", provider: "fixture-one", metadata: { sourceTemplateKey: "fixture-two" } })).toMatchObject({ status: 403 });
    expect(await f.request("PATCH", `/tool-applications/${application.body.id}`, { name: "Same app provider" })).toMatchObject({ status: 200 });
    for (const metadata of [{ sourceTemplateKey: "fixture-two" }, {}]) expect(await f.request("PATCH", `/tool-applications/${application.body.id}`, { provider: "fixture-one", metadata })).toMatchObject({ status: 403 });
    expect(await f.request("PATCH", `/tool-connections/${created.body.id}`, { name: "Still the same provider" })).toMatchObject({ status: 200 });
    for (const config of [{ url: "https://1.1.1.1/mcp", provider: "fixture-two" }, { url: "https://1.1.1.1/mcp" }]) expect(await f.request("PATCH", `/tool-connections/${created.body.id}`, { config })).toMatchObject({ status: 403 });
    expect(await f.request("POST", `/companies/${f.companyId}/tools/connections`, { ...payload, name: "Caller-labelled provider" })).toMatchObject({ status: 403 });
    await server.db.update(principalPermissionGrants).set({ scope: { purposes: ["tool"] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
    expect(await f.request("POST", `/companies/${f.companyId}/ai-connections`, { provider: "openai", method: "api_key", name: "Wrong purpose", apiKey: "fixture", ownership: "personal", agentIds: [] })).toMatchObject({ status: 403 });
  });

  it("hands generic app authentication to the saved setup without creating agent-bound OAuth state", async () => {
    const f = await fixture();
    const created = await f.request("POST", `/companies/${f.companyId}/tools/connections`, {
      name: "OAuth handoff fixture", transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", status: "draft",
      transportConfig: { url: "https://1.1.1.1/mcp" },
    });
    expect(created, JSON.stringify(created)).toMatchObject({ status: 201 });
    const path = `/tools/oauth/${created.body.id}/start`;
    const started = await f.request("POST", path, { asCurrentUser: true });
    expect(started, JSON.stringify(started)).toMatchObject({ status: 200, body: {
      expiresAt: null, requiredUserAction: { userId: f.userId, resource: { id: created.body.id } },
    } });
    // The agent links this in chat, so it is a relative app route, never the server's own origin.
    expect(started.body.authorizationUrl).toMatch(/^\/[^/]/);
    expect(started.body.requiredUserAction.setupPath).toBe(started.body.authorizationUrl);
    expect(new URL(started.body.authorizationUrl, "https://paperclip.example").searchParams.get("resume")).toBe(created.body.id);
    expect(await f.request("POST", path, { asCurrentUser: true })).toMatchObject({ status: 200, body: { authorizationUrl: started.body.authorizationUrl } });
    expect(await server.db.select().from(toolOauthStates).where(eq(toolOauthStates.connectionId, created.body.id))).toHaveLength(0);
  });

  it("delegates and revokes an owned credential with actual agent attribution", async () => {
    const f = await fixture();
    const created = await f.request("POST", `/companies/${f.companyId}/tools/connections`, {
      name: "Personal delegation fixture", transport: "mcp_remote", authKind: "none", credentialPolicy: "per_user",
      transportConfig: { url: "https://1.1.1.1/mcp" },
    });
    expect(created.status).toBe(201);
    // Provider fixture: a completed personal credential, not principal permissions.
    const [grant] = await server.db.insert(connectionGrants).values({ companyId: f.companyId,
      connectionId: created.body.id, kind: "user", subjectUserId: f.userId, status: "active",
      credentialSecretRefs: [], createdByUserId: f.userId,
    }).returning();
    const path = `/tool-connections/${created.body.id}/grants/${grant.id}/delegations`;
    const delegated = await f.request("POST", path, { agentId: f.agentId });
    expect(delegated, JSON.stringify(delegated)).toMatchObject({ status: 201 });
    expect(await f.request("POST", path, { agentId: f.agentId })).toMatchObject({ status: 201, body: { id: delegated.body.id } });
    expect(await f.request("DELETE", `${path}/${delegated.body.id}`)).toMatchObject({ status: 200 });
    expect(await server.db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.grantId, grant.id))).toHaveLength(0);
    const events = await server.db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.connectionId, created.body.id));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "connection_grant.delegated", actorType: "agent", actorId: f.agentId }),
      expect.objectContaining({ action: "connection_grant.delegation_revoked", actorType: "agent", actorId: f.agentId }),
    ]));
    const activity = await server.db.select().from(activityLog).where(eq(activityLog.entityId, grant.id));
    expect(activity).toEqual(expect.arrayContaining([expect.objectContaining({ actorType: "agent", actorId: f.agentId, responsibleUserId: f.userId })]));
  });

  it("saves the addressed user's Google service choices before handing off browser consent", async () => {
    const f = await fixture();
    const created = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Selected Google services", transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", status: "draft",
      config: { url: "https://1.1.1.1/mcp", sourceTemplateKey: "google-workspace", connectionMethodKey: "paperclip-workspace" } });
    expect(created, JSON.stringify(created)).toMatchObject({ status: 201 });
    const handoff = await f.request("POST", `/tools/oauth/${created.body.id}/start`, { asCurrentUser: true });
    expect(handoff, JSON.stringify(handoff)).toMatchObject({ status: 200, body: { expiresAt: null, requiredUserAction: { userId: f.userId } } });
    const [unselected] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.id));
    expect(unselected.config.workspaceSetup).toBeUndefined();
    const services = { gmail: "read" as const };
    const started = await f.request("POST", `/tools/oauth/${created.body.id}/start`, { asCurrentUser: true, workspaceServices: services });
    expect(started, JSON.stringify(started)).toMatchObject({ status: 200, body: { expiresAt: null, requiredUserAction: { userId: f.userId } } });
    const [saved] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.id));
    expect((saved.config.oauth as { pendingWorkspaceServiceRequests: Record<string, unknown> }).pendingWorkspaceServiceRequests).toEqual({
      [f.userId]: { requestedScopes: googleWorkspaceSelectedScopes(services), requestedAt: expect.any(String) },
    });
    const restored = await f.request("GET", `/tool-connections/${saved.id}`);
    expect(restored).toMatchObject({ status: 200, body: { config: { oauth: { pendingWorkspaceServiceRequests: {
      [f.userId]: { requestedScopes: googleWorkspaceSelectedScopes(services) },
    } } } } });
    expect(await server.db.select().from(toolOauthStates).where(eq(toolOauthStates.connectionId, saved.id))).toHaveLength(0);
    expect(await f.request("POST", `/tools/oauth/${saved.id}/start`, { asCurrentUser: true })).toMatchObject({ status: 200, body: { authorizationUrl: started.body.authorizationUrl } });
    const [handedOff] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, saved.id));
    expect(handedOff.config.workspaceSetup).toBeUndefined();
    expect(handedOff.config.oauth).toEqual(saved.config.oauth);
  });

  it("discovers and invokes connection APIs through default production native bindings", async () => {
    const f = await fixture();
    const definitions = await f.authority.definitions();
    const names = definitions.map(d => d.name);
    const context = await f.authority.execute({ tool: "get_task_context", callId: "configuration-guidance", arguments: {} });
    expect(JSON.stringify(context)).toContain("Standard agents can manage connections under their responsible user's authority");
    expect(JSON.stringify(definitions.find(d => d.name === "connections_search"))).toContain("search_api/call_api");
    expect(names).toEqual(expect.arrayContaining(["search_api", "call_api"]));
    const search = await f.authority.execute({ tool: "search_api", callId: "find-profile", arguments: { query: "create tools profiles", limit: 10 } });
    expect(JSON.stringify(search)).toContain("POST /api/companies/{companyId}/tools/profiles");
    const result = await f.authority.execute({ tool: "call_api", callId: "create-profile", arguments: { operationId: "POST /api/companies/{companyId}/tools/profiles", body: { profileKey: "native-profile", name: "Native profile", entries: [] } } });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 201, ok: true });
  });

});
