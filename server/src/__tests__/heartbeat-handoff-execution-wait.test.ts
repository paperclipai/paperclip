import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, environmentLeases, heartbeatRuns, issueRelations, issues, issueTreeHolds } from "@paperclipai/db";
import { filterZombieCoalesceTarget, heartbeatService, mergeCoalescedContextSnapshot } from "../services/heartbeat.js";
import { handoffWakeWork } from "../services/heartbeat/handoff-wake.js";
import { createHeartbeatQueue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake } from "../services/heartbeat/queue.js";
import type { WakeupOptions } from "../services/heartbeat/run-preparation.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { environmentService } from "../services/environments.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { evaluateAgentInvokabilityFromDb } from "../services/agent-invokability.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { budgetService } from "../services/budgets.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { issueService } from "../services/issues.js";
import { createAdmissionTransactionScope, createPostgresWakeQueueAdapter, createWakeAdmissionReader, createWakeAdmissionWriter } from "../modules/wake-queue/adapters/postgres.js";
import { createAdmitWakeBehindIssueExecution, createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("handoff execution waits", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("handoff-execution-wait-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });
  afterEach(async () => { await coordinator?.stop(); coordinator = undefined; });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), reviewerId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff", issuePrefix: "H" + companyId.replaceAll("-", ""), defaultResponsibleUserId: "board" });
    await db.insert(agents).values([agentId, reviewerId].map(id => ({ id, companyId, name: id === agentId ? "Executor" : "Reviewer", adapterType: "codex_local", status: "idle",
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })));
    const stageId = randomUUID();
    const executionState = { status: "pending", currentStageId: stageId, currentStageIndex: 0,
      currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
      returnAssignee: { type: "agent", agentId, userId: null }, reviewRequest: null,
      completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null };
    await db.insert(issues).values({ id: issueId, companyId, title: "Review the change", status: "in_review", assigneeAgentId: reviewerId, executionState });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "cancelled", runtimeMode: "legacy",
      startedAt: new Date(), finishedAt: new Date(), errorCode: "issue_reassigned",
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } }, contextSnapshot: { issueId } }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: run.id,
      provider: "local", status: "active", leasePolicy: "ephemeral" }).returning();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId, agentId: reviewerId, status: "running" }).returning();
    const wake = (actor: Pick<WakeupOptions, "requestedByActorType" | "requestedByActorId"> = {
      requestedByActorType: "agent", requestedByActorId: agentId,
    }, reason = "execution_review_requested") => heartbeatService(db).wakeup(reviewerId, { source: "assignment", triggerDetail: "system",
      reason, ...actor,
      payload: { issueId, mutation: "update", executionStage: { stageId, stageType: "review", currentParticipant: executionState.currentParticipant } },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: reason, source: "issue.execution_stage" } });
    const requests = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const successors = async () => (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, reviewerId)))).filter(row => row.id !== busy.id);
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockImplementation(async id => (await db.select().from(agents).where(eq(agents.id, id)))[0] ?? null);
    deps.getAgentInvokability.mockImplementation(agent => evaluateAgentInvokabilityFromDb(db, agent));
    deps.instanceSettings.getExperimental.mockImplementation(() => instanceSettingsService(db).getExperimental());
    const work = () => handoffWakeWork(db, createHeartbeatQueue(db, deps).enqueueWakeup);
    const recover = async () => { for (const entry of await work().load(companyId)) await work().check(entry); };
    const release = () => environmentService(db).releaseLease(lease.id, "released", { cleanupStatus: "success" });
    const drain = async () => {
      await db.update(heartbeatRuns).set({ resultJson: { conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, run.id));
      return createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => "board",
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      }), recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } })({
        companyId, runId: run.id, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true,
      });
    };
    return { companyId, agentId, reviewerId, issueId, run, lease, wake, requests, successors, recover, release, drain, work, deps };
  }

  it("settles the saved handoff when an existing run absorbs it and never resumes it after that run finishes", async () => {
    const f = await fixture();
    await f.wake();
    const [saved] = await f.requests();
    await f.release();
    const [existing] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.reviewerId,
      status: "queued", contextSnapshot: { issueId: f.issueId } }).returning();
    f.deps.wakeQueue.createAdmissionTransactionScope.mockImplementation(createAdmissionTransactionScope);
    f.deps.wakeQueue.admitWakeBehindIssueExecution.mockImplementation(createAdmitWakeBehindIssueExecution({
      reader: createWakeAdmissionReader(), writer: createWakeAdmissionWriter(),
      helpers: { filterZombieCoalesceTarget, mergeCoalescedContextSnapshot,
        shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
    }));

    await f.recover();
    expect((await f.requests()).find(row => row.id === saved.id)).toMatchObject({
      status: "coalesced", runId: existing.id, finishedAt: expect.any(Date),
    });
    expect(await f.work().load(f.companyId)).toHaveLength(0);
    expect(await f.successors()).toEqual([expect.objectContaining({ id: existing.id, status: "queued" })]);
    const receipts = await f.requests();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, existing.id));
    await Promise.all([f.recover(), f.recover()]);
    expect(await f.requests()).toEqual(receipts);
    await f.wake();
    expect(await f.requests()).toHaveLength(receipts.length);
    expect(await f.successors()).toEqual([expect.objectContaining({ id: existing.id, status: "succeeded" })]);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("keeps one recoverable handoff receipt through dependency retries and admits it once the dependency resolves", async () => {
    const f = await fixture();
    await f.wake();
    const [saved] = await f.requests();
    const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Unfinished prerequisite", status: "in_progress" }).returning();
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker.id, relatedIssueId: f.issueId, type: "blocks" });
    f.deps.issuesSvc.listDependencyReadiness.mockImplementation(issueService(db).listDependencyReadiness);
    await f.release();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await f.recover();
      expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "deferred_issue_execution",
        reason: "issue_dependencies_blocked", runId: null, finishedAt: null,
        payload: expect.objectContaining({ executionWait: expect.objectContaining({ unresolvedBlockerIssueIds: [blocker.id] }) }),
      })]);
      expect(await f.work().load(f.companyId)).toHaveLength(1);
      expect(await f.successors()).toHaveLength(0);
    }
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blocker.id));
    await Promise.all([f.recover(), f.recover()]);
    await f.recover();
    const runs = await f.successors();
    expect(runs).toHaveLength(1);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "queued", runId: runs[0].id,
      reason: "execution_review_requested", finishedAt: null })]);
    expect(await f.work().load(f.companyId)).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("retains the handoff through ordinary release at the daily limit, then admits exactly one successor", async () => {
    const f = await fixture();
    await f.wake();
    const [saved] = await f.requests();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, maxDailyRuns: 0 } } }).where(eq(agents.id, f.reviewerId));
    await f.release();
    await f.drain();
    expect(await f.successors()).toHaveLength(0);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "deferred_issue_execution", runId: null, finishedAt: null })]);
    await f.recover();
    await f.wake();
    await f.drain();
    expect(await f.successors()).toHaveLength(0);
    expect((await f.requests())[0]).toMatchObject({ id: saved.id, status: "deferred_issue_execution", runId: null, finishedAt: null });
    const errors: unknown[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    await f.work().register(coordinator, () => true).ready;
    expect(coordinator.nextWakeAt()).not.toBeNull();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.reviewerId));
    await f.drain();
    await vi.waitFor(async () => expect(await f.successors()).toHaveLength(1), { timeout: 10_000 });
    await Promise.all([f.drain(), f.recover(), f.recover(), f.wake()]);
    await f.recover();
    await f.wake();
    const runs = await f.successors();
    expect(runs).toEqual([expect.objectContaining({ status: "queued", startedAt: null })]);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "queued", runId: runs[0].id, reason: "execution_review_requested" })]);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it.each([{ requestedByActorType: "system" as const, requestedByActorId: null }, {}])(
    "restores assignment with the original nullable actor %j", async actor => {
      const f = await fixture();
      await f.wake(actor, "issue_assigned");
      const [saved] = await f.requests();
      expect(saved).toMatchObject({ status: "deferred_issue_execution", requestedByActorType: actor.requestedByActorType ?? null, requestedByActorId: null });
      await f.release();
      const queue = createHeartbeatQueue(db, f.deps);
      const options: WakeupOptions = { source: "assignment", reason: "issue_assigned", ...actor,
        payload: { issueId: f.issueId }, contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_assigned" } };
      await queue.enqueueWakeup(f.reviewerId, { ...options, requestedByActorId: "" }, saved.id);
      await queue.enqueueWakeup(f.reviewerId, { ...options, requestedByActorType: "agent", requestedByActorId: f.agentId }, saved.id);
      await queue.enqueueWakeup(f.reviewerId, { ...options, reason: "execution_review_requested" }, saved.id);
      await queue.enqueueWakeup(f.reviewerId, options, randomUUID());
      expect(await f.successors()).toHaveLength(0);
      expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "deferred_issue_execution", runId: null })]);
      await Promise.all([f.recover(), f.recover(), f.wake(actor, "issue_assigned")]);
      await f.recover();
      const runs = await f.successors();
      expect(runs).toHaveLength(1);
      expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "queued", runId: runs[0].id,
        requestedByActorType: actor.requestedByActorType ?? null, requestedByActorId: null, reason: "issue_assigned" })]);
    },
  );

  it.each(["agent_pause", "company_pause", "budget"].flatMap(gate =>
    ["done", "cancelled", "stage"].map(change => ({ gate, change })),
  ))("retires a stale $change handoff before the $gate gate and clears its deadline", async ({ gate, change }) => {
    const f = await fixture();
    await f.wake();
    if (gate === "agent_pause") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.reviewerId));
    else if (gate === "company_pause") await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
    else f.deps.budgets.getInvocationBlock.mockResolvedValue({ scopeType: "agent", scopeId: f.reviewerId, scopeName: "Reviewer", reason: "Budget exhausted" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await db.update(issues).set(change === "stage" ? { executionState: { ...issue.executionState, currentStageId: randomUUID() } } :
      { status: change }).where(eq(issues.id, f.issueId));
    await f.release();
    const errors: unknown[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    await f.work().register(coordinator, () => true).ready;
    expect(await f.requests()).toEqual([expect.objectContaining({ status: "cancelled", runId: null, finishedAt: expect.any(Date) })]);
    expect(await f.work().load(f.companyId)).toHaveLength(0);
    expect(await f.successors()).toHaveLength(0);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull());
    expect(errors).toEqual([]);
    const reads = vi.spyOn(db, "select"), transactions = vi.spyOn(db, "transaction"), executes = vi.spyOn(db, "execute");
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      expect(reads).not.toHaveBeenCalled();
      expect(transactions).not.toHaveBeenCalled();
      expect(executes).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      reads.mockRestore(); transactions.mockRestore(); executes.mockRestore();
    }
  });

  it.each(["company_pause", "subtree_pause", "budget"])("preserves ordinary release intent at the %s gate and resumes once", async gate => {
    const f = await fixture();
    await f.wake();
    const [saved] = await f.requests();
    if (gate === "company_pause") await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
    else if (gate === "budget") {
      await db.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, f.reviewerId));
      f.deps.budgets.getInvocationBlock.mockImplementation((...args) => budgetService(db).getInvocationBlock(...args));
    } else {
      const [parent] = await db.insert(issues).values({ companyId: f.companyId, title: "Paused parent" }).returning();
      await db.update(issues).set({ parentId: parent.id }).where(eq(issues.id, f.issueId));
      await db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: parent.id, mode: "pause" });
      f.deps.treeControlSvc.getActivePauseHoldGate.mockImplementation((...args) => issueTreeControlService(db).getActivePauseHoldGate(...args));
    }
    await f.release();
    await f.drain();
    expect(await f.successors()).toHaveLength(0);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "deferred_issue_execution", runId: null, finishedAt: null })]);
    await f.recover();
    expect(await f.successors()).toHaveLength(0);
    expect((await f.requests())[0]).toMatchObject({ id: saved.id, status: "deferred_issue_execution", runId: null,
      reason: gate === "budget" ? "budget.blocked" : gate === "subtree_pause" ? "issue_tree_hold_active" : "company.inactive" });
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
    await db.update(agents).set({ status: "idle", pauseReason: null }).where(eq(agents.id, f.reviewerId));
    await db.update(issueTreeHolds).set({ status: "released", releasedAt: new Date() }).where(eq(issueTreeHolds.companyId, f.companyId));
    await Promise.all([f.drain(), f.recover(), f.wake()]);
    await f.recover();
    const runs = await f.successors();
    expect(runs).toHaveLength(1);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "queued", runId: runs[0].id })]);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("preserves an agent-origin review handoff while its cancelled executor still owns a lease", async () => {
    const f = await fixture();
    await f.wake();
    expect(await f.requests()).toEqual([expect.objectContaining({ status: "deferred_issue_execution", runId: null,
      reason: "execution_owner_active", finishedAt: null })]);
    expect(await f.successors()).toHaveLength(0);
  });

  it("retains active and failed cleanup, then admits the reviewer exactly once across repeated recovery and wake signals", async () => {
    const f = await fixture();
    await Promise.all([f.wake(), f.wake()]);
    const [saved] = await f.requests();
    expect(await f.requests()).toHaveLength(1);
    await f.recover();
    expect(await f.successors()).toHaveLength(0);
    await environmentService(db).releaseLease(f.lease.id, "pending_cleanup", { cleanupStatus: "failed" });
    await f.recover();
    expect(await f.successors()).toHaveLength(0);
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "deferred_issue_execution", runId: null })]);
    await f.release();
    await Promise.all([f.recover(), f.recover(), f.wake()]);
    await f.recover();
    await f.wake();
    const runs = await f.successors();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "queued", startedAt: null, agentId: f.reviewerId,
      contextSnapshot: { issueId: f.issueId, wakeReason: "execution_review_requested" } });
    expect(await f.requests()).toEqual([expect.objectContaining({ id: saved.id, status: "queued", runId: runs[0].id,
      reason: "execution_review_requested" })]);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["stage", "participant", "cancelled", "reassigned"])("discards a stale %s handoff during restart recovery", async change => {
    const f = await fixture();
    await f.wake();
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    if (change === "stage" || change === "participant") {
      await db.update(issues).set({ executionState: { ...issue.executionState,
        ...(change === "stage" ? { currentStageId: randomUUID() } : { currentParticipant: { type: "agent", agentId: f.agentId, userId: null } }) },
      }).where(eq(issues.id, f.issueId));
    } else await db.update(issues).set(change === "cancelled" ? { status: "cancelled" } : {
      assigneeAgentId: f.agentId, statusVersion: issue.statusVersion + 1,
    }).where(eq(issues.id, f.issueId));
    await f.release();
    await f.recover();
    expect(await f.successors()).toHaveLength(0);
    expect(await f.requests()).toEqual([expect.objectContaining({ status: "cancelled", runId: null })]);
  });

  it("does not treat a released lease as proof that its provider process stopped", async () => {
    const f = await fixture();
    await f.wake();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.run.id));
    await f.release();
    await f.recover();
    expect(await f.successors()).toHaveLength(0);
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, f.run.id));
    await f.recover();
    expect(await f.successors()).toHaveLength(1);
  });

  it.each([false, true])("rechecks the stage in ordinary release promotion (stale: %s)", async stale => {
    const f = await fixture();
    await f.wake();
    await db.update(heartbeatRuns).set({ resultJson: { conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, f.run.id));
    if (stale) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      await db.update(issues).set({ executionState: { ...issue.executionState, currentStageId: randomUUID() } }).where(eq(issues.id, f.issueId));
    }
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => "board",
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    }), recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } });
    const input = { companyId: f.companyId, runId: f.run.id, now: new Date(), suppressImmediateRecovery: true, resumeStrandedQueue: true };
    await release(input);
    expect(await f.successors()).toHaveLength(0);
    await f.release();
    await Promise.all([release(input), release(input), f.recover()]);
    expect(await f.successors()).toHaveLength(stale ? 0 : 1);
    expect((await f.requests())[0].status).toBe(stale ? "cancelled" : "queued");
  });

  it.each(["agent_pause", "company_pause", "daily_limit"])("keeps the %s admission gate after cleanup", async gate => {
    const f = await fixture();
    await f.wake();
    if (gate === "agent_pause") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.reviewerId));
    else if (gate === "company_pause") await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
    else await db.update(agents).set({ runtimeConfig: { heartbeat: { maxDailyRuns: 0 } } }).where(eq(agents.id, f.reviewerId));
    await f.release();
    await f.recover();
    expect(await f.successors()).toHaveLength(0);
    expect(await f.requests()).toEqual([expect.objectContaining({ status: "deferred_issue_execution", runId: null })]);
    await db.update(agents).set({ status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.reviewerId));
    await db.update(companies).set({ status: "active" }).where(eq(companies.id, f.companyId));
    await f.recover();
    expect(await f.successors()).toHaveLength(1);
  });

  it.each([true, false])("reconstructs pending work (saved before startup: %s), wakes from lease cleanup and becomes idle", async savedBeforeStartup => {
    const f = await fixture();
    if (savedBeforeStartup) await f.wake();
    const errors: unknown[] = [];
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
    await heartbeatService(db).registerExecutionHandoffWork(coordinator, () => true).ready;
    if (!savedBeforeStartup) await f.wake();
    expect(await f.successors()).toHaveLength(0);
    await f.release();
    await vi.waitFor(async () => expect(await f.successors()).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeNull(), { timeout: 10_000 });
    const reads = vi.spyOn(db, "select");
    try {
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(reads).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); }
    expect(errors).toEqual([]);
  });
});
