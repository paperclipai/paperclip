import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issues, toolCatalogEntries, toolConnectionInstalls, toolInvocations, companies, companyMemberships, createDb, toolConnections, toolPolicies, toolProfileEntries } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { instanceSettingsService, normalizeExperimentalSettings } from "../services/instance-settings.js";
import express from "express";
import request from "supertest";
import { toolAccessRoutes } from "../routes/tool-access.js";
const actor = { actorType: "user" as const, actorId: "mcp-test-user", actorSource: "local_implicit" as const };
const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });
describe("remote connector lifecycle", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let keyDir: string;
  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "mcp-connector-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    fixture = await startEmbeddedPostgresTestDatabase("mcp-connectors-test-");
    db = createDb(fixture.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableMcpAggregators: true });
  });
  afterAll(async () => { await fixture?.cleanup(); vi.unstubAllEnvs(); if (keyDir) await rm(keyDir, { recursive: true, force: true }); });
  async function company() {
    const [row] = await db.insert(companies).values({ name: `MCP ${randomUUID()}`, issuePrefix: `M${randomUUID().slice(0, 5)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: row.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    return row;
  }
  function remoteFixture() {
    const requests: { url: string; headers: Headers }[] = [];
    let added = false;
    let removed = false;
    const service = toolAccessService(db, { deploymentMode: "local_trusted", deploymentExposure: "private",
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (url, init) => {
        const body = JSON.parse(String(init.body)); const headers = new Headers(init.headers);
        requests.push({ url, headers });
        if (body.method === "initialize") return Response.json({ id: body.id, jsonrpc: "2.0", result: { protocolVersion: "2025-06-18", capabilities: {} } }, { headers: { "Mcp-Session-Id": "session" } });
        expect(headers.get("mcp-session-id")).toBe("session");
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        expect(body.method).toBe("tools/list");
        return Response.json({ id: body.id, jsonrpc: "2.0", result: body.params?.cursor
          ? { tools: [tool("ask"), ...(added ? [tool("new_tool")] : [])] }
          : { tools: [tool("read"), ...(!removed ? [tool("off")] : [])], nextCursor: "page-two" } });
      },
    });
    return { service, requests, add: () => { added = true; }, remove: () => { removed = true; }, restore: () => { removed = false; } };
  }
  it("defaults MCP aggregators off and rejects direct setup without provider requests or credential writes", async () => {
    expect(normalizeExperimentalSettings({}).enableMcpAggregators).toBe(false);
    const org = await company(); const remote = remoteFixture();
    await instanceSettingsService(db).updateExperimental({ enableMcpAggregators: false });
    try {
      const app = express();
      app.use((req, _res, next) => { req.actor = { type: "board", userId: actor.actorId, source: "local_implicit", isInstanceAdmin: true }; next(); });
      app.use("/api", toolAccessRoutes(db, { paperclipCloudConnector: null }));
      const gallery = await request(app).get(`/api/companies/${org.id}/tools/gallery`);
      expect(gallery.status).toBe(200);
      expect(gallery.body.apps.some((entry: { slug: string }) => ["zapier", "arcade", "composio", "executor"].includes(entry.slug))).toBe(false);
      expect(gallery.body.apps.some((entry: { slug: string }) => entry.slug === "notion")).toBe(true);
      for (const [galleryKey, connectionMethodKey] of [["zapier", "generated-url"], ["arcade", "mcp"], ["composio", "mcp"], ["executor", "mcp"]]) {
        await expect(remote.service.connectGalleryApp(org.id, { galleryKey, connectionMethodKey, saveDraft: true }, actor))
          .rejects.toMatchObject({ status: 403, details: { code: "mcp_aggregators_disabled" } });
      }
      await expect(remote.service.preflightGalleryAppMetadata("composio", "mcp"))
        .rejects.toMatchObject({ status: 403 });
      expect(remote.requests).toHaveLength(0);
      expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, org.id))).toHaveLength(0);
    } finally {
      await instanceSettingsService(db).updateExperimental({ enableMcpAggregators: true });
    }
  });
  it("vaults generated URLs, paginates discovery, preserves Off/Ask during refresh and reconnect, and isolates companies", async () => {
    const org = await company(); const other = await company(); const remote = remoteFixture();
    const input = { galleryKey: "zapier", connectionMethodKey: "generated-url", link: "https://mcp.zapier.com/api/v1/connect?token=fixture-secret", authMode: "none" as const };
    const connected = await remote.service.connectGalleryApp(org.id, input, actor);
    expect(connected.catalog).toHaveLength(3);
    expect(JSON.stringify(connected)).not.toContain("fixture-secret");
    expect(remote.requests.every((r) => r.url.includes("token=fixture-secret"))).toBe(true);
    const ids = Object.fromEntries(connected.catalog.map((entry) => [entry.toolName, entry.id]));
    const finished = await remote.service.finishGalleryAppConnection(org.id, connected.connectionId, { enabledCatalogEntryIds: [ids.read, ids.ask], askFirstCatalogEntryIds: [ids.ask], access: "all_agents" }, actor);
    remote.add();
    const refreshed = await remote.service.refreshCatalog(connected.connectionId, actor, { enableAllByDefault: true });
    const newId = refreshed.catalog.find((entry) => entry.toolName === "new_tool")!.id;
    const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, finished.profile.id));
    expect(entries.map((entry) => entry.catalogEntryId)).toEqual(expect.arrayContaining([ids.read, ids.ask, newId]));
    expect(entries.map((entry) => entry.catalogEntryId)).not.toContain(ids.off);
    await expect(remote.service.connectGalleryApp(other.id, { ...input, reconnectConnectionId: connected.connectionId }, actor)).rejects.toThrow("not found");
    const reconnected = await remote.service.connectGalleryApp(org.id, { ...input, reconnectConnectionId: connected.connectionId }, actor);
    const restored = await remote.service.finishGalleryAppConnection(org.id, connected.connectionId, { enabledCatalogEntryIds: reconnected.catalog.map((entry) => entry.id), askFirstCatalogEntryIds: [], access: "all_agents" }, actor);
    expect(restored.connection.status).toBe("active");
    expect(restored.profileEntries.map((entry) => entry.catalogEntryId)).not.toContain(ids.off);
    const policies = await db.select().from(toolPolicies).where(eq(toolPolicies.companyId, org.id));
    expect(policies.some((policy) => policy.enabled && policy.config.catalogEntryId === ids.ask)).toBe(true);
    remote.remove();
    const afterRemoval = await remote.service.refreshCatalog(connected.connectionId, actor);
    expect(afterRemoval.catalog.find((entry) => entry.toolName === "off")?.status).not.toBe("active");
    const [retired] = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.id, ids.off));
    expect(retired.status).toBe("disabled"); // Check persisted discovery, not just this refresh response.
    remote.restore();
    const afterReturn = await remote.service.refreshCatalog(connected.connectionId, actor);
    expect(afterReturn.catalog.find((entry) => entry.toolName === "off")?.status).toBe("active");
    const retainedEntries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, finished.profile.id));
    expect(retainedEntries.map((entry) => entry.catalogEntryId)).not.toContain(ids.off);
    await remote.service.archiveConnection(connected.connectionId, org.id, actor);
    const [removed] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    expect(removed.enabled).toBe(false);
    expect(removed.status).toBe("archived");
  });
  it("renews expired discovery sessions and requires an explicit retry after an expired execution session", async () => {
    const org = await company();
    const [agent] = await db.insert(agents).values({ companyId: org.id, name: "Session tester", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }).returning();
    let initialized = 0;
    const expired = new Set<string>();
    const calls: string[] = [];
    const send = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") return Response.json({ id: body.id, result: { protocolVersion: "2025-06-18" } }, { headers: { "Mcp-Session-Id": `session-${++initialized}` } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      const session = new Headers(init.headers).get("mcp-session-id")!;
      if (body.method === "tools/call") calls.push(session);
      if (expired.has(session)) return new Response(null, { status: 404 });
      return Response.json({ id: body.id, result: body.method === "tools/list" ? { tools: [tool("read")] } : { content: [{ type: "text", text: "ok" }] } });
    };
    const service = toolAccessService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }], remoteHttpRequest: send });
    const connected = await service.connectGalleryApp(org.id, { galleryKey: "arcade", connectionMethodKey: "mcp", link: "https://api.arcade.dev/mcp/expiration", authMode: "none" }, actor);
    const beforeRefresh = initialized;
    expired.add(`session-${initialized}`);
    expect((await service.refreshCatalog(connected.connectionId, actor)).catalog).toHaveLength(1);
    expect(initialized).toBe(beforeRefresh + 1);
    await service.finishGalleryAppConnection(org.id, connected.connectionId, { enabledCatalogEntryIds: connected.catalog.map((entry) => entry.id), askFirstCatalogEntryIds: [], access: "all_agents" }, actor);
    const gateway = createToolGatewayService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", remoteHttpRequest: send });
    const call = () => gateway.executeTestCall({ companyId: org.id, connectionId: connected.connectionId, agentId: agent.id, userId: actor.actorId, toolName: "read", parameters: {} });
    expect(await call()).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
    const executionSession = calls[0];
    expired.add(executionSession);
    const failed = await call();
    expect(failed).toMatchObject({ error: { reasonCode: "mcp_remote_status" } });
    expect(calls).toEqual([executionSession, executionSession]);
    expect(await call()).toMatchObject({ decision: "allowed", result: { data: { isError: false } } });
    expect(calls).toHaveLength(3);
    expect(calls[2]).not.toBe(executionSession);
  });
  it("saves a vaulted draft without contacting the provider and resumes with custom headers", async () => {
    const org = await company(); const remote = remoteFixture();
    const input = { galleryKey: "arcade", connectionMethodKey: "mcp", link: "https://api.arcade.dev/mcp/fixture", authMode: "bearer" as const };
    const draft = await remote.service.connectGalleryApp(org.id, { ...input, saveDraft: true, credentialValues: { "credentials.authorization": "fixture-key", "headers.Arcade-User-ID": "test-user" } }, actor);
    expect(remote.requests).toHaveLength(0);
    expect(JSON.stringify(draft)).not.toContain("fixture-key");
    const connected = await remote.service.connectGalleryApp(org.id, { ...input, resumeConnectionId: draft.connectionId }, actor);
    expect(connected.catalog).toHaveLength(3);
    expect(remote.requests.every((request) => request.headers.get("authorization") === "Bearer fixture-key" && request.headers.get("arcade-user-id") === "test-user")).toBe(true);
  });
  it("does not widen an empty agent selection after an OAuth callback or reconnect", async () => {
    const org = await company();
    const endpoint = "https://api.arcade.dev/mcp/fixture-oauth";
    const send = async (url: string, init: RequestInit) => {
      if (url.includes(".well-known/oauth-protected-resource")) return Response.json({ resource: endpoint, authorization_servers: ["https://auth.arcade.dev"] });
      if (url.includes(".well-known/")) return Response.json({ issuer: "https://auth.arcade.dev", authorization_endpoint: "https://auth.arcade.dev/authorize", token_endpoint: "https://auth.arcade.dev/token", response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
      if (url === "https://auth.arcade.dev/token") return Response.json({ access_token: "fixture-access", token_type: "Bearer", expires_in: 3600 });
      if (url !== endpoint) throw new Error(`Unexpected fixture URL: ${url}`);
      if (!new Headers(init.headers).has("authorization")) return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://api.arcade.dev/.well-known/oauth-protected-resource"' } });
      const body = JSON.parse(String(init.body));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return Response.json({ id: body.id, result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools: [tool("read")] } });
    };
    const service = toolAccessService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }], remoteHttpRequest: send });
    const input = { galleryKey: "arcade", connectionMethodKey: "mcp", link: endpoint, authMode: "auto" as const, oauthClient: { clientId: "fixture-client" } };
    const connected = await service.connectGalleryApp(org.id, input, actor);
    const callback = async () => {
      const redirectUri = "http://127.0.0.1:3116/api/tools/oauth/callback";
      const started = await service.startOAuth(org.id, connected.connectionId, { redirectUri, actor });
      return service.completeOAuthCallback({ state: new URL(started.authorizationUrl).searchParams.get("state")!, code: "fixture-code", redirectUri, actor });
    };
    await service.putConnectionInstalls(connected.connectionId, { installs: [] }, actor);
    const first = await callback();
    expect(first.connection.status).toBe("active");
    expect((await service.listConnectionInstalls(connected.connectionId))).toHaveLength(0);
    await service.connectGalleryApp(org.id, { ...input, reconnectConnectionId: connected.connectionId }, actor);
    await callback();
    expect((await service.listConnectionInstalls(connected.connectionId))).toHaveLength(0);
  });
  it("enforces agent and action permissions before dispatch, and preserves provider resume after Paperclip approval", async () => {
    const org = await company();
    const [allowed, denied] = await db.insert(agents).values(["Allowed", "Denied"].map((name) => ({ companyId: org.id, name, role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: {} }))).returning();
    const calls: { name: string; arguments: unknown; session: string | null }[] = [];
    const send = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "initialize") return Response.json({ id: body.id, result: { protocolVersion: "2025-06-18" } }, { headers: { "Mcp-Session-Id": "execution-session" } });
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") return Response.json({ id: body.id, result: { tools: [tool("execute"), tool("resume"), tool("off")] } });
      calls.push({ ...body.params, session: new Headers(init.headers).get("mcp-session-id") });
      return Response.json({ id: body.id, result: { structuredContent: body.params.name === "execute"
        ? { status: "waiting_for_interaction", executionId: "fixture-execution", interaction: { kind: "form", message: "Approve read?", requestedSchema: { type: "object", properties: {} } } }
        : { ok: true, resumed: body.params.arguments.executionId }, content: [] } });
    };
    const service = toolAccessService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }], remoteHttpRequest: send });
    const connection = await service.connectGalleryApp(org.id, { galleryKey: "executor", connectionMethodKey: "mcp", link: "https://executor.sh/test/mcp", authMode: "none" }, actor);
    const ids = Object.fromEntries(connection.catalog.map((entry) => [entry.toolName, entry.id]));
    await service.finishGalleryAppConnection(org.id, connection.connectionId, { enabledCatalogEntryIds: [ids.execute, ids.resume], askFirstCatalogEntryIds: [ids.execute], access: { agentIds: [allowed.id] } }, actor);
    const gateway = createToolGatewayService(db, { deploymentMode: "local_trusted", deploymentExposure: "private", remoteHttpRequest: send, toolActionSigningSecret: "fixture-signing-key" });
    const call = (agentId: string, toolName: string, parameters: Record<string, unknown> = {}) => gateway.executeTestCall({ companyId: org.id, connectionId: connection.connectionId, agentId, userId: actor.actorId, toolName, parameters });
    expect((await call(denied.id, "execute")).decision).toBe("off");
    expect((await call(allowed.id, "off")).decision).toBe("off");
    expect(calls).toHaveLength(0);
    const asked = await call(allowed.id, "execute");
    expect(asked.decision).toBe("ask_first");
    expect(calls).toHaveLength(0);
    if (!("actionRequestId" in asked)) throw new Error("Missing approval request");
    await gateway.approveActionRequest({ companyId: org.id, actionRequestId: asked.actionRequestId!, actor: { userId: actor.actorId } });
    const status = await gateway.getTestCallStatus({ companyId: org.id, connectionId: connection.connectionId, actionRequestId: asked.actionRequestId! });
    expect(status.phase).toBe("done");
    expect(status.upstreamPending).toMatchObject({ executionId: "fixture-execution", resumeTool: "resume" });
    const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, asked.invocationId));
    expect(invocation.resultSummary?.summary).toContain("fixture-execution");
    const resumed = await call(allowed.id, "resume", { executionId: status.upstreamPending!.executionId, action: "accept", content: "{}" });
    expect(resumed.decision).toBe("allowed");
    expect(calls.map((call) => call.name)).toEqual(["execute", "resume"]);
    expect(calls.every((call) => call.session === "execution-session")).toBe(true);
    const [issue] = await db.insert(issues).values({ companyId: org.id, title: "Provider approval", status: "in_progress", assigneeAgentId: allowed.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: org.id, agentId: allowed.id, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: issue.id } }).returning();
    const session = await gateway.createSession({ companyId: org.id, agentId: allowed.id, runId: run.id });
    const execute = (await gateway.listToolsForSession(session.token)).find((entry) => entry.upstreamToolName === "execute")!;
    expect(execute).toBeDefined();
    let approvalId = "";
    try { await gateway.executeTool({ sessionToken: session.token, tool: execute.name, parameters: {} }); }
    catch (error) {
      expect(error).toMatchObject({ reasonCode: "approval_required" });
      approvalId = (error as { details: { actionRequestId: string } }).details.actionRequestId;
    }
    expect(approvalId).not.toBe("");
    await gateway.approveActionRequest({ companyId: org.id, actionRequestId: approvalId, actor: { userId: actor.actorId } });
    await expect(gateway.executeTool({ sessionToken: session.token, tool: execute.name, parameters: {} })).rejects.toMatchObject({
      reasonCode: "provider_interaction_required", details: { upstreamPending: { executionId: "fixture-execution" } },
    });
    expect(calls).toHaveLength(3); // Retrying the approved action did not start another execution.
    await service.finishGalleryAppConnection(org.id, connection.connectionId, { enabledCatalogEntryIds: [ids.execute, ids.resume], askFirstCatalogEntryIds: [ids.execute], access: { agentIds: [] } }, actor);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.connectionId))).toHaveLength(0);
    expect((await call(allowed.id, "execute")).decision).toBe("off");
    expect((await gateway.listToolsForSession(session.token)).filter((entry) => entry.connectionId === connection.connectionId)).toHaveLength(0);
    await service.archiveConnection(connection.connectionId, org.id, actor);
    await expect(call(allowed.id, "resume")).rejects.toThrow("not found");
    expect(calls).toHaveLength(3);
  });

});
