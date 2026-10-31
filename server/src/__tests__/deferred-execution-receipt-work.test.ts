import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { accessService } from "../services/access.js";
import { writeDeferredExecutionWait } from "../services/deferred-execution-wait.js";
import { createQueuedCommentIssueLockWriter } from "../modules/wake-queue/adapters/queued-comment-postgres.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, chatActions, chatEndpoints, toolApplications, toolConnections, companies, companyMemberships, createDb, reconcileDatabaseWork, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyDeferredExecutionEligibility, notifyDeferredExecutionWork, notifyNativeStatusWakeWork, notifyTaskRetrySettlement } from "../services/deferred-execution-notifications.js";
import { registerDeferredReceiptWork } from "../services/heartbeat/deferred-receipt-work.js";
import { heartbeatService } from "../services/heartbeat.js";
import { requestTaskRetry } from "../services/task-retry.js";
import { issueService } from "../services/issues.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

vi.setConfig({ testTimeout: 90_000 });
describe("deferred receipt durable dispatch", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  let drain = false;
  const errors: unknown[] = [];
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_DEFERRED_RECEIPT_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("deferred-receipts-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
  });
  beforeEach(async () => {
    await db.execute(sql`truncate companies cascade`); drain = false; errors.length = 0;
    heartbeat = heartbeatService(db);
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !drain, canReconcile: () => true,
      onError: error => errors.push(error) });
  });
  afterEach(async () => {
    await coordinator.stop(); await heartbeat.drainActiveRunExecutions();
    vi.useRealTimers(); vi.restoreAllMocks(); expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), actorId = "deferred-receipt-user";
    await db.insert(authUsers).values({ id: actorId, name: "Receipt operator", email: `${actorId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Deferred dispatch", issuePrefix: `DE${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: actorId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalId: actorId, principalType: "user", status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Receipt process", adapterType: "process", status: "idle",
      adapterConfig: { command: process.execPath, args: ["-e", "console.log('receipt-proof')"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Resume saved task", status: "todo", assigneeAgentId: agent.id }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, issueId: issue.id,
      status: "failed", finishedAt: new Date(), responsibleUserId: actorId, errorCode: "process_failed",
      contextSnapshot: { issueId: issue.id }, resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).returning();
    return { companyId, agent, issue, source, actorId };
  }
  async function quiet() {
    await vi.waitFor(async () => { expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 40_000 });
    const reads = vi.spyOn(db, "select"), executes = vi.spyOn(db, "execute");
    const selected = reads.mock.calls.length, executed = executes.mock.calls.length;
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(reads).toHaveBeenCalledTimes(selected); expect(executes).toHaveBeenCalledTimes(executed);
  }
  async function finish(issueId: string) {
    await issueService(db).update(issueId, { status: "done" });
    await heartbeat.drainActiveRunExecutions();
    const saved = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"));
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.status} in ('queued', 'running')`)).toHaveLength(0);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    if (saved.length) await vi.advanceTimersByTimeAsync(Math.max(0, Math.max(...saved.map(run => run.scheduledRetryAt!.getTime())) - Date.now()) + 1);
    await vi.waitFor(async () => expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"))).toHaveLength(0));
  }
  it("is quiet after empty reconstruction and terminal receipt history", async () => {
    const f = await fixture();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "on_demand", status: "completed", reason: "task_retry", payload: { issueId: f.issue.id } });
    await heartbeat.registerDeferredReceiptWork(coordinator, () => !drain).ready; await quiet();
  });
  it("dispatches an ordinary committed task Retry into saved process output", async () => {
    const f = await fixture();
    await heartbeat.registerDeferredReceiptWork(coordinator, () => !drain).ready;
    await heartbeat.registerRunDispatchWork(coordinator, () => !drain).ready;
    await heartbeat.registerScheduledRetryCancellationWork(coordinator, () => !drain).ready;
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id, actorId: f.actorId,
      observedRunId: f.source.id, idempotencyKey: randomUUID() });
    expect(receipt.accepted).toBe(true);
    let runId: string | undefined;
    await vi.waitFor(async () => {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      expect(wake.runId, JSON.stringify(wake)).toBeTruthy(); runId = wake.runId!;
    }, { timeout: 15_000 });
    await vi.waitFor(async () => {
      await heartbeat.drainActiveRunExecutions();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
      expect(run.status, JSON.stringify({ error: run.error, code: run.errorCode })).toBe("succeeded");
      expect(run.stdoutExcerpt).toContain("receipt-proof");
    }, { timeout: 15_000 });
    await finish(f.issue.id);
    const linked = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.reason, "task_retry"), sql`${agentWakeupRequests.runId} is not null`));
    expect(linked).toHaveLength(2);
    expect(new Set(linked.map(row => row.runId))).toEqual(new Set([runId]));
    expect(linked.map(row => row.idempotencyKey)).toContain(`task-retry-dispatch:${receipt.requestId}`);
    expect(linked.find(row => row.id === receipt.requestId)?.status).toBe("coalesced");
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`)).toHaveLength(1);
    await quiet();
  });
  it.each(["native claim", "execution wait"])("reconstructs an exact fresh %s deadline without probing early", async kind => {
    const f = await fixture(), updatedAt = new Date(), native = kind === "native claim";
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "automation", status: native ? "claimed" : "deferred_issue_execution", claimedAt: updatedAt, updatedAt,
      payload: native ? {} : { executionWait: { reason: "recovery" } },
      requestedByActorType: "system", requestedByActorId: native ? "native-status-committer" : null }).returning();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const check = vi.fn(async (scope: { companyId?: string; requestId?: string }) => {
      await db.update(agentWakeupRequests).set({ status: "skipped" }).where(eq(agentWakeupRequests.id, scope.requestId!));
    });
    await registerDeferredReceiptWork(db, coordinator, { resume: check, settleTaskChat: vi.fn(), dispatchNative: check,
      schedulingSuppressed: async () => false }, () => !drain).ready;
    const due = updatedAt.getTime() + (native ? 60_000 : 30_000);
    expect(coordinator.nextWakeAt()).toBe(due); expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(due - Date.now() - 1); expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(check).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ companyId: f.companyId, requestId: wake.id })));
    await quiet();
  });
  it("reconciles the first drained producer and waits for resume without domain SQL", async () => {
    const f = await fixture(); drain = true;
    const resume = vi.fn(async () => {}), dispatchNative = vi.fn(async () => {});
    await registerDeferredReceiptWork(db, coordinator, { resume, settleTaskChat: vi.fn(), dispatchNative,
      schedulingSuppressed: async () => false }, () => !drain).ready;
    await db.transaction(async tx => {
      await notifyDeferredExecutionWork(tx, { companyId: f.companyId });
      await tx.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id, source: "on_demand",
        status: "deferred_issue_execution", reason: "task_retry" });
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resume).not.toHaveBeenCalled(); expect(dispatchNative).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    drain = false; await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1)); await quiet();
  });
  it.each([
    { name: "saved comment", payload: { _paperclipWakeContext: { wakeCommentIds: ["saved-comment"] } } },
    { name: "interaction", payload: { mutation: "interaction" } },
    { name: "execution wait", payload: { executionWait: { reason: "recovery" } } },
    { name: "interrupt", payload: { queuedCommentInterrupt: { actorId: "operator" } } },
  ])("activates only the committed company's $name receipt after an empty start", async ({ payload }) => {
    const f = await fixture(), foreign = await fixture();
    const resume = vi.fn(async () => {});
    await registerDeferredReceiptWork(db, coordinator, { resume, settleTaskChat: vi.fn(), dispatchNative: vi.fn(),
      schedulingSuppressed: async () => false }, () => !drain).ready;
    const [other] = await db.insert(agentWakeupRequests).values({ companyId: foreign.companyId, agentId: foreign.agent.id,
      source: "on_demand", status: "deferred_issue_execution", payload }).returning();
    let requestId: string;
    await db.transaction(async tx => {
      await tx.transaction(async nested => {
        await notifyDeferredExecutionWork(nested, { companyId: f.companyId });
        const [row] = await nested.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
          source: "on_demand", status: "deferred_issue_execution", payload, updatedAt: new Date(Date.now() - 31_000) }).returning();
        requestId = row.id;
      });
      expect(resume).not.toHaveBeenCalled();
    });
    await vi.waitFor(() => expect(resume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ companyId: f.companyId, requestId })), { timeout: 5_000 });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, other.id)))[0].status).toBe("deferred_issue_execution");
    await quiet();
  });
  it("reconstructs a cancelled legacy run's exact deferred queue even without comment payload", async () => {
    const f = await fixture();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "on_demand", status: "deferred_issue_execution" }).returning();
    await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: { queuedCommentInterruptQueueId: wake.id } })
      .where(eq(heartbeatRuns.id, f.source.id));
    const resume = vi.fn(async () => {});
    await registerDeferredReceiptWork(db, coordinator, { resume, settleTaskChat: vi.fn(), dispatchNative: vi.fn(),
      schedulingSuppressed: async () => false }, () => !drain).ready;
    expect(resume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ companyId: f.companyId, requestId: wake.id }));
    await quiet();
  });
  it("settles a processed chat receipt without restaging it until an actual eligibility commit", async () => {
    const f = await fixture();
    await heartbeat.registerDeferredReceiptWork(coordinator, () => !drain).ready;
    const [application] = await db.insert(toolApplications).values({ companyId: f.companyId, name: "Receipt chat", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
      uid: randomUUID(), name: "Receipt chat", transport: "rest_api" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.companyId, connectionId: connection.id,
      provider: "slack", publicId: randomUUID(), assignedAgentId: f.agent.id }).returning();
    const intentId = randomUUID(), actionId = randomUUID(), previous = new Date(Date.now() - 60_000);
    await db.insert(agentWakeupRequests).values([
      { id: intentId, companyId: f.companyId, agentId: f.agent.id, source: "on_demand", reason: "task_retry",
        status: "deferred_issue_execution", updatedAt: previous, payload: { issueId: f.issue.id,
          taskRetry: { schema: "paperclip.task-retry.v1", generationId: intentId, sourceRunId: f.source.id,
            actorId: f.actorId, strategy: "evaluate", chatActionId: actionId } } },
      { id: actionId, companyId: f.companyId, agentId: f.agent.id, source: "automation", status: "deferred_issue_execution",
        payload: { issueId: f.issue.id, taskRetryRequestId: intentId } },
    ]);
    await db.transaction(async tx => {
      await notifyTaskRetrySettlement(tx, { companyId: f.companyId, requestId: intentId });
      await tx.insert(chatActions).values({ id: actionId, companyId: f.companyId, endpointId: endpoint.id,
        providerActionId: randomUUID(), kind: "failed_run_retry", status: "processed", updatedAt: new Date(),
        payload: { issueId: f.issue.id, taskRetryIntentId: intentId, failedRunId: f.source.id } });
    });
    await vi.waitFor(async () => {
      const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intentId));
      expect(intent.updatedAt.getTime()).toBeGreaterThan(previous.getTime());
    }, { timeout: 5_000 });
    expect((await db.select().from(chatActions).where(eq(chatActions.id, actionId)))[0].status).toBe("processed");
    await db.transaction(tx => notifyDeferredExecutionEligibility(tx, { companyId: f.companyId }));
    await vi.waitFor(async () => expect((await db.select().from(chatActions).where(eq(chatActions.id, actionId)))[0].status)
      .toBe("issued"), { timeout: 5_000 });
    await quiet();
  });
  it("retains a moved interrupt grace deadline after an ordinary saved queue reorder", async () => {
    const f = await fixture(), initialAt = new Date();
    const comments = await db.insert(issueComments).values(["first", "second"].map(body => ({
      companyId: f.companyId, issueId: f.issue.id, body, authorType: "user", authorUserId: f.actorId,
    }))).returning();
    const payload = { issueId: f.issue.id, queuedCommentInterrupt: { actorId: f.actorId },
      _paperclipWakeContext: { wakeCommentIds: comments.map(row => row.id) } };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "on_demand", status: "deferred_issue_execution", payload, updatedAt: initialAt }).returning();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const deps = createHeartbeatQueueTestDependencies(db), queue = createHeartbeatQueue(db, deps);
    await registerDeferredReceiptWork(db, coordinator, { resume: scope => queue.resumeDeferredExecutionReceipts(scope),
      settleTaskChat: async () => {}, dispatchNative: async () => {}, schedulingSuppressed: async () => false }, () => !drain).ready;
    await vi.advanceTimersByTimeAsync(initialAt.getTime() + 10_000 - Date.now());
    const movedAt = new Date();
    const writer = createQueuedCommentIssueLockWriter(db, { syncCommentReferences: async () => {},
      deleteCommentReferenceSource: async () => {}, syncCommentExternalObjectsSafely: async () => {} });
    await writer.withLockedQueue({ issue: f.issue, queueId: wake.id,
      actor: { actorType: "user", actorId: f.actorId, agentId: null, runId: null, agentApiKeyId: null } },
      async (_locked, tx) => { await tx.updateWakeQueuedCommentIds({ wakeId: wake.id, payload,
        ids: comments.map(row => row.id).reverse(), updatedAt: movedAt }); });
    await vi.advanceTimersByTimeAsync(initialAt.getTime() + 30_000 - Date.now());
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    expect(deps.resumeQueuedCommentInterrupt).not.toHaveBeenCalled();
    expect(coordinator.nextWakeAt()).toBe(movedAt.getTime() + 30_000);
    await vi.advanceTimersByTimeAsync(movedAt.getTime() + 30_000 - Date.now());
    await vi.waitFor(() => expect(deps.resumeQueuedCommentInterrupt).toHaveBeenCalledExactlyOnceWith(f.companyId, wake.id));
    await quiet();
  });
  it("reactivates a held task Retry when the authorized subtree hold is released without wakeAgents", async () => {
    const f = await fixture(), tree = issueTreeControlService(db);
    const actor = { actorType: "user" as const, actorId: f.actorId, userId: f.actorId };
    const hold = await tree.createHold(f.companyId, f.issue.id, { mode: "pause", actor });
    await heartbeat.registerDeferredReceiptWork(coordinator, () => !drain).ready;
    await heartbeat.registerRunDispatchWork(coordinator, () => !drain).ready;
    await heartbeat.registerScheduledRetryCancellationWork(coordinator, () => !drain).ready;
    const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id, actorId: f.actorId,
      observedRunId: f.source.id, idempotencyKey: randomUUID() });
    expect(request.requestId).toBeTruthy();
    await vi.waitFor(async () => {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!));
      expect(wake.payload?.executionWait).toMatchObject({ reason: "issue_tree_hold_active" });
      expect(wake.runId).toBeNull();
    }, { timeout: 5_000 });
    await vi.waitFor(() => { expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 40_000 });
    await tree.releaseHold(f.companyId, f.issue.id, hold.hold.id, { actor, reason: "Resume saved Retry" });
    let runId: string | null = null;
    await vi.waitFor(async () => {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!));
      expect(wake.runId, JSON.stringify(wake)).toBeTruthy(); runId = wake.runId;
    }, { timeout: 40_000 });
    await vi.waitFor(async () => {
      await heartbeat.drainActiveRunExecutions();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
      expect(run.status, JSON.stringify({ error: run.error, code: run.errorCode })).toBe("succeeded");
      expect(run.stdoutExcerpt).toContain("receipt-proof");
    }, { timeout: 15_000 });
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${request.requestId}`)).toHaveLength(1);
    await finish(f.issue.id); await quiet();
  });
  it("keeps a moved native dispatch error deadline instead of retrying at its old time", async () => {
    const f = await fixture(), initialAt = new Date();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "automation", status: "queued", error: "Transient dispatch failure", updatedAt: initialAt,
      requestedByActorType: "system", requestedByActorId: "native-status-committer" }).returning();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const dispatchNative = vi.fn(async () => {});
    await registerDeferredReceiptWork(db, coordinator, { resume: async () => {}, settleTaskChat: async () => {},
      dispatchNative, schedulingSuppressed: async () => false }, () => !drain).ready;
    await vi.advanceTimersByTimeAsync(initialAt.getTime() + 10_000 - Date.now());
    const movedAt = new Date();
    await db.update(agentWakeupRequests).set({ updatedAt: movedAt }).where(eq(agentWakeupRequests.id, wake.id));
    await vi.advanceTimersByTimeAsync(initialAt.getTime() + 30_000 - Date.now());
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    expect(dispatchNative).not.toHaveBeenCalled(); expect(coordinator.nextWakeAt()).toBe(movedAt.getTime() + 30_000);
    await vi.advanceTimersByTimeAsync(movedAt.getTime() + 30_000 - Date.now());
    await vi.waitFor(() => expect(dispatchNative).toHaveBeenCalledTimes(1)); await quiet();
  });
  it("arms one new wait reason grace and stays quiet when that same gate is still closed", async () => {
    const f = await fixture(); let reason = "operator_pause";
    const resume = vi.fn(async (scope: { companyId?: string; requestId?: string }) => {
      await writeDeferredExecutionWait(db, { companyId: scope.companyId!, requestId: scope.requestId! }, { reason });
    });
    await registerDeferredReceiptWork(db, coordinator, { resume, settleTaskChat: async () => {}, dispatchNative: async () => {},
      schedulingSuppressed: async () => false }, () => !drain).ready;
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "on_demand", status: "deferred_issue_execution", reason: "task_retry" }).returning();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    for (const nextReason of ["operator_pause", "budget_pause"]) {
      reason = nextReason;
      await writeDeferredExecutionWait(db, { companyId: f.companyId, requestId: wake.id }, { reason });
      const [current] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      const due = current.updatedAt.getTime() + 30_000;
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBe(due));
      const checked = resume.mock.calls.length;
      await vi.advanceTimersByTimeAsync(due - Date.now());
      await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(checked + 1));
      await quiet();
    }
    expect(resume).toHaveBeenCalledTimes(2);
  });
  it("reactivates a saved Retry through ordinary restore cancelled task", async () => {
    const f = await fixture(), actor = { actorType: "user" as const, actorId: f.actorId, userId: f.actorId };
    const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id, actorId: f.actorId,
      observedRunId: f.source.id, idempotencyKey: randomUUID() });
    const tree = issueTreeControlService(db);
    const cancel = await tree.createHold(f.companyId, f.issue.id, { mode: "cancel", actor });
    await tree.cancelIssueStatusesForHold(f.companyId, f.issue.id, cancel.hold.id);
    const restore = await tree.createHold(f.companyId, f.issue.id, { mode: "restore", actor });
    const commitEligibility = () => tree.restoreIssueStatusesForHold(f.companyId, f.issue.id, restore.hold.id, { actor });
    await heartbeat.registerDeferredReceiptWork(coordinator, () => !drain).ready;
    await heartbeat.registerRunDispatchWork(coordinator, () => !drain).ready;
    await heartbeat.registerScheduledRetryCancellationWork(coordinator, () => !drain).ready;
    await vi.waitFor(() => { expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 5_000 });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!)))[0].runId).toBeNull();
    await commitEligibility();
    let runId: string | null = null;
    await vi.waitFor(async () => {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!));
      expect(wake.runId, JSON.stringify(wake)).toBeTruthy(); runId = wake.runId;
    }, { timeout: 15_000 });
    await vi.waitFor(async () => {
      await heartbeat.drainActiveRunExecutions();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
      expect(run.status, JSON.stringify({ error: run.error, code: run.errorCode })).toBe("succeeded");
      expect(run.stdoutExcerpt).toContain("receipt-proof");
    }, { timeout: 15_000 });
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${request.requestId}`)).toHaveLength(1);
    await finish(f.issue.id); await quiet();
  });
  it("member archive publishes committed eligibility while preserving a cancelled Retry tombstone", async () => {
    const f = await fixture(), departing = `departing-${randomUUID()}`;
    const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id, actorId: f.actorId,
      observedRunId: f.source.id, idempotencyKey: randomUUID() });
    await db.insert(authUsers).values({ id: departing, name: "Departing member", email: `${departing}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    const [member] = await db.insert(companyMemberships).values({ companyId: f.companyId, principalId: departing,
      principalType: "user", status: "active", membershipRole: "member" }).returning();
    await issueService(db).update(f.issue.id, { assigneeUserId: departing, assigneeAgentId: null });
    const readIntent = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!)))[0];
    expect(await readIntent()).toMatchObject({ status: "cancelled", runId: null });
    const deferred = vi.fn(), native = vi.fn();
    const unsubscribes = [subscribeDeliveryWork(db, DELIVERY_QUEUES.deferredExecutionReceipts, deferred),
      subscribeDeliveryWork(db, DELIVERY_QUEUES.nativeStatusWakeIntents, native)];
    try {
      await expect(db.transaction(async tx => {
        await accessService(tx as unknown as typeof db).archiveMember(f.companyId, member.id,
          { reassignment: { assigneeAgentId: f.agent.id } });
        expect(deferred).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
        throw new Error("roll back member archive");
      })).rejects.toThrow("roll back member archive");
      expect(deferred).toHaveBeenCalledTimes(1); expect(native).toHaveBeenCalledTimes(1);
      expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0].assigneeUserId).toBe(departing);
      await reconcileDatabaseWork(db, DELIVERY_QUEUES.deferredExecutionReceipts);
      await reconcileDatabaseWork(db, DELIVERY_QUEUES.nativeStatusWakeIntents);
      deferred.mockClear(); native.mockClear();
      await db.transaction(async tx => {
        await accessService(tx as unknown as typeof db).archiveMember(f.companyId, member.id,
          { reassignment: { assigneeAgentId: f.agent.id } });
        expect(deferred).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
      });
      expect(deferred).toHaveBeenCalledTimes(1); expect(native).toHaveBeenCalledTimes(1);
      expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]).toMatchObject({
        assigneeUserId: null, assigneeAgentId: f.agent.id,
      });
      expect((await db.select().from(companyMemberships).where(eq(companyMemberships.id, member.id)))[0].status).toBe("archived");
      expect(await readIntent()).toMatchObject({ status: "cancelled", runId: null });
      expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${request.requestId}`)).toHaveLength(0);
    } finally { for (const unsubscribe of unsubscribes) unsubscribe(); }
    await quiet();
  });
  it("outer rollback and nested savepoint rollback do not dispatch receipt intent", async () => {
    const f = await fixture(); const dispatchNative = vi.fn(async () => {});
    await registerDeferredReceiptWork(db, coordinator, { resume: vi.fn(), settleTaskChat: vi.fn(), dispatchNative,
      schedulingSuppressed: async () => false }, () => !drain).ready;
    await expect(db.transaction(async tx => {
      await notifyNativeStatusWakeWork(tx, { companyId: f.companyId });
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    await db.transaction(async tx => {
      await expect(tx.transaction(async nested => {
        await notifyNativeStatusWakeWork(nested, { companyId: f.companyId }); throw new Error("nested rollback");
      })).rejects.toThrow("nested rollback");
    });
    await quiet(); expect(dispatchNative).not.toHaveBeenCalled();
  });
});
