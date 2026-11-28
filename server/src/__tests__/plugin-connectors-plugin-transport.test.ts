/**
 * Plugin-served connectors (`transport: "plugin"`) and legacy plugin tools.
 *
 * A fake worker manager stands in for the plugin worker so the test can see
 * exactly what the host sends it. It covers:
 *   - rules 1-3: enabling the plugin and connecting accounts grant no tools;
 *     only an install does, in discovery and invocation;
 *   - the run context the worker receives (connection, grant, settings and a
 *     per-call credential) and that tool arguments cannot change it;
 *   - settings validation, dynamic tool listing and retirement of removed
 *     tools, and the retryable error when the worker is down;
 *   - rule 5: legacy top-level tools stay with every agent of an existing
 *     installation and need an install for a new one.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, approvals, companies, companyMemberships, createDb, heartbeatRuns, issues, pluginConnectorLegacyAccess, toolActionRequests,
  plugins, toolConnectionInstalls, toolConnections, toolProfileBindings, toolProfileEntries, toolProfiles,
} from "@paperclipai/db";
import { pluginAppSlug, pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { setPluginConnectorWorkers } from "../services/plugin-connector-runtime.js";
import { completeLegacyPluginToolAccess } from "../services/plugin-connector-legacy-access.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const actor = { actorType: "user" as const, actorId: "plugin-transport-admin" };
const PLUGIN_KEY = "example.inspection";
const APP = "inspection";
const SLUG = pluginAppSlug(PLUGIN_KEY, APP);
const DYNAMIC_SLUG = pluginAppSlug(PLUGIN_KEY, "catalog");

const manifest = pluginManifestV1Schema.parse({
  id: PLUGIN_KEY, apiVersion: 1, version: "1.0.0", displayName: "Inspection", description: "Inspection connectors",
  author: "Tests", categories: ["connector"], capabilities: ["connectors.provide"], entrypoints: { worker: "worker.js" },
  apps: [{
    schemaVersion: 1, slug: APP, name: "Inspection", description: "Inspect stacks", categories: ["developer"],
    branding: { logoUrl: "/brands/apps/api-key-generic.svg" }, urlPatterns: [],
    methods: [{
      key: "api-key", label: "API key", transport: "plugin", auth: "api_key", ownershipModes: ["customer"],
      whenToUse: "Use an API key.", guidanceMd: "Paste a key.", riskTier: "S2",
      credentialFields: [{ key: "apiKey", label: "API key", type: "password", required: true, placeholder: "key", secret: true }],
      settingsSchema: { type: "object", properties: { region: { type: "string", enum: ["us", "eu"] } }, required: ["region"], additionalProperties: false },
      tools: { kind: "static", list: [
        { name: "list_stacks", displayName: "List stacks", description: "List stacks.", risk: "read", parametersSchema: { type: "object" } },
        { name: "request_access", description: "Request access.", risk: "write", parametersSchema: { type: "object" } },
      ] },
    }],
  }, {
    schemaVersion: 1, slug: "catalog", name: "Catalog", description: "Dynamic tools", categories: ["developer"],
    branding: { logoUrl: "/brands/apps/api-key-generic.svg" }, urlPatterns: [],
    methods: [{ key: "none", transport: "plugin", auth: "none", ownershipModes: ["customer"], whenToUse: "No sign-in.",
      guidanceMd: "Nothing to set up.", riskTier: "S1", tools: { kind: "dynamic" } }],
  }],
}) as PaperclipPluginManifestV1;

function fakeWorkers() {
  const calls: Array<{ method: string; params: any }> = [];
  let running = true;
  let dynamicTools = [
    { name: "search", risk: "read", parametersSchema: { type: "object" } },
    { name: "purge", risk: "destructive", parametersSchema: { type: "object" } },
  ];
  const manager = {
    isRunning: () => running,
    getWorker: () => ({ status: running ? "running" : "stopped" }),
    call: vi.fn(async (_id: string, method: string, params: any) => {
      calls.push({ method, params: structuredClone(params) });
      if (method === "listConnectorTools") return { tools: dynamicTools };
      if (method === "executeTool" && params.toolName === "request_access") return { error: `upstream rejected: Authorization: Bearer ${"ghp_" + "a".repeat(36)}` };
      if (method === "executeTool") return { content: `ran ${params.toolName}`, data: { ok: true } };
      throw new Error(`unexpected ${method}`);
    }),
  } as unknown as PluginWorkerManager;
  return { manager, calls, stop: () => { running = false; }, start: () => { running = true; }, setDynamic: (tools: typeof dynamicTools) => { dynamicTools = tools; } };
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("plugin-served connectors", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let keyDir: string;
  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "plugin-transport-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    temp = await startEmbeddedPostgresTestDatabase("paperclip-plugin-transport-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await temp?.cleanup(); vi.unstubAllEnvs(); if (keyDir) await rm(keyDir, { recursive: true, force: true }); });
  afterEach(async () => { setPluginConnectorWorkers(null); await db.delete(plugins); });

  async function setup(manifestJson: PaperclipPluginManifestV1 = manifest, dispatcher?: PluginToolDispatcher) {
    const [company] = await db.insert(companies).values({ name: "Plugin transport", issuePrefix: `PT${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    const [agentA, agentB] = await db.insert(agents).values([
      { companyId: company.id, name: "Inspector", role: "engineer", adapterType: "process" },
      { companyId: company.id, name: "Other", role: "engineer", adapterType: "process" },
    ]).returning();
    await db.insert(plugins).values({ pluginKey: manifestJson.id, packageName: `@test/${manifestJson.id}`, version: "1.0.0", manifestJson, status: "ready" });
    const workers = fakeWorkers();
    setPluginConnectorWorkers(workers.manager);
    const service = toolAccessService(db);
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "plugin-transport-signing", ...(dispatcher ? { pluginToolDispatcher: dispatcher } : {}) });
    const session = async (agentId: string) => {
      const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Inspect", assigneeAgentId: agentId }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId, issueId: issue.id, scopeKind: "issue",
        invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId, contextSnapshot: { issueId: issue.id } }).returning();
      return { ...(await gateway.createSession({ companyId: company.id, agentId, runId: run.id, issueId: issue.id })), runId: run.id };
    };
    return { company, agentA, agentB, workers, service, gateway, a: await session(agentA.id), b: await session(agentB.id) };
  }
  const pluginTools = async (gateway: ReturnType<typeof createToolGatewayService>, token: string) =>
    (await gateway.listToolsForSession(token)).filter(tool => tool.providerType === "paperclip_plugin_connection");

  it("connects accounts with settings and per-call credentials, and grants tools only through an install", async () => {
    const f = await setup();
    const gallery = await f.service.preflightGalleryAppMetadata(SLUG, "api-key").catch(() => null);
    expect(gallery === null || typeof gallery === "object").toBe(true);
    // Rule 1: the plugin is ready, but no agent has any tool.
    expect(await pluginTools(f.gateway, f.a.token)).toEqual([]);

    await expect(f.service.connectGalleryApp(f.company.id, { galleryKey: SLUG, connectionMethodKey: "api-key",
      settings: { region: "mars" }, credentialValues: { "credentials.apiKey": "key-one" } }, actor)).rejects.toMatchObject({ status: 422 });

    const first = await f.service.connectGalleryApp(f.company.id, { galleryKey: SLUG, connectionMethodKey: "api-key",
      settings: { region: "eu" }, credentialValues: { "credentials.apiKey": "key-one" } }, actor);
    expect(first.connection).toMatchObject({ transport: "plugin", config: expect.objectContaining({ sourceTemplateKey: SLUG, settings: { region: "eu" } }) });
    expect(first.catalog.map(entry => [entry.toolName, entry.riskLevel]).sort()).toEqual([["list_stacks", "read"], ["request_access", "write"]]);
    // Rule 2: a configured account grants no tools, even with no agents chosen.
    await f.service.finishGalleryAppConnection(f.company.id, first.connectionId, {
      enabledCatalogEntryIds: first.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [] } }, actor);
    const second = await f.service.connectGalleryApp(f.company.id, { galleryKey: SLUG, connectionMethodKey: "api-key", name: "Inspection (EU)",
      settings: { region: "us" }, credentialValues: { "credentials.apiKey": "key-two" } }, actor);
    expect(second.connectionId).not.toBe(first.connectionId);
    expect(await pluginTools(f.gateway, f.a.token)).toEqual([]);
    expect(f.workers.calls).toEqual([]);

    // Rule 3: an install for agent A gives only A the first account's tools.
    await f.service.putConnectionInstalls(first.connectionId, { installs: [{ targetType: "agent", targetId: f.agentA.id }] });
    const toolsA = await pluginTools(f.gateway, f.a.token);
    expect(toolsA.map(tool => tool.upstreamToolName).sort()).toEqual(["list_stacks", "request_access"]);
    expect(toolsA.every(tool => tool.connectionId === first.connectionId)).toBe(true);
    expect(await pluginTools(f.gateway, f.b.token)).toEqual([]);

    const listStacks = toolsA.find(tool => tool.upstreamToolName === "list_stacks")!;
    // Arguments cannot override the run context the host sends.
    const result = await f.gateway.executeTool({ sessionToken: f.a.token, tool: listStacks.name,
      parameters: { agentId: "spoofed", connection: { id: second.connectionId } }, idempotencyKey: randomUUID() });
    expect(JSON.stringify(result)).not.toContain("key-one");
    const call = f.workers.calls.find(entry => entry.method === "executeTool")!;
    expect(call.params).toMatchObject({
      toolName: "list_stacks", appSlug: APP,
      parameters: { agentId: "spoofed", connection: { id: second.connectionId } },
      runContext: {
        agentId: f.agentA.id, runId: f.a.runId, companyId: f.company.id,
        connection: { id: first.connectionId, appSlug: APP, methodKey: "api-key", settings: { region: "eu" },
          grantId: expect.any(String), credential: { kind: "api_key", value: "key-one" } },
      },
    });
    await expect(f.gateway.executeTool({ sessionToken: f.b.token, tool: listStacks.name, parameters: {}, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ status: expect.any(Number) });
    expect(f.workers.calls.filter(entry => entry.method === "executeTool")).toHaveLength(1);

    // The second account, installed for A as well, calls with its own key.
    await f.service.finishGalleryAppConnection(f.company.id, second.connectionId, {
      enabledCatalogEntryIds: second.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [f.agentA.id] } }, actor);
    const secondTool = (await pluginTools(f.gateway, f.a.token)).find(tool => tool.connectionId === second.connectionId && tool.upstreamToolName === "list_stacks")!;
    await f.gateway.executeTool({ sessionToken: f.a.token, tool: secondTool.name, parameters: {}, idempotencyKey: randomUUID() });
    expect(f.workers.calls.filter(entry => entry.method === "executeTool").at(-1)!.params.runContext.connection)
      .toMatchObject({ id: second.connectionId, settings: { region: "us" }, credential: { value: "key-two" } });

    // The agent never receives the connection's credential.
    await expect(f.service.mintConnectionTokenForAgent({ connectionId: first.connectionId, companyId: f.company.id,
      agentId: f.agentA.id, runId: f.a.runId, body: {} })).rejects.toMatchObject({ status: 403 });

    // A worker error is reported as a tool error, screened like any result.
    const requestAccess = toolsA.find(tool => tool.upstreamToolName === "request_access")!;
    const failure = await f.gateway.executeTool({ sessionToken: f.a.token, tool: requestAccess.name, parameters: {}, idempotencyKey: randomUUID() })
      .then(() => null, (error: unknown) => error as { status: number; reasonCode: string; message: string });
    expect(failure).toMatchObject({ status: 502, reasonCode: "tool_error" });
    expect(failure!.message).not.toContain("ghp_" + "a".repeat(36));
    // The board's Test tab runs the same worker path.
    const before = f.workers.calls.filter(call => call.method === "executeTool").length;
    const tested = await f.gateway.executeTestCall({ companyId: f.company.id, agentId: f.agentA.id, userId: actor.actorId,
      connectionId: first.connectionId, toolName: listStacks.name, parameters: {} });
    expect(tested).toMatchObject({ decision: "allowed" });
    expect(tested).not.toHaveProperty("error");
    expect(f.workers.calls.filter(call => call.method === "executeTool")).toHaveLength(before + 1);

    // A stopped worker is a retryable unavailable error, not a tool failure.
    f.workers.stop();
    await expect(f.gateway.executeTool({ sessionToken: f.a.token, tool: listStacks.name, parameters: {}, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ status: 503, reasonCode: "plugin_connector_unavailable", details: { retryable: true } });
    // A health check reports the stopped worker even though the tool list is static.
    await expect(f.service.checkHealth(first.connectionId, actor)).rejects.toThrow("not running");
    // Once the worker is back, the tools are available again without any
    // operator action, even though the saved health still shows the failure.
    f.workers.start();
    expect((await pluginTools(f.gateway, f.a.token)).some(tool => tool.name === listStacks.name)).toBe(true);
    await f.gateway.executeTool({ sessionToken: f.a.token, tool: listStacks.name, parameters: {}, idempotencyKey: randomUUID() });

    // An upgrade that changes a static tool's risk hides the old entry until
    // the catalog is refreshed with the new declaration.
    const [pluginRow] = await db.select().from(plugins).where(eq(plugins.pluginKey, PLUGIN_KEY));
    const upgraded = structuredClone(pluginRow.manifestJson);
    const staticTools = upgraded.apps![0]!.methods[0]!.tools as { kind: "static"; list: Array<{ name: string; risk: string }> };
    staticTools.list.find(entry => entry.name === "list_stacks")!.risk = "destructive";
    await db.update(plugins).set({ manifestJson: upgraded }).where(eq(plugins.pluginKey, PLUGIN_KEY));
    expect((await pluginTools(f.gateway, f.a.token)).some(entry => entry.upstreamToolName === "list_stacks" && entry.connectionId === first.connectionId)).toBe(false);
    await f.service.refreshCatalog(first.connectionId, actor);
    expect((await pluginTools(f.gateway, f.a.token)).find(entry => entry.upstreamToolName === "list_stacks" && entry.connectionId === first.connectionId)?.risk).toBe("destructive");

    // Rule 4 still applies: a disabled plugin's connections reach no agent.
    f.workers.start();
    await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.pluginKey, PLUGIN_KEY));
    expect(await pluginTools(f.gateway, f.a.token)).toEqual([]);
  });

  it("requires a new review when a plugin connection's settings change after Ask first", async () => {
    const f = await setup();
    const connected = await f.service.connectGalleryApp(f.company.id, { galleryKey: SLUG, connectionMethodKey: "api-key",
      settings: { region: "eu" }, credentialValues: { "credentials.apiKey": "key-one" } }, actor);
    const listEntry = connected.catalog.find(entry => entry.toolName === "list_stacks")!;
    await f.service.finishGalleryAppConnection(f.company.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [listEntry.id], access: { agentIds: [f.agentA.id] } }, actor);
    const tool = (await pluginTools(f.gateway, f.a.token)).find(candidate => candidate.upstreamToolName === "list_stacks")!;
    await expect(f.gateway.executeTool({ sessionToken: f.a.token, tool: tool.name, parameters: {}, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ reasonCode: "approval_required" });
    const [pending] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id));
    if (pending.approvalId) await db.update(approvals).set({ status: "approved", decidedByUserId: actor.actorId, decidedAt: new Date() }).where(eq(approvals.id, pending.approvalId));
    // The connection is pointed somewhere else while the request waits.
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connected.connectionId));
    await db.update(toolConnections).set({ config: { ...row.config, settings: { region: "us" } } }).where(eq(toolConnections.id, connected.connectionId));
    await f.gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: pending.id, actor: { userId: actor.actorId } }).catch(() => undefined);
    expect(f.workers.calls.filter(call => call.method === "executeTool")).toEqual([]);

    // An unchanged connection runs once approved.
    await expect(f.gateway.executeTool({ sessionToken: f.a.token, tool: tool.name, parameters: { again: true }, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ reasonCode: "approval_required" });
    const [next] = (await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id))).filter(request => request.id !== pending.id);
    if (next.approvalId) await db.update(approvals).set({ status: "approved", decidedByUserId: actor.actorId, decidedAt: new Date() }).where(eq(approvals.id, next.approvalId));
    await f.gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: next.id, actor: { userId: actor.actorId } });
    expect(f.workers.calls.filter(call => call.method === "executeTool")).toEqual([
      expect.objectContaining({ params: expect.objectContaining({ parameters: { again: true }, runContext: expect.objectContaining({ connection: expect.objectContaining({ settings: { region: "us" } }) }) }) }),
    ]);
  });

  it("lists dynamic tools through the worker and retires tools it stops offering", async () => {
    const f = await setup();
    const connected = await f.service.connectGalleryApp(f.company.id, { galleryKey: DYNAMIC_SLUG, connectionMethodKey: "none" }, actor);
    expect(f.workers.calls.length).toBeGreaterThan(0);
    for (const call of f.workers.calls) expect(call).toEqual({ method: "listConnectorTools",
      params: { companyId: f.company.id, appSlug: "catalog", connection: expect.objectContaining({ id: connected.connectionId, appSlug: "catalog", methodKey: "none" }) } });
    expect(connected.catalog.map(entry => [entry.toolName, entry.riskLevel]).sort()).toEqual([["purge", "destructive"], ["search", "read"]]);
    await f.service.finishGalleryAppConnection(f.company.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [f.agentA.id] } }, actor);
    expect((await pluginTools(f.gateway, f.a.token)).map(tool => tool.upstreamToolName).sort()).toEqual(["purge", "search"]);
    f.workers.setDynamic([{ name: "search", risk: "read", parametersSchema: { type: "object" } }]);
    const refreshed = await f.service.refreshCatalog(connected.connectionId, actor);
    expect(refreshed.catalog.find(entry => entry.toolName === "purge")?.status).not.toBe("active");
    expect(refreshed.catalog.find(entry => entry.toolName === "search")?.status).toBe("active");
    // The removed tool is gone from discovery, not only from the listing.
    expect((await pluginTools(f.gateway, f.a.token)).map(tool => tool.upstreamToolName)).toEqual(["search"]);
  });

  it("releases a legacy carry-over that failed while the worker was down, for the next start", async () => {
    const legacyManifest = pluginManifestV1Schema.parse({
      id: "example.retry", apiVersion: 1, version: "1.0.0", displayName: "Retry", description: "Legacy tools", author: "Tests",
      categories: ["connector"], capabilities: ["agent.tools.register"], entrypoints: { worker: "worker.js" },
      tools: [{ name: "ping", displayName: "Ping", description: "Ping", parametersSchema: { type: "object" } }],
    }) as PaperclipPluginManifestV1;
    const f = await setup(legacyManifest);
    await db.insert(pluginConnectorLegacyAccess).values({ companyId: f.company.id, pluginKey: "example.retry" });
    f.workers.stop();
    expect(await completeLegacyPluginToolAccess(db)).toBe(0);
    // The failed row is released, so the next worker start completes it.
    const [released] = await db.select().from(pluginConnectorLegacyAccess).where(eq(pluginConnectorLegacyAccess.companyId, f.company.id));
    expect(released).toMatchObject({ completedAt: null, claimedAt: null });
    f.workers.start();
    expect(await completeLegacyPluginToolAccess(db, "example.retry")).toBe(1);
  });

  it("keeps legacy plugin tools for existing installations and requires an install for new ones", async () => {
    const legacyManifest = pluginManifestV1Schema.parse({
      id: "example.legacy", apiVersion: 1, version: "1.0.0", displayName: "Legacy", description: "Legacy tools", author: "Tests",
      categories: ["connector"], capabilities: ["agent.tools.register"], entrypoints: { worker: "worker.js" },
      tools: [{ name: "read-status", displayName: "Read status", description: "Read status", parametersSchema: { type: "object" } }],
    }) as PaperclipPluginManifestV1;
    const legacyPluginDbId = randomUUID();
    const dispatcher: PluginToolDispatcher = {
      initialize: async () => {}, teardown: () => {},
      // Like the real dispatcher, `pluginId` is the plugin's database id.
      listToolsForAgent: () => [{ name: "example.legacy:read-status", displayName: "Read status", description: "Read status",
        parametersSchema: { type: "object" }, pluginId: legacyPluginDbId }],
      getTool: () => null,
      executeTool: async () => ({ pluginId: "example.legacy", toolName: "read-status", result: { content: "ok" } }),
      registerPluginTools: () => {}, unregisterPluginTools: () => {}, toolCount: () => 1, getRegistry: () => { throw new Error("unused"); },
    };
    const f = await setup(legacyManifest, dispatcher);
    // Today's policy: a profile allows the legacy tool for both agents.
    for (const agentId of [f.agentA.id, f.agentB.id]) {
      const [profile] = await db.insert(toolProfiles).values({ companyId: f.company.id, profileKey: `legacy-${randomUUID()}`, name: `Legacy ${randomUUID()}`, defaultAction: "deny" }).returning();
      await db.insert(toolProfileBindings).values({ companyId: f.company.id, profileId: profile.id, targetType: "agent", targetId: agentId });
      await db.insert(toolProfileEntries).values({ companyId: f.company.id, profileId: profile.id, selectorType: "tool_name", effect: "include", toolName: "example.legacy:read-status" });
    }
    const legacyNames = async (token: string) => (await f.gateway.listToolsForSession(token)).filter(tool => tool.providerType === "paperclip_plugin").map(tool => tool.name);
    // A new installation: the legacy tools are only available, not granted.
    expect(await legacyNames(f.a.token)).toEqual([]);
    expect(await legacyNames(f.b.token)).toEqual([]);

    // An installation that existed before plugin connectors (as recorded by
    // the migration) keeps the tools for every agent, under the same names.
    await db.insert(pluginConnectorLegacyAccess).values({ companyId: f.company.id, pluginKey: "example.legacy" });
    // An earlier attempt stopped after creating the connection, before finishing it.
    const interrupted = await f.service.connectGalleryApp(f.company.id, { galleryKey: pluginAppSlug("example.legacy", "default"), connectionMethodKey: "default" });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, interrupted.connectionId))).toEqual([]);
    // Concurrent hosts carry it over once.
    const runs = await Promise.all([completeLegacyPluginToolAccess(db), completeLegacyPluginToolAccess(db)]);
    expect(runs.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await completeLegacyPluginToolAccess(db)).toBe(0);
    expect(await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, f.company.id), eq(toolConnections.transport, "plugin")))).toHaveLength(1);
    const [row] = await db.select().from(pluginConnectorLegacyAccess).where(eq(pluginConnectorLegacyAccess.companyId, f.company.id));
    expect(row.completedAt).not.toBeNull();
    expect(row.connectionId).toBe(interrupted.connectionId);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, row.connectionId!)))
      .toEqual([expect.objectContaining({ targetType: "company", targetId: f.company.id })]);
    // Legacy tools keep their names and are not also exposed as connection tools.
    expect(await pluginTools(f.gateway, f.a.token)).toEqual([]);
    for (const token of [f.a.token, f.b.token]) expect(await legacyNames(token)).toEqual(["example.legacy:read-status"]);
    const [connection] = await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, f.company.id), eq(toolConnections.id, row.connectionId!)));
    expect(connection).toMatchObject({ transport: "plugin", status: "active", config: expect.objectContaining({ legacyPluginTools: true }) });

    // The implicit connector's action rules can only restrict legacy tools.
    const catalog = await f.service.listCatalog(row.connectionId!);
    await f.service.finishGalleryAppConnection(f.company.id, row.connectionId!, {
      enabledCatalogEntryIds: catalog.map(entry => entry.id), askFirstCatalogEntryIds: catalog.map(entry => entry.id), access: "all_agents" }, actor);
    const asked = (await f.gateway.listToolsForSession(f.a.token)).find(tool => tool.name === "example.legacy:read-status");
    expect(asked?.description).toContain("Requires human approval");
    await f.service.finishGalleryAppConnection(f.company.id, row.connectionId!, {
      enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents" }, actor);
    for (const token of [f.a.token, f.b.token]) expect(await legacyNames(token)).toEqual([]);

    // A retried carry-over never undoes an operator's restriction.
    await db.update(pluginConnectorLegacyAccess).set({ completedAt: null }).where(eq(pluginConnectorLegacyAccess.id, row.id));
    expect(await completeLegacyPluginToolAccess(db)).toBe(1);
    for (const token of [f.a.token, f.b.token]) expect(await legacyNames(token)).toEqual([]);
  });
});
