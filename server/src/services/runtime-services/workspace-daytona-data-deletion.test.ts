import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Request } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, builtInManagedResources, companies, companySecretBindings, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, plugins,
  projects, projectWorkspaces, runtimeServiceAllocations, runtimeServiceDataDeletions, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createRuntimeServiceSchema } from "@paperclipai/shared";
import { createRuntimeServiceDependencies } from "./application.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { environmentService } from "../environments.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { assertRuntimeServiceLeaseDataAvailable, withRuntimeServiceLeaseLock } from "./retention.js";
import { withTaskWorkspaceDataAdmission } from "./workspace-data-fence.js";
import { secretService } from "../secrets.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";

const board = { actor: { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true } } as Request;
describe("reviewed Daytona task deletion through the real host and database", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  const pluginId = randomUUID(), roots: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-daytona-task-deletion-"); db = createDb(database.connectionString);
    await db.insert(plugins).values({ id: pluginId, pluginKey: "test.daytona-task-deletion", packageName: "test-daytona", version: "1.0.0", status: "ready", categories: ["automation"],
      manifestJson: { id: "test.daytona-task-deletion", apiVersion: 1, version: "1.0.0", displayName: "Daytona fixture", description: "No live provider resources", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "worker.js" },
        environmentDrivers: [{ driverKey: "daytona", kind: "sandbox_provider", displayName: "Daytona", supportsReusableLeases: true,
          configSchema: { type: "object", properties: { apiKey: { type: "string", format: "secret-ref" }, apiUrl: { type: "string" }, target: { type: "string" } } } }],
      } });
  }, 30_000);
  afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
  afterAll(async () => { await database?.cleanup(); });
  async function fixture() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-daytona-task-"))); roots.push(root);
    const cwd = path.join(root, "task"); await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, "dirty.txt"), "retained source");
    const companyId = randomUUID(); await db.insert(companies).values({ id: companyId, name: "Remote task cleanup", issuePrefix: `R${companyId.slice(0, 6)}` });
    const [project] = await db.insert(projects).values({ companyId, name: "App" }).returning();
    const base = path.join(root, "project"); await fs.mkdir(base);
    await db.insert(projectWorkspaces).values({ companyId, projectId: project!.id, name: "Primary", cwd: base, isPrimary: true });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, name: "App checkout", mode: "isolated_workspace",
      strategyType: "project_primary", providerType: "local_fs", cwd, providerRef: cwd, metadata: { createdByRuntime: true } }).returning();
    const [agent] = await db.insert(agents).values({ companyId, name: "Developer" }).returning();
    const [task] = await db.insert(issues).values({ companyId, title: "Develop app", projectId: project!.id, executionWorkspaceId: workspace!.id, assigneeAgentId: agent!.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running", contextSnapshot: { issueId: task!.id, executionWorkspaceId: workspace!.id } }).returning();
    const [environmentRow] = await db.insert(environments).values({ name: `Fixture Daytona ${companyId}`, driver: "sandbox", config: { provider: "daytona", apiUrl: "https://original.provider.test/api", target: "test-region", image: "node:24" } }).returning();
    const environment = (await environmentService(db).getById(environmentRow!.id))!;
    const providerLeaseId = randomUUID(), resources = new Set([providerLeaseId]);
    let fingerprint = "a".repeat(64), available = true, loseResponse = false, invalidReceipt = false;
    let deletionGate: ((input: Record<string, any>) => Promise<void>) | undefined;
    const methods = ["environmentAcquireLease", "environmentGetServiceConnection", "environmentService", "environmentDeleteTaskWorkspaceData"];
    const call = vi.fn(async (_id: string, method: string, input: Record<string, any>) => {
      if (method === "environmentGetServiceConnection") return { fingerprint };
      if (method === "environmentAcquireLease") return { providerLeaseId, metadata: { provider: "daytona", remoteCwd: "/workspace", shellCommand: "bash",
        workspaceConnection: input.workspaceConnection, taskWorkspaceOwnership: { version: 1, executionWorkspaceId: workspace!.id, createdByRunId: input.runId, sandboxName: `task-${providerLeaseId}` } } };
      if (method === "environmentService") return { state: "retained", workspaceConnection: input.workspaceConnection };
      if (method !== "environmentDeleteTaskWorkspaceData") throw new Error(`Unexpected ${method}`);
      if (input.workspaceConnection.fingerprint !== fingerprint) throw new Error("Provider credential details must not leak");
      if (deletionGate) await deletionGate(input);
      resources.delete(input.providerLeaseId);
      if (loseResponse) { loseResponse = false; throw new Error("Deleted, response lost: private provider details"); }
      return { state: "destroyed", providerLeaseId: input.providerLeaseId, executionWorkspaceId: invalidReceipt ? randomUUID() : input.ownership.executionWorkspaceId, deletionId: input.deletionId };
    });
    const worker = { isRunning: () => available, getWorker: () => ({ supportedMethods: methods }), call } as unknown as PluginWorkerManager;
    const make = () => createRuntimeServiceDependencies(db, { pluginWorkerManager: worker }), app = make();
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const lease = (await runtime.acquireRunLease({ companyId, environment, issueId: task!.id, agentId: agent!.id, heartbeatRunId: run!.id,
      persistedExecutionWorkspace: { id: workspace!.id, mode: "isolated_workspace" }, adapterType: "paperclip_runner",
      runtimeServiceExecutionPolicy: { trustPreset: { kind: "standard" }, networkScope: "enabled" } })).lease;
    const input = createRuntimeServiceSchema.parse({ requestId: randomUUID(), name: "Remote app", purpose: "worker", issueId: task!.id, command: "node app.cjs", start: false });
    const placement = { provider: "daytona", cwd: "/workspace", reuseKey: providerLeaseId, environmentLeaseId: lease.id, executionWorkspaceId: workspace!.id };
    const service = await app.manager.create(companyId, { type: "board", id: "local-board" }, input, placement);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run!.id));
    await runtime.releaseRunLeases(run!.id, "released");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, task!.id));
    call.mockClear();
    const review = () => app.operations.dataDeletionReview(board, companyId, service.id);
    const accept = async () => { const plan = await review(); expect(plan.blockers).toEqual([]);
      const request = { requestId: randomUUID(), confirmedAllocationId: plan.allocationId, planToken: plan.planToken, confirm: true as const };
      return { request, plan: await app.operations.deleteData(board, companyId, service.id, request) }; };
    const addSandbox = async (samePhysical = false) => {
      const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
      const id = samePhysical ? providerLeaseId : randomUUID(); resources.add(id);
      const [nextLease] = await db.insert(environmentLeases).values({ ...source!, id: randomUUID(), providerLeaseId: id, metadata: { ...source!.metadata,
        taskWorkspaceOwnership: { ...(source!.metadata!.taskWorkspaceOwnership as object), sandboxName: `task-${id}` } } }).returning();
      const peer = await app.manager.create(companyId, { type: "board", id: "local-board" }, { ...input, name: "Historical task worker", requestId: randomUUID() },
        { ...placement, reuseKey: randomUUID(), environmentLeaseId: nextLease!.id });
      call.mockClear();
      return { lease: nextLease!, service: peer };
    };
    return { root, cwd, companyId, workspace: workspace!, task: task!, run: run!, environment, app, make, lease, service, placement, input, resources, call, methods,
      review, accept, addSandbox, runtime, setAvailable: (value: boolean) => { available = value; }, setFingerprint: (value: string) => { fingerprint = value; },
      setGate: (value?: typeof deletionGate) => { deletionGate = value; }, loseResponse: () => { loseResponse = true; }, invalidReceipt: (value: boolean) => { invalidReceipt = value; } };
  }
  it("deletes all reviewed task sandboxes and the local checkout using original run ownership", async () => {
    const f = await fixture(), peer = await f.addSandbox(), history = await f.addSandbox(true);
    const review = await f.review(); expect(review.blockers).toEqual([]); expect(review.provider).toBe("daytona"); expect(review.includesHostMirror).toBe(true);
    expect(review.remoteSandboxes).toHaveLength(2); expect(review.services).toHaveLength(3);
    const { request, plan } = await f.accept();
    expect(f.call).not.toHaveBeenCalled(); expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(3);
    await db.update(environments).set({ config: { provider: "daytona", apiUrl: "https://replacement.provider.test/api", target: "another-region" } }).where(eq(environments.id, f.environment.id));
    await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    const complete = await f.review(); expect(complete.deletion, complete.deletion?.error ?? "").toMatchObject({ state: "deleted", attempts: 1 });
    expect(complete.remoteSandboxes?.every((sandbox) => sandbox.deleted)).toBe(true); expect(complete.blockers).toEqual([]);
    const calls = f.call.mock.calls; expect(calls).toHaveLength(2);
    for (const [id, method, input] of calls) {
      expect(id).toBe(pluginId); expect(method).toBe("environmentDeleteTaskWorkspaceData");
      expect(input.config).toEqual({ apiUrl: "https://original.provider.test/api", target: "test-region", reuseLease: false });
      expect(input.ownership).toMatchObject({ createdByRunId: f.run.id, executionWorkspaceId: f.workspace.id }); expect(input.deletionId).toBe(plan.deletion!.id);
    }
    expect(f.resources.size).toBe(0); await expect(fs.lstat(f.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(0);
    for (const id of [f.service.id, peer.service.id, history.service.id]) expect((await f.app.manager.get(f.companyId, id)).dataDeletion?.id).toBe(plan.deletion!.id);
    expect((await f.app.operations.deleteData(board, f.companyId, f.service.id, request)).deletion?.state).toBe("deleted");
  });
  it("persists partial provider progress and retries a lost response without releasing capacity or losing local files", async () => {
    const f = await fixture(), peer = await f.addSandbox(), { plan } = await f.accept();
    const ordered = plan.remoteSandboxes!.map((sandbox) => sandbox.id); let count = 0;
    f.setGate(async () => { if (++count === 2) f.loseResponse(); });
    await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    const failed = await f.review(); expect(failed.deletion?.state).toBe("failed"); expect(failed.deletion?.error).not.toContain("private provider");
    expect(failed.remoteSandboxes?.map((sandbox) => sandbox.deleted)).toEqual([true, false]);
    expect(await fs.readFile(path.join(f.cwd, "dirty.txt"), "utf8")).toBe("retained source");
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(2);
    for (const lease of [f.lease, peer.lease]) await expect(assertRuntimeServiceLeaseDataAvailable(db, lease)).rejects.toThrow(/delet/i);
    await expect(withTaskWorkspaceDataAdmission(db, f.companyId, f.workspace.id, async () => undefined)).rejects.toThrow(/delet/i);
    await expect(f.app.manager.create(f.companyId, { type: "board", id: "operator" }, { ...f.input, requestId: randomUUID() }, f.placement)).rejects.toThrow(/delet/i);
    f.setGate(); await f.accept(); await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion).toMatchObject({ state: "deleted", attempts: 2 });
    expect(f.call.mock.calls.map(([, , params]) => params.providerLeaseId)).toEqual([ordered[0], ordered[1], ordered[1]]);
    expect(f.call.mock.calls[1]![2]).toEqual(f.call.mock.calls[2]![2]);
  });
  it("keeps replacement host directories and finishes confirmed provider cleanup with an offline worker", async () => {
    const f = await fixture(), { plan } = await f.accept(), original = `${f.cwd}-original`;
    f.setGate(async () => { await fs.rename(f.cwd, original); await fs.mkdir(f.cwd); await fs.writeFile(path.join(f.cwd, "replacement.txt"), "keep"); });
    await f.app.manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("failed"); expect((await f.review()).remoteSandboxes?.[0]?.deleted).toBe(true);
    expect(await fs.readFile(path.join(f.cwd, "replacement.txt"), "utf8")).toBe("keep");
    expect((await f.app.manager.companyPolicy(f.companyId)).usage.serviceAllocations).toBe(1);
    f.setAvailable(false); await fs.rename(f.cwd, `${f.cwd}-replacement`); await fs.rename(original, f.cwd);
    await f.accept(); await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("deleted"); expect(f.call).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path.join(`${f.cwd}-replacement`, "replacement.txt"), "utf8")).toBe("keep");
  });
  it("requires fresh review after remote identity changes and refuses legacy, plaintext or independent ownership", async () => {
    const f = await fixture(), original = await f.review(), [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const metadata = lease!.metadata!, ownership = metadata.taskWorkspaceOwnership as object;
    await db.update(environmentLeases).set({ metadata: { ...metadata, taskWorkspaceOwnership: { ...ownership, sandboxName: "changed" } } }).where(eq(environmentLeases.id, f.lease.id));
    await expect(f.app.operations.deleteData(board, f.companyId, f.service.id, { requestId: randomUUID(), confirmedAllocationId: original.allocationId, planToken: original.planToken, confirm: true })).rejects.toThrow("changed");
    for (const patch of [{ taskWorkspaceOwnership: undefined }, { apiKey: "plaintext-private-key" }, { apiKey: { type: "secret_ref", secretId: randomUUID(), version: 1 } }, { serviceAllocationId: randomUUID() }, { runtimeServiceRunScope: { version: 2 } }]) {
      await db.update(environmentLeases).set({ metadata: { ...metadata, ...patch } }).where(eq(environmentLeases.id, f.lease.id));
      expect((await f.review()).blockers.join(" ")).toContain("original task ownership");
      expect(JSON.stringify(await f.review())).not.toContain("plaintext-private-key");
    }
    expect(f.call).not.toHaveBeenCalled(); expect(await fs.readFile(path.join(f.cwd, "dirty.txt"), "utf8")).toBe("retained source");
  });
  it("blocks active final sync and physical lease locks during review acceptance", async () => {
    const f = await fixture();
    await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, f.lease.id));
    expect((await f.review()).blockers.join(" ")).toContain("final file sync");
    await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, f.lease.id));
    let ready!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withRuntimeServiceLeaseLock(db, f.lease, async () => { ready(); await gate; }); await entered;
    try { await expect(f.accept()).rejects.toThrow("in use"); } finally { release(); await held; }
    expect(f.call).not.toHaveBeenCalled();
    const { plan } = await f.accept(); await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("deleted");
  });
  it.each(["same company", "another company"])("refuses a physical sandbox used by another workspace in %s", async (scope) => {
    const f = await fixture(), [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const companyId = scope === "same company" ? f.companyId : randomUUID();
    if (scope !== "same company") await db.insert(companies).values({ id: companyId, name: "Private other company", issuePrefix: `F${companyId.slice(0, 6)}` });
    const [project] = await db.insert(projects).values({ companyId, name: "Private project" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, name: "Private workspace", mode: "isolated_workspace", strategyType: "project_primary", cwd: "/not-a-host-task" }).returning();
    await db.insert(environmentLeases).values({ ...source!, id: randomUUID(), companyId, executionWorkspaceId: workspace!.id, heartbeatRunId: null });
    const plan = await f.review(); expect(plan.blockers.join(" ")).toContain("depends on a remote sandbox");
    expect(JSON.stringify(plan)).not.toContain("Private"); expect(f.call).not.toHaveBeenCalled();
  });
  it("requires the dedicated capability and retains fences on credential or receipt failures", async () => {
    const f = await fixture(); f.methods.splice(f.methods.indexOf("environmentDeleteTaskWorkspaceData"), 1, "environmentDeleteServiceData");
    expect((await f.review()).blockers.join(" ")).toContain("does not support explicit task");
    f.methods.push("environmentDeleteTaskWorkspaceData"); const { plan } = await f.accept();
    f.setFingerprint("b".repeat(64)); await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("failed"); expect(f.resources.size).toBe(1);
    f.setFingerprint("a".repeat(64)); f.invalidReceipt(true); await f.accept(); await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("failed"); expect((await f.review()).remoteSandboxes?.[0]?.deleted).toBe(false);
    expect(await fs.readFile(path.join(f.cwd, "dirty.txt"), "utf8")).toBe("retained source");
    f.invalidReceipt(false); await f.accept(); await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("deleted");
    expect(f.call.mock.calls.every(([, method]) => method === "environmentDeleteTaskWorkspaceData")).toBe(true);
  });
  it("refuses a changed environment company binding before calling the provider", async () => {
    const f = await fixture(), { plan } = await f.accept(), companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Foreign company", issuePrefix: `F${companyId.slice(0, 6)}` });
    await db.insert(builtInManagedResources).values({ companyId, resourceKind: "environment", resourceId: f.environment.id, bundleKey: "test", resourceKey: "foreign", stockHash: "test", stockVersion: "1" });
    await f.app.manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("failed"); expect(f.call).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(f.cwd, "dirty.txt"), "utf8")).toBe("retained source");
  });
  it("stores only original credential references and resolves cleanup after an environment binding is gone", async () => {
    const f = await fixture();
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(f.root, "master.key"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", Buffer.alloc(32, 9).toString("base64"));
    const value = `fixture-provider-key-${randomUUID()}`, secret = await secretService(db).create(f.companyId, { name: "Original provider connection", provider: "local_encrypted", value });
    const binding = { type: "secret_ref", secretId: secret.id, version: "latest" };
    const [originalBinding] = await db.insert(companySecretBindings).values({ companyId: f.companyId, secretId: secret.id, targetType: "environment", targetId: f.environment.id, configPath: "apiKey" }).returning();
    await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ apiKey: binding, nativeHarnessBackup: { token: "not-part-of-deletion" } })}::jsonb` }).where(eq(environmentLeases.id, f.lease.id));
    const { plan } = await f.accept();
    const [job] = await db.select().from(runtimeServiceDataDeletions).where(eq(runtimeServiceDataDeletions.id, plan.deletion!.id));
    expect((job!.target.providers as Array<{ config: { apiKey: unknown } }>)[0]!.config.apiKey).toEqual(binding);
    expect(JSON.stringify(job!.target)).not.toContain(value); expect(JSON.stringify(job!.target)).not.toContain("not-part-of-deletion");
    expect(JSON.stringify(plan)).not.toContain(secret.id);
    await db.delete(companySecretBindings).where(eq(companySecretBindings.id, originalBinding!.id));
    await f.app.manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("deleted"); expect(f.call.mock.calls[0]![2].config.apiKey).toBe(value);
  });
  it("refuses changed physical identities and competing deletion fences without touching either resource", async () => {
    const f = await fixture(), [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ metadata: { ...lease!.metadata, runtimeServiceDataDeletionId: randomUUID() } }).where(eq(environmentLeases.id, f.lease.id));
    expect((await f.review()).blockers.join(" ")).toContain("Another deletion");
    await db.update(environmentLeases).set({ metadata: lease!.metadata }).where(eq(environmentLeases.id, f.lease.id));
    const { plan } = await f.accept();
    await db.update(environmentLeases).set({ providerLeaseId: randomUUID() }).where(eq(environmentLeases.id, f.lease.id));
    await f.app.manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("failed"); expect(f.call).not.toHaveBeenCalled();
    await db.update(environmentLeases).set({ providerLeaseId: lease!.providerLeaseId }).where(eq(environmentLeases.id, f.lease.id));
    await f.accept(); await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("deleted"); expect(f.call).toHaveBeenCalledTimes(1);
  });
  it("requires exact destroyed receipts for ordinary historical sandboxes and includes local sibling services", async () => {
    const f = await fixture(), [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const local = await f.app.manager.create(f.companyId, { type: "board", id: "operator" }, { ...f.input, name: "Local sibling", requestId: randomUUID() },
      { provider: "local", cwd: f.cwd, executionWorkspaceId: f.workspace.id, reuseKey: randomUUID() });
    const identity = { ...source!, id: randomUUID(), providerLeaseId: randomUUID() };
    const receipt = remoteTerminationReceipt(identity, { state: "destroyed", providerLeaseId: identity.providerLeaseId });
    const [history] = await db.insert(environmentLeases).values({ ...identity, status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { provider: "daytona", remoteExecutionTermination: receipt } }).returning();
    const original = await f.app.operations.dataDeletionReview(board, f.companyId, local.id);
    expect(original.blockers).toEqual([]); expect(original.remoteSandboxes).toHaveLength(1); expect(original.services).toHaveLength(2);
    for (const patch of [{ state: "stopped" }, { providerLeaseId: randomUUID() }]) {
      await db.update(environmentLeases).set({ metadata: { provider: "daytona", remoteExecutionTermination: { ...receipt, ...patch } } }).where(eq(environmentLeases.id, history!.id));
      expect((await f.review()).blockers.join(" ")).toContain("original task ownership");
    }
    await db.update(environmentLeases).set({ metadata: history!.metadata }).where(eq(environmentLeases.id, history!.id));
    const plan = await f.app.operations.dataDeletionReview(board, f.companyId, local.id);
    const accepted = await f.app.operations.deleteData(board, f.companyId, local.id, { requestId: randomUUID(), confirmedAllocationId: plan.allocationId, planToken: plan.planToken, confirm: true });
    await f.make().manager.reconcileDataDeletion(f.companyId, accepted.deletion!.id);
    expect((await f.review()).deletion?.state).toBe("deleted"); expect(f.call).toHaveBeenCalledTimes(1);
    expect((await f.app.manager.get(f.companyId, local.id)).dataDeletion?.state).toBe("deleted");
  });
  it("recovers the same multi-sandbox job after SIGKILL with the first provider checkpoint committed", async () => {
    const f = await fixture(); await f.addSandbox(); const { plan } = await f.accept();
    const script = path.join(f.root, "controller.mjs"), marker = path.join(f.root, "second-provider-started");
    const modulePath = path.resolve("server/src/services/runtime-services/application.ts"), dbPath = path.resolve("packages/db/src/index.ts");
    await fs.writeFile(script, `import fs from 'node:fs/promises';\nimport { createDb } from ${JSON.stringify(dbPath)};\nimport { createRuntimeServiceDependencies } from ${JSON.stringify(modulePath)};\nconst db = createDb(${JSON.stringify(database.connectionString)});\nlet count = 0;\nconst worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: ['environmentDeleteTaskWorkspaceData'] }), async call(_id, method, input) { if (method !== 'environmentDeleteTaskWorkspaceData') throw new Error('Unexpected operation'); if (++count === 2) { await fs.writeFile(${JSON.stringify(marker)}, 'ready'); await new Promise(() => {}); } return { state: 'destroyed', providerLeaseId: input.providerLeaseId, executionWorkspaceId: input.ownership.executionWorkspaceId, deletionId: input.deletionId }; } };\nawait createRuntimeServiceDependencies(db, { pluginWorkerManager: worker }).manager.reconcileDataDeletion(${JSON.stringify(f.companyId)}, ${JSON.stringify(plan.deletion!.id)});`);
    const child = spawn(process.execPath, ["--import", path.resolve("cli/node_modules/tsx/dist/loader.mjs"), script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; });
    const exited = once(child, "exit");
    try {
      await expect.poll(async () => { if (child.exitCode !== null) throw new Error(output); return fs.access(marker).then(() => true, () => false); }, { timeout: 30_000 }).toBe(true);
      const current = await f.review(); expect(current.deletion).toMatchObject({ state: "deleting", attempts: 1 });
      expect(current.remoteSandboxes?.map((sandbox) => sandbox.deleted)).toEqual([true, false]);
      expect(await fs.readFile(path.join(f.cwd, "dirty.txt"), "utf8")).toBe("retained source");
    } finally { child.kill("SIGKILL"); await exited; }
    await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion).toMatchObject({ state: "deleting", attempts: 1 });
    expect(f.call).not.toHaveBeenCalled();
    // Model the bounded claim expiry before another controller can resume the
    // remaining provider operation; the first committed receipt stays intact.
    await db.update(runtimeServiceDataDeletions).set({ retryAt: new Date(Date.now() - 1) }).where(eq(runtimeServiceDataDeletions.id, plan.deletion!.id));
    await f.make().manager.reconcileDataDeletion(f.companyId, plan.deletion!.id);
    expect((await f.review()).deletion).toMatchObject({ state: "deleted", attempts: 2 });
    expect(f.call).toHaveBeenCalledTimes(1); expect(f.call.mock.calls[0]![2].providerLeaseId).toBe(plan.remoteSandboxes![1]!.id);
    const [job] = await db.select().from(runtimeServiceDataDeletions).where(eq(runtimeServiceDataDeletions.id, plan.deletion!.id));
    expect(job!.providerDeletedAt).not.toBeNull();
    const allocations = await db.select().from(runtimeServiceAllocations).where(sql`${runtimeServiceAllocations.dataDeletionId} = ${job!.id}`);
    expect(allocations.every((allocation) => allocation.metadata.retentionReleased === true)).toBe(true);
  }, 45_000);
});
