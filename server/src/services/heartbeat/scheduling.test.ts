import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  agents, agentSessionGoalActions, agentTaskSessions, companies, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { conflict } from "../../errors.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatScheduling, type HeartbeatSchedulingDependencies } from "./scheduling.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));

type Run = typeof heartbeatRuns.$inferSelect;
const now = new Date("2026-10-09T12:00:00.000Z");
const dueAt = new Date(now.getTime() - 60_000);
const admitted = { id: "admitted-run" } as Run;
const timerPolicy = {
  enabled: false, intervalSec: 60, wakeOnDemand: true, maxConcurrentRuns: 1,
  skipTimerWhenNoActionableWork: false, maxDailyRuns: null, maxDailyCostCents: null,
};

function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  const preparation = createHeartbeatRunPreparation(db);
  return {
    getAgent: state.getAgent,
    getRun: state.getRun,
    toAgentOrgRow: preparation.toAgentOrgRow,
    groupAgentOrgRowsByCompany: preparation.groupAgentOrgRowsByCompany,
    issuesSvc: {
      listReviewAttention: vi.fn<HeartbeatSchedulingDependencies["issuesSvc"]["listReviewAttention"]>(async () => new Map()),
      create: vi.fn<HeartbeatSchedulingDependencies["issuesSvc"]["create"]>(),
    },
    enqueueWakeup: vi.fn<HeartbeatSchedulingDependencies["enqueueWakeup"]>(async () => admitted),
    scheduleBoundedRetryForRun: vi.fn<HeartbeatSchedulingDependencies["scheduleBoundedRetryForRun"]>(),
    getSchedulingSuppression: vi.fn(async () => ({ suppressed: false })),
    getWorktreeExecutionCutoff: vi.fn<HeartbeatSchedulingDependencies["getWorktreeExecutionCutoff"]>(async () => null),
    parseHeartbeatPolicy: vi.fn<HeartbeatSchedulingDependencies["parseHeartbeatPolicy"]>(() => timerPolicy),
    claimDueTimerHeartbeat: vi.fn<HeartbeatSchedulingDependencies["claimDueTimerHeartbeat"]>(async () => ({ wasFirstHeartbeat: true })),
  } satisfies HeartbeatSchedulingDependencies;
}

describe("heartbeat scheduling module boundary", () => {
  function guardedDatabase() {
    const access = vi.fn(() => { throw new Error("Unexpected scheduling database access"); });
    return { db: new Proxy({}, { get: access }) as Db, access };
  }

  it("constructs without querying, admitting work, or starting timers", () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    createHeartbeatScheduling(database.db, deps);
    expect(database.access).not.toHaveBeenCalled();
    for (const callback of Object.values(deps)) if (vi.isMockFunction(callback)) expect(callback).not.toHaveBeenCalled();
  });

  it.each(["tickTimers", "recoverActiveSessionGoals", "recoverPendingSessionGoalActions"] as const)(
    "honors suppression before %s reads or admits work", async (operation) => {
      const database = guardedDatabase();
      const deps = callbacks(database.db);
      deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true });
      const result = await createHeartbeatScheduling(database.db, deps)[operation]();
      expect(Object.values(result).every(value => value === 0)).toBe(true);
      expect(database.access).not.toHaveBeenCalled();
      expect(deps.enqueueWakeup).not.toHaveBeenCalled();
      expect(deps.claimDueTimerHeartbeat).not.toHaveBeenCalled();
    },
  );
});

