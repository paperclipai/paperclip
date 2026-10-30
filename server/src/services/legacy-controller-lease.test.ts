import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, closeLivenessDb, companies, createDb, heartbeatRuns, livenessDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";
import { hasLiveLegacyController, LEGACY_CONTROLLER_LEASE_MS, LEGACY_CONTROLLER_RENEW_MS,
  LEGACY_CONTROLLER_RENEWAL_RETRY_DELAY_MS, legacyControllerBootId, legacyControllerClaim, LegacyControllerLeaseLostError,
  renewLegacyControllerLease, revokeExpiredLegacyController, revokeExpiredLegacyControllerWithState,
  watchLegacyControllerLease } from "./legacy-controller-lease.js";

type WatchArgs = Parameters<typeof watchLegacyControllerLease>;
// A renewal test double: each attempt runs in a transaction on the liveness pool.
function fakeRenewalDb(returning: () => Promise<unknown>) {
  const fake = { update: () => ({ set: () => ({ where: () => ({ returning }) }) }),
    execute: async () => [], transaction: (action: (tx: unknown) => Promise<unknown>) => action(fake) };
  return fake as unknown as WatchArgs[0];
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable legacy controller ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("legacy-controller-");
    db = createDb(database.connectionString);
  }, 30000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Controller test", issuePrefix: `C${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "general", adapterType: "claude_local", status: "idle" });
    const [queued] = await db.insert(heartbeatRuns).values({ companyId, agentId }).returning();
    const [run] = await db.update(heartbeatRuns).set({ status: "running", ...legacyControllerClaim("legacy") })
      .where(eq(heartbeatRuns.id, queued.id)).returning();
    return run;
  }
  async function expire(id: string) {
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(heartbeatRuns.id, id));
  }
  it("commits ownership with the queued claim before provisioning or logs exist", async () => {
    const run = await seed();
    expect(run).toMatchObject({ status: "running", controllerBootId: legacyControllerBootId, executionStage: "preparing", processPid: null });
    expect(await hasLiveLegacyController(db, run)).toBe(true);
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("another deployment's startup reaper preserves an unexpired controller", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, run.id));
    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 0 });
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.status).toBe("running");
    expect(saved.errorCode).toBeNull();
  });
  it.each([false, true])("shutdown preserves a foreign controller (expired: %s)", async expired => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, run.id));
    if (expired) await expire(run.id);
    const result = await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date(), [run.id]);
    expect(result.interruptedRunIds).toEqual([]);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.status).toBe("running");
  });
  it("a current controller renews and records the dispatch boundary", async () => {
    const run = await seed();
    expect(await renewLegacyControllerLease(db, run, "dispatching")).toBe(true);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved.executionStage).toBe("dispatching");
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("an expired controller cannot renew or dispatch even before a reaper claims it", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await renewLegacyControllerLease(db, run, "dispatching")).toBe(false);
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller);
    try {
      await expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason).toBeInstanceOf(LegacyControllerLeaseLostError);
      expect(controller.signal.reason.leaseLossCause).toBe("renewal_rejected");
    } finally { watch.stop(); }
  });
  it("only one competing recovery revokes the observed expired owner", async () => {
    const run = await seed();
    await expire(run.id);
    const attempts = await Promise.all([revokeExpiredLegacyController(db, run), revokeExpiredLegacyController(db, run)]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await renewLegacyControllerLease(db, run)).toBe(false);
  });
  it("revocation reports the committed dispatch boundary instead of the caller's stale snapshot", async () => {
    const stale = await seed();
    expect(await renewLegacyControllerLease(db, stale, "dispatching")).toBe(true);
    await expire(stale.id);
    expect(stale.executionStage).toBe("preparing");
    expect(await revokeExpiredLegacyControllerWithState(db, stale)).toEqual({
      executionStage: "dispatching", processPid: null, processGroupId: null,
    });
    expect(await revokeExpiredLegacyControllerWithState(db, stale)).toBeNull();
  });
  it("a crash after revocation permits a later recovery claim", async () => {
    const run = await seed();
    await expire(run.id);
    expect(await revokeExpiredLegacyController(db, run)).toBe(true);
    const [claimed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await hasLiveLegacyController(db, claimed)).toBe(true);
    expect(await revokeExpiredLegacyController(db, claimed)).toBe(false);
    await expire(run.id);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(await revokeExpiredLegacyController(db, saved)).toBe(true);
  });
  it("rejects foreign company renewal and revocation", async () => {
    const run = await seed();
    expect(await renewLegacyControllerLease(db, { ...run, companyId: randomUUID() })).toBe(false);
    await expire(run.id);
    expect(await revokeExpiredLegacyController(db, { ...run, companyId: randomUUID() })).toBe(false);
  });
  it("never turns a terminal run back into owned execution", async () => {
    const run = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    expect(await renewLegacyControllerLease(db, run)).toBe(false);
    expect(await revokeExpiredLegacyController(db, run)).toBe(false);
  });
  it("rejects dispatch at the lease deadline even if the database query never settles", async () => {
    const run = await seed();
    const hungDb = fakeRenewalDb(() => new Promise(() => {}));
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(hungDb, { ...run, controllerLeaseExpiresAt: new Date(Date.now() + 100) }, controller);
    try {
      const checked = expect(watch.assertOwned("dispatching")).rejects.toThrow("lease lost");
      await vi.advanceTimersByTimeAsync(101);
      await checked;
      expect(controller.signal.aborted).toBe(true);
      expect(controller.signal.reason.leaseLossCause).toBe("renewal_deadline");
    } finally { watch.stop(); vi.useRealTimers(); }
  });

  it("renews without queueing behind a slow statement on a saturated shared pool", async () => {
    const run = await seed();
    // postgres.js pipelines onto a busy connection when none is idle.
    const shared = createDb(database.connectionString, { maxConnections: 1 });
    const slow = shared.execute(sql`select pg_sleep(5)`).then(() => undefined); // drizzle sends on then()
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(shared, run, controller);
    try {
      const startedAt = Date.now();
      await watch.assertOwned("dispatching");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(controller.signal.aborted).toBe(false);
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(saved.executionStage).toBe("dispatching");
    } finally { watch.stop(); await slow; }
  }, 15_000);

  it("renews on one private pool per client that shutdown can end", async () => {
    const run = await seed();
    const owner = createDb(database.connectionString);
    const pool = livenessDb(owner);
    expect(pool).not.toBe(owner);
    expect(livenessDb(owner)).toBe(pool);
    const watch = watchLegacyControllerLease(owner, run, new AbortController());
    try {
      await watch.assertOwned();
      const [{ name }] = await pool.execute<{ name: string }>(sql`select current_setting('application_name') as name`);
      expect(name).toBe("paperclip-controller-lease");
    } finally { watch.stop(); }
    await closeLivenessDb(owner, 1);
    await expect(livenessDb(owner).execute(sql`select 1`)).rejects.toThrow();
  });

  it("retries a renewal that times out waiting on the run row instead of losing the lease", async () => {
    const run = await seed();
    let lockTaken!: () => void, releaseLock!: () => void;
    const taken = new Promise<void>((resolve) => { lockTaken = resolve; });
    const released = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
      lockTaken();
      await released;
    });
    await taken;
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller, { renewalStatementTimeoutMs: 200 });
    try {
      const renewal = watch.assertOwned();
      setTimeout(releaseLock, 1_000);
      await expect(renewal).resolves.toBeUndefined();
      expect(controller.signal.aborted).toBe(false);
    } finally { releaseLock(); watch.stop(); await holder; }
  }, 15_000);

  it("retries a renewal whose connection was terminated instead of losing the lease", async () => {
    const run = await seed();
    let lockTaken!: () => void, releaseLock!: () => void;
    const taken = new Promise<void>((resolve) => { lockTaken = resolve; });
    const released = new Promise<void>((resolve) => { releaseLock = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
      lockTaken();
      await released;
    });
    await taken;
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(db, run, controller);
    try {
      const renewal = watch.assertOwned();
      // Drop the renewal's own connection while it waits on the run row.
      let blocked: { pid: number } | undefined;
      for (let attempt = 0; !blocked && attempt < 100; attempt++) {
        [blocked] = await db.execute<{ pid: number }>(sql`select pid from pg_stat_activity
          where application_name = 'paperclip-controller-lease' and wait_event_type = 'Lock'`);
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBeDefined();
      await db.execute(sql`select pg_terminate_backend(${blocked!.pid})`);
      setTimeout(releaseLock, LEGACY_CONTROLLER_RENEWAL_RETRY_DELAY_MS + 500);
      await expect(renewal).resolves.toBeUndefined();
      expect(controller.signal.aborted).toBe(false);
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(saved.controllerBootId).toBe(legacyControllerBootId);
    } finally { releaseLock(); watch.stop(); await holder; }
  }, 15_000);

  it("leaves native controller ownership to the native coordinator", () => {
    expect(legacyControllerClaim("native")).toEqual({});
  });
});

