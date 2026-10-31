import { idleWorkSnapshot } from "../services/task-admission.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, costEvents, createDb, databaseWorkPending, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { issueService } from "../services/issues.js";
import { materializeNativeProviderCapacityRetry } from "../services/native-runtime/native-provider-capacity-retry.js";
import { agentService } from "../services/agents.js";
import { budgetService } from "../services/budgets.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
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
  const retryQueries: string[] = [];
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("run-dispatch-work-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    db.$client.options.debug = (_connection, query) => {
      if (query.startsWith("select") && query.includes('"heartbeat_runs"') &&
        query.includes("startupCancellation") && query.includes('"scheduled_retry_at"')) retryQueries.push(query);
    };
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
  }, 90_000);
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
    heartbeat = heartbeatService(db); draining = false; errors.length = 0;
    reads = vi.spyOn(db, "select");
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
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull(), { timeout: 5_000 });
    const count = reads.mock.calls.length;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(reads).toHaveBeenCalledTimes(count);
    } finally { vi.useRealTimers(); }
  }
  async function status(id: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]);
  }
  async function completed(id: string) {
    await vi.waitFor(async () => expect(["running", "succeeded"]).toContain((await status(id))?.status), { timeout: 10_000 });
    await heartbeat.drainActiveRunExecutions();
    const completed = await status(id);
    expect(completed.status).toBe("succeeded");
    expect(completed.stdoutExcerpt).toContain("dispatch-proof");
  }
  it("keeps fresh empty, configured idle and retained terminal history quiet", async () => {
    await start(); await quiet();
    await fixture(); await worker!.stop(); await coordinator!.stop();
    await start(); await quiet();
  });
  it.each(["agent", "issue"] as const)("does not scan global scheduled retries for repeated ordinary %s edits", async kind => {
    const f = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Edit source", status: "backlog" }).returning();
    await start(); await quiet();
    const before = retryQueries.length;
    expect(before).toBeGreaterThan(0); // The passive observer saw real startup retry SQL.
    for (let index = 0; index < 12; index++) {
      if (kind === "agent") await agentService(db).update(f.agentId, { name: `Edited agent ${index}` });
      else await issueService(db).update(issue.id, { title: `Edited issue ${index}` });
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await quiet();
    expect(retryQueries).toHaveLength(before);
  });
  it.each([false, true])("observes a native capacity retry only after its transaction settles (rollback=%s)", async rollback => {
    const f = await fixture();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Capacity retry", status: "in_progress",
      assigneeAgentId: f.agentId }).returning();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.runId));
    await start(); await quiet();
    let retryId = "";
    const writing = db.transaction(async tx => {
      retryId = await materializeNativeProviderCapacityRetry({ tx: tx as unknown as typeof db, ...f, issueId: issue.id });
      expect(databaseWorkPending(db, DELIVERY_QUEUES.scheduledRetryDispatch)).toBe(true);
      expect(await status(retryId)).toBeUndefined();
      if (rollback) throw new Error("native capacity rollback");
    });
    if (rollback) {
      await expect(writing).rejects.toThrow("native capacity rollback");
      await quiet(); expect(await status(retryId)).toBeUndefined();
    } else {
      await writing;
      const retry = await status(retryId);
      expect(retry.status).toBe("scheduled_retry");
      await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(retry.scheduledRetryAt!.getTime()), { timeout: 5_000 });
      await heartbeat.cancelRun(retryId, "fixture teardown", { suppressImmediateRecovery: true });
      await quiet();
    }
  });
  it("ordinary retry creation wakes the worker, respects the exact deadline, dispatches and settles", async () => {
    const f = await fixture(); await start(); await quiet();
    const result = await heartbeat.scheduleBoundedRetry(f.runId, { delayMs: 4_000, random: () => 0 });
    expect(result.outcome).toBe("scheduled");
    if (result.outcome !== "scheduled") throw new Error("Expected retry creation");
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(result.dueAt.getTime()), { timeout: 5_000 });
    expect((await status(result.run.id)).status).toBe("scheduled_retry");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(Date.now()).toBeLessThan(result.dueAt.getTime());
    expect((await status(result.run.id)).status).toBe("scheduled_retry");
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
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(scheduled.dueAt.getTime()), { timeout: 5_000 });
    await heartbeat.cancelRun(scheduled.run.id, "operator stop", { suppressImmediateRecovery: true });
    await quiet(); expect((await status(scheduled.run.id)).status).toBe("cancelled");
  });
  it("retains the first retry written during drain and catches it up after resume", async () => {
    const f = await fixture(); await start(); await quiet(); draining = true;
    const scheduled = await heartbeat.scheduleBoundedRetry(f.runId, { delayMs: 200 });
    if (scheduled.outcome !== "scheduled") throw new Error("Expected retry creation");
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    const count = reads.mock.calls.length;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      await vi.advanceTimersByTimeAsync(90_000);
      expect(reads).toHaveBeenCalledTimes(count);
      expect(idleWorkSnapshot().active).toBe(0);
    } finally { vi.useRealTimers(); }
    expect((await status(scheduled.run.id)).status).toBe("scheduled_retry");
    draining = false; worker!.wake();
    await completed(scheduled.run.id); await quiet();
  });
  it("uses a committed budget raise to resume a queued run in the company it paused", async () => {
    const f = await fixture();
    const budgets = budgetService(db);
    await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, amount: 100,
      metric: "billed_cents", windowKind: "lifetime", hardStopEnabled: true }, "dispatch-user");
    const [cost] = await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId,
      provider: "fixture", biller: "fixture", model: "controlled", inputTokens: 0, outputTokens: 0,
      costCents: 125, occurredAt: new Date() }).returning();
    await budgets.evaluateCostEvent(cost);
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0].status).toBe("paused");
    const [queued] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "queued", responsibleUserId: "dispatch-user", invocationSource: "automation", contextSnapshot: {} }).returning();
    await start(); await quiet(); expect((await status(queued.id)).status).toBe("queued");
    await budgets.upsertPolicy(f.companyId, { scopeType: "company", scopeId: f.companyId, amount: 10_000,
      metric: "billed_cents", windowKind: "lifetime", hardStopEnabled: true }, "dispatch-user");
    await completed(queued.id); await quiet();
  });
  it("clearing an agent error wakes saved queue work only after its own transaction commits", async () => {
    const f = await fixture(); await start(); await quiet();
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, f.agentId));
    const [queued] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "queued", responsibleUserId: "dispatch-user", invocationSource: "automation", contextSnapshot: {} }).returning();
    let writing: ReturnType<ReturnType<typeof agentService>["clearError"]> | undefined;
    try {
      await db.transaction(async blocker => {
        await blocker.select().from(agents).where(eq(agents.id, f.agentId)).for("update");
        writing = agentService(db).clearError(f.agentId);
        void writing.catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(databaseWorkPending(db, DELIVERY_QUEUES.queuedRunDispatch)).toBe(false);
        expect((await status(queued.id)).status).toBe("queued");
        expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0].status).toBe("error");
      });
    } finally { await writing; }
    await completed(queued.id); await quiet();
  });
  it("leaves cancellation-owned retries quiet even when their old promotion time is overdue", async () => {
    const f = await fixture();
    const scheduled = await heartbeat.scheduleBoundedRetry(f.runId, { now: new Date(Date.now() - 60_000), delayMs: 1_000 });
    if (scheduled.outcome !== "scheduled") throw new Error("Expected retry creation");
    await db.update(heartbeatRuns).set({ resultJson: { startupCancellation: { requestedAt: new Date().toISOString() },
      cancellation: { expected: true, reason: "operator stop", source: "operator" } } }).where(eq(heartbeatRuns.id, scheduled.run.id));
    await start(); await quiet();
    expect((await status(scheduled.run.id)).status).toBe("scheduled_retry");
    expect(await heartbeat.promoteDueScheduledRetries()).toEqual({ promoted: 0, runIds: [] });
    await quiet();
  });
  it("rejects an error clear without publishing work when the lifecycle is no longer ready", async () => {
    const f = await fixture(); await start(); await quiet();
    await db.update(agents).set({ status: "error", lifecycleState: "paused" }).where(eq(agents.id, f.agentId));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      await expect(agentService(db).clearError(f.agentId)).rejects.toThrow("Only agents in error status");
      expect(coordinator!.nextWakeAt()).toBeNull();
      const count = reads.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toHaveBeenCalledTimes(count);
    } finally { vi.useRealTimers(); }
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0].status).toBe("error");
    await quiet();
  });
  it("keeps a foreign company's future retry intact while concurrent workers claim one due retry", async () => {
    const selected = await fixture(), foreign = await fixture(); await start();
    const later = await heartbeat.scheduleBoundedRetry(foreign.runId, { delayMs: 600_000 });
    const due = await heartbeat.scheduleBoundedRetry(selected.runId, { delayMs: 500 });
    if (later.outcome !== "scheduled" || due.outcome !== "scheduled") throw new Error("Expected retries");
    const other = heartbeatService(db);
    const competing = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const competingWorker = other.registerRunDispatchWork(competing, () => true);
    try {
      await competingWorker.ready; await completed(due.run.id); await other.drainActiveRunExecutions();
      expect((await status(later.run.id)).status).toBe("scheduled_retry");
      expect((await status(later.run.id)).scheduledRetryAt).toEqual(later.dueAt);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, selected.runId))).toHaveLength(1);
      await heartbeat.cancelRun(later.run.id, "fixture teardown", { suppressImmediateRecovery: true });
      await quiet();
    } finally { await competingWorker.stop(); await competing.stop(); await other.drainActiveRunExecutions(); }
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
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await status(queuedId)).toBeUndefined();
    release(); await writing; await completed(queuedId); await quiet();
    await expect(db.transaction(async tx => {
      await tx.transaction(async nested => { await notifyRunDispatch(nested); await nested.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "queued" }); });
      throw new Error("rollback outer");
    })).rejects.toThrow("rollback outer");
    await quiet();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(2);
  });
});
