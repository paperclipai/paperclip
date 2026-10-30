import { idleWorkSnapshot } from "../services/task-admission.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues, issueWatchdogs } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ISSUE_RECOVERY_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("issue recovery production producers and deadlines", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  let worker: ReturnType<ReturnType<typeof heartbeatService>["registerIssueStateRecoveryWork"]>;
  let dispatch: ReturnType<ReturnType<typeof heartbeatService>["registerRunDispatchWork"]>;
  let cancellation: ReturnType<ReturnType<typeof heartbeatService>["registerScheduledRetryCancellationWork"]>;
  let draining = false;
  const tasks = new Map<string, { nextRunAt?: () => number | null; hasPending: () => Promise<boolean> }>();
  const errors: unknown[] = [];
  const extraStops: Array<() => Promise<void>> = [];
  const extraDeadlines: Array<() => number | null> = [];
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("issue-recovery-work-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
  }, 90_000);
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
    heartbeat = heartbeatService(db); draining = false; errors.length = 0;
  });
  afterEach(async () => {
    for (const stop of extraStops.splice(0)) await stop();
    extraDeadlines.length = 0;
    await worker?.stop(); await dispatch?.stop(); await cancellation?.stop(); await coordinator?.stop();
    await heartbeat.drainActiveRunExecutions();
    vi.useRealTimers(); vi.restoreAllMocks();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true,
      onError: error => errors.push(error) });
    tasks.clear();
    const register = coordinator.register.bind(coordinator);
    coordinator.register = (queue, task) => { tasks.set(queue, task); return register(queue, task); };
    worker = heartbeat.registerIssueStateRecoveryWork(coordinator, () => !draining);
    dispatch = heartbeat.registerRunDispatchWork(coordinator, () => !draining);
    cancellation = heartbeat.registerScheduledRetryCancellationWork(coordinator, () => !draining);
    await Promise.all([worker.ready, dispatch.ready, cancellation.ready]);
  }
  async function compete() {
    const other = heartbeatService(db);
    const competing = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const work = other.registerIssueStateRecoveryWork(competing, () => true);
    extraStops.push(() => competing.stop()); extraDeadlines.push(competing.nextWakeAt); await work.ready;
  }
  async function fixture() {
    const companyId = randomUUID();
    await db.insert(authUsers).values({ id: "recovery-user", name: "Recovery operator", email: "recovery-user@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: `R${companyId.slice(0, 7)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "recovery-user" });
    await db.insert(companyMemberships).values({ companyId, principalId: "recovery-user", principalType: "user", status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Recovery process", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "console.log('recovery-proof')"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } },
    }).returning();
    return { companyId, agentId: agent.id };
  }
  async function settled() {
    await vi.waitFor(async () => {
      await heartbeat.drainActiveRunExecutions();
      const wake = coordinator.nextWakeAt();
      const detail = wake === null ? "" : JSON.stringify({ now: Date.now(), tasks: await Promise.all([...tasks].map(async ([queue, task]) => ({ queue, at: task.nextRunAt?.(), pending: await task.hasPending() }))),
        runs: (await db.select().from(heartbeatRuns)).map(run => ({ id: run.id, status: run.status, error: run.errorCode, lease: run.controllerLeaseExpiresAt, reason: run.contextSnapshot?.wakeReason })) });
      expect(wake, detail).toBeNull();
      expect(extraDeadlines.map(next => next())).toEqual(extraDeadlines.map(() => null));
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 10_000 });
  }
  async function quiet() {
    await settled();
    const reads = vi.spyOn(db, "select"); const executes = vi.spyOn(db, "execute");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try { await vi.advanceTimersByTimeAsync(20 * 60_000); expect(reads).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled(); }
    finally { vi.useRealTimers(); reads.mockRestore(); executes.mockRestore(); }
  }
  async function finish(issueId: string) {
    await issueService(db).update(issueId, { status: "done" });
    await heartbeat.drainActiveRunExecutions();
    const saved = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.status, "scheduled_retry"),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`));
    if (saved.length > 0) {
      const due = Math.max(...saved.map(run => run.scheduledRetryAt!.getTime()));
      expect(await db.select().from(heartbeatRuns).where(and(
        sql`${heartbeatRuns.status} in ('queued', 'running')`,
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`))).toHaveLength(0);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      await vi.advanceTimersByTimeAsync(Math.max(0, due - Date.now()) + 1);
      await vi.waitFor(async () => {
        const remaining = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.status, "scheduled_retry"),
            sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`));
        expect(remaining).toHaveLength(0);
      });
      for (const retry of saved) {
        const [settledRetry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id));
        expect(settledRetry.status).toBe("cancelled");
      }
    }
  }
  async function completed(issueId: string) {
    let runId: string | undefined;
    await vi.waitFor(async () => {
      const runs = await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`);
      const run = runs.find(row => row.status === "running" || row.status === "succeeded");
      expect(run).toBeDefined(); runId = run!.id;
    }, { timeout: 15_000 });
    await heartbeat.drainActiveRunExecutions();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
    expect(run.status, JSON.stringify({ error: run.error, code: run.errorCode, stderr: run.stderrExcerpt, result: run.resultJson })).toBe("succeeded"); expect(run.stdoutExcerpt).toContain("recovery-proof");
    return run;
  }
  it("keeps empty, configured idle, and terminal history quiet", async () => {
    await fixture(); await start(); await quiet();
  });
  it("dispatches an ordinary new assignment after commit and returns to quiet after completion", async () => {
    const f = await fixture(); await start(); await quiet();
    const issue = await issueService(db).create(f.companyId, { title: "Recover assignment", status: "todo", assigneeAgentId: f.agentId });
    await completed(issue.id);
    await finish(issue.id); await quiet();
  }, 45_000);
  it("reacts to blocker resolution once and dispatches the durable dependency wake", async () => {
    const f = await fixture();
    const blocker = await issueService(db).create(f.companyId, { title: "Blocker", status: "todo" });
    const dependent = await issueService(db).create(f.companyId, { title: "Dependent", status: "blocked", assigneeAgentId: f.agentId,
      blockedByIssueIds: [blocker.id] });
    await start(); await quiet();
    await compete();
    await issueService(db).update(blocker.id, { status: "done" });
    const run = await completed(dependent.id);
    expect(run.contextSnapshot?.wakeReason).toBe("issue_blockers_resolved");
    await finish(dependent.id); await quiet();
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'issue_blockers_resolved'`))).toHaveLength(1);
  }, 45_000);
  it("uses ordinary watchdog configuration and subtree closure to dispatch a reusable review", async () => {
    const f = await fixture();
    const source = await issueService(db).create(f.companyId, { title: "Finished subtree", status: "done" });
    await start(); await quiet();
    await compete();
    const watchdog = await taskWatchdogService(db).upsertForIssue(f.companyId, source.id, { agentId: f.agentId });
    let reviewId: string | undefined;
    await vi.waitFor(async () => {
      const [row] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, watchdog.watchdog.id));
      expect(row.watchdogIssueId).toBeTruthy(); reviewId = row.watchdogIssueId!;
    }, { timeout: 15_000 });
    await completed(reviewId!);
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'task_watchdog_stopped_subtree'`))).toHaveLength(1);
    await finish(reviewId!);
    await taskWatchdogService(db).disableForIssue(f.companyId, source.id); await quiet();
  }, 45_000);
  it("bounds ordinary writes to their company and reconstructs foreign stale debt after restart", async () => {
    const selected = await fixture(); await start(); await quiet();
    const foreign = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: foreign.companyId, agentId: foreign.agentId,
      status: "failed", finishedAt: new Date() }).returning();
    const [stale] = await db.insert(issues).values({ companyId: foreign.companyId, title: "Foreign stale lock", status: "done",
      checkoutRunId: run.id }).returning();
    await issueService(db).create(selected.companyId, { title: "Selected change", status: "done" }); await quiet();
    expect((await db.select().from(issues).where(eq(issues.id, stale.id)))[0].checkoutRunId).toBe(run.id);
    await worker.stop(); await dispatch.stop(); await cancellation.stop(); await coordinator.stop();
    heartbeat = heartbeatService(db); await start(); await quiet();
    expect((await db.select().from(issues).where(eq(issues.id, stale.id)))[0].checkoutRunId).toBeNull();
  });
  it("fences nested assignment writes until outer commit and ignores rollback", async () => {
    const f = await fixture(); await start(); await quiet();
    let committedId = "";
    await db.transaction(async outer => {
      await outer.transaction(async nested => {
        const issue = await issueService(db).create(f.companyId, { title: "Nested commit", status: "todo", assigneeAgentId: f.agentId }, nested);
        committedId = issue.id;
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    });
    await completed(committedId); await finish(committedId); await settled();
    await expect(db.transaction(async outer => {
      await outer.transaction(async nested => {
        await issueService(db).create(f.companyId, { title: "Nested rollback", status: "todo", assigneeAgentId: f.agentId }, nested);
      });
      throw new Error("rollback control");
    })).rejects.toThrow("rollback control");
    await quiet();
    expect(await db.select().from(issues).where(eq(issues.title, "Nested rollback"))).toHaveLength(0);
  }, 60_000);
  it("retains the first committed assignment during drain and executes on resume", async () => {
    const f = await fixture(); await start(); await quiet(); draining = true;
    const issue = await issueService(db).create(f.companyId, { title: "Drained assignment", status: "todo", assigneeAgentId: f.agentId });
    await new Promise(resolve => setTimeout(resolve, 100));
    const reads = vi.spyOn(db, "select");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try { await vi.advanceTimersByTimeAsync(90_000); expect(reads).not.toHaveBeenCalled(); }
    finally { vi.useRealTimers(); reads.mockRestore(); }
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    draining = false; worker.wake(); dispatch.wake();
    await completed(issue.id); await finish(issue.id); await quiet();
  }, 45_000);
  it("retains a fresh subtree's exact first-run grace then disarms on disable", async () => {
    const f = await fixture();
    const source = await issueService(db).create(f.companyId, { title: "Fresh unassigned subtree", status: "todo" });
    await start(); await quiet();
    await taskWatchdogService(db).upsertForIssue(f.companyId, source.id, { agentId: f.agentId });
    await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBe(source.createdAt.getTime() + 15_000), { timeout: 5_000 });
    expect(await db.select().from(issues).where(eq(issues.originKind, "task_watchdog"))).toHaveLength(0);
    await taskWatchdogService(db).disableForIssue(f.companyId, source.id); await quiet();
  });
  it("waits for a live foreign controller's exact stored lease before clearing a terminal lock", async () => {
    const f = await fixture();
    const source = await issueService(db).create(f.companyId, { title: "Remote owner", status: "done" });
    const lease = new Date(Date.now() + 5_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: lease,
      contextSnapshot: { issueId: source.id }, processPid: 2_000_000_000, startedAt: new Date() }).returning();
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, source.id));
    await start();
    await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBe(lease.getTime()), { timeout: 3_000 });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("running");
    await vi.waitFor(async () => expect((await db.select().from(issues).where(eq(issues.id, source.id)))[0].executionRunId).toBeNull(), { timeout: 12_000 });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("succeeded"); await quiet();
  }, 30_000);
});
