import { finishServiceShutdown } from "../shutdown.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as realDelay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, plugins, pluginJobs, pluginJobRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_PLUGIN_SCHEDULE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("plugin job scheduling without idle polling", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>, pluginId: string;
  let scheduler: ReturnType<typeof createPluginJobScheduler> | undefined;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let available = true, draining = false;
  let events: EventEmitter;
  const rpc = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("plugin-schedule-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {
    pluginId = randomUUID(); available = true; draining = false; events = new EventEmitter(); errors.length = 0;
    rpc.mockReset(); rpc.mockResolvedValue({});
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: pluginId, version: "1.0.0", manifestJson: {} as never });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    // Retry tests must not accidentally cross the next real hourly cron tick.
    vi.setSystemTime(new Date("2026-10-27T12:05:00Z"));
  });
  afterEach(async () => {
    await scheduler?.stop(); await coordinator?.stop(); scheduler = undefined; coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.execute(sql`drop trigger if exists plugin_settlement_failure on plugin_job_runs`);
    await db.execute(sql`drop function if exists plugin_settlement_failure()`);
    await db.delete(plugins).where(eq(plugins.id, pluginId));
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function start(maxConcurrentJobs = 10, settlementTimeoutMs = 30_000) {
    const workerManager = { isRunning: () => available, call: rpc, getWorker: () => events } as unknown as PluginWorkerManager;
    scheduler = createPluginJobScheduler({ db, jobStore: pluginJobStore(db), workerManager,
      isBackgroundWorkEnabled: () => !draining, maxConcurrentJobs, settlementTimeoutMs });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true,
      onError: error => errors.push(error) });
    await scheduler.start(coordinator);
    await scheduler.registerPlugin(pluginId);
  }
  const job = (key = "hourly", schedule = "0 * * * *") => pluginRegistryService(db).upsertJob(pluginId, key, { schedule });
  const runs = () => db.select().from(pluginJobRuns).where(eq(pluginJobRuns.pluginId, pluginId));
  async function settled() {
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(async () => {
      const next = coordinator!.nextWakeAt();
      if (idleWorkSnapshot().active > 0 && next !== null) {
        await vi.advanceTimersByTimeAsync(Math.max(0, next - Date.now()));
      }
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5000 });
  }
  async function quiet() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 5000 });
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction"), executes = vi.spyOn(db, "execute");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); executes.mockRestore();
  }
  async function due(key = "hourly") {
    const row = await job(key);
    await pluginJobStore(db).updateRunTimestamps(row.id, new Date(0), new Date(Date.now() - 1000));
    return row;
  }
  async function completed(count = 1) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect((await runs()).filter(run => run.status === "succeeded" || run.status === "failed")).toHaveLength(count);
    }, { timeout: 5000 });
  }

  it("does not query repeatedly after an empty startup reconciliation", async () => { await start(); await quiet(); });
  it("bounds full refreshes while many job status writes arrive sequentially", async () => {
    await pluginJobStore(db).syncJobDeclarations(pluginId, Array.from({ length: 40 }, (_, i) => ({ jobKey: `manual-${i}`, schedule: "" })));
    const jobs = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    await start(); await quiet();
    const reads = vi.spyOn(db, "select");
    for (const job of jobs.slice(0, 15)) {
      const run = await pluginJobStore(db).createRun({ jobId: job.id, pluginId, trigger: "manual" });
      await pluginJobStore(db).markRunning(run.id);
      await pluginJobStore(db).completeRun(run.id, { status: "succeeded" });
      await vi.advanceTimersByTimeAsync(1100);
    }
    expect(reads.mock.calls.length).toBeLessThanOrEqual(1);
    reads.mockRestore();
    await quiet();
    expect(await runs()).toHaveLength(15);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("honors a saved deadline inside the notification batching window", async () => {
    const row = await job();
    const deadline = new Date(Date.now() + 10_000);
    await pluginJobStore(db).updateRunTimestamps(row.id, new Date(0), deadline);
    await start();
    // registerPlugin produces a local wake immediately after startup. It may
    // batch the reload but must not replace the known ten-second deadline.
    await settled();
    expect(coordinator!.nextWakeAt()).toBe(deadline.getTime());
    expect(rpc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(Math.max(0, deadline.getTime() - Date.now()));
    await completed();
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0][2]).toMatchObject({ job: { scheduledAt: deadline.toISOString() } });
  });
  it("keeps configured manual-only and invalid schedules quiet", async () => {
    await job("manual", ""); await job("invalid", "not cron"); await start(); await quiet(); expect(rpc).not.toHaveBeenCalled();
  });
  it("initializes a first declaration after empty startup and runs only at its deadline", async () => {
    await start(); await quiet(); const row = await job(); await settled();
    const current = await pluginJobStore(db).getJobById(row.id);
    expect(current?.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    expect(rpc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(current!.nextRunAt!.getTime() - Date.now()); await completed(); expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("catches up an overdue startup job without moving its owed timestamp", async () => {
    const row = await due(); const at = (await pluginJobStore(db).getJobById(row.id))!.nextRunAt!;
    await start(); await completed();
    expect(rpc.mock.calls[0][2]).toMatchObject({ job: { scheduledAt: at.toISOString(), trigger: "schedule" } });
    expect((await pluginJobStore(db).getJobById(row.id))!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });
  it("pauses a due schedule and reactivates from the real status producer", async () => {
    const row = await due(); await pluginJobStore(db).updateJobStatus(row.id, "paused"); await start(); await quiet();
    await pluginJobStore(db).updateJobStatus(row.id, "active"); await completed(); expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("parks an unavailable worker and wakes overdue work from its lifecycle event", async () => {
    await due(); available = false; await start(); await quiet();
    available = true; events.emit("status", { status: "ready" }); await completed(); expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("retains a worker-availability wake received during drain", async () => {
    await due(); available = false; await start(); await quiet();
    draining = true; available = true; events.emit("status", { status: "ready" });
    await vi.advanceTimersByTimeAsync(10_000); expect(rpc).not.toHaveBeenCalled();
    draining = false; await completed();
  });
  it("retains the first committed job created during drain", async () => {
    await start(); await quiet(); draining = true; await due();
    const reads = vi.spyOn(db, "select"); await vi.advanceTimersByTimeAsync(10_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
    expect(rpc).not.toHaveBeenCalled(); draining = false; await completed();
  });
  it("does not dispatch a nested write until the outer transaction commits", async () => {
    await start(); await quiet();
    await db.transaction(async tx => {
      await pluginJobStore(tx).syncJobDeclarations(pluginId, [{ jobKey: "outer", schedule: "0 * * * *" }]);
      const row = await pluginJobStore(tx).getJobByKey(pluginId, "outer");
      await pluginJobStore(tx).updateRunTimestamps(row!.id, new Date(0), new Date(Date.now() - 1000));
      await vi.advanceTimersByTimeAsync(5000); expect(rpc).not.toHaveBeenCalled();
    });
    await completed();
  });
  it("disarms after a rolled-back declaration", async () => {
    await start(); await quiet();
    await expect(db.transaction(async tx => {
      await pluginJobStore(tx).syncJobDeclarations(pluginId, [{ jobKey: "rollback", schedule: "* * * * *" }]);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    await quiet(); expect(rpc).not.toHaveBeenCalled();
  });
  it("parks removed declarations while retaining their history", async () => {
    await due(); await start(); await completed();
    await pluginJobStore(db).syncJobDeclarations(pluginId, []); await quiet(); expect(await runs()).toHaveLength(1);
  });
  it.each([0, 3000])("recomputes a changed cron schedule with a %i ms database read lock", async (readLockMs) => {
    await job("changed", "0 0 1 1 *"); await start(); await settled();
    await job("changed", "* * * * *");
    let locked: Promise<unknown> | undefined;
    if (readLockMs > 0) {
      const acquired = Promise.withResolvers<void>();
      locked = db.transaction(async tx => {
        await tx.execute(sql`lock table plugin_jobs in access exclusive mode`);
        acquired.resolve();
        await realDelay(readLockMs);
      });
      await Promise.race([acquired.promise, locked]);
    }
    try { await settled(); } finally { await locked; }
    const deadline = coordinator!.nextWakeAt()!;
    expect(deadline - Date.now()).toBeGreaterThan(0);
    expect(deadline - Date.now()).toBeLessThanOrEqual(60_000);
    expect(rpc).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(deadline - Date.now()); await completed();
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0][2]).toMatchObject({ job: { scheduledAt: new Date(deadline).toISOString() } });
  });
  it("retries failed completion persistence without repeating the plugin side effect", async () => {
    await db.execute(sql`create function plugin_settlement_failure() returns trigger language plpgsql as $$ begin if new.status in ('succeeded', 'failed') then raise exception 'settlement unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger plugin_settlement_failure before update on plugin_job_runs for each row execute function plugin_settlement_failure()`);
    await due(); await start();
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors.length).toBeGreaterThan(0); }, { timeout: 5000 }); expect(rpc).toHaveBeenCalledTimes(1);
    await db.execute(sql`drop trigger plugin_settlement_failure on plugin_job_runs`); errors.length = 0;
    await completed(); expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("flushes a retained completion before graceful shutdown finishes", async () => {
    await db.execute(sql`create function plugin_settlement_failure() returns trigger language plpgsql as $$ begin if new.status in ('succeeded', 'failed') then raise exception 'settlement unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger plugin_settlement_failure before update on plugin_job_runs for each row execute function plugin_settlement_failure()`);
    await due(); await start();
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors.length).toBeGreaterThan(0); }, { timeout: 5000 });
    draining = true;
    await coordinator!.stop();
    await db.execute(sql`drop trigger plugin_settlement_failure on plugin_job_runs`); errors.length = 0;
    await scheduler!.stop();
    expect((await runs())[0].status).toBe("succeeded");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("finishes service cleanup and retries a failed settlement before closing the pool", async () => {
    await db.execute(sql`create function plugin_settlement_failure() returns trigger language plpgsql as $$ begin if new.status in ('succeeded', 'failed') then raise exception 'settlement unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger plugin_settlement_failure before update on plugin_job_runs for each row execute function plugin_settlement_failure()`);
    await due(); await start();
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors.length).toBeGreaterThan(0); }, { timeout: 5000 });
    draining = true; await coordinator!.stop(); errors.length = 0;
    const cleanup = vi.fn(async () => {
      expect((await runs())[0].status).toBe("running");
      await db.execute(sql`drop trigger plugin_settlement_failure on plugin_job_runs`);
    });
    const stop = vi.fn(() => scheduler!.stop());
    await finishServiceShutdown(stop, cleanup);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledTimes(2);
    expect((await runs())[0].status).toBe("succeeded");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("reports shutdown persistence failure and retains the result for another stop attempt", async () => {
    await db.execute(sql`create function plugin_settlement_failure() returns trigger language plpgsql as $$ begin if new.status in ('succeeded', 'failed') then raise exception 'settlement unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger plugin_settlement_failure before update on plugin_job_runs for each row execute function plugin_settlement_failure()`);
    await due(); await start();
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors.length).toBeGreaterThan(0); }, { timeout: 5000 });
    draining = true; await coordinator!.stop(); errors.length = 0;
    try {
      await expect(scheduler!.stop()).rejects.toThrow("Plugin job completion persistence failed during shutdown");
      expect((await runs())[0].status).toBe("running");
    } finally { await db.execute(sql`drop trigger plugin_settlement_failure on plugin_job_runs`); }
    await scheduler!.stop();
    expect((await runs())[0].status).toBe("succeeded");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("dispatches independent jobs while one completion remains unwritable", async () => {
    const blocked = await due("blocked");
    await db.execute(sql`create function plugin_settlement_failure() returns trigger language plpgsql as $$ begin if new.status in ('succeeded', 'failed') and new.job_id::text = TG_ARGV[0] then raise exception 'settlement unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger plugin_settlement_failure before update on plugin_job_runs for each row execute function plugin_settlement_failure(${sql.raw("'" + blocked.id + "'")})`);
    try {
      await start();
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(errors.length).toBeGreaterThan(0); }, { timeout: 5000 });
      const independent = await due("independent");
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        expect(await runs()).toEqual(expect.arrayContaining([expect.objectContaining({ jobId: independent.id, status: "succeeded" })]));
      }, { timeout: 5000 });
      expect(rpc).toHaveBeenCalledTimes(2);
    } finally {
      await db.execute(sql`drop trigger plugin_settlement_failure on plugin_job_runs`); errors.length = 0;
      await completed(2); await settled(); errors.length = 0;
    }
  });
  it.each(["succeeded", "failed"] as const)("retains a completed %s result when unregistering during a settlement failure", async outcome => {
    await db.execute(sql`create function plugin_settlement_failure() returns trigger language plpgsql as $$ begin if new.status in ('succeeded', 'failed') then raise exception 'settlement unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger plugin_settlement_failure before update on plugin_job_runs for each row execute function plugin_settlement_failure()`);
    if (outcome === "failed") rpc.mockRejectedValueOnce(new Error("Plugin failed before unregister"));
    await due(); await start();
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(errors.length).toBeGreaterThan(0);
      expect(scheduler!.diagnostics().activeJobCount).toBe(0);
    }, { timeout: 5000 });
    try {
      await scheduler!.unregisterPlugin(pluginId);
      expect((await runs())[0].status).toBe("running");
    } finally {
      await db.execute(sql`drop trigger plugin_settlement_failure on plugin_job_runs`);
      errors.length = 0;
      await scheduler!.tick(); await settled(); errors.length = 0;
    }
    expect((await runs())[0].status).toBe(outcome);
    expect(rpc).toHaveBeenCalledOnce();
    await quiet();
  });

  it("preserves a completion committed while unregister waits on the discovered run", async () => {
    const row = await job("finishing", "");
    const run = await pluginJobStore(db).createRun({ jobId: row.id, pluginId, trigger: "manual" });
    await pluginJobStore(db).markRunning(run.id);
    await start(); await quiet();
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const finishing = db.transaction(async tx => {
      await pluginJobStore(tx).completeRun(run.id, { status: "succeeded" });
      locked(); await gate;
    });
    await acquired;
    const unregistering = scheduler!.unregisterPlugin(pluginId);
    try {
      await vi.waitFor(async () => {
        const [waiting] = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and state = 'active' and wait_event_type = 'Lock'
          and query like '%plugin_job_runs%'`);
        expect(waiting.count).toBeGreaterThan(0);
      });
    } finally { release(); await finishing; await unregistering; }
    expect((await runs())[0].status).toBe("succeeded");
    expect(rpc).not.toHaveBeenCalled();
    await quiet();
  });

  it("retains the manual reservation when a refresh read finishes after manual dispatch", async () => {
    await start(2); await quiet();
    // Creating due work also wakes the scheduler. Keep dispatch paused until
    // the snapshot barrier is installed, regardless of notification timing.
    draining = true;
    const row = await due("raced");
    let resumeRead!: () => void, enteredRead!: () => void, releaseCall!: () => void;
    const readGate = new Promise<void>(resolve => { resumeRead = resolve; });
    const readEntered = new Promise<void>(resolve => { enteredRead = resolve; });
    const callGate = new Promise<void>(resolve => { releaseCall = resolve; });
    rpc.mockImplementation(() => callGate);
    const select = db.select.bind(db);
    let held = false;
    // Hold delivery of one real outstanding-run query result. The manual run
    // commits after this snapshot, before the scheduled dispatch resumes.
    const readSpy = vi.spyOn(db, "select").mockImplementation((fields) => {
      const builder = select(fields);
      if (fields?.jobId !== pluginJobRuns.jobId || held) return builder;
      held = true;
      const from = builder.from.bind(builder);
      vi.spyOn(builder, "from").mockImplementation((table) => {
        const query = from(table);
        const then = query.then.bind(query);
        query.then = ((fulfilled, rejected) => then(async rows => {
          enteredRead(); await readGate; return rows;
        }).then(fulfilled, rejected)) as typeof query.then;
        return query;
      });
      return builder;
    });
    draining = false;
    const refreshing = scheduler!.tick();
    try {
      await readEntered;
      await scheduler!.triggerJob(row.id);
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
      resumeRead(); await refreshing;
      expect(scheduler!.diagnostics().activeJobIds).toEqual([row.id]);
      await due("waiting-one"); await due("waiting-two"); await scheduler!.tick();
      await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
      expect(scheduler!.diagnostics().activeJobCount).toBe(2);
    } finally {
      resumeRead(); readSpy.mockRestore();
      await pluginJobStore(db).updateJobStatus(row.id, "paused");
      releaseCall(); await refreshing; await settled();
    }
    await completed(3);
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("preserves a deadline advanced during a concurrent unchanged declaration update", async () => {
    const row = await due();
    const advanced = new Date(Date.now() + 600_000);
    let release!: () => void, locked!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const advancing = db.transaction(async tx => {
      await pluginJobStore(tx).updateRunTimestamps(row.id, new Date(), advanced);
      locked(); await barrier;
    });
    await acquired;
    const updating = pluginRegistryService(db).upsertJob(pluginId, row.jobKey, { schedule: row.schedule });
    try {
      await vi.waitFor(async () => {
        const [waiting] = await db.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and state = 'active' and wait_event_type = 'Lock'`);
        expect(waiting.count).toBeGreaterThan(0);
      });
    } finally { release(); await advancing; await updating; }
    expect((await pluginJobStore(db).getJobById(row.id))!.nextRunAt).toEqual(advanced);
  });
  it("records provider failure and advances the cron obligation", async () => {
    rpc.mockRejectedValueOnce(new Error("plugin rejected job")); await due(); await start(); await completed();
    expect((await runs())[0]).toMatchObject({ status: "failed", error: "plugin rejected job" });
    await settled(); expect(coordinator!.nextWakeAt()! > Date.now()).toBe(true);
  });
  it("does not replay an unresolved run left by another process", async () => {
    const row = await due(); await pluginJobStore(db).createRun({ jobId: row.id, pluginId, trigger: "schedule" });
    await start(); await quiet(); expect(rpc).not.toHaveBeenCalled();
    const [run] = await runs(); await pluginJobStore(db).completeRun(run.id, { status: "cancelled" }); await completed();
  });
  it("fills released capacity from completion without a poll", async () => {
    await due("one"); await due("two"); let release!: () => void;
    rpc.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const starting = start(1); await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    release(); await starting; await completed(2); expect(rpc).toHaveBeenCalledTimes(2);
  });
  it("tracks manual work and waits for admitted calls during shutdown", async () => {
    const row = await job("manual", ""); await start(); await quiet(); let release!: () => void;
    rpc.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    await scheduler!.triggerJob(row.id); await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(idleWorkSnapshot().active).toBeGreaterThan(0);
    let stopped = false; const stopping = scheduler!.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1000); expect(stopped).toBe(false);
    release(); await stopping; expect((await runs())[0].status).toBe("succeeded");
  });
  it("does no SQL while waiting for a future configured deadline", async () => {
    const row = await job(); const at = new Date(Date.now() + 600_000);
    await pluginJobStore(db).updateRunTimestamps(row.id, new Date(0), at);
    await start();
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(coordinator!.nextWakeAt()).toBe(at.getTime());
    }, { timeout: 5000 });
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    await vi.advanceTimersByTimeAsync(180_000);
    expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    reads.mockRestore(); writes.mockRestore(); expect(rpc).not.toHaveBeenCalled();
  });
  it("reconstructs the saved deadline after scheduler restart", async () => {
    const row = await job(); const at = new Date(Date.now() + 600_000);
    await pluginJobStore(db).updateRunTimestamps(row.id, new Date(0), at);
    await start(); await settled(); await scheduler!.stop(); await coordinator!.stop();
    await start();
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(coordinator!.nextWakeAt()).toBe(at.getTime());
    }, { timeout: 5000 });
    await vi.advanceTimersByTimeAsync(at.getTime() - Date.now()); await completed(); expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("rechecks a paused definition after waiting for its lock", async () => {
    const row = await due(); let startup!: Promise<void>;
    await db.transaction(async tx => {
      await pluginJobStore(tx).updateJobStatus(row.id, "paused");
      startup = start(); await vi.advanceTimersByTimeAsync(1000); expect(rpc).not.toHaveBeenCalled();
    });
    await startup; await quiet(); expect(rpc).not.toHaveBeenCalled();
  });
  it("prevents overlapping concurrent manual triggers", async () => {
    const row = await job("manual", ""); await start(); await quiet(); let release!: () => void;
    rpc.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const attempts = await Promise.allSettled([scheduler!.triggerJob(row.id), scheduler!.triggerJob(row.id)]);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    release(); await completed(); expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
  });
  it("bounds a locked completion write through shutdown and retries without rerunning the plugin", async () => {
    const row = await job("manual", ""); await start(10, 250); await quiet();
    let finishRpc!: () => void;
    rpc.mockImplementation(() => new Promise<void>(resolve => { finishRpc = resolve; }));
    const { runId } = await scheduler!.triggerJob(row.id);
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
    let unlock!: () => void, acquired!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const admitted = new Promise<void>(resolve => { acquired = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, runId)).for("update");
      acquired(); await gate;
    });
    await admitted;
    let stop: Promise<void> | undefined, stopped = false, failure: unknown;
    try {
      draining = true; finishRpc();
      await vi.waitFor(async () => {
        const waits = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
          and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like 'update "plugin_job_runs"%'`);
        expect(waits.length).toBe(1);
      });
      stop = scheduler!.stop().then(() => { stopped = true; }, error => { failure = error; stopped = true; });
      await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 5000 });
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([expect.objectContaining({ cause: expect.objectContaining({ code: "57014" }) })]);
      expect(await runs()).toMatchObject([{ id: runId, status: "running" }]);
    } finally {
      unlock(); await holder; await stop;
    }
    await scheduler!.stop();
    expect(await runs()).toMatchObject([{ id: runId, status: "succeeded" }]);
    expect(rpc).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
  });

  it("deleting the last job cancels its future deadline", async () => {
    await job(); await start(); await settled(); await pluginJobStore(db).deleteAllJobs(pluginId); await quiet();
  });
});
