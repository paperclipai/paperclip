import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyRunDispatch } from "../services/run-dispatch-notifications.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_RUN_DISPATCH_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("run dispatch production wiring (controlled local process adapter)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<ReturnType<typeof heartbeatService>["registerRunDispatchWork"]> | undefined;
  let reads: ReturnType<typeof vi.spyOn>;
  let draining = false;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("run-dispatch-work-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 90_000);
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
    heartbeat = heartbeatService(db); draining = false; errors.length = 0;
    reads = vi.spyOn(db, "select");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await worker?.stop(); await coordinator?.stop();
    await heartbeat.drainActiveRunExecutions();
    worker = undefined; coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining,
      canReconcile: () => true, onError: error => errors.push(error) });
    worker = heartbeat.registerRunDispatchWork(coordinator, () => !draining);
    await worker.ready;
  }
  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Dispatch", issuePrefix: `D${companyId.slice(0, 7)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "dispatch-user" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Controlled process", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "console.log('dispatch-proof')"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } },
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "failed",
      responsibleUserId: "dispatch-user", errorCode: "codex_transient_upstream", finishedAt: new Date(),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }, contextSnapshot: {},
    }).returning();
    return { companyId, agentId: agent.id, runId: run.id };
  }
  async function quiet() {
    await heartbeat.drainActiveRunExecutions();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull(), { timeout: 5_000 });
    const count = reads.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(reads).toHaveBeenCalledTimes(count);
  }
  async function status(id: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]);
  }
  async function completed(id: string) {
    await vi.waitFor(async () => expect((await status(id))?.status).toBe("succeeded"), { timeout: 10_000 });
    await heartbeat.drainActiveRunExecutions();
  }
  it("keeps fresh empty, configured idle and retained terminal history quiet", async () => {
    await start(); await quiet();
    await fixture(); await worker!.stop(); await coordinator!.stop();
    await start(); await quiet();
  });
  it("ordinary retry creation wakes the worker, respects the exact deadline, dispatches and settles", async () => {
    const f = await fixture(); await start(); await quiet();
    const result = await heartbeat.scheduleBoundedRetry(f.runId, { delayMs: 60_000, random: () => 0 });
    expect(result.outcome).toBe("scheduled");
    if (result.outcome !== "scheduled") throw new Error("Expected retry creation");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(result.dueAt.getTime()));
    expect((await status(result.run.id)).status).toBe("scheduled_retry");
    await vi.advanceTimersByTimeAsync(result.dueAt.getTime() - Date.now() - 1);
    expect((await status(result.run.id)).status).toBe("scheduled_retry");
    await vi.advanceTimersByTimeAsync(1);
    await completed(result.run.id);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.retryOfRunId, f.runId)))).toHaveLength(1);
    await quiet();
  });
  it("reconstructs an overdue retry after process restart without a periodic tick", async () => {
    const f = await fixture();
    const scheduled = await heartbeat.scheduleBoundedRetry(f.runId, { now: new Date(Date.now() - 120_000), delayMs: 60_000 });
    if (scheduled.outcome !== "scheduled") throw new Error("Expected retry creation");
    heartbeat = heartbeatService(db);
    await start(); await completed(scheduled.run.id); await quiet();
  });
  it("cancels a future retry and removes its old deadline", async () => {
    const f = await fixture(); await start();
    const scheduled = await heartbeat.scheduleBoundedRetry(f.runId, { delayMs: 600_000 });
    if (scheduled.outcome !== "scheduled") throw new Error("Expected retry creation");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(scheduled.dueAt.getTime()));
    await heartbeat.cancelRun(scheduled.run.id, "operator stop", { suppressImmediateRecovery: true });
    await quiet(); expect((await status(scheduled.run.id)).status).toBe("cancelled");
  });
  it("retains the first retry written during drain and catches it up after resume", async () => {
    const f = await fixture(); await start(); await quiet(); draining = true;
    const scheduled = await heartbeat.scheduleBoundedRetry(f.runId, { delayMs: 10_000 });
    if (scheduled.outcome !== "scheduled") throw new Error("Expected retry creation");
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await status(scheduled.run.id)).status).toBe("scheduled_retry");
    draining = false; worker!.wake(); await vi.advanceTimersByTimeAsync(1);
    await completed(scheduled.run.id); await quiet();
  });
  it("holds nested producer work until outer commit and rolls back without a successor", async () => {
    const f = await fixture(); await start(); await quiet();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let queuedId = "";
    const writing = db.transaction(async tx => {
      await tx.transaction(async nested => {
        await notifyRunDispatch(nested);
        const [row] = await nested.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
          responsibleUserId: "dispatch-user", status: "queued", contextSnapshot: {} }).returning();
        queuedId = row.id;
      });
      await held;
    });
    await vi.waitFor(() => expect(queuedId).not.toBe(""));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await status(queuedId)).toBeUndefined();
    release(); await writing; await vi.advanceTimersByTimeAsync(1); await completed(queuedId); await quiet();
    await expect(db.transaction(async tx => {
      await tx.transaction(async nested => { await notifyRunDispatch(nested); await nested.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "queued" }); });
      throw new Error("rollback outer");
    })).rejects.toThrow("rollback outer");
    await vi.advanceTimersByTimeAsync(1); await quiet();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(2);
  });
});
