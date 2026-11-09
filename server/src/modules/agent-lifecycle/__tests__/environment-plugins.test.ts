import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, environments, heartbeatRuns, instanceSettings, plugins, principalPermissionGrants, createDb, type Db } from "@paperclipai/db";
import express from "express";
import request from "supertest";
import { agentRoutes } from "../../../routes/agents.js";
import { errorHandler } from "../../../middleware/error-handler.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { configureAgentLifecycle, createAgentLifecycle, createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";
import { agentService as agentConfiguration } from "../../../services/agents.js";
import { assertAgentsReadyForEnvironmentChange } from "../../../services/plugin-environment-driver.js";
import { createLifecycleStore } from "../adapters/postgres.js";
import type { LifecycleAgent, LifecycleDriver } from "../application/ports.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("environment-bound lifecycle plugins", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let companyId: string;
  let boundPluginId: string;
  let boundEnvironmentId: string;
  let otherEnvironmentId: string;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  const call = vi.fn(async (_id, _method, input) => ({ operationId: input.operationId, version: input.version, status: "complete" }));

  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-environment-plugins-"); db = createDb(database.connectionString); }, 90_000);
  afterAll(async () => { for (const work of workers) await work.stop(); await database?.cleanup(); });
  beforeEach(async () => {
    for (const work of workers.splice(0)) await work.stop();
    call.mockClear();
    await db.delete(plugins);
    await db.update(instanceSettings).set({ defaultEnvironmentId: null });
    companyId = randomUUID(); boundPluginId = randomUUID(); boundEnvironmentId = randomUUID(); otherEnvironmentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Environment plugins", issuePrefix: `E${companyId.slice(0, 7)}` });
    await db.insert(plugins).values({ id: boundPluginId, pluginKey: boundPluginId, packageName: "bound", version: "1.0.0", status: "ready",
      manifestJson: { agentLifecycle: true, capabilities: ["agents.lifecycle.manage", "environment.drivers.register"],
        environmentDrivers: [{ driverKey: "tasks", requiresAgent: true, supportsTasks: true }] } as never });
    await db.insert(environments).values([
      { id: boundEnvironmentId, name: `Bound ${boundEnvironmentId}`, driver: "plugin", status: "active", config: { pluginKey: boundPluginId, driverKey: "tasks", driverConfig: {} } },
      { id: otherEnvironmentId, name: `Other ${otherEnvironmentId}`, driver: "sandbox", status: "active", config: { provider: "fixture" } },
    ]);
  });

  function worker(runHost: LifecycleDriver["runHost"] = async () => "complete") {
    const work = configureAgentLifecycle(db, { ...createLifecycleDriver(db, { call } as never), runHost });
    workers.push(work);
    return work;
  }
  async function agent(defaultEnvironmentId: string | null, fields: Partial<typeof agents.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name: `Agent ${id}`, adapterType: "process", defaultEnvironmentId, ...fields });
    return id;
  }
  async function current(id: string) { return (await db.select().from(agents).where(eq(agents.id, id)))[0]!; }
  function app(actor: Express.Request["actor"]) {
    const value = express(); value.use(express.json());
    value.use((req, _res, next) => { req.actor = actor; next(); });
    value.use("/api", agentRoutes(db)); value.use(errorHandler); return value;
  }
  async function selection(id: string) {
    return createLifecycleDriver(db, { call } as never).requiredPluginIds((await createLifecycleStore(db, createAgentLifecycleEffects()).get(id))!);
  }

  it("selects an environment-bound plugin only for agents on its environment", async () => {
    const genericPluginId = randomUUID();
    await db.insert(plugins).values({ id: genericPluginId, pluginKey: genericPluginId, packageName: "generic", version: "1.0.0", status: "ready",
      manifestJson: { agentLifecycle: true, capabilities: ["agents.lifecycle.manage"] } as never });
    expect(await selection(await agent(boundEnvironmentId))).toEqual(expect.arrayContaining([boundPluginId, genericPluginId]));
    expect(await selection(await agent(otherEnvironmentId))).toEqual([genericPluginId]);
    expect(await selection(await agent(null))).toEqual([genericPluginId]);
  });

  it("keeps selecting a sandbox provider that requires an agent for all agents", async () => {
    const providerId = randomUUID(), sandboxId = randomUUID(), providerKey = `provider-${providerId.slice(0, 8)}`;
    await db.insert(plugins).values({ id: providerId, pluginKey: providerId, packageName: "provider", version: "1.0.0", status: "ready",
      manifestJson: { agentLifecycle: true, capabilities: ["agents.lifecycle.manage", "environment.drivers.register"],
        environmentDrivers: [{ driverKey: providerKey, kind: "sandbox_provider", requiresAgent: true }] } as never });
    await db.insert(environments).values({ id: sandboxId, name: `Sandbox ${sandboxId}`, driver: "sandbox", status: "active", config: { provider: providerKey } });
    expect(await selection(await agent(sandboxId))).toEqual([providerId]);
    expect(await selection(await agent(otherEnvironmentId))).toEqual([providerId]);
    const id = await agent(otherEnvironmentId, { lifecycleRequiredPluginIds: [] });
    await agentConfiguration(db).update(id, { defaultEnvironmentId: sandboxId });
    expect((await current(id)).defaultEnvironmentId).toBe(sandboxId);
  });

  it("refuses an environment change that gives active agents an unprepared plugin", async () => {
    const other = { driver: "sandbox", config: { provider: "fixture" } };
    const bound = { driver: "plugin", config: { pluginKey: boundPluginId, driverKey: "tasks" } };
    const users = { environmentId: otherEnvironmentId, inheritsDefault: false };
    const id = await agent(otherEnvironmentId, { lifecycleRequiredPluginIds: [] });
    await expect(assertAgentsReadyForEnvironmentChange(db, other, bound, users)).rejects.toThrow("need setup first");
    await db.update(agents).set({ lifecycleState: "paused", status: "paused" }).where(eq(agents.id, id));
    await expect(assertAgentsReadyForEnvironmentChange(db, other, bound, users)).resolves.toBeUndefined();
    await db.update(agents).set({ lifecycleState: "ready", status: "idle", lifecycleRequiredPluginIds: [boundPluginId] }).where(eq(agents.id, id));
    await expect(assertAgentsReadyForEnvironmentChange(db, other, bound, users)).resolves.toBeUndefined();
    await db.update(agents).set({ lifecycleRequiredPluginIds: [] }).where(eq(agents.id, id));
    await expect(assertAgentsReadyForEnvironmentChange(db, bound, bound, users)).resolves.toBeUndefined();
    await expect(assertAgentsReadyForEnvironmentChange(db, bound, other, users)).resolves.toBeUndefined();
  });

  it("refuses an instance default that gives inheriting agents an unprepared plugin", async () => {
    const other = { driver: "sandbox", config: { provider: "fixture" } };
    const bound = { driver: "plugin", config: { pluginKey: boundPluginId, driverKey: "tasks" } };
    await agent(null, { lifecycleRequiredPluginIds: [] });
    await expect(assertAgentsReadyForEnvironmentChange(db, other, bound, { inheritsDefault: true })).rejects.toThrow("need setup first");
    await expect(assertAgentsReadyForEnvironmentChange(db, other, bound, { environmentId: boundEnvironmentId, inheritsDefault: false })).resolves.toBeUndefined();
  });

  it("uses the instance default for an agent with no environment", async () => {
    await db.update(instanceSettings).set({ defaultEnvironmentId: boundEnvironmentId });
    expect(await selection(await agent(null))).toEqual([boundPluginId]);
    expect(await selection(await agent(otherEnvironmentId))).toEqual([]);
  });

  it("does not call the plugin while an agent on another environment prepares", async () => {
    const id = await agent(otherEnvironmentId, { lifecycleState: "resuming", status: "paused",
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0 } });
    await worker().process(id);
    expect(call).not.toHaveBeenCalled();
    expect((await current(id)).lifecycleRequiredPluginIds).toEqual([]);
  });

  it("adds the plugin when a paused agent moves to its environment and resumes", async () => {
    const id = await agent(otherEnvironmentId, { lifecycleState: "paused", status: "paused", lifecycleHolds: ["manual"], pauseReason: "manual", lifecycleRequiredPluginIds: [] });
    await agentConfiguration(db).update(id, { defaultEnvironmentId: boundEnvironmentId });
    await createAgentLifecycle(db).resumeAgent(id);
    await worker().process(id);
    expect((await current(id)).lifecycleRequiredPluginIds).toEqual([boundPluginId]);
    expect(call.mock.calls.map(args => args[2].phase)).toContain("resuming");
  });

  it("returns a verifying agent to preparing when it moves to the plugin's environment", async () => {
    const id = await agent(otherEnvironmentId, { lifecycleState: "verifying", status: "paused", lifecycleRequiredPluginIds: [],
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0 } });
    await agentConfiguration(db).update(id, { defaultEnvironmentId: boundEnvironmentId });
    expect((await current(id)).lifecycleState).toBe("preparing");
    await worker().process(id);
    expect((await current(id)).lifecycleRequiredPluginIds).toEqual([boundPluginId]);
    expect(call.mock.calls.map(args => args[2].phase)).toContain("preparing");
  });

  it("adds the plugin when an agent moves to its environment while preparing", async () => {
    const id = await agent(otherEnvironmentId, { lifecycleState: "preparing", status: "paused", lifecycleRequiredPluginIds: [],
      lifecycleOperation: { id: randomUUID(), hostComplete: true, completedPluginIds: [], attempts: 0 } });
    await agentConfiguration(db).update(id, { defaultEnvironmentId: boundEnvironmentId });
    await worker().process(id);
    expect((await current(id)).lifecycleRequiredPluginIds).toEqual([boundPluginId]);
    expect(call.mock.calls.map(args => args[2].phase)).toContain("preparing");
  });

  it("keeps a verifying agent in verifying when the new environment needs no new plugin", async () => {
    const id = await agent(boundEnvironmentId, { lifecycleState: "verifying", status: "paused", lifecycleRequiredPluginIds: [boundPluginId],
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0 } });
    await agentConfiguration(db).update(id, { defaultEnvironmentId: otherEnvironmentId });
    expect((await current(id)).lifecycleState).toBe("verifying");
  });

  it.each(["idle", "running"])("automatically pauses an %s agent, prepares its new environment, and verifies before readiness", async status => {
    const id = await agent(otherEnvironmentId, { status, lifecycleRequiredPluginIds: [] });
    const saved = await agentConfiguration(db).update(id, { defaultEnvironmentId: boundEnvironmentId });
    expect(saved).toMatchObject({ defaultEnvironmentId: boundEnvironmentId, lifecycleState: "pausing", status: "paused" });
    expect(await current(id)).toMatchObject({ lifecycleHolds: [], lifecycleOperation: { resumeState: "verifying" } });

    const phases: string[] = [];
    const runHost = vi.fn(async (row: LifecycleAgent) => { phases.push(row.lifecycleState); return "complete" as const; });
    await worker(runHost).process(id);
    expect(phases).toEqual(["pausing", "resuming", "verifying"]);
    expect(call.mock.calls.map(args => args[2].phase)).toEqual(["resuming", "verifying"]);
    expect(await current(id)).toMatchObject({ lifecycleState: "ready", status: "idle", lifecycleRequiredPluginIds: [boundPluginId] });
  });

  it.each(["board", "agent"] as const)("lets a configuration-authorized %s migrate without separate manual-pause authority", async type => {
    const id = await agent(otherEnvironmentId, { status: "running", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" }, lifecycleRequiredPluginIds: [] });
    const principalId = type === "agent" ? await agent(otherEnvironmentId) : randomUUID();
    await db.insert(companyMemberships).values({ companyId, principalType: type === "board" ? "user" : "agent",
      principalId, membershipRole: "member", status: "active" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: type === "board" ? "user" : "agent",
      principalId, permissionKey: "agents:configure" });
    const actor: Express.Request["actor"] = type === "board"
      ? { type, source: "session", userId: principalId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "member", status: "active" }] }
      : { type, source: "agent_key", agentId: principalId, companyId };
    await request(app(actor)).post(`/api/agents/${id}/pause`).send({}).expect(403);
    const response = await request(app(actor)).patch(`/api/agents/${id}`).send({ defaultEnvironmentId: boundEnvironmentId });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await current(id)).toMatchObject({ defaultEnvironmentId: boundEnvironmentId, lifecycleState: "pausing", status: "paused" });
  });

  it.each(["board", "agent"] as const)("rejects a %s without configuration permission before saving the environment or pausing", async type => {
    const id = await agent(otherEnvironmentId, { status: "running", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" }, lifecycleRequiredPluginIds: [] });
    const principalId = type === "agent" ? await agent(otherEnvironmentId) : randomUUID();
    await db.insert(companyMemberships).values({ companyId, principalType: type === "board" ? "user" : "agent", principalId, membershipRole: "member", status: "active" });
    const actor: Express.Request["actor"] = type === "board"
      ? { type, source: "session", userId: principalId, companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "member", status: "active" }] }
      : { type, source: "agent_key", agentId: principalId, companyId };
    const before = await current(id);
    await request(app(actor)).patch(`/api/agents/${id}`).send({ defaultEnvironmentId: boundEnvironmentId }).expect(403);
    expect(await current(id)).toMatchObject({ defaultEnvironmentId: otherEnvironmentId, lifecycleState: "ready", status: "running",
      lifecycleVersion: before.lifecycleVersion, lifecycleOperation: before.lifecycleOperation });
    expect(call).not.toHaveBeenCalled();
  });

  it("retains the migration across a pending stop and worker restart without starting the new plugin early", async () => {
    const id = await agent(otherEnvironmentId, { status: "running", lifecycleRequiredPluginIds: [] });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: id,
      status: "cancelled", invocationSource: "on_demand", runtimeMode: "legacy",
      startedAt: new Date(), finishedAt: new Date(), processPid: process.pid }).returning();
    await agentConfiguration(db).update(id, { defaultEnvironmentId: boundEnvironmentId });
    const driver = createLifecycleDriver(db, { call } as never);
    const stopping = worker(row => row.lifecycleState === "pausing" ? driver.runHost(row) : Promise.resolve("complete"));
    await stopping.process(id);
    expect((await current(id)).lifecycleState).toBe("pausing");
    expect(call).not.toHaveBeenCalled();
    await stopping.stop();
    await db.update(heartbeatRuns).set({ processPid: null,
      resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, run.id));
    await createAgentLifecycle(db).retry(id);
    await worker().process(id);
    expect(await current(id)).toMatchObject({ lifecycleState: "ready", lifecycleRequiredPluginIds: [boundPluginId] });
  });

  it.each(["manual", "budget", "company_paused"])("preserves a %s hold added while migration is pausing", async reason => {
    const id = await agent(otherEnvironmentId, { lifecycleRequiredPluginIds: [] });
    await agentConfiguration(db).update(id, { defaultEnvironmentId: boundEnvironmentId });
    await createAgentLifecycle(db).pauseAgent(id, reason);
    await worker().process(id);
    expect(await current(id)).toMatchObject({ lifecycleState: "paused", status: "paused", lifecycleHolds: [reason] });
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps the agent blocked when verification of the new environment fails", async () => {
    const id = await agent(otherEnvironmentId, { lifecycleRequiredPluginIds: [] });
    await agentConfiguration(db).update(id, { defaultEnvironmentId: boundEnvironmentId });
    await worker(vi.fn(async (row: LifecycleAgent) => {
      if (row.lifecycleState === "verifying") throw Object.assign(new Error("Fixture verification failed"), { code: "harness_test_failed" });
      return "complete" as const;
    })).process(id);
    expect(await current(id)).toMatchObject({ lifecycleState: "verifying", status: "paused", lifecycleRequiredPluginIds: [boundPluginId] });
    expect((await current(id)).lifecycleError).toBeTruthy();
  });

  it("lets a ready agent move when the plugin is selected, and keeps the selection when it leaves", async () => {
    const id = await agent(boundEnvironmentId, { lifecycleRequiredPluginIds: [boundPluginId] });
    await agentConfiguration(db).update(id, { defaultEnvironmentId: otherEnvironmentId });
    expect(await current(id)).toMatchObject({ defaultEnvironmentId: otherEnvironmentId, lifecycleRequiredPluginIds: [boundPluginId] });
    await agentConfiguration(db).update(id, { defaultEnvironmentId: boundEnvironmentId });
    expect((await current(id)).defaultEnvironmentId).toBe(boundEnvironmentId);
  });
});
