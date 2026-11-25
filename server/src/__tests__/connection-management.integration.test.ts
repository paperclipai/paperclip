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
describe("connection management with production default agents", () => {
  let server!: ConnectionManagementServer;
  let lifecycle!: ConnectionManagementLifecycle;
  let provider: ConnectionManagementProviderHandler | null = null;
  const harness = createConnectionManagementHarness(() => provider);
  beforeAll(() => {
    server = harness.server;
    lifecycle = harness.lifecycle;
  });
  const fixture = () => harness.fixture();

  it.each(["tool", "ai"] as const)("matches ordinary %s install capabilities on real PostgreSQL for scoped, retained and fallback resources", async (connectionPurpose) => {
    const f = await server.fixture({ connectionScenario: "fresh" });
    const candidateIds = [f.agentId, randomUUID(), randomUUID()];
    await server.db.insert(agents).values(candidateIds.slice(1).map((id, index) => ({ id, companyId: f.companyId, name: `Capability target ${index}`, adapterType: "process" })));
    const [application] = await server.db.insert(toolApplications).values({ companyId: f.companyId, name: "Capability differential", type: "mcp_http" }).returning();
    const [connection] = await server.db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
      uid: randomUUID(), name: "Capability differential", connectionPurpose,
      transport: connectionPurpose === "ai" ? "runtime_auth" : "mcp_remote", authKind: "none", createdByUserId: "different-creator" }).returning();
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

  it.each(["tool", "ai"] as const)("preserves the complete %s grants GET across human roles and denies a real install mutation after revocation", async (connectionPurpose) => {
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
      uid: randomUUID(), name: "Grants response parity", connectionPurpose,
      transport: connectionPurpose === "ai" ? "runtime_auth" : "mcp_remote", authKind: "none", createdByUserId: users.creator }).returning();
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

  it("checks company-wide personal AI installs once per target and preserves pool member authorization", async () => {
    const f = await server.fixture({ connectionScenario: "fresh" });
    const candidateIds = [f.agentId, ...Array.from({ length: 19 }, () => randomUUID())];
    await server.db.insert(agents).values(candidateIds.slice(1).map((id, index) => ({ id, companyId: f.companyId, name: `AI target ${index}`, adapterType: "process" })));
    const [application] = await server.db.insert(toolApplications).values({ companyId: f.companyId, name: "AI capability checks", type: "mcp_http" }).returning();
    const [connection] = await server.db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
      uid: randomUUID(), name: "Personal AI account", transport: "runtime_auth", connectionPurpose: "ai", authKind: "api_key",
      credentialPolicy: "per_user", createdByUserId: f.responsibleUserId }).returning();
    const [grant] = await server.db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: connection.id,
      kind: "user", subjectUserId: f.responsibleUserId, createdByUserId: f.responsibleUserId }).returning();
    await server.db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id, targetType: "company", targetId: f.companyId });
    await server.db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.responsibleUserId!,
      permissionKey: "tools:manage_profiles", scope: { targetAgentIds: candidateIds } });
    let targetReads = 0;
    const observedDb = new Proxy(server.db, { get(target, key, receiver) {
      if (key !== "select") return Reflect.get(target, key, receiver);
      return (...fields: Parameters<typeof target.select>) => {
        const builder = target.select(...fields), from = builder.from.bind(builder);
        builder.from = ((...args: Parameters<typeof from>) => {
          const query = from(...args), execute = query.execute.bind(query);
          query.execute = (async (...executeArgs: Parameters<typeof execute>) => {
            if (query.toSQL().sql.includes('"agents"."id" =')) targetReads++;
            return execute(...executeArgs);
          }) as typeof execute;
          return query;
        }) as typeof builder.from;
        return builder;
      };
    } });
    const service = connectionManagementService(observedDb);
    const actor: AuthorizationActor = { type: "board", userId: f.responsibleUserId, source: "cloud_tenant" };
    const resource = { type: "connection_management" as const, companyId: f.companyId, connectionId: connection.id, operation: "configure", readOnly: false };
    const baseline = [];
    for (const targetAgentId of candidateIds) baseline.push(await service.capability(actor, "connections:profiles", { ...resource, targetAgentId }));
    expect(baseline.every(result => result.allowed)).toBe(true);
    expect(targetReads).toBe(candidateIds.length ** 2);
    targetReads = 0;
    expect(await service.describeAgentInstallCapabilities(actor, resource, candidateIds)).toEqual(baseline);
    expect(targetReads).toBe(candidateIds.length);

    const [pool] = await server.db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
      uid: randomUUID(), name: "Pool with private member", transport: "runtime_auth", connectionPurpose: "ai", authKind: "none" }).returning();
    await server.db.insert(aiConnectionPools).values({ id: pool.id, companyId: f.companyId, pluginKey: "fixture-pool", config: {
      name: "Pool", enabled: true, mode: "round_robin", thresholdPercent: 90,
      members: [{ id: randomUUID(), binding: { mode: "delegated", provider: "openai", method: "api_key", connectionId: connection.id, grantId: grant.id }, profile: { provider: "codex", model: "fixture-model" } }],
    } });
    await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, f.companyId), eq(principalPermissionGrants.principalId, f.responsibleUserId!)));
    await server.db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: f.responsibleUserId!,
      permissionKey: "tools:manage_profiles", scope: { connectionIds: [pool.id] } });
    const poolResource = { ...resource, connectionId: pool.id };
    expect((await service.describeAgentInstallCapabilities(actor, poolResource, candidateIds.slice(0, 2))).every(result => result.allowed)).toBe(true);
    // The pool grant cannot replace the member account's own authority.
    await server.db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, grant.id));
    await server.db.update(toolConnections).set({ createdByUserId: "different-owner" }).where(eq(toolConnections.id, connection.id));
    const ordinary = await service.capability(actor, "connections:profiles", { ...poolResource, targetAgentId: candidateIds[0] });
    expect(ordinary.allowed).toBe(false);
    expect(await service.describeAgentInstallCapabilities(actor, poolResource, candidateIds.slice(0, 2))).toEqual([ordinary, ordinary]);
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
    const profileListPath = `/companies/${f.companyId}/tools/profiles`;
    const summaryPath = `${profileListPath}/summary`;
    const fullProfiles = await f.request("GET", profileListPath);
    expect(fullProfiles.body.profiles.map((profile: { id: string }) => profile.id)).toContain(profileIds[0]);
    const summary = await f.request("GET", summaryPath);
    expect(summary).toEqual({ status: 200, body: { profiles: fullProfiles.body.profiles.map(
      ({ id, name, status, updatedAt, summary, newToolsPendingCount }: Record<string, unknown>) =>
        ({ id, name, status, updatedAt, summary, newToolsPendingCount }),
    ) } });
    expect(await f.request("PUT", `/tool-connections/${second.body.id}/installs`, { installs: [{ targetType: "agent", targetId: f.agentId }] })).toMatchObject({ status: 200 });
    await server.db.update(toolConnections).set({ credentialPolicy: "per_user", createdByUserId: randomUUID() }).where(eq(toolConnections.id, second.body.id));
    for (const token of [f.key.token, f.jwt]) {
      expect(await f.request("GET", `/tool-profiles/${profileIds[1]}/new-tools`, undefined, token)).toMatchObject({ status: 403 });
      for (const id of profileIds) expect(await f.request("GET", `/tool-profiles/${id}/new-tools`, undefined, token)).toMatchObject({ status: 403 });
      expect((await f.request("GET", profileListPath, undefined, token)).body.profiles).toEqual([]);
      expect(await f.request("GET", summaryPath, undefined, token)).toEqual({ status: 200, body: { profiles: [] } });
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

  it("keeps connection profile configuration scoped and rechecks each profile against current personal access", async () => {
    const f = await fixture();
    const create = async (name: string) => {
      const response = await f.request("POST", `/companies/${f.companyId}/tools/connections`, {
        name, transport: "mcp_remote", authKind: "none", config: { url: "https://1.1.1.1/mcp" },
      });
      expect(response).toMatchObject({ status: 201 });
      return response.body;
    };
    const owned = await create("Configuration owned"), privateConnection = await create("Configuration private");
    const [app, intent] = await server.db.insert(toolProfiles).values([
      { companyId: f.companyId, profileKey: `app:${owned.id}`, name: "App" },
      { companyId: f.companyId, profileKey: `connection-intent:${owned.id}:${f.agentId}`, name: "Intent",
        metadata: { source: "connection_intent", connectionId: owned.id, agentId: f.agentId } },
    ]).returning();
    await server.db.insert(toolProfileBindings).values({ companyId: f.companyId, profileId: intent.id, targetType: "agent", targetId: f.agentId });
    await server.db.insert(toolProfileEntries).values([
      { companyId: f.companyId, profileId: app.id, selectorType: "connection", connectionId: privateConnection.id },
      { companyId: f.companyId, profileId: intent.id, selectorType: "connection", connectionId: owned.id },
    ]);
    const path = `/tool-connections/${owned.id}/profile-configuration`;
    const uidResult = await f.request("GET", `/tool-connections/${encodeURIComponent(owned.uid)}/profile-configuration`);
    expect(uidResult).toMatchObject({ status: 200 });
    expect(uidResult.body.profiles.map((p: { id: string }) => p.id).sort()).toEqual([app.id, intent.id].sort());
    const foreign = await fixture();
    expect(await foreign.request("GET", `/tool-connections/${owned.id}/profile-configuration`)).toMatchObject({ status: 404 });
    for (const token of [f.key.token, f.jwt]) {
      const result = await f.request("GET", path, undefined, token);
      expect(result).toMatchObject({ status: 200 });
      expect(result.body.profiles.map((p: { id: string }) => p.id).sort()).toEqual([app.id, intent.id].sort());
      expect(result.body.profiles.every((p: object) => !("summary" in p) && !("newToolsPendingCount" in p))).toBe(true);
    }
    // Seeing the displayed connection must not expose a profile spanning a
    // second account after that account becomes private to another person.
    await server.db.update(toolConnections).set({ credentialPolicy: "per_user", createdByUserId: randomUUID() }).where(eq(toolConnections.id, privateConnection.id));
    for (const token of [f.key.token, f.jwt]) {
      expect(await f.request("GET", path, undefined, token)).toMatchObject({ status: 200, body: { profiles: [expect.objectContaining({ id: intent.id })] } });
      expect(await f.request("GET", `/tool-connections/${privateConnection.id}/profile-configuration`, undefined, token)).toMatchObject({ status: 403 });
      expect(await f.request("GET", `/tool-connections/${randomUUID()}/profile-configuration`, undefined, token)).toMatchObject({ status: 404 });
    }
    await server.db.update(toolConnections).set({ createdByUserId: f.userId }).where(eq(toolConnections.id, privateConnection.id));
    expect((await f.request("GET", path)).body.profiles).toHaveLength(2);
    await server.db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, "tools:manage_profiles")));
    expect(await f.request("GET", path)).toMatchObject({ status: 403 });
    expect(await f.request("GET", path, undefined, f.jwt)).toMatchObject({ status: 403 });
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
        publicSessionId: randomUUID(), status: "waiting_for_user", expiresAt: new Date(Date.now() + 60_000), aiConnection: { provider: "openai", method: "subscription", ownership: "personal", name: "Saved login", allAgents: false, agentIds: [] } }).returning();
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

  it.each(["add", "remove"] as const)("requires a connection creator to edit agent targets when finish will %s installations", async (change) => {
    const f = await server.fixture({ connectionScenario: "fresh" });
    const userId = f.responsibleUserId!;
    const cookie = await server.humanSession(userId);
    const [application] = await server.db.insert(toolApplications).values({ companyId: f.companyId, name: "Creator install authority", type: "mcp_http" }).returning();
    const [connection] = await server.db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
      uid: randomUUID(), name: "Creator-owned connection", transport: "mcp_remote", authKind: "none", status: "active", createdByUserId: userId }).returning();
    if (change === "remove") await server.db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id, targetType: "agent", targetId: f.agentId });
    const before = await server.db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id));
    const finish = async () => fetch(`${server.apiUrl}/api/companies/${f.companyId}/tools/apps/${connection.id}/finish`, {
      method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: change === "add" ? [f.agentId] : [] } }),
    });
    const denied = await finish();
    expect(await denied.json()).toMatchObject({ error: expect.any(String) });
    expect(denied.status).toBe(403);
    expect(await server.db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).toEqual(before);
    expect(await server.db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${connection.id}`))).toEqual([]);
    await server.db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "user", principalId: userId,
      permissionKey: "agents:configure", scope: { targetAgentIds: [f.agentId] } });
    const allowed = await finish();
    expect(allowed.status, JSON.stringify(await allowed.json())).toBe(200);
    expect(await server.db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).toHaveLength(change === "add" ? 1 : 0);
    const [peer] = await server.db.insert(agents).values({ companyId: f.companyId, name: "Outside edit scope", adapterType: "process" }).returning();
    const outOfScope = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/tools/apps/${connection.id}/finish`, {
      method: "POST", headers: { cookie, origin: server.apiUrl, "Content-Type": "application/json" },
      body: JSON.stringify({ enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [peer.id] } }),
    });
    expect(outOfScope.status).toBe(403);
    expect(await server.db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).toHaveLength(change === "add" ? 1 : 0);
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

  it.each([
    { provider: "openai" as const, method: "api_key" as const },
    { provider: "anthropic" as const, method: "api_key" as const },
    { provider: "openai" as const, method: "subscription" as const },
  ])("guards $provider/$method model catalogs with requesting agent authority", async ({ provider: modelProvider, method }) => {
    const f = await fixture();
    const credential = method === "subscription" ? JSON.stringify({ tokens: { access_token: "catalog-access", refresh_token: "catalog-refresh", account_id: "catalog-account" } }) : "catalog-key";
    const account = await aiConnectionService(server.db).save(f.companyId, f.userId, {
      provider: modelProvider, method, ownership: "shared", name: "Scoped catalog", agentIds: [], allAgents: false,
      ...(method === "api_key" ? { apiKey: credential } : { loginSessionId: "fixture" }),
    }, credential);
    let calls = 0;
    provider = async url => {
      calls++;
      if (url.startsWith("https://chatgpt.com/backend-api/codex/models")) return Response.json({ models: [{ slug: "catalog-model", display_name: "Catalog model", visibility: "list" }] });
      if (url === "https://api.openai.com/v1/models" || url === "https://api.anthropic.com/v1/models?limit=1000") return Response.json({ data: [{ id: "catalog-model", display_name: "Catalog model" }] });
      throw new Error("Unexpected credential refresh or provider request");
    };
    const binding = { mode: "shared", provider: modelProvider, method, ...account };
    const path = `/companies/${f.companyId}/adapters/${modelProvider === "openai" ? "codex_local" : "claude_local"}/models?aiConnection=${encodeURIComponent(JSON.stringify(binding))}`;
    const permission = (key: "tools:manage_connections" | "tools:manage_profiles") => and(eq(principalPermissionGrants.companyId, f.companyId), eq(principalPermissionGrants.principalType, "agent"), eq(principalPermissionGrants.principalId, f.agentId), eq(principalPermissionGrants.permissionKey, key));
    try {
      await server.db.update(principalPermissionGrants).set({ scope: { connectionIds: [randomUUID()] } }).where(permission("tools:manage_connections"));
      const cookie = await server.humanSession(f.userId);
      const board = await fetch(`${server.apiUrl}/api${path}`, { headers: { cookie } });
      expect(board.status).toBe(200);
      expect(await board.json()).toEqual([{ id: "catalog-model", label: "Catalog model" }]);
      calls = 0;
      for (const token of [f.key.token, f.jwt]) expect(await f.request("GET", path, undefined, token)).toMatchObject({ status: 403 });
      expect(calls).toBe(0);
      await server.db.update(principalPermissionGrants).set({ scope: { connectionIds: [account.connectionId] } }).where(permission("tools:manage_connections"));
      await server.db.delete(principalPermissionGrants).where(permission("tools:manage_profiles"));
      for (const token of [f.key.token, f.jwt]) expect(await f.request("GET", path, undefined, token)).toMatchObject({ status: 403 });
      expect(calls).toBe(0);
      await server.db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent", principalId: f.agentId,
        permissionKey: "tools:manage_profiles", scope: { connectionIds: [account.connectionId] } });
      for (const token of [f.key.token, f.jwt]) expect(await f.request("GET", path, undefined, token)).toMatchObject({ status: 200, body: [{ id: "catalog-model", label: "Catalog model" }] });
      expect(calls).toBe(2);
      await server.db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: account.connectionId, targetType: "agent", targetId: f.agentId });
      await server.db.delete(principalPermissionGrants).where(permission("tools:manage_profiles"));
      for (const token of [f.key.token, f.jwt]) expect(await f.request("GET", path, undefined, token)).toMatchObject({ status: 200 });
      expect(calls).toBe(4);
      await server.db.update(principalPermissionGrants).set({ scope: { connectionIds: [randomUUID()] } }).where(permission("tools:manage_connections"));
      for (const token of [f.key.token, f.jwt]) expect(await f.request("GET", path, undefined, token)).toMatchObject({ status: 403 });
      expect(calls).toBe(4);
      expect(await f.request("GET", path.replace(f.companyId, f.foreignCompanyId))).toMatchObject({ status: 403 });
      expect(calls).toBe(4);
    } finally { provider = null; }
  });
});
