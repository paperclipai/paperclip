import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, environmentLeases, environments, runtimeServiceAllocations, runtimeServiceDataDeletions,
  runtimeServiceEvents, runtimeServices, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { resolveRuntimeServicePolicy } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { createRuntimeServiceProvisioning } from "./provisioning.js";
import { createRuntimeServiceDataDeletionExecutor, createRuntimeServiceDataDeletionStore } from "./data-deletion.js";
import { assertRuntimeServiceLeaseDataAvailable } from "./retention.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
describe("provider lifecycle work releases database transactions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("service-provider-locks-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), allocationId = randomUUID(), pluginId = randomUUID(), providerLeaseId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Provider locks", issuePrefix: `L${companyId.slice(0, 6)}` });
    const [environment] = await db.insert(environments).values({ name: companyId, driver: "sandbox", config: { provider: "daytona", image: "node:24" } }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id, provider: "daytona", status: "retained" }).returning();
    const allocationRequest = { version: 1, environmentId: environment!.id, pluginId, pluginKey: "test.daytona", baseConfig: environment!.config, launchConfig: environment!.config, requestedCwd: "app" };
    await db.insert(runtimeServiceAllocations).values({ id: allocationId, companyId, provider: "daytona", reuseKey: allocationId, cwd: "app", environmentLeaseId: lease!.id, metadata: { allocationRequest } });
    const [service] = await db.insert(runtimeServices).values({ companyId, allocationId, name: "Worker", purpose: "worker", creationKey: randomUUID(),
      spec: { command: "node worker.cjs", cwd: "app", env: {}, endpoints: [] }, policy: resolveRuntimeServicePolicy("worker") }).returning();
    let gateMethod: string | undefined, gate = deferred(), entered = deferred(), failDeletion = false;
    const call = vi.fn(async (_plugin: string, method: string, input: Record<string, any>) => {
      if (method === gateMethod) { entered.resolve(); await gate.promise; }
      if (method === "environmentGetServiceConnection") return { fingerprint: "a".repeat(64) };
      if (method === "environmentAcquireServiceLease") return { providerLeaseId, metadata: { remoteCwd: "/workspace", workspaceSentinel: { path: "/workspace/.paperclip/workspace.json", token: "fixture", result: "written" } } };
      if (method === "environmentDeleteServiceData") {
        if (failDeletion) throw new Error("Provider temporarily unavailable");
        return { state: "destroyed", providerLeaseId, serviceAllocationId: input.serviceAllocationId, deletionId: input.deletionId };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["environmentGetServiceConnection", "environmentAcquireServiceLease", "environmentService", "environmentDeleteServiceData"] }), call } as unknown as PluginWorkerManager;
    const provisioning = createRuntimeServiceProvisioning(db, worker);
    let clock = new Date();
    const store = () => createRuntimeServiceDataDeletionStore(db, { now: () => clock, executor: createRuntimeServiceDataDeletionExecutor(db, worker) });
    const acceptDeletion = async () => {
      await provisioning.ensure(companyId, allocationId);
      await db.update(runtimeServices).set({ state: "stopped", desiredState: "stopped" }).where(eq(runtimeServices.id, service!.id));
      const plan = await store().review(companyId, service!.id); expect(plan.blockers).toEqual([]);
      return store().request(companyId, service!.id, { type: "board", id: "operator" }, { requestId: randomUUID(), planToken: plan.planToken, confirmedAllocationId: allocationId, confirm: true });
    };
    return { companyId, allocationId, service: service!, environment: environment!, lease: lease!, providerLeaseId, call, provisioning, store, acceptDeletion,
      block(method: string) { gateMethod = method; gate = deferred(); entered = deferred(); return { entered: entered.promise, release: () => { gateMethod = undefined; gate.resolve(); } }; },
      failDeletion(value: boolean) { failDeletion = value; }, advance() { clock = new Date(clock.getTime() + 5 * 60_000 + 1); } };
  }

  it("does not contact the provider for an unstarted allocation without a running consumer", async () => {
    const f = await fixture();
    await db.update(runtimeServices).set({ desiredState: "stopped" }).where(eq(runtimeServices.id, f.service.id));
    await createRuntimeServiceProvisioning(db, undefined).ensure(f.companyId, f.allocationId);
    expect(f.call).not.toHaveBeenCalled();
  });

  it.each(["environmentGetServiceConnection", "environmentAcquireServiceLease"])("does not hold row/environment locks during %s and permits Stop", async (method) => {
    const f = await fixture(), gate = f.block(method), pending = f.provisioning.ensure(f.companyId, f.allocationId);
    try {
      await gate.entered;
      await db.transaction(async (tx) => {
        await tx.execute(sql`select id from ${runtimeServiceAllocations} where id = ${f.allocationId} for update nowait`);
        const locked = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`runtime-service-environment:${f.environment.id}`})) as acquired`);
        expect(locked[0]?.acquired).toBe(true);
        await tx.update(runtimeServices).set({ desiredState: "stopped" }).where(eq(runtimeServices.id, f.service.id));
      });
    } finally { gate.release(); await pending; }
    const acquisitions = f.call.mock.calls.filter(([, action]) => action === "environmentAcquireServiceLease");
    expect(acquisitions).toHaveLength(method === "environmentGetServiceConnection" ? 0 : 1);
    const [service] = await db.select().from(runtimeServices).where(eq(runtimeServices.id, f.service.id)); expect(service!.desiredState).toBe("stopped");
  });

  it("stores one receipt/event when concurrent recovery gets the same named allocation", async () => {
    const f = await fixture(), gate = f.block("environmentAcquireServiceLease");
    const first = f.provisioning.ensure(f.companyId, f.allocationId); await gate.entered;
    const second = f.provisioning.ensure(f.companyId, f.allocationId);
    try { await vi.waitFor(() => expect(f.call.mock.calls.filter(([, method]) => method === "environmentAcquireServiceLease")).toHaveLength(2)); }
    finally { gate.release(); await Promise.all([first, second]); }
    const events = await db.select().from(runtimeServiceEvents).where(and(eq(runtimeServiceEvents.companyId, f.companyId), eq(runtimeServiceEvents.kind, "allocation_ready")));
    expect(events).toHaveLength(1);
    const calls = f.call.mock.calls.filter(([, method]) => method === "environmentAcquireServiceLease"); expect(calls[0]![2]).toEqual(calls[1]![2]);
  });

  it("rechecks deletion after waiting for an acquisition intent transaction to commit", async () => {
    const f = await fixture(), prepared = deferred(), commit = deferred();
    let hold = true;
    // Run the real provisioning transaction, pausing only its commit so a
    // stopped service's deletion review can still see the previous snapshot.
    const heldDb = new Proxy(db, { get(target, key) {
      if (key === "transaction") return (work: Parameters<typeof db.transaction>[0]) => db.transaction(async (tx) => {
        const result = await work(tx);
        if (hold) { hold = false; prepared.resolve(); await commit.promise; }
        return result;
      });
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const pending = createRuntimeServiceProvisioning(heldDb, {
      isRunning: () => true,
      getWorker: () => ({ supportedMethods: ["environmentGetServiceConnection", "environmentAcquireServiceLease", "environmentService"] }),
      call: f.call,
    } as unknown as PluginWorkerManager).ensure(f.companyId, f.allocationId).then(() => null, (error: unknown) => error);
    let deleting: Promise<unknown> | undefined;
    try {
      await prepared.promise;
      await db.update(runtimeServices).set({ state: "stopped", desiredState: "stopped" }).where(eq(runtimeServices.id, f.service.id));
      const plan = await f.store().review(f.companyId, f.service.id);
      expect(plan.blockers).toEqual([]);
      deleting = f.store().request(f.companyId, f.service.id, { type: "board", id: "operator" }, {
        requestId: randomUUID(), planToken: plan.planToken, confirmedAllocationId: f.allocationId, confirm: true,
      }).then(() => null, (error: unknown) => error);
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select pid from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and (query like '%runtime_service_allocations%' or query like '%runtime_service_data_deletions%')
          and pid <> pg_backend_pid()`);
        expect(waiting.length).toBeGreaterThan(0);
      });
    } finally { commit.resolve(); }
    expect(await deleting).toMatchObject({ status: 409 });
    expect(await pending).toBeNull();
    const [allocation] = await db.select().from(runtimeServiceAllocations).where(eq(runtimeServiceAllocations.id, f.allocationId));
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(allocation!.dataDeletionId).toBeNull();
    expect(allocation!.metadata.provisionedAt).toEqual(expect.any(String));
    expect(lease!.providerLeaseId).toBe(f.providerLeaseId);
  });

  it("keeps a durable deletion fence without retaining allocation locks or duplicating live work", async () => {
    const f = await fixture(), plan = await f.acceptDeletion(), gate = f.block("environmentDeleteServiceData");
    const pending = f.store().reconcile(f.companyId, plan.deletion!.id);
    try {
      await gate.entered;
      await db.transaction(async (tx) => {
        const locked = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`runtime-service-allocation:${f.companyId}:daytona:${f.providerLeaseId}`})) as acquired`);
        expect(locked[0]?.acquired).toBe(true);
      });
      await expect(assertRuntimeServiceLeaseDataAvailable(db, { ...f.lease, providerLeaseId: f.providerLeaseId })).rejects.toMatchObject({ status: 409 });
      await f.store().reconcile(f.companyId, plan.deletion!.id);
      expect(f.call.mock.calls.filter(([, method]) => method === "environmentDeleteServiceData")).toHaveLength(1);
    } finally { gate.release(); await pending; }
    expect((await f.store().review(f.companyId, f.service.id)).deletion).toMatchObject({ state: "deleted", attempts: 1 });
  });

  it("fences late completion after an abandoned deletion claim is recovered", async () => {
    const f = await fixture(), plan = await f.acceptDeletion(), gate = f.block("environmentDeleteServiceData");
    const pending = f.store().reconcile(f.companyId, plan.deletion!.id); await gate.entered;
    // Reclaim by another process after the persisted deadline, while the old RPC
    // still has no result. Its eventual response cannot finish this newer job.
    f.advance(); f.failDeletion(true);
    // Let only the next call fail; the older call remains independently blocked.
    f.call.mockImplementationOnce(async () => { throw new Error("New attempt could not reach provider"); });
    await f.store().reconcile(f.companyId, plan.deletion!.id);
    f.failDeletion(false); gate.release(); await pending;
    const [job] = await db.select().from(runtimeServiceDataDeletions).where(eq(runtimeServiceDataDeletions.id, plan.deletion!.id));
    expect(job).toMatchObject({ state: "failed", attempts: 2, providerDeletedAt: null });
    f.advance(); await f.store().reconcile(f.companyId, plan.deletion!.id);
    expect((await f.store().review(f.companyId, f.service.id)).deletion).toMatchObject({ state: "deleted", attempts: 3 });
  });
});
