import { randomUUID } from "node:crypto";
import { contextCompactionService } from "../context-compaction.js";
import { claimNativeSessionResumptions } from "../native-runtime/native-finalization-reconciler.js";
import type { Db } from "@paperclipai/db";
import { authUsers, agents, agentWakeupRequests, budgetIncidents, budgetPolicies, caseHandoffs, cases, chatCompletionDeliveries, companies, companyMemberships, costEvents, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, heartbeatRuns, issueComments, issueThreadInteractions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createPostgresWakeQueueAdapter, createWakeAdmissionWriter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "./run-admission.js";
import { createHeartbeatQueue, DEFERRED_WAKE_CONTEXT_KEY, notifyOtherAgentsQueuedOnSettledIssue, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake, type HeartbeatQueueDependencies } from "./queue.js";
import { createWakeQueue } from "../../modules/wake-queue/index.js";
import { TransactionScope } from "../../modules/wake-queue/application/ports.js";
import { enrichWakeContextSnapshot, mergeCoalescedContextSnapshot } from "./run-preparation.js";
import { withQueuedCommentIdsInWakePayload, withQueuedCommentIdsInRunContext } from "../issue-queued-comment-queue.js";
import { settleConversationTurn } from "../agent-conversations.js";
import { chatCompletionDeliveryService, recordChatCompletion, recordChatHandoff } from "../chat-completion-delivery.js";
import { instanceSettingsService } from "../instance-settings.js";
import { createHeartbeatRunControl } from "./run-control.js";
import { callbacks as runControlCallbacks } from "./__tests__/run-control-fixtures.js";

import { createHeartbeatQueueTestDependencies as callbacks } from "../../__tests__/helpers/heartbeat-queue.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../delivery-work-notifications.js";

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

  it.each(["startNextQueuedRunForAgent", "resumeQueuedRuns"] as const)("starts no run once shutdown closed run admission (%s)", async (operation) => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.isRunAdmissionClosed = () => true;
    const queue = createHeartbeatQueue(database.db, deps);
    await queue[operation]("agent");
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("claims no queued run once run admission is closed, whatever path asks (draining or yielding server)", async () => {
    // Release-swap wave: an old server started a delivered continuation 3 minutes after traffic
    // had moved to its dispatching replacement, through executeRun of a queued run, which no gate covered.
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.isRunAdmissionClosed = () => true;
    const queue = createHeartbeatQueue(database.db, deps);
    const queued = { id: "run-1", status: "queued" } as Parameters<typeof queue.claimQueuedRun>[0];
    expect(await queue.claimQueuedRun(queued)).toBeNull();
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("honors the process-wide run admission gate in every heartbeat instance", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    closeProcessRunAdmission();
    try {
      await createHeartbeatQueue(database.db, deps).startNextQueuedRunForAgent("agent");
    } finally {
      resetProcessRunAdmissionForTests();
    }
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
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

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_QUEUE_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping queue module database tests: ${support.reason}`);
describe.skipIf(!support.supported)("heartbeat queue database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: Db;
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-queue-module");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4 });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  it.each([
    { provider: "codex" }, { provider: "acpx", acpxAgent: "antigravity" }, { provider: "muse" },
  ])("rejects direct taskless timer wakes for $provider before a run or request can be persisted", async adapterConfig => {
    const [company] = await db.insert(companies).values({ name: "Timer scope", issuePrefix: "TS" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Ready for a task", status: "idle",
      adapterType: "paperclip_runner", adapterConfig, runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60 } } }).returning();
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    const queue = createHeartbeatQueue(db, deps);
    expect(await queue.enqueueWakeup(agent.id, { source: "timer", reason: "heartbeat_timer", requestedByActorType: "system" })).toBeNull();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect((await db.select().from(agents).where(eq(agents.id, agent.id)))[0])
      .toMatchObject({ status: "idle", lastHeartbeatAt: null });
    expect(deps.executeRun).not.toHaveBeenCalled();
    expect(deps.budgets.getInvocationBlock).not.toHaveBeenCalled();
  });

  it.each(["ordinary recovery", "mismatched compaction"] as const)(
    "does not admit %s after the conversation settles between precheck and admission", async cause => {
    const [user] = await db.insert(authUsers).values({
      id: "queue-conversation-race-user", name: "Conversation owner", email: "queue-race@paperclip.test",
      createdAt: new Date(), updatedAt: new Date(),
    }).onConflictDoUpdate({ target: authUsers.id, set: { name: "Conversation owner" } }).returning();
    const [company] = await db.insert(companies).values({ name: "Conversation race", issuePrefix: "CR" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Chat agent",
      status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Answered conversation",
      assigneeAgentId: agent.id, responsibleUserId: user.id, conversationAgentId: agent.id,
      conversationUserId: user.id, conversationState: "active", status: "in_progress" }).returning();
    const [completed] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "succeeded", finishedAt: new Date(), invocationSource: "on_demand", triggerDetail: "manual",
      contextSnapshot: { issueId: issue.id, conversationSessionGeneration: issue.conversationSessionGeneration },
    }).returning();
    await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorAgentId: agent.id,
      createdByRunId: completed.id, origin: "comment", body: "The requested answer." });

    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableAgentChat: true } as Awaited<ReturnType<typeof deps.instanceSettings.getExperimental>>);
    // Admit through the normal transaction, but hold dispatch so no adapter runs.
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    deps.getSchedulingSuppression.mockResolvedValueOnce({ suppressed: false, reason: null });
    const getIssueExecutionContext = deps.getIssueExecutionContext;
    const outsideStates: Array<{ status: string; conversationState: string | null }> = [];
    deps.getIssueExecutionContext = async (...args) => {
      const current = await getIssueExecutionContext(...args);
      if (current) outsideStates.push({ status: current.status, conversationState: current.conversationState });
      return current;
    };
    let reached!: () => void;
    let release!: () => void;
    const atBarrier = new Promise<void>(resolve => { reached = resolve; });
    const admissionMayContinue = new Promise<void>(resolve => { release = resolve; });
    deps.budgets.getInvocationBlock.mockImplementationOnce(async () => {
      reached();
      await admissionMayContinue;
      return null;
    });
    const requestId = randomUUID();
    const compaction = cause === "mismatched compaction";
    const pending = createHeartbeatQueue(db, deps).enqueueWakeup(agent.id, {
      source: compaction ? "on_demand" : "automation", triggerDetail: compaction ? "manual" : "system",
      reason: compaction ? "context_compaction" : "issue.continuation_recovery",
      requestedByActorType: compaction ? "user" : "system", requestedByActorId: compaction ? user.id : undefined,
      ...(compaction ? { manualUserWake: true, allowRunCoalescing: false } : {}),
      payload: { issueId: issue.id, ...(compaction ? { intent: "context_compaction", requestId: `foreign-${requestId}` } : {}) },
      contextSnapshot: { issueId: issue.id, retryOfRunId: completed.id, source: "issue.continuation_recovery",
        ...(compaction ? { contextCompactionRequestId: requestId } : {}) },
    });
    try {
      await atBarrier;
      expect(outsideStates).toEqual([{ status: "in_progress", conversationState: "active" }]);
      expect(await settleConversationTurn(db, completed)).toBe(true);
      expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0])
        .toMatchObject({ status: "in_review", conversationState: "waiting" });
    } finally { release(); }
    const admitted = await pending;
    expect(deps.executeRun).not.toHaveBeenCalled();
    expect(admitted).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agent.id))).map(run => run.id))
      .toEqual([completed.id]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agent.id)))
      .toHaveLength(0);
  });

  async function waitingConversationFixture() {
    const [user] = await db.insert(authUsers).values({ id: "queue-conversation-owner", name: "Owner",
      email: "queue-owner@paperclip.test", createdAt: new Date(), updatedAt: new Date() })
      .onConflictDoUpdate({ target: authUsers.id, set: { name: "Owner" } }).returning();
    const [company] = await db.insert(companies).values({ name: "Waiting conversation", issuePrefix: "WC" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Chat agent", status: "idle", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Waiting for input",
      assigneeAgentId: agent.id, responsibleUserId: user.id, conversationAgentId: agent.id,
      conversationUserId: user.id, conversationState: "waiting", status: "in_review" }).returning();
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableAgentChat: true } as Awaited<ReturnType<typeof deps.instanceSettings.getExperimental>>);
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    deps.getSchedulingSuppression.mockResolvedValueOnce({ suppressed: false, reason: null });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    return { user, company, agent, issue, deps, queue: createHeartbeatQueue(db, deps) };
  }

  async function waitingCompactionFixture() {
    const f = await waitingConversationFixture();
    const [agent] = await db.update(agents).set({ adapterType: "paperclip_runner", adapterConfig: { provider: "codex" } })
      .where(eq(agents.id, f.agent.id)).returning();
    if (!agent) throw new Error("Missing compaction agent");
    f.deps.getAgent.mockResolvedValue(agent);
    const service = contextCompactionService(db, { wakeup: f.queue.enqueueWakeup });
    return { ...f, agent, service };
  }

  it("admits the owner's context compaction maintenance request while its conversation waits", async () => {
    const f = await waitingCompactionFixture();
    const accepted = await f.service.request({ companyId: f.company.id, issue: f.issue, userId: f.user.id });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: accepted.runId, status: "queued", contextSnapshot: {
      issueId: f.issue.id, contextCompactionRequestId: accepted.requestId, skipIssueComment: true,
    } });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id)))
      .toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0])
      .toMatchObject({ status: "in_review", conversationState: "waiting", assigneeAgentId: f.agent.id });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("admits only one of two simultaneous waiting-conversation compaction requests", async () => {
    const f = await waitingCompactionFixture();
    // Both service requests must finish their real availability read before
    // either enters queue admission. Dispatch remains suppressed, not mocked.
    // task_drain explicitly retains admission (queue.ts's admission guard
    // excludes it), while startNextQueuedRunForAgent stops before any claim.
    // Do not tie two admissions to a call-count-sensitive suppression sequence.
    f.deps.getSchedulingSuppression.mockReset().mockResolvedValue({ suppressed: true, reason: "task_drain" });
    const admission = createWakeQueue(db, {
      resolveResponsibleUserId: async () => f.user.id,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: { filterZombieCoalesceTarget: f.deps.filterZombieCoalesceTarget,
        mergeCoalescedContextSnapshot, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    f.deps.wakeQueue.createAdmissionTransactionScope.mockImplementation(admission.createAdmissionTransactionScope);
    f.deps.wakeQueue.admitWakeBehindIssueExecution.mockImplementation(admission.admitWakeBehindIssueExecution);
    let releaseAvailability!: () => void;
    const bothAvailable = new Promise<void>(resolve => { releaseAvailability = resolve; });
    let arrivals = 0;
    const service = contextCompactionService(db, { wakeup: async (...args) => {
      if (++arrivals === 2) releaseAvailability();
      await bothAvailable;
      return f.queue.enqueueWakeup(...args);
    } });
    const results = await Promise.allSettled([0, 1].map(() => service.request({
      companyId: f.company.id, issue: f.issue, userId: f.user.id,
    })));
    // Inspect both forms of durable execution authority before asserting.
    // A saved deferred maintenance request can replay after the first run;
    // counting only currently admitted runs would miss that extra work.
    const maintenanceRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id));
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id));
    const maintenanceReceipts = receipts.filter(row => row.status !== "skipped"
      && row.payload?.intent === "context_compaction" && row.payload.issueId === f.issue.id);
    expect(arrivals).toBe(2);
    expect(maintenanceReceipts.map(row => ({ id: row.id, status: row.status, runId: row.runId })),
      "one durable compaction authority including deferred").toHaveLength(1);
    expect(maintenanceRuns.map(run => run.id)).toHaveLength(1);
    expect(maintenanceRuns[0]).toMatchObject({ companyId: f.company.id, contextSnapshot: { issueId: f.issue.id } });
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(result => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === "rejected") expect(rejected[0].reason).toMatchObject({ code: "already_pending" });
    expect(receipts.filter(row => row.status === "deferred_issue_execution")).toEqual([]);
    expect(receipts.filter(row => row.reason === "context_compaction" && row.status !== "skipped")).toHaveLength(1);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("preserves an existing deferred compaction authority until cancellation allows a new request", async () => {
    const f = await waitingCompactionFixture();
    f.deps.getSchedulingSuppression.mockReset().mockResolvedValue({ suppressed: true, reason: "task_drain" });
    // Reproduce a pre-existing receipt through the actual normal deferred
    // writer. In particular, its informational reason is NOT context_compaction.
    // The service builds the real request; no provider/result rows are seeded.
    const historical = contextCompactionService(db, { wakeup: async (agentId, options) => {
      const source = options.source ?? "on_demand";
      const triggerDetail = options.triggerDetail ?? null;
      const context = enrichWakeContextSnapshot({ contextSnapshot: { ...options.contextSnapshot },
        reason: options.reason ?? null, source, triggerDetail, payload: options.payload ?? null });
      await db.transaction(async tx => {
        await createWakeAdmissionWriter().insertNewDeferredWake(TransactionScope.create(f.company.id, tx), {
          companyId: f.company.id, agentId, source, triggerDetail,
          payload: { ...options.payload, manualUserWake: true, [DEFERRED_WAKE_CONTEXT_KEY]: context.contextSnapshot },
          requestedByActorType: options.requestedByActorType ?? null,
          requestedByActorId: options.requestedByActorId ?? null, idempotencyKey: options.idempotencyKey ?? null,
        });
      });
      return null;
    } });
    await expect(historical.request({ companyId: f.company.id, issue: f.issue, userId: f.user.id }))
      .rejects.toMatchObject({ code: "wake_skipped" });
    const [pending] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id));
    expect(pending).toMatchObject({ reason: "issue_execution_deferred", status: "deferred_issue_execution", runId: null,
      payload: { issueId: f.issue.id, intent: "context_compaction" } });
    await expect(f.service.request({ companyId: f.company.id, issue: f.issue, userId: f.user.id }))
      .rejects.toMatchObject({ code: "already_pending" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id))).toEqual([pending]);
    // This never-dispatched fixture authority is now cancelled, not completed.
    // Nonpending history must not permanently block a fresh normal request.
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(agentWakeupRequests.id, pending.id));
    const accepted = await f.service.request({ companyId: f.company.id, issue: f.issue, userId: f.user.id });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id)))
      .toEqual([expect.objectContaining({ id: accepted.runId, status: "queued" })]);
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id));
    expect(receipts).toHaveLength(2);
    expect(receipts.find(row => row.id === pending.id)).toMatchObject({ status: "cancelled", runId: null });
    expect(receipts.find(row => row.runId === accepted.runId)).toMatchObject({ status: "queued" });
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it.each([
    { actor: "missing actor", userId: "", message: "Manual wake requires an authenticated user" },
    { actor: "foreign owner", userId: "another-conversation-owner", message: "Only the conversation owner can start a chat run" },
  ])("refuses waiting-conversation compaction from a $actor", async ({ userId, message }) => {
    const f = await waitingCompactionFixture();
    await expect(f.service.request({ companyId: f.company.id, issue: f.issue, userId })).rejects.toThrow(message);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id))).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["missing request", "malformed request", "mismatched request"] as const)(
    "rejects a waiting-conversation compaction envelope with a %s", async kind => {
      const f = await waitingCompactionFixture();
      const service = contextCompactionService(db, { wakeup: (agentId, options) => {
        const contextSnapshot = { ...options.contextSnapshot };
        const payload = { ...options.payload };
        if (kind === "missing request") delete contextSnapshot.contextCompactionRequestId;
        if (kind === "malformed request") payload.requestId = { unexpected: true };
        if (kind === "mismatched request") payload.requestId = randomUUID();
        return f.queue.enqueueWakeup(agentId, { ...options, contextSnapshot, payload });
      } });
      await expect(service.request({ companyId: f.company.id, issue: f.issue, userId: f.user.id }))
        .rejects.toMatchObject({ code: "wake_skipped" });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0])
        .toMatchObject({ status: "in_review", conversationState: "waiting" });
      expect(f.deps.executeRun).not.toHaveBeenCalled();
    });

  it("does not turn an ordinary waiting-conversation wake into compaction authority", async () => {
    const f = await waitingCompactionFixture();
    expect(await f.queue.enqueueWakeup(f.agent.id, { source: "on_demand", triggerDetail: "manual",
      reason: "issue.continuation_recovery", requestedByActorType: "user", requestedByActorId: f.user.id,
      manualUserWake: true, allowRunCoalescing: false, payload: { issueId: f.issue.id },
      contextSnapshot: { issueId: f.issue.id } })).toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id))).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it("keeps closed tasks ineligible for a compaction request", async () => {
    const f = await waitingCompactionFixture();
    const [closed] = await db.insert(issues).values({ companyId: f.company.id, title: "Closed task",
      status: "done", assigneeAgentId: f.agent.id }).returning();
    if (!closed) throw new Error("Missing closed task");
    await expect(f.service.request({ companyId: f.company.id, issue: closed, userId: f.user.id }))
      .rejects.toMatchObject({ code: "task_closed" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id))).toHaveLength(0);
  });

  it("keeps a busy conversation ineligible for a second compaction run", async () => {
    const f = await waitingCompactionFixture();
    const [running] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      issueId: f.issue.id, scopeKind: "issue", status: "running" }).returning();
    if (!running) throw new Error("Missing active conversation run");
    await expect(f.service.request({ companyId: f.company.id, issue: f.issue, userId: f.user.id }))
      .rejects.toMatchObject({ code: "agent_busy" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).map(run => run.id))
      .toEqual([running.id]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id))).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["comment", "interaction", "ordinary task"] as const)("preserves admission for a current %s", async cause => {
    const f = await waitingConversationFixture();
    const context: Record<string, unknown> = { issueId: f.issue.id, source: "issue.continuation_recovery" };
    const payload: Record<string, unknown> = { issueId: f.issue.id };
    if (cause === "comment") {
      const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id,
        authorUserId: f.user.id, body: "A new question" }).returning();
      context.wakeCommentId = comment.id;
      payload.commentId = comment.id;
    } else if (cause === "interaction") {
      const [interaction] = await db.insert(issueThreadInteractions).values({ companyId: f.company.id,
        issueId: f.issue.id, createdByAgentId: f.agent.id, kind: "ask_user_questions", status: "answered",
        resolvedByUserId: f.user.id, resolvedAt: new Date(),
        payload: { version: 1, questions: [{ id: "q", prompt: "Continue?", selectionMode: "single",
          options: [{ id: "a", label: "Continue" }] }] },
        result: { version: 1, answers: [{ questionId: "q", optionIds: ["a"] }] } }).returning();
      Object.assign(context, { source: "issue.interaction.respond", interactionId: interaction.id,
        interactionKind: interaction.kind, interactionStatus: interaction.status });
      Object.assign(payload, { mutation: "interaction", interactionId: interaction.id });
    } else {
      await db.update(issues).set({ conversationAgentId: null, conversationUserId: null,
        conversationState: null, status: "in_progress" }).where(eq(issues.id, f.issue.id));
    }
    const admitted = await f.queue.enqueueWakeup(f.agent.id, { source: "automation", triggerDetail: "system",
      reason: cause === "ordinary task" ? "issue.continuation_recovery" : "issue_commented",
      requestedByActorType: "system", payload, contextSnapshot: context });
    expect(admitted).toMatchObject({ agentId: f.agent.id, status: "queued" });
    expect(f.deps.executeRun).not.toHaveBeenCalled();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agent.id)))
      .toHaveLength(1);
  });

  it("delivers a real task completion to its waiting conversation", async () => {
    const f = await waitingConversationFixture();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "succeeded", finishedAt: new Date(), contextSnapshot: { issueId: f.issue.id, conversationSessionGeneration: 0 } }).returning();
    const [task] = await db.insert(issues).values({ companyId: f.company.id, title: "Handed-off task",
      status: "in_progress", createdByAgentId: f.agent.id }).returning();
    await recordChatHandoff(db, task, source.id);
    const recorded = await db.transaction(async tx => {
      const [done] = await tx.update(issues).set({ status: "done" }).where(eq(issues.id, task.id)).returning();
      return recordChatCompletion(tx, task, done);
    });
    expect(recorded).toBe(true);
    await chatCompletionDeliveryService(db, { wakeup: (agentId, options) => f.queue.enqueueWakeup(agentId, options) }).sweepPending();
    const [delivery] = await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.companyId, f.company.id));
    expect(delivery).toMatchObject({ status: "queued" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivery.targetRunId!));
    expect(run).toMatchObject({ agentId: f.agent.id, status: "queued" });
    expect(run.contextSnapshot).toMatchObject({ issueId: f.issue.id, wakeReason: "chat_task_completed" });
    expect(f.deps.executeRun).not.toHaveBeenCalled();
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

  async function pendingPredecessorFixture() {
    const f = await fixture("queued");
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      issueId: f.issue.id, status: "failed", runtimeMode: "legacy", finishedAt: new Date(),
      executionStage: "preparing", errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: f.issue.id } }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.company.id, issueId: f.issue.id,
      heartbeatRunId: source.id, provider: "daytona", providerLeaseId: crypto.randomUUID(), status: "active" }).returning();
    const [successor] = await db.update(heartbeatRuns).set({ retryOfRunId: source.id, responsibleUserId: "queue-test-user",
      contextSnapshot: { issueId: f.issue.id, source: "issue.continuation_recovery", retryOfRunId: source.id,
        wakeReason: "issue_continuation_needed" } }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(f.agent);
    return { ...f, source, lease, successor, deps, queue: createHeartbeatQueue(db, deps) };
  }

  it.each([
    ["issue_continuation_needed", "cancelled"], ["issue_recovery_action_restored", "cancelled"], ["issue_commented", "running"],
  ] as const)("does not start a %s run whose task another run already finished (expected %s)", async (wakeReason, expected) => {
    // Release-swap wave t011: a delivered continuation queued while its task was open started after
    // another run marked the task done, and took an extra turn on a finished task.
    const f = await fixture("queued");
    await db.update(issues).set({ status: "done", executionRunId: null }).where(eq(issues.id, f.issue.id));
    // A person's message wake carries the comment it answers.
    const wakeCommentId = wakeReason === "issue_commented"
      ? (await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id, authorAgentId: f.agent.id,
        body: "One more thing" }).returning())[0].id
      : undefined;
    const [queued] = await db.update(heartbeatRuns).set({ responsibleUserId: "queue-test-user",
      contextSnapshot: { issueId: f.issue.id, wakeReason, ...(wakeCommentId ? { wakeCommentId } : {}) } })
      .where(eq(heartbeatRuns.id, f.run.id)).returning();
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(f.agent);
    const queue = createHeartbeatQueue(db, deps);
    const claimed = await queue.claimQueuedRun(queued);
    if (expected === "cancelled") {
      expect(claimed).toBeNull();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id)))[0])
        .toMatchObject({ status: "cancelled", errorCode: "issue_closed_before_start" });
    } else {
      // A person's message on a done task still runs (and reopens it through the normal path).
      expect(claimed).toMatchObject({ id: queued.id, status: "running" });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id)))[0])
        .toMatchObject({ status: "running", errorCode: null });
    }
  });

  it.each([
    { label: "still undelivered", delivered: false },
    { label: "already read by the closing run", delivered: true },
  ])("answers a person's message attached to a system continuation on a closed task once ($label)", async ({ delivered }) => {
    // Admission can attach a deferred comment to a queued system continuation without changing its
    // wake reason. The claim-time closed-task cancel must not consume that person's message.
    const f = await fixture("queued");
    const [comment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id,
      authorType: "user", authorUserId: "queue-test-user", body: "Can you also update the changelog?" }).returning();
    if (delivered) {
      // The run that closed the task received the message as its own wake input.
      const startedAt = new Date(comment.createdAt.getTime() + 1_000);
      await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "succeeded",
        invocationSource: "assignment", startedAt, finishedAt: new Date(startedAt.getTime() + 1_000),
        contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_commented", wakeCommentIds: [comment.id] } });
    }
    await db.update(issues).set({ status: "done", executionRunId: null }).where(eq(issues.id, f.issue.id));
    const [queued] = await db.update(heartbeatRuns).set({ responsibleUserId: "queue-test-user",
      contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_continuation_needed", wakeCommentIds: [comment.id] } })
      .where(eq(heartbeatRuns.id, f.run.id)).returning();
    // The continuation's wake is still queued and bound to the run, as admission leaves it.
    await db.update(agentWakeupRequests).set({ status: "queued", claimedAt: null, runId: queued.id })
      .where(eq(agentWakeupRequests.id, f.wake.id));
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(f.agent);
    const claimed = await createHeartbeatQueue(db, deps).claimQueuedRun(queued);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id));
    if (delivered) {
      expect(claimed).toBeNull();
      expect(runs.find(row => row.id === queued.id)).toMatchObject({ status: "cancelled", errorCode: "issue_closed_before_start" });
      expect(runs).toHaveLength(2);
    } else {
      // Exactly one run answers it: this one, claimed as the person's follow-up.
      expect(claimed).toMatchObject({ id: queued.id, status: "running" });
      expect(runs.filter(row => row.status !== "succeeded")).toEqual([expect.objectContaining({ id: queued.id, status: "running" })]);
    }
  });

  it("keeps the result of a continuation another dispatcher already started and finished", async () => {
    // Two servers overlap during a swap: both read the same queued continuation; one starts it and
    // the run closes the task before the other reaches the closed-task check with its stale copy.
    const f = await fixture("queued");
    const [staleQueued] = await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_continuation_needed" } })
      .where(eq(heartbeatRuns.id, f.run.id)).returning();
    const finishedAt = new Date();
    await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: finishedAt, finishedAt,
      resultJson: { summary: "Finished by the other server" } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(issues).set({ status: "done", executionRunId: null }).where(eq(issues.id, f.issue.id));
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(f.agent);
    expect(await createHeartbeatQueue(db, deps).claimQueuedRun(staleQueued)).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toMatchObject({
      status: "succeeded", errorCode: null, resultJson: { summary: "Finished by the other server" } });
    expect(deps.setWakeupStatus).not.toHaveBeenCalled();
    expect(deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
  });

  it("returns the claim to the queue when run admission closes while the claim is being checked", async () => {
    // SIGTERM (drain) or the hand-over yield can close admission during claimQueuedRun's awaited
    // checks, after its first admission check passed. The run must stay exactly as it was.
    const f = await fixture("queued");
    const [queued] = await db.update(heartbeatRuns).set({ responsibleUserId: "queue-test-user",
      contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_commented" } })
      .where(eq(heartbeatRuns.id, f.run.id)).returning();
    const [issueBefore] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    let admissionClosed = false;
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(f.agent);
    deps.isRunAdmissionClosed = () => admissionClosed;
    deps.budgets.getInvocationBlock.mockImplementation(async () => { admissionClosed = true; return null; });
    expect(await createHeartbeatQueue(db, deps).claimQueuedRun(queued)).toBeNull();
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
    expect(stored).toMatchObject({ status: "queued", startedAt: null, finishedAt: null, errorCode: null,
      responsibleUserId: queued.responsibleUserId, runnerProfileJson: queued.runnerProfileJson });
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]).toMatchObject({
      executionRunId: issueBefore.executionRunId, executionLockedAt: issueBefore.executionLockedAt });
    expect(deps.setWakeupStatus).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("keeps an automatic continuation queued while its legacy predecessor still owns cleanup", async () => {
    const { successor, lease, queue, deps, ...f } = await pendingPredecessorFixture();
    expect(await queue.claimQueuedRun(successor)).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor.id)))[0].status).toBe("queued");
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].executionRunId).toBe(successor.id);
    expect(deps.executeRun).not.toHaveBeenCalled();

    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, lease.id));
    expect(await queue.claimQueuedRun(successor)).toMatchObject({ id: successor.id, status: "running" });
    expect(await queue.claimQueuedRun(successor)).toBeNull();
  });

  async function reassignedPredecessorFixture(previousStatus = "cancelled") {
    const f = await fixture("queued");
    await db.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, f.issue.id));
    const [previousAgent] = await db.insert(agents).values({ companyId: f.company.id, name: "Previous owner",
      role: "engineer", status: "idle", adapterType: "paperclip_runner", adapterConfig: {} }).returning();
    const [previous] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: previousAgent.id,
      status: previousStatus, runtimeMode: "native", invocationSource: "assignment", startedAt: new Date(),
      finishedAt: previousStatus === "running" ? null : new Date(), nativeIssueId: f.issue.id,
      errorCode: previousStatus === "cancelled" ? "issue_reassigned" : null,
      contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_assigned" } }).returning();
    const [next] = await db.update(heartbeatRuns).set({ responsibleUserId: "queue-test-user",
      contextSnapshot: { issueId: f.issue.id, wakeReason: "issue_assigned" } })
      .where(eq(heartbeatRuns.id, f.run.id)).returning();
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(f.agent);
    deps.activeRunExecutions.add(previous.id);
    return { ...f, previousAgent, previous, next, deps, queue: createHeartbeatQueue(db, deps) };
  }

  it("keeps the new owner's run queued while the reassigned owner's stopped run still settles", async () => {
    const f = await reassignedPredecessorFixture();
    expect(await f.queue.claimQueuedRun(f.next)).toBeNull();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.next.id)))[0])
      .toMatchObject({ status: "queued", startedAt: null });
    expect(f.deps.executeRun).not.toHaveBeenCalled();

    f.deps.activeRunExecutions.delete(f.previous.id);
    expect(await f.queue.claimQueuedRun(f.next)).toMatchObject({ id: f.next.id, status: "running" });
  });

  it("does not hold a run behind another agent's live run on the same task", async () => {
    const f = await reassignedPredecessorFixture("running");
    expect(await f.queue.claimQueuedRun(f.next)).toMatchObject({ id: f.next.id, status: "running" });
  });

  it("wakes queued dispatch for the task's next owner once the previous owner's execution settles", async () => {
    const f = await reassignedPredecessorFixture();
    let wakes = 0;
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.queuedRunDispatch, () => { wakes += 1; });
    try {
      expect(await notifyOtherAgentsQueuedOnSettledIssue(db, f.previous)).toBe(true);
      await vi.waitFor(() => expect(wakes).toBeGreaterThan(0));
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.next.id));
      expect(await notifyOtherAgentsQueuedOnSettledIssue(db, f.previous)).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("keeps a retry queued after failed cleanup and until its local executor releases", async () => {
    const f = await pendingPredecessorFixture();
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "failed" })
      .where(eq(environmentLeases.id, f.lease.id));
    expect(await f.queue.claimQueuedRun(f.successor)).toBeNull();
    await db.update(environmentLeases).set({ cleanupStatus: "success" }).where(eq(environmentLeases.id, f.lease.id));
    f.deps.liveRunExecutions.has.mockImplementation(id => id === f.source.id);
    expect(await f.queue.claimQueuedRun(f.successor)).toBeNull();
    f.deps.liveRunExecutions.has.mockReturnValue(false);
    expect(await f.queue.claimQueuedRun(f.successor)).toMatchObject({ id: f.successor.id, status: "running" });
  });

  it.each(["missing", "foreign company", "other task", "other agent", "native task overrides context"] as const)(
    "does not hold a queued run for a %s retry source", async mismatch => {
      const f = await pendingPredecessorFixture();
      let sourceId = f.source.id;
      if (mismatch === "missing") {
        await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, sourceId));
        expect(await f.queue.claimQueuedRun(f.successor)).toMatchObject({ id: f.successor.id, status: "running" });
        return;
      } else if (mismatch === "foreign company") {
        const [company] = await db.insert(companies).values({ name: "Unrelated company", issuePrefix: "OTHER" }).returning();
        const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Other company worker", adapterType: "process" }).returning();
        const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
          status: "failed", finishedAt: new Date() }).returning();
        sourceId = source.id;
        await db.insert(environmentLeases).values({ companyId: company.id, heartbeatRunId: sourceId, status: "active", provider: "daytona" });
      } else if (mismatch === "other agent") {
        const [other] = await db.insert(agents).values({ companyId: f.company.id, name: "Another worker", adapterType: "process" }).returning();
        const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: other.id, issueId: f.issue.id,
          status: "failed", finishedAt: new Date() }).returning();
        sourceId = source.id;
        await db.insert(environmentLeases).values({ companyId: f.company.id, heartbeatRunId: sourceId, status: "active", provider: "daytona" });
      } else {
        const [other] = await db.insert(issues).values({ companyId: f.company.id, title: "Another task" }).returning();
        const [source] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, issueId: other.id,
          ...(mismatch === "native task overrides context" ? { nativeIssueId: other.id } : {}),
          contextSnapshot: { issueId: f.issue.id }, status: "failed", finishedAt: new Date() }).returning();
        sourceId = source.id;
        await db.insert(environmentLeases).values({ companyId: f.company.id, heartbeatRunId: sourceId, status: "active", provider: "daytona" });
      }
      const [successor] = await db.update(heartbeatRuns).set({ retryOfRunId: sourceId })
        .where(eq(heartbeatRuns.id, f.successor.id)).returning();
      expect(await f.queue.claimQueuedRun(successor)).toMatchObject({ id: successor.id, status: "running" });
    },
  );

  it("retains the current execution owner's hold when retry provenance is unrelated", async () => {
    const f = await pendingPredecessorFixture();
    const [unrelated] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "succeeded", finishedAt: new Date() }).returning();
    const [successor] = await db.update(heartbeatRuns).set({ retryOfRunId: unrelated.id })
      .where(eq(heartbeatRuns.id, f.successor.id)).returning();
    await db.update(issues).set({ executionRunId: f.source.id }).where(eq(issues.id, f.issue.id));
    expect(await f.queue.claimQueuedRun(successor)).toBeNull();
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].executionRunId).toBe(f.source.id);
  });

  it.each((["process", "paperclip_runner"] as const).flatMap(adapterType => (["coalesced", "claimed-primary", "legacy-envelope", "delete-old", "delete-new", "stopped", "running", "system-primary", "foreign-primary", "same-named-agent", "mixed-author"] as const).map(scenario => ({ adapterType, scenario }))))("protects a queued comment batch across $adapterType/$scenario", async ({ adapterType, scenario }) => {
    const f = await fixture("queued");
    let admissionAgent: typeof agents.$inferSelect = { ...f.agent, adapterType, adapterConfig: adapterType === "paperclip_runner" ? { provider: "codex" } : {} };
    await db.update(agents).set({ adapterType, adapterConfig: admissionAgent.adapterConfig }).where(eq(agents.id, f.agent.id));
    if (scenario === "same-named-agent") [admissionAgent] = await db.insert(agents).values({ companyId: f.company.id,
      name: f.agent.name.toUpperCase(), role: "engineer", status: "idle", adapterType, adapterConfig: admissionAgent.adapterConfig,
    }).returning();
    const userId = `source-user-${f.company.id}`;
    await db.insert(authUsers).values({ id: userId, name: "Source owner", email: `${f.company.id}@queue.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
    await db.update(companies).set({ defaultResponsibleUserId: userId }).where(eq(companies.id, f.company.id));
    const incomingActorId = scenario === "mixed-author" ? `second-user-${f.company.id}` : userId;
    if (scenario === "mixed-author") {
      await db.insert(authUsers).values({ id: incomingActorId, name: "Incoming source owner", email: `${incomingActorId}@queue.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: incomingActorId, status: "active", membershipRole: "operator" });
    }
    const [oldComment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id,
      authorType: "user", authorUserId: userId, body: "Review source A" }).returning();
    const [newComment] = await db.insert(issueComments).values({ companyId: f.company.id, issueId: f.issue.id,
      authorType: "user", authorUserId: incomingActorId, body: "Review source B" }).returning();
    await db.update(agentWakeupRequests).set({ status: scenario === "claimed-primary" ? "claimed" : "queued", runId: f.run.id, claimedAt: null,
      requestedByActorType: scenario === "system-primary" ? "system" : "user", requestedByActorId: scenario === "system-primary" ? null : userId,
      payload: scenario === "legacy-envelope" ? { issueId: f.issue.id, commentId: oldComment.id }
        : withQueuedCommentIdsInWakePayload({ issueId: f.issue.id, retainedSource: "original-source" }, [oldComment.id]),
    }).where(eq(agentWakeupRequests.id, f.wake.id));
    const [scanned] = await db.update(heartbeatRuns).set({ responsibleUserId: userId,
      contextSnapshot: withQueuedCommentIdsInRunContext({ issueId: f.issue.id, wakeReason: "issue_commented" }, [oldComment.id]),
    }).where(eq(heartbeatRuns.id, f.run.id)).returning();
    let foreignPrimary: typeof agentWakeupRequests.$inferSelect | undefined;
    if (scenario === "foreign-primary") {
      const [company] = await db.insert(companies).values({ name: "Foreign source", issuePrefix: "FOREIGN" }).returning();
      const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Foreign source agent", adapterType: "process" }).returning();
      [foreignPrimary] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "assignment", status: "queued", payload: { source: "foreign" } }).returning();
      await db.update(heartbeatRuns).set({ wakeupRequestId: foreignPrimary.id }).where(eq(heartbeatRuns.id, f.run.id));
    }
    if (scenario === "delete-old") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, oldComment.id));
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(admissionAgent);
    deps.canStartNewExternalBotWork.mockResolvedValue(false);
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false, enableNativeRunner: true } as Awaited<ReturnType<HeartbeatQueueDependencies["instanceSettings"]["getExperimental"]>>);
    const admission = createWakeQueue(db, {
      resolveResponsibleUserId: async () => userId,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
      wakeAdmissionHelpers: { filterZombieCoalesceTarget: deps.filterZombieCoalesceTarget,
        mergeCoalescedContextSnapshot, shouldDeferFollowupWakeForSameIssue, shouldQueueFollowupForRunningIssueWake },
      recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined },
    });
    deps.wakeQueue.createAdmissionTransactionScope.mockImplementation(admission.createAdmissionTransactionScope);
    deps.wakeQueue.admitWakeBehindIssueExecution.mockImplementation(admission.admitWakeBehindIssueExecution);
    const queue = createHeartbeatQueue(db, deps);
    if (scenario === "running") {
      deps.canStartNewExternalBotWork.mockResolvedValue(true);
      expect(await queue.claimQueuedRun(scanned)).toMatchObject({ status: "running" });
      deps.canStartNewExternalBotWork.mockResolvedValue(false);
    }
    const [originalPrimary] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    const coalesced = await queue.enqueueWakeup(admissionAgent.id, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      payload: { issueId: f.issue.id, commentId: newComment.id }, contextSnapshot: { issueId: f.issue.id, wakeCommentId: newComment.id },
      requestedByActorType: "user", requestedByActorId: incomingActorId });
    if (["running", "foreign-primary", "same-named-agent"].includes(scenario)) {
      expect(coalesced).toBeNull();
      const [preserved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
      expect(preserved.contextSnapshot).toMatchObject({ wakeCommentId: oldComment.id, wakeCommentIds: [oldComment.id] });
      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id));
      expect(receipts.find(row => row.id !== f.wake.id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(receipts.find(row => row.id === f.wake.id)).toEqual(originalPrimary);
      if (scenario === "same-named-agent") {
        expect(preserved).toEqual(scanned);
        expect(receipts.find(row => row.id !== f.wake.id)).toMatchObject({ agentId: admissionAgent.id,
          requestedByActorType: "user", requestedByActorId: incomingActorId, payload: { issueId: f.issue.id, commentId: newComment.id } });
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toEqual([scanned]);
      }
      if (foreignPrimary) expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, foreignPrimary.id)))[0]).toEqual(foreignPrimary);
      expect(deps.executeRun).not.toHaveBeenCalled();
      return;
    }
    expect(coalesced).toMatchObject({ id: f.run.id, status: "queued", contextSnapshot: { wakeCommentIds: [oldComment.id, newComment.id] } });
    const accepted = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id));
    expect(accepted.find(row => row.id !== f.wake.id)).toMatchObject({ status: "coalesced", runId: f.run.id, finishedAt: expect.any(Date),
      requestedByActorType: "user", requestedByActorId: incomingActorId });
    const [updatedPrimary] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    expect(updatedPrimary).toMatchObject({ id: originalPrimary.id, companyId: originalPrimary.companyId,
      agentId: originalPrimary.agentId, source: originalPrimary.source, requestedByActorType: originalPrimary.requestedByActorType,
      requestedByActorId: originalPrimary.requestedByActorId, idempotencyKey: originalPrimary.idempotencyKey, requestedAt: originalPrimary.requestedAt });
    if (scenario === "legacy-envelope" || scenario === "claimed-primary") expect(updatedPrimary.payload).toEqual(originalPrimary.payload);
    else expect(updatedPrimary.payload).toMatchObject({ retainedSource: "original-source", commentId: oldComment.id,
      _paperclipWakeContext: { commentId: oldComment.id, wakeCommentId: oldComment.id, wakeCommentIds: [oldComment.id, newComment.id] } });
    if (scenario === "claimed-primary") {
      deps.canStartNewExternalBotWork.mockResolvedValue(true);
      expect(await queue.claimQueuedRun(scanned)).toBeNull();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0])
        .toMatchObject({ status: "queued", contextSnapshot: { wakeCommentIds: [oldComment.id, newComment.id] } });
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id)))[0]).toEqual(originalPrimary);
      expect(deps.executeRun).not.toHaveBeenCalled();
      return;
    }
    if (scenario === "stopped") {
      await createHeartbeatRunControl(db, runControlCallbacks(db)).cancelRunInternal(f.run.id, "operator Stop");
      deps.canStartNewExternalBotWork.mockResolvedValue(true);
      expect(await queue.claimQueuedRun(scanned)).toBeNull();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0])
        .toMatchObject({ status: "cancelled", contextSnapshot: { wakeCommentIds: [oldComment.id, newComment.id] } });
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id)))[0].status).toBe("cancelled");
      expect(deps.executeRun).not.toHaveBeenCalled();
      return;
    }
    if (scenario === "delete-new") await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, newComment.id));
    deps.canStartNewExternalBotWork.mockResolvedValue(true);
    const claimed = await queue.claimQueuedRun(scanned);
    expect(claimed).toMatchObject({ id: f.run.id, status: "running",
      contextSnapshot: { wakeCommentId: scenario === "delete-new" ? oldComment.id : newComment.id,
        wakeCommentIds: scenario === "delete-old" ? [newComment.id] : scenario === "delete-new" ? [oldComment.id] : [oldComment.id, newComment.id] } });
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id));
    expect(receipts.find(row => row.id !== f.wake.id)).toMatchObject({ status: "coalesced", runId: f.run.id });
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

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

  async function addStrandedMessages(seeded: Awaited<ReturnType<typeof strandedMention>>) {
    const messages = [seeded.pending];
    for (let index = 0; index < 2; index++) {
      const [comment] = await db.insert(issueComments).values({ companyId: seeded.company.id, issueId: seeded.issue.id,
        body: `Additional saved feedback ${index}`, authorAgentId: seeded.agent.id }).returning();
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: seeded.company.id, agentId: seeded.recipient.id,
        source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution",
        payload: { issueId: seeded.issue.id, _paperclipWakeContext: { issueId: seeded.issue.id,
          wakeReason: "issue_comment_mentioned", wakeCommentIds: [comment.id] } } }).returning();
      messages.push(wake);
    }
    await db.update(agentWakeupRequests).set({ updatedAt: new Date(0) }).where(inArray(agentWakeupRequests.id, messages.map(row => row.id)));
    return messages;
  }

  async function expectSavedMessages(messages: Awaited<ReturnType<typeof addStrandedMessages>>) {
    const rows = await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, messages.map(row => row.id)));
    expect(rows).toHaveLength(messages.length);
    for (const before of messages) {
      const row = rows.find(row => row.id === before.id)!;
      expect(row).toMatchObject({ payload: before.payload, status: "deferred_issue_execution", runId: null,
        finishedAt: null, error: null });
      expect(row.updatedAt.getTime()).toBeGreaterThan(0);
    }
  }

  it.each(["legacy", "native"])("keeps saved %s messages while avoiding repeated native source release", async runtimeMode => {
    const seeded = await strandedMention(runtimeMode);
    const messages = await addStrandedMessages(seeded);
    const deps = callbacks(db), queue = createHeartbeatQueue(db, deps);
    await queue.resumeQueuedRuns();
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledTimes(runtimeMode === "native" ? 1 : 3);
    await expectSavedMessages(messages);
    await queue.resumeQueuedRuns();
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledTimes(runtimeMode === "native" ? 2 : 6);
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("retries a rejected native release on the next saved message", async () => {
    const seeded = await strandedMention("native"), messages = await addStrandedMessages(seeded);
    const deps = callbacks(db);
    deps.releaseIssueExecutionAndPromote.mockRejectedValueOnce(new Error("Fixture release remains pending"));
    await createHeartbeatQueue(db, deps).resumeQueuedRuns();
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledTimes(2);
    await expectSavedMessages(messages);
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("joins the native release before it suppresses another message's duplicate check", async () => {
    const seeded = await strandedMention("native"), messages = await addStrandedMessages(seeded);
    const deps = callbacks(db);
    let finish!: () => void;
    deps.releaseIssueExecutionAndPromote.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    let settled = false;
    const pending = createHeartbeatQueue(db, deps).resumeQueuedRuns().then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledTimes(1));
      expect(settled).toBe(false);
    } finally { finish?.(); }
    await pending;
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledTimes(1);
    await expectSavedMessages(messages);
  });

  it("rechecks a different native source that completes during the pass", async () => {
    const seeded = await strandedMention("native"), messages = await addStrandedMessages(seeded);
    await db.update(heartbeatRuns).set({ createdAt: new Date(0) }).where(eq(heartbeatRuns.id, seeded.run.id));
    const deps = callbacks(db);
    let nextId: string | undefined;
    deps.releaseIssueExecutionAndPromote.mockImplementationOnce(async () => {
      const [next] = await db.insert(heartbeatRuns).values({ companyId: seeded.company.id, agentId: seeded.agent.id,
        runtimeMode: "native", nativeIssueId: seeded.issue.id, status: "succeeded", finishedAt: new Date(),
        contextSnapshot: { issueId: seeded.issue.id } }).returning();
      nextId = next.id;
    });
    await createHeartbeatQueue(db, deps).resumeQueuedRuns();
    expect(deps.releaseIssueExecutionAndPromote.mock.calls.map(([run]) => run.id)).toEqual([seeded.run.id, nextId]);
    await expectSavedMessages(messages);
  });

  it("rechecks changed native evidence on the same source run", async () => {
    const seeded = await strandedMention("native"), messages = await addStrandedMessages(seeded);
    const deps = callbacks(db);
    deps.releaseIssueExecutionAndPromote.mockImplementationOnce(async () => {
      await db.update(heartbeatRuns).set({ resultJson: { observedReceipt: "new evidence" } }).where(eq(heartbeatRuns.id, seeded.run.id));
    });
    await createHeartbeatQueue(db, deps).resumeQueuedRuns();
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledTimes(2);
    expect(deps.releaseIssueExecutionAndPromote.mock.calls.map(([run]) => run.id)).toEqual([seeded.run.id, seeded.run.id]);
    await expectSavedMessages(messages);
  });

  it("checks each unrelated native task in the same pass", async () => {
    const seeded = await strandedMention("native"), firstMessages = await addStrandedMessages(seeded);
    const [issue] = await db.insert(issues).values({ companyId: seeded.company.id, title: "Another saved task", status: "todo", assigneeAgentId: seeded.agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: seeded.company.id, agentId: seeded.agent.id,
      runtimeMode: "native", nativeIssueId: issue.id, status: "succeeded", finishedAt: new Date(), contextSnapshot: { issueId: issue.id } }).returning();
    const [comment] = await db.insert(issueComments).values({ companyId: seeded.company.id, issueId: issue.id,
      body: "Other task feedback", authorAgentId: seeded.agent.id }).returning();
    const [pending] = await db.insert(agentWakeupRequests).values({ companyId: seeded.company.id, agentId: seeded.recipient.id,
      source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      payload: { issueId: issue.id, _paperclipWakeContext: { issueId: issue.id, wakeReason: "issue_comment_mentioned", wakeCommentIds: [comment.id] } } }).returning();
    const secondMessages = await addStrandedMessages({ ...seeded, issue, run, pending });
    const deps = callbacks(db);
    await createHeartbeatQueue(db, deps).resumeQueuedRuns();
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledTimes(2);
    expect(new Set(deps.releaseIssueExecutionAndPromote.mock.calls.map(([row]) => row.id))).toEqual(new Set([seeded.run.id, run.id]));
    await expectSavedMessages([...firstMessages, ...secondMessages]);
  });

  // H1 bug C review: a queued run admission cancels for a board-owned budget
  // block records which budget stopped it, so Raise budget and resume can
  // continue it.
  async function admissionBudgetBlock(options: { openIncident: boolean }) {
    const fixtureRows = await fixture("queued");
    const { company, agent } = fixtureRows;
    const [policy] = await db.insert(budgetPolicies).values({ companyId: company.id, scopeType: "company", scopeId: company.id,
      windowKind: "lifetime", amount: 1, hardStopEnabled: true, isActive: true }).returning();
    await db.insert(costEvents).values({ companyId: company.id, agentId: agent.id, provider: "test", model: "test",
      costCents: 5, occurredAt: new Date() });
    if (options.openIncident) await db.insert(budgetIncidents).values({ companyId: company.id, policyId: policy.id,
      scopeType: "company", scopeId: company.id, metric: "billed_cents", windowKind: "lifetime",
      windowStart: new Date(0), windowEnd: new Date(Date.now() + 86_400_000), thresholdType: "hard",
      amountLimit: 1, amountObserved: 5 });
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.budgets.getInvocationBlock.mockResolvedValue({ scopeType: "company", scopeId: company.id,
      scopeName: company.name, reason: "Company cannot start work because its budget hard-stop is still exceeded." });
    deps.cancelRunInternal.mockImplementation(async (runId: string) => {
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    });
    return { ...fixtureRows, deps };
  }

  it("leaves a queued run queued when a resume closed its budget incident first", async () => {
    // Raise budget and resume closed the incident between the admission
    // check and the cancel: the re-read finds no block, so the task runs.
    const { run, deps } = await admissionBudgetBlock({ openIncident: false });
    deps.budgets.getInvocationBlock.mockResolvedValueOnce({ scopeType: "company", scopeId: run.companyId,
      scopeName: "Budget", reason: "Company cannot start work because its budget hard-stop is still exceeded." })
      .mockResolvedValueOnce(null);
    expect(await createHeartbeatQueue(db, deps).claimQueuedRun({ ...run, responsibleUserId: "queue-test-user" })).toBeNull();
    expect(deps.cancelRunInternal).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("queued");
  });

  it("records the budget that cancelled a queued run at admission", async () => {
    const { company, agent, run, deps } = await admissionBudgetBlock({ openIncident: true });
    void agent;
    expect(await createHeartbeatQueue(db, deps).claimQueuedRun({ ...run, responsibleUserId: "queue-test-user" })).toBeNull();
    expect(deps.cancelRunInternal).toHaveBeenCalledWith(run.id, expect.stringContaining("budget"), expect.anything());
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].resultJson)
      .toMatchObject({ budgetAdmissionStop: { scopeType: "company", scopeId: company.id } });
  });

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
    const seeded = await strandedMention(runtimeMode);
    const { company, issue, recipient } = seeded;
    const messages = await addStrandedMessages(seeded);
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, recipient.id));
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issue.id));
    const deps = callbacks(db);
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => "responsible-user",
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    }), recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } });
    const controlDeps = runControlCallbacks(db);
    vi.mocked(controlDeps.wakeQueue.releaseIssueExecution).mockImplementation(release);
    const control = createHeartbeatRunControl(db, controlDeps);
    deps.releaseIssueExecutionAndPromote.mockImplementation(control.releaseIssueExecutionAndPromote);
    for (let pass = 0; pass < 2; pass++) {
      await createHeartbeatQueue(db, deps).resumeQueuedRuns();
      await expectSavedMessages(messages);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toHaveLength(1);
    }
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledTimes(runtimeMode === "native" ? 2 : 6);
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it.each(["legacy", "native"])("resumes an accepted non-assignee queue through its %s owner", async runtimeMode => {
    const { run, pending } = await strandedMention(runtimeMode);
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot, prompt: "large context".repeat(20_000) },
      runnerProfileJson: { instructions: "large profile".repeat(20_000) }, stdoutExcerpt: "large output".repeat(20_000),
    }).where(eq(heartbeatRuns.id, run.id));
    const deps = callbacks(db);
    await createHeartbeatQueue(db, deps).resumeQueuedRuns();
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: run.id }), { suppressImmediateRecovery: true, resumeStrandedQueue: true },
    );
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending.id)))[0]).toMatchObject({
      status: "deferred_issue_execution", runId: null, payload: pending.payload,
    });
    expect(deps.executeRun).not.toHaveBeenCalled();
    const selected = deps.releaseIssueExecutionAndPromote.mock.calls[0][0];
    expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThan(512);
    expect(selected).not.toHaveProperty("contextSnapshot");
    expect(selected).not.toHaveProperty("runnerProfileJson");
    expect(selected).not.toHaveProperty("stdoutExcerpt");
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
    expect(deps.setRunStatusFromLive).not.toHaveBeenCalled();
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

  it("leaves a queued run for the next server when shutdown closes admission during the queue scan", async () => {
    const { run, agent, wake } = await fixture("queued");
    await db.update(heartbeatRuns).set({ responsibleUserId: "queue-test-user" }).where(eq(heartbeatRuns.id, run.id));
    let admissionClosed = false;
    const deps = callbacks(db);
    deps.isRunAdmissionClosed = () => admissionClosed;
    deps.getAgent.mockImplementation(async () => { admissionClosed = true; return agent; });
    expect(await createHeartbeatQueue(db, deps).startNextQueuedRunForAgent(agent.id)).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toMatchObject({ status: "queued", startedAt: null });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe(wake.status);
    expect(deps.executeRun).not.toHaveBeenCalled();
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

  it("keeps a claim queued while another task of its routine holds the execution slot", async () => {
    const { company, agent, issue, run } = await fixture("queued");
    const origin = { originKind: "routine_execution", originId: crypto.randomUUID(), originFingerprint: "scheduled" };
    await db.update(issues).set({ ...origin, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null })
      .where(eq(issues.id, issue.id));
    // An earlier task of the same routine keeps its lock while its failed run waits for a scheduled resume.
    const [holder] = await db.insert(issues).values({ companyId: company.id, title: "Earlier routine task",
      status: "in_progress", assigneeAgentId: agent.id, ...origin }).returning();
    const [holderRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "failed", finishedAt: new Date(), contextSnapshot: { issueId: holder.id } }).returning();
    await db.update(issues).set({ executionRunId: holderRun.id }).where(eq(issues.id, holder.id));
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    await expect(createHeartbeatQueue(db, deps).claimQueuedRun({ ...run, responsibleUserId: "queue-test-user" }))
      .rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toMatchObject({ status: "queued" });
    expect((await db.select().from(issues).where(eq(issues.id, issue.id)))[0]).toMatchObject({ executionRunId: null });
    expect((await db.select().from(issues).where(eq(issues.id, holder.id)))[0]).toMatchObject({ executionRunId: holderRun.id });
    expect(deps.executeRun).not.toHaveBeenCalled();
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
