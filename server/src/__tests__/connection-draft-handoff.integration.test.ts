import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toolConnections, toolCatalogEntries, connectionGrants, principalPermissionGrants, companySecrets, userSecretDefinitions } from "@paperclipai/db";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { accessService } from "../services/access.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { toolAccessService } from "../services/tool-access.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

describe("saved tool connection authentication handoff", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    vi.stubEnv("PAPERCLIP_AUTH_RATE_LIMIT_ENABLED", "false");
    server = await startRunnerApiTestServer({ humanSessions: true });
  }, 90_000);
  afterAll(async () => { await server?.close(); vi.unstubAllEnvs(); });

  async function fixture() {
    const f = await server.fixture({ connectionScenario: "fresh", disableWakeOnDemand: true });
    const userId = f.responsibleUserId!;
    await accessService(server.db).ensureMembership(f.companyId, "user", userId, "operator", "active");
    await accessService(server.db).ensureMembership(f.companyId, "agent", f.agentId, "member", "active");
    await accessService(server.db).ensureRoleDefaultGrants(f.companyId, userId, "operator", userId);
    await server.db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent", principalId: f.agentId,
      permissionKey: "tools:manage_connections", scope: null });
    const jwt = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, userId)!;
    const cookie = await server.humanSession(userId);
    const request = async (path: string, body?: unknown, human = false) => {
      const response = await fetch(`${server.apiUrl}/api${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(human ? { cookie, origin: server.apiUrl } : { Authorization: `Bearer ${jwt}` }), "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const authority = new PaperclipRunnerToolAuthority(server.db, { companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, runId: f.runId, apiUrl: server.apiUrl, storage: server.storage });
    const call = (tool: string, args: Record<string, unknown>) => authority.execute({ tool, callId: randomUUID(), arguments: args });
    const draft = async (name = "Slack") => {
      const result = await request(`/companies/${f.companyId}/tools/apps/connect`, {
        galleryKey: "slack", connectionMethodKey: "mcp-oauth", name,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ status: 201, body: { connection: { status: "draft", enabled: false } } });
      return result.body;
    };
    return { ...f, userId, request, call, draft, service: connectionIntentService(server.db) };
  }

  it.each([true, false])("resumes the saved OAuth draft with explicit connectionId=%s and completes without a duplicate", async explicit => {
    const f = await fixture();
    const saved = await f.draft();
    const result = await f.call("connection_request", { service: "slack", ...(explicit ? { connectionId: saved.connectionId } : {}) }) as { interactionId: string; connectionId: string };
    expect(result).toMatchObject({ state: "needs_user_action", connectionId: saved.connectionId });
    expect(await f.call("connection_request", { service: "slack", connectionId: saved.connectionId })).toMatchObject({ interactionId: result.interactionId });
    const setup = await f.request(`/connection-intents/${result.interactionId}/setup-options`, undefined, true);
    expect(setup.status).toBe(200);
    expect(setup.body.interaction.payload).toMatchObject({ savedConnectionId: saved.connectionId });
    expect(setup.body.interaction.payload.accessRequest).toBeUndefined();
    expect(setup.body.service.connectionId).toBe(saved.connectionId);
    const path = new URL(setup.body.service.methods[0].setupPath, server.apiUrl);
    expect(path.searchParams.get("resume")).toBe(saved.connectionId);
    expect(path.searchParams.get("intent")).toBe(result.interactionId);
    expect(path.pathname).toBe(new URL(saved.requiredUserAction.setupPath, server.apiUrl).pathname);

    // The browser submits the same resume operation. Provider consent and the
    // indexed catalog below stand in for the external OAuth server only.
    const resumed = await toolAccessService(server.db).connectGalleryApp(f.companyId, {
      galleryKey: "slack", connectionMethodKey: "mcp-oauth", resumeConnectionId: path.searchParams.get("resume")!,
      interactionId: result.interactionId,
    }, { actorType: "user", actorId: f.userId });
    expect(resumed.connectionId).toBe(saved.connectionId);
    await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "ok" }).where(eq(toolConnections.id, saved.connectionId));
    const [definition] = await server.db.insert(userSecretDefinitions).values({ companyId: f.companyId, key: randomUUID(), name: "Fixture OAuth token" }).returning();
    const [secret] = await server.db.insert(companySecrets).values({ companyId: f.companyId, scope: "user", ownerUserId: f.userId,
      userSecretDefinitionId: definition.id, key: randomUUID(), name: "Fixture OAuth token" }).returning();
    await server.db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: saved.connectionId,
      kind: "user", subjectUserId: f.userId, createdByUserId: f.userId, status: "active",
      credentialSecretRefs: [{ secretId: secret.id, versionSelector: "latest", configPath: "oauth.access_token", required: true, label: "OAuth access token" }],
    });
    await server.db.insert(toolCatalogEntries).values({ companyId: f.companyId, connectionId: saved.connectionId,
      toolName: "slack_read", name: "slack_read", entryKind: "tool", status: "active", riskLevel: "read", versionHash: "v1" });
    await expect(f.service.complete(result.interactionId, saved.connectionId, f.userId, { canManageOrganizationGrant: true }))
      .resolves.toMatchObject({ status: "accepted", result: { connectionId: saved.connectionId } });
    expect(await server.db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(1);
  });

  it("discovers the saved draft and its method resume path without provider calls", async () => {
    const f = await fixture();
    const saved = await f.draft();
    const result = await f.call("connections_search", { query: "Slack" }) as { results: Array<Record<string, unknown>> };
    expect(result.results).toContainEqual(expect.objectContaining({ service: "slack", connectionId: saved.connectionId,
      state: "needs_user_action", methods: expect.arrayContaining([expect.objectContaining({ key: "mcp-oauth",
        connectionId: saved.connectionId, setupPath: saved.requiredUserAction.setupPath })]) }));
  });

  it("keeps enabled connection requests as exact-tool access grants", async () => {
    const f = await fixture();
    const saved = await f.draft();
    await server.db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "ok" }).where(eq(toolConnections.id, saved.connectionId));
    await server.db.update(connectionGrants).set({ status: "active" }).where(and(eq(connectionGrants.connectionId, saved.connectionId), eq(connectionGrants.isDefault, true)));
    await server.db.insert(toolCatalogEntries).values(["slack_read", "slack_write"].map((toolName, index) => ({
      companyId: f.companyId, connectionId: saved.connectionId, toolName, name: toolName, entryKind: "tool" as const,
      status: "active" as const, riskLevel: index ? "write" as const : "read" as const, versionHash: "v1",
    })));
    const result = await f.call("connection_request", { service: "slack", connectionId: saved.connectionId, toolNames: ["slack_read"] }) as { interactionId: string };
    const loaded = await f.service.loadIntent(result.interactionId);
    expect(loaded.interaction.payload.savedConnectionId).toBeUndefined();
    expect(loaded.interaction.payload.accessRequest).toMatchObject({ connectionId: saved.connectionId,
      tools: [{ toolName: "slack_read", permission: "allowed" }] });
    await expect(f.service.complete(result.interactionId, saved.connectionId, f.userId, { canManageOrganizationGrant: true }))
      .resolves.toMatchObject({ status: "accepted" });
    const effective = await toolAccessService(server.db).getEffectiveToolAssignmentsForAgent(f.companyId, f.agentId);
    expect(effective.allowedTools.map(tool => tool.toolName)).toEqual(["slack_read"]);
  });

  it("returns actionable errors for draft tool grants, ambiguous drafts, and unavailable IDs", async () => {
    const f = await fixture();
    const saved = await f.draft();
    await expect(f.call("connection_request", { service: "slack", connectionId: saved.connectionId, toolNames: ["slack_read"] }))
      .rejects.toThrow(/sign.in.*without toolNames/i);
    await f.draft("Slack second account");
    await expect(f.call("connection_request", { service: "slack" })).rejects.toThrow(/multiple.*draft.*connectionId/i);
    await expect(f.call("connection_request", { service: "slack", connectionId: randomUUID() }))
      .rejects.toThrow(/not eligible.*connections_search/i);
  });

  it("keeps another person's draft private and binds completion to the requested ID", async () => {
    const f = await fixture();
    const saved = await f.draft();
    await server.db.update(toolConnections).set({ createdByUserId: "another-user" }).where(eq(toolConnections.id, saved.connectionId));
    const found = await f.call("connections_search", { query: "Slack" }) as { results: Array<{ connectionId: string | null }> };
    expect(found.results.every(item => item.connectionId !== saved.connectionId)).toBe(true);
    await expect(f.call("connection_request", { service: "slack", connectionId: saved.connectionId })).rejects.toThrow("not eligible");
    await server.db.update(toolConnections).set({ createdByUserId: f.userId }).where(eq(toolConnections.id, saved.connectionId));
    const result = await f.call("connection_request", { service: "slack", connectionId: saved.connectionId }) as { interactionId: string };
    const other = await f.draft("Another Slack draft");
    await expect(f.request(`/tools/oauth/${other.connectionId}/start`, { asCurrentUser: true, interactionId: result.interactionId }, true))
      .resolves.toMatchObject({ status: 409, body: { error: expect.stringMatching(/saved connection/) } });
    await expect(f.service.complete(result.interactionId, randomUUID(), f.userId)).rejects.toThrow(/saved connection/i);
    await expect(f.service.updatePhase(result.interactionId, "authorizing", f.userId, {
      setupAccess: { connectionId: randomUUID(), access: { agentIds: [f.agentId] } },
    })).rejects.toThrow(/saved connection/i);
    const foreign = await fixture();
    await expect(foreign.call("connection_request", { service: "slack", connectionId: saved.connectionId })).rejects.toThrow("not eligible");
    expect(await server.db.select().from(toolConnections).where(and(eq(toolConnections.companyId, f.companyId), eq(toolConnections.id, saved.connectionId)))).toHaveLength(1);
  });
});