const postgres = await getEmbeddedPostgresTestSupport();
describe.skipIf(!postgres.supported)("heartbeat scheduling database boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-scheduling-module");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Scheduling", issuePrefix: "SCH" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Scheduled agent", adapterType: "paperclip_runner", createdAt: dueAt }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company.id, title: "Check deployment", status: "in_progress", assigneeAgentId: agent.id,
      monitorNextCheckAt: dueAt, monitorAttemptCount: 0, createdAt: dueAt,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor: { nextCheckAt: dueAt.toISOString() } },
    }).returning();
    const deps = callbacks(db);
    return { company, agent, issue, deps, scheduler: createHeartbeatScheduling(db, deps) };
  }
  async function readIssue(id: string) {
    return db.select().from(issues).where(eq(issues.id, id)).then(rows => rows[0]!);
  }
  async function session(f: Awaited<ReturnType<typeof fixture>>, patch: Partial<typeof agentTaskSessions.$inferInsert> = {}) {
    return db.insert(agentTaskSessions).values({
      companyId: f.company.id, agentId: f.agent.id, adapterType: f.agent.adapterType, taskKey: f.issue.id,
      goalDesiredState: "active", goalStatus: "active", goalRevision: 7, ...patch,
    }).returning().then(rows => rows[0]!);
  }
  function enableTimer(deps: ReturnType<typeof callbacks>) {
    deps.parseHeartbeatPolicy.mockReturnValue({ ...timerPolicy, enabled: true });
    deps.parseHeartbeatPolicy.mockClear();
  }

  it("shares database monitor claims across scheduler instances", async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    f.deps.enqueueWakeup.mockImplementationOnce(async () => { entered(); await hold; return admitted; });
    const first = f.scheduler.tickTimers(now);
    try {
      await started;
      const second = createHeartbeatScheduling(db, f.deps);
      expect(await second.tickTimers(now)).toEqual({ checked: 0, enqueued: 0, skipped: 0 });
      await expect(second.triggerIssueMonitor(f.issue.id, { now })).rejects.toThrow("already in progress");
    } finally {
      release();
      await first;
    }
    expect(f.deps.enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: null, monitorAttemptCount: 1 });
  });

  it("preserves a replacement schedule written during wake admission", async () => {
    const f = await fixture();
    const replacement = new Date(now.getTime() + 60_000);
    f.deps.enqueueWakeup.mockImplementationOnce(async () => {
      await db.update(issues).set({ monitorNextCheckAt: replacement, monitorWakeRequestedAt: null }).where(eq(issues.id, f.issue.id));
      return admitted;
    });
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 1, enqueued: 0, skipped: 1 });
    expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: replacement, monitorAttemptCount: 0 });
  });

  it("retains a deferred monitor and releases its claim for a later tick", async () => {
    const f = await fixture();
    f.deps.enqueueWakeup.mockResolvedValueOnce(null);
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 1, enqueued: 0, skipped: 1 });
    expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: dueAt, monitorWakeRequestedAt: null, monitorAttemptCount: 0 });
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
    const calls = f.deps.enqueueWakeup.mock.calls;
    expect(calls[0]![1]!.idempotencyKey).toBe(calls[1]![1]!.idempotencyKey);
    expect(calls[0]![1]!.issueStateGuard).toMatchObject({
      assigneeAgentId: f.agent.id, statuses: ["in_progress"], monitorNextCheckAt: dueAt.toISOString(), monitorWakeRequestedAt: now.toISOString(),
    });
  });

  it("keeps manual error recovery distinct from scheduled client-error handling", async () => {
    const f = await fixture();
    f.deps.enqueueWakeup.mockRejectedValue(conflict("Agent is paused"));
    await expect(f.scheduler.triggerIssueMonitor(f.issue.id, { now, actorType: "user", actorId: "board-user" })).rejects.toThrow("Agent is paused");
    expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: dueAt, monitorWakeRequestedAt: null });
    expect(f.deps.enqueueWakeup).toHaveBeenLastCalledWith(f.agent.id, expect.objectContaining({
      source: "on_demand", requestedByActorType: "user", requestedByActorId: "board-user",
    }));
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 1, enqueued: 0, skipped: 1 });
    expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: null });
  });

  it("retains monitors after transient admission failures", async () => {
    const f = await fixture();
    f.deps.enqueueWakeup.mockRejectedValueOnce(new Error("Temporary admission failure"));
    await f.scheduler.tickTimers(now);
    expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: dueAt, monitorWakeRequestedAt: null });
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
  });

  it("leaves monitors alone while a native run owns the issue", async () => {
    const f = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, nativeIssueId: f.issue.id, runtimeMode: "native", status: "running", contextSnapshot: { issueId: f.issue.id } }).returning();
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 0, enqueued: 0, skipped: 0 });
    expect(f.deps.enqueueWakeup).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run!.id));
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
  });

  it("skips archived companies for both timers and monitors", async () => {
    const f = await fixture();
    enableTimer(f.deps);
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, f.company.id));
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 0, enqueued: 0, skipped: 0 });
    expect(f.deps.claimDueTimerHeartbeat).not.toHaveBeenCalled();
    expect(f.deps.enqueueWakeup).not.toHaveBeenCalled();
    expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: dueAt });
  });

  it("combines timer and monitor counts and passes the timer claim receipt to admission", async () => {
    const f = await fixture();
    enableTimer(f.deps);
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 2, enqueued: 2, skipped: 0 });
    expect(f.deps.claimDueTimerHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ id: f.agent.id }), now, 60);
    expect(f.deps.enqueueWakeup).toHaveBeenCalledWith(f.agent.id, expect.objectContaining({
      source: "timer", reason: "heartbeat_timer", contextSnapshot: expect.objectContaining({ timerClaimWasFirstHeartbeat: true }),
    }));
  });

  it("does not enqueue a timer after losing its due claim", async () => {
    const f = await fixture();
    enableTimer(f.deps);
    await db.update(issues).set({ monitorNextCheckAt: null }).where(eq(issues.id, f.issue.id));
    f.deps.claimDueTimerHeartbeat.mockResolvedValue(null);
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 1, enqueued: 0, skipped: 0 });
    expect(f.deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it("enforces worktree cutoffs and agent invokability before timer claims", async () => {
    const f = await fixture();
    enableTimer(f.deps);
    await db.update(issues).set({ monitorNextCheckAt: null }).where(eq(issues.id, f.issue.id));
    f.deps.getWorktreeExecutionCutoff.mockResolvedValue(now);
    await f.scheduler.tickTimers(now);
    expect(f.deps.claimDueTimerHeartbeat).not.toHaveBeenCalled();
    await db.update(issues).set({ createdAt: now }).where(eq(issues.id, f.issue.id));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agent.id));
    await f.scheduler.tickTimers(now);
    expect(f.deps.claimDueTimerHeartbeat).not.toHaveBeenCalled();
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agent.id));
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
  });

  it("recovers active goals with stable revision-based admission keys", async () => {
    const f = await fixture();
    const active = await session(f);
    expect(await f.scheduler.recoverActiveSessionGoals()).toEqual({ scanned: 1, enqueued: 1 });
    expect(f.deps.enqueueWakeup).toHaveBeenCalledWith(f.agent.id, expect.objectContaining({
      idempotencyKey: `goal_recovery:${active.id}:7`, contextSnapshot: { issueId: f.issue.id, taskKey: f.issue.id, resumeSessionGoalHeartbeat: true, skipIssueComment: true },
    }));
    f.deps.enqueueWakeup.mockResolvedValueOnce(null);
    expect(await f.scheduler.recoverActiveSessionGoals()).toEqual({ scanned: 1, enqueued: 0 });
    expect(f.deps.enqueueWakeup.mock.calls[1]![1]!.idempotencyKey).toBe(f.deps.enqueueWakeup.mock.calls[0]![1]!.idempotencyKey);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issue.id));
    expect(await f.scheduler.recoverActiveSessionGoals()).toEqual({ scanned: 0, enqueued: 0 });
  });

  it("excludes goals after reassignment or with a mismatched company binding", async () => {
    const f = await fixture();
    const [other] = await db.insert(companies).values({ name: "Other company", issuePrefix: "OTH" }).returning();
    const active = await session(f, { companyId: other!.id });
    expect(await f.scheduler.recoverActiveSessionGoals()).toEqual({ scanned: 0, enqueued: 0 });
    await db.update(agentTaskSessions).set({ companyId: f.company.id }).where(eq(agentTaskSessions.id, active.id));
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issue.id));
    expect(await f.scheduler.recoverActiveSessionGoals()).toEqual({ scanned: 0, enqueued: 0 });
    expect(f.deps.enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["queued", "scheduled_retry", "running"])("deduplicates a pending goal action against a %s run", async status => {
    const f = await fixture();
    const active = await session(f);
    const requestId = randomUUID();
    const [action] = await db.insert(agentSessionGoalActions).values({ companyId: f.company.id, sessionId: active.id, requestId, action: "pause", payloadJson: { requestId, action: "pause" } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status, contextSnapshot: { goalControlRequestId: requestId } }).returning();
    expect(await f.scheduler.recoverPendingSessionGoalActions()).toEqual({ scanned: 1, enqueued: 0, alreadyQueued: 1, invalid: 0 });
    expect(f.deps.enqueueWakeup).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run!.id));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issue.id));
    expect(await f.scheduler.recoverPendingSessionGoalActions()).toEqual({ scanned: 1, enqueued: 1, alreadyQueued: 0, invalid: 0 });
    expect(f.deps.enqueueWakeup).toHaveBeenCalledWith(f.agent.id, expect.objectContaining({
      idempotencyKey: `goal_control_recovery:${action!.id}`, contextSnapshot: expect.objectContaining({ resumeIntent: true, goalControlRequestId: requestId, runnerGoalControl: { requestId, action: "pause" } }),
    }));
  });

  it("persists invalid goal actions as failures without wake admission", async () => {
    const f = await fixture();
    const active = await session(f);
    const [action] = await db.insert(agentSessionGoalActions).values({ companyId: f.company.id, sessionId: active.id, requestId: "expected", action: "pause", payloadJson: { requestId: "different", action: "pause" } }).returning();
    expect(await f.scheduler.recoverPendingSessionGoalActions()).toEqual({ scanned: 1, enqueued: 0, alreadyQueued: 0, invalid: 1 });
    expect(f.deps.enqueueWakeup).not.toHaveBeenCalled();
    const failed = await db.select().from(agentSessionGoalActions).where(eq(agentSessionGoalActions.id, action!.id));
    expect(failed[0]).toMatchObject({ status: "failed", error: "session_goal_control_payload_invalid" });
  });
});
