import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, projects, runtimeServiceAllocations, runtimeServices, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createRuntimeServiceSchema } from "@paperclipai/shared";
import { environmentRuntimeService } from "../environment-runtime.js";
import { environmentService } from "../environments.js";
import { executionWorkspaceService } from "../execution-workspaces.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { createRuntimeServiceManager } from "./manager.js";
import type { RuntimeServiceProvider } from "./provider.js";
import { runtimeServiceRetentionForLease, withRuntimeServiceLeaseLock, withRuntimeServiceWorkspaceCleanup } from "./retention.js";

describe("service retention through the production environment lifecycle", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-service-retention-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-retention-"));
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); });

  async function fixture() {
    const companyId = randomUUID();
    const providerLeaseId = randomUUID();
    const pluginId = randomUUID();
    const cwd = path.join(root, companyId);
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "dirty.txt"), "keep this uncommitted change");
    await db.insert(companies).values({ id: companyId, name: "Retention", issuePrefix: `R${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Developer" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running" }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "App" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, name: "App files", mode: "isolated_workspace", strategyType: "git_worktree", cwd }).returning();
    const [environment] = await db.insert(environments).values({ name: `Daytona test ${companyId}`, driver: "sandbox", config: { provider: "daytona" } }).returning();
    const envs = environmentService(db);
    const lease = await envs.acquireLease({
      companyId, environmentId: environment!.id, executionWorkspaceId: workspace!.id, heartbeatRunId: run!.id,
      provider: "daytona", providerLeaseId, leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", provider: "daytona", sandboxProviderPlugin: true, pluginId },
    });
    const call = vi.fn(async (_pluginId: string, _method: string, _input: unknown) => ({ state: "stopped" }));
    const worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["environmentService", "environmentDestroyLease", "environmentReleaseLease"] }), call } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const provider: RuntimeServiceProvider = {
      key: "daytona", capabilities: { dynamicPorts: true, preview: true, logs: true, preservesDataOnStop: true },
      async start(ctx) { return ctx.process; }, async inspect() { return { state: "running", endpoints: [] }; },
      async stop() {}, async logs() { return ""; },
    };
    const manager = createRuntimeServiceManager(db, { providers: [provider] });
    const placement = { provider: "daytona", reuseKey: lease.id, environmentLeaseId: lease.id, executionWorkspaceId: workspace!.id, cwd };
    const create = (start = true) => manager.create(companyId, { type: "board", id: "operator" }, createRuntimeServiceSchema.parse({ name: "Worker", purpose: "worker", command: "node app.cjs", requestId: randomUUID(), start }), placement);
    return { companyId, lease, envs, environment: (await envs.getById(environment!.id))!, run: run!, workspace: workspace!, cwd, call, runtime, manager, create };
  }

  it("ending a run retains its service allocation and blocks workspace and environment removal", async () => {
    const f = await fixture();
    const service = await f.create(false);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    const released = await f.runtime.releaseRunLeases(f.run.id, "released");
    expect(released[0]?.lease).toMatchObject({ status: "retained", cleanupStatus: "success" });
    expect(f.call).not.toHaveBeenCalled();
    await expect(withRuntimeServiceWorkspaceCleanup(db, f.companyId, f.workspace.id, () => fs.rm(f.cwd, { recursive: true }))).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(path.join(f.cwd, "dirty.txt"), "utf8")).toContain("uncommitted");
    expect(await f.envs.getDeleteBlastRadius(f.environment.id)).toMatchObject({ canDelete: false, retainedServiceAllocationCount: 1, deleteBlockedReasons: ["runtime_service_retention"] });
    expect(await f.envs.removeIfDeletable(f.environment.id)).toBeNull();
    await expect(f.envs.remove(f.environment.id)).rejects.toMatchObject({ status: 409 });
    expect(await f.manager.get(f.companyId, service.id)).toMatchObject({ state: "stopped" });
  });

  it("lets a later run share the same allocation without accepting a different sandbox or boundary", async () => {
    const f = await fixture();
    const original = await f.create(false);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    await f.runtime.releaseRunLeases(f.run.id, "released");
    const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.run.agentId, status: "running" }).returning();
    const nextLease = await f.envs.acquireLease({ companyId: f.companyId, environmentId: f.environment.id, heartbeatRunId: nextRun!.id, provider: "daytona", providerLeaseId: f.lease.providerLeaseId, metadata: f.lease.metadata });
    const input = () => createRuntimeServiceSchema.parse({ name: "Second worker", command: "node second.cjs", purpose: "worker", start: false, requestId: randomUUID() });
    const placement = { provider: "daytona", reuseKey: f.lease.id, environmentLeaseId: nextLease.id, executionWorkspaceId: f.workspace.id, cwd: f.cwd };
    const secondInput = input();
    const second = await f.manager.create(f.companyId, { type: "board", id: "operator" }, secondInput, placement);
    expect(second.allocationId).toBe(original.allocationId);
    expect((await f.manager.getRecord(f.companyId, second.id)).allocation.environmentLeaseId).toBe(f.lease.id);
    const replay = await f.manager.create(f.companyId, { type: "board", id: "operator" }, secondInput, { ...placement, environmentLeaseId: f.lease.id });
    expect(replay.id).toBe(second.id);
    await expect(f.manager.create(f.companyId, { type: "board", id: "operator" }, input(), { ...placement, metadata: { localBoundary: { network: "enabled" } } })).rejects.toMatchObject({ status: 409 });
    await db.update(environmentLeases).set({ providerLeaseId: randomUUID() }).where(eq(environmentLeases.id, nextLease.id));
    await expect(f.manager.create(f.companyId, { type: "board", id: "operator" }, input(), placement)).rejects.toMatchObject({ status: 409 });
  });

  it("counts sibling services and newer run leases before releasing shared compute", async () => {
    const f = await fixture();
    const web = await f.create(false);
    const api = await f.create(true);
    const release = () => f.runtime.operateRuntimeService({ companyId: f.companyId, environmentLeaseId: f.lease.id, serviceId: web.id, generation: randomUUID(), action: "release_compute" });
    expect(await release()).toMatchObject({ state: "retained" });
    await db.update(runtimeServices).set({ desiredState: "stopped", state: "stopped" }).where(eq(runtimeServices.id, api.id));
    expect(await release()).toMatchObject({ state: "retained" });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    const [newRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.run.agentId, status: "running" }).returning();
    const newLease = await f.envs.acquireLease({ companyId: f.companyId, environmentId: f.environment.id, heartbeatRunId: newRun!.id, provider: "daytona", providerLeaseId: f.lease.providerLeaseId });
    expect(await runtimeServiceRetentionForLease(db, newLease)).toHaveLength(1);
    expect(await release()).toMatchObject({ state: "retained" });
    expect(f.call).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, newRun!.id));
    expect(await release()).toMatchObject({ state: "stopped" });
    expect(f.call).toHaveBeenCalledExactlyOnceWith(expect.any(String), "environmentService", expect.objectContaining({ action: "release_compute", providerLeaseId: f.lease.providerLeaseId }), 45_000);
  });

  it("rejects foreign allocation access and removes retained allocations from the cleanup retry queue", async () => {
    const f = await fixture();
    const service = await f.create(false);
    await expect(f.runtime.operateRuntimeService({ companyId: randomUUID(), environmentLeaseId: f.lease.id, serviceId: service.id, generation: randomUUID(), action: "release_compute" })).rejects.toThrow("unavailable");
    await db.update(environmentLeases).set({ status: "pending_cleanup" }).where(eq(environmentLeases.id, f.lease.id));
    expect(await f.runtime.isPendingCleanupWorkerReady({ environment: f.environment, lease: f.lease })).toBe(false);
    expect((await f.envs.listLeases(f.environment.id))[0]?.status).toBe("retained");
    await expect(f.runtime.retryPendingSandboxTeardown({ environment: f.environment, lease: f.lease })).rejects.toThrow("retained by runtime services");
    expect(f.call).not.toHaveBeenCalled();
  });

  it("does not count a retained reusable sandbox as destroyed", async () => {
    const f = await fixture();
    await f.create(false);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment" }).where(eq(environmentLeases.id, f.lease.id));
    expect(await f.runtime.destroyReusableSandboxLeasesForEnvironment({ environmentId: f.environment.id })).toMatchObject({ destroyed: 0, failed: 0, skippedRetainedService: 1 });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("rechecks retention under the physical lock before claiming environment-wide teardown", async () => {
    const f = await fixture();
    const service = await f.create(false);
    const { allocation } = await f.manager.getRecord(f.companyId, service.id);
    await db.update(runtimeServiceAllocations).set({ metadata: { ...allocation.metadata, retentionReleased: true } }).where(eq(runtimeServiceAllocations.id, allocation.id));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment" }).where(eq(environmentLeases.id, f.lease.id));
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const retain = withRuntimeServiceLeaseLock(db, f.lease, async tx => {
      entered();
      await pending;
      await tx.update(runtimeServiceAllocations).set({ metadata: allocation.metadata }).where(eq(runtimeServiceAllocations.id, allocation.id));
    });
    await ready;
    const teardown = f.runtime.destroyReusableSandboxLeasesForEnvironment({ environmentId: f.environment.id });
    try {
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`);
        expect(waiting.length).toBeGreaterThan(0);
      });
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      expect(lease?.status).toBe("active");
    } finally { release(); }
    await retain;
    expect(await teardown).toMatchObject({ destroyed: 0, failed: 0, skippedRetainedService: 1 });
    expect(f.call).not.toHaveBeenCalled();
  });

  it("serializes creation against physical sandbox teardown", async () => {
    const f = await fixture();
    let begun!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { begun = resolve; });
    const release = new Promise<void>((resolve) => { finish = resolve; });
    const cleanup = withRuntimeServiceLeaseLock(db, f.lease, async (tx) => {
      begun(); await release;
      await tx.update(environmentLeases).set({ status: "expired" }).where(eq(environmentLeases.id, f.lease.id));
    });
    await entered;
    const creating = f.create();
    finish();
    await cleanup;
    await expect(creating).rejects.toMatchObject({ status: 409 });
  });

  it("keeps the source workspace open after task completion and rejects destructive close", async () => {
    const f = await fixture();
    await f.create(false);
    const [task] = await db.insert(issues).values({ companyId: f.companyId, projectId: f.workspace.projectId, title: "Finished app", status: "done", executionWorkspaceId: f.workspace.id }).returning();
    await db.update(executionWorkspaces).set({ sourceIssueId: task!.id }).where(eq(executionWorkspaces.id, f.workspace.id));
    const workspaces = executionWorkspaceService(db);
    await expect(workspaces.archiveWorkspaceUnderLifecycleLock({ id: f.workspace.id, patch: { status: "archived" }, closedAt: new Date() })).rejects.toMatchObject({ status: 409 });
    expect(await workspaces.sweepTerminalWorkspaces()).toMatchObject({ archived: 0, skippedRetainedServices: 1 });
    expect(await workspaces.getById(f.workspace.id)).toMatchObject({ status: "active", closedAt: null });
    expect(await fs.readFile(path.join(f.cwd, "dirty.txt"), "utf8")).toContain("uncommitted");
  });
});
