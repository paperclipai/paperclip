import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues, plugins, toolCatalogEntries, toolConnections } from "@paperclipai/db";
import { pluginAppSlug, pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { setPluginConnectorWorkers } from "../services/plugin-connector-runtime.js";
import { paperclipDefinedTool } from "../services/connectors/paperclip-defined-tools.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const actor = { actorType: "user" as const, actorId: "plugin-definitions-admin" };
const PLUGIN_KEY = "example.reports";
const APP = "reports";
const SLUG = pluginAppSlug(PLUGIN_KEY, APP);

function reportsManifest(buildReportSchema: Record<string, unknown> = { type: "object" }, description = "Build a report.") {
  return pluginManifestV1Schema.parse({
    id: PLUGIN_KEY, apiVersion: 1, version: "1.0.0", displayName: "Reports", description: "Reports connector",
    author: "Tests", categories: ["connector"], capabilities: ["connectors.provide"], entrypoints: { worker: "worker.js" },
    apps: [{
      schemaVersion: 1, slug: APP, name: "Reports", description: "Build reports", categories: ["data"],
      branding: { logoUrl: "/brands/apps/api-key-generic.svg" }, urlPatterns: [],
      methods: [{
        key: "none", transport: "plugin", auth: "none", ownershipModes: ["customer"], whenToUse: "No sign-in.",
        guidanceMd: "Nothing to set up.", riskTier: "S1",
        tools: { kind: "static", list: [{ name: "build_report", description, risk: "read", parametersSchema: buildReportSchema }] },
      }],
    }],
  }) as PaperclipPluginManifestV1;
}

const UPGRADED_SCHEMA = { type: "object", properties: { order: { type: "string", enum: ["newest", "oldest"] } } };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("plugin connector tool definitions", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let keyDir: string;
  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "plugin-definitions-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    temp = await startEmbeddedPostgresTestDatabase("paperclip-plugin-definitions-");
    db = createDb(temp.connectionString);
  }, 60_000);
  afterAll(async () => { await temp?.cleanup(); vi.unstubAllEnvs(); if (keyDir) await rm(keyDir, { recursive: true, force: true }); });
  afterEach(async () => { setPluginConnectorWorkers(null); await db.delete(plugins); });

  async function connectedReports() {
    const [company] = await db.insert(companies).values({ name: "Plugin definitions", issuePrefix: `PD${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, status: "active", membershipRole: "admin" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Reporter", role: "engineer", adapterType: "process" }).returning();
    await db.insert(plugins).values({ pluginKey: PLUGIN_KEY, packageName: `@test/${PLUGIN_KEY}`, version: "1.0.0", manifestJson: reportsManifest(), status: "ready" });
    setPluginConnectorWorkers({ isRunning: () => true, getWorker: () => ({ status: "running" }), call: vi.fn() } as unknown as PluginWorkerManager);
    const service = toolAccessService(db);
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "plugin-definitions-signing" });
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Report", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue",
      invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId, contextSnapshot: { issueId: issue.id } }).returning();
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id, issueId: issue.id });
    const connected = await service.connectGalleryApp(company.id, { galleryKey: SLUG, connectionMethodKey: "none" }, actor);
    await service.finishGalleryAppConnection(company.id, connected.connectionId, {
      enabledCatalogEntryIds: connected.catalog.map(entry => entry.id), askFirstCatalogEntryIds: [], access: { agentIds: [agent.id] } }, actor);
    const buildReport = async () => (await gateway.listToolsForSession(session.token))
      .find(tool => tool.providerType === "paperclip_plugin_connection" && tool.upstreamToolName === "build_report")!;
    return { connectionId: connected.connectionId, buildReport, service };
  }

  async function upgradePlugin() {
    await db.update(plugins).set({ version: "1.1.0", manifestJson: reportsManifest(UPGRADED_SCHEMA, "Build a report, newest first.") as never });
  }

  it("gives agents the installed plugin's current tool schema after an upgrade, without a catalog refresh", async () => {
    const reports = await connectedReports();
    expect((await reports.buildReport()).parametersSchema).toEqual({ type: "object" });
    await upgradePlugin();
    const current = await reports.buildReport();
    expect(current.parametersSchema).toMatchObject({ properties: { order: { enum: ["newest", "oldest"] } } });
    expect(current.description).toContain("newest first");
  });

  it("keeps the reviewed schema while changed tools await review, and the catalog refresh quarantines them", async () => {
    const reports = await connectedReports();
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, reports.connectionId));
    await db.update(toolConnections).set({ config: { ...connection.config, quarantineNewEntries: true } })
      .where(eq(toolConnections.id, reports.connectionId));
    await upgradePlugin();
    expect((await reports.buildReport()).parametersSchema).toEqual({ type: "object" });
    await reports.service.refreshCatalog(reports.connectionId, actor);
    const [entry] = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, reports.connectionId));
    expect(entry.status).toBe("quarantined");
    expect(await reports.buildReport()).toBeUndefined();
  });

  it("never treats a plugin's tools as Paperclip-trusted for catalog review", async () => {
    const reports = await connectedReports();
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, reports.connectionId));
    expect(paperclipDefinedTool(connection, "build_report")).toBeNull();
  });
});
