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
(support.supported ? describe : describe.skip)("plugin connector tool definitions", () => {
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

  it("gives agents the installed plugin's current tool schema after an upgrade, without a catalog refresh", async () => {
    const manifest = pluginManifestV1Schema.parse(slowManifest()) as PaperclipPluginManifestV1;
    const f = await setup(manifest, { delayMs: 0 });
    const before = await connectReports(f);
    expect(Object.keys((before.buildReport.parametersSchema as { properties?: Record<string, unknown> }).properties ?? {})).toEqual([]);

    const upgraded = structuredClone(manifest) as unknown as { version: string; apps: Array<{ methods: Array<{ tools: { list: Array<Record<string, unknown>> } }> }> };
    upgraded.version = "1.1.0";
    const tool = upgraded.apps[0]!.methods[0]!.tools.list.find((candidate) => candidate.name === "build_report")!;
    tool.parametersSchema = { type: "object", properties: { order: { type: "string", enum: ["newest", "oldest"] } } };
    tool.description = "Build a report, newest first.";
    await db.update(plugins).set({ version: "1.1.0", manifestJson: pluginManifestV1Schema.parse(upgraded) as never });

    const tools = (await f.gateway.listToolsForSession(f.token)).filter(candidate => candidate.providerType === "paperclip_plugin_connection");
    const current = tools.find(candidate => candidate.upstreamToolName === "build_report")!;
    expect(current.parametersSchema).toMatchObject({ properties: { order: { enum: ["newest", "oldest"] } } });
    expect(current.description).toContain("newest first");
  });
});
