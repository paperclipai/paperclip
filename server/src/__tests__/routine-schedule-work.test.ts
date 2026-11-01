import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, applyPendingMigrations, companies, costEvents, createDb, routineRuns, routineTriggers, type Db } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.js";
import { budgetService } from "../services/budgets.js";
import { companyService } from "../services/companies.js";
import { registerDeadlineWork } from "../services/deadline-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ROUTINE_SCHEDULE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("routine schedule deadline work", () => {
  let db: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let companyId: string, agentId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let draining = false;
  const errors: unknown[] = [];
  const wakeup = vi.fn(async () => null);
  const service = (owner = db) => routineService(owner, { heartbeat: { wakeup }, runtimeEnv: {} });
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("routine-schedule-work-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6 });
  }, 30_000);
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Scheduled work", issuePrefix: `R${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: randomUUID(), requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Scheduled agent", status: "active", lifecycleState: "ready", adapterType: "codex_local" });
    errors.length = 0; wakeup.mockClear(); draining = false;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-07-16T12:30:00Z"));
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.execute(sql`truncate companies cascade`);
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  const create = (owner = db, catchUpPolicy: "skip_missed" | "enqueue_missed_with_cap" = "skip_missed") => service(owner).create(companyId, {
    title: "Scheduled routine", assigneeAgentId: agentId, priority: "medium", status: "active",
    concurrencyPolicy: "coalesce_if_active", catchUpPolicy,
  }, {});
  async function start(options: {
    next?: () => Promise<number | null>;
    run?: (signal: AbortSignal) => Promise<unknown>;
  } = {}) {
    const svc = service();
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true,
      onError: error => errors.push(error) });


    const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.routineSchedules, {
      retryMs: 30_000,
      canRun: () => !draining,
      run: options.run ?? (signal => svc.tickScheduledTriggers(new Date(), () => !draining && !signal.aborted)),
      next: options.next ?? (() => svc.nextScheduledTriggerAt()),
    });
    await worker.ready;
    return worker;
  }
  async function settled() {
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
  }
  async function quiet(duration = 60_000, waitForIdle = true) {
    if (waitForIdle) await settled();
    const select = vi.spyOn(db, "select"), execute = vi.spyOn(db, "execute"), transaction = vi.spyOn(db, "transaction");
    try {
      await vi.advanceTimersByTimeAsync(duration);
      expect(select).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
    } finally { select.mockRestore(); execute.mockRestore(); transaction.mockRestore(); }
  }

  it("retains overdue catch-up work after the first capped pass", async () => {
    const routine = await create(db, "enqueue_missed_with_cap");
    const { trigger } = await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 * * * *", timezone: "UTC" }, {});
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-07-15T10:00:00Z") }).where(eq(routineTriggers.id, trigger.id));
    await start(); await settled();
    expect(await db.select().from(routineRuns)).toHaveLength(25);
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(async () => expect(await db.select().from(routineRuns)).toHaveLength(27));
    await settled();
    expect(coordinator!.nextWakeAt()).toBe(Date.parse("2026-07-16T13:00:00Z"));
    await quiet();
  });

  it("disarms on company pause and rearms from the committed reactivation", async () => {
    const routine = await create();
    const { trigger } = await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
    await start(); await settled();
    expect(coordinator!.nextWakeAt()).toBe(trigger.nextRunAt!.getTime());
    await companyService(db).update(companyId, { status: "paused" });
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    await quiet();
    await companyService(db).update(companyId, { status: "active" });
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(trigger.nextRunAt!.getTime()));
    await quiet();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("reactivates from the first trigger, replaces earlier deadlines, and cancels disabled or archived schedules", async () => {
    await start(); await quiet();
    const routine = await create();
    await quiet();
    const created = await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(created.trigger.nextRunAt!.getTime()));
    const updated = await service().updateTrigger(created.trigger.id, { cronExpression: "0 * * * *" }, {});
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(updated.trigger.nextRunAt!.getTime()));
    await service().updateTrigger(created.trigger.id, { enabled: false }, {});
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    await quiet();
    await service().updateTrigger(created.trigger.id, { enabled: true }, {});
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).not.toBeNull());
    await service().update(routine.id, { status: "archived" }, {});
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    await quiet();
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("restores a deleted schedule from its revision through the ordinary producer", async () => {
    const routine = await create();
    const created = await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
    await start();
    await service().deleteTrigger(created.trigger.id, {});
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    await quiet();
    await service().restoreRevision(routine.id, created.revision!.id, {});
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(created.trigger.nextRunAt!.getTime()));
    await quiet();
  });

  it("waits for the outer transaction and forgets rolled-back nested schedules", async () => {
    const routine = await create();
    await start(); await quiet();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const written = new Promise<void>(resolve => { entered = resolve; });
    let expected: number | null = null;
    const writing = db.transaction(async tx => {
      const created = await service(tx as unknown as Db).createTrigger(routine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
      expected = created.trigger.nextRunAt!.getTime(); entered(); await held;
    });
    try {
      await written;
      expect(await service().nextScheduledTriggerAt()).toBeNull();
      expect(wakeup).not.toHaveBeenCalled();
    } finally { release(); await writing; }
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(expected));
    await expect(db.transaction(async tx => {
      await service(tx as unknown as Db).createTrigger(routine.id, { kind: "schedule", cronExpression: "* * * * *", timezone: "UTC" }, {});
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    await settled();
    expect(await service().nextScheduledTriggerAt()).toBe(expected);
    expect(coordinator!.nextWakeAt()).toBe(expected);
    await quiet();
  });

  it("retains the first committed schedule during drain without passive SQL and loads it on resume", async () => {
    const routine = await create();
    await start(); await quiet();
    draining = true;
    const created = await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
    await vi.advanceTimersByTimeAsync(1_000);
    await quiet(60_000, false);
    draining = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(created.trigger.nextRunAt!.getTime()));
    await quiet();
  });

  it("reconstructs an overdue schedule on restart and keeps completed history passive", async () => {
    const routine = await create();
    await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "* * * * *", timezone: "UTC" }, {});
    await start(); await settled();
    await coordinator!.stop(); coordinator = undefined;
    vi.setSystemTime(new Date("2026-07-16T12:35:30Z"));
    await start(); await settled();
    expect(await db.select().from(routineRuns)).toHaveLength(1);
    expect(coordinator!.nextWakeAt()).toBe(Date.parse("2026-07-16T12:36:00Z"));
    await service().update(routine.id, { status: "paused" }, {});
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    await quiet();
    expect(await db.select().from(routineRuns)).toHaveLength(1);
  });

  it("retries a failed deadline read after drain and becomes quiet after successful reconstruction", async () => {
    const routine = await create();
    const created = await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
    const next = vi.fn().mockRejectedValueOnce(new Error("deadline unavailable"))
      .mockImplementation(() => service().nextScheduledTriggerAt());
    await start({ next });
    expect(errors.splice(0)).toEqual([expect.objectContaining({ message: "deadline unavailable" })]);
    expect(next).toHaveBeenCalledTimes(1);
    draining = true;
    await quiet(60_000, false);
    expect(next).toHaveBeenCalledTimes(1);
    draining = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(created.trigger.nextRunAt!.getTime()));
    await quiet();
  });

  it("reconciles a schedule changed while the previous deadline read was in flight", async () => {
    const routine = await create();
    const created = await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const read = new Promise<void>(resolve => { entered = resolve; });
    const next = vi.fn().mockImplementationOnce(async () => {
      const value = await service().nextScheduledTriggerAt(); entered(); await held; return value;
    }).mockImplementation(() => service().nextScheduledTriggerAt());
    const starting = start({ next });
    let expected: number | undefined;
    try {
      await read;
      const updated = await service().updateTrigger(created.trigger.id, { cronExpression: "0 * * * *" }, {});
      expected = updated.trigger.nextRunAt!.getTime();
    } finally { release(); await starting; }
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(expected));
    await quiet();
  });

  it("stops between claimed trigger batches and leaves unclaimed work for restart", async () => {
    const routine = await create();
    await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 * * * *", timezone: "UTC" }, {});
    await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 * * * *", timezone: "UTC" }, {});
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-07-16T12:00:00Z") });
    let candidates = 0;
    await start({ run: () => service().tickScheduledTriggers(new Date(), () => ++candidates === 1) });
    await settled();
    expect(await db.select().from(routineRuns)).toHaveLength(1);
    expect(await service().nextScheduledTriggerAt()).toBe(Date.parse("2026-07-16T12:00:00Z"));
    await coordinator!.stop(); coordinator = undefined;
    await start(); await settled();
    expect(await db.select().from(routineRuns)).toHaveLength(2);
    expect(coordinator!.nextWakeAt()).toBe(Date.parse("2026-07-16T13:00:00Z"));
    await quiet();
  });


  it("refreshes a saved deadline advanced by a manual run naming the trigger", async () => {
    const routine = await create();
    const { trigger } = await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
    await db.update(routineTriggers).set({ nextRunAt: new Date("2026-08-01T00:00:00Z") }).where(eq(routineTriggers.id, trigger.id));
    await start(); await settled();
    expect(coordinator!.nextWakeAt()).toBe(Date.parse("2026-08-01T00:00:00Z"));
    await service().runRoutine(routine.id, { source: "manual", triggerId: trigger.id });
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(Date.parse("2026-07-17T00:00:00Z")));
    await quiet();
  });

  it.each(["archive", "remove"] as const)("disarms a company schedule after %s", async operation => {
    const routine = await create();
    await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
    await start(); await settled();
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    if (operation === "remove") {


      await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, agentId));
    }
    await companyService(db)[operation](companyId);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    await quiet();
  });

  it("starts during drain without querying and reconstructs schedules when admission resumes", async () => {
    const routine = await create();
    const { trigger } = await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
    draining = true;
    const select = vi.spyOn(db, "select");
    try { await start(); expect(select).not.toHaveBeenCalled(); } finally { select.mockRestore(); }
    await quiet(60_000, false);
    draining = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(trigger.nextRunAt!.getTime()));
    await quiet();
  });

  it("does not consume overdue triggers in a paused company", async () => {
    const routine = await create();
    const { trigger } = await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 * * * *", timezone: "UTC" }, {});
    const due = new Date("2026-07-16T12:00:00Z");
    await db.update(routineTriggers).set({ nextRunAt: due }).where(eq(routineTriggers.id, trigger.id));
    await companyService(db).update(companyId, { status: "paused" });
    await start(); await quiet();
    expect(await db.select().from(routineRuns)).toHaveLength(0);
    expect((await db.select().from(routineTriggers))[0]!.nextRunAt).toEqual(due);
    expect(coordinator!.nextWakeAt()).toBeNull();
  });


  it.each(["pause", "resume"] as const)("refreshes schedules when budget enforcement changes company state: %s", async operation => {
    const routine = await create();
    const { trigger } = await service().createTrigger(routine.id, { kind: "schedule", cronExpression: "0 0 * * *", timezone: "UTC" }, {});
    await db.insert(costEvents).values({ companyId, agentId, provider: "openai", biller: "openai",
      billingType: "metered_api", model: "fixture", costCents: 125, occurredAt: new Date() });
    const budgets = budgetService(db);
    const limit = (amount: number) => budgets.upsertPolicy(companyId, {
      scopeType: "company", scopeId: companyId, amount, windowKind: "calendar_month_utc", notifyEnabled: false,
    }, null);
    if (operation === "resume") await limit(100);
    await start(); await settled();
    if (operation === "pause") {
      await limit(100);
      await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    } else {
      expect(coordinator!.nextWakeAt()).toBeNull();
      await limit(200);
      await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBe(trigger.nextRunAt!.getTime()));
    }
    await quiet();
  });

});
