import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, createDb, heartbeatRuns, issues, plugins, pluginConnectorLegacyAccess,
  toolProfileBindings, toolProfileEntries, toolProfiles,
} from "@paperclipai/db";
import { pluginAppSlug, pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { setPluginConnectorWorkers } from "../services/plugin-connector-runtime.js";
import { completeLegacyPluginToolAccess } from "../services/plugin-connector-legacy-access.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const actor = { actorType: "user" as const, actorId: "plugin-timeout-admin" };
const PLUGIN_KEY = "example.slow";
const APP = "reports";
const SLUG = pluginAppSlug(PLUGIN_KEY, APP);
const BACKEND_DELAY_MS = 12_000;

function slowManifest(method: { timeoutMs?: number; quickTimeoutMs?: number } = {}) {
  return {
    id: PLUGIN_KEY, apiVersion: 1, version: "1.0.0", displayName: "Slow reports", description: "Slow backend",
    author: "Tests", categories: ["connector"], capabilities: ["connectors.provide"], entrypoints: { worker: "worker.js" },
    apps: [{
      schemaVersion: 1, slug: APP, name: "Reports", description: "Build reports", categories: ["data"],
      branding: { logoUrl: "/brands/apps/api-key-generic.svg" }, urlPatterns: [],
      methods: [{
        key: "none", transport: "plugin", auth: "none", ownershipModes: ["customer"], whenToUse: "No sign-in.",
        guidanceMd: "Nothing to set up.", riskTier: "S1",
        ...(method.timeoutMs !== undefined ? { timeoutMs: method.timeoutMs } : {}),
        tools: { kind: "static", list: [
          { name: "build_report", description: "Build a report.", risk: "read", parametersSchema: { type: "object" } },
          { name: "quick_check", description: "Check quickly.", risk: "read", parametersSchema: { type: "object" },
            ...(method.quickTimeoutMs !== undefined ? { timeoutMs: method.quickTimeoutMs } : {}) },
        ] },
      }],
    }],
  };
}

function slowWorkers(delayMs: number) {
  const calls: Array<{ method: string; params: any; timeoutMs?: number }> = [];
  const manager = {
    isRunning: () => true,
    getWorker: () => ({ status: "running" }),
    call: vi.fn((_id: string, method: string, params: any, timeoutMs?: number) => {
      calls.push({ method, params: structuredClone(params), timeoutMs });
      if (method !== "executeTool") return Promise.reject(new Error(`unexpected ${method}`));
      return new Promise((resolve) => setTimeout(() => resolve({ content: `ran ${params.toolName}` }), delayMs));
    }),
  } as unknown as PluginWorkerManager;
  return { manager, calls };
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("plugin connector tool timeouts", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let keyDir: string;
  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "plugin-timeout-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    temp = await startEmbeddedPostgresTestDatabase("paperclip-plugin-timeout-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await temp?.cleanup(); vi.unstubAllEnvs(); if (keyDir) await rm(keyDir, { recursive: true, force: true }); });
  afterEach(async () => { vi.useRealTimers(); setPluginConnectorWorkers(null); await db.delete(plugins); });

  async function setup(manifestJson: PaperclipPluginManifestV1, options: { delayMs?: number; dispatcher?: PluginToolDispatcher } = {}) {
    const [company] = await db.insert(companies).values({ name: "Plugin timeouts", issuePrefix: `PO${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Reporter", role: "engineer", adapterType: "process" }).returning();
    await db.insert(plugins).values({ pluginKey: manifestJson.id, packageName: `@test/${manifestJson.id}`, version: "1.0.0", manifestJson, status: "ready" });
    const workers = slowWorkers(options.delayMs ?? BACKEND_DELAY_MS);
    setPluginConnectorWorkers(workers.manager);
    const service = toolAccessService(db);
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "plugin-timeout-signing",
      ...(options.dispatcher ? { pluginToolDispatcher: options.dispatcher } : {}),
    });
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Report", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue",
      invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId, contextSnapshot: { issueId: issue.id } }).returning();
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id, issueId: issue.id });
    return { company, agent, workers, service, gateway, token: session.token };
  }

  async function connectReports(f: Awaited<ReturnType<typeof setup>>) {
    const connected = await f.service.connectGalleryApp(f.company.id, { galleryKey: SLUG, connectionMethodKey: "none" }, actor);
    await f.service.finishGalleryAppConnection(f.company.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [f.agent.id] } }, actor);
    const tools = (await f.gateway.listToolsForSession(f.token)).filter(tool => tool.providerType === "paperclip_plugin_connection");
    const tool = (name: string) => tools.find(candidate => candidate.upstreamToolName === name)!;
    return { connectionId: connected.connectionId, buildReport: tool("build_report"), quickCheck: tool("quick_check") };
  }

  async function settleAfter<T>(f: { workers: { calls: unknown[] } }, start: () => Promise<T>, advanceMs: number) {
    const before = f.workers.calls.length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const pending = start().then((value) => ({ value }), (error: unknown) => ({ error: error as { status?: number; reasonCode?: string } }));
    await vi.waitFor(() => expect(f.workers.calls.length).toBe(before + 1), { timeout: 20_000, interval: 5 });
    await vi.advanceTimersByTimeAsync(advanceMs);
    const outcome = await pending;
    vi.useRealTimers();
    return outcome;
  }

  const timedOut = { error: expect.objectContaining({ status: 504, reasonCode: "tool_timeout" }) };

  it("waits for the method's declared timeoutMs on session and test calls", async () => {
    const f = await setup(pluginManifestV1Schema.parse(slowManifest({ timeoutMs: 30_000 })) as PaperclipPluginManifestV1);
    const { connectionId, buildReport } = await connectReports(f);

    const call = await settleAfter(f, () => f.gateway.executeTool({ sessionToken: f.token, tool: buildReport.name, parameters: {}, idempotencyKey: randomUUID() }), BACKEND_DELAY_MS);
    expect(call).toMatchObject({ value: { status: "completed" } });
    expect(f.workers.calls.at(-1)).toMatchObject({ method: "executeTool", timeoutMs: 31_000 });

    const tested = await settleAfter(f, () => f.gateway.executeTestCall({ companyId: f.company.id, agentId: f.agent.id, userId: actor.actorId,
      connectionId, toolName: buildReport.name, parameters: {} }), BACKEND_DELAY_MS);
    expect(tested).toMatchObject({ value: { decision: "allowed" } });
    expect(tested).not.toHaveProperty("value.error");
  });

  it("times out at a tool's declared timeoutMs when the backend is slower", async () => {
    const f = await setup(pluginManifestV1Schema.parse(slowManifest({ timeoutMs: 30_000, quickTimeoutMs: 5_000 })) as PaperclipPluginManifestV1);
    const { quickCheck } = await connectReports(f);
    const call = await settleAfter(f, () => f.gateway.executeTool({ sessionToken: f.token, tool: quickCheck.name, parameters: {}, idempotencyKey: randomUUID() }), 5_000);
    expect(call).toMatchObject(timedOut);
    expect(f.workers.calls.at(-1)).toMatchObject({ timeoutMs: 6_000 });
  });

  it("prefers an explicit caller timeout below the declared value", async () => {
    const f = await setup(pluginManifestV1Schema.parse(slowManifest({ timeoutMs: 30_000 })) as PaperclipPluginManifestV1);
    const { buildReport } = await connectReports(f);
    const call = await settleAfter(f, () => f.gateway.executeTool({ sessionToken: f.token, tool: buildReport.name, parameters: {},
      timeoutMs: 5_000, idempotencyKey: randomUUID() }), 5_000);
    expect(call).toMatchObject(timedOut);
    expect(f.workers.calls.at(-1)).toMatchObject({ timeoutMs: 6_000 });
  });

  it("waits 30 s for plugin tools that declare no timeout", async () => {
    const f = await setup(pluginManifestV1Schema.parse(slowManifest()) as PaperclipPluginManifestV1);
    const { buildReport } = await connectReports(f);
    const call = await settleAfter(f, () => f.gateway.executeTool({ sessionToken: f.token, tool: buildReport.name, parameters: {}, idempotencyKey: randomUUID() }), BACKEND_DELAY_MS);
    expect(call).toMatchObject({ value: { status: "completed" } });
    expect(f.workers.calls.at(-1)).toMatchObject({ timeoutMs: 31_000 });

    setPluginConnectorWorkers(null);
    const slower = slowWorkers(45_000);
    f.workers.calls.length = 0;
    setPluginConnectorWorkers(slower.manager);
    const late = await settleAfter({ workers: slower }, () => f.gateway.executeTool({ sessionToken: f.token, tool: buildReport.name, parameters: {}, idempotencyKey: randomUUID() }), 30_000);
    expect(late).toMatchObject(timedOut);
  });

  it("rejects declared timeouts outside 1-60 s and clamps caller timeouts to the 60 s ceiling", async () => {
    expect(pluginManifestV1Schema.safeParse(slowManifest({ timeoutMs: 60_000 })).success).toBe(true);
    for (const bad of [{ timeoutMs: 60_001 }, { timeoutMs: 120_000 }, { timeoutMs: 999 }, { timeoutMs: 1_500.5 }, { quickTimeoutMs: 90_000 }]) {
      expect(pluginManifestV1Schema.safeParse(slowManifest(bad)).success).toBe(false);
    }

    const f = await setup(pluginManifestV1Schema.parse(slowManifest()) as PaperclipPluginManifestV1, { delayMs: 90_000 });
    const { buildReport } = await connectReports(f);
    const call = await settleAfter(f, () => f.gateway.executeTool({ sessionToken: f.token, tool: buildReport.name, parameters: {},
      timeoutMs: 120_000, idempotencyKey: randomUUID() }), 60_000);
    expect(call).toMatchObject(timedOut);
    expect(f.workers.calls.at(-1)).toMatchObject({ timeoutMs: 61_000 });
  });
  it("leaves legacy plugin tools on their own deadline path", async () => {
    const legacyManifest = pluginManifestV1Schema.parse({
      id: "example.legacy-slow", apiVersion: 1, version: "1.0.0", displayName: "Legacy slow", description: "Legacy tools", author: "Tests",
      categories: ["connector"], capabilities: ["agent.tools.register"], entrypoints: { worker: "worker.js" },
      tools: [{ name: "read-status", displayName: "Read status", description: "Read status", parametersSchema: { type: "object" } }],
    }) as PaperclipPluginManifestV1;
    const legacyPluginDbId = randomUUID();
    const dispatched: string[] = [];
    const dispatcher: PluginToolDispatcher = {
      initialize: async () => {}, teardown: () => {},
      listToolsForAgent: () => [{ name: "example.legacy-slow:read-status", displayName: "Read status", description: "Read status",
        parametersSchema: { type: "object" }, pluginId: legacyPluginDbId }],
      getTool: () => null,
      executeTool: (toolName) => {
        dispatched.push(toolName);
        return new Promise((resolve) => setTimeout(() => resolve({ pluginId: "example.legacy-slow", toolName: "read-status", result: { content: "ok" } }), BACKEND_DELAY_MS));
      },
      registerPluginTools: () => {}, unregisterPluginTools: () => {}, toolCount: () => 1, getRegistry: () => { throw new Error("unused"); },
    };
    const f = await setup(legacyManifest, { dispatcher });
    const [profile] = await db.insert(toolProfiles).values({ companyId: f.company.id, profileKey: `legacy-${randomUUID()}`, name: `Legacy ${randomUUID()}`, defaultAction: "deny" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: f.company.id, profileId: profile.id, targetType: "agent", targetId: f.agent.id });
    await db.insert(toolProfileEntries).values({ companyId: f.company.id, profileId: profile.id, selectorType: "tool_name", effect: "include", toolName: "example.legacy-slow:read-status" });
    await db.insert(pluginConnectorLegacyAccess).values({ companyId: f.company.id, pluginKey: "example.legacy-slow" });
    expect(await completeLegacyPluginToolAccess(db)).toBe(1);
    const tool = (await f.gateway.listToolsForSession(f.token)).find(candidate => candidate.name === "example.legacy-slow:read-status")!;
    expect(tool.providerType).toBe("paperclip_plugin");
    const call = await settleAfter({ workers: { calls: dispatched } }, () => f.gateway.executeTool({ sessionToken: f.token, tool: tool.name, parameters: {},
      timeoutMs: 5_000, idempotencyKey: randomUUID() }), 5_000);
    expect(call).toMatchObject(timedOut);
    expect(f.workers.calls).toEqual([]);
  });
});
