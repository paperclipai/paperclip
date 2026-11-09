import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { adapterAuthSessions, applyPendingMigrations, companies, createDb, environmentLeases, environments, type Db } from "@paperclipai/db";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { registerLoginCleanupWork } from "../services/login-cleanup-work.js";
import { loginCleanupSchedule, orphanLoginLeases } from "../services/login-cleanup-state.js";
import { createDbAdapterAuthSessionStore, LOGIN_LEASE_SESSION_TAG_KEY } from "../services/device-login-service.js";
import { createDeviceLoginReaper, createProductionLoginSessionReaperRuntime } from "../services/device-login-reaper.js";
import { createDbSetupTokenCleanupStore, transitionSetupTokenSessionToStored } from "../services/setup-token-session.js";
import { createSetupTokenReaper } from "../services/setup-token-reaper.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => { for (const c of coordinators.splice(0)) await c.stop(); vi.useRealTimers(); });
function coordinator(owner: object, canRun = () => true, onError: (error: unknown) => void = vi.fn()) {
  const c = createDeliveryWorkCoordinator({ owner, canRun, canReconcile: () => true, onError });
  coordinators.push(c); return c;
}
function fakeOwner() {
  const execute = vi.fn(async () => [{ xid: "42" }]);
  const owner = installDatabaseWorkSignals({ execute, async transaction(fn: (tx: any) => Promise<any>): Promise<any> {
    return fn({ execute, transaction: owner.transaction });
  } });
  return owner;
}