describe("legacy controller lease loss attribution", () => {
  it("attributes a renewal that keeps failing until the deadline to renewal_error", async () => {
    let calls = 0;
    const failingDb = fakeRenewalDb(() => { calls += 1; return Promise.reject(new Error("connection reset")); });
    vi.useFakeTimers();
    const controller = new AbortController();
    const run = { id: randomUUID(), companyId: randomUUID(), runtimeMode: "legacy", controllerBootId: legacyControllerBootId,
      controllerLeaseExpiresAt: new Date(Date.now() + LEGACY_CONTROLLER_LEASE_MS) } as WatchArgs[1];
    const watch = watchLegacyControllerLease(failingDb, run, controller);
    try {
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_RENEW_MS + 1);
      expect(controller.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_LEASE_MS - LEGACY_CONTROLLER_RENEW_MS);
      expect(calls).toBeGreaterThan(1);
      expect(controller.signal.reason).toBeInstanceOf(LegacyControllerLeaseLostError);
      expect(controller.signal.reason.leaseLossCause).toBe("renewal_error");
      expect(controller.signal.reason.leaseLossTiming).toMatchObject({ sinceRenewalMs: LEGACY_CONTROLLER_LEASE_MS,
        renewalPendingMs: LEGACY_CONTROLLER_LEASE_MS - LEGACY_CONTROLLER_RENEW_MS, deadlineLateMs: 0, renewalCount: 0 });
    } finally { watch.stop(); vi.useRealTimers(); }
  });

  it("retries a renewal that fails once instead of losing the lease", async () => {
    let calls = 0;
    const flakyDb = fakeRenewalDb(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("write CONNECTION_CLOSED")) : Promise.resolve([{ id: "run" }]);
    });
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(flakyDb, watchedRun(LEGACY_CONTROLLER_LEASE_MS), controller);
    try {
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_RENEW_MS + LEGACY_CONTROLLER_RENEWAL_RETRY_DELAY_MS);
      expect(calls).toBe(2);
      expect(controller.signal.aborted).toBe(false);
      // Renewals keep succeeding well past the first lease deadline.
      await vi.advanceTimersByTimeAsync(2 * LEGACY_CONTROLLER_LEASE_MS);
      expect(controller.signal.aborted).toBe(false);
    } finally { watch.stop(); vi.useRealTimers(); }
  });

  it("attributes a stall after a recovered error to renewal_deadline", async () => {
    let calls = 0;
    const recoveringDb = fakeRenewalDb(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("connection reset"));
      return calls === 2 ? Promise.resolve([{ id: "run" }]) : new Promise(() => {});
    });
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(recoveringDb, watchedRun(LEGACY_CONTROLLER_LEASE_MS), controller);
    try {
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_RENEW_MS + LEGACY_CONTROLLER_RENEWAL_RETRY_DELAY_MS + LEGACY_CONTROLLER_LEASE_MS);
      expect(controller.signal.reason.leaseLossCause).toBe("renewal_deadline");
      expect(controller.signal.reason.leaseLossTiming).toMatchObject({ renewalCount: 1, deadlineLateMs: 0 });
    } finally { watch.stop(); vi.useRealTimers(); }
  });

  const watchedRun = (leaseMs: number) => ({ id: randomUUID(), companyId: randomUUID(), runtimeMode: "legacy",
    controllerBootId: legacyControllerBootId, controllerLeaseExpiresAt: new Date(Date.now() + leaseMs) }) as WatchArgs[1];

  it("records a renewal still in flight when a stalled query reaches the deadline", async () => {
    let calls = 0;
    const stallingDb = fakeRenewalDb(() => {
      calls += 1;
      return calls <= 2 ? Promise.resolve([{ id: "run" }]) : new Promise(() => {});
    });
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(stallingDb, watchedRun(LEGACY_CONTROLLER_LEASE_MS), controller);
    try {
      await vi.advanceTimersByTimeAsync(2 * LEGACY_CONTROLLER_RENEW_MS);
      expect(controller.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_LEASE_MS + 1);
      expect(controller.signal.reason.leaseLossCause).toBe("renewal_deadline");
      expect(controller.signal.reason.leaseLossTiming).toEqual({ sinceRenewalMs: LEGACY_CONTROLLER_LEASE_MS,
        renewalPendingMs: LEGACY_CONTROLLER_LEASE_MS - LEGACY_CONTROLLER_RENEW_MS, deadlineLateMs: 0, renewalCount: 2 });
    } finally { watch.stop(); vi.useRealTimers(); }
  });

  it("measures the next deadline from the retry that renewed the lease", async () => {
    const timeoutAfterMs = 45_000;
    let calls = 0;
    const retryingDb = fakeRenewalDb(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("statement timeout"), { code: "57014" })), timeoutAfterMs));
      }
      return calls === 2 ? Promise.resolve([{ id: "run" }]) : new Promise(() => {});
    });
    vi.useFakeTimers();
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(retryingDb, watchedRun(LEGACY_CONTROLLER_LEASE_MS), controller);
    try {
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_RENEW_MS + timeoutAfterMs);
      expect(calls).toBe(2);
      // The retry wrote a fresh 60s lease; the first attempt's start must not shorten it.
      await vi.advanceTimersByTimeAsync(LEGACY_CONTROLLER_LEASE_MS - 1);
      expect(controller.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(controller.signal.reason.leaseLossCause).toBe("renewal_deadline");
      expect(controller.signal.reason.leaseLossTiming).toMatchObject({ sinceRenewalMs: LEGACY_CONTROLLER_LEASE_MS, renewalCount: 1 });
    } finally { watch.stop(); vi.useRealTimers(); }
  });

  it("records how late the deadline ran when the event loop was blocked", async () => {
    const idleDb = fakeRenewalDb(() => new Promise(() => {}));
    const controller = new AbortController();
    const watch = watchLegacyControllerLease(idleDb, watchedRun(10), controller);
    try {
      const blockedUntil = Date.now() + 80;
      while (Date.now() < blockedUntil) { /* hold the event loop past the deadline */ }
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(controller.signal.reason.leaseLossCause).toBe("renewal_deadline");
      expect(controller.signal.reason.leaseLossTiming.deadlineLateMs).toBeGreaterThanOrEqual(60);
      expect(controller.signal.reason.leaseLossTiming.renewalPendingMs).toBeNull();
    } finally { watch.stop(); }
  });
});
