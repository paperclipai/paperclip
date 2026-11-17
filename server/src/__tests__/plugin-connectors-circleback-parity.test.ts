/**
 * Plugin-provided connectors: Circleback parity.
 *
 * A test-only plugin provides a copy of the built-in Circleback definition.
 * The same journey runs against the built-in connector and the plugin copy,
 * and both must give the same results. The provider is a recorded MCP and
 * OAuth fixture; no request leaves the host. Each hard rule for plugin
 * connectors is asserted where it applies:
 *
 *   1. Enabling the plugin only adds the connector type to the catalog.
 *   2. Connecting and signing in an account grants no tools.
 *   3. Only an agent (or company) install gives an agent the tools, in
 *      discovery and in invocation.
 *   4. A disabled plugin hides its connector and connections and reaches no
 *      agent; re-enabling restores the saved setup unchanged. Uninstalling
 *      retires the connections and revokes their credentials.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, companySecrets, connectionGrants, createDb, heartbeatRuns,
  issues, plugins, toolConnectionInstalls, toolConnections,
} from "@paperclipai/db";
import {
  APP_DEFINITIONS, pluginAppSlug, pluginManifestV1Schema, type AppDefinition, type PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { toolAccessService, type McpToolDescriptor } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { retirePluginAppConnections } from "../services/plugin-app-catalog.js";
import { connectorKeyForConnection } from "../services/connector-telemetry.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const fixtureDir = new URL("./fixtures/plugin-connectors/circleback-parity/", import.meta.url);
const pluginCircleback = JSON.parse(readFileSync(new URL("circleback.json", fixtureDir), "utf8")) as AppDefinition;
const fixtureManifest = pluginManifestV1Schema.parse({
  ...JSON.parse(readFileSync(new URL("manifest.json", fixtureDir), "utf8")),
  apps: [pluginCircleback],
}) as PaperclipPluginManifestV1;
const PLUGIN_KEY = fixtureManifest.id;
const PLUGIN_SLUG = pluginAppSlug(PLUGIN_KEY, "circleback");

const actor = { actorType: "user" as const, actorId: "circleback-parity-admin" };
const redirectUri = "https://paperclip.fixture.test/api/tools/oauth/callback";
const origin = "https://circleback.ai";
const endpoint = `${origin}/api/mcp`;

// Recorded shape of Circleback's hosted MCP catalog, trimmed to the tools
// whose risk differs between the reviewed list and the generic classifier.
const tools: McpToolDescriptor[] = [
  { name: "SearchMeetings", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "ReadMeetings", inputSchema: { type: "object" } },
  { name: "ShareMeeting", inputSchema: { type: "object" } },
  { name: "ShareFolder", inputSchema: { type: "object" } },
  { name: "SubmitFeedback", inputSchema: { type: "object" } },
  { name: "DeleteFolder", inputSchema: { type: "object" } },
  { name: "UpdateActionItem", inputSchema: { type: "object" } },
];

/** One recorded Circleback provider: DCR OAuth plus the MCP endpoint. */
function circlebackProvider() {
  const issued = new Set<string>();
  const calls: Array<{ tool: string; token: string }> = [];
  let tokenCount = 0;
  const fetchFixture = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe(origin);
    const headers = new Headers(init.headers);
    const body = String(init.body ?? "");
    if (url === endpoint && init.method === "POST") {
      const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!issued.has(token)) {
        return new Response(null, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"` } });
      }
      const rpc = JSON.parse(body);
      if (rpc.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Circleback fixture", version: "1" } } });
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools } });
      if (rpc.method === "tools/call") {
        calls.push({ tool: rpc.params.name, token });
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { content: [{ type: "text", text: `Circleback ran ${rpc.params.name}` }] } });
      }
    }
    if (url.includes("oauth-protected-resource")) return Response.json({ resource: endpoint, authorization_servers: [origin], scopes_supported: ["user", "user:write"] });
    if (url === `${origin}/.well-known/oauth-authorization-server`) return Response.json({
      issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`, code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["user", "user:write"],
    });
    if (url === `${origin}/oauth/register`) return Response.json({ ...JSON.parse(body), client_id: "circleback-fixture-client" });
    if (url === `${origin}/oauth/token`) {
      const accessToken = `circleback-account-${++tokenCount}-${randomUUID()}`;
      issued.add(accessToken);
      return Response.json({ access_token: accessToken, refresh_token: `refresh-${accessToken}`, expires_in: 3600, token_type: "Bearer", scope: "user user:write" });
    }
    return new Response(null, { status: 404 });
  });
  return { fetchFixture, calls };
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("plugin-provided connectors: Circleback parity", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-plugin-connectors-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await temp?.cleanup(); });

  it("ships an unmodified copy of the built-in Circleback definition", () => {
    expect(pluginCircleback).toEqual(APP_DEFINITIONS.find(app => app.slug === "circleback"));
  });

  async function setup() {
    const [company] = await db.insert(companies).values({ name: "Circleback parity", issuePrefix: `CP${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    const [agentA, agentB] = await db.insert(agents).values([
      { companyId: company.id, name: "Meeting analyst", role: "engineer", adapterType: "process" },
      { companyId: company.id, name: "Other agent", role: "engineer", adapterType: "process" },
    ]).returning();
    const provider = circlebackProvider();
    const service = toolAccessService(db, { remoteHttpRequest: provider.fetchFixture, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const gateway = createToolGatewayService(db, { remoteHttpRequest: provider.fetchFixture, toolActionSigningSecret: "circleback-parity-signing-key" });
    const app = express();
    app.use((req, _res, next) => { req.actor = { type: "board", userId: actor.actorId, source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", toolAccessRoutes(db, { paperclipCloudConnector: null }));
    const session = async (agentId: string) => {
      const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Review meetings", assigneeAgentId: agentId }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId, issueId: issue.id, scopeKind: "issue",
        invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId, contextSnapshot: { issueId: issue.id } }).returning();
      return { ...(await gateway.createSession({ companyId: company.id, agentId, runId: run.id, issueId: issue.id })), runId: run.id };
    };
    const sessions = { a: await session(agentA.id), b: await session(agentB.id) };
    const circlebackTools = async (token: string, galleryKey: string) => (await gateway.listToolsForSession(token))
      .filter(tool => tool.providerType === "mcp_remote_http")
      .filter(tool => {
        const connection = connectionsBySlug.get(galleryKey);
        return connection?.has(tool.connectionId ?? "");
      });
    const connectionsBySlug = new Map<string, Set<string>>();
    const gallerySlugs = async () => (await request(app).get(`/api/companies/${company.id}/tools/gallery`)).body.apps.map((entry: { slug: string }) => entry.slug) as string[];
    return { company, agentA, agentB, provider, service, gateway, app, sessions, circlebackTools, connectionsBySlug, gallerySlugs };
  }

  async function connectAccount(f: Awaited<ReturnType<typeof setup>>, galleryKey: string, { saveAgentSelection = true } = {}) {
    const connected = await f.service.connectGalleryApp(f.company.id, { galleryKey, connectionMethodKey: "mcp-oauth" }, actor);
    // The setup screen saves the operator's agent selection (none yet) before sign-in.
    if (saveAgentSelection) await f.service.putConnectionInstalls(connected.connectionId, { installs: [] });
    const start = await f.service.startOAuth(f.company.id, connected.connectionId, { redirectUri, actor });
    const authorization = new URL(start.authorizationUrl);
    expect(start.registrationSource).toBe("dcr");
    expect(authorization.origin).toBe(origin);
    const signedIn = await f.service.completeOAuthCallback({ state: authorization.searchParams.get("state")!, code: `code-${randomUUID()}`, iss: origin, redirectUri, actor });
    const ids = f.connectionsBySlug.get(galleryKey) ?? new Set<string>();
    ids.add(signedIn.connectionId);
    f.connectionsBySlug.set(galleryKey, ids);
    return signedIn;
  }

  async function journey(f: Awaited<ReturnType<typeof setup>>, galleryKey: string) {
    const first = await connectAccount(f, galleryKey);
    const second = await connectAccount(f, galleryKey);
    const catalog = (await f.service.listCatalog(first.connectionId))
      .map(entry => ({ tool: entry.toolName, risk: entry.riskLevel, status: entry.status }))
      .sort((left, right) => left.tool.localeCompare(right.tool));
    // Rule 2: two signed-in accounts, and still no agent has any tool.
    const beforeInstall = {
      a: (await f.circlebackTools(f.sessions.a.token, galleryKey)).length,
      b: (await f.circlebackTools(f.sessions.b.token, galleryKey)).length,
    };
    // Rule 3: enable the first account for agent A only.
    await f.service.finishGalleryAppConnection(f.company.id, first.connectionId, {
      enabledCatalogEntryIds: first.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [f.agentA.id] },
    }, actor);
    const toolsA = await f.circlebackTools(f.sessions.a.token, galleryKey);
    const toolsB = await f.circlebackTools(f.sessions.b.token, galleryKey);
    const search = toolsA.find(tool => tool.upstreamToolName === "SearchMeetings")!;
    await f.gateway.executeTool({ sessionToken: f.sessions.a.token, tool: search.name, parameters: { query: "roadmap" }, idempotencyKey: randomUUID() });
    const denied = await f.gateway.executeTool({ sessionToken: f.sessions.b.token, tool: search.name, parameters: { query: "roadmap" }, idempotencyKey: randomUUID() })
      .then(() => "allowed", () => "denied");
    return {
      first, second, catalog, beforeInstall, denied, searchTool: search.name,
      suggestedDefaults: first.suggestedDefaults,
      visibleToA: toolsA.map(tool => ({ tool: tool.upstreamToolName, risk: tool.risk, connection: tool.connectionId === first.connectionId ? "first" : "other" }))
        .sort((left, right) => String(left.tool).localeCompare(String(right.tool))),
      visibleToB: toolsB.length,
    };
  }

  it("runs the same journey with identical results for the built-in connector and the plugin copy", async () => {
    const f = await setup();
    // Rule 1: before the plugin exists only the built-in connector is listed.
    expect(await f.gallerySlugs()).toContain("circleback");
    expect(await f.gallerySlugs()).not.toContain(PLUGIN_SLUG);

    const [plugin] = await db.insert(plugins).values({ pluginKey: PLUGIN_KEY, packageName: "@paperclipai/test-circleback-parity", version: fixtureManifest.version,
      manifestJson: fixtureManifest, status: "ready" }).returning();
    // Rule 1: enabling the plugin adds the namespaced connector type and nothing else.
    const slugs = await f.gallerySlugs();
    expect(slugs).toEqual(expect.arrayContaining(["circleback", PLUGIN_SLUG]));
    // The board also gets the full definition, as it bundles built-in ones.
    const gallery = await request(f.app).get(`/api/companies/${f.company.id}/tools/gallery`);
    expect(gallery.body.pluginApps).toEqual([expect.objectContaining({ slug: PLUGIN_SLUG, plugin: { pluginKey: PLUGIN_KEY, appSlug: "circleback" },
      methods: pluginCircleback.methods })]);
    // Telemetry never names a plugin's connector.
    expect(connectorKeyForConnection({ config: { sourceTemplateKey: PLUGIN_SLUG } })).toBe("custom");
    expect(connectorKeyForConnection({ config: { sourceTemplateKey: "circleback" } })).toBe("circleback");
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.company.id))).toHaveLength(0);
    expect(await f.gateway.listToolsForSession(f.sessions.a.token)).toEqual(await f.gateway.listToolsForSession(f.sessions.b.token));

    const core = await journey(f, "circleback");
    const fromPlugin = await journey(f, PLUGIN_SLUG);

    for (const result of [core, fromPlugin]) {
      expect(result.beforeInstall).toEqual({ a: 0, b: 0 });
      expect(result.visibleToB).toBe(0);
      expect(result.denied).toBe("denied");
      expect(result.visibleToA.every(tool => tool.connection === "first")).toBe(true);
      expect(result.catalog).toEqual(expect.arrayContaining([
        { tool: "SearchMeetings", risk: "read", status: "active" },
        { tool: "ShareMeeting", risk: "write", status: "active" },
        { tool: "ShareFolder", risk: "write", status: "active" },
        { tool: "SubmitFeedback", risk: "write", status: "active" },
        { tool: "DeleteFolder", risk: "destructive", status: "active" },
      ]));
    }
    expect(fromPlugin.catalog).toEqual(core.catalog);
    expect(fromPlugin.suggestedDefaults).toEqual(core.suggestedDefaults);
    expect(fromPlugin.visibleToA).toEqual(core.visibleToA);
    expect(fromPlugin.first.connection.config).toMatchObject({ sourceTemplateKey: PLUGIN_SLUG, url: endpoint, connectionMethodKey: "mcp-oauth" });
    // Each account calls the provider with its own credential.
    const tokensByTool = f.provider.calls.map(call => call.token);
    expect(tokensByTool).toHaveLength(2);
    expect(new Set(tokensByTool).size).toBe(2);

    // Rule 2, without the setup screen: signing in a plugin account through
    // the API alone never installs it for agents.
    const apiOnly = await connectAccount(f, PLUGIN_SLUG, { saveAgentSelection: false });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, apiOnly.connectionId))).toEqual([]);
    expect((await f.gateway.listToolsForSession(f.sessions.b.token)).some(tool => tool.connectionId === apiOnly.connectionId)).toBe(false);

    const pluginConnectionIds = [fromPlugin.first.connectionId, fromPlugin.second.connectionId, apiOnly.connectionId];
    const installsBefore = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, fromPlugin.first.connectionId));
    const grantsBefore = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, fromPlugin.first.connectionId));

    // Rule 4: disabling the plugin hides its connector type and connections
    // and removes the tools from discovery and invocation. Built-in Circleback
    // is untouched.
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, plugin.id));
    expect(await f.gallerySlugs()).not.toContain(PLUGIN_SLUG);
    expect(await f.gallerySlugs()).toContain("circleback");
    const listedConnections = (await f.service.listConnections(f.company.id)).map(connection => connection.id);
    expect(listedConnections).toEqual(expect.arrayContaining([core.first.connectionId, core.second.connectionId]));
    expect(listedConnections).not.toEqual(expect.arrayContaining([pluginConnectionIds[0]]));
    expect(listedConnections.some(id => pluginConnectionIds.includes(id))).toBe(false);
    const listedApplications = (await f.service.listApplications(f.company.id)).map(application => application.metadata?.sourceTemplateKey);
    expect(listedApplications).toContain("circleback");
    expect(listedApplications).not.toContain(PLUGIN_SLUG);
    expect(await f.circlebackTools(f.sessions.a.token, PLUGIN_SLUG)).toEqual([]);
    expect((await f.circlebackTools(f.sessions.a.token, "circleback")).map(tool => tool.upstreamToolName).sort())
      .toEqual(core.visibleToA.map(tool => tool.tool));
    await expect(f.gateway.executeTool({ sessionToken: f.sessions.a.token, tool: fromPlugin.searchTool, parameters: {}, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ status: 404 });
    await expect(f.service.connectGalleryApp(f.company.id, { galleryKey: PLUGIN_SLUG, connectionMethodKey: "mcp-oauth" }, actor))
      .rejects.toMatchObject({ status: 404 });
    // Token exchange is refused too.
    await expect(f.service.mintConnectionTokenForAgent({ connectionId: fromPlugin.first.connectionId, companyId: f.company.id,
      agentId: f.agentA.id, runId: f.sessions.a.runId, body: {} })).rejects.toMatchObject({ status: 404 });
    // Saved setup is untouched while disabled.
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, fromPlugin.first.connectionId))).toEqual(installsBefore);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, fromPlugin.first.connectionId))).toEqual(grantsBefore);

    // Rule 4: re-enabling restores the connector, both accounts and agent A's tools.
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, plugin.id));
    expect(await f.gallerySlugs()).toContain(PLUGIN_SLUG);
    expect((await f.service.listConnections(f.company.id)).map(connection => connection.id)).toEqual(expect.arrayContaining(pluginConnectionIds));
    const restored = await f.circlebackTools(f.sessions.a.token, PLUGIN_SLUG);
    expect(restored.map(tool => tool.upstreamToolName).sort()).toEqual(fromPlugin.visibleToA.map(tool => tool.tool));
    expect(restored.some(tool => tool.name === fromPlugin.searchTool)).toBe(true);
    await f.gateway.executeTool({ sessionToken: f.sessions.a.token, tool: fromPlugin.searchTool, parameters: {}, idempotencyKey: randomUUID() });
    expect(await f.circlebackTools(f.sessions.b.token, PLUGIN_SLUG)).toEqual([]);

    // Rule 4: an upgrade that drops the app hides it the same way.
    await db.update(plugins).set({ manifestJson: { ...fixtureManifest, apps: [] } }).where(eq(plugins.id, plugin.id));
    expect(await f.gallerySlugs()).not.toContain(PLUGIN_SLUG);
    expect(await f.circlebackTools(f.sessions.a.token, PLUGIN_SLUG)).toEqual([]);
    await db.update(plugins).set({ manifestJson: fixtureManifest }).where(eq(plugins.id, plugin.id));

    // Rule 4: uninstalling keeps the rows for audit, archived, and revokes
    // their grants and connection-owned credentials.
    const secretIdsBefore = (await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, fromPlugin.first.connectionId)))
      .flatMap(grant => grant.credentialSecretRefs.map(ref => ref.secretId));
    expect(secretIdsBefore.length).toBeGreaterThan(0);
    await db.update(plugins).set({ status: "uninstalled" }).where(eq(plugins.id, plugin.id));
    expect(await retirePluginAppConnections(db, PLUGIN_KEY)).toBe(3);
    const retired = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, f.company.id)));
    for (const row of retired) {
      if (pluginConnectionIds.includes(row.id)) expect(row).toMatchObject({ status: "archived", enabled: false });
      else expect(row.status).not.toBe("archived");
    }
    for (const id of pluginConnectionIds) {
      const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, id));
      expect(grants.length).toBeGreaterThan(0);
      expect(grants.every(grant => grant.status === "revoked")).toBe(true);
    }
    for (const secretId of secretIdsBefore) {
      expect(await db.select().from(companySecrets).where(eq(companySecrets.id, secretId))).toHaveLength(0);
    }
    expect((await f.circlebackTools(f.sessions.a.token, "circleback")).length).toBe(core.visibleToA.length);
  });

  it("archives a connection whose plugin was disabled while its setup ran", async () => {
    const f = await setup();
    const pluginKey = `${PLUGIN_KEY}-race`;
    const slug = pluginAppSlug(pluginKey, "circleback");
    await db.insert(plugins).values({ pluginKey, packageName: "@paperclipai/test-circleback-race", version: fixtureManifest.version,
      manifestJson: { ...fixtureManifest, id: pluginKey }, status: "ready" });
    const connected = await f.service.connectGalleryApp(f.company.id, { galleryKey: slug, connectionMethodKey: "mcp-oauth" }, actor);
    await f.service.putConnectionInstalls(connected.connectionId, { installs: [] });
    const start = await f.service.startOAuth(f.company.id, connected.connectionId, { redirectUri, actor });
    await f.service.completeOAuthCallback({ state: new URL(start.authorizationUrl).searchParams.get("state")!, code: "race", iss: origin, redirectUri, actor });
    // Disabled while an account signs in: the saved setup stays, hidden.
    const paused = await f.service.connectGalleryApp(f.company.id, { galleryKey: slug, connectionMethodKey: "mcp-oauth", name: "Paused account" }, actor);
    await f.service.putConnectionInstalls(paused.connectionId, { installs: [] });
    const pausedStart = await f.service.startOAuth(f.company.id, paused.connectionId, { redirectUri, actor });
    const beforeDisable = f.provider.fetchFixture.getMockImplementation()!;
    f.provider.fetchFixture.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/oauth/token")) await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.pluginKey, pluginKey));
      return beforeDisable(url, init);
    });
    await expect(f.service.completeOAuthCallback({ state: new URL(pausedStart.authorizationUrl).searchParams.get("state")!, code: "paused", iss: origin, redirectUri, actor }))
      .rejects.toMatchObject({ status: 404 });
    f.provider.fetchFixture.mockImplementation(beforeDisable);
    const [pausedRow] = await db.select().from(toolConnections).where(eq(toolConnections.id, paused.connectionId));
    expect(pausedRow.status).not.toBe("archived");
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.pluginKey, pluginKey));
    expect((await f.service.listConnections(f.company.id)).map(connection => connection.id)).toContain(paused.connectionId);
    await f.service.archiveConnection(paused.connectionId, f.company.id, actor);

    // The plugin goes away while a second account signs in.
    const second = await f.service.connectGalleryApp(f.company.id, { galleryKey: slug, connectionMethodKey: "mcp-oauth", name: "Second account" }, actor);
    await f.service.putConnectionInstalls(second.connectionId, { installs: [] });
    const secondStart = await f.service.startOAuth(f.company.id, second.connectionId, { redirectUri, actor });
    const original = f.provider.fetchFixture.getMockImplementation()!;
    f.provider.fetchFixture.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith("/oauth/token")) await db.update(plugins).set({ status: "uninstalled" }).where(eq(plugins.pluginKey, pluginKey));
      return original(url, init);
    });
    await expect(f.service.completeOAuthCallback({ state: new URL(secondStart.authorizationUrl).searchParams.get("state")!, code: "race-2", iss: origin, redirectUri, actor }))
      .rejects.toMatchObject({ status: 404 });
    f.provider.fetchFixture.mockImplementation(original);
    const [secondRow] = await db.select().from(toolConnections).where(eq(toolConnections.id, second.connectionId));
    expect(secondRow).toMatchObject({ status: "archived", enabled: false });
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, second.connectionId))).every(grant => grant.status === "revoked")).toBe(true);
    const rows = await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.company.id));
    expect(rows.filter(row => row.config.sourceTemplateKey === slug && row.status !== "archived").map(row => row.id)).toEqual([connected.connectionId]);
    await db.delete(plugins).where(eq(plugins.pluginKey, pluginKey));
  });

  // Live check against the real Circleback service. It never runs in CI:
  // set PAPERCLIP_CIRCLEBACK_LIVE=1 to run it. It registers a client with
  // Circleback for both connectors and compares the sign-in requests, up to
  // the point where a person would sign in.
  it.skipIf(process.env.PAPERCLIP_CIRCLEBACK_LIVE !== "1")("starts the same real Circleback sign-in for both connectors", async () => {
    const [company] = await db.insert(companies).values({ name: "Circleback live", issuePrefix: `CL${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    const [row] = await db.insert(plugins).values({ pluginKey: `${PLUGIN_KEY}-live-${randomUUID().slice(0, 8)}`, packageName: "@paperclipai/test-circleback-parity",
      version: fixtureManifest.version, manifestJson: fixtureManifest, status: "ready" }).returning();
    const service = toolAccessService(db);
    const signIn = async (galleryKey: string) => {
      const connected = await service.connectGalleryApp(company.id, { galleryKey, connectionMethodKey: "mcp-oauth" }, actor);
      const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri, actor });
      const url = new URL(start.authorizationUrl);
      return { registrationSource: start.registrationSource, origin: url.origin, path: url.pathname,
        scope: url.searchParams.get("scope"), resource: url.searchParams.get("resource"), method: url.searchParams.get("code_challenge_method") };
    };
    const core = await signIn("circleback");
    expect(core.registrationSource).toBe("dcr");
    expect(await signIn(pluginAppSlug(row!.pluginKey, "circleback"))).toEqual(core);
  }, 60_000);
});
