import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, principalPermissionGrants, environments, plugins, createDb, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle, configureAgentLifecycle, createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { agentService as agentConfiguration } from "../../../services/agents.js";
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";
import { agentRoutes } from "../../../routes/agents.js";
import { errorHandler } from "../../../middleware/error-handler.js";
import { createLifecycleStore as createStore } from "../adapters/postgres.js";
import type { LifecycleAgent } from "../application/ports.js";

const createLifecycleStore = (db: Db) => createStore(db, createAgentLifecycleEffects());
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("agent setup lifecycle", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-agent-setup-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { for (const work of workers) await work.stop(); await database?.cleanup(); });
  beforeEach(async () => {
    for (const work of workers) await work.stop();
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Setup test", issuePrefix: `S${companyId.slice(0, 7)}` });
  });
  function worker(runHost: (agent: LifecycleAgent) => Promise<"complete" | "pending"> = async () => "complete") {
    const work = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost });
    workers.push(work); return work;
  }
  async function current(id: string) { return (await db.select().from(agents).where(eq(agents.id, id)))[0]!; }

  it("keeps early setup inactive and completes the same record without renaming it", async () => {
    const runHost = vi.fn(async () => "complete" as const);
    const work = worker(runHost);
    const lifecycle = createAgentLifecycle(db);
    const id = randomUUID();
    const input = { id, name: "Early agent", adapterType: "process" };
    const first = await lifecycle.requestHire(companyId, input, { setupOnly: true });
    const retry = await lifecycle.requestHire(companyId, input, { setupOnly: true });
    expect(first.id).toBe(id);
    expect(retry.id).toBe(id);
    await work.process(id);
    expect(runHost).not.toHaveBeenCalled();
    expect(await current(id)).toMatchObject({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["setup"] });
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.principalId, id))).toHaveLength(0);
    await expect(agentConfiguration(db).createApiKey(id, "Incomplete setup")).rejects.toThrow("Finish agent setup");
    await expect(lifecycle.resumeAgent(id)).rejects.toThrow("Finish agent setup");
    const finished = await lifecycle.requestHire(companyId, { id, name: "Early agent", adapterType: "process", status: "idle" }, { setupAgentId: id });
    expect(finished).toMatchObject({ id, name: "Early agent" });
    await work.process(id);
    expect(await current(id)).toMatchObject({ status: "idle", lifecycleState: "ready", lifecycleHolds: [] });
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(1);
    await expect(lifecycle.requestHire(companyId, { id, name: "Early agent" }, { setupAgentId: id })).rejects.toThrow("no longer available");
  });

  it("prepares agent-dependent drafts, stays idle until finish, and invalidates changed environments", async () => {
    const pluginId = randomUUID(), environmentId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "agent-environment-test", version: "1.0.0", status: "ready",
      manifestJson: { agentLifecycle: true, capabilities: ["agents.lifecycle.manage", "environment.drivers.register"],
        environmentDrivers: [{ driverKey: "tasks", requiresAgent: true, supportsTasks: true }] } as never });
    await db.insert(environments).values({ id: environmentId, name: "Agent-owned test computer", driver: "plugin", status: "active",
      config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } });
    const call = vi.fn(async (_id, _method, input) => ({ operationId: input.operationId, version: input.version, status: "complete" }));
    const driver = createLifecycleDriver(db, { call } as never);
    const runHost = vi.fn(async () => "complete" as const);
    const work = configureAgentLifecycle(db, { ...driver, requiredPluginIds: async () => [pluginId], runHost });
    workers.push(work);
    const lifecycle = createAgentLifecycle(db);
    const id = randomUUID();
    const input = { id, name: "Early computer", adapterType: "paperclip_runner", adapterConfig: { provider: "codex" }, defaultEnvironmentId: environmentId };
    const draft = await lifecycle.requestHire(companyId, input, { setupOnly: true, runnerResolved: true });
    expect(draft).toMatchObject({ lifecycleState: "preparing", status: "paused", pauseReason: "setup" });
    await work.process(id);
    expect(await current(id)).toMatchObject({ lifecycleState: "verifying", status: "paused", lifecycleHolds: ["setup"] });
    expect(call.mock.calls.map(([, , request]) => request.phase)).toEqual(["preparing"]);
    const store = createLifecycleStore(db);
    expect(await store.pending(100, new Date())).not.toContain(id);
    expect(await store.claim(id, "unexpected", new Date())).toBeNull();
    await work.process(id);
    expect(runHost).toHaveBeenCalledTimes(1);
    await expect(agentConfiguration(db).createApiKey(id, "Incomplete computer")).rejects.toThrow("Finish agent setup");
    await expect(lifecycle.resumeAgent(id)).rejects.toThrow("Finish agent setup");
    await lifecycle.pauseAgent(id, "budget"); await work.process(id);
    expect(await current(id)).toMatchObject({ lifecycleState: "paused", lifecycleHolds: ["setup", "budget"] });
    await lifecycle.updateConfiguration(id, { adapterConfig: { provider: "codex", model: "changed" } });
    expect((await current(id)).lifecycleState).toBe("paused");
    await store.change(id, "reconcile"); await work.process(id);
    expect(await current(id)).toMatchObject({ lifecycleState: "verifying", lifecycleHolds: ["setup"] });
    await lifecycle.updateConfiguration(id, { adapterConfig: { provider: "codex", model: "prepared" } });
    await work.process(id);
    expect((await current(id)).lifecycleState).toBe("verifying");
    const [local] = await db.select().from(environments).where(eq(environments.driver, "local"));
    await lifecycle.updateConfiguration(id, { defaultEnvironmentId: local.id }); await work.process(id);
    expect((await current(id)).lifecycleState).toBe("paused");
    await lifecycle.updateConfiguration(id, { defaultEnvironmentId: environmentId }); await work.process(id);
    expect((await current(id)).lifecycleState).toBe("verifying");
    await lifecycle.updateConfiguration(id, { defaultEnvironmentId: local.id });
    expect((await current(id)).lifecycleState).toBe("pausing");
    await lifecycle.updateConfiguration(id, { defaultEnvironmentId: environmentId });
    await work.process(id);
    expect((await current(id)).lifecycleState).toBe("verifying");
    const finished = await lifecycle.requestHire(companyId, input, { setupAgentId: id, runnerResolved: true });
    expect(finished.id).toBe(id);
    await work.process(id);
    expect(await current(id)).toMatchObject({ lifecycleState: "ready", lifecycleHolds: [] });
    expect(call.mock.calls.map(([, , request]) => request.phase).at(-1)).toBe("verifying");
  });

  it("does not prepare agent-owned resources before required hire approval", async () => {
    const pluginId = randomUUID(), environmentId = randomUUID();
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, companyId));
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "approval-computer-test", version: "1.0.0", status: "ready",
      manifestJson: { agentLifecycle: true, capabilities: ["agents.lifecycle.manage", "environment.drivers.register"],
        environmentDrivers: [{ driverKey: "tasks", requiresAgent: true, supportsTasks: true }] } as never });
    await db.insert(environments).values({ id: environmentId, name: "Approval computer", driver: "plugin", status: "active",
      config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } });
    const runHost = vi.fn(async () => "complete" as const);
    const work = worker(runHost);
    const lifecycle = createAgentLifecycle(db);
    const draft = await lifecycle.requestHire(companyId, { name: "Unapproved computer", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" }, defaultEnvironmentId: environmentId }, { setupOnly: true, runnerResolved: true });
    await work.process(draft.id);
    await lifecycle.updateConfiguration(draft.id, { adapterConfig: { provider: "codex", model: "changed" } });
    await work.process(draft.id);
    expect(await current(draft.id)).toMatchObject({ lifecycleState: "paused", lifecycleHolds: ["setup"] });
    expect(runHost).not.toHaveBeenCalled();
  });

  it("lets only the setup creator configure and retry a stopping draft with creation permission", async () => {
    await db.insert(companyMemberships).values(["setup-owner", "setup-other"].map(principalId => ({ companyId,
      principalType: "user", principalId, membershipRole: "member" })));
    await db.insert(principalPermissionGrants).values(["setup-owner", "setup-other"].map(principalId => ({ companyId,
      principalType: "user", principalId, permissionKey: "agents:create" })));
    const lifecycle = createAgentLifecycle(db);
    const draft = await lifecycle.requestHire(companyId, { name: "Stopping setup", adapterType: "process" },
      { setupOnly: true, createdByUserId: "setup-owner" });
    await db.update(agents).set({ lifecycleState: "pausing" }).where(eq(agents.id, draft.id));
    function app(userId: string) {
      const value = express(); value.use(express.json());
      value.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId,
        companyIds: [companyId], memberships: [{ companyId, membershipRole: "member", status: "active" }] }; next(); });
      value.use("/api", agentRoutes(db)); value.use(errorHandler); return value;
    }
    const updated = await request(app("setup-owner")).patch(`/api/agents/${draft.id}`).send({ runtimeConfig: { heartbeat: { enabled: false } } });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    await request(app("setup-owner")).post(`/api/agents/${draft.id}/lifecycle/retry`).send({}).expect(200);
    await request(app("setup-other")).patch(`/api/agents/${draft.id}`).send({ runtimeConfig: { heartbeat: { enabled: true } } }).expect(403);
    await request(app("setup-other")).post(`/api/agents/${draft.id}/lifecycle/retry`).send({}).expect(403);
    await expect(lifecycle.requestHire(companyId, { name: draft.name }, { setupAgentId: draft.id })).rejects.toThrow("no longer available");
    expect((await current(draft.id)).lifecycleState).toBe("pausing");
  });
});
