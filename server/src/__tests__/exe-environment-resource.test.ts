import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, environments, companies, agents, heartbeatRuns, issues, plugins, environmentLeases } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { bindEnvironmentResource, readEnvironmentResourceBinding } from "../services/environment-resource-binding.js";
import { assertExeEnvironmentEnabled } from "../services/exe-environment-gate.js";
import { environmentService } from "../services/environments.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable exe.dev environment resource", () => {
  let db: ReturnType<typeof createDb>;
  let stop: () => Promise<void>;
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("exe-resource");
    db = createDb(started.connectionString); stop = started.stop;
  });
  afterAll(async () => { await stop?.(); });
  async function fixture() {
    const id = randomUUID(); const companyId = randomUUID();
    await db.insert(environments).values({ id, name: id, driver: "sandbox", config: { provider: "exe-dev" } });
    const binding = { provider: "exe-dev", companyId, resourceId: "test-vm", identity: randomUUID() };
    return { id, companyId, binding };
  }
  it("defaults off, gates API/runtime admission, and allows explicit opt-in", async () => {
    const environment = { driver: "sandbox", config: { provider: "exe-dev" } };
    await expect(assertExeEnvironmentEnabled(db, environment)).rejects.toThrow("Enable experimental");
    await expect(assertExeEnvironmentEnabled(db, { driver: "sandbox", config: { provider: "daytona" } })).resolves.toBeUndefined();
    await instanceSettingsService(db).updateExperimental({ enableExeEnvironments: true });
    await expect(assertExeEnvironmentEnabled(db, environment)).resolves.toBeUndefined();
    await instanceSettingsService(db).updateExperimental({ enableExeEnvironments: false });
  });
  it("atomically converges concurrent acquisitions on the same durable identity", async () => {
    const { id, companyId, binding } = await fixture();
    await Promise.all(Array.from({ length: 8 }, () => bindEnvironmentResource(db, id, companyId, binding)));
    expect(await readEnvironmentResourceBinding(db, id, companyId)).toEqual(binding);
  });
  it("keeps the configuration revision stable while attesting VM identity", async () => {
    const { id, companyId, binding } = await fixture();
    const revision = new Date("2020-01-01T00:00:00Z");
    await db.update(environments).set({ updatedAt: revision }).where(eq(environments.id, id));
    await bindEnvironmentResource(db, id, companyId, binding);
    await bindEnvironmentResource(db, id, companyId, binding);
    const [bound] = await db.select().from(environments).where(eq(environments.id, id));
    expect(bound.updatedAt).toEqual(revision);
    expect(await readEnvironmentResourceBinding(db, id, companyId)).toEqual(binding);
    await environmentService(db).update(id, { config: { provider: "exe-dev", vmName: "operator-change" } });
    const [edited] = await db.select().from(environments).where(eq(environments.id, id));
    expect(edited.updatedAt.getTime()).toBeGreaterThan(revision.getTime());
  });
  it("allows only one identity when competing first acquisitions disagree", async () => {
    const { id, companyId, binding } = await fixture();
    const results = await Promise.allSettled([
      bindEnvironmentResource(db, id, companyId, binding),
      bindEnvironmentResource(db, id, companyId, { ...binding, identity: randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
  it("survives metadata replacement and has no dependence on run lease rows", async () => {
    const { id, companyId, binding } = await fixture();
    await bindEnvironmentResource(db, id, companyId, binding);
    await environmentService(db).update(id, { metadata: { note: "operator edit" } });
    expect(await readEnvironmentResourceBinding(db, id, companyId)).toEqual(binding);
    await environmentService(db).update(id, { metadata: null });
    expect(await readEnvironmentResourceBinding(db, id, companyId)).toEqual(binding);
  });
  it("denies a different company and a replacement VM", async () => {
    const { id, companyId, binding } = await fixture();
    await bindEnvironmentResource(db, id, companyId, binding);
    await expect(readEnvironmentResourceBinding(db, id, randomUUID())).rejects.toThrow("another company");
    await expect(bindEnvironmentResource(db, id, companyId, { ...binding, identity: randomUUID() })).rejects.toThrow("identity changed");
    expect(await readEnvironmentResourceBinding(db, id, companyId)).toEqual(binding);
  });
  it("reuses a task lease without a project, but separates tasks, agents, and concurrent runs", async () => {
    const { id, companyId, binding } = await fixture();
    const agentId = randomUUID(); const otherAgentId = randomUUID(); const issueId = randomUUID(); const otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Durable test" });
    await db.insert(agents).values([agentId, otherAgentId].map((id) => ({ id, companyId, name: id, role: "engineer", adapterType: "paperclip_runner" })));
    await db.insert(issues).values([issueId, otherIssueId].map((id) => ({ id, companyId, title: id })));
    const environment = await environmentService(db).update(id, { config: { provider: "exe-dev", reuseLease: true } });
    const pluginId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: "test.exe", packageName: "test-exe", version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1,
      manifestJson: { id: "test.exe", apiVersion: 1, version: "1.0.0", displayName: "Test exe", description: "Test", author: "Test", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "exe-dev", kind: "sandbox_provider", displayName: "Test exe", supportsReusableLeases: true, configSchema: { type: "object" } }],
      },
    });
    const manager = {
      isRunning: () => true,
      getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
      call: vi.fn(async (_id: string, method: string, params: Record<string, any>) => {
        if (method === "environmentResumeLease") return { providerLeaseId: params.providerLeaseId, metadata: params.leaseMetadata };
        if (method === "environmentAcquireLease") return { providerLeaseId: randomUUID(), metadata: { provider: "exe-dev", reuseLease: true, bindingId: binding.identity, environmentResourceBinding: binding, remoteCwd: "/workspace" } };
        throw new Error(`Unexpected ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: manager });
    await instanceSettingsService(db).updateExperimental({ enableExeEnvironments: true });
    const acquire = async (taskId = issueId, workerId = agentId) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: workerId, invocationSource: "manual", status: "running" });
      return (await runtime.acquireRunLease({ companyId, environment: environment!, issueId: taskId, agentId: workerId, heartbeatRunId: runId, persistedExecutionWorkspace: null, adapterType: "paperclip_runner" })).lease;
    };
    const first = await acquire();
    const concurrent = await acquire();
    expect(concurrent.providerLeaseId).not.toBe(first.providerLeaseId);
    await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, first.id));
    const next = await acquire();
    expect(next.providerLeaseId).toBe(first.providerLeaseId);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, first.id)))[0].status).toBe("expired");
    await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, next.id));
    expect((await acquire(otherIssueId)).providerLeaseId).not.toBe(next.providerLeaseId);
    expect((await acquire(issueId, otherAgentId)).providerLeaseId).not.toBe(next.providerLeaseId);
    await instanceSettingsService(db).updateExperimental({ enableExeEnvironments: false });
  });
});
