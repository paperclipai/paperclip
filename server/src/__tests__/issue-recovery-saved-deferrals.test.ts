import { setImmediate as immediate } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { agents, issueRecoveryDeferrals, issues } from "@paperclipai/db";
import { reconcileDatabaseWorkNotifications } from "@paperclipai/db/work-signals";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyIssueRecovery } from "../services/issue-recovery-notifications.js";
import { registerIssueRecoveryWork } from "../services/recovery/work.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TEST_TIMEOUT_MS = 120_000;
const STEP_TIMEOUT_MS = 20_000;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function bounded<T>(work: Promise<T>, waitingFor: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`Timed out after ${STEP_TIMEOUT_MS} ms waiting for ${waitingFor()}`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([work, expired]).finally(() => realClearTimeout(timer));
}

/** The task recovery queues against the real test database, with the task
 * checks replaced by a recorder, so a deferral and a server replacement can be
 * placed exactly. No agent run can start: nothing but the recorder runs. */
describeIssueRecovery("saved task recovery passes and deferrals", () => {
  const state = issueRecoveryFixture();
  const passes = new Set<Promise<unknown>>();
  // Every server a test starts stops after it, even when an assertion failed,
  // so no worker stays subscribed while the next test reuses the database.
  const running = new Set<ReturnType<typeof createDeliveryWorkCoordinator>>();
  afterEach(async () => {
    for (const coordinator of [...running]) await bounded(coordinator.stop(), () => "a test server to stop");
    running.clear(); passes.clear();
  });

  async function seed(count: number) {
    const f = await state.fixture();
    const old = new Date(Date.now() - 2 * HOUR);
    const [agent] = await state.db.insert(agents).values({ companyId: f.companyId, name: "Reviewer", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "0"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false } }, createdAt: old, updatedAt: old, lastHeartbeatAt: old,
    }).returning({ id: agents.id });
    const rows = await state.db.insert(issues).values(Array.from({ length: count }, (_, index) => ({ companyId: f.companyId,
      title: `Review ${index}`, status: "in_review", assigneeAgentId: agent!.id, createdAt: old, updatedAt: old })))
      .returning({ id: issues.id });
    return { ...f, tasks: rows.map(row => row.id) };
  }

  /** One server: a coordinator and the recovery queues, with recorded checks. */
  async function server(behavior: { deferUntil: Map<string, number>; suppressed: () => boolean; checks: Array<{ id: string; at: number }>;
    rolling?: Set<string> }) {
    const coordinator = createDeliveryWorkCoordinator({ owner: state.db, canRun: () => true, canReconcile: () => true,
      onError: error => { throw error; } });
    running.add(coordinator);
    const register = coordinator.register.bind(coordinator);
    coordinator.register = (queue, task) => register(queue, { ...task, run: signal => {
      const work = task.run(signal); passes.add(work);
      void work.then(() => passes.delete(work), () => passes.delete(work));
      return work;
    } });
    const stranded = async (scope: { issueId: string; onDeferredDeadline(at: number): void }) => {
      behavior.checks.push({ id: scope.issueId, at: Date.now() });
      const until = behavior.deferUntil.get(scope.issueId);
      if (until !== undefined && until > Date.now()) scope.onDeferredDeadline(until);
      if (behavior.rolling?.has(scope.issueId)) scope.onDeferredDeadline(Date.now() + 30_000);
    };
    const work = registerIssueRecoveryWork(state.db, coordinator, {
      stranded, orphanBlockers: async () => {}, recoveryActions: async () => {},
      dependencies: async () => ({ enqueueFailed: 0 }), locks: async () => {}, watchdogs: async () => ({ incomplete: 0 }),
      schedulingSuppressed: async () => behavior.suppressed(),
    }, () => true);
    await bounded(work.ready, () => "the recovery queues to start");
    return { stop: async () => { running.delete(coordinator); await coordinator.stop(); } };
  }

  async function advance(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const at = new Date(Date.now()).toISOString();
      await bounded(vi.advanceTimersByTimeAsync(Math.min(1000, until - Date.now())), () => `simulated time to advance past ${at}`);
      await bounded(Promise.allSettled([...passes]), () => `${passes.size} delivery passes started by simulated ${at} to settle`);
      await immediate();
    }
  }

  it("checks a deferred task at its deadline after the server that deferred it is replaced", async () => {
    const f = await bounded(seed(30), () => "the fixture to be seeded");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const target = f.tasks[7]!;
    const deadline = Date.now() + 20 * MINUTE;
    const behavior = { deferUntil: new Map([[target, deadline]]), suppressed: () => false, checks: [] as Array<{ id: string; at: number }> };
    // The first server checks every task (no saved pass yet); the target defers itself 20 minutes.
    const first = await server(behavior);
    await advance(MINUTE);
    expect(behavior.checks.filter(check => check.id === target)).toHaveLength(1);
    await advance(4 * MINUTE);
    // The server is replaced without shutdown work; its successor has no memory of the deadline.
    await bounded(first.stop(), () => "the first server to stop");
    await server(behavior);
    reconcileDatabaseWorkNotifications(state.db);
    await advance(deadline - Date.now() + MINUTE);
    const atDeadline = behavior.checks.filter(check => check.id === target && check.at >= deadline);
    expect(atDeadline[0], "the replacement did not check the deferred task at its deadline").toBeDefined();
    expect(atDeadline[0]!.at - deadline).toBeLessThanOrEqual(MINUTE);
  }, TEST_TIMEOUT_MS);

  it("keeps a deferral another server rewrote while this server clears the one it saw", async () => {
    const f = await bounded(seed(10), () => "the fixture to be seeded");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const target = f.tasks[4]!;
    const checks: Array<{ id: string; at: number }> = [];
    const first = Date.now() + 30 * MINUTE;
    const b = { deferUntil: new Map([[target, first]]), suppressed: () => false, checks };
    const a = { deferUntil: new Map([[target, first]]), suppressed: () => false, checks };
    const hint = () => bounded(state.db.transaction(tx => notifyIssueRecovery(tx, { companyId: f.companyId, issueId: target })),
      () => "the task hint to commit");
    // Server B saves the first deadline; server A boots while it overlaps and reads that row.
    const serverB = await server(b);
    await advance(MINUTE);
    await server(a);
    reconcileDatabaseWorkNotifications(state.db);
    await advance(MINUTE);
    // B's check stops deferring and clears the row, then defers again to a new deadline.
    b.deferUntil.delete(target);
    await hint(); await advance(MINUTE);
    const second = Date.now() + 15 * MINUTE;
    b.deferUntil.set(target, second);
    await hint(); await advance(MINUTE);
    // A's check stops deferring and clears the row it read; B's new row must stay.
    a.deferUntil.delete(target);
    await hint(); await advance(MINUTE);
    // B is replaced without shutdown work; its successor keeps B's deadline.
    await bounded(serverB.stop(), () => "server B to stop");
    await server({ deferUntil: new Map([[target, second]]), suppressed: () => false, checks });
    reconcileDatabaseWorkNotifications(state.db);
    const replacedAt = Date.now();
    await advance(second - Date.now() + MINUTE);
    const atDeadline = checks.filter(check => check.id === target && check.at >= second && check.at > replacedAt);
    expect(atDeadline[0], "the successor did not check the task at the deadline server B saved").toBeDefined();
    expect(atDeadline[0]!.at - second).toBeLessThanOrEqual(MINUTE);
  }, TEST_TIMEOUT_MS);

  it("removes a saved deferral once its task has left the queue", async () => {
    const f = await bounded(seed(10), () => "the fixture to be seeded");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const target = f.tasks[3]!;
    const behavior = { deferUntil: new Map([[target, Date.now() + HOUR]]), suppressed: () => false, checks: [] as Array<{ id: string; at: number }> };
    const first = await server(behavior);
    await advance(MINUTE);
    const saved = () => state.db.select({ id: issueRecoveryDeferrals.issueId }).from(issueRecoveryDeferrals)
      .where(and(eq(issueRecoveryDeferrals.queue, "stranded-assignments"), eq(issueRecoveryDeferrals.issueId, target)));
    expect(await bounded(saved(), () => "the deferral to be read")).toHaveLength(1);
    // The task closes while its deferral is pending; no queue loads it again.
    await bounded(state.db.update(issues).set({ status: "done" }).where(eq(issues.id, target)).then(() => undefined), () => "the task to close");
    await bounded(first.stop(), () => "the first server to stop");
    await server(behavior);
    await advance(MINUTE);
    expect(await bounded(saved(), () => "the deferral to be read")).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it("removes a saved deferral once its open task has left the queue and its deadline is past", async () => {
    const f = await bounded(seed(10), () => "the fixture to be seeded");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const target = f.tasks[5]!;
    const behavior = { deferUntil: new Map([[target, Date.now() + 2 * MINUTE]]), suppressed: () => false, checks: [] as Array<{ id: string; at: number }> };
    const first = await server(behavior);
    await advance(MINUTE);
    const saved = () => state.db.select({ id: issueRecoveryDeferrals.issueId }).from(issueRecoveryDeferrals)
      .where(and(eq(issueRecoveryDeferrals.queue, "stranded-assignments"), eq(issueRecoveryDeferrals.issueId, target)));
    expect(await bounded(saved(), () => "the deferral to be read")).toHaveLength(1);
    // The task stays open but leaves the queue (a user takes it over) while its deferral is pending.
    await bounded(state.db.update(issues).set({ status: "in_progress", assigneeUserId: "recovery-user" }).where(eq(issues.id, target))
      .then(() => undefined), () => "the task to leave the queue");
    await bounded(first.stop(), () => "the first server to stop");
    await advance(15 * MINUTE);
    await server(behavior);
    await advance(MINUTE);
    expect(await bounded(saved(), () => "the deferral to be read")).toHaveLength(0);
  }, TEST_TIMEOUT_MS);

  it("writes a task's deferral a few times, not on every check, while it defers every 30 seconds", async () => {
    const f = await bounded(seed(10), () => "the fixture to be seeded");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const target = f.tasks[2]!;
    const behavior = { deferUntil: new Map<string, number>(), rolling: new Set([target]), suppressed: () => false,
      checks: [] as Array<{ id: string; at: number }> };
    const statements: string[] = [];
    const priorDebug = state.db.$client.options.debug;
    state.db.$client.options.debug = (_connection, query) => { statements.push(query); };
    try {
      await server(behavior);
      await advance(20 * MINUTE);
    } finally { state.db.$client.options.debug = priorDebug; }
    const checks = behavior.checks.filter(check => check.id === target).length;
    const writes = statements.filter(query => /insert into issue_recovery_deferrals/i.test(query)).length;
    // The saved deadline still moves forward, so the row of a task that keeps
    // deferring never looks stale to the prune (10 minutes past its deadline).
    const [row] = await bounded(state.db.select({ dueAt: issueRecoveryDeferrals.dueAt }).from(issueRecoveryDeferrals)
      .where(and(eq(issueRecoveryDeferrals.queue, "stranded-assignments"), eq(issueRecoveryDeferrals.issueId, target))),
      () => "the deferral to be read");
    const savedBehind = row ? Date.now() - row.dueAt.getTime() : null;
    console.info(`rolling-deferral census: ${JSON.stringify({ minutes: 20, checks, deferralWrites: writes, savedBehindMs: savedBehind })}`);
    expect(checks).toBeGreaterThanOrEqual(30);
    expect(writes).toBeLessThanOrEqual(5);
    expect(writes).toBeGreaterThan(1);
    expect(savedBehind, "the saved deferral was not kept").not.toBeNull();
    expect(savedBehind!).toBeLessThan(6 * MINUTE);
  }, TEST_TIMEOUT_MS);

  it("checks every task again after scheduling suppression, even with a recent saved full pass", async () => {
    const f = await bounded(seed(30), () => "the fixture to be seeded");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    let suppressed = false;
    const behavior = { deferUntil: new Map<string, number>(), suppressed: () => suppressed, checks: [] as Array<{ id: string; at: number }> };
    await server(behavior);
    await advance(MINUTE);
    expect(new Set(behavior.checks.map(check => check.id)).size).toBe(f.tasks.length);
    // While suppressed, a pass drops the queue's entries.
    suppressed = true;
    await bounded(state.db.transaction(tx => notifyIssueRecovery(tx, { companyId: f.companyId })), () => "the company hint to commit");
    await advance(MINUTE);
    suppressed = false;
    const liftedAt = Date.now();
    // A plain company hint would load only changed rows; after suppression it loads every task.
    await bounded(state.db.transaction(tx => notifyIssueRecovery(tx, { companyId: f.companyId })), () => "the company hint to commit");
    await advance(2 * MINUTE);
    const checkedAfter = new Set(behavior.checks.filter(check => check.at >= liftedAt).map(check => check.id));
    expect(f.tasks.filter(id => !checkedAfter.has(id))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
