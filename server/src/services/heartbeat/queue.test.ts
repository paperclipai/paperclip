import { claimNativeSessionResumptions } from "../native-runtime/native-finalization-reconciler.js";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, caseHandoffs, cases, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues, nativeRunFinalizations } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { createHeartbeatQueue, type HeartbeatQueueDependencies } from "./queue.js";

import { createHeartbeatQueueTestDependencies as callbacks } from "../../__tests__/helpers/heartbeat-queue.js";

function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected queue database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

describe("heartbeat queue module boundary", () => {
  it("constructs without querying, dispatching, or registering background work", () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    createHeartbeatQueue(database.db, deps);
    expect(database.access).not.toHaveBeenCalled();
    for (const callback of Object.values(deps)) if (vi.isMockFunction(callback)) expect(callback).not.toHaveBeenCalled();
    expect(deps.activeRunExecutionPromises.size).toBe(0);
    expect(deps.activeWakeupPromises.size).toBe(0);
  });

  it.each(["startNextQueuedRunForAgent", "resumeQueuedRuns"] as const)("honors suppression before %s reads or resumes work", async (operation) => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    const queue = createHeartbeatQueue(database.db, deps);
    await queue[operation]("agent");
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.resumeExecutionWaitComments).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("tracks pending wakes across instances and clears each rejected wake", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    let rejectFirst!: (reason: Error) => void;
    let rejectSecond!: (reason: Error) => void;
    deps.getAgent.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    deps.getAgent.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSecond = reject; }));
    const first = createHeartbeatQueue(database.db, deps).trackWakeup("first");
    const second = createHeartbeatQueue(database.db, deps).trackWakeup("second");
    const firstCheck = expect(first).rejects.toThrow("first lookup failed");
    const secondCheck = expect(second).rejects.toThrow("second lookup failed");
    expect(deps.activeWakeupPromises).toEqual(new Set([first, second]));
    rejectFirst(new Error("first lookup failed"));
    await firstCheck;
    await Promise.resolve();
    expect(deps.activeWakeupPromises).toEqual(new Set([second]));
    rejectSecond(new Error("second lookup failed"));
    await secondCheck;
    await Promise.resolve();
    expect(deps.activeWakeupPromises.size).toBe(0);
    expect(deps.activeRunExecutionPromises.size).toBe(0);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("uses the same policy limits for dispatch and execution", () => {
    const database = guardedDatabase();
    const queue = createHeartbeatQueue(database.db, callbacks(database.db));
    const agent = { adapterType: "paperclip_runner", adapterConfig: { provider: "openai_dot" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 20, maxDailyRuns: 3.8 } } } as unknown as typeof agents.$inferSelect;
    expect(queue.parseHeartbeatPolicy(agent)).toMatchObject({ maxConcurrentRuns: 1, maxDailyRuns: 3 });
    expect(queue.parseHeartbeatPolicy({ ...agent, adapterConfig: { provider: "codex" } })).toMatchObject({ maxConcurrentRuns: 20, maxDailyRuns: 3 });
    expect(database.access).not.toHaveBeenCalled();
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping queue module database tests: ${support.reason}`);
describe.skipIf(!support.supported)("heartbeat queue database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-queue-module");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture(status = "running") {
    const [company] = await db.insert(companies).values({ name: "Queue module", issuePrefix: "QM" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Queue agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Queue task", status: "todo", assigneeAgentId: agent.id }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "assignment", status: "claimed", claimedAt: new Date() }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status, invocationSource: "assignment", wakeupRequestId: wake.id, startedAt: status === "running" ? new Date() : null, contextSnapshot: { issueId: issue.id } }).returning();
    await db.update(issues).set({ executionRunId: run.id, executionAgentNameKey: agent.name, executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    return { company, agent, issue, wake, run };
  }

  async function strandedMention(runtimeMode = "legacy") {
    const seeded = await fixture("succeeded");
    await db.update(heartbeatRuns).set({ runtimeMode, nativeIssueId: runtimeMode === "native" ? seeded.issue.id : null, finishedAt: new Date() }).where(eq(heartbeatRuns.id, seeded.run.id));
    if (runtimeMode === "native") await db.insert(nativeRunFinalizations).values({ runId: seeded.run.id, companyId: seeded.company.id, issueId: seeded.issue.id, phase: "committed" });
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, seeded.issue.id));
    const [recipient] = await db.insert(agents).values({ companyId: seeded.company.id, name: "Mention recipient", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: seeded.company.id, issueId: seeded.issue.id, body: "Saved feedback", authorAgentId: seeded.agent.id }).returning();
    const [pending] = await db.insert(agentWakeupRequests).values({ companyId: seeded.company.id, agentId: recipient.id,
      source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      payload: { issueId: seeded.issue.id, _paperclipWakeContext: { issueId: seeded.issue.id, wakeReason: "issue_comment_mentioned", wakeCommentIds: [comment.id] } },
    }).returning();
    return { ...seeded, recipient, pending };
  }

  it("rechecks a handoff's assignment version under the issue claim lock", async () => {
    const { company, agent, issue, wake, run } = await fixture("queued");
    const [record] = await db.insert(cases).values({ companyId: company.id, caseNumber: 1, identifier: "QM-CASE-1",
      caseType: "work", title: issue.title, workIssueId: issue.id, handoffVersion: 1 }).returning();
    await db.insert(caseHandoffs).values({ companyId: company.id, caseId: record.id, issueId: issue.id,
      version: 1, toAgentId: agent.id, phase: "implementation", instructions: "Build the change", actorType: "system",
      actorId: "test", idempotencyKey: "queue-version-race", inputFingerprint: "fixture", wakeupRequestId: wake.id,
      expectedIssueStatusVersion: issue.statusVersion, appliedIssueStatusVersion: issue.statusVersion, state: "delivered" });
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableCases: true } as Awaited<ReturnType<HeartbeatQueueDependencies["instanceSettings"]["getExperimental"]>>);
    // Simulate A → B → A after the optimistic receipt read. The agent ID is
    // unchanged, but the original assignment no longer authorizes a new turn.
    deps.budgets.getInvocationBlock.mockImplementationOnce(async () => {
      await db.update(issues).set({ statusVersion: issue.statusVersion + 2 }).where(eq(issues.id, issue.id));
      return null;
    });
    expect(await createHeartbeatQueue(db, deps).claimQueuedRun({ ...run, responsibleUserId: "queue-test-user" })).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0])
      .toMatchObject({ status: "queued", startedAt: null });
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["legacy", "native"])("periodic recovery preserves a paused recipient through the real %s release adapter", async runtimeMode => {
    const { company, issue, recipient, pending } = await strandedMention(runtimeMode);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, recipient.id));
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issue.id));
    const deps = callbacks(db);
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => "responsible-user",
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    }), recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } });
    deps.releaseIssueExecutionAndPromote.mockImplementation(async (run, options) => {
      await release({ companyId: run.companyId, runId: run.id, now: new Date(), ...options });
    });
    for (let pass = 0; pass < 2; pass++) {
      await createHeartbeatQueue(db, deps).resumeQueuedRuns();
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending.id)))[0])
        .toMatchObject({ status: "deferred_issue_execution", runId: null, finishedAt: null, error: null, payload: pending.payload });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toHaveLength(1);
    }
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledTimes(2);
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["legacy", "native"])("resumes an accepted non-assignee queue through its %s owner", async runtimeMode => {
    const { run, pending } = await strandedMention(runtimeMode);
    const deps = callbacks(db);
    await createHeartbeatQueue(db, deps).resumeQueuedRuns();
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: run.id }), { suppressImmediateRecovery: true, resumeStrandedQueue: true },
    );
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending.id)))[0]).toMatchObject({
      status: "deferred_issue_execution", runId: null, payload: pending.payload,
    });
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("preserves a former owner's ordinary messages for the assignment handoff", async () => {
    const { pending } = await strandedMention();
    const payload = { ...pending.payload, _paperclipWakeContext: {
      ...(pending.payload!._paperclipWakeContext as Record<string, unknown>), wakeReason: "issue_commented",
    } };
    await db.update(agentWakeupRequests).set({ payload }).where(eq(agentWakeupRequests.id, pending.id));
    const deps = callbacks(db);
    await createHeartbeatQueue(db, deps).resumeQueuedRuns();
    expect(deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending.id)))[0])
      .toMatchObject({ status: "deferred_issue_execution", runId: null, payload });
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "scheduled_retry"])("does not replay a finishing owner while another agent has a %s turn", async status => {
    const { company, issue, recipient } = await strandedMention();
    await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: recipient.id, status, invocationSource: "assignment", contextSnapshot: { issueId: issue.id } });
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue({ ...recipient, status: "paused" });
    await createHeartbeatQueue(db, deps).resumeQueuedRuns();
    expect(deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["claimed", "cancelled"] as const)("releases a running claim while preserving a %s wake", async (wakeStatus) => {
    const { run, issue, wake } = await fixture();
    await db.update(agentWakeupRequests).set({ status: wakeStatus }).where(eq(agentWakeupRequests.id, wake.id));
    await createHeartbeatQueue(db, callbacks(db)).releaseRunClaimedJustBeforeSuppression(run.id);
    const [released] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [releasedIssue] = await db.select().from(issues).where(eq(issues.id, issue.id));
    const [releasedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(released).toMatchObject({ status: "queued", startedAt: null, responsibleUserId: null });
    expect(releasedIssue).toMatchObject({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null });
    expect(releasedWake.status).toBe(wakeStatus === "cancelled" ? "cancelled" : "queued");
    if (wakeStatus === "claimed") expect(releasedWake.claimedAt).toBeNull();
  });

  it("preserves a newer execution owner when releasing an old claim", async () => {
    const { run, issue, agent, company } = await fixture();
    const [newOwner] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running", invocationSource: "assignment" }).returning();
    await db.update(issues).set({ executionRunId: newOwner.id }).where(eq(issues.id, issue.id));
    await createHeartbeatQueue(db, callbacks(db)).releaseRunClaimedJustBeforeSuppression(run.id);
    const [current] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(current.executionRunId).toBe(newOwner.id);
  });

  it.each(["running", "failed"])("resumes the %s native owner before promoting its queued waiter", async status => {
    const { run, issue, agent, company } = await fixture(status);
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue.id, runnerProfileJson: {
      nativeExecutionInput: { binding: { runId: run.id } },
      sessionCheckpoint: { providerSessionId: "original-session" },
    } }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId: company.id,
      issueId: issue.id, phase: "retryable_failure", attempt: 1 });
    const [waiter] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "queued", invocationSource: "assignment", responsibleUserId: "queue-test-user", contextSnapshot: { issueId: issue.id },
    }).returning();
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableNativeRunner: true } as Awaited<ReturnType<HeartbeatQueueDependencies["instanceSettings"]["getExperimental"]>>);
    const queue = createHeartbeatQueue(db, deps);
    expect(await queue.claimQueuedRun(waiter)).toBeNull();
    const claims = await claimNativeSessionResumptions({ db, runnerInstanceId: "owner", runIds: [run.id] });
    expect(claims.map(claim => claim.runId)).toEqual([run.id]);
    expect(await queue.claimQueuedRun(waiter)).toBeNull();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    await db.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: null, leaseExpiresAt: null })
      .where(eq(nativeRunFinalizations.runId, run.id));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issue.id));
    expect(await queue.claimQueuedRun(waiter)).toMatchObject({ id: waiter.id, status: "running" });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].executionRunId).toBe(waiter.id);
  });

  it.each(["direct", "batch"] as const)("keeps fresh work queued across a held external connection on the %s path", async path => {
    const { run, agent, issue, wake } = await fixture("queued");
    await db.update(heartbeatRuns).set({ responsibleUserId: "queue-test-user" }).where(eq(heartbeatRuns.id, run.id));
    const deps = { ...callbacks(db), canStartNewExternalBotWork: vi.fn(async () => false) };
    deps.getAgent.mockResolvedValue({ ...agent, adapterType: "paperclip_runner", adapterConfig: { provider: "grok_bot" } });
    const queue = createHeartbeatQueue(db, deps);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (path === "direct") expect(await queue.claimQueuedRun({ ...run, responsibleUserId: "queue-test-user" })).toBeNull();
      else expect(await queue.startNextQueuedRunForAgent(agent.id)).toEqual([]);
    }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toMatchObject({ status: "queued", startedAt: null });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe(wake.status);
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0].status).toBe("todo");
    expect(deps.executeRun).not.toHaveBeenCalled();
    expect(deps.setRunStatus).not.toHaveBeenCalled();
  });

  it("admits the same queued input after the external connection is repaired", async () => {
    const { run, agent } = await fixture("queued");
    await db.update(heartbeatRuns).set({ responsibleUserId: "queue-test-user" }).where(eq(heartbeatRuns.id, run.id));
    const deps = { ...callbacks(db), canStartNewExternalBotWork: vi.fn(async () => false) };
    deps.getAgent.mockResolvedValue(agent);
    const queue = createHeartbeatQueue(db, deps);
    expect(await queue.startNextQueuedRunForAgent(agent.id)).toEqual([]);
    deps.canStartNewExternalBotWork.mockResolvedValue(true);
    expect(await queue.startNextQueuedRunForAgent(agent.id)).toEqual([expect.objectContaining({ id: run.id, status: "running" })]);
    expect(deps.executeRun).toHaveBeenCalledExactlyOnceWith(run.id);
  });

  it("rechecks the connection hold when Stop races the queue scan", async () => {
    const { run, agent } = await fixture("queued");
    const deps = { ...callbacks(db), canStartNewExternalBotWork: vi.fn(async () => false) };
    deps.getAgent.mockResolvedValue(agent);
    deps.canStartNewExternalBotWork.mockResolvedValueOnce(true);
    expect(await createHeartbeatQueue(db, deps).startNextQueuedRunForAgent(agent.id)).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toMatchObject({ status: "queued", startedAt: null });
    expect(deps.canStartNewExternalBotWork).toHaveBeenCalledTimes(2);
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("keeps admitted resumptions outside the fresh external connection gate", async () => {
    const { run, agent } = await fixture("queued");
    await db.update(heartbeatRuns).set({ startedAt: new Date(), responsibleUserId: "queue-test-user" }).where(eq(heartbeatRuns.id, run.id));
    const [admitted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const deps = { ...callbacks(db), canStartNewExternalBotWork: vi.fn(async () => false) };
    deps.getAgent.mockResolvedValue(agent);
    expect(await createHeartbeatQueue(db, deps).claimQueuedRun(admitted)).toMatchObject({ id: run.id, status: "running" });
    expect(deps.canStartNewExternalBotWork).not.toHaveBeenCalled();
  });

  it("cancels at the daily run cap before claiming or dispatching", async () => {
    const { run, agent } = await fixture("queued");
    const cappedAgent = { ...agent, runtimeConfig: { heartbeat: { maxDailyRuns: 0 } } };
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(cappedAgent);
    expect(await createHeartbeatQueue(db, deps).claimQueuedRun(run)).toBeNull();
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "heartbeat.daily_run_limit" });
    expect(deps.setWakeupStatus).toHaveBeenCalledWith(run.wakeupRequestId, "skipped", expect.any(Object));
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(cancelled, { suppressImmediateRecovery: true });
    expect(deps.treeControlSvc.getActivePauseHoldGate).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });
});
