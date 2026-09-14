import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, projects, runtimeServices, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createRuntimeServiceSchema, registerRuntimeServiceSchema } from "@paperclipai/shared";
import type { PluginEnvironmentProcessHandoffParams, PluginEnvironmentServiceParams } from "@paperclipai/plugin-sdk";
import { environmentRuntimeService } from "../environment-runtime.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { createDaytonaRuntimeServiceProvider } from "./daytona-provider.js";
import { createRuntimeServiceManager } from "./manager.js";
import { NativeProcessOwnership, nativeProcessOwnershipScope } from "../native-runtime/native-process-ownership.js";
import { persistHeartbeatRunProcessMetadata } from "../run-process-metadata.js";
import type { AdapterProcessSpawnMetadata } from "@paperclipai/adapter-utils";

describe("remote process registration through durable service and environment boundaries", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-remote-handoff-"); db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-remote-handoff-"));
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); });

  async function fixture() {
    const companyId = randomUUID(), providerLeaseId = randomUUID(), pluginId = randomUUID(), cwd = path.join(root, companyId);
    await fs.mkdir(cwd);
    await db.insert(companies).values({ id: companyId, name: "Remote handoff", issuePrefix: `H${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Developer" }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "App" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, name: "App", mode: "isolated_workspace", strategyType: "git_worktree", cwd }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "App", status: "in_progress", assigneeAgentId: agent!.id, executionWorkspaceId: workspace!.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running", processPid: 40, processStartedAt: new Date(), processGroupId: null, nativeIssueId: issue!.id, contextSnapshot: { issueId: issue!.id } }).returning();
    const [environment] = await db.insert(environments).values({ name: companyId, driver: "sandbox", config: { provider: "daytona", image: "node:24" } }).returning();
    const leaseId = randomUUID(), connection = { scopeId: run!.id, fingerprint: "a".repeat(64) };
    const processIdentity = { version: 1, pid: 40, uid: 1000, processGroupId: 40, bootId: randomUUID(), startTicks: "100" };
    const [lease] = await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId: environment!.id, executionWorkspaceId: workspace!.id, heartbeatRunId: run!.id, provider: "daytona", providerLeaseId, status: "active",
      metadata: { driver: "sandbox", provider: "daytona", sandboxProviderPlugin: true, pluginId,
        runtimeServiceBoundary: { version: 1, provider: "daytona", workspaceRoot: cwd },
        runtimeServiceProcessOwner: { version: 1, provider: "daytona", environmentLeaseId: leaseId, providerLeaseId, runId: run!.id, workspaceRoot: cwd, process: processIdentity },
        runtimeServiceRunScope: { version: 1, companyId, environmentId: environment!.id, executionWorkspaceId: workspace!.id, pluginId, configurationDigest: "b".repeat(64), connection },
      } }).returning();
    const original = { stopped: false, stopCalls: 0, starts: 0, loseStopResponse: false, failCapture: false, mismatchConnection: false };
    const methods = ["environmentService", "environmentProcessHandoff"];
    const call = vi.fn(async (_pluginId: string, method: string, raw: unknown) => {
      if (method === "environmentProcessHandoff") {
        const params = raw as PluginEnvironmentProcessHandoffParams;
        expect(params.providerLeaseId).toBe(providerLeaseId); expect(params.workspaceConnection).toEqual(connection);
        expect(params.config).not.toHaveProperty("runtimeServiceProcessOwner"); expect(params.config).not.toHaveProperty("runtimeServiceBoundary");
        if (params.operation.action === "capture") {
          expect(params.operation.owner).toEqual(processIdentity);
          if (original.failCapture) return { state: "failed", errorCode: "PROCESS_OWNERSHIP_UNVERIFIED", workspaceConnection: connection };
          return { state: "captured", key: createHash("sha256").update(companyId).digest("hex"), workspaceConnection: original.mismatchConnection ? { ...connection, fingerprint: "c".repeat(64) } : connection,
            receipt: { version: 1, scope: { companyId, environmentId: environment!.id, providerLeaseId }, boot: { bootId: processIdentity.bootId, initStartTicks: "1", uid: 1000 }, groupId: 42, leaderIdentity: "110", members: [{ pid: 42, identity: "110" }] } };
        }
        const service = (await db.select().from(runtimeServices).where(eq(runtimeServices.companyId, companyId))).find(row => row.processHandoff);
        expect(service?.processHandoff).toMatchObject({ phase: "pending", sourceRunId: service!.startedByRunId, receipt: { process: params.operation.receipt } });
        original.stopCalls++; original.stopped = true;
        if (original.loseStopResponse) { original.loseStopResponse = false; throw new Error("Synthetic lost Stop response"); }
        return { state: "stopped", workspaceConnection: connection };
      }
      const params = raw as PluginEnvironmentServiceParams;
      if (params.action === "start") { expect(original.stopped).toBe(true); original.starts++; }
      if (params.action === "inspect" && !original.starts) return { state: "missing", endpoints: [], workspaceConnection: connection };
      return { state: params.action === "retain" ? "retained" : params.action === "stop" ? "exited" : "running",
        processRef: { generation: params.generation }, endpoints: [], workspaceConnection: connection };
    });
    const worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: methods }), call } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const provider = createDaytonaRuntimeServiceProvider({ operate: input => runtime.operateRuntimeService(input), handoff: input => runtime.operateRuntimeServiceProcessHandoff(input), logRoot: path.join(cwd, "logs") });
    const manager = createRuntimeServiceManager(db, { providers: [provider] });
    const placement = { provider: "daytona", reuseKey: providerLeaseId, environmentLeaseId: lease!.id, executionWorkspaceId: workspace!.id, cwd };
    const actor = { type: "agent" as const, id: agent!.id, runId: run!.id };
    const input = registerRuntimeServiceSchema.parse({ issueId: issue!.id, name: "Worker", purpose: "worker", command: "node worker.cjs", sourcePid: 42, requestId: randomUUID() });
    const register = () => manager.register(companyId, actor, input, placement);
    return { companyId, run: run!, lease: lease!, original, call, methods, runtime, manager, placement, actor, input, register };
  }

  it("persists before stopping and relaunches after the source run ends; duplicate requests converge", async () => {
    const f = await fixture();
    const [service, repeated] = await Promise.all([f.register(), f.register()]); expect(repeated.id).toBe(service.id);
    expect(service).toMatchObject({ startedByRunId: f.run.id, handoff: { phase: "pending" } }); expect(f.original.stopped).toBe(false);
    await db.update(heartbeatRuns).set({ status: "succeeded", processPid: null }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, f.lease.id));
    for (let attempt = 0; attempt < 3; attempt++) await f.manager.reconcile(f.companyId, service.id);
    expect(await f.manager.get(f.companyId, service.id)).toMatchObject({ state: "ready", handoff: { phase: "complete" } });
    expect(f.original).toMatchObject({ stopped: true, stopCalls: 1, starts: 1 });
    expect((await f.register()).id).toBe(service.id); expect(f.original.starts).toBe(1);
  });
  it("carries an attested warm runner into the next run's lease, then registers and relaunches its command", async () => {
    const f = await fixture(), firstOwner = Symbol(), secondOwner = Symbol(), relay = new NativeProcessOwnership();
    const meta: AdapterProcessSpawnMetadata = { pid: 40, processGroupId: null, startedAt: f.run.processStartedAt!.toISOString(), processLocation: "remote",
      remoteProcessIdentity: (f.lease.metadata!.runtimeServiceProcessOwner as { process: NonNullable<AdapterProcessSpawnMetadata["remoteProcessIdentity"]> }).process };
    await relay.bind(firstOwner, async value => { await persistHeartbeatRunProcessMetadata(db, f.run.id, value, f.lease.id); });
    await relay.record(meta); await relay.release(firstOwner);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, f.lease.id));
    const [nextRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.actor.id, status: "running", nativeIssueId: f.run.nativeIssueId, contextSnapshot: f.run.contextSnapshot }).returning();
    const [nextLease] = await db.insert(environmentLeases).values({ ...f.lease, id: randomUUID(), heartbeatRunId: nextRun!.id, status: "active" }).returning();
    const target = { kind: "remote" as const, transport: "sandbox" as const, providerKey: "daytona", environmentId: f.lease.environmentId, leaseId: f.lease.id, remoteCwd: f.placement.cwd };
    expect(await nativeProcessOwnershipScope(db, f.companyId, { ...target, leaseId: nextLease!.id })).toBe(await nativeProcessOwnershipScope(db, f.companyId, target));
    await relay.bind(secondOwner, async value => { await persistHeartbeatRunProcessMetadata(db, nextRun!.id, value, nextLease!.id); });
    const [saved] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, nextLease!.id));
    expect(saved?.metadata?.runtimeServiceProcessOwner).toMatchObject({ runId: nextRun!.id, environmentLeaseId: nextLease!.id, process: meta.remoteProcessIdentity });
    const service = await f.manager.register(f.companyId, { ...f.actor, runId: nextRun!.id }, f.input, { ...f.placement, environmentLeaseId: nextLease!.id });
    expect(service.startedByRunId).toBe(nextRun!.id); expect(f.original.stopped).toBe(false);
    await f.manager.reconcile(f.companyId, service.id);
    expect(await f.manager.get(f.companyId, service.id)).toMatchObject({ state: "ready", handoff: { phase: "complete" } });
    expect(f.original).toMatchObject({ starts: 1, stopCalls: 1 }); await relay.release(secondOwner); relay.close();
  });
  it("does not reuse warm process scope across a different sandbox, connection, company or missing receipt", async () => {
    const f = await fixture();
    const target = { kind: "remote" as const, transport: "sandbox" as const, providerKey: "daytona", environmentId: f.lease.environmentId, leaseId: f.lease.id, remoteCwd: f.placement.cwd };
    const original = await nativeProcessOwnershipScope(db, f.companyId, target); expect(original).toMatch(/^[a-f0-9]{64}$/);
    expect(await nativeProcessOwnershipScope(db, randomUUID(), target)).toBeNull();
    await db.update(environmentLeases).set({ providerLeaseId: randomUUID() }).where(eq(environmentLeases.id, f.lease.id));
    expect(await nativeProcessOwnershipScope(db, f.companyId, target)).not.toBe(original);
    await db.update(environmentLeases).set({ providerLeaseId: f.lease.providerLeaseId, metadata: { ...f.lease.metadata, runtimeServiceRunScope: { ...(f.lease.metadata!.runtimeServiceRunScope as Record<string, unknown>), connection: { scopeId: randomUUID(), fingerprint: "d".repeat(64) } } } }).where(eq(environmentLeases.id, f.lease.id));
    expect(await nativeProcessOwnershipScope(db, f.companyId, target)).not.toBe(original);
    await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, runtimeServiceRunScope: null } }).where(eq(environmentLeases.id, f.lease.id));
    expect(await nativeProcessOwnershipScope(db, f.companyId, target)).toBeNull();
  });
  it("does not start after an uncertain Stop, then explicit retry recovers the committed handoff without another registration", async () => {
    const f = await fixture(), service = await f.register(); f.original.loseStopResponse = true;
    await f.manager.reconcile(f.companyId, service.id);
    expect(f.original).toMatchObject({ stopped: true, stopCalls: 1, starts: 0 });
    expect((await f.manager.getRecord(f.companyId, service.id)).service.processHandoff?.phase).toBe("pending");
    const failed = await f.manager.get(f.companyId, service.id);
    await f.manager.control(f.companyId, service.id, { type: "board", id: "operator" }, { requestId: randomUUID(), expectedRevision: failed.revision, action: "start" });
    for (let attempt = 0; attempt < 3; attempt++) await f.manager.reconcile(f.companyId, service.id);
    expect(f.original).toMatchObject({ stopCalls: 2, starts: 1 });
  });
  it("requires the exact committed receipt and company before the stop RPC", async () => {
    const f = await fixture(), service = await f.register();
    const saved = (await f.manager.getRecord(f.companyId, service.id)).service.processHandoff!.receipt;
    for (const request of [
      { companyId: randomUUID(), serviceId: service.id, receipt: saved }, { companyId: f.companyId, serviceId: randomUUID(), receipt: saved },
      { companyId: f.companyId, serviceId: service.id, receipt: { ...saved, process: {} } },
    ]) await expect(f.runtime.operateRuntimeServiceProcessHandoff({ action: "stop", ...request })).rejects.toThrow();
    expect(f.original.stopCalls).toBe(0);
  });
  it("binds a new run's handoff to an allocation retained through an older lease on the same sandbox", async () => {
    const f = await fixture();
    const [older] = await db.insert(environmentLeases).values({ ...f.lease, id: randomUUID(), heartbeatRunId: null, status: "retained" }).returning();
    const existing = await f.manager.create(f.companyId, { type: "board", id: "operator" }, createRuntimeServiceSchema.parse({ name: "Existing", purpose: "worker", command: "node existing.cjs", start: false, requestId: randomUUID() }), { ...f.placement, environmentLeaseId: older!.id });
    const service = await f.register(); expect(service.allocationId).toBe(existing.allocationId);
    expect((await f.manager.getRecord(f.companyId, service.id)).allocation.environmentLeaseId).toBe(older!.id);
    await f.manager.reconcile(f.companyId, service.id);
    expect(f.original).toMatchObject({ stopped: true, stopCalls: 1, starts: 1 });
  });
  it.each(["process", "connection"])("rechecks %s after provider capture before committing a registration", async (change) => {
    const f = await fixture(), original = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (pluginId, method, input) => {
      const result = await original(pluginId, method, input);
      if (method === "environmentProcessHandoff") {
        if (change === "process") await db.update(heartbeatRuns).set({ processPid: 400 }).where(eq(heartbeatRuns.id, f.run.id));
        else await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, runtimeServiceRunScope: { ...(f.lease.metadata!.runtimeServiceRunScope as Record<string, unknown>), connection: { scopeId: f.run.id, fingerprint: "d".repeat(64) } } } }).where(eq(environmentLeases.id, f.lease.id));
      }
      return result;
    });
    await expect(f.register()).rejects.toMatchObject({ status: 422 });
    expect(await f.manager.list(f.companyId)).toEqual([]); expect(f.original.stopCalls).toBe(0);
  });
  it.each(["missing", "changed_pid", "ended", "connection", "capability", "provider_rejection"])("leaves the command untouched when capture is denied: %s", async (cause) => {
    const f = await fixture();
    if (cause === "missing") await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, runtimeServiceProcessOwner: null } }).where(eq(environmentLeases.id, f.lease.id));
    if (cause === "changed_pid") await db.update(heartbeatRuns).set({ processPid: 400 }).where(eq(heartbeatRuns.id, f.run.id));
    if (cause === "ended") await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    if (cause === "connection") f.original.mismatchConnection = true;
    if (cause === "capability") f.methods.splice(f.methods.indexOf("environmentProcessHandoff"), 1);
    if (cause === "provider_rejection") f.original.failCapture = true;
    await expect(f.register()).rejects.toMatchObject({ status: 422 });
    expect(await f.manager.list(f.companyId)).toEqual([]); expect(f.original).toMatchObject({ stopped: false, stopCalls: 0, starts: 0 });
  });
  it("capacity denial after capture never stops the original command", async () => {
    const f = await fixture();
    await f.manager.updateCompanyPolicy(f.companyId, { type: "board", id: "operator" }, { requestId: randomUUID(), expectedRevision: 0, config: { maxRunningServices: 1 } });
    await f.manager.create(f.companyId, { type: "board", id: "operator" }, createRuntimeServiceSchema.parse({ name: "Existing", purpose: "worker", command: "node existing.cjs", requestId: randomUUID() }), f.placement);
    await expect(f.register()).rejects.toMatchObject({ status: 409 }); expect(f.original.stopCalls).toBe(0);
  });
  it("a deletion fence established after capture prevents the stop RPC", async () => {
    const f = await fixture(), service = await f.register();
    const saved = (await f.manager.getRecord(f.companyId, service.id)).service.processHandoff!.receipt;
    await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, runtimeServiceDataDeletionId: randomUUID() } }).where(eq(environmentLeases.id, f.lease.id));
    await expect(f.runtime.operateRuntimeServiceProcessHandoff({ action: "stop", companyId: f.companyId, serviceId: service.id, receipt: saved })).rejects.toMatchObject({ status: 409 });
    expect(f.original.stopCalls).toBe(0);
  });
});