describe("login cleanup lifecycle", () => {
  it.each(["startup", "commit", "failure"])("retains %s reconciliation across drain without passive SQL", async kind => {
    vi.useFakeTimers(); const owner = fakeOwner(); let draining = kind === "startup";
    const c = coordinator(owner, () => !draining);
    const run = vi.fn(async () => {}), next = vi.fn(async () => null);
    await registerLoginCleanupWork(c, [{ queue: DELIVERY_QUEUES.adapterLoginCleanup, run, next }], () => true).ready;
    if (kind !== "startup") {
      if (kind === "failure") run.mockRejectedValueOnce(new Error("provider unavailable"));
      else draining = true;
      await owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.adapterLoginCleanup));
      await vi.advanceTimersByTimeAsync(30_000); draining = true;
    }
    const reads = next.mock.calls.length, runs = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(next).toHaveBeenCalledTimes(reads); expect(run).toHaveBeenCalledTimes(runs);
    draining = false; await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(runs + 1); expect(c.nextWakeAt()).toBeNull();
  });
  it("coalesces writes and retains a write during a slow sweep without overlapping", async () => {
    vi.useFakeTimers(); const owner = fakeOwner(); const c = coordinator(owner);
    const run = vi.fn(async () => {});
    await registerLoginCleanupWork(c, [{ queue: DELIVERY_QUEUES.adapterLoginCleanup, run, next: async () => null }], () => true).ready;
    for (let i = 0; i < 20; i++) {
      await owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.adapterLoginCleanup));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(run).toHaveBeenCalledTimes(1);
    let release!: () => void;
    run.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(28_000);
    await owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.adapterLoginCleanup));
    await vi.advanceTimersByTimeAsync(30_000); expect(run).toHaveBeenCalledTimes(2);
    release(); await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(3); expect(c.nextWakeAt()).toBeNull();
  });
  it("does not block another cleanup worker and awaits in-flight work on shutdown", async () => {
    vi.useFakeTimers(); const c = coordinator(fakeOwner()); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const setup = vi.fn(async () => {});
    const workers = registerLoginCleanupWork(c, [
      { queue: DELIVERY_QUEUES.adapterLoginCleanup, run: () => gate, next: async () => null },
      { queue: DELIVERY_QUEUES.setupTokenCleanup, run: setup, next: async () => null },
    ], () => true);
    await vi.advanceTimersByTimeAsync(1); expect(setup).toHaveBeenCalledTimes(1);
    let stopped = false; const stopping = c.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1); expect(stopped).toBe(false);
    release(); await workers.ready; await stopping; expect(stopped).toBe(true);
  });
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_LOGIN_CLEANUP_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("durable login cleanup", () => {
  let db: ReturnType<typeof createDb>, observed: typeof db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let companyId: string, environmentId: string, calls: number, failedDelete: boolean;
  let store: ReturnType<typeof createDbAdapterAuthSessionStore>;
  let runtime: ReturnType<typeof createProductionLoginSessionReaperRuntime>;
  let driver: { releaseRunLease: ReturnType<typeof vi.fn> };
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("login-cleanup-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
  }, 90000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies, environments CASCADE`);
    companyId = randomUUID(); environmentId = randomUUID(); calls = 0; failedDelete = false; errors.length = 0;
    await db.insert(companies).values({ id: companyId, name: "Login cleanup", issuePrefix: "LOG" });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    observed = new Proxy(db, { get(target, key) {
      if (!["select", "update", "insert", "delete", "execute", "transaction"].includes(String(key))) return Reflect.get(target, key);
      return (...args: unknown[]) => { calls++; return Reflect.apply(Reflect.get(target, key), target, args); };
    } });
    store = createDbAdapterAuthSessionStore(observed);
    driver = { releaseRunLease: vi.fn(async ({ lease }) => {
      if (failedDelete) return { cleanupStatus: "failed" };
      await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success" }).where(eq(environmentLeases.id, lease.id));
      return { cleanupStatus: "success" };
    }) };
    runtime = createProductionLoginSessionReaperRuntime({ db: observed, environmentRuntime: { getDriver: () => driver } as any });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  async function settle(ms = 30_000) {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0), { timeout: 5000 });
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0), { timeout: 5000 });
    expect(errors).toEqual([]);
  }
  async function quiet(c: ReturnType<typeof coordinator>) {
    await settle(60_000); expect(c.nextWakeAt()).toBeNull();
    const before = calls, deletes = driver.releaseRunLease.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(calls).toBe(before); expect(driver.releaseRunLease).toHaveBeenCalledTimes(deletes);
  }
  async function adapterWorker() {
    const c = coordinator(db, undefined, error => errors.push(error));
    const reaper = createDeviceLoginReaper({ store, runtime });
    await registerLoginCleanupWork(c, [{ queue: DELIVERY_QUEUES.adapterLoginCleanup, run: reaper.sweep, next: loginCleanupSchedule(observed).adapter }], () => true).ready;
    return c;
  }
  async function session(at = new Date(Date.now() + 120_000), target = store) {
    const id = randomUUID();
    await target.insert({ id, publicSessionId: id, companyId, environmentId, adapterType: "codex_local", startedByUserId: id, expiresAt: at, at: new Date() });
    return id;
  }
  async function lease(sessionId: string) {
    const id = randomUUID();
    await db.insert(environmentLeases).values({ id, companyId, environmentId, providerLeaseId: id, metadata: { [LOGIN_LEASE_SESSION_TAG_KEY]: sessionId } });
    return id;
  }
  it("is quiet with configured environments and completed history, excluding local login attempts", async () => {
    const id = await session(); await store.setStatus({ sessionId: id, status: "authenticated", at: new Date() });
    await db.insert(adapterAuthSessions).values({ companyId, environmentId, adapterType: "claude_local", startedByUserId: "local", publicSessionId: randomUUID(), connectionMethod: "local_subscription", status: "authenticated", expiresAt: new Date(Date.now() - 1) });
    const c = await adapterWorker();
    const setup = createSetupTokenReaper({ store: createDbSetupTokenCleanupStore(observed), leases: { releaseById: vi.fn() } });
    await registerLoginCleanupWork(c, [{ queue: DELIVERY_QUEUES.setupTokenCleanup, run: setup.sweep, next: loginCleanupSchedule(observed).setupToken }], () => true).ready;
    await quiet(c);
  });
  it("wakes from a real producer, waits for expiry without polling, and settles back to quiet", async () => {
    const c = await adapterWorker(); await quiet(c);
    const due = new Date(Date.now() + 120_000); const id = await session(due);
    await settle(); expect(c.nextWakeAt()).toBe(due.getTime());
    const before = calls; await vi.advanceTimersByTimeAsync(30_000); expect(calls).toBe(before);
    await settle(91_000); expect((await store.get(id))?.status).toBe("timed_out"); await quiet(c);
  });
  it("respects promotion expiry and disarms cancellation", async () => {
    const c = await adapterWorker(); const id = await session(new Date(Date.now() + 60_000));
    const promotion = new Date(Date.now() + 180_000);
    await store.setStatus({ sessionId: id, status: "promoting", promotionExpiresAt: promotion, at: new Date() });
    await settle(); expect(c.nextWakeAt()).toBe(promotion.getTime());
    await store.setStatus({ sessionId: id, status: "cancelled", at: new Date() }); await quiet(c);
  });
  it("retries failed deletion only while pending and reconstructs it after restart", async () => {
    const id = await session(new Date(Date.now() - 1)); const leaseId = await lease(id);
    await store.recordLeaseAcquired({ sessionId: id, providerLeaseId: leaseId, at: new Date() });
    failedDelete = true; const first = await adapterWorker();
    expect((await store.get(id))?.status).toBe("cleanup_pending"); expect(driver.releaseRunLease).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); expect(driver.releaseRunLease).toHaveBeenCalledTimes(1);
    await first.stop(); failedDelete = false; const second = await adapterWorker();
    expect((await store.get(id))?.status).toBe("timed_out"); expect(driver.releaseRunLease).toHaveBeenCalledTimes(2); await quiet(second);
  });
  it("protects an in-flight lease attachment, then recovers an unbound lease after acquisition fails", async () => {
    const id = await session(); const leaseId = await lease(id); const c = await adapterWorker();
    expect(driver.releaseRunLease).not.toHaveBeenCalled(); expect(await orphanLoginLeases(observed)).toEqual([]);
    await store.setStatus({ sessionId: id, status: "failed", at: new Date() }); await quiet(c);
    expect(driver.releaseRunLease).toHaveBeenCalledTimes(1);
    expect(driver.releaseRunLease.mock.calls[0]![0].lease.id).toBe(leaseId);
  });
  it("recovers orphan leases without a live session and retains failed orphan cleanup", async () => {
    await lease(randomUUID()); failedDelete = true; const c = await adapterWorker();
    expect(driver.releaseRunLease).toHaveBeenCalledTimes(1); expect(c.nextWakeAt()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000); expect(driver.releaseRunLease).toHaveBeenCalledTimes(1);
    failedDelete = false; await quiet(c); expect(driver.releaseRunLease).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])("keeps nested producer intent until outer settlement (rollback=%s)", async rollback => {
    const c = await adapterWorker(); await quiet(c);
    let release!: () => void, written!: () => void, id!: string;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { written = resolve; });
    const transaction = db.transaction(async tx => {
      id = await session(new Date(Date.now() + 120_000), createDbAdapterAuthSessionStore(tx as unknown as Db));
      written(); await gate; if (rollback) throw new Error("rollback");
    }).catch(error => { if (!rollback) throw error; });
    await ready; await vi.advanceTimersByTimeAsync(30_000);
    expect(await store.get(id)).toBeNull(); expect(idleWorkSnapshot().active).toBeGreaterThan(0);
    release(); await transaction; await settle();
    if (rollback) await quiet(c);
    else { expect((await store.get(id))?.status).toBe("starting"); await settle(120_000); await quiet(c); }
  });
  it.each(["consume", "expire", "cancel"])("setup-token producers wake cleanup on %s", async mode => {
    const cleanup = createDbSetupTokenCleanupStore(observed), releaseById = vi.fn(async () => {});
    const c = coordinator(db, undefined, error => errors.push(error));
    const reaper = createSetupTokenReaper({ store: cleanup, leases: { releaseById } });
    await registerLoginCleanupWork(c, [{ queue: DELIVERY_QUEUES.setupTokenCleanup, run: reaper.sweep, next: loginCleanupSchedule(observed).setupToken }], () => true).ready;
    await quiet(c);
    const identity = { sessionId: randomUUID(), companyId, ownerUserId: "setup", adapterType: "claude_local" };
    const deadline = Date.now() + 120_000;
    await cleanup.record({ ...identity, environmentId, leaseId: randomUUID(), state: "starting", deadline, boundAt: null });
    await settle(); expect(c.nextWakeAt()).toBe(deadline);
    if (mode === "consume") {
      expect(await transitionSetupTokenSessionToStored(observed, identity)).toBe(true);
      await cleanup.consumeStoredClaim(identity);
    } else if (mode === "cancel") {
      expect(await cleanup.cancelDurable(identity, ["starting"])).not.toBeNull();
    } else {
      await settle(120_000);
    }
    await quiet(c);
    expect(releaseById).toHaveBeenCalledTimes(1); expect(await cleanup.listReapable(Date.now())).toEqual([]);
  });
});
