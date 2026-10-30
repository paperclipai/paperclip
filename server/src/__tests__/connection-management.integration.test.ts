import { createToolGatewayService } from "../services/tool-gateway.js";
import { commitToolActionReview } from "../services/tool-action-review.js";
import { googleWorkspaceSelectedScopes, defaultGitHubReviewPolicy, SLACK_CHAT_BOT_SCOPES, SLACK_BOT_TOOL_SCOPES } from "@paperclipai/shared";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { createServer } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createDb, authUsers, activityLog, agentApiKeys, companies, companySecrets, companySecretVersions, chatConversations, chatDeliveries, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, toolPolicies, toolRateLimitCounters, connectionGrants, connectionGrantMembers, connectionGrantDelegations, toolAccessAuditEvents, toolOauthStates, issueThreadInteractions, connectionIntentDeliveries, agents, companyMemberships, heartbeatRuns, issues, principalPermissionGrants, projects, toolApplications, toolConnections, toolConnectionInstalls, toolMcpGateways, toolMcpGatewayTokens, toolActionRequests, toolCatalogEntries, toolInvocations, toolCallEvents, toolProfiles, toolProfileBindings, plugins, adapterAuthSessions, environments, routines, chatGitHubReviews } from "@paperclipai/db";
import { findSatisfiedToolConnection, satisfiedConnectionIntentService } from "../services/satisfied-connection-intents.js";
import { connectionManagementService, continuingConnectionManagement } from "../services/connection-management.js";
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

