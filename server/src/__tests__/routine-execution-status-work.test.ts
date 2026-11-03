import { issueTreeControlService } from "../services/issue-tree-control.js";
import { writeExecutionControl } from "../services/execution-control-notifications.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, pluginManagedResources, plugins, routineRuns, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyRoutineExecutionStatus } from "../services/routine-execution-status-notifications.js";
import { registerRoutineExecutionStatusWork } from "../services/routine-execution-status-work.js";
import { routineExecutionStatusService } from "../services/routine-run-status.js";
import { routineService } from "../services/routines.js";
import { issueService } from "../services/issues.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "../services/heartbeat/run-lifecycle.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { createHeartbeatRunPreparation } from "../services/heartbeat/run-preparation.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ROUTINE_STATUS_WORK_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("routine execution status work with PostgreSQL", () => {
  let db: Db, temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let enabled = true, draining = false, standby = false;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("routine-status-work-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6 });
  }, 60_000);
  beforeEach(() => {
    enabled = true; draining = false; standby = false; errors.length = 0;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks();
    await db.execute(sql`SET client_min_messages = warning; TRUNCATE companies CASCADE`);
  });
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });
  const canRun = () => enabled && !draining && !standby;
  async function start(service = routineExecutionStatusService(db)) {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun, canReconcile: () => !standby,
      onError: error => errors.push(error) });
    const worker = registerRoutineExecutionStatusWork(coordinator, service, canRun);
    await worker.ready;
    return worker;
  }
  async function settled() { await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0)); }
  async function quiet() {
    await settled();
    const select = vi.spyOn(db, "select"), execute = vi.spyOn(db, "execute"), transaction = vi.spyOn(db, "transaction");
    try {
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(select).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
    } finally { select.mockRestore(); execute.mockRestore(); transaction.mockRestore(); }
  }
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Routine status work", issuePrefix: `R${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: randomUUID(), requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Routine worker", status: "active", lifecycleState: "ready", adapterType: "codex_local" });
    const service = routineService(db, { heartbeat: { wakeup: async () => null }, runtimeEnv: {} });
    const routine = await service.create(companyId, { title: "Status projection", assigneeAgentId: agentId,
      priority: "medium", status: "active", concurrencyPolicy: "always_enqueue", catchUpPolicy: "skip_missed" }, {});
    return { companyId, agentId, routine, service };
  }
  async function dispatch(f: Awaited<ReturnType<typeof fixture>>) {
    return f.service.runRoutine(f.routine.id, { source: "manual", idempotencyKey: randomUUID() });
  }
  async function saved(id: string) { return (await db.select().from(routineRuns).where(eq(routineRuns.id, id)))[0]; }
  async function projected(id: string, status: string) {
    await vi.waitFor(async () => expect((await saved(id)).status).toBe(status));
    await settled();
  }

  it("settles empty startup, configured idle, healthy active and retained terminal history without recurring SQL", async () => {
    await start(); await quiet();
    const f = await fixture(); await quiet();
    const run = await dispatch(f); await quiet();
    await issueService(db).update(run.linkedIssueId!, { status: "done" });
    await projected(run.id, "completed");
    const before = await saved(run.id); await quiet();
    expect(await saved(run.id)).toEqual(before); expect(errors).toEqual([]);
  });
  it.each(["done", "blocked", "cancelled"])("reactivates from the first ordinary %s transition and preserves input", async status => {
    await start(); await quiet();
    const f = await fixture(), run = await dispatch(f);
    await issueService(db).update(run.linkedIssueId!, { status });
    await projected(run.id, status === "done" ? "completed" : "failed");
    expect((await saved(run.id)).completedAt).toBeInstanceOf(Date);
    await quiet(); expect(errors).toEqual([]);
    if (status !== "done") {
      await issueService(db).update(run.linkedIssueId!, { status: "in_progress" });
      await projected(run.id, "issue_created");
      expect(await saved(run.id)).toMatchObject({ completedAt: null, failureReason: null });
      await quiet();
    }
  });
  it("reconstructs legacy terminal debt and reopened transient failures but leaves skipped and coalesced history unchanged", async () => {
    const f = await fixture(), first = await dispatch(f), second = await dispatch(f);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, first.linkedIssueId!));
    await db.update(routineRuns).set({ status: "failed", failureReason: "Execution issue moved to blocked", completedAt: new Date() }).where(eq(routineRuns.id, second.id));
    const terminal = await db.insert(routineRuns).values(["skipped", "coalesced"].map(status => ({ companyId: f.companyId,
      routineId: f.routine.id, source: "manual", linkedIssueId: first.linkedIssueId, status, completedAt: new Date() }))).returning();
    await start(); await projected(first.id, "completed"); await projected(second.id, "issue_created");
    for (const row of terminal) expect(await saved(row.id)).toEqual(row);
    await quiet(); expect(errors).toEqual([]);
  });
  it("settles the declared custom origin of a real plugin-managed dispatch and preserves other companies", async () => {
    const f = await fixture(), other = await fixture();
    const pluginKey = `routine-status-${randomUUID()}`, originId = `operation:${randomUUID()}`;
    const [plugin] = await db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "0.1.0",
      manifestJson: { id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Routine test", description: "Routine test",
        author: "Paperclip", categories: ["automation"], capabilities: ["routines.managed"], entrypoints: { worker: "./worker.js" } } }).returning();
    await db.insert(pluginManagedResources).values({ companyId: f.companyId, pluginId: plugin.id, pluginKey,
      resourceKind: "routine", resourceKey: "status", resourceId: f.routine.id, defaultsJson: { issueTemplate: { originId } } });
    const run = await dispatch(f), otherRun = await dispatch(other);
    expect((await db.select().from(issues).where(eq(issues.id, run.linkedIssueId!)))[0].originId).toBe(originId);
    await start(); await quiet();
    await issueService(db).update(run.linkedIssueId!, { status: "done" }); await projected(run.id, "completed");
    const before = await saved(run.id);
    await db.transaction(async tx => { await notifyRoutineExecutionStatus(tx, run.linkedIssueId!); await notifyRoutineExecutionStatus(tx, run.linkedIssueId!); });
    await settled(); await quiet();
    expect(await saved(run.id)).toEqual(before); expect((await saved(otherRun.id)).status).toBe("issue_created"); expect(errors).toEqual([]);
  });
  it.each(["changed", "removed"])("keeps historical custom-origin custody after its plugin declaration is %s", async mode => {
    const f = await fixture(), pluginKey = `routine-history-${randomUUID()}`, originId = `operation:${randomUUID()}`;
    const [plugin] = await db.insert(plugins).values({ pluginKey, packageName: pluginKey, version: "0.1.0",
      manifestJson: { id: pluginKey, apiVersion: 1, version: "0.1.0", displayName: "Routine test", description: "Routine test",
        author: "Paperclip", categories: ["automation"], capabilities: ["routines.managed"], entrypoints: { worker: "./worker.js" } } }).returning();
    const [resource] = await db.insert(pluginManagedResources).values({ companyId: f.companyId, pluginId: plugin.id, pluginKey,
      resourceKind: "routine", resourceKey: "history", resourceId: f.routine.id, defaultsJson: { issueTemplate: { originId } } }).returning();
    const run = await dispatch(f);
    expect((await db.select().from(issues).where(eq(issues.id, run.linkedIssueId!)))[0].originId).toBe(originId);
    if (mode === "changed") await db.update(pluginManagedResources).set({ defaultsJson: { issueTemplate: { originId: "new-origin" } } }).where(eq(pluginManagedResources.id, resource.id));
    else await db.delete(pluginManagedResources).where(eq(pluginManagedResources.id, resource.id));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, run.linkedIssueId!));
    await start(); await projected(run.id, "completed"); await quiet(); expect(errors).toEqual([]);
  });
  it("reconstructs more than one page and does not lose a committed issue hint behind the startup cursor", async () => {
    const f = await fixture(), ids = Array.from({ length: 53 }, () => randomUUID()).sort();
    const issueIds = ids.map(() => randomUUID());
    await db.insert(issues).values(ids.map((id, index) => ({ id: issueIds[index], companyId: f.companyId, title: "Legacy execution",
      status: index === 0 ? "todo" : "done", originKind: "routine_execution", originRunId: id, originId: f.routine.id })));
    await db.insert(routineRuns).values(ids.map((id, index) => ({ id, companyId: f.companyId, routineId: f.routine.id,
      source: "schedule", linkedIssueId: issueIds[index], status: "issue_created" })));
    const service = routineExecutionStatusService(db), load = service.load;
    let entered!: () => void, release!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    const loaded = vi.spyOn(service, "load").mockImplementationOnce(async (scope, afterId) => {
      const page = await load(scope, afterId); expect(page).toHaveLength(50); entered(); await releaseGate; return page;
    });
    const starting = start(service); await enteredGate;
    await issueService(db).update(issueIds[0]!, { status: "done" }); release(); await starting;
    await vi.advanceTimersByTimeAsync(3000);
    await vi.waitFor(async () => expect((await db.select().from(routineRuns)).every(row => row.status === "completed")).toBe(true));
    expect(loaded.mock.calls.some(([scope, afterId]) => scope === undefined && afterId !== undefined)).toBe(true);
    expect(loaded.mock.calls.some(([scope]) => scope?.issueId === issueIds[0])).toBe(true);
    await quiet(); expect(errors).toEqual([]);
  });
  it("scopes shared execution writes to their company and settles paused-company projection debt", async () => {
    const f = await fixture(), other = await fixture(), run = await dispatch(f), otherRun = await dispatch(other);
    const service = routineExecutionStatusService(db), load = vi.spyOn(service, "load");
    await start(service); await quiet(); load.mockClear();
    await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, otherRun.linkedIssueId!));
    await writeExecutionControl(db, DELIVERY_QUEUES.executionStatus,
      tx => tx.update(issues).set({ status: "done" }).where(eq(issues.id, run.linkedIssueId!)), { companyId: f.companyId });
    await projected(run.id, "completed");
    expect(load.mock.calls.every(([scope]) => scope?.companyId === f.companyId)).toBe(true);
    expect((await saved(otherRun.id)).status).toBe("issue_created"); await quiet();
    await db.transaction(async tx => { await notifyRoutineExecutionStatus(tx, otherRun.linkedIssueId!); });
    await projected(otherRun.id, "completed"); await quiet(); expect(errors).toEqual([]);
  });
  it("projects subtree cancel and restore without waking agents, then becomes quiet", async () => {
    const f = await fixture(), root = await dispatch(f), child = await dispatch(f);
    await issueService(db).update(child.linkedIssueId!, { parentId: root.linkedIssueId });
    const tree = issueTreeControlService(db), actor = { actorType: "system" as const, actorId: "routine-status-test" };
    await start(); await quiet();
    const cancel = await tree.createHold(f.companyId, root.linkedIssueId!, { mode: "cancel", actor });
    expect((await tree.cancelIssueStatusesForHold(f.companyId, root.linkedIssueId!, cancel.hold.id)).updatedIssueIds.sort())
      .toEqual([root.linkedIssueId, child.linkedIssueId].sort());
    await projected(root.id, "failed"); await projected(child.id, "failed"); await quiet();
    const restore = await tree.createHold(f.companyId, root.linkedIssueId!, { mode: "restore", actor });
    const restored = await tree.restoreIssueStatusesForHold(f.companyId, root.linkedIssueId!, restore.hold.id, { actor });
    expect(restored.updatedIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: root.linkedIssueId, status: "todo" }),
      expect.objectContaining({ id: child.linkedIssueId, status: "todo" }),
    ]));
    await projected(root.id, "issue_created"); await projected(child.id, "issue_created");
    expect(await saved(root.id)).toMatchObject({ completedAt: null, failureReason: null });
    expect(await saved(child.id)).toMatchObject({ completedAt: null, failureReason: null });
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
    await quiet(); expect(errors).toEqual([]);
  });
  it("serializes a direct status hook with later task changes before projecting the routine", async () => {
    const f = await fixture(), run = await dispatch(f); await start(); await quiet();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, run.linkedIssueId!));
    let entered!: () => void, release!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    const holding = db.transaction(async tx => {
      await tx.select().from(routineRuns).where(eq(routineRuns.id, run.id)).for("update");
      entered(); await releaseGate;
    });
    let direct: Promise<unknown> | undefined, changing: Promise<unknown> | undefined;
    let directPid: number | undefined;
    try {
      await enteredGate; direct = f.service.syncRunStatusForIssue(run.linkedIssueId!);
      await vi.waitFor(async () => {
        const rows = await db.execute(sql`select pid from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and (query like 'update "routine_runs"%' or query like 'select %"routine_runs"%')`);
        expect(rows).toHaveLength(1); directPid = Number(rows[0]!.pid);
      }, { timeout: 5000 });
      await expect(db.transaction(tx => tx.select({ id: issues.id }).from(issues)
        .where(eq(issues.id, run.linkedIssueId!)).for("update", { noWait: true })))
        .rejects.toMatchObject({ cause: expect.objectContaining({ code: "55P03" }) });
      changing = issueService(db).update(run.linkedIssueId!, { status: "blocked" });
      await vi.waitFor(async () => {
        const rows = await db.execute(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and ${directPid}::int = any(pg_blocking_pids(pid))`);
        expect(Number(rows[0]?.count)).toBeGreaterThan(0);
      }, { timeout: 5000 });
      release(); await holding; await direct; await changing;
      await projected(run.id, "failed"); await quiet(); expect(errors).toEqual([]);
    } finally { release(); await holding; await direct; await changing; }
  });
  it("waits for the real outer transaction and forgets a rolled-back nested status write", async () => {
    const f = await fixture(), run = await dispatch(f); await start(); await quiet();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const written = new Promise<void>(resolve => { entered = resolve; });
    const writing = db.transaction(async tx => {
      await issueService(db).update(run.linkedIssueId!, { status: "done" }, tx);
      entered(); await gate;
    });
    try { await written; expect((await saved(run.id)).status).toBe("issue_created"); }
    finally { release(); await writing; }
    await projected(run.id, "completed"); await quiet();
    const other = await dispatch(f);
    await expect(db.transaction(async tx => {
      await issueService(db).update(other.linkedIssueId!, { status: "cancelled" }, tx);
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    await settled(); expect((await saved(other.id)).status).toBe("issue_created"); await quiet(); expect(errors).toEqual([]);
  });
  it("keeps the first write during drain and reconstructs on resume without passive SQL", async () => {
    const f = await fixture(), run = await dispatch(f); await start(); await quiet();
    draining = true;
    await issueService(db).update(run.linkedIssueId!, { status: "cancelled" });
    await settled(); await quiet(); expect((await saved(run.id)).status).toBe("issue_created");
    draining = false; await vi.advanceTimersByTimeAsync(30_000); await projected(run.id, "failed");
    await quiet(); expect(errors).toEqual([]);
  });
  it.each(["standby", "disabled"])("does no owner SQL while %s and reconstructs when enabled", async mode => {
    const f = await fixture(), run = await dispatch(f);
    await issueService(db).update(run.linkedIssueId!, { status: "done" });
    if (mode === "standby") standby = true; else enabled = false;
    await start(); await quiet(); expect((await saved(run.id)).status).toBe("issue_created");
    standby = false; enabled = true; await vi.advanceTimersByTimeAsync(30_000);
    await projected(run.id, "completed"); await quiet(); expect(errors).toEqual([]);
  });
  it("retries failed exact owners, retains the retry across drain and reconstructs after restart", async () => {
    const f = await fixture(), run = await dispatch(f), service = routineExecutionStatusService(db);
    const settle = vi.spyOn(service, "settle").mockRejectedValueOnce(new Error("projection unavailable"));
    await start(service);
    await issueService(db).update(run.linkedIssueId!, { status: "done" });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect((await saved(run.id)).status).toBe("issue_created");
    await vi.advanceTimersByTimeAsync(29_000); expect(settle).toHaveBeenCalledTimes(1);
    draining = true; await vi.advanceTimersByTimeAsync(60_000); await quiet();
    draining = false; await vi.advanceTimersByTimeAsync(30_000); await projected(run.id, "completed"); await quiet();
    await coordinator!.stop(); coordinator = undefined;
    const other = await dispatch(f); await issueService(db).update(other.linkedIssueId!, { status: "blocked" });
    await start(); await projected(other.id, "failed"); await quiet();
  });
  it("preserves notifications during a sweep, coalesces duplicate hints and never overlaps", async () => {
    const f = await fixture(), first = await dispatch(f), second = await dispatch(f), service = routineExecutionStatusService(db);
    let entered!: () => void, release!: () => void;
    const enteredGate = new Promise<void>(resolve => { entered = resolve; });
    const releaseGate = new Promise<void>(resolve => { release = resolve; });
    const load = service.load;
    vi.spyOn(service, "load").mockImplementationOnce(async issueId => { const rows = await load(issueId); entered(); await releaseGate; return rows; });
    const starting = start(service); await enteredGate;
    await issueService(db).update(second.linkedIssueId!, { status: "done" });
    await db.transaction(async tx => { await notifyRoutineExecutionStatus(tx, second.linkedIssueId!); await notifyRoutineExecutionStatus(tx, second.linkedIssueId!); });
    release(); await starting;
    await projected(second.id, "completed"); expect((await saved(first.id)).status).toBe("issue_created");
    await quiet(); expect(errors).toEqual([]);
  });
  it.each(["succeeded", "failed", "cancelled", "interrupted", "timed_out"])("uses real %s run lifecycle changes for activeIssue without an open-issue retry", async status => {
    const f = await fixture(), run = await dispatch(f); await start();
    const [execution] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", contextSnapshot: { issueId: run.linkedIssueId } }).returning();
    await db.update(issues).set({ executionRunId: execution.id }).where(eq(issues.id, run.linkedIssueId!));
    expect((await f.service.getDetail(f.routine.id))?.activeIssue?.id).toBe(run.linkedIssueId);
    const deps = {
      ...createHeartbeatRunState(db), ...createHeartbeatRunPreparation(db),
      issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
      recovery: { escalateStrandedAssignedIssue: vi.fn() }, companySkills: { completeTestRunForIssue: vi.fn() },
      budgets: { getInvocationBlock: vi.fn(async () => null) }, treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
      enqueueWakeup: vi.fn(), getCurrentUserRedactionOptions: vi.fn(async () => ({})),
      getAgentInvokability: vi.fn(async () => ({ invokable: true })), emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
    } satisfies HeartbeatLifecycleDependencies;
    await createHeartbeatLifecycle(db, deps).setRunStatusIfRunning(execution.id, status, { finishedAt: new Date() });
    expect((await f.service.getDetail(f.routine.id))?.activeIssue).toBeNull();
    expect((await saved(run.id)).status).toBe("issue_created"); await quiet(); expect(errors).toEqual([]);
  });
});
