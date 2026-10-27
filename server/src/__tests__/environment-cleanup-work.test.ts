import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxOrphanCleanupSpool } from "../services/sandbox-orphan-cleanup-spool.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, environmentLeases, environments, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerEnvironmentCleanupWork } from "../services/environment-cleanup-work.js";
import { registerDeferredEnvironmentCleanup } from "../services/environment-cleanup-notifications.js";
import { environmentService } from "../services/environments.js";
import { historicalCleanupVerificationService } from "../services/historical-cleanup-verification.js";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("environment cleanup scheduling", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  let companyId: string, environmentId: string, draining: boolean, failing: boolean;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<typeof registerEnvironmentCleanupWork> | undefined;
  let releases: ReturnType<typeof vi.fn>, inspections: ReturnType<typeof vi.fn>, reads: ReturnType<typeof vi.spyOn>;
  const errors: unknown[] = [], disposers: Array<() => void> = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("environment-cleanup-work-");
    db = createDb(database.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
  }, 90_000);
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE companies, environments CASCADE`);
    companyId = randomUUID(); environmentId = randomUUID(); draining = false; failing = false; errors.length = 0;
    await db.insert(companies).values({ id: companyId, name: "Cleanup worker", issuePrefix: "CLN" });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    releases = vi.fn(async () => { if (failing) throw new Error("provider unavailable"); return undefined; });
    inspections = vi.fn(async (row: { providerLeaseId: string | null }) => ({ providerLeaseId: row.providerLeaseId, state: "destroyed" }));
    reads = vi.spyOn(db, "select");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    worker?.stop(); await coordinator?.stop(); coordinator = undefined; worker = undefined;
    for (const stop of disposers.splice(0)) stop();
    vi.useRealTimers(); vi.restoreAllMocks();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  async function start(historical = false, sweepOverride?: (backoffMs: number) => Promise<unknown>) {
    const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox", retryPendingSandboxTeardown: releases } as any] });
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true,
      onError: error => errors.push(error) });
    const history = historical && historicalCleanupVerificationService(db, { inspectLease: inspections, inspectSetup: inspections });
    let historySettled = !history;
    worker = registerEnvironmentCleanupWork(db, coordinator, {
      sweepPending: sweepOverride ?? (backoffMs => heartbeat.sweepPendingCleanupLeases({ backoffMs })),
      historical: history ? { hasPending: history.hasPending,
        sweep: async () => { const result = await history.sweep(); historySettled = true; return result; } } : undefined,
      canRun: () => !draining,
    });
    await worker.ready;
    await vi.waitFor(() => expect(historySettled).toBe(true));
  }
  async function settle(ms = 30_000, wait = true) {
    await vi.advanceTimersByTimeAsync(ms);
    if (wait && !draining) {
      await vi.waitFor(() => expect(idleWorkSnapshot().active === 0 || coordinator!.nextWakeAt() !== null).toBe(true), { timeout: 5000 });
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(idleWorkSnapshot().active === 0 || coordinator!.nextWakeAt() !== null).toBe(true), { timeout: 5000 });
    }
  }
  const pending = (executor: Db = db) => environmentService(executor).insertPendingCleanupLease({ companyId, environmentId,
    provider: "fixture", providerLeaseId: randomUUID(), metadata: { driver: "sandbox" }, failureReason: "fixture" });
  async function quiet() {
    for (let pass = 0; pass < 4; pass++) {
      await settle(30_000);
      if (coordinator!.nextWakeAt() === null) break;
    }
    expect(coordinator!.nextWakeAt()).toBeNull();
    const count = reads.mock.calls.length, providerCalls = releases.mock.calls.length + inspections.mock.calls.length;
    await settle(20 * 60_000);
    expect(reads).toHaveBeenCalledTimes(count);
    expect(releases.mock.calls.length + inspections.mock.calls.length).toBe(providerCalls);
  }
  it("stays quiet with an idle environment and verified history, and rechecks changed proof", async () => {
    const lease = await pending();
    await environmentService(db).releaseLease(lease.id, "failed", { cleanupStatus: "success" });
    await start(true); expect(inspections).toHaveBeenCalledTimes(1);
    await quiet();
    await environmentService(db).updateLeaseMetadata(lease.id, { driver: "sandbox", changed: true });
    await settle(); expect(inspections).toHaveBeenCalledTimes(2);
    await environmentService(db).updateLeaseMetadata(lease.id, { changed: "again" });
    await settle(90_000); expect(inspections).toHaveBeenCalledTimes(2);
    await settle(180_000); expect(inspections).toHaveBeenCalledTimes(3);
    await quiet();
  });
  it("wakes on a real orphan insert, waits for its backoff, then disarms after deletion", async () => {
    await start(); await quiet();
    const lease = await pending(); await settle();
    expect(releases).not.toHaveBeenCalled();
    const count = reads.mock.calls.length;
    await settle(240_000); expect(reads).toHaveBeenCalledTimes(count);
    await settle(30_000); expect(releases).toHaveBeenCalledTimes(1);
    expect((await environmentService(db).getLeaseById(lease.id))?.status).toBe("expired");
    await quiet();
  });
  it("does not rescan pending cleanup from an otherwise idle run-reaper pass", async () => {
    const lease = await pending();
    await db.update(environmentLeases).set({ updatedAt: new Date(Date.now() - 600_000) }).where(eq(environmentLeases.id, lease.id));
    const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox", retryPendingSandboxTeardown: releases } as any] });
    await heartbeatService(db, { environmentRuntime: runtime }).reapOrphanedRuns({ staleThresholdMs: 300_000 });
    expect(releases).not.toHaveBeenCalled();
    await start(); expect(releases).toHaveBeenCalledTimes(1); await quiet();
  });
  it("retries a concrete failed teardown and reconstructs its cooldown after restart", async () => {
    const lease = await pending(); failing = true;
    await start(); expect(releases).toHaveBeenCalledTimes(1);
    const due = await nextEnvironmentCleanupAt(db); expect(due).toBeGreaterThan(Date.now());
    worker!.stop(); await coordinator!.stop();
    await start(); expect(releases).toHaveBeenCalledTimes(1);
    failing = false; await settle(300_000); expect(releases).toHaveBeenCalledTimes(2);
    expect((await environmentService(db).getLeaseById(lease.id))?.status).toBe("expired");
    await quiet();
  });
  it.each([false, true])("respects outer transaction settlement (rollback %s)", async rollback => {
    await start(); await quiet();
    let release!: () => void, written!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { written = resolve; });
    const writing = db.transaction(async tx => { await pending(tx as unknown as Db); written(); await gate; if (rollback) throw new Error("rollback"); })
      .catch(error => { if (!rollback) throw error; });
    await ready; await settle(30_000, false); expect(releases).not.toHaveBeenCalled();
    release(); await writing; await settle(300_000);
    expect(releases).toHaveBeenCalledTimes(rollback ? 0 : 1); await quiet();
  });
  it("preserves the first write during drain without passive SQL", async () => {
    await start(); await quiet(); draining = true;
    await pending(); const count = reads.mock.calls.length;
    await settle(600_000); expect(reads).toHaveBeenCalledTimes(count); expect(releases).not.toHaveBeenCalled();
    draining = false; await settle(); expect(releases).toHaveBeenCalledTimes(1); await quiet();
  });
  it("wakes for deferred work from another runtime and retries while no durable row exists", async () => {
    await start(); await quiet();
    let available = false, stop!: () => void;
    const flush = vi.fn(async () => {
      if (!available) return { recovered: 0, pending: 1 };
      await pending(); stop(); return { recovered: 1, pending: 0 };
    });
    stop = registerDeferredEnvironmentCleanup(db, flush); disposers.push(stop);
    await settle(); expect(flush).toHaveBeenCalledTimes(1);
    expect(await db.select().from(environmentLeases)).toEqual([]);
    const count = reads.mock.calls.length;
    await settle(240_000); expect(reads).toHaveBeenCalledTimes(count);
    available = true; await settle(60_000); expect(flush).toHaveBeenCalledTimes(2);
    await settle(300_000); expect(releases).toHaveBeenCalledTimes(1); await quiet();
  });
  it("retries a failed spool read without starving other buffers or persisted cleanup", async () => {
    const lease = await pending();
    const stop = registerDeferredEnvironmentCleanup(db, async () => { throw new Error("spool unavailable"); });
    disposers.push(stop);
    let stopHealthy!: () => void;
    let bufferedLeaseId: string | undefined;
    const healthy = vi.fn(async () => {
      bufferedLeaseId = (await pending()).id;
      stopHealthy();
      return { recovered: 1, pending: 0 };
    });
    stopHealthy = registerDeferredEnvironmentCleanup(db, healthy); disposers.push(stopHealthy);
    await start();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(releases).toHaveBeenCalledTimes(2);
    expect((await environmentService(db).getLeaseById(lease.id))?.status).toBe("expired");
    expect((await environmentService(db).getLeaseById(bufferedLeaseId!))?.status).toBe("expired");
    expect(errors).toHaveLength(1); errors.length = 0;
    draining = true; const count = reads.mock.calls.length;
    await settle(90_000); expect(reads).toHaveBeenCalledTimes(count);
    stop(); draining = false; await quiet();
  });
  it("retains startup recovery for an unread real spool with no buffered or durable row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cleanup-unread-spool-"));
    try {
      await writeFile(join(dir, "unread.json"), "{ truncated");
      const runtime = environmentRuntimeService(db, { orphanCleanupSpool: createSandboxOrphanCleanupSpool(dir) });
      const heartbeat = heartbeatService(db, { environmentRuntime: runtime });
      await start(false, backoffMs => heartbeat.sweepPendingCleanupLeases({ backoffMs }));
      expect(errors).toHaveLength(1); errors.length = 0;
      expect(coordinator!.nextWakeAt()).not.toBeNull();
      expect(await db.select().from(environmentLeases)).toEqual([]);
      await rm(join(dir, "unread.json"));
      await quiet();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("does not delay startup for historical provider checks but joins them on shutdown", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sweep = vi.fn(() => gate);
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    worker = registerEnvironmentCleanupWork(db, coordinator, {
      sweepPending: async () => {}, historical: { sweep, hasPending: async () => false }, canRun: () => true,
    });
    let ready = false, stopped = false;
    void worker.ready.then(() => { ready = true; });
    try {
      await vi.waitFor(() => expect(ready).toBe(true));
      expect(sweep).toHaveBeenCalledOnce();
      const stopping = coordinator.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(1); expect(stopped).toBe(false);
      release(); await stopping; expect(stopped).toBe(true);
    } finally { release(); }
  });
  it("coalesces a write during a slow sweep and waits for it on shutdown", async () => {
    await start(); await quiet(); worker!.stop(); await coordinator!.stop();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const starting = start(false, async () => { calls++; if (calls === 1) await gate; });
    await settle(1, false); await pending();
    let stopped = false; const stopping = coordinator!.stop().then(() => { stopped = true; });
    await settle(30_000, false); expect(stopped).toBe(false); expect(calls).toBe(1);
    release(); await starting; await stopping; expect(stopped).toBe(true);
  });
  it("rotates historical pages until all confirmed records are passive", async () => {
    for (let i = 0; i < 33; i++) {
      const lease = await pending(); await environmentService(db).releaseLease(lease.id, "failed", { cleanupStatus: "success" });
    }
    await start(true); await settle(300_000); await settle(300_000); expect(inspections).toHaveBeenCalledTimes(33); await quiet();
  });
  it("keeps unknown historical resources scheduled until provider confirmation", async () => {
    const lease = await pending(); await environmentService(db).releaseLease(lease.id, "failed", { cleanupStatus: "success" });
    inspections.mockResolvedValueOnce({ providerLeaseId: lease.providerLeaseId, state: "unknown" });
    await start(true); expect(coordinator!.nextWakeAt()).not.toBeNull();
    await settle(300_000); expect(inspections).toHaveBeenCalledTimes(2); await quiet();
  });
});
