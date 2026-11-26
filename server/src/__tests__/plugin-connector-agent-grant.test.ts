/**
 * A plugin connector method that declares agent grants and has no sign-in step
 * (`auth: "none"` or `"api_key"`) must work like any per-agent connector when
 * an operator connects it through the real routes:
 *   - connect for one agent creates that agent's grant (with the API key for
 *     `api_key`) but exposes no tools;
 *   - finish with that agent creates the install, and only that agent's
 *     gateway discovery lists the tools;
 *   - organization-grant methods keep their default organization grant;
 *   - a Paperclip Runner session (the run-scoped assigned-tool gateway) lists
 *     installed plugin-transport tools, like it does for MCP connections.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, connectionGrants, createDb, heartbeatRuns, issues, plugins, toolConnectionInstalls, toolConnections,
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
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const PLUGIN_KEY = "example.agent-grants";
const NO_SIGN_IN = pluginAppSlug(PLUGIN_KEY, "open");
const API_KEY = pluginAppSlug(PLUGIN_KEY, "keyed");
const SHARED = pluginAppSlug(PLUGIN_KEY, "shared");
const staticTools = {
  kind: "static" as const,
  list: [
    { name: "lookup", description: "Look up a record.", risk: "read" as const, parametersSchema: { type: "object" } },
    { name: "update_record", description: "Update a record.", risk: "write" as const, parametersSchema: { type: "object" } },
  ],
};
const app = (slug: string, name: string, method: Record<string, unknown>) => ({
  schemaVersion: 1, slug, name, description: `${name} records`, categories: ["developer"],
  branding: { logoUrl: "/brands/apps/api-key-generic.svg" }, urlPatterns: [],
  methods: [{ transport: "plugin", ownershipModes: ["customer"], whenToUse: "Use it.", guidanceMd: "Connect it.",
    riskTier: "S1", tools: staticTools, ...method }],
});
const manifest = pluginManifestV1Schema.parse({
  id: PLUGIN_KEY, apiVersion: 1, version: "1.0.0", displayName: "Agent grants", description: "Per-agent connectors",
  author: "Tests", categories: ["connector"], capabilities: ["connectors.provide"], entrypoints: { worker: "worker.js" },
  apps: [
    app("open", "Open records", { key: "none", auth: "none", grantKinds: ["agent"] }),
    app("keyed", "Keyed records", {
      key: "api-key", auth: "api_key", grantKinds: ["agent"],
      credentialFields: [{ key: "apiKey", label: "API key", type: "password", required: true, placeholder: "key", secret: true }],
    }),
    app("shared", "Shared records", { key: "none", auth: "none" }),
  ],
}) as PaperclipPluginManifestV1;

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("plugin connector with agent grants and no sign-in", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let keyDir: string;
  const workerCalls: Array<{ method: string; params: any }> = [];

  beforeAll(async () => {
    keyDir = await mkdtemp(join(tmpdir(), "plugin-agent-grant-secrets-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", join(keyDir, "key"));
    vi.stubEnv("PAPERCLIP_API_URL", "http://127.0.0.1:3100");
    temp = await startEmbeddedPostgresTestDatabase("paperclip-plugin-agent-grant-");
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
    const [company] = await db.insert(companies).values({ name: "Agent grants", issuePrefix: `AG${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company!.id, principalType: "user", principalId: "board-user", status: "active", membershipRole: "admin" });
    const [agentA, agentB] = await db.insert(agents).values([
      { companyId: company!.id, name: "Owner", role: "engineer", adapterType: "process" },
      { companyId: company!.id, name: "Other", role: "engineer", adapterType: "process" },
    ]).returning();
    const routes = express();
    routes.use(express.json());
    routes.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", userName: "Board User", userEmail: null, isInstanceAdmin: true, source: "local_implicit" };
      next();
    });
    routes.use("/api", toolAccessRoutes(db, {}));
    routes.use(errorHandler);
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "plugin-agent-grant-signing" });
    const session = async (agentId: string) => {
      const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Use records", assigneeAgentId: agentId }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId, issueId: issue!.id, scopeKind: "issue",
        invocationSource: "on_demand", status: "running", responsibleUserId: "board-user", contextSnapshot: { issueId: issue!.id } }).returning();
      runIds.set(agentId, run!.id);
      return (await gateway.createSession({ companyId: company!.id, agentId, runId: run!.id, issueId: issue!.id })).token;
    };
    const runIds = new Map<string, string>();
    const tools = async (token: string) =>
      (await gateway.listToolsForSession(token)).filter((tool) => tool.providerType === "paperclip_plugin_connection");
    const tokenA = await session(agentA!.id);
    const tokenB = await session(agentB!.id);
    /** The tools a Paperclip Runner run sees: the run-scoped assigned-tool gateway built at run start. */
    const runnerTools = async (agent: typeof agentA) => {
      const runId = runIds.get(agent!.id)!;
      const snapshot = await resolveNativeRuntimeMcpSnapshot({ db, agent: agent!, runId });
      const servers = await buildPaperclipRuntimeMcpServers({ db, agent: agent!, runId, expectedAssignmentDigest: snapshot.digest });
      if (servers.length === 0) return { definitions: [] as Array<{ name: string }>, search: async () => [] as string[] };
      const assigned = await createAssignedMcpTools({ gateway, companyId: company!.id,
        gatewayPublicId: servers[0]!.url.split("/").at(-1)!, bearerToken: servers[0]!.token });
      return {
        definitions: assigned.definitions(),
        search: async (query: string) => ((await assigned.execute({ tool: "paperclip_search_assigned_tools", arguments: { query } })) as { tools: Array<{ name: string }> })
          .tools.map((tool) => tool.name),
      };
    };
    return { company: company!, agentA: agentA!, agentB: agentB!, routes, gateway, tools, runnerTools, tokenA, tokenB };
  }

  async function connectAndFinish(f: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown>, access: unknown) {
    const connected = await request(f.routes).post(`/api/companies/${f.company.id}/tools/apps/connect`).send(body);
    expect(connected.status, JSON.stringify(connected.body)).toBe(201);
    // Rule 2: a configured connection alone gives no agent any tool.
    expect(await f.tools(f.tokenA)).toEqual([]);
    expect(await f.tools(f.tokenB)).toEqual([]);
    const connectionId = connected.body.connectionId as string;
    const catalogIds = (connected.body.catalog as Array<{ id: string }>).map((entry) => entry.id);
    expect(catalogIds).toHaveLength(2);
    const finished = await request(f.routes).post(`/api/companies/${f.company.id}/tools/apps/${connectionId}/finish`)
      .send({ enabledCatalogEntryIds: catalogIds, askFirstCatalogEntryIds: [], access });
    expect(finished.status, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body.connection).toMatchObject({ status: "active", enabled: true });
    const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connectionId));
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId));
    return { connectionId, connectBody: connected.body, grants, installs };
  }

  it("gives only the chosen agent the tools of a no-sign-in method", async () => {
    const f = await setup();
    const result = await connectAndFinish(f, { galleryKey: NO_SIGN_IN, connectionMethodKey: "none", grantKind: "agent", subjectAgentId: f.agentA.id },
      { agentIds: [f.agentA.id] });
    expect(result.connectBody.connection).toMatchObject({ credentialPolicy: "per_agent" });
    expect(result.grants.map((grant) => ({ kind: grant.kind, subjectAgentId: grant.subjectAgentId, status: grant.status })))
      .toEqual([{ kind: "agent", subjectAgentId: f.agentA.id, status: "active" }]);
    expect(result.installs.map((install) => [install.targetType, install.targetId])).toEqual([["agent", f.agentA.id]]);
    expect((await f.tools(f.tokenA)).map((tool) => tool.upstreamToolName).sort()).toEqual(["lookup", "update_record"]);
    expect(await f.tools(f.tokenB)).toEqual([]);
  });

  it("stores the API key on the chosen agent's grant and serves the tools only to that agent", async () => {
    const f = await setup();
    const result = await connectAndFinish(f, { galleryKey: API_KEY, connectionMethodKey: "api-key", grantKind: "agent", subjectAgentId: f.agentA.id,
      credentialValues: { "credentials.apiKey": "agent-key-1" } }, { agentIds: [f.agentA.id] });
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0]).toMatchObject({ kind: "agent", subjectAgentId: f.agentA.id, status: "active" });
    expect(result.grants[0]!.credentialSecretRefs.map((ref) => ref.configPath)).toEqual(["credentials.apiKey"]);
    // The key belongs to the agent's grant, never to a shared connection credential.
    expect(result.connectBody.connection.credentialSecretRefs ?? []).toEqual([]);
    const toolsA = await f.tools(f.tokenA);
    expect(toolsA.map((tool) => tool.upstreamToolName).sort()).toEqual(["lookup", "update_record"]);
    expect(await f.tools(f.tokenB)).toEqual([]);

    const lookup = toolsA.find((tool) => tool.upstreamToolName === "lookup")!;
    await f.gateway.executeTool({ sessionToken: f.tokenA, tool: lookup.name, parameters: {}, idempotencyKey: randomUUID() });
    expect(workerCalls.filter((call) => call.method === "executeTool").at(-1)!.params.runContext).toMatchObject({
      agentId: f.agentA.id,
      connection: { id: result.connectionId, grantId: result.grants[0]!.id, credential: { kind: "api_key", value: "agent-key-1" } },
    });
  });

  it("refuses a second agent's identity on the same connection and an agent grant without an agent", async () => {
    const f = await setup();
    const missing = await request(f.routes).post(`/api/companies/${f.company.id}/tools/apps/connect`)
      .send({ galleryKey: NO_SIGN_IN, connectionMethodKey: "none", grantKind: "agent" });
    expect(missing.status).toBe(400);
    const connected = await request(f.routes).post(`/api/companies/${f.company.id}/tools/apps/connect`)
      .send({ galleryKey: NO_SIGN_IN, connectionMethodKey: "none", grantKind: "agent", subjectAgentId: f.agentA.id });
    expect(connected.status).toBe(201);
    const resumed = await request(f.routes).post(`/api/companies/${f.company.id}/tools/apps/connect`)
      .send({ galleryKey: NO_SIGN_IN, connectionMethodKey: "none", resumeConnectionId: connected.body.connectionId, grantKind: "agent", subjectAgentId: f.agentB.id });
    expect(resumed.status).toBe(409);
    const grants = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.connectionId, connected.body.connectionId), eq(connectionGrants.kind, "agent")));
    expect(grants.map((grant) => grant.subjectAgentId)).toEqual([f.agentA.id]);
  });

  it("resumes an API-key draft for the same agent without asking for the key again", async () => {
    const f = await setup();
    const connected = await request(f.routes).post(`/api/companies/${f.company.id}/tools/apps/connect`)
      .send({ galleryKey: API_KEY, connectionMethodKey: "api-key", grantKind: "agent", subjectAgentId: f.agentA.id,
        credentialValues: { "credentials.apiKey": "agent-key-2" } });
    expect(connected.status).toBe(201);
    const resumed = await request(f.routes).post(`/api/companies/${f.company.id}/tools/apps/connect`)
      .send({ galleryKey: API_KEY, connectionMethodKey: "api-key", resumeConnectionId: connected.body.connectionId });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(201);
    const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connected.body.connectionId));
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ kind: "agent", subjectAgentId: f.agentA.id, status: "active" });
    expect(grants[0]!.credentialSecretRefs.map((ref) => ref.configPath)).toEqual(["credentials.apiKey"]);
  });

  it("lets only one of two concurrent resumes claim a grant-less agent draft", async () => {
    const f = await setup();
    const connected = await request(f.routes).post(`/api/companies/${f.company.id}/tools/apps/connect`)
      .send({ galleryKey: NO_SIGN_IN, connectionMethodKey: "none", grantKind: "agent", subjectAgentId: f.agentA.id });
    expect(connected.status).toBe(201);
    const connectionId = connected.body.connectionId as string;
    // A draft saved before connect created agent grants has none.
    await db.delete(connectionGrants).where(eq(connectionGrants.connectionId, connectionId));
    const resume = (agentId: string) => request(f.routes).post(`/api/companies/${f.company.id}/tools/apps/connect`)
      .send({ galleryKey: NO_SIGN_IN, connectionMethodKey: "none", resumeConnectionId: connectionId, grantKind: "agent", subjectAgentId: agentId });
    const results = await Promise.all([resume(f.agentA.id), resume(f.agentB.id)]);
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    const active = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.connectionId, connectionId), eq(connectionGrants.status, "active")));
    expect(active).toHaveLength(1);
  });

  it("replaces a dedicated agent's API key on that agent's grant", async () => {
    const f = await setup();
    const result = await connectAndFinish(f, { galleryKey: API_KEY, connectionMethodKey: "api-key", grantKind: "agent", subjectAgentId: f.agentA.id,
      credentialValues: { "credentials.apiKey": "agent-key-old" } }, { agentIds: [f.agentA.id] });
    const replaced = await request(f.routes).post(`/api/tool-connections/${result.connectionId}/reconnect`)
      .send({ credentialValues: { "credentials.apiKey": "agent-key-new" } });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, result.connectionId));
    expect(connection!.credentialSecretRefs).toEqual([]);
    const lookup = (await f.tools(f.tokenA)).find((tool) => tool.upstreamToolName === "lookup")!;
    await f.gateway.executeTool({ sessionToken: f.tokenA, tool: lookup.name, parameters: {}, idempotencyKey: randomUUID() });
    expect(workerCalls.filter((call) => call.method === "executeTool").at(-1)!.params.runContext.connection.credential)
      .toMatchObject({ value: "agent-key-new" });
  });

  it("does not revive a removed agent identity for a connect that names no agent", async () => {
    const f = await setup();
    const result = await connectAndFinish(f, { galleryKey: NO_SIGN_IN, connectionMethodKey: "none", grantKind: "agent", subjectAgentId: f.agentA.id },
      { agentIds: [f.agentA.id] });
    const removed = await request(f.routes).delete(`/api/tool-connections/${result.connectionId}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const again = await request(f.routes).post(`/api/companies/${f.company.id}/tools/apps/connect`)
      .send({ galleryKey: NO_SIGN_IN, connectionMethodKey: "none" });
    expect(again.status).toBe(400);
    const active = await db.select().from(connectionGrants).where(and(
      eq(connectionGrants.connectionId, result.connectionId), eq(connectionGrants.status, "active")));
    expect(active).toEqual([]);
    expect(await f.tools(f.tokenA)).toEqual([]);
  });

  it("keeps the default organization grant for a method without agent grants", async () => {
    const f = await setup();
    const result = await connectAndFinish(f, { galleryKey: SHARED, connectionMethodKey: "none" }, "all_agents");
    expect(result.connectBody.connection).toMatchObject({ credentialPolicy: "shared" });
    expect(result.grants.map((grant) => ({ kind: grant.kind, isDefault: grant.isDefault, status: grant.status })))
      .toEqual([{ kind: "organization", isDefault: true, status: "active" }]);
    expect((await f.tools(f.tokenA)).map((tool) => tool.upstreamToolName).sort()).toEqual(["lookup", "update_record"]);
    expect((await f.tools(f.tokenB)).map((tool) => tool.upstreamToolName).sort()).toEqual(["lookup", "update_record"]);
  });

  it("lists installed plugin-transport tools in a Paperclip Runner session", async () => {
    const f = await setup();
    expect((await f.runnerTools(f.agentA)).definitions).toEqual([]);
    await connectAndFinish(f, { galleryKey: SHARED, connectionMethodKey: "none" }, { agentIds: [f.agentA.id] });
    const runnerA = await f.runnerTools(f.agentA);
    expect(runnerA.definitions).toHaveLength(2);
    // Search by the tool's manifest name finds the gateway tool.
    expect(await runnerA.search("update_record")).toHaveLength(1);
    expect((await f.runnerTools(f.agentB)).definitions).toEqual([]);
  });

  it("keeps plugin-transport tools in a Paperclip Runner session after a stale health error", async () => {
    const f = await setup();
    const { connectionId } = await connectAndFinish(f, { galleryKey: SHARED, connectionMethodKey: "none" }, { agentIds: [f.agentA.id] });
    // A health check that ran while the worker was down saved an error; the
    // worker is running again, so each call can succeed.
    await db.update(toolConnections).set({ healthStatus: "error", healthMessage: "Plugin worker unavailable" })
      .where(eq(toolConnections.id, connectionId));
    expect(await f.tools(f.tokenA)).toHaveLength(2);
    expect((await f.runnerTools(f.agentA)).definitions).toHaveLength(2);
  });
});
