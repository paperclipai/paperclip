import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, createDb, heartbeatRuns, issues, plugins, principalPermissionGrants, toolConnectionInstalls,
} from "@paperclipai/db";
import { pluginAppSlug, pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { buildPaperclipRuntimeMcpServers } from "../services/heartbeat.js";
import { createAssignedMcpTools } from "../services/native-runtime/assigned-mcp-tools.js";
import { resolveNativeRuntimeMcpSnapshot } from "../services/native-runtime/runtime-context.js";
import { setPluginConnectorWorkers } from "../services/plugin-connector-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS, newStandardAgentGrantScope } from "../lib/agent-permissions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const PLUGIN_KEY = "example.install-gate";
const SHARED = pluginAppSlug(PLUGIN_KEY, "shared");
const PER_AGENT = pluginAppSlug(PLUGIN_KEY, "dedicated");
const OTHER = pluginAppSlug(PLUGIN_KEY, "other");
const tools = (prefix: string) => ({
  kind: "static" as const,
  list: [{ name: `${prefix}_lookup`, description: "Look up a record.", risk: "read" as const, parametersSchema: { type: "object" } }],
});
const app = (slug: string, method: Record<string, unknown>) => ({
  schemaVersion: 1, slug, name: `Gate ${slug}`, description: `${slug} records`, categories: ["developer"],
  branding: { logoUrl: "/brands/apps/api-key-generic.svg" }, urlPatterns: [],
  methods: [{ key: "none", transport: "plugin", auth: "none", ownershipModes: ["customer"], whenToUse: "Use it.",
    guidanceMd: "Connect it.", riskTier: "S1", ...method }],
});
const manifest = pluginManifestV1Schema.parse({
  id: PLUGIN_KEY, apiVersion: 1, version: "1.0.0", displayName: "Install gate", description: "Install gate connectors",
  author: "Tests", categories: ["connector"], capabilities: ["connectors.provide"], entrypoints: { worker: "worker.js" },
  apps: [
    app("shared", { tools: tools("shared") }),
    app("dedicated", { grantKinds: ["agent"], tools: tools("dedicated") }),
    app("other", { tools: tools("other") }),
  ],
}) as PaperclipPluginManifestV1;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("plugin connector tools need an install", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let keyDir: string;
  const workerCalls: Array<{ method: string; params: any }> = [];

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "plugin-install-gate-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    vi.stubEnv("PAPERCLIP_API_URL", "http://127.0.0.1:3100");
    temp = await startEmbeddedPostgresTestDatabase("paperclip-plugin-install-gate-");
    db = createDb(temp.connectionString);
    await db.insert(plugins).values({ pluginKey: PLUGIN_KEY, packageName: `@test/${PLUGIN_KEY}`, version: "1.0.0", manifestJson: manifest, status: "ready" });
    setPluginConnectorWorkers({
      isRunning: () => true,
      getWorker: () => ({ status: "running" }),
      call: vi.fn(async (_id: string, method: string, params: any) => {
        workerCalls.push({ method, params: structuredClone(params) });
        if (method === "executeTool") return { content: `ran ${params.toolName}` };
        throw new Error(`unexpected ${method}`);
      }),
    } as unknown as PluginWorkerManager);
  }, 60_000);
  afterAll(async () => {
    setPluginConnectorWorkers(null);
    await temp?.cleanup();
    vi.unstubAllEnvs();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });

  async function setup() {
    const [company] = await db.insert(companies).values({ name: "Install gate", issuePrefix: `IG${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: "board-user", status: "active", membershipRole: "admin" });
    const [agentA, agentB] = await db.insert(agents).values([
      { companyId: company!.id, name: "Installed", role: "engineer", adapterType: "process" },
      { companyId: company!.id, name: "Not installed", role: "engineer", adapterType: "process" },
    ]).returning();
    for (const agent of [agentA!, agentB!]) {
      await db.insert(principalPermissionGrants).values(NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS.map((permissionKey) => ({
        companyId: company!.id, principalType: "agent", principalId: agent.id, permissionKey,
        scope: newStandardAgentGrantScope(permissionKey, agent.id),
      })));
    }
    const routes = express();
    routes.use(express.json());
    routes.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", userName: "Board User", userEmail: null, isInstanceAdmin: true, source: "local_implicit" };
      next();
    });
    routes.use("/api", toolAccessRoutes(db, {}));
    routes.use(errorHandler);
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "plugin-install-gate-signing" });
    const runs = new Map<string, string>();
    const sessions = new Map<string, string>();
    for (const agent of [agentA!, agentB!]) {
      const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Work", assigneeAgentId: agent.id }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent.id, issueId: issue!.id, scopeKind: "issue",
        invocationSource: "on_demand", status: "running", responsibleUserId: "board-user", contextSnapshot: { issueId: issue!.id } }).returning();
      runs.set(agent.id, run!.id);
      sessions.set(agent.id, (await gateway.createSession({ companyId: company!.id, agentId: agent.id, runId: run!.id, issueId: issue!.id })).token);
    }
    const connect = async (body: Record<string, unknown>, agentIds: string[]) => {
      const connected = await request(routes).post(`/api/companies/${company!.id}/tools/apps/connect`).send(body);
      expect(connected.status, JSON.stringify(connected.body)).toBe(201);
      const finished = await request(routes).post(`/api/companies/${company!.id}/tools/apps/${connected.body.connectionId}/finish`)
        .send({ enabledCatalogEntryIds: connected.body.catalog.map((entry: { id: string }) => entry.id), askFirstCatalogEntryIds: [], access: { agentIds } });
      expect(finished.status, JSON.stringify(finished.body)).toBe(200);
      return connected.body.connectionId as string;
    };
    const gatewayTools = async (agentId: string) =>
      (await gateway.listToolsForSession(sessions.get(agentId)!)).filter((tool) => tool.providerType === "paperclip_plugin_connection");
    const runner = async (agentId: string) => {
      const agent = agentId === agentA!.id ? agentA! : agentB!;
      const runId = runs.get(agentId)!;
      const snapshot = await resolveNativeRuntimeMcpSnapshot({ db, agent, runId });
      const [server] = await buildPaperclipRuntimeMcpServers({ db, agent, runId, expectedAssignmentDigest: snapshot.digest });
      if (!server) return null;
      const gatewayPublicId = server.url.split("/").at(-1)!;
      const listed = await gateway.listToolsForNamedGateway({ gatewayPublicId, bearerToken: server.token });
      const assigned = await createAssignedMcpTools({ gateway, companyId: company!.id, gatewayPublicId, bearerToken: server.token });
      return { listed, assigned, gatewayPublicId, bearerToken: server.token };
    };
    return { company: company!, agentA: agentA!, agentB: agentB!, routes, gateway, sessions, connect, gatewayTools, runner };
  }

  const executeCalls = () => workerCalls.filter((call) => call.method === "executeTool").length;

  it.each([
    { label: "organization grant", body: { galleryKey: SHARED, connectionMethodKey: "none" }, perAgent: false },
    { label: "per-agent grant", body: { galleryKey: PER_AGENT, connectionMethodKey: "none", grantKind: "agent" }, perAgent: true },
  ])("gives the tools of a $label connection only to the installed agent", async ({ body, perAgent }) => {
    const f = await setup();
    const connectionId = await f.connect({ ...body, ...(perAgent ? { subjectAgentId: f.agentA.id } : {}) }, [f.agentA.id]);
    await f.connect({ galleryKey: OTHER, connectionMethodKey: "none" }, [f.agentB.id]);
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId));
    expect(installs.map((install) => install.targetId)).toEqual([f.agentA.id]);

    const toolA = (await f.gatewayTools(f.agentA.id)).find((tool) => tool.connectionId === connectionId)!;
    expect(toolA).toBeDefined();
    const runnerA = await f.runner(f.agentA.id);
    expect(runnerA!.listed.some((tool) => tool.connectionId === connectionId)).toBe(true);
    const before = executeCalls();
    await f.gateway.executeTool({ gatewayPublicId: runnerA!.gatewayPublicId, sessionToken: runnerA!.bearerToken, tool: toolA.name,
      parameters: {}, idempotencyKey: randomUUID() });
    expect(executeCalls()).toBe(before + 1);

    expect((await f.gatewayTools(f.agentB.id)).filter((tool) => tool.connectionId === connectionId)).toEqual([]);
    const runnerB = await f.runner(f.agentB.id);
    expect(runnerB!.listed.filter((tool) => tool.connectionId === connectionId)).toEqual([]);
    expect(runnerB!.listed.some((tool) => tool.upstreamToolName === "other_lookup")).toBe(true);
    const callsBefore = executeCalls();
    await expect(f.gateway.executeTool({ sessionToken: f.sessions.get(f.agentB.id)!, tool: toolA.name, parameters: {}, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ reasonCode: "deny_connection_not_installed" });
    await expect(f.gateway.executeTool({ gatewayPublicId: runnerB!.gatewayPublicId, sessionToken: runnerB!.bearerToken, tool: toolA.name,
      parameters: {}, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: expect.any(Number) });
    await expect(runnerB!.assigned.execute({ tool: "paperclip_call_assigned_tool", arguments: { name: toolA.name, arguments: {} } }))
      .rejects.toThrow();
    expect(executeCalls()).toBe(callsBefore);
  });

  it("gives the tools of a company-installed connection to every agent", async () => {
    const f = await setup();
    const connectionId = await f.connect({ galleryKey: SHARED, connectionMethodKey: "none" }, []);
    await request(f.routes).put(`/api/tool-connections/${connectionId}/installs`)
      .send({ installs: [{ targetType: "company", targetId: f.company.id }] }).expect(200);
    for (const agentId of [f.agentA.id, f.agentB.id]) {
      const tool = (await f.gatewayTools(agentId)).find((candidate) => candidate.connectionId === connectionId)!;
      expect(tool).toBeDefined();
      const before = executeCalls();
      await f.gateway.executeTool({ sessionToken: f.sessions.get(agentId)!, tool: tool.name, parameters: {}, idempotencyKey: randomUUID() });
      expect(executeCalls()).toBe(before + 1);
    }
  });
});
