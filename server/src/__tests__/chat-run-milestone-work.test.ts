import { documentService } from "../services/documents.js";
import { createChatMilestoneFixtures } from "./helpers/chat-milestone-fixtures.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, agents, agentWakeupRequests, caseHandoffs, cases, chatConversations, chatEndpoints, chatPublications, completionContracts, createDb, nativeRunFinalizations, nativeRunResults, statusDecisions, statusDecisionEffects, workAssessments, subscribeDatabaseWork, heartbeatRuns, issueComments, issueQuestionResponseDeliveries, issueThreadInteractions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { chatRunMilestoneWork } from "../services/chat-run-milestone-work.js";
import { notifyChatRunMilestones } from "../services/chat-run-milestone-notifications.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { questionResponseDeliveryService } from "../services/question-response-delivery.js";
import { createQueuedCommentIssueLockWriter } from "../modules/wake-queue/adapters/queued-comment-postgres.js";
import { createDiscardQueuedComment, createReorderQueuedComments } from "../modules/wake-queue/application/queued-comment-use-cases.js";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import { createAdmissionTransactionScope, createPostgresWakeQueueAdapter, createWakeAdmissionWriter } from "../modules/wake-queue/adapters/postgres.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { CHAT_CONTROL_RECOVERY_ADMISSION_KEY, CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE } from "../services/chat-control-recovery-stop.js";
import { heartbeatService } from "../services/heartbeat.js";
import { commitNativeStatusDecision, dispatchPendingNativeStatusEffects } from "../services/native-runtime/status-decision-committer.js";
import { claimQueuedNativeReviewRun } from "../services/native-runtime/native-review-dispatch.js";
import { createChatPublicationResolution } from "../services/chat-channels/publications/resolution.js";
import { createChatPublicationWorker } from "../services/chat-channels/publications/worker.js";
import { CAPABILITIES } from "../services/chat-channels/provider-catalog.js";
import { createChatPublicationFailures } from "../services/chat-channels/publications/failures.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MILESTONE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat lifecycle milestone worker", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let enabled = true;
  const errors: unknown[] = [];
  let fixtures: ReturnType<typeof createChatMilestoneFixtures>;
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  let f: Fixture;

  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("chat-milestones-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    fixtures = createChatMilestoneFixtures(db);
  }, 60_000);
  const fixture = (companyId?: string) => fixtures.create(companyId);
  beforeEach(async () => {
    enabled = true; errors.length = 0; f = await fixture();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    await fixtures.cleanup();
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  function runValues(scope = f, patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    return { id: randomUUID(), companyId: scope.companyId, agentId: scope.agentId, responsibleUserId: scope.userId, status: "running", updatedAt: new Date(),
      contextSnapshot: { issueId: scope.issueId, source: "chat:slack", endpointId: scope.endpointId, wakeCommentId: scope.commentId }, ...patch };
  }
  async function run(scope = f, patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const values = runValues(scope, patch);
    await db.transaction(async tx => { await notifyChatRunMilestones(tx, scope); await tx.insert(heartbeatRuns).values(values); });
    return values;
  }
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => enabled, canReconcile: () => true, onError: error => errors.push(error) });
    await chatRunMilestoneWork(db).register(coordinator, () => enabled).ready;
  }
  async function flush() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
  }
  async function quiet(ms = 120_000) {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    try { await vi.advanceTimersByTimeAsync(ms); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
    finally { reads.mockRestore(); writes.mockRestore(); }
  }
  const publications = (scope = f) => db.select().from(chatPublications).where(eq(chatPublications.issueId, scope.issueId));

  it("leaves configured idle, internal runs and old history quiet", async () => {
    await run(f, { contextSnapshot: { issueId: f.issueId, source: "issue.comment" } });
    await run(f, { updatedAt: new Date(Date.now() - 2 * 86_400_000) });
    await start(); await flush(); expect(await publications()).toEqual([]); await quiet();
  });
  it("reconstructs missing notices at startup and leaves published history quiet across restart", async () => {
    const row = await run(); await start(); await flush();
    expect(await publications()).toEqual([expect.objectContaining({ idempotencyKey: `run:${row.id}:working:${f.endpointId}` })]);
    await quiet(); await coordinator!.stop(); await start(); await flush(); await quiet();
    expect(await publications()).toHaveLength(1);
  });
  it("wakes on the first committed row after becoming quiet", async () => {
    await start(); await flush(); await quiet(); await run(); await flush();
    expect(await publications()).toHaveLength(1); await quiet();
  });
  it("wakes from the real run cancellation transaction without a manual milestone signal", async () => {
    const row = await run(f, { status: "queued", runtimeMode: "legacy" });
    await start(); await flush(); await quiet();
    // This fixture exercises the Stop producer, not successor execution.
    await heartbeatService(db).cancelRun(row.id, "Operator stopped queued work", { suppressImmediateRecovery: true });
    await flush();
    expect((await publications()).map(publication => publication.idempotencyKey).sort()).toEqual([
      `run:${row.id}:failed:${f.endpointId}`, `run:${row.id}:queued:${f.endpointId}`,
    ].sort());
    await quiet();
  });
  it.each(["promote", "suppress"] as const)("wakes when real retry dispatch chooses to %s", async action => {
    const row = await run(f, { status: "scheduled_retry", runtimeMode: "legacy", scheduledRetryAt: new Date(Date.now() - 1000), scheduledRetryReason: "transient_error" });
    if (action === "suppress") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    await start(); await flush(); expect(await publications()).toEqual([]); await quiet();
    const dispatch = createRunDispatch(db);
    const result = await dispatch.promoteScheduledRetry({ companyId: f.companyId, runId: row.id });
    expect(result.outcome).toBe(action === "promote" ? "promoted" : "gate_suppressed");
    await flush();
    expect((await publications()).map(publication => publication.idempotencyKey)).toContain(
      `run:${row.id}:${action === "promote" ? "queued" : "failed"}:${f.endpointId}`,
    );
    await quiet();
    expect((await dispatch.promoteScheduledRetry({ companyId: f.companyId, runId: row.id })).outcome).toBe("not_promoted");
    await quiet();
  });
  it("wakes when the real staleness gate cancels queued work", async () => {
    const row = await run(f, { status: "queued", runtimeMode: "legacy", scheduledRetryReason: "max_turns_continuation" });
    await start(); await flush(); await quiet();
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    const dispatch = createRunDispatch(db);
    await dispatch.cancelStaleQueuedRun({ companyId: f.companyId, runId: row.id, expectedStatus: "queued" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, row.id)))[0].status).toBe("cancelled");
    await flush();
    expect((await publications()).map(publication => publication.idempotencyKey)).toContain(`run:${row.id}:failed:${f.endpointId}`);
    await quiet();
    await dispatch.cancelStaleQueuedRun({ companyId: f.companyId, runId: row.id, expectedStatus: "queued" });
    await quiet();
  });
  it.each(["deferred", "immediate"] as const)("wakes when real %s recovery admits chat work", async kind => {
    const finishing = await run(f, { status: "succeeded", runtimeMode: "legacy", finishedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, source: "issue_assigned" },
    });
    const wakeId = randomUUID();
    if (kind === "deferred") await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: f.agentId,
      source: "on_demand", status: "deferred_issue_execution", payload: { issueId: f.issueId },
    });
    const adapter = createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => f.userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    });
    await start(); await flush(); expect(await publications()).toEqual([]); await quiet();
    let admittedId: string | undefined;
    await adapter.withIssueExecutionLock({ companyId: f.companyId, runId: finishing.id, now: new Date() }, async (locked, ports) => {
      const input = { companyId: f.companyId, issue: locked.primaryIssue, finishingRun: locked.run,
        contextSnapshot: runValues().contextSnapshot, responsibleUserId: f.userId, sessionBefore: null, now: new Date(),
      };
      const agent = { id: f.agentId, companyId: f.companyId, name: "Maya", invokable: true };
      if (kind === "deferred") {
        expect(await ports.transaction.claimDeferredWakeForPromotion({ companyId: f.companyId, wakeId, now: new Date() })).toBe(true);
        admittedId = (await ports.transaction.finalizePromotedWake({ ...input, wakeId, deferredAgent: agent,
          reason: "issue_execution_promoted", source: "on_demand", triggerDetail: null, payload: {},
        })).id;
      } else {
        admittedId = (await ports.transaction.queueImmediateRecoveryRun({ ...input, recoveryAgent: agent, reason: "issue_execution_recovery" })).id;
      }
      expect(await publications()).toEqual([]);
      return { outcome: { kind: "released" }, postCommitEffects: [] };
    });
    expect(admittedId).toBeDefined();
    await flush();
    expect((await publications()).map(publication => publication.idempotencyKey)).toContain(`run:${admittedId}:queued:${f.endpointId}`);
    await quiet();
  });
  async function queue() {
    const dependencies = createHeartbeatQueueTestDependencies(db);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    dependencies.getAgent.mockResolvedValue(agent);
    dependencies.instanceSettings.getExperimental.mockImplementation(() => instanceSettingsService(db).getExperimental());
    return { service: createHeartbeatQueue(db, dependencies), dependencies };
  }
  it("wakes on real queue admission while execution is held by drain", async () => {
    const { service, dependencies } = await queue();
    dependencies.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    await start(); await flush(); await quiet();
    const admitted = await service.enqueueWakeup(f.agentId, { source: "on_demand", reason: "issue_commented",
      contextSnapshot: runValues().contextSnapshot, requestedByActorType: "user", requestedByActorId: f.userId,
    });
    expect(admitted).toMatchObject({ status: "queued", companyId: f.companyId });
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${admitted!.id}:queued:${f.endpointId}`);
    expect(dependencies.executeRun).not.toHaveBeenCalled();
    await quiet();
  });
  it.each(["ordinary", "legacy_comments", "queued_comments"] as const)("wakes on a real %s queue claim", async kind => {
    const wakeId = randomUUID();
    const context = runValues().contextSnapshot;
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: f.agentId,
      source: "on_demand", status: "queued",
      payload: kind === "queued_comments" ? { _paperclipWakeContext: { wakeCommentIds: [f.commentId] } } : {},
    });
    const seeded = await run(f, { status: "queued", runtimeMode: "legacy", wakeupRequestId: wakeId,
      contextSnapshot: kind === "ordinary" ? context : { ...context, wakeCommentIds: [f.commentId] },
    });
    await db.update(agentWakeupRequests).set({ runId: seeded.id }).where(eq(agentWakeupRequests.id, wakeId));
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.id));
    const { service, dependencies } = await queue();
    await start(); await flush(); await quiet();
    expect(await service.claimQueuedRun(before)).toMatchObject({ id: seeded.id, status: "running" });
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${seeded.id}:working:${f.endpointId}`);
    expect(dependencies.executeRun).not.toHaveBeenCalled();
    await quiet();
    expect(await service.claimQueuedRun(before)).toBeNull();
    await quiet();
  });
  it("wakes when claim rejects a superseded case handoff and leaves repeated claims quiet", async () => {
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: f.agentId,
      source: "assignment", status: "queued", payload: { issueId: f.issueId },
    });
    const seeded = await run(f, { status: "queued", runtimeMode: "legacy", wakeupRequestId: wakeId });
    const [record] = await db.insert(cases).values({ companyId: f.companyId, caseNumber: 1, identifier: "M-CASE-1",
      caseType: "work", title: "Chat task", workIssueId: f.issueId, handoffVersion: 2 }).returning();
    await db.insert(caseHandoffs).values({ companyId: f.companyId, caseId: record.id, issueId: f.issueId,
      version: 1, toAgentId: f.agentId, phase: "implementation", instructions: "Build the change", actorType: "system",
      actorId: "test", idempotencyKey: "superseded", inputFingerprint: "fixture", wakeupRequestId: wakeId,
      expectedIssueStatusVersion: 0, appliedIssueStatusVersion: 0, state: "delivered" });
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.id));
    const { service, dependencies } = await queue();
    await start(); await flush(); await quiet();
    expect(await service.claimQueuedRun(before)).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.id)))[0])
      .toMatchObject({ status: "cancelled", errorCode: "case_handoff_superseded" });
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${seeded.id}:failed:${f.endpointId}`);
    expect(dependencies.executeRun).not.toHaveBeenCalled();
    await quiet();
    expect(await service.claimQueuedRun(before)).toBeNull();
    await quiet();
  });
  it("waits for the company before locking the issue during an automatic claim", async () => {
    const seeded = await run(f, { status: "queued", runtimeMode: "legacy", invocationSource: "automation" });
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.id));
    const { service } = await queue();
    let release!: () => void;
    let locked!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<number>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select().from(companies).where(eq(companies.id, f.companyId)).for("no key update");
      const [row] = await tx.execute(sql`select pg_backend_pid() as pid`);
      locked(Number(row.pid));
      await gate;
      await tx.select().from(issues).where(eq(issues.id, f.issueId)).for("update", { noWait: true });
    });
    const pid = await ready;
    const claim = service.withChatControlRecoveryGate(before, "claim", async () => null);
    try {
      await vi.waitFor(async () => {
        const [row] = await db.execute(sql`select count(*)::int as count from pg_stat_activity
          where ${pid} = any(pg_blocking_pids(pid))`);
        expect(Number(row.count)).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 10 });
      release();
      await expect(holder).resolves.toBeUndefined();
      await expect(claim).resolves.toBeNull();
    } finally {
      release();
      await Promise.allSettled([holder, claim]);
    }
  });

  it("wakes when dispatch fails an unverifiable chat recovery and leaves repeated gates quiet", async () => {
    const seeded = await run(f, { status: "running", runtimeMode: "legacy", invocationSource: "automation",
      runnerProfileJson: { [CHAT_CONTROL_RECOVERY_ADMISSION_KEY]: {} },
    });
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.id));
    const { service, dependencies } = await queue();
    const dispatch = vi.fn(async () => null);
    await start(); await flush(); await quiet();
    await service.withChatControlRecoveryGate(before, "dispatch", dispatch);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.id)))[0])
      .toMatchObject({ status: "failed", errorCode: CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE });
    expect(dispatch).not.toHaveBeenCalled(); expect(dependencies.executeRun).not.toHaveBeenCalled();
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${seeded.id}:failed:${f.endpointId}`);
    await quiet();
    await service.withChatControlRecoveryGate(before, "dispatch", dispatch);
    await quiet();
  });
  it.each(["queued", "scheduled_retry"] as const)("publishes cancellation when admission replaces a reassigned %s owner", async status => {
    const old = await run(f, { status, runtimeMode: "legacy", scheduledRetryAt: status === "scheduled_retry" ? new Date(Date.now() + 60_000) : null });
    const [replacement] = await db.insert(agents).values({ companyId: f.companyId, name: "Replacement", adapterType: "paperclip_runner" }).returning();
    await db.update(issues).set({ assigneeAgentId: replacement.id, executionRunId: old.id }).where(eq(issues.id, f.issueId));
    const { service, dependencies } = await queue();
    dependencies.getAgent.mockResolvedValue(replacement);
    dependencies.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    await start(); await flush(); await quiet();
    const admitted = await service.enqueueWakeup(replacement.id, { source: "on_demand", reason: "issue_commented",
      contextSnapshot: runValues().contextSnapshot, requestedByActorType: "user", requestedByActorId: f.userId,
    });
    expect(admitted).toMatchObject({ agentId: replacement.id, status: "queued" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, old.id)))[0])
      .toMatchObject({ status: "cancelled", errorCode: status === "queued" ? "lock_released_on_reassignment" : "issue_reassigned" });
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${old.id}:failed:${f.endpointId}`);
    expect(dependencies.executeRun).not.toHaveBeenCalled(); await quiet();
  });
  async function editableQueue(staleContext = false) {
    const wakeId = randomUUID();
    await db.update(issueComments).set({ authorUserId: f.userId }).where(eq(issueComments.id, f.commentId));
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: f.agentId,
      source: "on_demand", status: "queued", payload: { issueId: f.issueId, _paperclipWakeContext: { wakeCommentIds: [f.commentId] } },
    });
    const seeded = await run(f, { status: "queued", runtimeMode: "legacy", wakeupRequestId: wakeId,
      contextSnapshot: { ...runValues().contextSnapshot, wakeCommentId: staleContext ? randomUUID() : f.commentId },
    });
    await db.update(agentWakeupRequests).set({ runId: seeded.id }).where(eq(agentWakeupRequests.id, wakeId));
    const issue = { id: f.issueId, companyId: f.companyId, assigneeAgentId: f.agentId, executionRunId: seeded.id };
    const actor = { actorType: "user" as const, actorId: f.userId, agentId: null, runId: null, agentApiKeyId: null };
    const issueLock = createQueuedCommentIssueLockWriter(db, {
      syncCommentReferences: async () => {}, deleteCommentReferenceSource: async () => {}, syncCommentExternalObjectsSafely: async () => {},
    });
    const snapshot = await issueLock.withLockedQueue({ issue, actor, queueId: wakeId }, async locked => locked.queue);
    return { seeded, issueLock, input: { issue, actor, queueId: wakeId, revision: snapshot.revision, now: new Date() } };
  }
  it("wakes when queued-comment mutation reconstructs run lineage from its authoritative queue", async () => {
    const { seeded, issueLock, input } = await editableQueue(true);
    await start(); await flush(); expect(await publications()).toEqual([]); await quiet();
    await createReorderQueuedComments({ issueLock })({ ...input, orderedCommentIds: [f.commentId] });
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${seeded.id}:queued:${f.endpointId}`);
    await quiet();
  });
  it("settles queued-comment discard intent only after the owning transaction commits", async () => {
    const { seeded, input } = await editableQueue();
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, "chat-run-milestones", event => events.push(event));
    try {
      await db.transaction(async tx => {
        const writer = createQueuedCommentIssueLockWriter(tx as unknown as typeof db, {
          syncCommentReferences: async () => {}, deleteCommentReferenceSource: async () => {}, syncCommentExternalObjectsSafely: async () => {},
        });
        await createDiscardQueuedComment({ issueLock: writer })({ ...input, commentId: f.commentId });
        expect(events).toContain("intent"); expect(events).not.toContain("settled");
      });
      expect(events).toContain("settled");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.id)))[0])
        .toMatchObject({ status: "cancelled", errorCode: "queued_comment_discarded" });
    } finally { unsubscribe(); }
  });
  it("wakes when the real coalescing writer gives an existing run chat lineage", async () => {
    const seeded = await run(f, { contextSnapshot: { issueId: f.issueId, source: "issue_assigned" } });
    await start(); await flush(); expect(await publications()).toEqual([]); await quiet();
    await db.transaction(async tx => {
      await createWakeAdmissionWriter().coalesceIntoActiveExecutionRun(
        createAdmissionTransactionScope(f.companyId, tx as unknown as typeof db), {
          companyId: f.companyId, activeExecutionRunId: seeded.id, mergedContextSnapshot: runValues().contextSnapshot,
          agentId: f.agentId, source: "on_demand", triggerDetail: null, payload: { issueId: f.issueId },
          requestedByActorType: "user", requestedByActorId: f.userId, idempotencyKey: null,
        });
      expect(await publications()).toEqual([]);
    });
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${seeded.id}:working:${f.endpointId}`);
    await quiet();
  });
  it("wakes on a claim released for drain and leaves repeated release quiet", async () => {
    const seeded = await run();
    const { service } = await queue();
    await start(); await flush(); await quiet();
    await service.releaseRunClaimedJustBeforeSuppression(seeded.id);
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${seeded.id}:queued:${f.endpointId}`);
    await quiet();
    await service.releaseRunClaimedJustBeforeSuppression(seeded.id);
    await quiet();
  });
  it("wakes an admitted monitor through its previously committed source receipt", async () => {
    const source = await run(f, { runtimeMode: "native", nativeIssueId: f.issueId });
    await db.update(issues).set({ executionRunId: source.id }).where(eq(issues.id, f.issueId));
    await start(); await flush(); await quiet();
    const nextCheckAt = new Date(Date.now() + 60_000).toISOString();
    const authority = new PaperclipRunnerToolAuthority(db, { ...f, runId: source.id });
    const request = { tool: "set_task_monitor", callId: randomUUID(), arguments: {
      idempotencyKey: "milestone-monitor", monitor: { nextCheckAt, notes: "Check the saved task" },
    } };
    await expect(authority.execute(request)).resolves.toMatchObject({ taskId: f.issueId, replayed: false });
    // The monitor and source receipt commit together, before due admission. This
    // fixture finishes the source without executing a harness; admission below
    // uses the real queue, with execution held by task drain.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, source.id));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    await quiet();
    const { service, dependencies } = await queue();
    dependencies.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    const admitted = await service.enqueueWakeup(f.agentId, { source: "automation", reason: "issue_monitor_due",
      idempotencyKey: `issue-monitor:${f.issueId}:${nextCheckAt}`,
      payload: { issueId: f.issueId, nextCheckAt },
      contextSnapshot: { issueId: f.issueId, source: "issue.monitor" },
      requestedByActorType: "user", requestedByActorId: f.userId,
    });
    expect(admitted).toMatchObject({ status: "queued" });
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${admitted!.id}:queued:${f.endpointId}`);
    expect(dependencies.executeRun).not.toHaveBeenCalled();
    await quiet();
  });
  async function nativeFixture(phase = "committed") {
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(completionContracts).values({
      id: contractId, companyId: f.companyId, issueId: f.issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { objective: "Respond to chat" }, canonicalSha256: "milestone-contract",
      createdByActorType: "system", createdByActorId: "test",
    });
    // Persisted audit-only routing can commit without a status decision. Recovery
    // still owes the terminal run projection after the controller restarts.
    const row = await run(f, { runtimeMode: "native", nativeIssueId: f.issueId, completionContractId: contractId,
      resultJson: { nativeAttentionRouting: [{ decisionId: null, reasonCode: "attention_duplicate_suppressed",
        materializedTargets: [{ kind: "existing_attention" }] }] },
    });
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId,
      runId: row.id, completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted",
      resultJson: { terminal: { runTerminalState: "cancelled" } }, canonicalSha256: "milestone-result",
    });
    await db.insert(nativeRunFinalizations).values({ runId: row.id, companyId: f.companyId, issueId: f.issueId,
      phase, resultId,
    });
    return { row, contractId, resultId };
  }
  async function continuationDecisionFixture() {
    const native = await nativeFixture("assessing");
    const assessmentId = randomUUID();
    await db.insert(workAssessments).values({ id: assessmentId, companyId: f.companyId, issueId: f.issueId,
      runId: native.row.id, contractId: native.contractId, resultId: native.resultId, triggerKind: "run_result",
      triggerActorCompanyId: f.companyId, priorIssueStatus: "in_progress", priorStatusVersion: 0,
      policyVersion: "phase6-v1", assessmentJson: {}, inputDigest: assessmentId,
    });
    return { companyId: f.companyId, issueId: f.issueId, runId: native.row.id, assessmentId,
      priorStatus: "in_progress", priorStatusVersion: 0, priorDecisionId: null,
      decision: { policyVersion: "phase6-v1", statusAction: "preserve" as const, toStatus: "in_progress" as const,
        reasonCode: "live_continuation_registered", unblockDescriptor: null,
        effects: [{ kind: "enqueue_continuation" as const, agentId: f.agentId, continuationKind: "same_agent" as const,
          summary: "Continue responding", idempotencyKey: `continuation:${native.row.id}` }],
      },
    };
  }
  it("wakes from a governed native reviewer claim and leaves repeated claims quiet", async () => {
    const input = await continuationDecisionFixture();
    const { decision } = await commitNativeStatusDecision({ db, ...input });
    const [reviewer] = await db.insert(agents).values({ companyId: f.companyId, name: "Reviewer", adapterType: "paperclip_runner" }).returning();
    await db.update(statusDecisions).set({ decisionJson: { ...decision.decisionJson, projectedStatusVersion: 1 } }).where(eq(statusDecisions.id, decision.id));
    await db.update(issues).set({ status: "in_review", statusVersion: 1, lastStatusDecisionId: decision.id, executionRunId: null }).where(eq(issues.id, f.issueId));
    await db.update(chatEndpoints).set({ assignedAgentId: reviewer.id }).where(eq(chatEndpoints.id, f.endpointId));
    const [interaction] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "request_confirmation", status: "pending", sourceRunId: input.runId, addresseeAgentId: reviewer.id,
      effectiveResolverPolicy: "anyone", resolverPolicyProvenance: "inherited",
      payload: { version: 1, prompt: "Review the work", target: { type: "custom", key: "native_completion_review", revisionId: decision.id } },
    }).returning();
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: reviewer.id, source: "automation", status: "queued" });
    const seeded = await run(f, { agentId: reviewer.id, status: "queued", runtimeMode: "native", nativeIssueId: f.issueId, wakeupRequestId: wakeId,
      contextSnapshot: { ...runValues().contextSnapshot, nativeReviewInteractionId: interaction.id, nativeReviewDecisionId: decision.id },
    });
    await db.update(agentWakeupRequests).set({ runId: seeded.id }).where(eq(agentWakeupRequests.id, wakeId));
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.id));
    const claim = { run: before, agentNameKey: "reviewer", claimedAt: new Date(), claimValues: {} };
    await start(); await flush(); await quiet();
    expect(await claimQueuedNativeReviewRun(db, claim)).toMatchObject({ id: seeded.id, status: "running" });
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${seeded.id}:working:${f.endpointId}`);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(seeded.id);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0].status).toBe("claimed");
    await quiet();
    expect(await claimQueuedNativeReviewRun(db, claim)).toBeNull(); await quiet();
  });
  it("wakes from native committed-result projection and leaves repeated finalization quiet", async () => {
    const { row } = await nativeFixture();
    await start(); await flush(); await quiet();
    await finalizeNativeRun({ db, runId: row.id, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    await flush();
    expect((await publications()).map(publication => publication.idempotencyKey).sort()).toEqual([
      `run:${row.id}:failed:${f.endpointId}`, `run:${row.id}:working:${f.endpointId}`,
    ].sort());
    await quiet();
    await finalizeNativeRun({ db, runId: row.id, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    // A no-op repair must not enqueue another scan. This also catches deferred
    // coordinator callbacks that start after the finalizer returns.
    await quiet();
    expect(await publications()).toHaveLength(2);
  });
  it("signals a new native decision at outer commit but not an already committed replay", async () => {
    const input = await continuationDecisionFixture();
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, "chat-run-milestones", event => events.push(event));
    try {
      await db.transaction(async tx => {
        await commitNativeStatusDecision({ db: tx as unknown as typeof db, ...input });
        expect(events).toEqual(["intent"]);
      });
      expect(events).toEqual(["intent", "settled"]);
      events.length = 0;
      await expect(commitNativeStatusDecision({ db, ...input })).resolves.toMatchObject({ replayed: true });
      expect(events).toEqual([]);
    } finally { unsubscribe(); }
  });
  it("wakes a suppressed continuation when its native effect delivery receipt commits", async () => {
    const input = await continuationDecisionFixture();
    const { decision } = await commitNativeStatusDecision({ db, ...input });
    const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    // Reconstruct an interrupted delivery with its already admitted successor.
    // The target has no direct chat identity: only the delivered ledger can
    // authorize inheriting the source run's conversation.
    await db.update(statusDecisionEffects).set({ deliveryState: "pending", deliveredAt: null })
      .where(eq(statusDecisionEffects.decisionId, decision.id));
    const target = await run(f, { status: "queued", contextSnapshot: {
      issueId: f.issueId, source: "native_status_decision", nativeStatusWakeIntentId: intent.id,
    } });
    await db.update(agentWakeupRequests).set({ status: "coalesced", runId: target.id }).where(eq(agentWakeupRequests.id, intent.id));
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "issue_status_changed", requestedByActorType: "system", requestedByActorId: `native-status-wake-dispatch:${intent.id}`,
      runId: target.id, status: "queued", idempotencyKey: intent.idempotencyKey, payload: { issueId: f.issueId },
    });
    await start(); await flush();
    expect((await publications()).some(row => row.idempotencyKey.startsWith(`run:${target.id}:`))).toBe(false);
    await quiet();
    await dispatchPendingNativeStatusEffects({ db, ...input, decisionId: decision.id });
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${target.id}:queued:${f.endpointId}`);
    await quiet();
    await expect(dispatchPendingNativeStatusEffects({ db, ...input, decisionId: decision.id })).resolves.toEqual([]);
    await quiet();
  });
  it("wakes an admitted continuation when native wake dispatch repairs its original receipt", async () => {
    const input = await continuationDecisionFixture();
    await commitNativeStatusDecision({ db, ...input });
    const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const target = await run(f, { status: "queued", contextSnapshot: {
      issueId: f.issueId, source: "native_status_decision", nativeStatusWakeIntentId: intent.id,
    } });
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "issue_status_changed", requestedByActorType: "system", requestedByActorId: `native-status-wake-dispatch:${intent.id}`,
      runId: target.id, status: "queued", idempotencyKey: intent.idempotencyKey, payload: { issueId: f.issueId },
    });
    await start(); await flush();
    expect((await publications()).some(row => row.idempotencyKey.startsWith(`run:${target.id}:`))).toBe(false);
    await quiet();
    const { service, dependencies } = await queue();
    await expect(service.dispatchPendingNativeStatusWakeups({ companyId: f.companyId })).resolves.toMatchObject({ recovered: 1, dispatched: 0 });
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${target.id}:queued:${f.endpointId}`);
    expect(dependencies.executeRun).not.toHaveBeenCalled();
    await quiet();
    await expect(service.dispatchPendingNativeStatusWakeups({ companyId: f.companyId })).resolves.toMatchObject({ scanned: 0 });
    await quiet();
  });
  it("rechecks a fresh native continuation after admission finishes its wake receipt", async () => {
    const input = await continuationDecisionFixture();
    await commitNativeStatusDecision({ db, ...input });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, input.runId));
    await start(); await flush(); await quiet();
    const { service, dependencies } = await queue();
    let admittedId: string | undefined;
    dependencies.getSchedulingSuppression.mockImplementation(async () => {
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      const admitted = rows.find(row => row.id !== input.runId);
      if (admitted && !admittedId) {
        admittedId = admitted.id;
        // Admission already committed and signalled, but the original wake
        // receipt is still claimed. Let that first projection finish now.
        await flush();
        expect((await publications()).some(row => row.idempotencyKey.startsWith(`run:${admittedId}:`))).toBe(false);
      }
      return { suppressed: true, reason: "task_drain" };
    });
    await expect(service.dispatchPendingNativeStatusWakeups({ companyId: f.companyId })).resolves.toMatchObject({ dispatched: 1 });
    expect(admittedId).toBeDefined();
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${admittedId}:queued:${f.endpointId}`);
    expect(dependencies.executeRun).not.toHaveBeenCalled();
    await quiet();
  });
  it("projects a continuation only after the real question delivery receipt commits", async () => {
    const source = await run(f, { status: "succeeded" });
    const interactions = issueThreadInteractionService(db);
    const interaction = await interactions.create({ id: f.issueId, companyId: f.companyId }, {
      kind: "ask_user_questions", continuationPolicy: "wake_assignee", sourceRunId: source.id,
      title: "Choose", payload: { version: 1, title: "Choose", questions: [{
        id: "choice", prompt: "Continue?", selectionMode: "single", required: true,
        options: [{ id: "yes", label: "Yes" }],
      }] },
    }, { agentId: f.agentId, runId: source.id });
    await interactions.answerQuestions({ id: f.issueId, companyId: f.companyId, status: "in_progress" }, interaction.id,
      { answers: [{ questionId: "choice", optionIds: ["yes"] }] }, { userId: f.userId });
    // A provider acknowledgement is durable input to this projection test.
    await db.insert(chatPublications).values({ companyId: f.companyId, endpointId: f.endpointId, conversationId: f.conversationId,
      issueId: f.issueId, idempotencyKey: `interaction:${interaction.id}:${f.endpointId}`,
      payload: { text: "Continue?", interactionId: interaction.id }, state: "published", providerMessageId: "question-1",
    }).onConflictDoNothing();
    await db.update(chatPublications).set({ state: "published", providerMessageId: "question-1" }).where(eq(chatPublications.issueId, f.issueId));
    await start(); await flush(); await quiet();
    let targetId!: string;
    const delivery = questionResponseDeliveryService(db, { heartbeat: {
      cancelRun: async () => { throw new Error("The source is already terminal"); },
      wakeup: async (_agentId, options) => {
        const values = runValues(f, { status: "queued", contextSnapshot: options.contextSnapshot });
        const [target] = await db.insert(heartbeatRuns).values(values).returning();
        targetId = target.id;
        await flush();
        expect((await publications()).some(row => row.idempotencyKey.startsWith(`run:${target.id}:`))).toBe(false);
        return target;
      },
    } });
    await expect(delivery.deliver(interaction.id)).resolves.toMatchObject({ status: "fallback_queued" });
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${targetId}:queued:${f.endpointId}`);
    await quiet();
  });
  it.each([
    ["question", "answer"], ["question", "skip"], ["question", "cancel"],
    ["question", "withdraw"], ["question", "expire"], ["question", "historical answer"],
    ["confirmation", "accept"], ["confirmation", "reject"], ["confirmation", "skip"],
    ["confirmation", "withdraw"], ["confirmation", "expire"],
    ["question", "comment"], ["question", "historical comment"],
    ["confirmation", "comment"], ["confirmation", "historical comment"],
    ["question", "replacement"], ["confirmation", "replacement"], ["confirmation", "startup supersession"],
    ["question", "addressee deletion"], ["confirmation", "addressee deletion"],
  ] as const)("rechecks an unsent %s after %s", async (kind, action) => {
    const source = await run(f, { status: "failed", errorCode: "test_run_failed" });
    const interactions = issueThreadInteractionService(db);
    const issue = { id: f.issueId, companyId: f.companyId, status: "in_progress" };
    const addressee = action === "addressee deletion"
      ? (await db.insert(agents).values({ companyId: f.companyId, name: "Reviewer", adapterType: "paperclip_runner" }).returning())[0] : null;
    const createInteraction = (sourceRunId: string, supersedePendingSiblingInteractions = true) => interactions.create(issue, kind === "confirmation" ? {
      kind: "request_confirmation", continuationPolicy: "wake_assignee", sourceRunId, addresseeAgentId: addressee?.id,
      title: "Confirm", payload: { version: 1, prompt: "Continue?", supersedeOnUserComment: true },
    } : {
      kind: "ask_user_questions", continuationPolicy: "wake_assignee", sourceRunId, addresseeAgentId: addressee?.id,
      title: "Choose", payload: { version: 1, title: "Choose", supersedeOnUserComment: true, questions: [{
        id: "choice", prompt: "Continue?", selectionMode: "single", required: true,
        options: [{ id: "yes", label: "Yes" }],
      }] },
    }, { agentId: f.agentId, runId: sourceRunId }, { supersedePendingSiblingInteractions });
    const interaction = await createInteraction(source.id);
    const replacement = action === "replacement" || action === "startup supersession" ? await run() : null;
    if (action === "startup supersession") {
      await createInteraction(replacement!.id, false);
      await db.update(issueThreadInteractions).set({ createdAt: new Date(Date.now() - 1000) }).where(eq(issueThreadInteractions.id, interaction.id));
    }
    if (action === "historical answer") {
      await interactions.dismissInteraction(issue, interaction.id, { userId: f.userId });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    }
    await start(); await flush();
    expect((await publications()).some(row => row.idempotencyKey.startsWith(`run:${source.id}:`))).toBe(false);
    await quiet();
    if (action === "addressee deletion") {
      expect((await interactions.cancelPendingForDeletedAddressee(f.companyId, addressee!.id)).map(row => row.id)).toContain(interaction.id);
    } else if (action === "startup supersession") {
      expect(await interactions.sweepSupersededPendingRequestConfirmations()).toMatchObject({ expired: 1 });
    } else if (action === "replacement") {
      await createInteraction(replacement!.id);
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0].status).toBe("expired");
    } else if (action === "comment" || action === "historical comment") {
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: f.userId, origin: "comment", body: "Ignore the earlier request" }).returning();
      const expired = action === "comment"
        ? await interactions.expireRequestConfirmationsSupersededByComment(issue, comment, { userId: f.userId })
        : await interactions.expireRequestConfirmationsSupersededByHistoricalComments(issue);
      expect(expired.map(row => row.id)).toContain(interaction.id);
    } else if (action === "accept") {
      await interactions.acceptInteraction({ ...issue, projectId: null, goalId: null }, interaction.id, {}, { userId: f.userId });
    } else if (action === "reject") {
      await interactions.rejectInteraction(issue, interaction.id, { reason: "No longer needed" }, { userId: f.userId });
    } else if (action === "skip") {
      await interactions.skipInteraction(issue, interaction.id, { reason: "No longer needed" }, { userId: f.userId });
    } else if (action === "cancel") {
      await interactions.cancelQuestions(issue, interaction.id, { reason: "No longer needed" }, { userId: f.userId });
    } else if (action === "withdraw") {
      await interactions.withdrawInteraction(issue, interaction.id, { reason: "No longer needed" }, { userId: f.userId });
    } else if (action === "expire") {
      await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
      await interactions.expirePendingInteractionsForTerminalIssue({ ...issue, status: "cancelled" }, { userId: f.userId });
    } else {
      await interactions.answerQuestions(issue, interaction.id,
        { answers: [{ questionId: "choice", optionIds: ["yes"] }] }, { userId: f.userId });
    }
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${source.id}:failed:${f.endpointId}`);
    if (action === "historical answer") {
      expect(await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id))).toEqual([]);
    }
    await quiet();
  });
  it.each(["change", "delete", "accept", "reject"] as const)("rechecks a document confirmation after %s detects a stale target", async mode => {
    const source = await run(f, { status: "failed", errorCode: "test_run_failed" });
    const interactions = issueThreadInteractionService(db), docs = documentService(db);
    const issue = { id: f.issueId, companyId: f.companyId, status: "in_progress", projectId: null, goalId: null };
    const input = { issueId: f.issueId, key: "plan", format: "markdown", body: "First plan", createdByUserId: f.userId };
    const { document } = await docs.upsertIssueDocument(input);
    const interaction = await interactions.create(issue, {
      kind: "request_confirmation", continuationPolicy: "wake_assignee", sourceRunId: source.id,
      payload: { version: 1, prompt: "Apply this plan?", target: { type: "issue_document", issueId: f.issueId,
        documentId: document.id, key: document.key, revisionId: document.latestRevisionId!, revisionNumber: document.latestRevisionNumber } },
    }, { agentId: f.agentId, runId: source.id });
    await start(); await flush();
    expect((await publications()).some(row => row.idempotencyKey.startsWith(`run:${source.id}:`))).toBe(false);
    await quiet();
    const changed = mode === "delete"
      ? { ...(await docs.deleteIssueDocument(f.issueId, document.key))!, latestRevisionId: null, latestRevisionNumber: null }
      : (await docs.upsertIssueDocument({ ...input, body: "Revised plan", baseRevisionId: document.latestRevisionId })).document;
    await flush(); await quiet();
    if (mode === "accept" || mode === "reject") {
      await expect(mode === "accept"
        ? interactions.acceptInteraction(issue, interaction.id, {}, { userId: f.userId })
        : interactions.rejectInteraction(issue, interaction.id, {}, { userId: f.userId }))
        .rejects.toMatchObject({ status: 409, details: { code: "interaction_stale_target" } });
    } else {
      expect((await interactions.expireStaleRequestConfirmationsForIssueDocument(issue, changed, { userId: f.userId })).map(row => row.id)).toContain(interaction.id);
    }
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction.id)))[0].status).toBe("expired");
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${source.id}:failed:${f.endpointId}`);
    await quiet();
  });
  it("wakes a question continuation after its in-flight prompt receipt commits", async () => {
    await db.update(chatEndpoints).set({ provider: "discord" }).where(eq(chatEndpoints.id, f.endpointId));
    const source = await run(f, { status: "failed", contextSnapshot: { ...runValues().contextSnapshot, source: "chat:discord" } });
    const interactions = issueThreadInteractionService(db);
    const interaction = await interactions.create({ id: f.issueId, companyId: f.companyId }, {
      kind: "ask_user_questions", continuationPolicy: "wake_assignee", sourceRunId: source.id,
      title: "Choose", payload: { version: 1, title: "Choose", questions: [{
        id: "choice", prompt: "Continue?", selectionMode: "single", required: true,
        options: [{ id: "yes", label: "Yes" }],
      }] },
    }, { agentId: f.agentId, runId: source.id });
    const prompt = (await publications()).find(row => row.idempotencyKey === `interaction:${interaction.id}:${f.endpointId}`)!;
    const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpointId));
    const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, f.conversationId));
    const targetId = randomUUID();
    let beforeReceiptKeys: string[] | undefined;
    await start(); await flush(); await quiet();
    const deliver = questionResponseDeliveryService(db, { heartbeat: {
      wakeup: async () => {
        const [target] = await db.insert(heartbeatRuns).values(runValues(f, {
          id: targetId, status: "queued", contextSnapshot: { issueId: f.issueId },
        })).returning();
        return target;
      },
    } });
    const post = vi.fn(async () => {
      await interactions.answerQuestions({ id: f.issueId, companyId: f.companyId, status: "in_progress" }, interaction.id,
        { answers: [{ questionId: "choice", optionIds: ["yes"] }] }, { userId: f.userId });
      await deliver.deliver(interaction.id);
      await flush();
      beforeReceiptKeys = (await publications()).map(row => row.idempotencyKey);
      return { id: "published-question" };
    });
    // Controlled transport/authorization ports; actual attempt lease, receipt
    // transaction, question delivery receipt and milestone worker use PostgreSQL.
    const worker = createChatPublicationWorker(db, {
      CAPABILITIES, settleGitHubAutomaticPublication: async () => false,
      ensureDurablePublicationTransport: async publication => publication,
      tryProcessTeamsFilePublication: async () => false,
      endpointRecord: async () => ({ endpoint, assignedAgentName: "Maya", connectionName: "Chat", applicationId: "test", credentialSecretRefs: [] }),
      runtimeContextForRecord: () => ({ generation: 0, localEpoch: 0, credentialFingerprint: "test", version: "test" }),
      hasCommittedTaskControlCompletion: async () => false, nonDirectDestinationAllowed: () => true,
      runOwnershipMilestoneSupersessionReason: async () => null,
      progressSupersededByFastResponse: async () => false, runProgressSupersededByPublishedInteraction: async () => false,
      currentTaskControlPayload: async publication => publication.payload,
      withCredentialMutationLease: async (_endpoint, operation) => operation({ assertOwned: async () => {} }),
      closeProgressToReplace: async () => null, interactionResolutionPublicationToReplace: async () => null,
      interactionPromptPublicationToReplace: async () => null, runPublicationToReplace: async () => null,
      inboundWakePublicationToReplace: async () => null, taskStatusPublicationToReplace: async () => null,
      claimPublicationTransportAuthorization: async () => ({ endpoint, conversation, authorizationActionId: null, preparedText: null }),
      postSafePublication: post, commitTaskControlCompletion: async () => {}, receiptReactionCompletionRunId: async () => null,
      finalizePublicationFailure: async (_publication, error) => { errors.push(error); return false; },
      redactError: String,
    } as Parameters<typeof createChatPublicationWorker>[1]);
    await worker.processSelectedPublication(prompt);
    expect(post).toHaveBeenCalledTimes(1);
    expect((await db.select().from(chatPublications).where(eq(chatPublications.id, prompt.id)))[0]).toMatchObject({ state: "published", providerMessageId: "published-question" });
    expect(beforeReceiptKeys).toBeDefined();
    expect(beforeReceiptKeys).not.toContain(`run:${targetId}:queued:${f.endpointId}`);
    await flush();
    expect((await publications()).map(row => row.idempotencyKey)).toContain(`run:${targetId}:queued:${f.endpointId}`);
    await quiet();
  });
  it.each([
    ["retry", null], ["failed", null], ["delivery_unknown", "cancel"], ["delivery_unknown", "mark_delivered"],
  ] as const)("rechecks resolved prompt ownership after delivery %s (%s)", async (state, resolution) => {
    const source = await run(f, { status: "failed", errorCode: "test_run_failed" });
    const interactions = issueThreadInteractionService(db);
    const interaction = await interactions.create({ id: f.issueId, companyId: f.companyId }, {
      kind: "ask_user_questions", continuationPolicy: "wake_assignee", sourceRunId: source.id,
      title: "Choose", payload: { version: 1, title: "Choose", questions: [{
        id: "choice", prompt: "Continue?", selectionMode: "single", required: true,
        options: [{ id: "yes", label: "Yes" }],
      }] },
    }, { agentId: f.agentId, runId: source.id });
    // Model a send already claimed when the user answers through the UI.
    const [prompt] = await db.update(chatPublications).set({ state: "streaming", attempts: 1 })
      .where(eq(chatPublications.idempotencyKey, `interaction:${interaction.id}:${f.endpointId}`)).returning();
    await interactions.answerQuestions({ id: f.issueId, companyId: f.companyId, status: "in_progress" }, interaction.id,
      { answers: [{ questionId: "choice", optionIds: ["yes"] }] }, { userId: f.userId });
    expect(prompt).toBeDefined();
    await start(); await flush();
    expect((await publications()).some(row => row.idempotencyKey.startsWith(`run:${source.id}:`))).toBe(false);
    await quiet();
    const failures = createChatPublicationFailures(db, {
      FailedChatRetryPublicationReadError: class extends Error {},
      MAX_ERROR_TEXT: 1000, getTaskBaseUrl: () => null,
      invalidateRuntime: async () => false, runtimeCallbackEndpoint: async () => null,
    });
    const failure = Object.assign(new Error("provider rejected the send"), { status: state === "retry" ? 429 : 400 });
    // The finalizer receives the selection from before the attempt increment.
    await expect(failures.finalizePublicationFailure({ ...prompt, attempts: 0 }, failure, state === "delivery_unknown")).resolves.toBe(true);
    expect((await db.select().from(chatPublications).where(eq(chatPublications.id, prompt.id)))[0].state).toBe(state);
    await flush();
    expect((await publications()).some(row => row.idempotencyKey === `run:${source.id}:failed:${f.endpointId}`)).toBe(state === "failed");
    await quiet();
    if (resolution) {
      const targetId = randomUUID();
      await questionResponseDeliveryService(db, { heartbeat: { wakeup: async () => {
        const [target] = await db.insert(heartbeatRuns).values(runValues(f, {
          id: targetId, status: "queued", contextSnapshot: { issueId: f.issueId },
        })).returning();
        return target;
      } } }).deliver(interaction.id);
      await flush();
      expect((await publications()).some(row => row.idempotencyKey.startsWith(`run:${targetId}:`))).toBe(false);
      await quiet();
      const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpointId));
      const resolver = createChatPublicationResolution(db, {
        endpointRecord: async () => ({ endpoint, assignedAgentName: "Maya", connectionName: "Chat", applicationId: "test", credentialSecretRefs: [] }),
        withCredentialMutationLease: async (_endpoint, operation) => operation({ assertOwned: async () => {} }),
        commitTaskControlCompletion: async () => {}, processPendingPublications: async () => {},
      } as Parameters<typeof createChatPublicationResolution>[1]);
      await resolver.resolvePublication(f.endpointId, prompt.id, resolution, f.userId);
      await flush();
      const keys = (await publications()).map(row => row.idempotencyKey);
      expect(keys.includes(`run:${source.id}:failed:${f.endpointId}`)).toBe(resolution === "cancel");
      expect(keys.includes(`run:${targetId}:queued:${f.endpointId}`)).toBe(resolution === "mark_delivered");
      await quiet();
    }
  });
  it.each(["retry", "stale claim", "live claim", "rolled-back reset"] as const)("rechecks question prompt binding after %s", async (mode) => {
    const source = await run();
    const interactions = issueThreadInteractionService(db);
    const interaction = await interactions.create({ id: f.issueId, companyId: f.companyId }, {
      kind: "ask_user_questions", continuationPolicy: "wake_assignee", sourceRunId: source.id,
      title: "Choose", payload: { version: 1, title: "Choose", questions: [{
        id: "choice", prompt: "Continue?", selectionMode: "single", required: true,
        options: [{ id: "yes", label: "Yes" }],
      }] },
    }, { agentId: f.agentId, runId: source.id });
    await interactions.answerQuestions({ id: f.issueId, companyId: f.companyId, status: "in_progress" }, interaction.id,
      { answers: [{ questionId: "choice", optionIds: ["yes"] }] }, { userId: f.userId });
    const other = await fixture(f.companyId);
    await db.update(chatEndpoints).set({ assignedAgentId: f.agentId }).where(eq(chatEndpoints.id, other.endpointId));
    await db.update(chatConversations).set({ issueId: f.issueId }).where(eq(chatConversations.id, other.conversationId));
    await db.insert(chatPublications).values({ companyId: f.companyId, endpointId: other.endpointId, conversationId: other.conversationId,
      issueId: f.issueId, idempotencyKey: `interaction:${interaction.id}:${other.endpointId}`,
      payload: { text: "Continue?", interactionId: interaction.id }, state: "published", providerMessageId: "other-question",
    });
    const events: string[] = [];
    let claimEvents: string[] = [];
    let duringClaimNotices: string[] | undefined;
    const unsubscribe = subscribeDatabaseWork(db, "chat-run-milestones", event => events.push(event));
    const delivery = questionResponseDeliveryService(db, { heartbeat: {
      cancelRun: async () => {
        claimEvents = [...events];
        await start(); await flush();
        duringClaimNotices = (await publications()).map(row => row.idempotencyKey);
        throw new Error("temporary cancellation failure");
      },
      wakeup: async () => { throw new Error("Must retain the still-active source"); },
    } });
    try {
      if (mode === "retry") {
        await expect(delivery.deliver(interaction.id)).resolves.toBeNull();
      } else {
        await db.update(issueQuestionResponseDeliveries).set({ status: "delivering", attemptCount: 1,
          lastAttemptAt: new Date(Date.now() - (mode === "live claim" ? 0 : 60_000)),
        }).where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id));
        await start(); await flush();
        duringClaimNotices = (await publications()).map(row => row.idempotencyKey);
        if (mode === "rolled-back reset") {
          await expect(db.transaction(async tx => {
            await questionResponseDeliveryService(tx as unknown as typeof db, { heartbeat: {} as never }).sweepPending(0);
            expect(events).toEqual(["intent"]);
            throw new Error("rollback reset");
          })).rejects.toThrow("rollback reset");
        } else {
          await delivery.sweepPending(0);
        }
      }
      expect(duringClaimNotices).toBeDefined();
      expect(duringClaimNotices!.some(key => key.startsWith(`run:${source.id}:`))).toBe(false);
      expect((await db.select().from(issueQuestionResponseDeliveries).where(eq(issueQuestionResponseDeliveries.interactionId, interaction.id)))[0].status).toBe(mode === "live claim" || mode === "rolled-back reset" ? "delivering" : "pending");
      await flush();
      const noticeExists = (await publications()).some(row => row.idempotencyKey === `run:${source.id}:working:${f.endpointId}`);
      expect(noticeExists).toBe(mode === "retry" || mode === "stale claim");
      if (mode === "retry") expect(claimEvents).toEqual(["intent", "settled"]);
      else if (mode === "live claim") expect(events).toEqual([]);
      else {
        expect(events[0]).toBe("intent");
        expect(events.slice(1)).toContain("settled");
        expect(events.filter(event => event === "intent")).toHaveLength(1);
      }
      await quiet();
    } finally { unsubscribe(); }
  });
  it("waits for outer commit and ignores rolled-back nested writes", async () => {
    await start(); await flush();
    await expect(db.transaction(async tx => {
      await tx.transaction(async nested => { await notifyChatRunMilestones(nested, f); await nested.insert(heartbeatRuns).values(runValues()); });
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    await flush(); expect(await publications()).toEqual([]); await quiet();
    let release!: () => void, staged!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const stagedPromise = new Promise<void>(resolve => { staged = resolve; });
    const writing = db.transaction(async tx => {
      await tx.transaction(async nested => { await notifyChatRunMilestones(nested, f); await nested.insert(heartbeatRuns).values(runValues()); });
      staged(); await gate;
    });
    try { await stagedPromise; await vi.advanceTimersByTimeAsync(1000); expect(await publications()).toEqual([]); }
    finally { release(); await writing; }
    await flush(); expect(await publications()).toHaveLength(1); await quiet();
  });
  it("retains the first committed wake during drain without periodic SQL", async () => {
    await start(); await flush(); enabled = false;
    await run(); await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    const drained = idleWorkSnapshot();
    expect(await publications()).toEqual([]); await quiet(); expect(idleWorkSnapshot()).toEqual(drained);
    enabled = true; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(await publications()).toHaveLength(1); await quiet();
  });
  it("scopes mutation wakes to their issue and company", async () => {
    const sibling = await fixture(f.companyId), foreign = await fixture();
    await start(); await flush();
    // Unsupported raw writers deliberately do not wake: they provide a sentinel
    // proving a supported issue mutation does not perform a global scan.
    await db.insert(heartbeatRuns).values([runValues(sibling), runValues(foreign)]);
    await run(); await flush();
    expect(await publications()).toHaveLength(1); expect(await publications(sibling)).toEqual([]); expect(await publications(foreign)).toEqual([]);
    await db.transaction(tx => notifyChatRunMilestones(tx, { companyId: f.companyId }));
    await flush(); expect(await publications(sibling)).toHaveLength(1); expect(await publications(foreign)).toEqual([]);
    await quiet();
  });
  it("disarms suppressed lineage and reactivates after its binding changes", async () => {
    const row = await run(f, { contextSnapshot: { issueId: f.issueId, source: "chat:slack", endpointId: randomUUID(), wakeCommentId: f.commentId } });
    await start(); await flush(); expect(await publications()).toEqual([]); await quiet();
    await db.transaction(async tx => {
      await notifyChatRunMilestones(tx, f);
      await tx.update(heartbeatRuns).set({ contextSnapshot: runValues().contextSnapshot }).where(eq(heartbeatRuns.id, row.id));
    });
    await flush(); expect(await publications()).toHaveLength(1); await quiet();
  });
  it("waits quietly for a late presentation decision", async () => {
    const row = await run(f, { status: "succeeded" }); await start(); await flush();
    expect(await publications()).toEqual([]); await quiet();
    await db.transaction(async tx => {
      await notifyChatRunMilestones(tx, f);
      await tx.update(heartbeatRuns).set({ resultJson: { presentationDecision: { source: "none" } } }).where(eq(heartbeatRuns.id, row.id));
    });
    await flush(); expect(await publications()).toEqual([expect.objectContaining({ idempotencyKey: `run:${row.id}:completed:${f.endpointId}` })]); await quiet();
  });
  it("drains more than one batch without duplicate notices or starving another company", async () => {
    const other = await fixture();
    await db.insert(heartbeatRuns).values([...Array.from({ length: 205 }, () => runValues()), runValues(other)]);
    await start(); await flush(); expect(await publications()).toHaveLength(205); expect(await publications(other)).toHaveLength(1); await quiet();
  });
  it("retains a failed selection for retry through drain", async () => {
    await run();
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => { throw new Error("temporary read failure"); });
    await start(); select.mockRestore(); expect(errors.splice(0)).toHaveLength(1);
    enabled = false; await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    const drained = idleWorkSnapshot();
    await quiet(); expect(idleWorkSnapshot()).toEqual(drained);
    enabled = true; await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(await publications()).toHaveLength(1); await quiet();
  });
  it("retries a failed publication write without idle scans before its deadline", async () => {
    await run();
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("temporary publication failure"));
    await start(); transaction.mockRestore(); expect(errors.splice(0)).toHaveLength(1);
    expect(await publications()).toEqual([]); await quiet(10_000);
    await vi.advanceTimersByTimeAsync(30_000); await flush(); expect(await publications()).toHaveLength(1); await quiet();
  });
  it("preserves a committed change arriving while a projection batch is running", async () => {
    await run();
    const transaction = db.transaction.bind(db);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const staged = new Promise<void>(resolve => { entered = resolve; });
    const held = vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, config) => {
      entered(); await gate; return transaction(callback, config);
    });
    const starting = start();
    try {
      await staged;
      await transaction(async tx => { await notifyChatRunMilestones(tx, f); await tx.insert(heartbeatRuns).values(runValues()); });
    } finally { release(); await starting; held.mockRestore(); }
    await flush(); expect(await publications()).toHaveLength(2); await quiet();
  });
  it("stops future wakes and reconstructs writes made after shutdown", async () => {
    await start(); await flush(); await coordinator!.stop(); await run(); await quiet();
    expect(await publications()).toEqual([]); await start(); await flush(); expect(await publications()).toHaveLength(1);
  });
});
