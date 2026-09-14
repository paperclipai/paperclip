import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express, { type Request } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issues, executionWorkspaces, projects, runtimeServiceDataDeletions, runtimeServiceTaskWorkspaces, builtInManagedResources, companies, createDb, environmentLeases, environments, plugins, runtimeServiceAllocations, runtimeServices, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createRuntimeServiceSchema } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { createRuntimeServiceDataDeletionExecutor, createRuntimeServiceDataDeletionStore } from "./data-deletion.js";
import { createRuntimeServiceDependencies } from "./application.js";
import { environmentService } from "../environments.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { resolveEnvironmentExecutionTarget } from "../environment-execution-target.js";
import { prepareNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";
import { materializeRuntimeServiceTaskMirror } from "./task-workspace.js";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runtimeServiceRoutes } from "../../routes/runtime-services.js";
import { errorHandler } from "../../middleware/error-handler.js";

describe("durable service-owned sandbox allocation through production host operations", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const pluginId = randomUUID();
  const board = { actor: { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true } } as Request;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-service-provisioning-"); db = createDb(database.connectionString);
    await db.insert(plugins).values({ id: pluginId, pluginKey: "test.daytona", packageName: "test-daytona", version: "1.0.0", status: "ready", categories: ["automation"],
      manifestJson: { id: "test.daytona", apiVersion: 1, version: "1.0.0", displayName: "Daytona fixture", description: "Provider boundary fixture", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "worker.js" },
        environmentDrivers: [{ driverKey: "daytona", kind: "sandbox_provider", displayName: "Daytona", supportsReusableLeases: true, configSchema: { type: "object", properties: {} } }],
      } });
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(remoteCwd = "/home/daytona") {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Service allocation", issuePrefix: `A${companyId.slice(0, 6)}` });
    const [environment] = await db.insert(environments).values({ name: `Daytona ${companyId}`, driver: "sandbox", config: { provider: "daytona", image: "node:24" } }).returning();
    const resources = new Map<string, string>();
    const runningGenerations = new Set<string>();
    let loseResponse = false;
    let invalidDirectory = false;
    let gate: (() => Promise<void>) | undefined;
    let connectionGate: (() => Promise<void>) | undefined;
    let storageGate: (() => Promise<void>) | undefined;
    let deletionGate: (() => Promise<void>) | undefined;
    let lostDeletionResponse = false;
    let fingerprint = "a".repeat(64);
    let resourcesVerified: boolean | undefined = true;
    let serviceResourceMismatch = false;
    let methods = ["environmentGetServiceConnection", "environmentAcquireServiceLease", "environmentService", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentDeleteServiceData"];
    const call = vi.fn(async (_plugin: string, method: string, input: Record<string, any>) => {
      if (method === "environmentGetServiceConnection") { if (connectionGate) await connectionGate(); return { fingerprint, ...(input.checkResources ? { resourcesVerified } : {}) }; }
      if (method === "environmentDeleteServiceData") {
        if (input.serviceConnectionFingerprint !== fingerprint) throw new Error("The provider connection changed");
        if (deletionGate) await deletionGate();
        resources.delete(input.serviceAllocationId);
        if (lostDeletionResponse) { lostDeletionResponse = false; throw new Error("Deleted resource but lost response containing private connection details"); }
        return { state: "destroyed", providerLeaseId: input.providerLeaseId, serviceAllocationId: input.serviceAllocationId, deletionId: input.deletionId };
      }
      if (method === "environmentAcquireServiceLease") {
        if (!resources.has(input.serviceAllocationId)) resources.set(input.serviceAllocationId, randomUUID());
        if (gate) await gate();
        if (loseResponse) { loseResponse = false; throw new Error("Acquisition response lost"); }
        return { providerLeaseId: resources.get(input.serviceAllocationId), metadata: {
          remoteCwd: invalidDirectory ? "relative-root" : remoteCwd, shellCommand: "bash", apiKey: "must-not-be-persisted",
          workspaceSentinel: { path: `${remoteCwd}/.paperclip/workspace.json`, token: "stable-token", result: "written" },
        } };
      }
      if (method === "environmentResumeLease") {
        if (input.workspaceConnection?.fingerprint !== fingerprint) throw new Error("Connection changed");
        return { providerLeaseId: input.providerLeaseId, metadata: { remoteCwd, shellCommand: "bash", workspaceConnection: input.workspaceConnection,
          workspaceSentinel: { path: `${remoteCwd}/.paperclip/workspace.json`, token: "stable-token", result: "matched" } } };
      }
      if (method !== "environmentService") throw new Error(`Unexpected ${method}`);
      if (serviceResourceMismatch && ["start", "inspect", "endpoint"].includes(input.action)) return { state: "running", errorCode: "RESOURCE_CONFIGURATION_MISMATCH" };
      if (input.action === "storage_usage") { if (storageGate) await storageGate(); return { state: "running", storageUsage: { bytes: 8192 } }; }
      if (input.action === "start") { runningGenerations.add(input.generation); return { state: "running", processRef: { generation: input.generation } }; }
      if (input.action === "inspect") return { state: runningGenerations.has(input.generation) ? "running" : "missing", endpoints: [] };
      if (input.action === "stop") { runningGenerations.delete(input.generation); return { state: "exited" }; }
      if (input.action === "retain") return { state: "retained" };
      if (input.action === "release_compute") return { state: "stopped" };
      if (input.action === "logs") return { state: "running", logs: "Worker output" };
      return { state: "exited" };
    });
    const worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: methods }), call } as unknown as PluginWorkerManager;
    const make = () => createRuntimeServiceDependencies(db, { pluginWorkerManager: worker });
    const app = make();
    const input = createRuntimeServiceSchema.parse({ requestId: randomUUID(), name: "Standalone worker", purpose: "worker", environmentId: environment!.id, cwd: "app", command: "node worker.cjs", start: false });
    const create = (next = input) => app.operations.create(board, companyId, next);
    const control = async (action: "start" | "stop", target = app, serviceId?: string) => {
      const service = serviceId ? await target.manager.get(companyId, serviceId) : (await create());
      await target.operations.control(board, companyId, service.id, { action, requestId: randomUUID(), expectedRevision: service.revision });
      await target.manager.reconcile(companyId, service.id);
      return target.manager.get(companyId, service.id);
    };
    return { companyId, environment: environment!, app, make, input, create, control, call, resources, worker,
      loseNextResponse: () => { loseResponse = true; }, rejectDirectory: () => { invalidDirectory = true; },
      setConnection: (value: string) => { fingerprint = value; },
      setResourceVerification: (value: boolean | undefined) => { resourcesVerified = value; },
      setServiceResourceMismatch: (value: boolean) => { serviceResourceMismatch = value; },
      setConnectionGate: (next: () => Promise<void>) => { connectionGate = next; },
      setStorageGate: (next: () => Promise<void>) => { storageGate = next; },
      setDeletionGate: (next: () => Promise<void>) => { deletionGate = next; },
      loseDeletionResponse: () => { lostDeletionResponse = true; },
      setGate: (next: () => Promise<void>) => { gate = next; }, oldWorker: () => { methods = ["environmentAcquireLease", "environmentService"]; } };
  }

  async function requestDataDeletion(f: Awaited<ReturnType<typeof fixture>>, serviceId: string) {
    const plan = await f.app.operations.dataDeletionReview(board, f.companyId, serviceId);
    expect(plan.blockers).toEqual([]);
    const input = { requestId: randomUUID(), confirmedAllocationId: plan.allocationId, planToken: plan.planToken, confirm: true as const };
    return { input, result: await f.app.operations.deleteData(board, f.companyId, serviceId, input) };
  }

  it.each([false, undefined])("refuses unverified resource settings (%s) before reserving or renting an allocation", async (verification) => {
    const f = await fixture();
    await db.update(environments).set({ config: { provider: "daytona", snapshot: "sized-app", cpu: 4, memory: 8 } }).where(eq(environments.id, f.environment.id));
    f.setResourceVerification(verification);
    await expect(f.create()).rejects.toMatchObject({ status: 422, message: expect.stringContaining("CPU, memory, disk") });
    expect(f.resources.size).toBe(0);
    expect((await f.app.manager.companyPolicy(f.companyId)).usage).toEqual({ runningServices: 0, serviceAllocations: 0 });
    expect(f.call.mock.calls.every(([, method]) => method === "environmentGetServiceConnection")).toBe(true);
    f.setResourceVerification(true);
    expect(await f.create()).toMatchObject({ state: "stopped" });
  });

  it("passes the configured allocation sizes through admission, acquisition and launch", async () => {
    const f = await fixture(); const sizes = { cpu: 4, memory: 8, disk: 20 };
    await db.update(environments).set({ config: { provider: "daytona", image: "node:24", ...sizes } }).where(eq(environments.id, f.environment.id));
    const service = await f.control("start");
    expect(service.state).toBe("ready");
    const preflights = f.call.mock.calls.filter(([, method, input]) => method === "environmentGetServiceConnection" && input.checkResources);
    expect(preflights.length).toBeGreaterThanOrEqual(2);
    for (const [, , input] of preflights) expect(input).toMatchObject({ companyId: f.companyId, environmentId: f.environment.id, config: sizes });
    expect(f.call.mock.calls.find(([, method]) => method === "environmentAcquireServiceLease")?.[2]).toMatchObject({ config: sizes });
    expect(f.call.mock.calls.find(([, method, input]) => method === "environmentService" && input.action === "start")?.[2]).toMatchObject({ config: sizes });
  });

  it("returns an actionable HTTP rejection and permits the same creation request after correction", async () => {
    const f = await fixture();
    await db.update(environments).set({ config: { provider: "daytona", snapshot: "sized-app", cpu: 4, memory: 8 } }).where(eq(environments.id, f.environment.id));
    const api = express(); api.use(express.json());
    api.use((req, _res, next) => { req.actor = board.actor; next(); });
    api.use("/api", runtimeServiceRoutes(db, f.app)); api.use(errorHandler);
    const endpoint = `/api/companies/${f.companyId}/runtime-services`;
    f.setResourceVerification(false);
    const rejected = await request(api).post(endpoint).send(f.input);
    expect(rejected.status).toBe(422);
    expect(rejected.body).toMatchObject({ error: expect.stringContaining("CPU, memory, disk") });
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(0);
    expect(f.resources.size).toBe(0);
    f.setResourceVerification(true);
    const accepted = await request(api).post(endpoint).send(f.input);
    expect(accepted.status).toBe(202); expect(accepted.body).toMatchObject({ name: f.input.name, state: "stopped" });
  });

  it("recovers an accepted creation after the provider can no longer verify snapshot sizes", async () => {
    const f = await fixture();
    await db.update(environments).set({ config: { provider: "daytona", snapshot: "sized-app", cpu: 4, memory: 8 } }).where(eq(environments.id, f.environment.id));
    const service = await f.create(); f.setResourceVerification(false);
    const calls = f.call.mock.calls.length;
    expect((await f.create()).id).toBe(service.id);
    expect(f.call.mock.calls).toHaveLength(calls);
    await expect(f.create({ ...f.input, command: "changed command" })).rejects.toMatchObject({ status: 409 });
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(1);
  });

  it("rechecks size configuration before acquisition and lets an empty failed allocation be deleted", async () => {
    const f = await fixture();
    await db.update(environments).set({ config: { provider: "daytona", image: "node:24", cpu: 4, memory: 8 } }).where(eq(environments.id, f.environment.id));
    const service = await f.create(); f.setResourceVerification(false);
    expect(await f.control("start", f.app, service.id)).toMatchObject({ desiredState: "stopped", state: "stopping", stopReason: "resource_configuration" });
    await f.app.manager.reconcile(f.companyId, service.id);
    expect(await f.app.manager.get(f.companyId, service.id)).toMatchObject({ state: "failed", desiredState: "stopped", error: expect.stringContaining("CPU, memory, disk") });
    expect(f.resources.size).toBe(0);
    const { allocation } = await f.app.manager.getRecord(f.companyId, service.id);
    expect(allocation.metadata.acquisitionStarted).not.toBe(true);
    await f.control("stop", f.app, service.id);
    const deletion = await requestDataDeletion(f, service.id);
    await f.app.manager.reconcileDataDeletion(f.companyId, deletion.result.deletion!.id);
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(0);
    expect(f.call.mock.calls.some(([, method]) => method === "environmentAcquireServiceLease")).toBe(false);
  });

  it("stops a running service after a resource mismatch without crash retries or data deletion", async () => {
    const f = await fixture(); const service = await f.control("start");
    f.setServiceResourceMismatch(true); await f.app.manager.reconcile(f.companyId, service.id);
    expect(await f.app.manager.get(f.companyId, service.id)).toMatchObject({ state: "stopping", desiredState: "stopped", stopReason: "resource_configuration" });
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.runningServices).toBe(1);
    await f.app.manager.reconcile(f.companyId, service.id);
    const failed = await f.app.manager.get(f.companyId, service.id);
    expect(failed).toMatchObject({ state: "failed", desiredState: "stopped", restartCount: 0, error: expect.stringContaining("CPU, memory, disk") });
    expect((await f.app.manager.getRecord(f.companyId, service.id)).service.retryAt).toBeNull();
    for (const kind of ["start", "stop", "observe"] as const) expect(await f.app.manager.reconciliationCandidates(kind, 1000)).not.toContainEqual({ id: service.id, companyId: f.companyId });
    expect((await f.app.manager.companyPolicy(f.companyId)).usage).toEqual({ runningServices: 0, serviceAllocations: 1 });
    expect(f.resources.size).toBe(1);
    expect(f.call.mock.calls.some(([, method, input]) => method === "environmentService" && input.action === "stop")).toBe(true);
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDeleteServiceData")).toBe(false);
    f.setServiceResourceMismatch(false);
    expect(await f.control("start", f.app, service.id)).toMatchObject({ state: "ready" });
    expect(f.resources.size).toBe(1);
  });

  it("releases a never-provisioned allocation without renting or deleting provider compute", async () => {
    const f = await fixture(), service = await f.create();
    const { input, result } = await requestDataDeletion(f, service.id);
    expect(result.deletion?.state).toBe("pending");
    expect(f.call).not.toHaveBeenCalled();
    const replacement = f.make();
    await replacement.manager.reconcileDataDeletion(f.companyId, result.deletion!.id);
    expect(await replacement.manager.get(f.companyId, service.id)).toMatchObject({ state: "deleted", dataDeletion: { id: result.deletion!.id, state: "deleted" } });
    expect((await f.app.operations.deleteData(board, f.companyId, service.id, input)).deletion?.state).toBe("deleted");
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(0);
    await replacement.manager.reconcileAllocation(f.companyId, service.allocationId);
    expect(f.call).not.toHaveBeenCalled();
  });

  it("expires an independent Daytona allocation once, with recoverable provider confirmation", async () => {
    const f = await fixture(), service = await f.control("start");
    await f.control("stop", f.app, service.id);
    const policy = await f.app.manager.updateCompanyPolicy(f.companyId, { type: "board", id: "operator" }, {
      requestId: randomUUID(), expectedRevision: 0, config: { retainedDataSeconds: 86400 },
    });
    let clock = new Date(Date.parse(policy.updatedAt!) + 86400_001);
    const store = () => createRuntimeServiceDataDeletionStore(db, { now: () => clock, executor: createRuntimeServiceDataDeletionExecutor(db, f.worker) });
    await store().expirationTick();
    const pending = (await f.app.manager.get(f.companyId, service.id)).dataDeletion!;
    expect(pending).toMatchObject({ state: "pending", reason: "retention", policyRevision: 1 });
    f.loseDeletionResponse();
    await store().tick();
    expect((await f.app.manager.get(f.companyId, service.id)).dataDeletion).toMatchObject({ state: "failed", reason: "retention" });
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(1);
    expect(f.resources.size).toBe(0);
    clock = new Date(clock.getTime() + 600_000);
    await store().tick();
    expect((await f.app.manager.get(f.companyId, service.id)).dataDeletion).toMatchObject({ id: pending.id, state: "deleted", attempts: 2 });
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(0);
    const calls = f.call.mock.calls.filter(([, method]) => method === "environmentDeleteServiceData");
    expect(calls).toHaveLength(2); expect(calls[0]![2]).toEqual(calls[1]![2]);
  });

  it("reviews all shared physical allocations, rejects stale confirmation and fences subsequent admission", async () => {
    const f = await fixture(), service = await f.control("start");
    const { allocation } = await f.app.manager.getRecord(f.companyId, service.id);
    const peerPlacement = { provider: "daytona", cwd: "/home/daytona/side", reuseKey: randomUUID(), environmentLeaseId: allocation.environmentLeaseId,
      metadata: { executionBoundary: allocation.metadata.executionBoundary } };
    const peerInput = createRuntimeServiceSchema.parse({ requestId: randomUUID(), name: "Shared sibling", command: "node sibling.cjs", start: false });
    const actor = { type: "board" as const, id: "local-board" };
    const peer = await f.app.manager.create(f.companyId, actor, peerInput, peerPlacement);
    const busy = await f.app.operations.dataDeletionReview(board, f.companyId, service.id);
    expect(busy.services.map((item) => item.id).sort()).toEqual([service.id, peer.id].sort());
    expect(peer.allocationId).not.toBe(service.allocationId);
    expect(busy.blockers.some((blocker) => blocker.startsWith("Stop all services"))).toBe(true);
    await f.control("stop", f.app, service.id);
    await expect(f.app.operations.deleteData(board, f.companyId, service.id, { requestId: randomUUID(), confirmedAllocationId: busy.allocationId, planToken: busy.planToken, confirm: true })).rejects.toThrow("changed");
    const { input, result } = await requestDataDeletion(f, peer.id);
    expect(result.allocationId).toBe(service.allocationId);
    const latest = await f.app.manager.get(f.companyId, service.id);
    await expect(f.app.operations.control(board, f.companyId, service.id, { action: "start", expectedRevision: latest.revision, requestId: randomUUID() })).rejects.toThrow("being deleted");
    await expect(f.app.manager.create(f.companyId, actor, { ...peerInput, requestId: randomUUID() }, { ...peerPlacement, reuseKey: randomUUID() })).rejects.toThrow("deleted");
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Late attachment" }).returning();
    await expect(f.app.operations.attachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: latest.revision, issueId: issue!.id })).rejects.toThrow("being deleted");
    expect((await f.app.manager.list(f.companyId)).map((item) => item.id).sort()).toEqual([service.id, peer.id].sort());
    await f.app.manager.reconcileDataDeletion(f.companyId, result.deletion!.id);
    expect((await f.app.operations.deleteData(board, f.companyId, peer.id, input)).deletion?.state).toBe("deleted");
    expect(f.resources.size).toBe(0);
    expect((await f.app.manager.list(f.companyId))).toEqual([]);
    expect((await f.app.manager.get(f.companyId, service.id)).dataDeletion?.state).toBe("deleted");
    expect((await f.app.manager.get(f.companyId, peer.id)).dataDeletion?.id).toBe(result.deletion!.id);
    await expect(f.app.operations.dataDeletionReview(board, randomUUID(), service.id)).rejects.toThrow("not found");
  });

  it("keeps a lost deletion receipt fenced, retryable and counted until a replacement controller verifies it", async () => {
    const f = await fixture(), service = await f.control("start"); await f.control("stop", f.app, service.id);
    const { result } = await requestDataDeletion(f, service.id); f.loseDeletionResponse();
    await f.app.manager.reconcileDataDeletion(f.companyId, result.deletion!.id);
    const failed = await f.app.manager.get(f.companyId, service.id);
    expect(failed.dataDeletion?.state).toBe("failed"); expect(JSON.stringify(failed)).not.toContain("private connection");
    expect(f.resources.size).toBe(0); expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(1);
    const { result: retry } = await requestDataDeletion(f, service.id);
    expect(retry.deletion?.id).toBe(result.deletion!.id);
    const replacement = f.make(); await replacement.manager.reconcileDataDeletion(f.companyId, result.deletion!.id);
    expect((await replacement.manager.get(f.companyId, service.id)).dataDeletion).toMatchObject({ state: "deleted", attempts: 2 });
    const calls = f.call.mock.calls.filter(([, method]) => method === "environmentDeleteServiceData");
    expect(calls).toHaveLength(2); expect(calls[0]![2]).toEqual(calls[1]![2]);
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(0);
  });

  it("does not hold company controls while a provider deletion is slow and coalesces controllers", async () => {
    const f = await fixture(), service = await f.control("start"); await f.control("stop", f.app, service.id);
    const unrelated = await f.create({ ...f.input, requestId: randomUUID(), name: "Unrelated workspace" });
    const { result } = await requestDataDeletion(f, service.id);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); f.setDeletionGate(() => gate);
    const pending = f.app.manager.reconcileDataDeletion(f.companyId, result.deletion!.id);
    try {
      await vi.waitFor(() => expect(f.call.mock.calls.some(([, method]) => method === "environmentDeleteServiceData")).toBe(true));
      await f.make().manager.reconcileDataDeletion(f.companyId, result.deletion!.id);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const started = await Promise.race([f.app.operations.control(board, f.companyId, unrelated.id, { action: "start", requestId: randomUUID(), expectedRevision: unrelated.revision }),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1000); })]);
        expect(started?.desiredState).toBe("running");
      } finally { clearTimeout(timer); }
      expect(f.call.mock.calls.filter(([, method]) => method === "environmentDeleteServiceData")).toHaveLength(1);
    } finally { release(); await pending; }
    expect((await f.app.manager.get(f.companyId, service.id)).dataDeletion?.state).toBe("deleted");
  });

  it("resumes a durable deletion after its controller process dies during a lost provider response", async () => {
    const f = await fixture(), service = await f.control("start");
    await f.control("stop", f.app, service.id);
    const { result } = await requestDataDeletion(f, service.id);
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-deletion-crash-"));
    const receiptPath = path.join(root, "provider-request.json");
    // Production host/database code in a separate process; the provider boundary
    // records acceptance before withholding its response. No live Daytona call.
    const source = `
      import fs from "node:fs/promises";
      import { createDb } from "@paperclipai/db";
      import { createRuntimeServiceDependencies } from ${JSON.stringify(new URL("./application.ts", import.meta.url).href)};
      const worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["environmentDeleteServiceData"] }),
        async call(_id, method, input) {
          if (method !== "environmentDeleteServiceData") throw new Error("Unexpected provider operation");
          await fs.writeFile(process.env.DELETION_TEST_RECEIPT, JSON.stringify(input));
          await new Promise(() => {});
        }
      };
      const app = createRuntimeServiceDependencies(createDb(process.env.DELETION_TEST_DATABASE), { pluginWorkerManager: worker });
      await app.manager.reconcileDataDeletion(process.env.DELETION_TEST_COMPANY, process.env.DELETION_TEST_JOB);
    `;
    const child = spawn(process.execPath, ["--import", new URL("../../../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url).pathname, "--input-type=module", "-e", source], {
      cwd: new URL("../../../../server", import.meta.url).pathname,
      env: { ...process.env, DELETION_TEST_DATABASE: database.connectionString, DELETION_TEST_RECEIPT: receiptPath, DELETION_TEST_COMPANY: f.companyId, DELETION_TEST_JOB: result.deletion!.id },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = ""; child.stderr!.on("data", (chunk) => { stderr += chunk.toString(); });
    const exited = once(child, "exit");
    try {
      await vi.waitFor(async () => {
        if (child.exitCode !== null) throw new Error(`Deletion child exited early: ${stderr}`);
        expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({ deletionId: result.deletion!.id, serviceAllocationId: service.allocationId });
      }, { timeout: 20_000, interval: 100 });
      const [active] = await db.select().from(runtimeServiceDataDeletions).where(eq(runtimeServiceDataDeletions.id, result.deletion!.id));
      expect(active).toMatchObject({ state: "deleting", attempts: 1, providerDeletedAt: null });
      expect(active!.retryAt!.getTime()).toBeGreaterThan(Date.now());
      child.kill("SIGKILL"); expect(await exited).toEqual([null, "SIGKILL"]);
      expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(1);
      await expect(f.control("start", f.app, service.id)).rejects.toThrow(/delet/i);
      const acceptedInput = JSON.parse(await readFile(receiptPath, "utf8"));
      // Model the provider having acted already: retry confirms absence for the
      // same resource/deletion identity without allocating another sandbox.
      f.resources.delete(service.allocationId);
      await f.make().manager.dataDeletionTick();
      expect(f.call.mock.calls.filter(([, method]) => method === "environmentDeleteServiceData")).toHaveLength(0);
      // A different process cannot know the old process died. Model the bounded
      // durable claim expiring before it reclaims the same deletion intent.
      await db.update(runtimeServiceDataDeletions).set({ retryAt: new Date(Date.now() - 1) }).where(eq(runtimeServiceDataDeletions.id, result.deletion!.id));
      await f.make().manager.dataDeletionTick();
      expect(f.call.mock.calls.filter(([, method]) => method === "environmentDeleteServiceData").map(([, , input]) => input)).toEqual([acceptedInput]);
      expect((await f.app.manager.get(f.companyId, service.id)).dataDeletion).toMatchObject({ state: "deleted", attempts: 2 });
      expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited; await rm(root, { recursive: true, force: true });
    }
  }, 35_000);

  it("blocks attached tasks and final sync, then removes only the owned host copy", async () => {
    const f = await fixture(), service = await f.control("start");
    const outside = await mkdtemp(path.join(os.tmpdir(), "paperclip-deletion-neighbor-"));
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Retained files" }).returning();
    await f.app.operations.attachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: service.revision, issueId: issue!.id });
    const [binding] = await db.select().from(runtimeServiceTaskWorkspaces).where(eq(runtimeServiceTaskWorkspaces.issueId, issue!.id));
    const mirror = await materializeRuntimeServiceTaskMirror(binding!);
    try {
      await writeFile(path.join(mirror, "dirty.txt"), "retained uncommitted work");
      await writeFile(path.join(outside, "private.txt"), "neighbor must survive");
      await symlink(outside, path.join(mirror, "outside-link"));
      const stopped = await f.control("stop", f.app, service.id);
      const attached = await f.app.operations.dataDeletionReview(board, f.companyId, service.id);
      expect(attached.tasks).toMatchObject([{ id: issue!.id }]); expect(attached.includesHostMirror).toBe(true);
      await expect(f.app.operations.deleteData(board, f.companyId, service.id, { requestId: randomUUID(), confirmedAllocationId: attached.allocationId, planToken: attached.planToken, confirm: true })).rejects.toThrow("Detach every attached task");
      await f.app.operations.detachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: stopped.revision, issueId: issue!.id });
      const { allocation } = await f.app.manager.getRecord(f.companyId, service.id);
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, allocation.environmentLeaseId!));
      const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Finishing writer" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, status: "succeeded" }).returning();
      const [writer] = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id, provider: "daytona", providerLeaseId: lease!.providerLeaseId, heartbeatRunId: run!.id, status: "active" }).returning();
      expect((await f.app.manager.dataDeletionReview(f.companyId, service.id)).blockers.join(" ")).toContain("final workspace sync");
      await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, writer!.id));
      const { result } = await requestDataDeletion(f, service.id);
      await f.app.manager.reconcileDataDeletion(f.companyId, result.deletion!.id);
      expect((await f.app.manager.get(f.companyId, service.id)).dataDeletion?.state).toBe("deleted");
      await expect(readFile(path.join(mirror, "dirty.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(outside, "private.txt"), "utf8")).toBe("neighbor must survive");
      expect((await db.select().from(runtimeServiceTaskWorkspaces).where(eq(runtimeServiceTaskWorkspaces.id, binding!.id)))[0]).toMatchObject({ issueId: null });
    } finally { await rm(mirror, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });

  it("preserves a replaced host mirror and retries cleanup without repeating confirmed provider destruction", async () => {
    const f = await fixture(), service = await f.control("start");
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Owned copy" }).returning();
    const attached = await f.app.operations.attachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: service.revision, issueId: issue!.id });
    const [binding] = await db.select().from(runtimeServiceTaskWorkspaces).where(eq(runtimeServiceTaskWorkspaces.issueId, issue!.id));
    const mirror = await materializeRuntimeServiceTaskMirror(binding!), original = `${mirror}-original`, replacement = `${mirror}-replacement`;
    try {
      await writeFile(path.join(mirror, "original.txt"), "original source");
      await f.app.operations.detachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: attached.revision, issueId: issue!.id });
      await f.control("stop", f.app, service.id);
      const { result } = await requestDataDeletion(f, service.id);
      await rename(mirror, original); await mkdir(mirror); await writeFile(path.join(mirror, "new.txt"), "new files must survive");
      await f.app.manager.reconcileDataDeletion(f.companyId, result.deletion!.id);
      const [job] = await db.select().from(runtimeServiceDataDeletions).where(eq(runtimeServiceDataDeletions.id, result.deletion!.id));
      expect(job).toMatchObject({ state: "failed" }); expect(job!.providerDeletedAt).not.toBeNull();
      expect(await readFile(path.join(mirror, "new.txt"), "utf8")).toBe("new files must survive");
      expect(await readFile(path.join(original, "original.txt"), "utf8")).toBe("original source");
      await rename(mirror, replacement); await rename(original, mirror);
      f.oldWorker(); // Once provider destruction is confirmed, host cleanup needs no provider RPC.
      await requestDataDeletion(f, service.id);
      await f.make().manager.reconcileDataDeletion(f.companyId, result.deletion!.id);
      expect((await f.app.manager.get(f.companyId, service.id)).dataDeletion?.state).toBe("deleted");
      await expect(readFile(path.join(mirror, "original.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(path.join(replacement, "new.txt"), "utf8")).toBe("new files must survive");
      expect(f.call.mock.calls.filter(([, method]) => method === "environmentDeleteServiceData")).toHaveLength(1);
    } finally { for (const owned of [mirror, original, replacement]) await rm(owned, { recursive: true, force: true }); }
  });

  it("records invalid persisted deletion targets as recoverable failures without provider calls", async () => {
    const f = await fixture(), service = await f.control("start");
    await f.control("stop", f.app, service.id);
    const { result } = await requestDataDeletion(f, service.id);
    const [job] = await db.select().from(runtimeServiceDataDeletions).where(eq(runtimeServiceDataDeletions.id, result.deletion!.id));
    await db.update(runtimeServiceDataDeletions).set({ target: { invalid: true } }).where(eq(runtimeServiceDataDeletions.id, job!.id));
    await f.make().manager.dataDeletionTick();
    const failed = (await f.app.manager.get(f.companyId, service.id)).dataDeletion!;
    expect(failed).toMatchObject({ state: "failed", attempts: 1 }); expect(failed.retryAt).not.toBeNull();
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDeleteServiceData")).toHaveLength(0);
    await db.update(runtimeServiceDataDeletions).set({ target: job!.target }).where(eq(runtimeServiceDataDeletions.id, job!.id));
    await requestDataDeletion(f, service.id);
    await f.make().manager.dataDeletionTick();
    expect((await f.app.manager.get(f.companyId, service.id)).dataDeletion).toMatchObject({ state: "deleted", attempts: 2 });
  });

  it("uses the host-owned allocation root for storage without holding the physical Stop lock", async () => {
    const f = await fixture(), service = await f.control("start");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.setStorageGate(() => gate);
    const scan = f.app.operations.storage(board, f.companyId, service.id, true);
    try {
      await vi.waitFor(() => expect(f.call.mock.calls.some(([, method, input]) => method === "environmentService" && input.action === "storage_usage")).toBe(true));
      const request = f.call.mock.calls.find(([, method, input]) => method === "environmentService" && input.action === "storage_usage")![2];
      expect(request.launch).toEqual({ cwd: "/home/daytona", command: "", env: {}, secretKeys: [], endpoints: [] });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        expect(await Promise.race([f.control("stop", f.app, service.id), new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500); })])).toMatchObject({ state: "stopped" });
      } finally { clearTimeout(timer); }
    } finally { release(); await scan; }
    expect(await f.app.manager.get(f.companyId, service.id)).toMatchObject({ state: "stopped", desiredState: "stopped", storageUsage: { bytes: 8192 } });
  });

  it("reserves one durable claim before compute, deduplicates creation, and starts without an agent run", async () => {
    const f = await fixture(); const [left, right] = await Promise.all([f.create(), f.create()]);
    expect(left.id).toBe(right.id); expect(f.call).not.toHaveBeenCalled();
    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId));
    expect(leases).toHaveLength(1); expect(leases[0]).toMatchObject({ heartbeatRunId: null, providerLeaseId: null, status: "retained" });
    await f.app.manager.reconcileAllocation(f.companyId, left.allocationId); expect(f.call).not.toHaveBeenCalled();
    const started = await f.control("start"); expect(started.state).toBe("ready"); expect(started.startedByRunId).toBeNull();
    expect(f.resources.size).toBe(1);
    const record = await f.app.manager.getRecord(f.companyId, left.id);
    expect(record.service.spec.cwd).toBe("/home/daytona/app");
    expect(JSON.stringify((await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId)))[0])).not.toContain("must-not-be-persisted");
    expect((await f.create()).id).toBe(left.id); expect(f.resources.size).toBe(1);
    expect((await f.control("stop")).state).toBe("stopped");
    expect(f.call.mock.calls.some(([, method, input]) => method === "environmentService" && input.action === "release_compute")).toBe(true);
  });

  it("recovers a lost acquisition response after controller replacement without changing allocation identity", async () => {
    const f = await fixture(); const created = await f.create(); f.loseNextResponse();
    expect((await f.control("start")).state).toBe("failed");
    const replacement = f.make();
    const recovered = await f.control("start", replacement, created.id);
    expect(recovered.state).toBe("ready"); expect(recovered.allocationId).toBe(created.allocationId); expect(f.resources.size).toBe(1);
    const attempts = f.call.mock.calls.filter(([, method]) => method === "environmentAcquireServiceLease");
    expect(attempts).toHaveLength(2); expect(attempts[1]![2]).toEqual(attempts[0]![2]);
    await f.control("stop", replacement, created.id);
  });

  it("honors Stop while acquisition is in flight and releases the recovered compute", async () => {
    const f = await fixture(); const service = await f.create();
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void; const gate = new Promise<void>((resolve) => { finish = resolve; });
    f.setGate(async () => { entered(); await gate; });
    const pending = f.control("start"); await started;
    const current = await f.app.manager.get(f.companyId, service.id);
    await f.app.operations.control(board, f.companyId, service.id, { action: "stop", expectedRevision: current.revision, requestId: randomUUID() });
    finish(); await pending;
    expect((await f.app.manager.get(f.companyId, service.id)).state).toBe("stopped");
    expect(f.call.mock.calls.some(([, method, input]) => method === "environmentService" && input.action === "start")).toBe(false);
    expect(f.call.mock.calls.some(([, method, input]) => method === "environmentService" && input.action === "release_compute")).toBe(true);
  });

  it("does not acquire compute when Stop arrives during the read-only connection check", async () => {
    const f = await fixture(); const service = await f.create();
    let entered!: () => void; const checking = new Promise<void>((resolve) => { entered = resolve; });
    let finish!: () => void; const gate = new Promise<void>((resolve) => { finish = resolve; });
    f.setConnectionGate(async () => { entered(); await gate; });
    const pending = f.control("start"); await checking;
    const current = await f.app.manager.get(f.companyId, service.id);
    await f.app.operations.control(board, f.companyId, service.id, { action: "stop", expectedRevision: current.revision, requestId: randomUUID() });
    finish(); await pending;
    expect((await f.app.manager.get(f.companyId, service.id)).state).toBe("stopped");
    expect(f.call.mock.calls.some(([, method]) => method === "environmentAcquireServiceLease")).toBe(false);
    expect(f.resources.size).toBe(0);
  });

  it("recovers and releases an uncertain allocation after Stop without starting the service", async () => {
    const f = await fixture(); const service = await f.create(); f.loseNextResponse();
    expect((await f.control("start")).state).toBe("failed");
    const replacement = f.make();
    expect((await f.control("stop", replacement, service.id)).state).toBe("stopped");
    await replacement.manager.reconcileAllocation(f.companyId, service.allocationId);
    const acquisitions = f.call.mock.calls.filter(([, method]) => method === "environmentAcquireServiceLease");
    expect(acquisitions).toHaveLength(2); expect(acquisitions[1]![2]).toEqual(acquisitions[0]![2]);
    expect(f.resources.size).toBe(1);
    expect(f.call.mock.calls.some(([, method, input]) => method === "environmentService" && input.action === "start")).toBe(false);
    expect(f.call.mock.calls.some(([, method, input]) => method === "environmentService" && input.action === "release_compute")).toBe(true);
    expect(await replacement.manager.get(f.companyId, service.id)).toMatchObject({ state: "stopped", desiredState: "stopped" });
  });

  it("retains a provider receipt after invalid initialization so Stop can release its compute", async () => {
    const f = await fixture(); const created = await f.create(); f.rejectDirectory();
    expect((await f.control("start")).state).toBe("failed");
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId));
    expect(lease!.providerLeaseId).toBe(f.resources.get(created.allocationId));
    await f.control("stop");
    expect(f.call.mock.calls.some(([, method, input]) => method === "environmentService" && input.action === "release_compute")).toBe(true);
    expect(f.resources.size).toBe(1);
  });

  it("keeps an uncertain allocation bound to its original provider connection", async () => {
    const f = await fixture(); const service = await f.create(); f.loseNextResponse();
    expect((await f.control("start")).state).toBe("failed");
    f.setConnection("b".repeat(64));
    const replacement = f.make();
    const failed = await f.control("start", replacement, service.id);
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/provider connection changed/i);
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentAcquireServiceLease")).toHaveLength(1);
    expect(f.resources.size).toBe(1);
    // Stop keeps the unresolved claim. Restoring the original connection lets a
    // replacement controller find and stop that sandbox without launching work.
    await f.control("stop", replacement, service.id);
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentAcquireServiceLease")).toHaveLength(1);
    f.setConnection("a".repeat(64));
    await replacement.manager.reconcileAllocation(f.companyId, service.allocationId);
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentAcquireServiceLease")).toHaveLength(2);
    expect(f.call.mock.calls.some(([, method, input]) => method === "environmentService" && input.action === "release_compute")).toBe(true);
    expect(f.call.mock.calls.some(([, method, input]) => method === "environmentService" && input.action === "start")).toBe(false);
  });

  it("blocks old workers and foreign-company environments before reserving an allocation", async () => {
    const f = await fixture(); f.oldWorker();
    await expect(f.create()).rejects.toMatchObject({ status: 422 }); expect(f.call).not.toHaveBeenCalled();
    const other = await fixture();
    await db.insert(builtInManagedResources).values({ companyId: other.companyId, bundleKey: "test", resourceKey: "sandbox", resourceKind: "environment",
      resourceId: f.environment.id, stockVersion: "1", stockHash: "test" });
    await expect(f.create()).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(runtimeServiceAllocations).where(eq(runtimeServiceAllocations.companyId, f.companyId))).toHaveLength(0);
  });

  it("rejects inline provider credentials and unsupported network restrictions before reserving compute", async () => {
    const f = await fixture();
    for (const extra of [{ apiKey: "inline-provider-key" }, { networkBlockAll: true }, { networkAllowList: "10.0.0.0/8" }, { domainAllowList: ["example.test"] }]) {
      await db.update(environments).set({ config: { provider: "daytona", image: "node:24", ...extra } }).where(eq(environments.id, f.environment.id));
      await expect(f.create()).rejects.toMatchObject({ status: 422 });
    }
    expect(f.call).not.toHaveBeenCalled();
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId))).toHaveLength(0);
  });

  it("protects a queued service's environment and atomically rejects configuration changes during creation", async () => {
    const f = await fixture();
    const placement = await f.app.resolvePlacement(board, f.companyId, f.input);
    await db.update(environments).set({ config: { provider: "daytona", image: "node:22" } }).where(eq(environments.id, f.environment.id));
    await expect(f.app.manager.create(f.companyId, { type: "board", id: "local-board" }, f.input, placement)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId))).toHaveLength(0);
    await f.create();
    await expect(environmentService(db).remove(f.environment.id)).rejects.toThrow(/retained|runtime service/i);
    expect(await db.select().from(runtimeServices).where(eq(runtimeServices.companyId, f.companyId))).toHaveLength(1);
  });
  it("attaches a projectless task with durable replay and preserves the service lifetime", async () => {
    const f = await fixture();
    const service = await f.control("start");
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Develop independent app" }).returning();
    const input = { requestId: randomUUID(), expectedRevision: service.revision, issueId: issue!.id };
    const attached = await f.app.operations.attachTask(board, f.companyId, service.id, input);
    const replay = await f.app.operations.attachTask(board, f.companyId, service.id, input);
    expect(replay.revision).toBe(attached.revision);
    expect(attached).toMatchObject({ state: "ready", startedAt: service.startedAt, taskWorkspace: { issueId: issue!.id }, executionWorkspaceId: null });
    expect(await db.select().from(runtimeServiceTaskWorkspaces).where(eq(runtimeServiceTaskWorkspaces.companyId, f.companyId))).toHaveLength(1);
    const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Other task" }).returning();
    await expect(f.app.operations.attachTask(board, f.companyId, service.id, { ...input, requestId: randomUUID(), expectedRevision: attached.revision, issueId: other!.id })).rejects.toThrow(/another workspace/);
  });

  it("rejects active tasks, foreign tasks, agents, and unprovisioned services", async () => {
    const f = await fixture(), g = await fixture();
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Developer" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Active app task", assigneeAgentId: agent!.id }).returning();
    const [foreign] = await db.insert(issues).values({ companyId: g.companyId, title: "Foreign task" }).returning();
    const pending = await f.create();
    const input = { requestId: randomUUID(), expectedRevision: pending.revision, issueId: issue!.id };
    await expect(f.app.operations.attachTask(board, f.companyId, pending.id, input)).rejects.toThrow(/provisioned independent/);
    const service = await f.control("start");
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, status: "running", contextSnapshot: { issueId: issue!.id } }).returning();
    await expect(f.app.operations.attachTask(board, f.companyId, service.id, { ...input, expectedRevision: service.revision })).rejects.toThrow(/active run/);
    await expect(f.app.operations.attachTask(board, f.companyId, service.id, { ...input, expectedRevision: service.revision, issueId: foreign!.id })).rejects.toThrow();
    await expect(f.app.operations.attachTask({ actor: { type: "agent", companyId: f.companyId, agentId: agent!.id, runId: run!.id } } as Request,
      f.companyId, service.id, { ...input, expectedRevision: service.revision })).rejects.toThrow();
    expect(await db.select().from(runtimeServiceTaskWorkspaces).where(eq(runtimeServiceTaskWorkspaces.companyId, f.companyId))).toHaveLength(0);
  });

  it("restores the previous task selection, preserves new settings, and fences old detachment retries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-detachment-checkout-"));
    try {
      await writeFile(path.join(root, "dirty.txt"), "uncommitted checkout");
      const f = await fixture(), service = await f.control("start");
      const startsBefore = f.call.mock.calls.filter((call) => call[1] === "environmentService" && call[2].action === "start").length;
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Existing project" }).returning();
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: project!.id,
        mode: "isolated", strategyType: "git_worktree", name: "Existing checkout", cwd: root }).returning();
      const [issue] = await db.insert(issues).values({ companyId: f.companyId, projectId: project!.id, title: "Existing development",
        executionWorkspaceId: workspace!.id, executionWorkspacePreference: "reuse", executionWorkspaceSettings: { mode: "isolated", networkPolicy: "original" } }).returning();
      const attach = async () => f.app.operations.attachTask(board, f.companyId, service.id, {
        requestId: randomUUID(), expectedRevision: (await f.app.manager.get(f.companyId, service.id)).revision, issueId: issue!.id });
      await attach();
      // A distinct accepted request must not replace the original selection.
      const attached = await attach();
      await db.update(issues).set({ executionWorkspaceSettings: { mode: "agent_default", networkPolicy: "newer" } }).where(eq(issues.id, issue!.id));
      const request = { requestId: randomUUID(), expectedRevision: attached.revision, issueId: issue!.id };
      const detached = await f.app.operations.detachTask(board, f.companyId, service.id, request);
      expect(detached).toMatchObject({ issueId: null, taskWorkspace: null, state: "ready", startedAt: service.startedAt, restartCount: 0 });
      expect((await db.select().from(issues).where(eq(issues.id, issue!.id)))[0]).toMatchObject({ executionWorkspaceId: workspace!.id,
        executionWorkspacePreference: "reuse", executionWorkspaceSettings: { mode: "isolated", networkPolicy: "newer" } });
      expect(await readFile(path.join(root, "dirty.txt"), "utf8")).toBe("uncommitted checkout");
      const reattached = await attach();
      const replay = await f.app.operations.detachTask(board, f.companyId, service.id, request);
      expect(replay).toMatchObject({ revision: reattached.revision, taskWorkspace: { issueId: issue!.id } });
      expect(f.call.mock.calls.filter((call) => call[1] === "environmentService" && call[2].action === "start")).toHaveLength(startsBefore);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves newer operator choices and permits detachment after service deletion", async () => {
    const f = await fixture(), service = await f.control("start");
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Change workspace" }).returning();
    const attached = await f.app.operations.attachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: service.revision, issueId: issue!.id });
    await db.update(issues).set({ executionWorkspacePreference: "new", executionWorkspaceSettings: { mode: "isolated", newSetting: true } }).where(eq(issues.id, issue!.id));
    await f.app.operations.control(board, f.companyId, service.id, { action: "delete", requestId: randomUUID(), expectedRevision: attached.revision });
    await f.app.manager.reconcile(f.companyId, service.id);
    const deleted = await f.app.manager.get(f.companyId, service.id);
    expect(deleted.state).toBe("deleted");
    const detached = await f.app.operations.detachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: deleted.revision, issueId: issue!.id });
    expect(detached).toMatchObject({ state: "deleted", taskWorkspace: null });
    expect((await db.select().from(issues).where(eq(issues.id, issue!.id)))[0]).toMatchObject({ executionWorkspacePreference: "new", executionWorkspaceSettings: { mode: "isolated", newSetting: true } });
  });

  it("rejects active task and allocation writers without changing their binding", async () => {
    const f = await fixture(), service = await f.control("start");
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Writer" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Active workspace" }).returning();
    const attached = await f.app.operations.attachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: service.revision, issueId: issue!.id });
    const request = { requestId: randomUUID(), expectedRevision: attached.revision, issueId: issue!.id };
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent!.id, status: "queued", nativeIssueId: issue!.id }).returning();
    await expect(f.app.operations.detachTask(board, f.companyId, service.id, request)).rejects.toThrow(/active run/);
    await db.update(heartbeatRuns).set({ nativeIssueId: null }).where(eq(heartbeatRuns.id, run!.id));
    const [allocation] = await db.select().from(runtimeServiceAllocations).where(eq(runtimeServiceAllocations.id, service.allocationId));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, allocation!.environmentLeaseId!));
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id, provider: "daytona", providerLeaseId: lease!.providerLeaseId, heartbeatRunId: run!.id });
    await expect(f.app.operations.detachTask(board, f.companyId, service.id, request)).rejects.toThrow(/Another active run/);
    expect(await f.app.manager.get(f.companyId, service.id)).toMatchObject({ revision: attached.revision, taskWorkspace: { issueId: issue!.id } });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run!.id));
    expect(await f.app.operations.detachTask(board, f.companyId, service.id, request)).toMatchObject({ taskWorkspace: null });
  });

  it.each(["missing snapshot", "archived workspace", "workspace moved to another project"])("requires a new operator selection for %s", async (reason) => {
    const f = await fixture(), service = await f.control("start");
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Older project" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: project!.id, mode: "isolated", strategyType: "git_worktree", name: "Old checkout" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, projectId: project!.id, title: "Older attachment", executionWorkspaceId: workspace!.id }).returning();
    const attached = await f.app.operations.attachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: service.revision, issueId: issue!.id });
    if (reason === "missing snapshot") await db.update(runtimeServiceTaskWorkspaces).set({ previousTaskWorkspace: null }).where(eq(runtimeServiceTaskWorkspaces.issueId, issue!.id));
    else if (reason === "archived workspace") await db.update(executionWorkspaces).set({ status: "archived" }).where(eq(executionWorkspaces.id, workspace!.id));
    else {
      const [other] = await db.insert(projects).values({ companyId: f.companyId, name: "Different project" }).returning();
      await db.update(executionWorkspaces).set({ projectId: other!.id }).where(eq(executionWorkspaces.id, workspace!.id));
    }
    const request = { requestId: randomUUID(), expectedRevision: attached.revision, issueId: issue!.id };
    await expect(f.app.operations.detachTask(board, f.companyId, service.id, request)).rejects.toThrow(/Choose a workspace/);
    await db.update(issues).set({ executionWorkspacePreference: "new", executionWorkspaceSettings: { mode: "isolated" } }).where(eq(issues.id, issue!.id));
    expect(await f.app.operations.detachTask(board, f.companyId, service.id, request)).toMatchObject({ taskWorkspace: null });
  });

  it("does not restore a selection from the task's former project", async () => {
    const f = await fixture(), service = await f.control("start");
    const [project, next] = await db.insert(projects).values([{ companyId: f.companyId, name: "Former project" }, { companyId: f.companyId, name: "New project" }]).returning();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, projectId: project!.id, title: "Moved task", executionWorkspacePreference: "reuse", executionWorkspaceSettings: { mode: "isolated" } }).returning();
    const attached = await f.app.operations.attachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: service.revision, issueId: issue!.id });
    await db.update(issues).set({ projectId: next!.id }).where(eq(issues.id, issue!.id));
    await f.app.operations.detachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: attached.revision, issueId: issue!.id });
    expect((await db.select().from(issues).where(eq(issues.id, issue!.id)))[0]).toMatchObject({ projectId: next!.id,
      executionWorkspaceId: null, executionWorkspacePreference: "agent_default", executionWorkspaceSettings: { mode: "agent_default" } });
  });

  it("keeps the allocation workspace identity after task deletion and reattaches another task", async () => {
    const f = await fixture(), service = await f.control("start");
    const [issue, next] = await db.insert(issues).values([{ companyId: f.companyId, title: "Delete task" }, { companyId: f.companyId, title: "Continue files" }]).returning();
    const attached = await f.app.operations.attachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: service.revision, issueId: issue!.id });
    const [before] = await db.select().from(runtimeServiceTaskWorkspaces).where(eq(runtimeServiceTaskWorkspaces.allocationId, service.allocationId));
    await db.delete(issues).where(eq(issues.id, issue!.id));
    expect((await db.select().from(runtimeServiceTaskWorkspaces).where(eq(runtimeServiceTaskWorkspaces.id, before!.id)))[0]).toMatchObject({ issueId: null, hostCwd: before!.hostCwd });
    await f.app.operations.attachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: attached.revision, issueId: next!.id });
    expect((await db.select().from(runtimeServiceTaskWorkspaces).where(eq(runtimeServiceTaskWorkspaces.id, before!.id)))[0]).toMatchObject({ issueId: next!.id, hostCwd: before!.hostCwd });
  });

  it("imports a standalone app through native run sync and resumes its files after attachment to another task", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-standalone-attachment-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home")); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "attachment-fixture");
    try {
      const remote = path.join(root, "sandbox"); await mkdir(remote);
      await writeFile(path.join(remote, "app.txt"), "standalone app source");
      await writeFile(path.join(remote, "database.json"), '{"visits":1}');
      await mkdir(path.join(remote, "node_modules")); await writeFile(path.join(remote, "node_modules", "installed.txt"), "original dependencies");
      const f = await fixture(remote), service = await f.control("start");
      const [firstAgent, nextAgent] = await db.insert(agents).values([{ companyId: f.companyId, name: "Developer" }, { companyId: f.companyId, name: "Next developer" }]).returning();
      const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Develop standalone app", assigneeAgentId: firstAgent!.id }).returning();
      await f.app.operations.attachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: service.revision, issueId: issue!.id });
      const [binding] = await db.select().from(runtimeServiceTaskWorkspaces).where(eq(runtimeServiceTaskWorkspaces.issueId, issue!.id));
      const local = await materializeRuntimeServiceTaskMirror(binding!);
      const envs = environmentService(db), runtime = environmentRuntimeService(db, { pluginWorkerManager: f.worker });
      const environment = (await envs.getById(f.environment.id))!;
      const runner: CommandManagedRuntimeRunner = { execute: async (command) => new Promise((resolve, reject) => {
        const startedAt = new Date().toISOString();
        const child = spawn(command.command, command.args ?? [], { cwd: command.cwd, env: { ...process.env, ...command.env } });
        let stdout = "", stderr = "";
        child.stdout.on("data", (data) => { stdout += data.toString(); }); child.stderr.on("data", (data) => { stderr += data.toString(); });
        child.on("error", reject); child.stdin.on("error", reject); child.stdin.end(command.stdin);
        child.on("close", (exitCode, signal) => resolve({ exitCode, signal, timedOut: false, stdout, stderr, startedAt, pid: child.pid ?? null }));
      }) };
      const startRun = async (agentId: string, taskId = issue!.id) => {
        await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, taskId));
        const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, status: "running", contextSnapshot: { issueId: taskId, runtimeServiceTaskWorkspaceId: binding!.id } }).returning();
        const leaseInput = { companyId: f.companyId, environment, issueId: taskId, heartbeatRunId: run!.id, agentId, persistedExecutionWorkspace: null,
          adapterType: "paperclip_runner", runtimeServiceExecutionPolicy: { trustPreset: { kind: "standard" } } };
        const { lease } = await runtime.acquireRunLease(leaseInput);
        const target = await resolveEnvironmentExecutionTarget({ db, companyId: f.companyId, adapterType: "paperclip_runner", environment, lease, leaseId: lease.id, leaseMetadata: lease.metadata });
        if (target?.kind !== "remote" || target.transport !== "sandbox") throw new Error("Missing sandbox target");
        const sync = await prepareNativeWorkspaceSync({ db, runId: run!.id, companyId: f.companyId, workspaceId: binding!.id, workspaceLocalDir: local, lease, target: { ...target, runner } });
        if (!sync) throw new Error("Missing native sync");
        return { run: run!, lease, leaseInput, sync, target };
      };
      const first = await startRun(firstAgent!.id);
      expect(first.target.retainedServiceWorkspace?.initialImport).toBeDefined();
      expect(await readFile(path.join(remote, "app.txt"), "utf8")).toBe("standalone app source");
      await writeFile(path.join(remote, "app.txt"), "first attached edit"); await first.sync.restoreWorkspace();
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, first.run.id));
      await runtime.releaseRunLeases(first.run.id, "released");
      expect(await readFile(path.join(local, "app.txt"), "utf8")).toBe("first attached edit");
      await writeFile(path.join(remote, "database.json"), '{"visits":2}');
      const second = await startRun(nextAgent!.id);
      expect(second.lease.providerLeaseId).toBe(first.lease.providerLeaseId);
      expect(second.target.retainedServiceWorkspace?.initialImport).toBeUndefined();
      expect(await readFile(path.join(remote, "database.json"), "utf8")).toBe('{"visits":2}');
      expect(await readFile(path.join(remote, "node_modules", "installed.txt"), "utf8")).toBe("original dependencies");
      await expect(runtime.acquireRunLease({ ...second.leaseInput, adapterType: "codex_local" })).rejects.toThrow(/configuration/);
      await writeFile(path.join(remote, "app.txt"), "second attached edit"); await second.sync.restoreWorkspace();
      expect(await readFile(path.join(local, "app.txt"), "utf8")).toBe("second attached edit");
      expect(await readFile(path.join(local, "database.json"), "utf8")).toBe('{"visits":2}');
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, second.run.id));
      await runtime.releaseRunLeases(second.run.id, "released");
      const current = await f.app.manager.get(f.companyId, service.id);
      const detached = await f.app.operations.detachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: current.revision, issueId: issue!.id });
      const [nextIssue] = await db.insert(issues).values({ companyId: f.companyId, title: "Continue from another task" }).returning();
      await f.app.operations.attachTask(board, f.companyId, service.id, { requestId: randomUUID(), expectedRevision: detached.revision, issueId: nextIssue!.id });
      expect((await db.select().from(runtimeServiceTaskWorkspaces).where(eq(runtimeServiceTaskWorkspaces.issueId, nextIssue!.id)))[0]).toMatchObject({ id: binding!.id, hostCwd: binding!.hostCwd });
      await writeFile(path.join(remote, "database.json"), '{"visits":3}');
      const third = await startRun(firstAgent!.id, nextIssue!.id);
      expect(third.lease.providerLeaseId).toBe(first.lease.providerLeaseId);
      expect(third.target.retainedServiceWorkspace?.initialImport).toBeUndefined();
      expect(await readFile(path.join(remote, "app.txt"), "utf8")).toBe("second attached edit");
      expect(await readFile(path.join(remote, "node_modules", "installed.txt"), "utf8")).toBe("original dependencies");
      await writeFile(path.join(remote, "app.txt"), "third edit in another task"); await third.sync.restoreWorkspace();
      expect(await readFile(path.join(local, "app.txt"), "utf8")).toBe("third edit in another task");
      expect(await readFile(path.join(local, "database.json"), "utf8")).toBe('{"visits":3}');
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, third.run.id));
      await runtime.releaseRunLeases(third.run.id, "released");
      expect(await f.app.manager.get(f.companyId, service.id)).toMatchObject({ state: "ready", startedAt: service.startedAt, restartCount: 0 });
      expect(f.resources.size).toBe(1);
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  }, 20_000);

});