// All requests traverse the assembled server and production bearer middleware.
// No req.actor injection or special permission grants establish access.
describe("connection management with production default agents", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  let lifecycle: ReturnType<typeof configureAgentLifecycle>;
  let provider: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;
  let providerFetch: ReturnType<typeof vi.spyOn>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    vi.stubEnv("PAPERCLIP_RESPONSIBLE_USER_AUTHZ_MODE", "shadow");
    vi.stubEnv("PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", "false");
    const realFetch = globalThis.fetch;
    providerFetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (new URL(url).hostname === "127.0.0.1") return realFetch(input, init);
      if (provider) return provider(url, init);
      throw new Error("Unexpected external request in provider fixture");
    });
    server = await startRunnerApiTestServer({ authPublicBaseUrl: "https://paperclip.fixture.invalid", humanSessions: true, databaseUrl: process.env.PAPERCLIP_CONNECTION_MANAGEMENT_TEST_DATABASE_URL });
    lifecycle = configureAgentLifecycle(server.db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(server.root, "master.key"));
    await instanceSettingsService(server.db).updateExperimental({ enableChatConnectors: true, enableGitHubReviewBots: true });
  }, 90_000);
  afterAll(async () => { await lifecycle?.stop(); await server?.close(); providerFetch?.mockRestore(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  async function fixture() {
    const base = await server.fixture({ connectionScenario: "fresh" });
    const userId = base.responsibleUserId!;
    const access = accessService(server.db);
    await access.ensureMembership(base.companyId, "user", userId, "operator", "active");
    await access.ensureRoleDefaultGrants(base.companyId, userId, "operator", userId);
    await server.db.update(companies).set({ requireBoardApprovalForNewAgents: false }).where(eq(companies.id, base.companyId));
    const cookie = await server.humanSession(userId);
    const created = await fetch(`${server.apiUrl}/api/companies/${base.companyId}/agents`, {
      method: "POST", headers: { cookie, "Content-Type": "application/json", origin: server.apiUrl },
      body: JSON.stringify({ name: "Fresh standard agent", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } }, permissions: {} }),
    });
    const agent = await created.json();
    expect(agent, JSON.stringify(agent)).toHaveProperty("id");
    expect(created.status).toBe(201);
    await lifecycle.process(agent.id);
    await vi.waitFor(async () => expect((await agentService(server.db).getById(agent.id))?.status).toBe("idle"), { timeout: 10_000 });
    await server.db.update(heartbeatRuns).set({ agentId: agent.id }).where(eq(heartbeatRuns.id, base.runId));
    await server.db.update(issues).set({ assigneeAgentId: agent.id, responsibleUserId: userId }).where(eq(issues.id, base.issueId));
    const key = await agentService(server.db).createApiKey(agent.id, "integration", { kind: "standard" }, { responsibleUserId: userId });
    const jwt = createLocalAgentJwt(agent.id, base.companyId, "paperclip_runner", base.runId, userId);
    const request = async (method: string, path: string, body?: unknown, token = key.token) => {
      const response = await fetch(server.apiUrl + (path.startsWith("/mcp/") ? "" : "/api") + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    return { ...base, agentId: agent.id, userId, key, jwt, request,
      authority: new PaperclipRunnerToolAuthority(server.db, { companyId: base.companyId, agentId: agent.id, issueId: base.issueId, runId: base.runId, apiUrl: server.apiUrl, storage: server.storage }) };
  }

  it("matches ordinary install capabilities on real PostgreSQL for scoped, retained and fallback resources", async () => {
    const f = await server.fixture({ connectionScenario: "fresh" });
    const candidateIds = [f.agentId, randomUUID(), randomUUID()];
    await server.db.insert(agents).values(candidateIds.slice(1).map((id, index) => ({ id, companyId: f.companyId, name: `Capability target ${index}`, adapterType: "process" })));
    const [application] = await server.db.insert(toolApplications).values({ companyId: f.companyId, name: "Capability differential", type: "mcp_http" }).returning();
    const [connection] = await server.db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
      uid: randomUUID(), name: "Capability differential", transport: "mcp_remote", authKind: "none", createdByUserId: "different-creator" }).returning();
    await server.db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.responsibleUserId!,
      permissionKey: "tools:manage_profiles", scope: { targetAgentIds: candidateIds.slice(0, 2) } });
    const service = connectionManagementService(server.db);
    const actor: AuthorizationActor = { type: "board", userId: f.responsibleUserId, source: "cloud_tenant" };
    const resource = { type: "connection_management" as const, companyId: f.companyId, connectionId: connection.id, operation: "configure", readOnly: false };
    const compare = async (base: ConnectionManagementResource = resource, candidates: readonly string[] = candidateIds, principal = actor) => {
      const baseline = [];
      for (const targetAgentId of candidates) baseline.push(await service.capability(principal, "connections:profiles", { ...base, targetAgentId }));
      const batch = await service.describeAgentInstallCapabilities(principal, base, candidates);
      expect(batch).toEqual(baseline);
      return batch;
    };
    expect((await compare()).map(result => result.allowed)).toEqual([true, true, false]);
    expect(await service.capability(actor, "connections:profiles", resource)).toMatchObject({ allowed: false });
    expect(await compare(resource, [])).toEqual([]);
    expect((await compare(resource, [candidateIds[1], candidateIds[0], candidateIds[1]])).map(result => result.allowed)).toEqual([true, true, true]);
    // A saved empty text target leaves the candidate ID in the ordinary
    // evaluator's resolved policy input, so it is not a shared target prefix.
    await server.db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id, targetType: "agent", targetId: "" });
    const emptyTargetCandidates = [candidateIds[2], candidateIds[0]];
    const emptyTargetBaseline = [];
    for (const targetAgentId of emptyTargetCandidates) {
      emptyTargetBaseline.push(await service.capability(actor, "connections:profiles", { ...resource, targetAgentId }));
    }
    expect(emptyTargetBaseline.map(capability => capability.allowed)).toEqual([false, true]);
    expect(await service.describeAgentInstallCapabilities(actor, resource, emptyTargetCandidates)).toEqual(emptyTargetBaseline);
    await server.db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id));
    await server.db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id, targetType: "agent", targetId: candidateIds[0] });
    expect((await compare()).map(result => result.allowed)).toEqual([true, true, false]);
    await server.db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id, targetType: "agent", targetId: candidateIds[2] });
    expect((await compare()).every(result => !result.allowed)).toBe(true);
    await server.db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id));
    await server.db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id, targetType: "company", targetId: f.companyId });
    expect((await compare()).every(result => !result.allowed)).toBe(true);
    // JavaScript target sets distinguish UUID spelling; PostgreSQL's uuid
    // lookup does not. Noncanonical candidates must retain ordinary evaluation.
    for (const spellings of [candidateIds.map(id => id.toUpperCase()),
      [candidateIds[0].toUpperCase(), candidateIds[1], candidateIds[0], candidateIds[1].toUpperCase(), candidateIds[0].toUpperCase()]]) {
      expect((await compare(resource, spellings, { type: "board", source: "local_implicit" })).map(result => result.allowed))
        .toEqual(spellings.map(() => true));
    }
    await server.db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id));
    await server.db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id, targetType: "agent", targetId: randomUUID() });
    expect((await compare(resource, candidateIds, { type: "board", source: "local_implicit" })).map(result => result.reason))
      .toEqual(candidateIds.map(() => "Target agent is outside this company"));
    await server.db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id));
    const [foreign] = await server.db.insert(agents).values({ companyId: f.foreignCompanyId, name: "Foreign capability target", adapterType: "process" }).returning();
    expect((await compare(resource, [candidateIds[0], foreign.id], { type: "board", source: "local_implicit" })).map(result => result.allowed))
      .toEqual([true, false]);
    const [profile] = await server.db.insert(toolProfiles).values({ companyId: f.companyId, name: "Fallback profile", profileKey: randomUUID(), defaultAction: "deny" }).returning();
    await compare({ ...resource, profileId: profile.id });
    // Proposed changes also stay on the full evaluator, including own-property presence.
    await compare({ ...resource, requestedProvider: null });
    const faultingDb = new Proxy(server.db, { get(target, key, receiver) {
      if (key !== "select") return Reflect.get(target, key, receiver);
      return (...fields: Parameters<typeof target.select>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const query = from(...args), execute = query.execute.bind(query);
          query.execute = (async (...executeArgs: Parameters<typeof execute>) => {
            const compiled = query.toSQL();
            if (compiled.sql.includes('"agents"."id" =') && compiled.params[0] === candidateIds[1]) {
              // A real database failure at the visited target boundary, rather
              // than a fake permission denial or a mocked query result.
              await server.db.$client.unsafe("SELECT 1 / 0");
            }
            return execute(...executeArgs);
          }) as typeof execute;
          return query;
        }) as typeof builder.from;
        return builder;
      };
    } });
    const faulting = connectionManagementService(faultingDb);
    const localActor: AuthorizationActor = { type: "board", source: "local_implicit" };
    await expect(faulting.capability(localActor, "connections:profiles", { ...resource, targetAgentId: candidateIds[1] })).rejects.toThrow(/division by zero/);
    await expect(faulting.describeAgentInstallCapabilities(localActor, resource, [candidateIds[1]])).rejects.toThrow(/division by zero/);
    await server.db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id, targetType: "agent", targetId: randomUUID() });
    const denied = await faulting.capability(localActor, "connections:profiles", { ...resource, targetAgentId: candidateIds[1] });
    expect(denied).toMatchObject({ allowed: false, reason: "Target agent is outside this company" });
    expect(await faulting.describeAgentInstallCapabilities(localActor, resource, [candidateIds[1]])).toEqual([denied]);
  });

  it("preserves the complete grants GET across human roles and denies a real install mutation after revocation", async () => {
    const f = await server.fixture({ connectionScenario: "fresh" });
    const candidateIds = [f.agentId, randomUUID(), randomUUID()];
    await server.db.insert(agents).values(candidateIds.slice(1).map((id, index) => ({ id, companyId: f.companyId, name: `Grant target ${index}`, adapterType: "process" })));
    const users = { creator: f.responsibleUserId!, manager: randomUUID(), member: randomUUID(), viewer: randomUUID(), inactive: randomUUID(),
      admin: randomUUID(), owner: randomUUID(), operator: randomUUID() };
    for (const [name, userId] of Object.entries(users)) {
      if (name !== "creator") {
        await server.db.insert(authUsers).values({ id: userId, name, email: `${userId}@fixture.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
        await server.db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId,
          membershipRole: ["viewer", "admin", "owner", "operator"].includes(name) ? name : "member", status: name === "inactive" ? "inactive" : "active" });
      }
    }
    for (const permissionKey of ["tools:manage_connections", "tools:manage_profiles", "tools:use", "agents:configure"]) {
      await server.db.insert(principalPermissionGrants).values([users.manager, users.admin].map(principalId => ({ companyId: f.companyId, principalType: "user", principalId, permissionKey })));
    }
    await server.db.insert(principalPermissionGrants).values(["tools:manage_profiles", "agents:configure"].map(permissionKey => ({ companyId: f.companyId,
      principalType: "user", principalId: users.member, permissionKey,
      scope: permissionKey === "tools:manage_profiles" ? { targetAgentIds: candidateIds.slice(0, 2) } : null })));
    const [application] = await server.db.insert(toolApplications).values({ companyId: f.companyId, name: "Grants response parity", type: "mcp_http" }).returning();
    const [connection] = await server.db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
      uid: randomUUID(), name: "Grants response parity", transport: "mcp_remote", authKind: "none", createdByUserId: users.creator }).returning();
    const grants = await server.db.insert(connectionGrants).values([
      { companyId: f.companyId, connectionId: connection.id, kind: "organization", createdByUserId: users.creator, isDefault: true },
      ...[users.creator, users.manager, users.member].map((subjectUserId, index) => ({ companyId: f.companyId, connectionId: connection.id, kind: "user" as const,
        subjectUserId, createdByUserId: subjectUserId, updatedAt: new Date(`2026-10-2${index + 1}T12:00:00.000Z`) })),
    ]).returning();
    await server.db.insert(connectionGrantMembers).values({ companyId: f.companyId, grantId: grants[0].id, subjectType: "user", subjectId: users.member });
    await server.db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id, targetType: "agent", targetId: candidateIds[0] });
    const cookies = Object.fromEntries(await Promise.all(Object.entries(users).map(async ([name, userId]) => [name, await server.humanSession(userId)])));
    const request = async (name: keyof typeof users, method = "GET", body?: unknown) => {
      const response = await fetch(`${server.apiUrl}/api/tool-connections/${connection.id}/${method === "GET" ? "grants" : "installs"}`, {
        method, headers: { cookie: cookies[name], origin: server.apiUrl, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const original = connectionManagementModule.connectionManagementService;
    const legacy = vi.spyOn(connectionManagementModule, "connectionManagementService").mockImplementation(db => {
      const service = original(db);
      return { ...service, describeAgentInstallCapabilities: async (actor, base, candidates, options) => {
        const result = [];
        for (const targetAgentId of candidates) result.push(await service.capability(actor, "connections:profiles", { ...base, targetAgentId, readOnly: false }, options));
        return result;
      } };
    });
    const baseline = new Map<string, Awaited<ReturnType<typeof request>>>();
    try {
      for (const name of Object.keys(users) as Array<keyof typeof users>) baseline.set(name, await request(name));
    } finally { legacy.mockRestore(); }
    const actual = new Map<string, Awaited<ReturnType<typeof request>>>();
    for (const name of Object.keys(users) as Array<keyof typeof users>) {
      actual.set(name, await request(name));
      expect(actual.get(name), name).toEqual(baseline.get(name));
    }
    expect(actual.get("manager")).toMatchObject({ status: 200, body: { capabilities: { canConfigure: true, canViewOtherPersonalIdentities: true, editableAgentIds: expect.arrayContaining(candidateIds) } } });
    expect(actual.get("manager")!.body.grants).toHaveLength(4);
    expect(actual.get("creator")!.body.capabilities).toMatchObject({ canConfigure: true, canViewOtherPersonalIdentities: false });
    expect(actual.get("creator")!.body.members.length).toBeGreaterThan(0);
    expect(actual.get("member")!.body.capabilities).toMatchObject({ canConfigure: false, canViewOtherPersonalIdentities: false, editableAgentIds: expect.arrayContaining(candidateIds.slice(0, 2)) });
    expect(actual.get("member")!.body.capabilities.editableAgentIds).toHaveLength(2);
    expect(actual.get("member")!.body.grants.map((grant: { id: string }) => grant.id)).toEqual([grants[0].id, grants[3].id]);
    expect(actual.get("member")!.body.members).toEqual([]);
    expect(actual.get("viewer")!.body.capabilities).toMatchObject({ canConfigure: false, canManageAgentInstalls: false, editableAgentIds: [] });
    expect(actual.get("inactive")!.status).toBe(404);
    const installs = [{ targetType: "agent", targetId: candidateIds[0] }, { targetType: "agent", targetId: candidateIds[1] }];
    const beforeRevoke = await request("member", "PUT", { installs });
    expect(beforeRevoke, JSON.stringify(beforeRevoke)).toMatchObject({ status: 200 });
    await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, f.companyId), eq(principalPermissionGrants.principalId, users.member)));
    expect(await request("member")).toMatchObject({ status: 200, body: { capabilities: { editableAgentIds: [], canManageAgentInstalls: false } } });
    expect(await request("member", "PUT", { installs: [{ targetType: "agent", targetId: candidateIds[0] }] })).toMatchObject({ status: 403 });
    const savedInstalls = await server.db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id));
    expect(savedInstalls.map(install => install.targetId)).toEqual(expect.arrayContaining(candidateIds.slice(0, 2)));
    expect(savedInstalls).toHaveLength(2);
  });

  it("creates and configures tool connections and profiles with fresh grants and actual key/JWT authentication", async () => {
    const f = await fixture();
    const grants = await server.db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, f.agentId));
    expect(grants.some(g => g.permissionKey === "tools:admin")).toBe(false);
    expect(await f.request("GET", `/companies/${f.companyId}/tools/stdio-templates`)).toMatchObject({ status: 403 });
    const created = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Fixture tool", transport: "mcp_remote", authKind: "none", transportConfig: { url: "https://1.1.1.1/mcp" } });
    expect(created, JSON.stringify(created)).toMatchObject({ status: 201 });
    expect(await f.request("PATCH", `/tool-connections/${created.body.id}`, { name: "Updated tool" }, f.jwt)).toMatchObject({ status: 200, body: { name: "Updated tool" } });
    const [saved] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.id));
    expect(saved.createdByUserId).toBe(f.userId);
    const audit = await server.db.select().from(activityLog).where(eq(activityLog.entityId, saved.id));
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ actorType: "agent", actorId: f.agentId, responsibleUserId: f.userId,
      details: expect.objectContaining({ permissionDecision: expect.objectContaining({ action: "connections:configure", reason: expect.stringMatching(/^allow_/) }) }),
    })]));
    const profile = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "fixture-profile", name: "Fixture profile", defaultAction: "deny", entries: [] });
    expect(profile, JSON.stringify(profile)).toMatchObject({ status: 201 });
  });

  it("checks effective-profile connection access once for hundreds of tools on the same account", async () => {
    const f = await fixture();
    const connection = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Large catalog", transport: "mcp_remote", authKind: "none", config: { url: "https://1.1.1.1/mcp" } });
    expect(connection).toMatchObject({ status: 201 });
    await server.db.insert(toolCatalogEntries).values(Array.from({ length: 200 }, (_, index) => ({ companyId: f.companyId, applicationId: connection.body.applicationId, connectionId: connection.body.id, name: `tool_${index}`, toolName: `tool_${index}`, versionHash: `fixture_${index}` })));
    const profile = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "large-catalog", name: "Large catalog", entries: [{ selectorType: "connection", connectionId: connection.body.id }] });
    expect(profile).toMatchObject({ status: 201 });
    expect(await f.request("POST", `/companies/${f.companyId}/tools/profiles/${profile.body.id}/bind`, { targetType: "agent", targetId: f.agentId })).toMatchObject({ status: 201 });
    expect(await f.request("PUT", `/tool-connections/${connection.body.id}/installs`, { installs: [{ targetType: "agent", targetId: f.agentId }] })).toMatchObject({ status: 200 });
    const module = await import("../services/connection-management.js");
    const original = connectionManagementService;
    let connectionChecks = 0;
    const factory = vi.spyOn(module, "connectionManagementService").mockImplementation((...args) => {
      const service = original(...args);
      return { ...service, capability: async (...input: Parameters<typeof service.capability>) => {
        if (input[2].connectionId === connection.body.id) connectionChecks++;
        return service.capability(...input);
      } };
    });
    try {
      const effective = await f.request("GET", `/companies/${f.companyId}/tools/profiles/effective/agents/${f.agentId}`);
      expect(effective, JSON.stringify(effective)).toMatchObject({ status: 200 });
      expect(effective.body.allowedTools).toHaveLength(200);
      expect(effective.body.installedConnections).toHaveLength(1);
      expect(connectionChecks).toBe(1);
    } finally { factory.mockRestore(); }
  });

  it("checks every saved profile selector and effective projection against personal account visibility", async () => {
    const f = await fixture();
    const first = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Owned profile account", transport: "mcp_remote", authKind: "none", config: { url: "https://1.1.1.1/mcp" } });
    expect(first).toMatchObject({ status: 201 });
    const second = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { applicationId: first.body.applicationId, name: "Private profile account", transport: "mcp_remote", authKind: "none", config: { url: "https://1.1.1.1/mcp" } });
    expect(second, JSON.stringify(second)).toMatchObject({ status: 201, body: { applicationId: first.body.applicationId } });
    const [known] = await server.db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId: first.body.applicationId, connectionId: first.body.id, name: "known", toolName: "known", versionHash: "known" }).returning();
    const profileIds: string[] = [];
    const selectors = [
      { selectorType: "application", applicationId: first.body.applicationId },
      { selectorType: "catalog_entry", catalogEntryId: known.id },
      { selectorType: "tool_name", toolName: "private_tool" },
      { selectorType: "risk_level", riskLevel: "read" },
    ];
    for (const [index, entry] of selectors.entries()) {
      const profile = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: `privacy-${index}`, name: `Privacy ${index}`, entries: [entry] });
      expect(profile, JSON.stringify(profile)).toMatchObject({ status: 201 });
      profileIds.push(profile.body.id);
    }
    const all = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "privacy-all", name: "All tools", defaultAction: "allow", entries: [] });
    expect(all).toMatchObject({ status: 201 });
    profileIds.push(all.body.id);
    expect(await f.request("POST", `/companies/${f.companyId}/tools/profiles/${profileIds[0]}/bind`, { targetType: "agent", targetId: f.agentId })).toMatchObject({ status: 201 });
    await server.db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId: first.body.applicationId, connectionId: second.body.id, name: "private_tool", toolName: "private_tool", description: "Private tool metadata", versionHash: "private", firstSeenAt: new Date(Date.now() + 60_000) });
    expect(await f.request("GET", `/tool-profiles/${profileIds[1]}/new-tools`)).toMatchObject({ status: 200, body: { tools: [expect.objectContaining({ connectionName: "Private profile account", description: "Private tool metadata" })] } });
    const effectivePath = `/companies/${f.companyId}/tools/profiles/effective/agents/${f.agentId}`;
    expect((await f.request("GET", effectivePath)).body.allowedTools.some((tool: { toolName: string }) => tool.toolName === "private_tool")).toBe(true);
    expect(await f.request("PUT", `/tool-connections/${second.body.id}/installs`, { installs: [{ targetType: "agent", targetId: f.agentId }] })).toMatchObject({ status: 200 });
    await server.db.update(toolConnections).set({ credentialPolicy: "per_user", createdByUserId: randomUUID() }).where(eq(toolConnections.id, second.body.id));
    for (const token of [f.key.token, f.jwt]) {
      expect(await f.request("GET", `/tool-profiles/${profileIds[1]}/new-tools`, undefined, token)).toMatchObject({ status: 403 });
      for (const id of profileIds) expect(await f.request("GET", `/tool-profiles/${id}/new-tools`, undefined, token)).toMatchObject({ status: 403 });
      expect((await f.request("GET", `/companies/${f.companyId}/tools/profiles`, undefined, token)).body.profiles).toEqual([]);
      expect(await f.request("GET", effectivePath, undefined, token)).toMatchObject({ status: 403 });
    }
    for (const [index, entry] of selectors.entries()) expect(await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: `private-attempt-${index}`, name: `Private attempt ${index}`, entries: [entry] })).toMatchObject({ status: 403 });
    expect(await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "private-attempt-all", name: "Private all", defaultAction: "allow", entries: [] })).toMatchObject({ status: 403 });
    await server.db.delete(toolProfileBindings).where(and(eq(toolProfileBindings.companyId, f.companyId), eq(toolProfileBindings.targetType, "agent"), eq(toolProfileBindings.targetId, f.agentId)));
    expect(await f.request("GET", effectivePath)).toMatchObject({ status: 403 });
    await server.db.update(toolConnections).set({ createdByUserId: f.userId }).where(eq(toolConnections.id, second.body.id));
    expect(await f.request("GET", effectivePath)).toMatchObject({ status: 200 });
    await server.db.update(principalPermissionGrants).set({ scope: { connectionIds: [first.body.id] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_profiles")));
    for (const id of profileIds) expect(await f.request("GET", `/tool-profiles/${id}/new-tools?connectionId=${first.body.id}`)).toMatchObject({ status: 403 });
    await server.db.update(principalPermissionGrants).set({ scope: { connectionIds: [first.body.id, second.body.id] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_profiles")));
    for (const id of profileIds) expect(await f.request("GET", `/tool-profiles/${id}/new-tools?connectionId=${first.body.id}`)).toMatchObject({ status: 200 });
  });

  it("rechecks authority after remote endpoint validation before committing a connection update", async () => {
    const f = await fixture();
    const created = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Before validation", transport: "mcp_remote", authKind: "none", transportConfig: { url: "https://1.1.1.1/mcp" } });
    expect(created).toMatchObject({ status: 201 });
    const original = remoteEndpointGuard.assertPublicRemoteHttpEndpoint;
    const validation = vi.spyOn(remoteEndpointGuard, "assertPublicRemoteHttpEndpoint").mockImplementation(async (...args) => {
      const result = await original(...args);
      await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
      return result;
    });
    try {
      expect(await f.request("PATCH", `/tool-connections/${created.body.id}`, { name: "After validation" })).toMatchObject({ status: 403 });
      expect(validation).toHaveBeenCalled();
      expect((await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.id)))[0].name).toBe("Before validation");
    } finally { validation.mockRestore(); }
  });

  it("reaches sandbox device-login management as the responsible user and protects another owner's saved session", async () => {
    const f = await fixture();
    registerServerAdapter({ ...getServerAdapter("paperclip_runner"), type: "codex_local", loginCapability: {
      panelMode: "displayed_code", timeoutPolicy: "caller_bounded", getCommand: () => "codex login --device-auth", parsePrompt: () => null,
    } });
    try {
      const [environment] = await server.db.insert(environments).values({ name: `Login fixture ${f.agentId}`, driver: "sandbox" }).returning();
      const [session] = await server.db.insert(adapterAuthSessions).values({ companyId: f.companyId, environmentId: environment.id, adapterType: "codex_local", startedByUserId: f.userId,
        publicSessionId: randomUUID(), status: "waiting_for_user", expiresAt: new Date(Date.now() + 60_000), aiConnection: { ownership: "personal", name: "Saved login", allAgents: false, agentIds: [] } }).returning();
      const path = `/companies/${f.companyId}/adapters/codex_local/login-sessions`;
      expect(await f.request("GET", `${path}/active`)).toMatchObject({ status: 200, body: { sessionId: session.publicSessionId } });
      expect(await f.request("GET", `${path}/${session.publicSessionId}`, undefined, f.jwt)).toMatchObject({ status: 200, body: { sessionId: session.publicSessionId } });
      expect(await f.request("POST", path, {})).toMatchObject({ status: 400 });
      expect(await f.request("POST", `${path}/${session.publicSessionId}/cancel`, {})).toMatchObject({ status: 200 });
      await server.db.update(adapterAuthSessions).set({ startedByUserId: randomUUID() }).where(eq(adapterAuthSessions.id, session.id));
      expect(await f.request("GET", `${path}/${session.publicSessionId}`)).toMatchObject({ status: 404 });
      expect(await f.request("POST", `${path}/${session.publicSessionId}/cancel`, {})).toMatchObject({ status: 404 });
    } finally { unregisterServerAdapter("codex_local"); }
  });

  it("checks finish access, all-agent sharing, and retained targets against both management grants", async () => {
    const f = await fixture();
    const connection = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Finish authority", transport: "mcp_remote", authKind: "none", transportConfig: { url: "https://1.1.1.1/mcp" } });
    const path = `/companies/${f.companyId}/tools/apps/${connection.body.id}/finish`;
    const body = { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [f.agentId] } };
    expect(await f.request("POST", path, body)).toMatchObject({ status: 200 });
    await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_profiles")));
    for (const access of [body.access, { agentIds: [] }, "all_agents"]) expect(await f.request("POST", path, { ...body, access })).toMatchObject({ status: 403 });
    await server.db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent", principalId: f.agentId, permissionKey: "tools:manage_profiles", scope: { targetAgentIds: [f.agentId] } });
    expect(await f.request("POST", path, { ...body, access: "all_agents" })).toMatchObject({ status: 403 });
    const [other] = await server.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, f.companyId), eq(agents.name, "Eval agent")));
    const targets = await server.db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, f.companyId));
    const otherId = other?.id ?? targets.find(agent => agent.id !== f.agentId)!.id;
    expect(await f.request("POST", path, { ...body, access: { agentIds: [otherId] } })).toMatchObject({ status: 403 });
    await server.db.update(principalPermissionGrants).set({ scope: null }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_profiles")));
    await server.db.update(principalPermissionGrants).set({ scope: { targetAgentIds: [f.agentId] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    expect(await f.request("POST", path, { ...body, access: { agentIds: [otherId] } })).toMatchObject({ status: 403 });
    const bindings = await server.db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, f.companyId));
    expect(bindings.map(binding => binding.targetId)).toEqual([f.agentId]);
  });

  it.each(["none", "other-agent", "other-agent-no-access", "other-agent-allow-policy", "other-agent-explicit-grant", "other-agent-caller-ask", "other-agent-new-rate", "other-agent-new-shared-rate", "other-agent-new-rate-target-block", "other-agent-caller-rate", "other-agent-shared-rate", "other-agent-credential", "other-agent-credential-none", "other-agent-caller-revoked", "private-status", "agent", "user", "cancelled", "project-block", "rate-limit", "agent-rate-approval", "authorized-policy-edit"] as const)("keeps delegated test policy and approval continuation bounded (%s)", async revocation => {
    const f = await fixture();
    let targetAgentId = f.agentId;
    if (revocation.startsWith("other-agent")) {
      const cookie = await server.humanSession(f.userId);
      const created = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/agents`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test target", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }) });
      const target = await created.json();
      expect(created.status, JSON.stringify(target)).toBe(201);
      targetAgentId = target.id;
      await lifecycle.process(targetAgentId);
      await vi.waitFor(async () => expect((await agentService(server.db).getById(targetAgentId))?.status).toBe("idle"));
    }
    const allowed = revocation === "none" || revocation === "other-agent" || revocation === "other-agent-caller-ask" || ["other-agent-new-rate", "other-agent-new-shared-rate"].includes(revocation);
    let calls = 0;
    const remote = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      let result: unknown;
      if (request.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Fixture", version: "1" } };
      else if (request.method === "tools/call") { calls++; result = { content: [{ type: "text", text: "Fixture result" }] }; }
      else { res.writeHead(req.method === "DELETE" ? 204 : request.method === "notifications/initialized" ? 202 : 405); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    });
    await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not listen");
    const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
    const freezeRateClock = revocation.startsWith("other-agent-new-") || ["other-agent-caller-rate", "other-agent-shared-rate", "rate-limit", "agent-rate-approval"].includes(revocation);
    if (freezeRateClock) vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const created = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Governed test", transport: "mcp_remote", authKind: "none", transportConfig: { url: mcpUrl } });
      await server.db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, created.body.id));
      const [entry] = await server.db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId: created.body.applicationId, connectionId: created.body.id,
        entryKind: "tool", name: "Fixture probe", toolName: "fixture_probe", inputSchema: { type: "object", properties: {} }, riskLevel: "read", isReadOnly: true, status: "active", versionHash: "fixture-v1" }).returning();
      expect(await f.request("POST", `/companies/${f.companyId}/tools/apps/${created.body.id}/finish`, { enabledCatalogEntryIds: [entry.id], access: { agentIds: revocation.startsWith("other-agent") && !["other-agent-no-access", "other-agent-allow-policy", "other-agent-explicit-grant"].includes(revocation) ? [f.agentId, targetAgentId] : [targetAgentId] } })).toMatchObject({ status: 200 });
      const path = `/tool-connections/${created.body.id}/test-calls`;
      const body = { agentId: targetAgentId, runContext: { heartbeatRunId: randomUUID(), issueId: randomUUID(), projectId: randomUUID() }, toolName: "fixture_probe", parameters: {} };
      if (revocation === "other-agent-no-access") {
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Caller cannot use this tool", policyType: "block", selectors: { connectionId: created.body.id, agentId: f.agentId }, priority: 0 });
        for (const token of [f.key.token, f.jwt]) expect(await f.request("POST", path, body, token)).toMatchObject({ status: 200, body: { decision: "off", error: { reasonCode: "deny_policy_block" } } });
        expect(calls).toBe(0);
        return;
      }
      if (revocation === "other-agent-allow-policy" || revocation === "other-agent-explicit-grant") {
        if (revocation === "other-agent-allow-policy") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Caller authorized by policy", policyType: "allow", selectors: { connectionId: created.body.id, agentId: f.agentId }, priority: 0 });
        else await server.db.update(principalPermissionGrants).set({ scope: { connectionId: created.body.id } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:use")));
        const result = await f.request("POST", path, body, f.jwt);
        expect(result, JSON.stringify(result)).toMatchObject({ status: 200, body: { decision: "allowed", result: { content: "Fixture result" } } });
        expect(calls).toBe(1);
        return;
      }
      if (revocation === "other-agent-credential" || revocation === "other-agent-credential-none") {
        await server.db.update(toolConnections).set({ authKind: revocation === "other-agent-credential-none" ? "none" : "api_key", credentialPolicy: "per_agent" }).where(eq(toolConnections.id, created.body.id));
        await server.db.insert(connectionGrants).values([f.agentId, targetAgentId].map(subjectAgentId => ({ companyId: f.companyId, connectionId: created.body.id, kind: "agent" as const, subjectAgentId, status: "active" })));
        expect(await f.request("POST", path, body, f.jwt)).toMatchObject({ status: 403, body: { reasonCode: "test_credential_identity_mismatch" } });
        expect(calls).toBe(0);
        return;
      }
      if (revocation === "other-agent-caller-rate" || revocation === "other-agent-shared-rate") {
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Caller rate", policyType: "rate_limit", selectors: { connectionId: created.body.id, ...(revocation === "other-agent-caller-rate" ? { agentId: f.agentId } : {}) }, config: { limit: 1, windowSeconds: 60, keyBy: revocation === "other-agent-caller-rate" ? ["agent", "tool"] : ["company", "tool"] } });
        const admitted = await f.request("POST", path, body, f.jwt);
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ status: 200, body: { decision: "allowed", result: { content: "Fixture result" } } });
        expect(calls).toBe(1);
        expect(await f.request("POST", path, body, f.jwt)).toMatchObject({ status: 200, body: { decision: "off", error: { reasonCode: "rate_limited" } } });
        expect(calls).toBe(1);
        return;
      }
      for (const selectors of [{ connectionId: created.body.id, projectId: f.projectId }, { connectionId: created.body.id, issueId: f.issueId }]) {
        const [block] = await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Scoped test block", policyType: "block", selectors, priority: 1 }).returning();
        expect(await f.request("POST", path, body, f.jwt)).toMatchObject({ status: 200, body: { decision: "off" } });
        expect(calls).toBe(0);
        await server.db.delete(toolPolicies).where(eq(toolPolicies.id, block.id));
      }
      if (revocation === "rate-limit") {
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "One test per minute", policyType: "rate_limit", selectors: { connectionId: created.body.id }, config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] } });
        expect(await f.request("POST", path, body, f.jwt)).toMatchObject({ status: 200, body: { decision: "allowed", result: { content: "Fixture result" } } });
        expect(calls).toBe(1);
        expect(await f.request("POST", path, body, f.jwt)).toMatchObject({ status: 200, body: { decision: "off", error: { reasonCode: "rate_limited" } } });
        expect(calls).toBe(1);
        return;
      }
      if (revocation === "agent-rate-approval") {
        await server.db.insert(toolPolicies).values([
          { companyId: f.companyId, name: "One admitted call", policyType: "rate_limit", selectors: { connectionId: created.body.id }, priority: 0, config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] } },
          { companyId: f.companyId, name: "Approve admitted call", policyType: "require_approval", selectors: { connectionId: created.body.id }, priority: 1 },
        ]);
        const session = await f.request("POST", "/tool-gateway/sessions", {}, f.jwt);
        expect(session, JSON.stringify(session)).toMatchObject({ status: 201 });
        const gatewayRequest = async (path: string, parameters?: unknown) => {
          const response = await fetch(server.apiUrl + "/api" + path, { method: parameters === undefined ? "GET" : "POST", headers: { "x-paperclip-tool-gateway-token": session.body.token, "Content-Type": "application/json" }, ...(parameters === undefined ? {} : { body: JSON.stringify(parameters) }) });
          return { status: response.status, body: await response.json() };
        };
        const listed = await gatewayRequest("/tool-gateway/tools");
        expect(listed).toMatchObject({ status: 200 });
        const tool = listed.body.find((item: { catalogEntryId: string }) => item.catalogEntryId === entry.id);
        expect(tool, JSON.stringify(listed.body)).toBeTruthy();
        const requested = await gatewayRequest("/tool-gateway/tools/call", { tool: tool.name, parameters: {}, idempotencyKey: "rate-approval" });
        expect(requested, JSON.stringify(requested)).toMatchObject({ status: 409, body: { reasonCode: "approval_required" } });
        expect(calls).toBe(0);
        expect(await f.request("POST", `/tool-gateway/action-requests/${requested.body.actionRequestId}/approve`, { companyId: f.companyId }, f.jwt)).toMatchObject({ status: 403 });
        const cookie = await server.humanSession(f.userId);
        const response = await fetch(`${server.apiUrl}/api/tool-gateway/action-requests/${requested.body.actionRequestId}/approve`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify({ companyId: f.companyId }) });
        expect(response.status, JSON.stringify(await response.json())).toBe(200);
        expect((await server.db.select().from(toolInvocations).where(eq(toolInvocations.id, requested.body.invocationId)))[0].status).toBe("succeeded");
        expect(calls).toBe(1);
        expect(await gatewayRequest("/tool-gateway/tools/call", { tool: tool.name, parameters: { anotherCall: true }, idempotencyKey: "next-rate-approval" })).toMatchObject({ status: 429, body: { reasonCode: "rate_limited" } });
        expect(calls).toBe(1);
        return;
      }
      await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Scoped test approval", policyType: "require_approval", selectors: { connectionId: created.body.id, issueId: f.issueId, ...(revocation === "other-agent-caller-ask" ? { agentId: f.agentId } : {}) }, priority: 1 });
      const pending = await f.request("POST", path, body, f.jwt);
      expect(pending, JSON.stringify(pending)).toMatchObject({ status: 200, body: { decision: "ask_first" } });
      const [saved] = await server.db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.body.invocationId));
      expect(saved).toMatchObject({ runId: f.runId, issueId: f.issueId, actorType: "agent", actorId: f.agentId, agentId: targetAgentId });
      expect(calls).toBe(0);
      if (revocation === "private-status") {
        const statusPath = `${path}/${pending.body.actionRequestId}`;
        expect(await f.request("GET", statusPath)).toMatchObject({ status: 200 });
        const [hidden] = await server.db.insert(issues).values({ companyId: f.companyId, title: "Private test task", visibility: "private", status: "in_progress", responsibleUserId: randomUUID() }).returning();
        await server.db.update(toolInvocations).set({ issueId: hidden.id }).where(eq(toolInvocations.id, saved.id));
        for (const token of [f.key.token, f.jwt]) expect(await f.request("GET", statusPath, undefined, token)).toMatchObject({ status: 403 });
        expect(calls).toBe(0);
        return;
      }
      const approvalPath = `/tool-gateway/action-requests/${pending.body.actionRequestId}/approve`;
      expect(await f.request("POST", approvalPath, { companyId: f.companyId }, f.jwt)).toMatchObject({ status: 403 });
      if (revocation === "authorized-policy-edit") {
        const policiesPath = `/companies/${f.companyId}/tools/policies`;
        const policy = await f.request("POST", policiesPath, { name: "Requested self-targeted access", policyType: "allow", priority: 0,
          selectors: { agentId: f.agentId, connectionId: created.body.id } }, f.jwt);
        expect(policy, JSON.stringify(policy)).toMatchObject({ status: 201 });
        expect(await f.request("POST", path, body, f.jwt)).toMatchObject({ status: 200, body: { decision: "allowed" } });
        expect(calls).toBe(1);
        expect(await f.request("POST", approvalPath, { companyId: f.companyId }, f.jwt)).toMatchObject({ status: 403 });
        await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_profiles")));
        expect(await f.request("PATCH", `${policiesPath}/${policy.body.id}`, { enabled: false }, f.jwt)).toMatchObject({ status: 403 });
        return;
      }
      await server.db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
      if (revocation === "agent") await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:use")));
      if (revocation === "user") for (const permission of ["tools:use", "tools:manage_connections"]) await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, f.companyId), eq(principalPermissionGrants.principalId, f.userId), eq(principalPermissionGrants.permissionKey, permission)));
      if (revocation === "cancelled") await server.db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
      if (revocation === "other-agent-caller-revoked") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Caller access revoked", policyType: "block", selectors: { connectionId: created.body.id, agentId: f.agentId }, priority: 0 });
      if (revocation === "project-block") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New project block", policyType: "block", selectors: { connectionId: created.body.id, projectId: f.projectId }, priority: 0 });
      if (revocation.startsWith("other-agent-new-")) {
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New delegated test admission", policyType: "rate_limit",
          selectors: { connectionId: created.body.id, ...(revocation === "other-agent-new-shared-rate" ? {} : { agentId: f.agentId }) },
          priority: -2, config: { limit: 1, windowSeconds: 60, keyBy: revocation === "other-agent-new-shared-rate" ? ["company", "tool"] : ["agent", "tool"] } });
        if (revocation === "other-agent-new-rate") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New test target admission", policyType: "rate_limit",
          selectors: { connectionId: created.body.id, agentId: targetAgentId }, priority: -2,
          config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] } });
        if (revocation === "other-agent-new-rate-target-block") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New test target block", policyType: "block",
          selectors: { connectionId: created.body.id, agentId: targetAgentId }, priority: -1 });
      }
      const cookie = await server.humanSession(f.userId);
      const approve = () => fetch(server.apiUrl + "/api" + approvalPath, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify({ companyId: f.companyId }) });
      const response = await approve();
      expect(response.status, JSON.stringify(await response.json())).toBe(revocation === "cancelled" ? 409 : 200);
      const [settled] = await server.db.select().from(toolInvocations).where(eq(toolInvocations.id, saved.id));
      if (revocation === "cancelled") expect(settled.status).not.toBe("succeeded");
      else expect(settled, JSON.stringify(settled)).toMatchObject({ status: allowed ? "succeeded" : "failed" });
      expect(calls).toBe(allowed ? 1 : 0);
      if (allowed) { expect((await approve()).status).toBe(200); expect(calls).toBe(1); }
      if (revocation.startsWith("other-agent-new-")) {
        const counters = await server.db.select().from(toolRateLimitCounters).where(eq(toolRateLimitCounters.companyId, f.companyId));
        expect(counters).toHaveLength(allowed ? revocation === "other-agent-new-shared-rate" ? 1 : 2 : 0);
        expect(counters.every(counter => counter.remaining === 0)).toBe(true);
        if (allowed) {
          expect(settled.policyExplanation?.consumedRateAdmissions).toHaveLength(1);
          expect(settled.policyExplanation?.delegatedCallerConsumedRateAdmissions).toHaveLength(1);
          const [nextRun] = await server.db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
            status: "running", responsibleUserId: f.userId, contextSnapshot: { issueId: f.issueId } }).returning();
          const nextJwt = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", nextRun.id, f.userId);
          expect(await f.request("POST", path, body, nextJwt)).toMatchObject({ status: 200, body: { decision: "off", error: { reasonCode: "rate_limited" } } });
          expect(calls).toBe(1);
        }
      }
    } finally { if (freezeRateClock) vi.useRealTimers(); remote.closeAllConnections(); await new Promise<void>((resolve, reject) => remote.close(error => error ? reject(error) : resolve())); }
  });

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
    for (const target of [{ targetType: "project", targetId: f.projectId }, { targetType: "issue", targetId: issue.id }, { targetType: "routine", targetId: routine.id }, { targetType: "gateway", targetId: gateway.body.id }]) {
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
    }) as typeof server.db.select);
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
    expect(new URL(started.body.authorizationUrl).searchParams.get("resume")).toBe(created.body.id);
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

  it("persists meaningful Slack and GitHub endpoint configuration for the responsible user", async () => {
    const f = await fixture();
    for (const provider of ["slack", "github"]) {
      const result = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider, assignedAgentId: f.agentId, name: `${provider} fixture`, ...(provider === "slack" ? { slackSetupMethod: "manual" } : {}) });
      expect(result, JSON.stringify(result)).toMatchObject({ status: 201 });
      if (provider === "slack") {
        const patch = { requireAtMention: true, allowDirectMessages: false };
        const updated = await f.request("PATCH", `/chat-endpoints/${result.body.id}`, patch);
        expect(updated, JSON.stringify(updated)).toMatchObject({ status: 200, body: patch });
      } else {
        const current = await f.request("GET", `/chat-endpoints/${result.body.id}/github/configuration`);
        expect(current, JSON.stringify(current)).toMatchObject({ status: 200 });
        const body = { expectedRevision: current.body.revision, configuration: { ...current.body.configuration, memberAccess: "selected" } };
        const updated = await f.request("PUT", `/chat-endpoints/${result.body.id}/github/configuration`, body);
        expect(updated, JSON.stringify(updated)).toMatchObject({ status: 200, body: { revision: 1, configuration: { memberAccess: "selected" } } });
        expect(await f.request("PUT", `/chat-endpoints/${result.body.id}/github/configuration`, body)).toMatchObject({ status: 409 });
        const handoff = await f.request("POST", `/chat-endpoints/${result.body.id}/github/identity/start`, {});
        expect(handoff).toMatchObject({ status: 200, body: { requiredUserAction: { userId: f.userId, resource: { id: result.body.id } } } });
      }
      expect((await f.request("GET", `/chat-endpoints/${result.body.id}`)).body.sponsorUserId).toBe(f.userId);
    }
  });

  it("configures Slack against provider fixtures and subjects test messages to the normal action policy", async () => {
    const f = await fixture();
    const botId = `U${f.agentId.replaceAll("-", "").toUpperCase()}`;
    const scopes = [...SLACK_CHAT_BOT_SCOPES, ...SLACK_BOT_TOOL_SCOPES];
    let sent = 0;
    let revokeDuringAuth = false;
    provider = async (url, init) => {
      if (url.endsWith("auth.test")) {
        if (revokeDuringAuth) await accessService(server.db).ensureMembership(f.companyId, "user", f.userId, "operator", "suspended");
        return Response.json({ ok: true, team_id: "TFIXTURE", team: "Fixture workspace", user_id: botId, user: "fixture-bot" }, { headers: { "x-oauth-scopes": scopes.join(",") } });
      }
      if (url.includes("conversations.list")) return Response.json({ ok: true, channels: [], response_metadata: { next_cursor: "" } });
      if (url.endsWith("users.info")) return Response.json({ ok: true, user: { id: new URLSearchParams(String(init?.body)).get("user") ?? "UHUMAN", team_id: "TFIXTURE", name: "Fixture user", is_bot: false, deleted: false } });
      if (url.endsWith("chat.postMessage")) { sent++; return Response.json({ ok: true, channel: "DTEST", ts: "1.000001" }); }
      if (url.endsWith("agents.sessions.setStatus")) return Response.json({ ok: true });
      throw new Error(`Unexpected Slack fixture operation: ${new URL(url).pathname}`);
    };
    try {
      const created = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "slack", assignedAgentId: f.agentId, slackSetupMethod: "manual" });
      const setupPath = `/chat-endpoints/${created.body.id}/setup`;
      const cookie = await server.humanSession(f.userId);
      const configuredResponse = await fetch(server.apiUrl + "/api" + setupPath, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "configure", credentials: { botToken: "xoxb-fixture-token", signingSecret: "fixture-signing-secret" } }) });
      const configured = { status: configuredResponse.status, body: await configuredResponse.json() };
      expect(configured, JSON.stringify(configured)).toMatchObject({ status: 200 });
      expect(JSON.stringify(configured.body)).not.toContain("xoxb-fixture-token");
      const [configuredEndpoint] = await server.db.select().from(chatEndpoints).where(eq(chatEndpoints.id, created.body.id));
      await server.db.update(chatEndpoints).set({ status: "active", setup: { ...configuredEndpoint.setup, step: "complete", webhookVerifiedAt: new Date().toISOString() } }).where(eq(chatEndpoints.id, created.body.id));
      const [before] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      const botTokenRef = before.credentialSecretRefs.find(ref => ref.configPath === "credentials.botToken")!;
      const rebound = before.credentialSecretRefs.map(ref => ref.configPath === "credentials.signingSecret" ? { ...ref, secretId: botTokenRef.secretId } : ref);
      expect(await f.request("PATCH", `/tool-connections/${created.body.connectionId}`, { credentialSecretRefs: rebound }, f.jwt))
        .toMatchObject({ status: 403, body: { code: "chat_endpoint_credentials_require_setup" } });
      let credentialIntentId: string | undefined;
      for (const action of ["reconnect", "configure"] as const) for (const token of [f.key.token, f.jwt]) {
        const chosen = "agent-chosen-webhook-key";
        const handoff = await f.request("POST", setupPath, { action, credentials: { signingSecret: chosen } }, token);
        expect(handoff, JSON.stringify(handoff)).toMatchObject({ status: 200, body: { status: "needs_user_action", endpointId: created.body.id,
          requiredUserAction: { kind: "enter_credentials", userId: f.userId, resource: { id: created.body.id } } } });
        expect(JSON.stringify(handoff.body)).not.toContain(chosen);
        expect(handoff.body.requiredUserAction.setupPath).toContain("stage=credentials&reconnect=1");
        const entryLink = new URL(handoff.body.requiredUserAction.setupPath, server.apiUrl);
        expect.soft(entryLink.searchParams.get("credentialFields")).toBe("signingSecret");
        expect.soft(entryLink.searchParams.get("credentialMode")).toBe("all");
        if (token === f.jwt) {
          if (credentialIntentId) expect(handoff.body.interactionId).toBe(credentialIntentId);
          credentialIntentId = handoff.body.interactionId;
        }
        const [after] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
        expect(after.credentialSecretRefs).toEqual(before.credentialSecretRefs);
        const signing = after.credentialSecretRefs.find(ref => ref.configPath === "credentials.signingSecret")!;
        expect(await secretService(server.db).resolveSecretValue(f.companyId, signing.secretId, "latest", {
          accessContext: { consumerType: "system", consumerId: "integration-fixture", actorType: "system" },
        })).toBe("fixture-signing-secret");
      }
      const [credentialIntent] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, credentialIntentId!));
      const [task] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
      const entryProof = (credentialIntent.payload as { savedSetup: { credentialEntry: { previousGenerations: Record<string, string>; requireAll: boolean } } }).savedSetup.credentialEntry;
      expect(entryProof).toEqual({ previousGenerations: { signingSecret: expect.any(String) }, requireAll: true });
      expect(await findSatisfiedToolConnection(server.db, task, credentialIntent)).toBeNull();
      await satisfiedConnectionIntentService(server.db).sweepPending();
      expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, credentialIntentId!)))[0].status).toBe("pending");
      // Ordinary write-only bot-token repair remains delegated under current authority.
      expect(await f.request("POST", setupPath, { action: "reconnect", credentials: { botToken: "xoxb-fixture-token" } }, f.jwt)).toMatchObject({ status: 200, body: { id: created.body.id } });
      const healthy = async () => {
        await server.db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, created.body.id));
        await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
      };
      await healthy();
      expect(await findSatisfiedToolConnection(server.db, task, credentialIntent)).toBeNull();
      const humanReconnect = async (signingSecret: string) => {
        const response = await fetch(server.apiUrl + "/api" + setupPath, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reconnect", credentials: { signingSecret, botToken: "xoxb-fixture-token" } }) });
        expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 200 });
      };
      await humanReconnect("fixture-signing-secret");
      await healthy();
      expect(await findSatisfiedToolConnection(server.db, task, credentialIntent)).toBeNull();
      await humanReconnect("human-replacement-signing-secret");
      expect(await findSatisfiedToolConnection(server.db, task, credentialIntent)).toBeNull();
      const resumedRequest = await f.request("POST", setupPath, { action: "reconnect", credentials: { signingSecret: "agent-chosen-webhook-key" } }, f.jwt);
      expect(resumedRequest.body.interactionId).toBe(credentialIntentId);
      expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, credentialIntentId!)))[0].payload)
        .toMatchObject({ savedSetup: { credentialEntry: entryProof } });
      await healthy();
      expect(await findSatisfiedToolConnection(server.db, task, credentialIntent)).toBeNull();
      const [repaired] = await server.db.select().from(chatEndpoints).where(eq(chatEndpoints.id, created.body.id));
      await server.db.update(chatEndpoints).set({ setup: { ...repaired.setup, webhookVerifiedAt: new Date().toISOString() } }).where(eq(chatEndpoints.id, created.body.id));
      expect((await findSatisfiedToolConnection(server.db, task, credentialIntent))?.id).toBe(created.body.connectionId);
      expect(await findSatisfiedToolConnection(server.db, { ...task, status: "cancelled" }, credentialIntent)).toBeNull();
      await accessService(server.db).ensureMembership(f.companyId, "user", f.userId, "operator", "suspended");
      expect(await findSatisfiedToolConnection(server.db, task, credentialIntent)).toBeNull();
      await accessService(server.db).ensureMembership(f.companyId, "user", f.userId, "operator", "active");
      await satisfiedConnectionIntentService(server.db).sweepPending();
      expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, credentialIntentId!)))[0].status).toBe("expired");
      // Replacing complete credentials repairs unavailable old vault material.
      for (const state of ["disabled", "deleted", "unreadable"] as const) {
        const [connection] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
        const signing = connection.credentialSecretRefs.find(ref => ref.configPath === "credentials.signingSecret")!;
        if (state === "unreadable") {
          await server.db.update(companySecrets).set({ status: "active" }).where(eq(companySecrets.id, signing.secretId));
          await server.db.update(companySecretVersions).set({ material: {} }).where(eq(companySecretVersions.secretId, signing.secretId));
        } else {
          await server.db.update(companySecrets).set({ status: state }).where(eq(companySecrets.id, signing.secretId));
        }
        const response = await fetch(server.apiUrl + "/api" + setupPath, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reconnect", credentials: { signingSecret: `human-repair-${state}`, botToken: "xoxb-fixture-token" } }) });
        expect.soft({ status: response.status, body: await response.json() }, `repair ${state} signing secret`).toMatchObject({ status: 200 });
        if (response.status === 200) {
          const [current] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
          const replacement = current.credentialSecretRefs.find(ref => ref.configPath === "credentials.signingSecret")!;
          expect(replacement.secretId).not.toBe(signing.secretId);
          expect(await secretService(server.db).resolveSecretValue(f.companyId, replacement.secretId, "latest", {
            accessContext: { consumerType: "system", consumerId: "integration-fixture", actorType: "system" },
          })).toBe(`human-repair-${state}`);
        }
      }
      // Unexpected resolver failures must abort before writing new references.
      const [beforeFault] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      const resolverFault = vi.spyOn(localEncryptedProvider, "resolveVersion").mockRejectedValue(new Error("Unexpected secret resolution failure"));
      try {
        const response = await fetch(server.apiUrl + "/api" + setupPath, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "reconnect", credentials: { signingSecret: "human-repair-unexpected", botToken: "xoxb-fixture-token" } }) });
        expect(response.status).toBe(500);
        expect((await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId)))[0].credentialSecretRefs).toEqual(beforeFault.credentialSecretRefs);
      } finally { resolverFault.mockRestore(); }
      // Identity is a provider fixture; production HTTP admission and policy remain real.
      const [principal] = await server.db.insert(chatExternalPrincipals).values({ companyId: f.companyId, provider: "slack", providerAccountId: "TFIXTURE", externalId: "UHUMAN", isBot: false }).returning();
      await server.db.insert(chatIdentityLinks).values({ companyId: f.companyId, endpointId: created.body.id, principalId: principal.id, paperclipUserId: f.userId, status: "linked", confirmedAt: new Date() });
      await server.db.update(chatEndpoints).set({ status: "active", allowDirectMessages: true }).where(eq(chatEndpoints.id, created.body.id));
      const [deny] = await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Test messages off", policyType: "block", selectors: { connectionId: created.body.connectionId }, priority: 1 }).returning();
      const testPath = `/chat-endpoints/${created.body.id}/slack/test-message`;
      const denied = await f.request("POST", testPath, { requestId: randomUUID() });
      expect(denied, JSON.stringify(denied)).toMatchObject({ status: 403 });
      expect(sent).toBe(0);
      await server.db.update(toolPolicies).set({ policyType: "allow" }).where(eq(toolPolicies.id, deny.id));
      vi.useFakeTimers({ toFake: ["Date"] });
      await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "One Slack setup send", policyType: "rate_limit", selectors: { connectionId: created.body.connectionId }, priority: 0, config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] } });
      const requestId = randomUUID();
      const tested = await f.request("POST", testPath, { requestId });
      expect(tested, JSON.stringify(tested)).toMatchObject({ status: 200, body: { status: "sent" } });
      expect(await f.request("POST", testPath, { requestId })).toMatchObject({ status: 200 });
      expect(await f.request("POST", testPath, { requestId: randomUUID() })).toMatchObject({ status: 403, body: { details: { reasonCode: "rate_limited" } } });
      expect(await f.request("POST", testPath, { requestId: randomUUID(), slackUserId: "UOTHER" })).toMatchObject({ status: 403 });
      expect(sent).toBe(1);
      vi.useRealTimers();
      const [beforeRevocation] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      revokeDuringAuth = true;
      expect(await f.request("POST", setupPath, { action: "reconnect", credentials: { botToken: "xoxb-fixture-token" } }, f.jwt)).toMatchObject({ status: 403 });
      expect((await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId)))[0].credentialSecretRefs)
        .toEqual(beforeRevocation.credentialSecretRefs);
    } finally { vi.useRealTimers(); provider = null; }
  });

  it.each(["linked", "invitation"] as const)("checks caller and target policy for delegated Slack %s sends", async recipient => {
    for (const mode of ["caller-block", "caller-ask", "caller-rate", "target-block", "target-rate", "shared-rate"] as const) {
      const f = await fixture();
      const cookie = await server.humanSession(f.userId);
      const targetResponse = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/agents`, {
        method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Slack target", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" },
          permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }),
      });
      const target = await targetResponse.json();
      expect(targetResponse.status, JSON.stringify(target)).toBe(201);
      await lifecycle.process(target.id);
      await vi.waitFor(async () => expect((await agentService(server.db).getById(target.id))?.status).toBe("idle"));
      let sends = 0;
      const workspaceId = `T${f.companyId.replaceAll("-", "").toUpperCase()}`;
      const scopes = [...SLACK_CHAT_BOT_SCOPES, ...SLACK_BOT_TOOL_SCOPES];
      provider = async (url, init) => {
        if (url.endsWith("auth.test")) return Response.json({ ok: true, team_id: workspaceId, team: "Delegated fixture", user_id: `U${target.id.replaceAll("-", "").toUpperCase()}`, user: "fixture-bot" }, { headers: { "x-oauth-scopes": scopes.join(",") } });
        if (url.includes("conversations.list")) return Response.json({ ok: true, channels: [], response_metadata: { next_cursor: "" } });
        if (url.endsWith("users.info")) return Response.json({ ok: true, user: { id: new URLSearchParams(String(init?.body)).get("user"), team_id: workspaceId, name: "Fixture user", is_bot: false, deleted: false } });
        if (url.endsWith("chat.postMessage")) { sends++; return Response.json({ ok: true, channel: "DTEST", ts: "1.000001" }); }
        if (url.endsWith("agents.sessions.setStatus")) return Response.json({ ok: true });
        throw new Error(`Unexpected Slack fixture operation: ${new URL(url).pathname}`);
      };
      try {
        const created = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "slack", assignedAgentId: target.id, slackSetupMethod: "manual" });
        expect(created, JSON.stringify(created)).toMatchObject({ status: 201 });
        const configured = await fetch(`${server.apiUrl}/api/chat-endpoints/${created.body.id}/setup`, {
          method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "configure", credentials: { botToken: `xoxb-${target.id}`, signingSecret: "fixture-signing-secret" } }),
        });
        expect({ status: configured.status, body: await configured.json() }).toMatchObject({ status: 200 });
        await server.db.update(chatEndpoints).set({ status: "active", allowDirectMessages: true }).where(eq(chatEndpoints.id, created.body.id));
        await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
        if (recipient === "linked") {
          const [principal] = await server.db.insert(chatExternalPrincipals).values({ companyId: f.companyId, provider: "slack", providerAccountId: workspaceId, externalId: "UHUMAN", isBot: false }).returning();
          await server.db.insert(chatIdentityLinks).values({ companyId: f.companyId, endpointId: created.body.id, principalId: principal.id, paperclipUserId: f.userId, status: "linked", confirmedAt: new Date() });
        }
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Slack fixture access", policyType: "allow", selectors: { connectionId: created.body.connectionId }, priority: 2 });
        const rate = mode.endsWith("rate");
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: mode, policyType: rate ? "rate_limit" : mode === "caller-ask" ? "require_approval" : "block",
          selectors: { connectionId: created.body.connectionId, ...(mode === "shared-rate" ? {} : { agentId: mode.startsWith("caller") ? f.agentId : target.id }) }, priority: 0,
          ...(rate ? { config: { limit: 1, windowSeconds: 60, keyBy: mode === "shared-rate" ? ["company", "tool"] : ["agent", "tool"] } } : {}),
        });
        const path = `/chat-endpoints/${created.body.id}/slack/test-message`;
        if (rate) {
          // Keep both calls in one rate window even when CI crosses a minute boundary.
          vi.useFakeTimers({ toFake: ["Date"] });
          // Shared buckets admit one actual send, while each principal's own
          // limit also prevents the next send. Neither may consume twice.
          expect(await f.request("POST", path, { requestId: randomUUID(), slackUserId: "UHUMAN" }, f.jwt), mode)
            .toMatchObject({ status: 200, body: { status: recipient === "linked" ? "sent" : "connection_pending" } });
          expect(sends, mode).toBe(1);
        }
        for (const token of [f.key.token, f.jwt]) {
          const denied = await f.request("POST", path, { requestId: randomUUID(), slackUserId: "UHUMAN" }, token);
          expect(denied, `${mode}: ${JSON.stringify(denied)}`).toMatchObject({ status: 403, body: { details: { reasonCode: rate ? "rate_limited" : mode === "caller-ask" ? "requires_approval_policy" : "deny_policy_block" } } });
          if (mode === "caller-ask") expect(denied.body.details.requiredUserAction).toMatchObject({ kind: "approve" });
        }
        expect(sends, mode).toBe(rate ? 1 : 0);
        const audit = await server.db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, f.companyId));
        expect(audit.some(event => event.details.agentId === f.agentId && event.actorId === f.agentId), mode).toBe(true);
      } finally { vi.useRealTimers(); provider = null; }
    }
  }, 90_000);

  it("imports a GitHub App and discovers repositories against provider fixtures", async () => {
    const f = await fixture();
    const permissions = { contents: "read", issues: "write", metadata: "read", pull_requests: "write" };
    const appId = 100000 + Number.parseInt(f.agentId.slice(0, 6), 16);
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    provider = async (url, init) => {
      const path = new URL(url).pathname;
      if (path === "/login/oauth/access_token") return Response.json({ access_token: "fixture-personal-token" });
      if (path === "/user") return Response.json({ id: 1357, login: "fixture-person" });
      if (path === "/user/installations") return Response.json({ installations: [{ id: 2468, app_id: appId }] });
      if (path === "/app") return Response.json({ id: appId, slug: `fixture-${f.agentId.slice(0, 8)}`, name: "Fixture App", owner: { login: "fixture" }, permissions,
        events: ["pull_request", "github_app_authorization", "installation", "installation_repositories", "issue_comment", "pull_request_review_comment"] });
      if (path === "/app/hook/config") return Response.json(init?.body ? JSON.parse(String(init.body)) : { url: "https://paperclip.fixture.invalid", content_type: "json", insecure_ssl: "0" });
      if (path === "/app/installations") return Response.json([{ id: 2468, account: { id: 1357, login: "fixture", type: "Organization" }, permissions, suspended_at: null }]);
      if (path === "/app/installations/2468") return Response.json({ permissions, suspended_at: null });
      if (path === "/app/installations/2468/access_tokens") return Response.json({ token: "fixture-installation-token" }, { status: 201 });
      if (path === "/installation/repositories") return Response.json({ repositories: [{ id: 42, name: "repo", full_name: "fixture/repo", private: true, owner: { login: "fixture" }, html_url: "https://github.com/fixture/repo" }] });
      throw new Error(`Unexpected GitHub fixture operation: ${path}`);
    };
    try {
      const created = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "github", assignedAgentId: f.agentId });
      expect(await f.request("POST", `/chat-endpoints/${created.body.id}/github/registration`, { name: `fixture-${f.agentId.slice(0, 8)}` })).toMatchObject({ status: 200 });
      const cookie = await server.humanSession(f.userId);
      const humanRequest = (path: string, method = "GET", body?: unknown, session = cookie) => fetch(server.apiUrl + path, {
        method, redirect: "manual", headers: { cookie: session, "Content-Type": "application/json", origin: server.apiUrl },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const appCredentials = { appId: String(appId), privateKey, webhookSecret: "fixture-webhook-secret", clientId: "fixture-client", clientSecret: "fixture-secret" };
      expect(await f.request("POST", `/chat-endpoints/${created.body.id}/github/app`, appCredentials)).toMatchObject({ status: 200, body: { status: "needs_user_action" } });
      const importHandoff = await f.request("POST", `/chat-endpoints/${created.body.id}/github/app`, {}, f.jwt);
      expect(importHandoff).toMatchObject({ status: 200, body: { requiredUserAction: { kind: "enter_credentials", userId: f.userId } } });
      expect.soft(importHandoff.body.requiredUserAction.setupPath).toContain("stage=credentials");
      expect.soft(importHandoff.body.requiredUserAction.setupPath).not.toContain("reconnect=1");
      const privateKeyHandoff = await f.request("POST", `/chat-endpoints/${created.body.id}/setup`, { action: "configure", credentials: { privateKey } }, f.jwt);
      expect.soft(privateKeyHandoff, JSON.stringify(privateKeyHandoff)).toMatchObject({ status: 200, body: { requiredUserAction: { kind: "enter_credentials" } } });
      if (privateKeyHandoff.status === 200) {
        const entryLink = new URL(privateKeyHandoff.body.requiredUserAction.setupPath, server.apiUrl);
        expect.soft(entryLink.searchParams.get("credentialFields")).toBe("privateKey");
        expect.soft(entryLink.searchParams.get("credentialMode")).toBe("all");
        expect(privateKeyHandoff.body.interactionId).not.toBe(importHandoff.body.interactionId);
        const retry = await f.request("POST", `/chat-endpoints/${created.body.id}/setup`, { action: "configure", credentials: { privateKey } }, f.jwt);
        expect(retry.body.interactionId).toBe(privateKeyHandoff.body.interactionId);
      }
      expect((await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId)))[0].credentialSecretRefs).toEqual([]);
      const imported = await humanRequest(`/api/chat-endpoints/${created.body.id}/github/app`, "POST", appCredentials);
      expect(imported.status).toBe(200);
      expect(JSON.stringify(await imported.json())).not.toContain("PRIVATE KEY");
      const refreshed = await f.request("POST", `/chat-endpoints/${created.body.id}/github/repositories/refresh`, {});
      expect(refreshed, JSON.stringify(refreshed)).toMatchObject({ status: 200 });
      expect(JSON.stringify(refreshed.body)).toContain("fixture/repo");
      expect(await f.request("POST", `/chat-endpoints/${created.body.id}/github/verify`, {})).toMatchObject({ status: 200 });
      await server.db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, created.body.id));
      await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
      const identityHandoff = await f.request("POST", `/chat-endpoints/${created.body.id}/github/identity/start`, {}, f.jwt);
      expect(identityHandoff).toMatchObject({ status: 200, body: { requiredUserAction: { kind: "confirm_identity" } } });
      const [identityIntent] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, identityHandoff.body.interactionId));
      const [identityTask] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(await findSatisfiedToolConnection(server.db, identityTask, identityIntent)).toBeNull();
      const start = await humanRequest(`/api/chat-endpoints/${created.body.id}/github/identity/start`, "POST", {});
      const started = await start.json();
      expect(started, JSON.stringify(started)).toHaveProperty("authorizationUrl");
      const state = new URL(started.authorizationUrl).searchParams.get("state")!;
      const callback = `/api/chat-github/identity/callback?state=${encodeURIComponent(state)}&code=fixture-code`;
      const other = await fixture();
      const otherCookie = await server.humanSession(other.userId);
      expect((await humanRequest(callback, "GET", undefined, otherCookie)).status).toBe(403);
      expect((await humanRequest(callback)).status).toBe(303);
      expect((await humanRequest(callback)).status).toBe(403);
      expect(await findSatisfiedToolConnection(server.db, identityTask, identityIntent)).toBeNull();
      const confirmed = await humanRequest(`/api/chat-endpoints/${created.body.id}/github/identity/confirm`, "POST", { githubUserId: "1357" });
      expect(confirmed.status, JSON.stringify(await confirmed.json())).toBe(200);
      const [endpoint] = await server.db.select().from(chatEndpoints).where(eq(chatEndpoints.id, created.body.id));
      await server.db.update(chatEndpoints).set({ status: "active", setup: { ...endpoint.setup, webhookVerifiedAt: new Date().toISOString() } }).where(eq(chatEndpoints.id, endpoint.id));
      await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
      expect((await findSatisfiedToolConnection(server.db, identityTask, identityIntent))?.id).toBe(created.body.connectionId);
      const credentialHandoff = await f.request("POST", `/chat-endpoints/${created.body.id}/setup`, { action: "reconnect", credentials: { webhookSecret: "agent-chosen-key" } }, f.jwt);
      expect(credentialHandoff).toMatchObject({ status: 200, body: { requiredUserAction: { kind: "enter_credentials" } } });
      const entryLink = new URL(credentialHandoff.body.requiredUserAction.setupPath, server.apiUrl);
      expect(entryLink.searchParams.get("reconnect")).toBe("1");
      expect.soft(entryLink.searchParams.get("credentialFields")).toBe("webhookSecret");
      expect.soft(entryLink.searchParams.get("credentialMode")).toBe("all");
      const entryOptionsResponse = await humanRequest(`/api/connection-intents/${credentialHandoff.body.interactionId}/setup-options`);
      const entryOptions = await entryOptionsResponse.json();
      expect.soft(entryOptions.chatSetup.path).toBe(credentialHandoff.body.requiredUserAction.setupPath);
      const [entryIntent] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, credentialHandoff.body.interactionId));
      const [entryTask] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(await findSatisfiedToolConnection(server.db, entryTask, entryIntent)).toBeNull();
      const repairedResponse = await humanRequest(`/api/chat-endpoints/${created.body.id}/setup`, "POST", { action: "reconnect", credentials: { webhookSecret: "human-replacement-webhook" } });
      expect(repairedResponse.status).toBe(200);
      const [repairedConnection] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      for (const [field, value] of [["privateKey", privateKey], ["clientSecret", "fixture-secret"], ["webhookSecret", "human-replacement-webhook"]]) {
        const ref = repairedConnection.credentialSecretRefs.find(ref => ref.configPath === `credentials.${field}`)!;
        expect(await secretService(server.db).resolveSecretValue(f.companyId, ref.secretId, "latest", {
          accessContext: { consumerType: "system", consumerId: "integration-fixture", actorType: "system" },
        })).toBe(value);
      }
      expect(await findSatisfiedToolConnection(server.db, entryTask, entryIntent)).toBeNull();
      const [repairedEndpoint] = await server.db.select().from(chatEndpoints).where(eq(chatEndpoints.id, created.body.id));
      expect(repairedEndpoint.setup.webhookVerifiedAt).toBeNull();
      await server.db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, created.body.id));
      await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
      expect(await findSatisfiedToolConnection(server.db, entryTask, entryIntent)).toBeNull();
      await server.db.update(chatEndpoints).set({ setup: { ...repairedEndpoint.setup, webhookVerifiedAt: new Date().toISOString() } }).where(eq(chatEndpoints.id, created.body.id));
      expect((await findSatisfiedToolConnection(server.db, entryTask, entryIntent))?.id).toBe(created.body.connectionId);
      const [beforeRotation] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      let rotationIntentId = "";
      for (const token of [f.key.token, f.jwt, f.jwt]) {
        const rotation = await f.request("POST", `/chat-endpoints/${created.body.id}/setup-secret`, {}, token);
        expect(rotation, JSON.stringify(rotation)).toMatchObject({ status: 200, body: { status: "needs_user_action", endpointId: created.body.id,
          requiredUserAction: { kind: "enter_credentials", userId: f.userId } } });
        expect(rotation.body).not.toHaveProperty("webhookSecret");
        expect(rotation.body.requiredUserAction.setupPath).toContain("stage=credentials&reconnect=1&rotateSecret=1");
        if (token === f.jwt) {
          if (rotationIntentId) expect(rotation.body.interactionId).toBe(rotationIntentId);
          rotationIntentId = rotation.body.interactionId;
        }
      }
      expect(rotationIntentId).not.toBe(importHandoff.body.interactionId);
      const [afterRotation] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      expect(afterRotation.credentialSecretRefs).toEqual(beforeRotation.credentialSecretRefs);
      const [rotationIntent] = await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, rotationIntentId));
      const [task] = await server.db.select().from(issues).where(eq(issues.id, f.issueId));
      const setupOptions = await humanRequest(`/api/connection-intents/${rotationIntentId}/setup-options`);
      expect(setupOptions.status).toBe(200);
      expect((await setupOptions.json()).chatSetup.path).toContain("stage=credentials&reconnect=1&rotateSecret=1");
      expect(await findSatisfiedToolConnection(server.db, task, rotationIntent)).toBeNull();
      await satisfiedConnectionIntentService(server.db).sweepPending();
      expect((await server.db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, rotationIntentId)))[0].status).toBe("pending");
      const humanRotation = await humanRequest(`/api/chat-endpoints/${created.body.id}/setup-secret`, "POST", {});
      expect(humanRotation.status).toBe(201);
      const generatedRotation = await humanRotation.json();
      expect(generatedRotation).toMatchObject({ webhookSecret: expect.stringMatching(/^[a-f0-9]{64}$/), credentialRotationId: expect.any(String) });
      const [humanRotated] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.connectionId));
      expect(humanRotated.credentialSecretRefs).not.toEqual(beforeRotation.credentialSecretRefs);
      const rotationState = await f.request("GET", `/chat-endpoints/${endpoint.id}`);
      expect(rotationState.body.setup).toMatchObject({ credentialRotationId: expect.any(String), webhookVerifiedAt: null });
      expect(rotationState.body.setup.credentialRotationId).toBe(generatedRotation.credentialRotationId);
      const nextRotation = await f.request("POST", `/chat-endpoints/${endpoint.id}/setup-secret`, {});
      expect(nextRotation.body.requiredUserAction.setupPath).toContain(`afterRotationId=${rotationState.body.setup.credentialRotationId}`);
      expect(await findSatisfiedToolConnection(server.db, task, rotationIntent)).toBeNull();
      // Provider-fixture states separate restored health from new webhook verification.
      const [rotatedEndpoint] = await server.db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id));
      await server.db.update(chatEndpoints).set({ status: "active" }).where(eq(chatEndpoints.id, endpoint.id));
      await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "healthy" }).where(eq(toolConnections.id, created.body.connectionId));
      expect(await findSatisfiedToolConnection(server.db, task, rotationIntent)).toBeNull();
      await server.db.update(chatEndpoints).set({ setup: { ...rotatedEndpoint.setup, webhookVerifiedAt: new Date().toISOString() } }).where(eq(chatEndpoints.id, endpoint.id));
      expect((await findSatisfiedToolConnection(server.db, task, rotationIntent))?.id).toBe(created.body.connectionId);
    } finally { provider = null; }
  });

  it("creates an email account through the API without exposing its write-only credential and reuses retries", async () => {
    const f = await fixture();
    provider = async url => {
      if (new URL(url).pathname === "/v0/auth/me") return Response.json({ scope_type: "organization", organization_id: "fixture-org" });
      throw new Error(`Unexpected AgentMail fixture operation: ${new URL(url).pathname}`);
    };
    try {
      const body = { apiKey: "fixture-agentmail-secret", grantKind: "user", agentIds: [f.agentId], allAgents: false, idempotencyKey: randomUUID() };
      const created = await f.request("POST", `/companies/${f.companyId}/email/connections`, body);
      expect(created, JSON.stringify(created)).toMatchObject({ status: 201 });
      expect(JSON.stringify(created.body)).not.toContain(body.apiKey);
      expect(await f.request("POST", `/companies/${f.companyId}/email/connections`, body)).toMatchObject({ status: 201, body: { id: created.body.id } });
      expect((await f.request("GET", `/companies/${f.companyId}/email/connections`)).body).toEqual(expect.arrayContaining([expect.objectContaining({ id: created.body.id })]));
      const [saved] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.id));
      expect(saved.createdByUserId).toBe(f.userId);
      const other = await f.request("POST", `/companies/${f.companyId}/email/connections`, { ...body, apiKey: "other-agentmail-secret", grantKind: "organization", idempotencyKey: randomUUID() });
      expect(other).toMatchObject({ status: 201 });
      await server.db.update(principalPermissionGrants).set({ scope: { connectionIds: [created.body.id] } }).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
      for (const token of [f.key.token, f.jwt]) {
        const listed = await f.request("GET", `/companies/${f.companyId}/email/connections?connectionId=${created.body.id}`, undefined, token);
        expect(listed, JSON.stringify(listed)).toMatchObject({ status: 200 });
        expect(listed.body.map((account: { id: string }) => account.id)).toEqual([created.body.id]);
      }
    } finally { provider = null; }
  });

  it("shares tool-activity authorization by task and reuses run identity within one page", async () => {
    const f = await fixture();
    const connection = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Activity page", transport: "mcp_remote", authKind: "none", transportConfig: { url: "https://1.1.1.1/mcp" } });
    expect(connection).toMatchObject({ status: 201 });
    const [hidden] = await server.db.insert(issues).values({ companyId: f.companyId, title: "Private activity task", visibility: "private", status: "in_progress", responsibleUserId: randomUUID() }).returning();
    await server.db.insert(toolCallEvents).values(Array.from({ length: 100 }, (_, index) => ({ companyId: f.companyId, connectionId: connection.body.id,
      eventType: "policy_decision" as const, actorType: "agent", actorId: f.agentId, issueId: index % 2 ? f.issueId : hidden.id, toolName: index % 2 ? "visible" : "private_activity" })));
    const original = connectionManagementModule.connectionManagementService;
    const checked: string[] = [];
    const authorization = vi.spyOn(connectionManagementModule, "connectionManagementService").mockImplementation((db) => {
      const service = original(db);
      return { ...service, capability: async (...args: Parameters<typeof service.capability>) => {
        if (args[1] === "connections:audit") checked.push(args[2].issueId ?? "unbound");
        return service.capability(...args);
      } };
    });
    const capture = vi.spyOn(runIdentity, "captureRunIdentity");
    try {
      const path = `/tool-connections/${connection.body.id}/activity?limit=100`;
      const result = await f.request("GET", path, undefined, f.jwt);
      expect(result, JSON.stringify(result)).toMatchObject({ status: 200 });
      expect(result.body.events).toHaveLength(50);
      expect(JSON.stringify(result.body)).not.toContain("private_activity");
      expect(checked, JSON.stringify({ checks: checked.length, captures: capture.mock.calls.length })).toHaveLength(2);
      expect(capture.mock.calls.length).toBeGreaterThan(0);
      expect(capture.mock.calls.length).toBeLessThanOrEqual(2);
      await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:view_audit")));
      expect(await f.request("GET", path, undefined, f.jwt)).toMatchObject({ status: 403 });
    } finally { authorization.mockRestore(); capture.mockRestore(); }
  });

  it("bounds activity authorization to the requested page rather than endpoint history", async () => {
    const f = await fixture();
    const endpoint = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "github", assignedAgentId: f.agentId });
    expect(endpoint).toMatchObject({ status: 201 });
    const conversations = await server.db.insert(chatConversations).values(Array.from({ length: 200 }, (_, index) => ({
      companyId: f.companyId, endpointId: endpoint.body.id, issueId: f.issueId,
      externalConversationId: `history-${index}`, externalLabel: `History ${index}`,
    }))).returning();
    const [delivery] = await server.db.insert(chatDeliveries).values({ companyId: f.companyId, endpointId: endpoint.body.id,
      conversationId: conversations[0].id, providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "mention", state: "processed", normalizedEvent: {} }).returning();
    const original = connectionManagementModule.connectionManagementService;
    const checked: string[] = [];
    const authorization = vi.spyOn(connectionManagementModule, "connectionManagementService").mockImplementation((db) => {
      const service = original(db);
      return { ...service, capability: async (...args: Parameters<typeof service.capability>) => {
        if (args[1] === "connections:audit") checked.push(args[2].issueId ?? "unbound");
        return service.capability(...args);
      } };
    });
    try {
      const result = await f.request("GET", `/chat-endpoints/${endpoint.body.id}/activity?limit=1`, undefined, f.jwt);
      expect(result, JSON.stringify(result)).toMatchObject({ status: 200, body: { items: [expect.objectContaining({ id: delivery.id })] } });
      expect(checked).toEqual([f.issueId]);
    } finally { authorization.mockRestore(); }
  });

  it("continues activity pagination through private-only windows", async () => {
    const f = await fixture();
    const endpoint = await f.request("POST", `/companies/${f.companyId}/chat-endpoints`, { provider: "github", assignedAgentId: f.agentId });
    const [hidden] = await server.db.insert(issues).values({ companyId: f.companyId, title: "Private history", visibility: "private", status: "in_progress", responsibleUserId: randomUUID() }).returning();
    const conversations = await server.db.insert(chatConversations).values([f.issueId, hidden.id].map(issueId => ({ companyId: f.companyId, endpointId: endpoint.body.id, issueId,
      externalConversationId: randomUUID(), externalLabel: "History" }))).returning();
    const rows = Array.from({ length: 30 }, (_, index) => ({ id: `${f.agentId.slice(0, 24)}${index.toString(16).padStart(12, "0")}`,
      companyId: f.companyId, endpointId: endpoint.body.id, conversationId: conversations[index < 3 ? 0 : 1].id,
      providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: index < 3 ? "readable_history" : "private_history", state: "processed", normalizedEvent: {}, createdAt: new Date("2026-10-25T12:00:00.000Z") }));
    await server.db.insert(chatDeliveries).values(rows);
    const path = `/chat-endpoints/${endpoint.body.id}/activity?limit=25`;
    const first = await f.request("GET", path, undefined, f.jwt);
    expect(first).toMatchObject({ status: 200, body: { items: [], nextCursor: expect.any(String) } });
    expect(JSON.stringify(first.body)).not.toContain("private_history");
    const second = await f.request("GET", `${path}&cursor=${encodeURIComponent(first.body.nextCursor)}`, undefined, f.jwt);
    expect(second).toMatchObject({ status: 200, body: { items: rows.slice(0, 3).reverse().map(row => expect.objectContaining({ id: row.id })), nextCursor: null } });
    expect(JSON.stringify(second.body)).not.toContain("private_history");
  });

  it("saves delegated Arcade discovery for the responsible user and shares its inventory with that user", async () => {
    const f = await fixture();
    const transport = vi.spyOn(remoteHttpFetch, "guardedRemoteHttpFetch").mockImplementation(async (url, init) => provider!(String(url), init));
    provider = async (url, init) => {
      const path = new URL(url).pathname;
      const rpc = init?.body ? JSON.parse(String(init.body)) : null;
      if (rpc?.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
      if (rpc?.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc?.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "Notion.ListPages", inputSchema: { type: "object" } }] } });
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-arcade-discovery");
      if (path === "/v1/tools") return Response.json({ items: [{ qualified_name: "Notion.ListPages", toolkit: { name: "Notion" }, requirements: { met: true, authorization: { provider_id: "notion", token_status: "completed" } } }] });
      if (path === "/v1/admin/user_connections") return Response.json({ items: [{ id: "arcade-work", provider_id: "notion", user_id: "arcade-user", connection_status: "active" }] });
      throw new Error(`Unexpected Arcade fixture operation: ${path}`);
    };
    try {
      const created = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Arcade fixture", transport: "mcp_remote", authKind: "none", credentialPolicy: "shared", status: "active", enabled: true, config: { sourceTemplateKey: "arcade", url: "https://api.arcade.dev/mcp/test" } });
      expect(created, JSON.stringify(created)).toMatchObject({ status: 201 });
      const configured = await f.request("PUT", `/tool-connections/${created.body.id}/aggregator/discovery`, { apiKey: "fixture-arcade-discovery", userId: "arcade-user" }, f.jwt);
      expect(configured, JSON.stringify(configured)).toMatchObject({ status: 200 });
      const [saved] = await server.db.select().from(toolConnections).where(eq(toolConnections.id, created.body.id));
      const discovery = saved.config.aggregatorDiscovery as Record<string, { secretId: string }>;
      expect(discovery[f.agentId]).toBeUndefined();
      expect(discovery[f.userId]).toMatchObject({ userId: "arcade-user", secretId: expect.any(String) });
      const [secret] = await server.db.select().from(companySecrets).where(eq(companySecrets.id, discovery[f.userId].secretId));
      expect(secret.ownerUserId).toBe(f.userId);
      const events = await server.db.select().from(activityLog).where(eq(activityLog.entityId, saved.id));
      expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ action: "tool_connection.account_sync_configured", actorType: "agent", actorId: f.agentId, responsibleUserId: f.userId })]));
      const cookie = await server.humanSession(f.userId);
      await vi.waitFor(async () => {
        const response = await fetch(`${server.apiUrl}/api/tool-connections/${saved.id}/aggregator/apps`, { headers: { cookie } });
        const result = await response.json();
        expect(result.discovery).toMatchObject({ availability: "available" });
        expect(result.apps).toEqual(expect.arrayContaining([expect.objectContaining({ provider: "arcade", appSlug: "notion" })]));
      }, { timeout: 10_000 });
    } finally { transport.mockRestore(); provider = null; }
  });

  it("encrypts native local-login checks and replays without exposing device codes in receipts or assets", async () => {
    const f = await fixture();
    const priorHome = process.env.PAPERCLIP_HOME;
    vi.stubEnv("PAPERCLIP_HOME", join(server.root, "local-login-receipt"));
    const authorizationUrl = "https://fixture.invalid/device?private_handoff=disposable-login";
    const code = "DISPOSABLE-DEVICE-CODE";
    const browser = vi.spyOn(localBrowserLogin, "startLocalBrowserLogin").mockReturnValue({ authorizationUrl, code, abort: vi.fn() });
    const intent = { provider: "openai", method: "subscription", ownership: "personal", name: "Local receipt fixture", agentIds: [], allAgents: false };
    let sessionId: string | undefined;
    try {
      const started = await f.request("POST", `/companies/${f.companyId}/ai-connections/local/attempts`, intent, f.jwt);
      expect(started, JSON.stringify(started)).toMatchObject({ status: 201, body: { sessionId: expect.any(String) } });
      sessionId = started.body.sessionId;
      const call = { tool: "call_api", callId: "local-login-private-check", arguments: {
        operationId: "POST /api/companies/{companyId}/ai-connections/local/check", body: { ...intent, localSessionId: sessionId },
      } };
      const result = await f.authority.execute(call);
      expect(result).toMatchObject({ ok: true, status: 200, data: { status: "sign_in_required", authorizationUrl, code } });
      expect(result).not.toHaveProperty("artifact");
      expect(await f.authority.execute(call)).toEqual(result);
      const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const receipts = (run.resultJson as { apiToolReceipts: Record<string, { operationId: string }> }).apiToolReceipts;
      expect(Object.values(receipts).find(receipt => receipt.operationId === call.arguments.operationId)).toHaveProperty("encryptedResult");
      for (const secret of [authorizationUrl, code]) {
        expect(JSON.stringify(run.resultJson)).not.toContain(secret);
        expect(JSON.stringify(redactRunnerApiPayloads(result))).not.toContain(secret);
      }
      expect((await f.snapshot()).assets.filter(asset => asset.objectKey.includes("/runner-api/"))).toEqual([]);
    } finally {
      if (sessionId) await f.request("DELETE", `/companies/${f.companyId}/ai-connections/local/attempts/${sessionId}`, undefined, f.jwt);
      browser.mockRestore();
      if (priorHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = priorHome;
    }
  });

  it("keeps durable gateway client tokens bound to the issuer and responsible user", async () => {
    const f = await fixture();
    const profile = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "gateway-profile", name: "Gateway profile", entries: [] });
    expect(profile, JSON.stringify(profile)).toMatchObject({ status: 201 });
    const gateway = await f.request("POST", `/companies/${f.companyId}/tools/gateways`, { name: "Delegated gateway", slug: "delegated", profileId: profile.body.id });
    expect(gateway, JSON.stringify(gateway)).toMatchObject({ status: 201 });
    const call = { tool: "call_api", callId: "gateway-client-secret", arguments: {
      operationId: "POST /api/tool-gateway/gateways/{gatewayId}/tokens", pathParams: { gatewayId: gateway.body.id },
      body: { companyId: f.companyId, name: "Fixture client", clientLabel: "fixture", expiresAt: new Date(Date.now() + 3600000).toISOString() },
    } };
    const issued = await f.authority.execute(call) as { status: number; data: { id: string; token: string } };
    expect(issued, JSON.stringify(issued)).toMatchObject({ status: 201, data: { token: expect.any(String), responsibleUserId: f.userId } });
    expect(await f.authority.execute(call)).toEqual(issued);
    const token = { status: issued.status, body: issued.data };
    const [receiptRun] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(JSON.stringify(receiptRun.resultJson)).not.toContain(token.body.token);
    const receipts = (receiptRun.resultJson as { apiToolReceipts: Record<string, { operationId: string }> }).apiToolReceipts;
    expect(Object.values(receipts).find(receipt => receipt.operationId === call.arguments.operationId)).toHaveProperty("encryptedResult");
    expect(JSON.stringify(redactRunnerApiPayloads(issued))).not.toContain(token.body.token);
    expect(await server.db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.gatewayId, gateway.body.id))).toHaveLength(1);
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

  it.each(["block", "ask", "ask-board", "ask-revoked", "ask-rate", "ask-new-rate", "ask-new-shared-rate", "ask-new-rate-target-block", "ask-token-revoked", "ask-token-deleted", "ask-token-scope", "ask-grant-revoked", "ask-one-connection", "ask-one-connection-recovery", "ask-one-connection-revoked", "rate", "shared-rate", "target-block", "credential"] as const)("intersects gateway issuer and target rules (%s)", async mode => {
    const f = await fixture();
    const cookie = await server.humanSession(f.userId);
    const createdTarget = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/agents`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Gateway target", role: "engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }) });
    const target = await createdTarget.json();
    expect(createdTarget.status).toBe(201);
    await lifecycle.process(target.id);
    await vi.waitFor(async () => expect((await agentService(server.db).getById(target.id))?.status).toBe("idle"));
    let calls = 0;
    const remote = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const rpc = JSON.parse(body || "{}");
      let result: unknown;
      if (rpc.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "Fixture", version: "1" } };
      else if (rpc.method === "tools/list") result = { tools: [{ name: "fixture_probe", inputSchema: { type: "object" } }] };
      else if (rpc.method === "tools/call") { calls++; result = { content: [{ type: "text", text: "Fixture gateway result" }] }; }
      else { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    });
    await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    try {
      const connection = await f.request("POST", `/companies/${f.companyId}/tools/connections`, { name: "Gateway policy fixture", transport: "mcp_remote", authKind: "none", transportConfig: { url: `http://127.0.0.1:${address.port}/mcp` } });
      expect(connection.status).toBe(201);
      await server.db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, connection.body.id));
      const [entry] = await server.db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId: connection.body.applicationId, connectionId: connection.body.id,
        entryKind: "tool", name: "Fixture probe", toolName: "fixture_probe", inputSchema: { type: "object" }, riskLevel: "read", isReadOnly: true, status: "active", versionHash: "fixture-v1" }).returning();
      expect(await f.request("POST", `/companies/${f.companyId}/tools/apps/${connection.body.id}/finish`, { enabledCatalogEntryIds: [entry.id], access: { agentIds: [f.agentId, target.id] } })).toMatchObject({ status: 200 });
      const profile = await f.request("POST", `/companies/${f.companyId}/tools/profiles`, { profileKey: "gateway-rules", name: "Gateway rules", entries: [{ selectorType: "connection", connectionId: connection.body.id }] });
      const gateway = await f.request("POST", `/companies/${f.companyId}/tools/gateways`, { name: "Cross-agent gateway", slug: "cross-agent", profileId: profile.body.id, agentId: target.id, issueId: f.issueId, projectId: f.projectId });
      expect(gateway, JSON.stringify(gateway)).toMatchObject({ status: 201 });
      const tokenBody = { companyId: f.companyId, name: "Issuer client", clientLabel: "fixture" };
      const token = mode === "ask-board" ? await (async () => {
        const response = await fetch(`${server.apiUrl}/api/tool-gateway/gateways/${gateway.body.id}/tokens`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify(tokenBody) });
        return { status: response.status, body: await response.json() };
      })() : await f.request("POST", `/tool-gateway/gateways/${gateway.body.id}/tokens`, tokenBody);
      expect(token, JSON.stringify(token)).toMatchObject({ status: 201 });
      const path = `/mcp/gateways/${gateway.body.gatewayPublicId}`;
      const rpc = (method: string, params?: unknown) => f.request("POST", path, { jsonrpc: "2.0", id: randomUUID(), method, ...(params ? { params } : {}) }, token.body.token);
      const listed = await rpc("tools/list");
      const tool = listed.body.result?.tools?.find((tool: { name: string }) => tool.name.includes("fixture-probe"));
      expect(tool, JSON.stringify(listed)).toBeTruthy();
      vi.useFakeTimers({ toFake: ["Date"] });
      const isRate = mode === "rate" || mode === "shared-rate";
      await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Gateway caller control", policyType: isRate ? "rate_limit" : mode.startsWith("ask") ? "require_approval" : mode === "credential" ? "allow" : "block",
        selectors: { connectionId: connection.body.id, ...(mode === "shared-rate" ? {} : { agentId: mode === "target-block" || mode === "ask-board" ? target.id : f.agentId }) }, priority: 0,
        ...(isRate ? { config: { limit: 1, windowSeconds: 60, keyBy: mode === "shared-rate" ? ["company", "tool"] : ["agent", "tool"] } } : {}) });
      if (mode === "ask-rate") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "One issuer admission", policyType: "rate_limit", selectors: { connectionId: connection.body.id, agentId: f.agentId }, priority: -1, config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] } });
      if (mode === "credential") {
        await server.db.update(toolConnections).set({ credentialPolicy: "per_agent" }).where(eq(toolConnections.id, connection.body.id));
        await server.db.insert(connectionGrants).values([f.agentId, target.id].map(subjectAgentId => ({ companyId: f.companyId, connectionId: connection.body.id, kind: "agent" as const, subjectAgentId, status: "active" })));
      }
      const called = await rpc("tools/call", { name: tool.name, arguments: {} });
      if (isRate) {
        expect(calls, JSON.stringify(called)).toBe(1);
        await rpc("tools/call", { name: tool.name, arguments: { another: true } });
        expect(calls).toBe(1);
        return;
      }
      expect(calls, JSON.stringify(called)).toBe(0);
      if (mode === "credential") {
        expect(JSON.stringify(called.body)).toContain("gateway_credential_identity_mismatch");
        return;
      }
      const [invocation] = await server.db.select().from(toolInvocations).where(eq(toolInvocations.gatewayId, gateway.body.id));
      expect(invocation).toMatchObject({ gatewayTokenId: token.body.id, actorId: mode === "ask-board" ? token.body.id : f.agentId, agentId: target.id, policyDecision: mode.startsWith("ask") ? "require_approval" : "deny" });
      if (!mode.startsWith("ask")) return;
      const [action] = await server.db.select().from(toolActionRequests).where(eq(toolActionRequests.invocationId, invocation.id));
      expect(action.requestedByAgentId).toBe(mode === "ask-board" ? null : f.agentId);
      if (mode.startsWith("ask-new-")) {
        await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New admission after review", policyType: "rate_limit",
          selectors: { connectionId: connection.body.id, ...(mode === "ask-new-shared-rate" ? {} : { agentId: f.agentId }) },
          priority: -2, config: { limit: 1, windowSeconds: 60, keyBy: mode === "ask-new-shared-rate" ? ["company", "tool"] : ["agent", "tool"] } });
        if (mode === "ask-new-rate") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New target admission", policyType: "rate_limit",
          selectors: { connectionId: connection.body.id, agentId: target.id }, priority: -1,
          config: { limit: 1, windowSeconds: 60, keyBy: ["agent", "tool"] } });
        if (mode === "ask-new-rate-target-block") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "New target block", policyType: "block",
          selectors: { connectionId: connection.body.id, agentId: target.id }, priority: -1 });
      }
      if (mode === "ask-revoked") await server.db.insert(toolPolicies).values({ companyId: f.companyId, name: "Issuer blocked after review", policyType: "block", selectors: { connectionId: connection.body.id, agentId: f.agentId }, priority: -1 });
      if (mode === "ask-token-revoked") await server.db.update(toolMcpGatewayTokens).set({ revokedAt: new Date() }).where(eq(toolMcpGatewayTokens.id, token.body.id));
      if (mode === "ask-token-deleted") await server.db.delete(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, token.body.id));
      if (mode === "ask-token-scope") await server.db.update(toolMcpGatewayTokens).set({ allowedActions: ["tools/list"] }).where(eq(toolMcpGatewayTokens.id, token.body.id));
      if (mode === "ask-grant-revoked" || mode === "ask-one-connection-revoked") await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_connections")));
      const approvalDenied = ["ask-revoked", "ask-new-rate-target-block", "ask-token-revoked", "ask-token-deleted", "ask-token-scope", "ask-grant-revoked", "ask-one-connection-revoked"].includes(mode);
      if (mode.startsWith("ask-one-connection")) {
        const limited = createDb(server.databaseUrl, { maxConnections: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
        const service = createToolGatewayService(limited);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let attempt: Promise<unknown> | undefined;
        try {
          if (mode === "ask-one-connection-recovery") await commitToolActionReview(server.db, {
            companyId: f.companyId, actionRequestId: action.id, decision: "approved", actor: { userId: f.userId },
          });
          attempt = mode === "ask-one-connection-recovery" ? service.recoverApprovedActionReviews(f.companyId)
            : service.approveActionRequest({ companyId: f.companyId, actionRequestId: action.id, actor: { userId: f.userId } });
          void attempt.catch(() => undefined);
          const completed = Promise.race([attempt, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Single-connection gateway approval did not settle")), 5000);
          })]);
          if (approvalDenied) await expect(completed).rejects.toMatchObject({ status: 403 });
          else await completed;
          expect((await limited.execute(sql`select 1 as available`))[0].available).toBe(1);
        } finally {
          clearTimeout(timer); await limited.$client.end({ timeout: 1 }); await attempt?.catch(() => undefined);
        }
      } else {
        const response = await fetch(`${server.apiUrl}/api/tool-gateway/action-requests/${action.id}/approve`, { method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" }, body: JSON.stringify({ companyId: f.companyId }) });
        expect(response.status, JSON.stringify(await response.json())).toBe(approvalDenied ? 403 : 200);
      }
      expect(calls).toBe(approvalDenied ? 0 : 1);
      if (mode.startsWith("ask-new-")) {
        const counters = await server.db.select().from(toolRateLimitCounters).where(eq(toolRateLimitCounters.companyId, f.companyId));
        expect(counters).toHaveLength(approvalDenied ? 0 : mode === "ask-new-shared-rate" ? 1 : 2);
        expect(counters.every(counter => counter.remaining === 0)).toBe(true);
        if (!approvalDenied) {
          const [settled] = await server.db.select().from(toolInvocations).where(eq(toolInvocations.id, invocation.id));
          expect(settled.policyExplanation?.consumedRateAdmissions).toHaveLength(1);
          expect(settled.policyExplanation?.delegatedCallerConsumedRateAdmissions).toHaveLength(1);
        }
      }
      if (["ask-rate", "ask-new-rate", "ask-new-shared-rate"].includes(mode)) {
        await rpc("tools/call", { name: tool.name, arguments: { another: true } });
        expect(calls).toBe(1);
      }
    } finally { vi.useRealTimers(); await new Promise<void>((resolve, reject) => remote.close(error => error ? reject(error) : resolve())); }
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
    await server.db.update(agentApiKeys).set({ scopeConfig: { kind: "task_bridge", issueId: g.issueId } }).where(eq(agentApiKeys.id, g.key.id));
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
