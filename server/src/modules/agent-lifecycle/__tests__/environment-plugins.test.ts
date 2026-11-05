import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, environments, instanceSettings, plugins, createDb, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { configureAgentLifecycle, createAgentLifecycle, createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";
import { agentService as agentConfiguration } from "../../../services/agents.js";
import { createLifecycleStore } from "../adapters/postgres.js";

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

  function worker() {
    const work = configureAgentLifecycle(db, { ...createLifecycleDriver(db, { call } as never), runHost: async () => "complete" as const });
    workers.push(work);
    return work;
  }
  async function agent(defaultEnvironmentId: string | null, fields: Partial<typeof agents.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name: `Agent ${id}`, adapterType: "process", defaultEnvironmentId, ...fields });
    return id;
  }
  async function current(id: string) { return (await db.select().from(agents).where(eq(agents.id, id)))[0]!; }
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

  it("refuses to move a ready agent to an environment whose plugin it has not selected", async () => {
    const id = await agent(otherEnvironmentId, { lifecycleRequiredPluginIds: [] });
    await expect(agentConfiguration(db).update(id, { defaultEnvironmentId: boundEnvironmentId })).rejects.toThrow("Pause the agent");
    expect((await current(id)).defaultEnvironmentId).toBe(otherEnvironmentId);
  });

  it("lets a ready agent move when the plugin is selected, and keeps the selection when it leaves", async () => {
    const id = await agent(boundEnvironmentId, { lifecycleRequiredPluginIds: [boundPluginId] });
    await agentConfiguration(db).update(id, { defaultEnvironmentId: otherEnvironmentId });
    expect(await current(id)).toMatchObject({ defaultEnvironmentId: otherEnvironmentId, lifecycleRequiredPluginIds: [boundPluginId] });
    await agentConfiguration(db).update(id, { defaultEnvironmentId: boundEnvironmentId });
    expect((await current(id)).defaultEnvironmentId).toBe(boundEnvironmentId);
  });
});
