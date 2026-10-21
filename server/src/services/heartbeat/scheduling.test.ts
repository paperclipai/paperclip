import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  activityLog, agents, agentSessionGoalActions, agentTaskSessions, companies, createDb,
  completionContracts, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues, nativeRunFinalizations, nativeRunResults,
} from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { conflict } from "../../errors.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatScheduling, type HeartbeatSchedulingDependencies } from "./scheduling.js";
import { readIdleSleepSafety } from "../idle-sleep-safety.js";
import { PaperclipRunnerToolAuthority } from "../native-runtime/paperclip-runner-tool-authority.js";
import { finalizeNativeRun } from "../native-runtime/native-run-finalizer.js";
import { nativeCompletionFeedback } from "../native-runtime/native-completion-feedback.js";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";

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

  it("restores the reported future deadline and claims monitor delivery exactly once", async () => {
    const f = await fixture();
    const at = new Date(now.getTime() + 600_000);
    await db.update(issues).set({ monitorNextCheckAt: at,
      executionPolicy: { monitor: { nextCheckAt: at.toISOString() } } }).where(eq(issues.id, f.issue.id));
    const ownerId = randomUUID();
    const hold = () => ({ ownerId, draining: true, activeRuns: 0, pendingWakes: 0,
      startedAt: now, expiresAt: new Date(now.getTime() + 120_000) });
    const report = await readIdleSleepSafety(db, hold, () => now.getTime(), ownerId,
      async () => "none", undefined, undefined, true, true);
    expect(report).toMatchObject({ version: 2, backgroundWork: "none", scheduledWake: {
      kind: "routines_and_issue_monitors", nextWakeAt: at.toISOString() } });
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 0, enqueued: 0, skipped: 0 });
    expect(f.deps.enqueueWakeup).not.toHaveBeenCalled();
    const restored = createHeartbeatScheduling(db, f.deps);
    const deadline = new Date(report.scheduledWake!.nextWakeAt);
    await Promise.all([restored.tickTimers(deadline), f.scheduler.tickTimers(deadline)]);
    expect(f.deps.enqueueWakeup).toHaveBeenCalledOnce();
    expect(f.deps.enqueueWakeup).toHaveBeenCalledWith(f.agent.id, expect.objectContaining({ reason: "issue_monitor_due" }));
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

  it("records bounded dispatch failure diagnostics while retaining the schedule", async () => {
    const f = await fixture();
    f.deps.enqueueWakeup.mockRejectedValue(new Error("PRIVATE_PROVIDER_FAILURE"));
    await f.scheduler.tickTimers(now);
    await f.scheduler.tickTimers(new Date(now.getTime() + 30_000));
    expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: dueAt, monitorWakeRequestedAt: null, monitorAttemptCount: 0 });
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id));
    expect(events.filter(event => event.action === "issue.monitor_dispatch_failed")).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ reason: "monitor_dispatch_failed", nextCheckAt: dueAt.toISOString(), attemptCount: 0 });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_PROVIDER_FAILURE");
  });

  it("repeats a persistent diagnostic after its bounded quiet window", async () => {
    const f = await fixture();
    f.deps.enqueueWakeup.mockResolvedValue(null);
    await f.scheduler.tickTimers(now);
    await f.scheduler.tickTimers(new Date(now.getTime() + 30_000));
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id))).toHaveLength(1);
    await db.update(activityLog).set({ createdAt: new Date(Date.now() - 6 * 60_000) }).where(eq(activityLog.entityId, f.issue.id));
    await f.scheduler.tickTimers(new Date(now.getTime() + 60_000));
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id))).toHaveLength(2);
    expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: dueAt, monitorAttemptCount: 0 });
  });

  it("does not copy an unrecognized blocker cause into monitor activity", async () => {
    const f = await fixture();
    f.deps.enqueueWakeup.mockImplementationOnce(async (_agentId, options) => {
      options?.issueStateGuard?.onExecutionDeferred?.("PRIVATE_BLOCKER_CAUSE");
      return null;
    });
    await f.scheduler.tickTimers(now);
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id));
    expect(events).toMatchObject([{ action: "issue.monitor_deferred", details: { reason: "execution_reconciliation_required" } }]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_BLOCKER_CAUSE");
  });

  it("releases a monitor claim when diagnostic storage fails", async () => {
    const f = await fixture();
    await db.execute(sql`create function fail_monitor_diagnostic_test() returns trigger language plpgsql as $$
      begin if new.action = 'issue.monitor_deferred' then raise exception 'Synthetic diagnostic storage failure'; end if; return new; end; $$`);
    await db.execute(sql`create trigger fail_monitor_diagnostic_test before insert on activity_log
      for each row execute function fail_monitor_diagnostic_test()`);
    try {
      f.deps.enqueueWakeup.mockResolvedValueOnce(null);
      expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 1, enqueued: 0, skipped: 1 });
      expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: dueAt, monitorWakeRequestedAt: null, monitorAttemptCount: 0 });
      expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
    } finally {
      await db.execute(sql`drop trigger fail_monitor_diagnostic_test on activity_log`);
      await db.execute(sql`drop function fail_monitor_diagnostic_test()`);
    }
  });

  it("does not attach old dispatch diagnostics to a replacement monitor", async () => {
    const f = await fixture();
    const replacement = new Date(now.getTime() + 60_000);
    f.deps.enqueueWakeup.mockImplementationOnce(async () => {
      await db.update(issues).set({ monitorNextCheckAt: replacement, monitorWakeRequestedAt: null }).where(eq(issues.id, f.issue.id));
      return null;
    });
    await f.scheduler.tickTimers(now);
    expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: replacement });
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id))).toHaveLength(0);
  });

  it("leaves monitors alone while a native run owns the issue", async () => {
    const f = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, nativeIssueId: f.issue.id, runtimeMode: "native", status: "running", contextSnapshot: { issueId: f.issue.id } }).returning();
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 0, enqueued: 0, skipped: 0 });
    expect(f.deps.enqueueWakeup).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run!.id));
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
  });

  it("keeps a due monitor until a terminal native run finishes finalization", async () => {
    const f = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: f.company.id, agentId: f.agent.id, nativeIssueId: f.issue.id,
      runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: f.issue.id },
    }).returning();
    await db.insert(nativeRunFinalizations).values({
      companyId: f.company.id, issueId: f.issue.id, runId: run!.id, phase: "retryable_failure",
    });
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 0, enqueued: 0, skipped: 0 });
    await expect(f.scheduler.triggerIssueMonitor(f.issue.id, { now })).rejects.toThrow("waiting for the previous run to settle");
    expect(f.deps.enqueueWakeup).not.toHaveBeenCalled();
    expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: dueAt, monitorWakeRequestedAt: null });
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, run!.id));
    expect(await f.scheduler.tickTimers(now)).toEqual({ checked: 1, enqueued: 1, skipped: 0 });
    expect(f.deps.enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it.each(["scheduled", "manual"] as const)("applies expired monitor recovery after workspace settlement without another turn (%s)", async (dispatch) => {
    const f = await fixture();
    const start = new Date();
    const nextCheckAt = new Date(start.getTime() + 60_000).toISOString();
    const timeoutAt = new Date(start.getTime() + 120_000).toISOString();
    const [contract] = await db.insert(completionContracts).values({
      companyId: f.company.id, issueId: f.issue.id, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test",
      risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "test", criteria: [] }, canonicalSha256: randomUUID(),
      createdByActorType: "system", createdByActorId: "test",
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: f.company.id, agentId: f.agent.id, nativeIssueId: f.issue.id,
      runtimeMode: "native", status: "running", completionContractId: contract!.id,
      contextSnapshot: { issueId: f.issue.id },
    }).returning();
    await db.update(issues).set({ executionRunId: run!.id, checkoutRunId: run!.id }).where(eq(issues.id, f.issue.id));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId: f.company.id,
      issueId: f.issue.id, agentId: f.agent.id, runId: run!.id });
    await authority.execute({ tool: "set_task_monitor", callId: randomUUID(), arguments: {
      idempotencyKey: "expires-during-workspace-save",
      monitor: { nextCheckAt, timeoutAt, notes: "Check once saved", recoveryPolicy: "escalate_to_board" },
    } });
    const result: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: "Wait for the check.",
      completionClaim: { contractRevision: "test", objectiveSatisfied: false, criteria: [],
        remainingWork: [{ description: "Check after saving", blocksCompletion: true }] },
      continuation: { kind: "monitor", summary: "Wait for the saved check", idempotencyKey: "wait" },
      evidence: [], verification: [], attentionRequests: [], artifacts: [],
    };
    await expect(nativeCompletionFeedback(db, run!.id, result)).resolves.toContain("issue_monitor_due");
    const [saved] = await db.insert(nativeRunResults).values({
      companyId: f.company.id, issueId: f.issue.id, runId: run!.id, completionContractId: contract!.id,
      serverFingerprint: randomUUID(), canonicalSha256: randomUUID(), schemaStatus: "accepted",
      resultJson: { result, terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded",
        turnTerminalState: "completed", reportedWorkDisposition: "yielded" } },
    }).returning();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run!.id));
    await db.insert(nativeRunFinalizations).values({ companyId: f.company.id, issueId: f.issue.id,
      runId: run!.id, phase: "result_persisted", resultId: saved!.id });
    await finalizeNativeRun({ db, runId: run!.id, workspaceFinalizeStatus: "failed" });
    const expiredAt = new Date(start.getTime() + 180_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(expiredAt);
    try {
      await expect(nativeCompletionFeedback(db, run!.id, result)).rejects.toThrow("persisted, eligible monitor");
      expect(await f.scheduler.tickTimers(expiredAt)).toEqual({ checked: 0, enqueued: 0, skipped: 0 });
      await expect(f.scheduler.triggerIssueMonitor(f.issue.id, { now: expiredAt })).rejects.toThrow("waiting for the previous run to settle");
      await finalizeNativeRun({ db, runId: run!.id, workspaceFinalizeStatus: "succeeded" });
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run!.id)))[0])
        .toMatchObject({ phase: "committed", failureCode: null });
      expect(await readIssue(f.issue.id)).toMatchObject({ executionRunId: null, checkoutRunId: null,
        monitorNextCheckAt: new Date(nextCheckAt) });
      if (dispatch === "manual") await f.scheduler.triggerIssueMonitor(f.issue.id, { now: expiredAt });
      else await f.scheduler.tickTimers(expiredAt);
      expect(await readIssue(f.issue.id)).toMatchObject({ monitorNextCheckAt: null,
        executionState: { monitor: { status: "cleared", clearReason: "timeout_exceeded" } } });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(1);
      await finalizeNativeRun({ db, runId: run!.id, workspaceFinalizeStatus: "succeeded" });
      await f.scheduler.tickTimers(expiredAt);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(1);
      expect(f.deps.enqueueWakeup).not.toHaveBeenCalled();
      expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.id, saved!.id)))[0]!.resultJson).toEqual(saved!.resultJson);
    } finally {
      vi.useRealTimers();
    }
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
