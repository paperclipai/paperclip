import { createServer } from "node:http";
import { conflict, HttpError } from "../errors.js";
import { setImmediate as immediate } from "node:timers/promises";
import { setTimeout as realTimeout, clearTimeout as clearRealTimeout } from "node:timers";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { budgetService } from "../services/budgets.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { accessService } from "../services/access.js";
import { PersistedExecutionWaitRefusal, writeDeferredExecutionWait } from "../services/deferred-execution-wait.js";
import { createQueuedCommentIssueLockWriter } from "../modules/wake-queue/adapters/queued-comment-postgres.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, chatActions, chatEndpoints, toolApplications, toolConnections, companies, companyMemberships, costEvents, createDb, projects, reconcileDatabaseWork, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
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
// Vitest's waitFor advances fake time on every poll. Keep PostgreSQL leases
// and actual child processes on wall time until an explicit idle deadline step.
function waitForReal(assertion: () => unknown | Promise<unknown>, { timeout = 1000 } = {}) {
  return new Promise<void>((resolve, reject) => {
    let settled = false, lastError: unknown;
    let retry: ReturnType<typeof realTimeout> | undefined;
    const deadline = realTimeout(() => finish(lastError ?? new Error("Expectation did not complete before its deadline")), timeout);
    function finish(error?: unknown) {
      if (settled) return;
      settled = true; clearRealTimeout(deadline); if (retry) clearRealTimeout(retry);
      if (error) reject(error); else resolve();
    }
    async function attempt() {
      try { await assertion(); finish(); }
      catch (error) { lastError = error; if (!settled) retry = realTimeout(attempt, 50); }
    }
    void attempt();
  });
}
describe("deferred receipt durable dispatch", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  let drain = false;
  const errors: unknown[] = [];
  const errorTimes: number[] = [];
  const statements: string[] = [];
  const passes = new Set<Promise<unknown>>();
  const extraStops: Array<() => Promise<void>> = [];
  const lifecycleWorkers = new Set<ReturnType<typeof configureAgentLifecycle>>();
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_DEFERRED_RECEIPT_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("deferred-receipts-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    db.$client.options.onnotice = () => {};
    db.$client.options.debug = (_connection, query) => { statements.push(query); };
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
  });
  beforeEach(async () => {
    await db.execute(sql`truncate companies cascade`); drain = false; errors.length = 0; errorTimes.length = 0;
    // Install one clock before any worker arms a timer. It follows wall time
    // during actual process execution; accelerated steps only settle idle work.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    heartbeat = heartbeatService(db);
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !drain, canReconcile: () => true,
      onError: error => { errors.push(error); errorTimes.push(Date.now()); } });
    const register = coordinator.register.bind(coordinator);
    coordinator.register = (queue, task) => register(queue, { ...task, run: signal => {
      const pass = Promise.resolve(task.run(signal)); passes.add(pass);
      void pass.then(() => passes.delete(pass), () => passes.delete(pass)); return pass;
    } });
  });
  afterEach(async () => {
    await coordinator.stop(); await heartbeat.drainActiveRunExecutions();
    for (const stop of extraStops.splice(0)) await stop();
    await Promise.all([...lifecycleWorkers].map(worker => worker.stop())); lifecycleWorkers.clear();
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
    await Promise.allSettled([...passes]); await heartbeat.drainActiveRunExecutions();
    await waitForReal(async () => {
      if (vi.isFakeTimers()) {
        // Fake-clock cases have no live execution. Settle finite cleanup
        // deadlines explicitly instead of advancing at waitFor's wall speed.
        await vi.advanceTimersByTimeAsync(1000);
        await Promise.allSettled([...passes]); await immediate();
      }
      expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 40_000 });
    const reads = vi.spyOn(db, "select"), executes = vi.spyOn(db, "execute");
    const selected = reads.mock.calls.length, executed = executes.mock.calls.length;
    const count = statements.length;
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    expect(statements).toHaveLength(count);
    expect(reads).toHaveBeenCalledTimes(selected); expect(executes).toHaveBeenCalledTimes(executed);
  }
  async function finish(issueId: string) {
    await issueService(db).update(issueId, { status: "done" });
    await waitForReal(async () => {
      await Promise.allSettled([...passes]); await heartbeat.drainActiveRunExecutions();
      expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.status} in ('queued', 'running')`)).toHaveLength(0);
    }, { timeout: 15_000 });
    const saved = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"));
    if (saved.length) {
      const due = Math.max(...saved.map(run => run.scheduledRetryAt!.getTime()));
      while (Date.now() <= due) {
        await vi.advanceTimersByTimeAsync(Math.min(500, due - Date.now() + 1));
        await Promise.allSettled([...passes]); await immediate();
      }
    }
    await waitForReal(async () => {
      // A committed cancellation may be coalesced behind an already-armed
      // worker deadline. Follow that deadline rather than a guessed 500ms step.
      const next = coordinator.nextWakeAt();
      await vi.advanceTimersByTimeAsync(next === null ? 500 : Math.max(1, next - Date.now()));
      await Promise.allSettled([...passes]); await immediate();
      await heartbeat.drainActiveRunExecutions();
      const remaining = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "scheduled_retry"));
      expect(remaining, JSON.stringify({ next: coordinator.nextWakeAt(), at: Date.now(),
        runs: remaining.map(run => ({ id: run.id, at: run.scheduledRetryAt, error: run.errorCode })) })).toHaveLength(0);
    });
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
    await waitForReal(async () => {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      expect(wake.runId, JSON.stringify(wake)).toBeTruthy(); runId = wake.runId!;
    }, { timeout: 15_000 });
    await waitForReal(async () => {
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
  async function blockedRetry(gate: "budget" | "project budget" | "paused agent") {
    const f = await fixture(), lifecycle = createAgentLifecycle(db), budgets = budgetService(db);
    // Host lifecycle completion is controlled; all state, admission and the
    // eventual process adapter execution use their production implementations.
    const lifecycleWorker = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
      runHost: async () => "complete", runPlugin: async () => "complete" });
    lifecycleWorkers.add(lifecycleWorker);
    const projectId = gate === "project budget" ? randomUUID() : null;
    if (projectId) {
      await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Retry budget project" });
      await db.update(issues).set({ projectId }).where(eq(issues.id, f.issue.id));
    }
    const policy = { scopeType: projectId ? "project" as const : "agent" as const, scopeId: projectId ?? f.agent.id, amount: 100,
      metric: "billed_cents" as const, windowKind: "lifetime" as const, hardStopEnabled: true, notifyEnabled: false };
    if (gate !== "paused agent") {
      await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agent.id, projectId,
        provider: "test", model: "receipt-proof", costCents: 200, occurredAt: new Date() });
      await budgets.upsertPolicy(f.companyId, policy, f.actorId);
    } else await lifecycle.pauseAgent(f.agent.id);
    await lifecycleWorker.process(f.agent.id);
    await heartbeat.registerDeferredReceiptWork(coordinator, () => !drain).ready;
    await heartbeat.registerRunDispatchWork(coordinator, () => !drain).ready;
    await heartbeat.registerScheduledRetryCancellationWork(coordinator, () => !drain).ready;
    const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id, actorId: f.actorId,
      observedRunId: f.source.id, idempotencyKey: randomUUID() });
    expect(request.accepted).toBe(true);
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!)))[0];
    await waitForReal(async () => expect((await read()).payload?.executionWait).toMatchObject({
      reason: gate !== "paused agent" ? "budget.blocked" : "agent.not_invokable",
    }), { timeout: 10_000 });
    const refusals: unknown[] = [];
    await heartbeat.resumeExecutionWaitComments({ companyId: f.companyId, requestId: request.requestId!, onError: error => refusals.push(error) });
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toBeInstanceOf(HttpError);
    expect(refusals[0]).toMatchObject({ status: 409,
      details: gate !== "paused agent" ? { scopeType: policy.scopeType, scopeId: policy.scopeId } : { status: "paused", reason: "paused" } });
    return { f, lifecycle, budgets, policy, lifecycleWorker, request, read };
  }

  it.each(["budget", "project budget", "paused agent"] as const)("parks real task Retry behind unchanged %s without recurring SQL", async gate => {
    const { request, read } = await blockedRetry(gate);
    // The clock was installed before worker registration and every timer.
    // No execution exists while we observe actual driver SQL across25min.
    for (let n = 0; n < 3; n++) {
      await vi.advanceTimersByTimeAsync(31_000); await Promise.allSettled([...passes]); await immediate();
    }
    expect(errors).toEqual([]);
    await quiet();
    expect(await read()).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${request.requestId}`)).toHaveLength(0);
  });

  it.each(["budget", "project budget", "paused agent"] as const)("releases real %s Retry into exactly one saved process execution", async gate => {
    const { f, lifecycle, budgets, policy, lifecycleWorker, request, read } = await blockedRetry(gate);
    // Keep the clock advancing with wall time through gate release and actual
    // child-process exit. Accelerate only after that execution has settled.
    if (gate !== "paused agent") await budgets.upsertPolicy(f.companyId, { ...policy, amount: 1000 }, f.actorId);
    else await lifecycle.resumeAgent(f.agent.id);
    await lifecycleWorker.process(f.agent.id);
    let runId: string | null = null;
    await waitForReal(async () => {
      const wake = await read(); expect(wake.runId).toBeTruthy(); runId = wake.runId;
    }, { timeout: 40_000 });
    await waitForReal(async () => {
      await heartbeat.drainActiveRunExecutions();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
      expect(run.status, JSON.stringify({ error: run.error, code: run.errorCode })).toBe("succeeded");
      expect(run.stdoutExcerpt).toContain("receipt-proof");
    }, { timeout: 15_000 });
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${request.requestId}`)).toHaveLength(1);
    await finish(f.issue.id); await quiet();
  });

  it.each(["missing", "cancelled"] as const)("preserves ordinary409 when a %s receipt cannot save the gate", async status => {
    const f = await fixture(), requestId = randomUUID();
    if (status === "cancelled") await db.insert(agentWakeupRequests).values({ id: requestId, companyId: f.companyId,
      agentId: f.agent.id, source: "on_demand", status, payload: { issueId: f.issue.id } });
    const deps = createHeartbeatQueueTestDependencies(db), queue = createHeartbeatQueue(db, deps);
    deps.getAgent.mockResolvedValue(f.agent);
    deps.instanceSettings.getExperimental.mockImplementation(() => instanceSettingsService(db).getExperimental());
    for (const gate of ["budget", "agent"] as const) {
      deps.budgets.getInvocationBlock.mockResolvedValue(gate === "budget"
        ? { scopeType: "agent", scopeId: f.agent.id, scopeName: f.agent.name, reason: "Budget blocked" } : null);
      deps.getAgentInvokability.mockResolvedValue({ invokable: false, message: "Paused", reason: "paused", details: {}, invalidOrgChain: false });
      const error = await queue.enqueueWakeup(f.agent.id, { source: "on_demand", reason: "task_retry",
        requestedByActorType: "user", requestedByActorId: f.actorId, payload: { issueId: f.issue.id },
        contextSnapshot: { issueId: f.issue.id, responsibleUserId: f.actorId } }, requestId).catch(cause => cause);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).not.toBeInstanceOf(PersistedExecutionWaitRefusal);
      expect(error).toMatchObject({ status: 409, message: gate === "budget" ? "Budget blocked" : "Paused" });
    }
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, requestId));
    expect(rows).toHaveLength(status === "missing" ? 0 : 1);
    if (status === "cancelled") expect(rows[0]).toMatchObject({ status: "cancelled", runId: null, payload: { issueId: f.issue.id } });
  });

  it("retains failure backoff for a real wait-persistence database error", async () => {
    // This case observes the millisecond before retry. Freeze before any
    // fixture or worker can arm a timer; it never starts a child process.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: false });
    const f = await fixture();
    await createAgentLifecycle(db).pauseAgent(f.agent.id);
    const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id, actorId: f.actorId,
      observedRunId: f.source.id, idempotencyKey: randomUUID() });
    await db.execute(sql`create function c1_refusal_fault() returns trigger language plpgsql as $$
      begin if new.reason = 'task_retry' and new.payload ? 'executionWait' then
        raise exception 'C1 injected wait persistence failure'; end if; return new; end $$`);
    await db.execute(sql`create trigger c1_refusal_fault before update on agent_wakeup_requests
      for each row execute function c1_refusal_fault()`);
    try {
      await heartbeat.registerDeferredReceiptWork(coordinator, () => !drain).ready;
      await waitForReal(() => expect(errors).toHaveLength(1));
      const failure = errors[0] as AggregateError;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(String(failure.errors[0]?.errors[0]?.cause?.message)).toContain("C1 injected wait persistence failure");
      const due = errorTimes[0] + 30_000;
      // Other owners may publish a coalesced deadline after their real SQL
      // settles. Run those saved deadlines without reaching the failed retry.
      await waitForReal(async () => {
        await Promise.allSettled([...passes]); await immediate();
        const next = coordinator.nextWakeAt();
        if (next !== null && next < due) {
          await vi.advanceTimersByTimeAsync(Math.max(1, next - Date.now() + 1));
          await Promise.allSettled([...passes]); await immediate();
        }
        expect(errors).toHaveLength(1);
        expect(coordinator.nextWakeAt()).toBe(due);
      });
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!)))[0].payload?.executionWait).toBeUndefined();
      await vi.advanceTimersByTimeAsync(due - Date.now() - 1);
      expect(errors).toHaveLength(1);
      await db.execute(sql`drop trigger c1_refusal_fault on agent_wakeup_requests`);
      await db.execute(sql`drop function c1_refusal_fault()`);
      errors.length = 0;
      for (let n = 0; n < 3; n++) {
        await vi.advanceTimersByTimeAsync(31_000); await Promise.allSettled([...passes]); await immediate();
      }
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!)))[0].payload?.executionWait)
        .toMatchObject({ reason: "agent.not_invokable" });
      await quiet();
    } finally {
      await db.execute(sql`drop trigger if exists c1_refusal_fault on agent_wakeup_requests`);
      await db.execute(sql`drop function if exists c1_refusal_fault()`);
    }
  });

  it("does not park an unrelated HTTP409 as a persisted refusal", async () => {
    const f = await fixture();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "on_demand", reason: "task_retry", status: "deferred_issue_execution" }).returning();
    const failure = conflict("Unexpected admission conflict");
    let fail = true, failedAt = 0;
    const resume = vi.fn(async (scope: { onError?: (error: unknown) => void }) => {
      if (fail) { failedAt = Date.now(); scope.onError?.(failure); }
    });
    await registerDeferredReceiptWork(db, coordinator, { resume, settleTaskChat: async () => {}, createNativeBatch: () => async () => {},
      schedulingSuppressed: async () => false }, () => !drain).ready;
    expect(errors).toHaveLength(1);
    expect((errors[0] as AggregateError).errors[0].errors).toEqual([failure]);
    expect(coordinator.nextWakeAt()).toBe(failedAt + 30_000);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0].status).toBe("deferred_issue_execution");
    errors.length = 0; fail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForReal(() => expect(resume).toHaveBeenCalledTimes(2));
    await quiet();
  });

  async function nativeCohort(f: Awaited<ReturnType<typeof fixture>>, count = 2, completeAfter = 1) {
    const failures: unknown[] = [];
    let delivered = 0;
    const listener = createServer(async (request, response) => {
      try {
        let body = "";
        for await (const chunk of request) body += chunk;
        const { runId } = JSON.parse(body) as { runId: string };
        const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
          eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.agent.id)));
        const issueId = run?.contextSnapshot?.issueId;
        const [target] = typeof issueId === "string" ? await db.select().from(issues).where(and(eq(issues.id, issueId),
          eq(issues.companyId, f.companyId), eq(issues.assigneeAgentId, f.agent.id))) : [];
        if (!run || !target) throw new Error("Unknown native cohort run");
        delivered++;
        if (delivered >= completeAfter) await issueService(db).update(target.id, { status: "done" });
        else await issueService(db).addComment(target.id, "This native batch was handled.", { agentId: f.agent.id, runId: run.id });
        response.end("ok");
      } catch (error) { failures.push(error); response.statusCode = 500; response.end("completion failed"); }
    });
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    extraStops.push(async () => { listener.closeAllConnections(); await new Promise<void>(resolve => listener.close(() => resolve())); });
    const port = (listener.address() as { port: number }).port;
    const script = `fetch("http://127.0.0.1:${port}/complete", {method:"POST",body:JSON.stringify({runId:process.env.PAPERCLIP_RUN_ID})}).then(async response=>{if(!response.ok)throw new Error(await response.text());console.log("receipt-proof")}).catch(error=>{console.error(error);process.exitCode=1})`;
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script], cwd: process.cwd() } })
      .where(eq(agents.id, f.agent.id));
    const at = Date.now();
    const intents = await db.insert(agentWakeupRequests).values(Array.from({ length: count }, (_, index) => ({
      reason: index % 2 ? "issue_blockers_resolved" : "issue_children_completed",
      companyId: f.companyId, agentId: f.agent.id, source: "automation", triggerDetail: "system",
      status: "queued", requestedByActorType: "system", requestedByActorId: "native-status-committer",
      requestedAt: new Date(at - (count - index) * 1000), idempotencyKey: `native-cohort:${index}:${f.issue.id}`,
      payload: { issueId: f.issue.id, taskId: f.issue.id,
        _paperclipWakeContext: { issueId: f.issue.id, taskId: f.issue.id, source: "native_status_decision" } },
    }))).returning();
    return { intents, failures };
  }
  async function nativeCohortResult(f: Awaited<ReturnType<typeof fixture>>, cohort: Awaited<ReturnType<typeof nativeCohort>>,
    owners = [heartbeat]) {
    await waitForReal(async () => {
      const rows = await db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.id} in ${cohort.intents.map(row => row.id)}`);
      expect(rows.map(row => row.status)).toEqual(cohort.intents.map(() => "coalesced"));
    }, { timeout: 15_000 });
    const dispatched = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      sql`${agentWakeupRequests.requestedByActorId} like 'native-status-wake-dispatch:%'`,
      sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issue.id}`));
    expect(dispatched.map(row => ({ id: row.id, runId: row.runId, status: row.status }))).toHaveLength(1);
    const [first, second] = await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.id} in ${cohort.intents.map(row => row.id)}`);
    expect(first.runId).toBeTruthy(); expect(second.runId).toBe(first.runId);
    expect((await db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.id} in ${cohort.intents.map(row => row.id)}`))
      .every(row => row.runId === first.runId)).toBe(true);
    await waitForReal(async () => {
      await Promise.all(owners.map(owner => owner.drainActiveRunExecutions()));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.runId!));
      expect(run.status, JSON.stringify({ error: run.error, code: run.errorCode })).toBe("succeeded");
      expect(run.stdoutExcerpt).toContain("receipt-proof");
    }, { timeout: 15_000 });
    expect(cohort.failures).toEqual([]);
    return first.runId!;
  }
  it("coalesces two due native status intents through the registered receipt worker", async () => {
    const f = await fixture(), cohort = await nativeCohort(f);
    await heartbeat.registerDeferredReceiptWork(coordinator, () => !drain).ready;
    await nativeCohortResult(f, cohort); await quiet();
  });
  it("preserves one dispatch for the canonical hundred-intent native batch", async () => {
    const f = await fixture(), cohort = await nativeCohort(f, 100);
    await heartbeat.registerDeferredReceiptWork(coordinator, () => !drain).ready;
    await nativeCohortResult(f, cohort); await quiet();
  });
  it("keeps other issues and companies separate within one native worker batch", async () => {
    const f = await fixture(), cohort = await nativeCohort(f), foreign = await fixture(), foreignCohort = await nativeCohort(foreign);
    const [otherIssue] = await db.insert(issues).values({ companyId: f.companyId, assigneeAgentId: f.agent.id,
      status: "todo", title: "Separate native issue" }).returning();
    const otherIntents = await db.insert(agentWakeupRequests).values(cohort.intents.map((_, index) => ({
      companyId: f.companyId, agentId: f.agent.id, source: "automation", triggerDetail: "system",
      reason: index ? "issue_blockers_resolved" : "issue_children_completed", status: "queued",
      requestedByActorType: "system", requestedByActorId: "native-status-committer",
      idempotencyKey: `other-native-issue:${index}:${otherIssue.id}`,
      payload: { issueId: otherIssue.id, taskId: otherIssue.id,
        _paperclipWakeContext: { issueId: otherIssue.id, taskId: otherIssue.id, source: "native_status_decision" } },
    }))).returning();
    await heartbeat.registerDeferredReceiptWork(coordinator, () => !drain).ready;
    const first = await nativeCohortResult(f, cohort);
    const other = await nativeCohortResult({ ...f, issue: otherIssue }, { intents: otherIntents, failures: cohort.failures });
    const third = await nativeCohortResult(foreign, foreignCohort);
    expect(new Set([first, other, third]).size).toBe(3); await quiet();
  });
  it("dispatches a notice committed during held admission in a fresh native pass even with old requestedAt", async () => {
    const f = await fixture(), cohort = await nativeCohort(f, 2, 2);
    let allowLate!: () => void, began!: () => void, releaseIssue!: () => void, locked!: () => void;
    const lateGate = new Promise<void>(resolve => { allowLate = resolve; });
    const lateBegan = new Promise<void>(resolve => { began = resolve; });
    const issueGate = new Promise<void>(resolve => { releaseIssue = resolve; });
    const issueLocked = new Promise<void>(resolve => { locked = resolve; });
    let late: typeof agentWakeupRequests.$inferSelect | undefined;
    const lateRequestedAt = new Date(Date.now() - 60_000);
    const lateTransaction = db.transaction(async tx => {
      await tx.execute(sql`select 1`); began(); await lateGate;
      const id = randomUUID();
      await notifyNativeStatusWakeWork(tx, { companyId: f.companyId, requestId: id });
      [late] = await tx.insert(agentWakeupRequests).values({ id, companyId: f.companyId, agentId: f.agent.id,
        source: "automation", triggerDetail: "system", reason: "issue_children_completed", status: "queued",
        requestedByActorType: "system", requestedByActorId: "native-status-committer", requestedAt: lateRequestedAt,
        idempotencyKey: `late-native:${id}`,
        payload: { issueId: f.issue.id, taskId: f.issue.id,
          _paperclipWakeContext: { issueId: f.issue.id, taskId: f.issue.id, source: "native_status_decision" } },
      }).returning();
    });
    await lateBegan;
    const issueLock = db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issue.id)).for("update"); locked(); await issueGate;
    });
    await issueLocked;
    const registration = heartbeat.registerDeferredReceiptWork(coordinator, () => !drain);
    try {
      await waitForReal(async () => expect((await db.select().from(agentWakeupRequests)
        .where(sql`${agentWakeupRequests.id} in ${cohort.intents.map(row => row.id)}`)).some(row => row.status === "claimed")).toBe(true), { timeout: 5000 });
      const [claimed] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.status, "claimed")));
      allowLate(); await lateTransaction;
      expect(late!.requestedAt.getTime()).toBeLessThanOrEqual(claimed.claimedAt!.getTime());
    } finally { allowLate(); releaseIssue(); await Promise.all([lateTransaction, issueLock]); }
    await registration.ready;
    let lateRunId: string | null = null;
    await waitForReal(async () => {
      const [saved] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        eq(agentWakeupRequests.requestedByActorType, "system"),
        eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${late!.id}`)));
      expect(saved?.runId, JSON.stringify(saved)).toBeTruthy(); lateRunId = saved.runId;
    }, { timeout: 45_000 });
    const originals = await db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.id} in ${cohort.intents.map(row => row.id)}`);
    expect(originals.every(row => row.runId === originals[0].runId)).toBe(true);
    expect(lateRunId).not.toBe(originals[0].runId);
    await waitForReal(async () => {
      await heartbeat.drainActiveRunExecutions();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, lateRunId!));
      expect(run.status, JSON.stringify({ error: run.error, code: run.errorCode })).toBe("succeeded");
      expect(run.stdoutExcerpt).toContain("receipt-proof");
      expect(run.contextSnapshot?.nativeStatusWakeIntentId).toBe(late!.id);
    }, { timeout: 15_000 });
    expect(cohort.failures).toEqual([]);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, late!.id)))[0].status).toBe("coalesced");
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      sql`${agentWakeupRequests.requestedByActorId} like 'native-status-wake-dispatch:%'`))).toHaveLength(2);
    await quiet();
  });
  it.each(["native claim", "execution wait"])("reconstructs an exact fresh %s deadline without probing early", async kind => {
    const f = await fixture(), updatedAt = new Date(), native = kind === "native claim";
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "automation", status: native ? "claimed" : "deferred_issue_execution", claimedAt: updatedAt, updatedAt,
      payload: native ? {} : { executionWait: { reason: "recovery" } },
      requestedByActorType: "system", requestedByActorId: native ? "native-status-committer" : null }).returning();
    const check = vi.fn(async (scope: { companyId?: string; requestId?: string }) => {
      await db.update(agentWakeupRequests).set({ status: "skipped" }).where(eq(agentWakeupRequests.id, scope.requestId!));
    });
    await registerDeferredReceiptWork(db, coordinator, { resume: check, settleTaskChat: vi.fn(), createNativeBatch: () => check,
      schedulingSuppressed: async () => false }, () => !drain).ready;
    const due = updatedAt.getTime() + (native ? 60_000 : 30_000);
    expect(coordinator.nextWakeAt()).toBe(due); expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(due - Date.now() - 1); expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await waitForReal(() => expect(check).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ companyId: f.companyId, requestId: wake.id })));
    await quiet();
  });
  it("reconciles the first drained producer and waits for resume without domain SQL", async () => {
    const f = await fixture(); drain = true;
    const resume = vi.fn(async () => {}), dispatchNative = vi.fn(async () => {});
    await registerDeferredReceiptWork(db, coordinator, { resume, settleTaskChat: vi.fn(), createNativeBatch: () => dispatchNative,
      schedulingSuppressed: async () => false }, () => !drain).ready;
    await db.transaction(async tx => {
      await notifyDeferredExecutionWork(tx, { companyId: f.companyId });
      await tx.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id, source: "on_demand",
        status: "deferred_issue_execution", reason: "task_retry" });
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(resume).not.toHaveBeenCalled(); expect(dispatchNative).not.toHaveBeenCalled();
    await waitForReal(() => expect(idleWorkSnapshot().active).toBe(0));
    drain = false; await vi.advanceTimersByTimeAsync(30_000);
    await waitForReal(() => expect(resume).toHaveBeenCalledTimes(1)); await quiet();
  });
  it.each([
    { name: "saved comment", payload: { _paperclipWakeContext: { wakeCommentIds: ["saved-comment"] } } },
    { name: "interaction", payload: { mutation: "interaction" } },
    { name: "execution wait", payload: { executionWait: { reason: "recovery" } } },
    { name: "interrupt", payload: { queuedCommentInterrupt: { actorId: "operator" } } },
  ])("activates only the committed company's $name receipt after an empty start", async ({ payload }) => {
    const f = await fixture(), foreign = await fixture();
    const resume = vi.fn(async () => {});
    await registerDeferredReceiptWork(db, coordinator, { resume, settleTaskChat: vi.fn(), createNativeBatch: () => vi.fn(),
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
    await waitForReal(() => expect(resume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ companyId: f.companyId, requestId })), { timeout: 5_000 });
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
    await registerDeferredReceiptWork(db, coordinator, { resume, settleTaskChat: vi.fn(), createNativeBatch: () => vi.fn(),
      schedulingSuppressed: async () => false }, () => !drain).ready;
    expect(resume).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ companyId: f.companyId, requestId: wake.id }));
    await quiet();
  });
  it("parks an accepted conversation Retry while chat is disabled and resumes it on enablement", async () => {
    const settings = instanceSettingsService(db), original = await settings.getExperimental();
    await settings.updateExperimental({ enableAgentChat: true });
    try {
      const f = await fixture();
      await db.update(issues).set({ status: "in_review", conversationAgentId: f.agent.id,
        conversationUserId: f.actorId, conversationState: "waiting" }).where(eq(issues.id, f.issue.id));
      const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id,
        actorId: f.actorId, observedRunId: f.source.id, idempotencyKey: randomUUID() });
      expect(request.accepted).toBe(true);
      await settings.updateExperimental({ enableAgentChat: false });
      await expect(requestTaskRetry({ db, companyId: f.companyId, issueId: f.issue.id,
        actorId: f.actorId, observedRunId: f.source.id, idempotencyKey: randomUUID() }))
        .rejects.toMatchObject({ status: 404, message: "Agent Chat is disabled" });
      const priorCursor = new Date(Date.now() - 31_000);
      await db.update(agentWakeupRequests).set({ updatedAt: priorCursor }).where(eq(agentWakeupRequests.id, request.requestId!));
      await heartbeat.resumeExecutionWaitComments({ companyId: f.companyId });
      const [parked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!));
      expect(parked.updatedAt.getTime()).toBeGreaterThan(priorCursor.getTime());
      expect(parked).toMatchObject({ status: "deferred_issue_execution", runId: null });
      await heartbeat.registerDeferredReceiptWork(coordinator, () => !drain).ready;
      await heartbeat.registerRunDispatchWork(coordinator, () => !drain).ready;
      await Promise.allSettled([...passes]);
      expect(errors).toEqual([]);
      const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!)))[0];
      expect(await read()).toMatchObject({ status: "deferred_issue_execution", runId: null });
      await waitForReal(async () => {
        await Promise.allSettled([...passes]);
        expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0);
      }, { timeout: 40_000 });
      const idleStatements = statements.length;
      await new Promise(resolve => setTimeout(resolve, 31_000));
      expect(statements).toHaveLength(idleStatements);
      await settings.updateExperimental({ enableAgentChat: true });
      let runId: string | null = null;
      await waitForReal(async () => {
        const saved = await read(); expect(saved.runId).toBeTruthy(); runId = saved.runId;
      }, { timeout: 5_000 });
      await waitForReal(async () => {
        await heartbeat.drainActiveRunExecutions();
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
        expect(run.status).toBe("succeeded"); expect(run.stdoutExcerpt).toContain("receipt-proof");
      }, { timeout: 15_000 });
      expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${request.requestId}`)).toHaveLength(1);
      await heartbeat.drainActiveRunExecutions();
    } finally { await settings.updateExperimental({ enableAgentChat: original.enableAgentChat }); }
  });
  it("resumes saved conversation input only after chat is re-enabled and its transaction commits", async () => {
    const settings = instanceSettingsService(db), original = await settings.getExperimental();
    await settings.updateExperimental({ enableAgentChat: true });
    try {
      const f = await fixture();
      await db.update(issues).set({ status: "in_review", conversationAgentId: f.agent.id,
        conversationUserId: f.actorId, conversationState: "waiting" }).where(eq(issues.id, f.issue.id));
      const comment = await issueService(db).addComment(f.issue.id, "Continue with this saved input", { userId: f.actorId });
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
        source: "on_demand", status: "deferred_issue_execution", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: f.actorId, updatedAt: new Date(Date.now() - 31_000),
        payload: { issueId: f.issue.id, queuedCommentInterrupt: { actorId: f.actorId },
          _paperclipWakeContext: { issueId: f.issue.id, wakeCommentIds: [comment.id] } } }).returning();
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(Date.now() - 31_000),
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          queuedCommentInterruptQueueId: wake.id } }).where(eq(heartbeatRuns.id, f.source.id));
      await settings.updateExperimental({ enableAgentChat: false });
      await heartbeat.registerDeferredReceiptWork(coordinator, () => !drain).ready;
      await heartbeat.registerRunDispatchWork(coordinator, () => !drain).ready;
      await waitForReal(async () => {
        await Promise.allSettled([...passes]);
        expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0);
      }, { timeout: 5_000 });
      const idleStatements = statements.length;
      await new Promise(resolve => setTimeout(resolve, 31_000));
      expect(statements).toHaveLength(idleStatements);
      const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0];
      expect(await read()).toMatchObject({ status: "deferred_issue_execution", runId: null });
      await expect(db.transaction(async tx => {
        await instanceSettingsService(tx as unknown as typeof db).updateExperimental({ enableAgentChat: true });
        throw new Error("rolled back chat enablement");
      })).rejects.toThrow("rolled back chat enablement");
      await Promise.allSettled([...passes]);
      expect(await read()).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect((await settings.getExperimental()).enableAgentChat).toBe(false);
      await settings.updateExperimental({ enableAgentChat: true });
      let runId: string | null = null;
      await waitForReal(async () => {
        const saved = await read(); expect(saved.runId).toBeTruthy(); runId = saved.runId;
      }, { timeout: 5_000 });
      await waitForReal(async () => {
        await heartbeat.drainActiveRunExecutions();
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
        expect(run.status).toBe("succeeded"); expect(run.stdoutExcerpt).toContain("receipt-proof");
      }, { timeout: 15_000 });
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.id} <> ${f.source.id}`));
      expect(runs).toHaveLength(1);
      expect(runs[0].contextSnapshot?.wakeCommentIds).toEqual([comment.id]);
      await quiet();
    } finally { await settings.updateExperimental({ enableAgentChat: original.enableAgentChat }); }
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
    await waitForReal(async () => {
      const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intentId));
      expect(intent.updatedAt.getTime()).toBeGreaterThan(previous.getTime());
    }, { timeout: 5_000 });
    expect((await db.select().from(chatActions).where(eq(chatActions.id, actionId)))[0].status).toBe("processed");
    await db.transaction(tx => notifyDeferredExecutionEligibility(tx, { companyId: f.companyId }));
    await waitForReal(async () => expect((await db.select().from(chatActions).where(eq(chatActions.id, actionId)))[0].status)
      .toBe("issued"), { timeout: 5_000 });
    await quiet();
  });
  it("retains a moved interrupt grace deadline after an ordinary saved queue reorder", async () => {
    const f = await fixture(), initialAt = new Date();
    const comments = await db.insert(issueComments).values(["first", "second"].map(body => ({
      companyId: f.companyId, issueId: f.issue.id, body, authorType: "user" as const, authorUserId: f.actorId,
    }))).returning();
    const payload = { issueId: f.issue.id, queuedCommentInterrupt: { actorId: f.actorId },
      _paperclipWakeContext: { wakeCommentIds: comments.map(row => row.id) } };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "on_demand", status: "deferred_issue_execution", payload, updatedAt: initialAt }).returning();
    const deps = createHeartbeatQueueTestDependencies(db), queue = createHeartbeatQueue(db, deps);
    await registerDeferredReceiptWork(db, coordinator, { resume: scope => queue.resumeDeferredExecutionReceipts(scope),
      settleTaskChat: async () => {}, createNativeBatch: () => async () => {}, schedulingSuppressed: async () => false }, () => !drain).ready;
    await vi.advanceTimersByTimeAsync(initialAt.getTime() + 10_000 - Date.now());
    const movedAt = new Date();
    const writer = createQueuedCommentIssueLockWriter(db, { syncCommentReferences: async () => {},
      deleteCommentReferenceSource: async () => {}, syncCommentExternalObjectsSafely: async () => {} });
    await writer.withLockedQueue({ issue: f.issue, queueId: wake.id,
      actor: { actorType: "user", actorId: f.actorId, agentId: null, runId: null, agentApiKeyId: null } },
      async (_locked, tx) => { await tx.updateWakeQueuedCommentIds({ wakeId: wake.id, payload,
        ids: comments.map(row => row.id).reverse(), updatedAt: movedAt }); });
    await vi.advanceTimersByTimeAsync(initialAt.getTime() + 30_000 - Date.now());
    await waitForReal(() => expect(idleWorkSnapshot().active).toBe(0));
    expect(deps.resumeQueuedCommentInterrupt).not.toHaveBeenCalled();
    expect(coordinator.nextWakeAt()).toBe(movedAt.getTime() + 30_000);
    await vi.advanceTimersByTimeAsync(movedAt.getTime() + 30_000 - Date.now());
    await waitForReal(() => expect(deps.resumeQueuedCommentInterrupt).toHaveBeenCalledExactlyOnceWith(f.companyId, wake.id));
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
    await waitForReal(async () => {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!));
      expect(wake.payload?.executionWait).toMatchObject({ reason: "issue_tree_hold_active" });
      expect(wake.runId).toBeNull();
    }, { timeout: 5_000 });
    await waitForReal(() => { expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 40_000 });
    await tree.releaseHold(f.companyId, f.issue.id, hold.hold.id, { actor, reason: "Resume saved Retry" });
    let runId: string | null = null;
    await waitForReal(async () => {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!));
      expect(wake.runId, JSON.stringify(wake)).toBeTruthy(); runId = wake.runId;
    }, { timeout: 40_000 });
    // Observe this Retry before closing the task and draining its follow-ups.
    await waitForReal(async () => {
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
    const dispatchNative = vi.fn(async () => {});
    await registerDeferredReceiptWork(db, coordinator, { resume: async () => {}, settleTaskChat: async () => {},
      createNativeBatch: () => dispatchNative, schedulingSuppressed: async () => false }, () => !drain).ready;
    await vi.advanceTimersByTimeAsync(initialAt.getTime() + 10_000 - Date.now());
    const movedAt = new Date();
    await db.update(agentWakeupRequests).set({ updatedAt: movedAt }).where(eq(agentWakeupRequests.id, wake.id));
    await vi.advanceTimersByTimeAsync(initialAt.getTime() + 30_000 - Date.now());
    await waitForReal(() => expect(idleWorkSnapshot().active).toBe(0));
    expect(dispatchNative).not.toHaveBeenCalled(); expect(coordinator.nextWakeAt()).toBe(movedAt.getTime() + 30_000);
    await vi.advanceTimersByTimeAsync(movedAt.getTime() + 30_000 - Date.now());
    await waitForReal(() => expect(dispatchNative).toHaveBeenCalledTimes(1)); await quiet();
  });
  it("arms one new wait reason grace and stays quiet when that same gate is still closed", async () => {
    const f = await fixture(); let reason = "operator_pause";
    const resume = vi.fn(async (scope: { companyId?: string; requestId?: string }) => {
      await writeDeferredExecutionWait(db, { companyId: scope.companyId!, requestId: scope.requestId! }, { reason });
    });
    await registerDeferredReceiptWork(db, coordinator, { resume, settleTaskChat: async () => {}, createNativeBatch: () => async () => {},
      schedulingSuppressed: async () => false }, () => !drain).ready;
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "on_demand", status: "deferred_issue_execution", reason: "task_retry" }).returning();
    for (const nextReason of ["operator_pause", "budget_pause"]) {
      reason = nextReason;
      await writeDeferredExecutionWait(db, { companyId: f.companyId, requestId: wake.id }, { reason });
      const [current] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
      const due = current.updatedAt.getTime() + 30_000;
      await vi.advanceTimersByTimeAsync(1_000);
      await waitForReal(() => expect(coordinator.nextWakeAt()).toBe(due));
      const checked = resume.mock.calls.length;
      await vi.advanceTimersByTimeAsync(due - Date.now());
      await waitForReal(() => expect(resume).toHaveBeenCalledTimes(checked + 1));
      await quiet();
    }
    expect(resume).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])("reactivates a saved Retry through ordinary restore cancelled task (held unrelated Retry: %s)", async heldFollowup => {
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
    await waitForReal(() => { expect(coordinator.nextWakeAt()).toBeNull(); expect(idleWorkSnapshot().active).toBe(0); }, { timeout: 5_000 });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!)))[0].runId).toBeNull();
    let releaseFollowup: (() => void) | undefined;
    let draining: Promise<void> | undefined;
    let drained = false;
    const providerErrors: unknown[] = [];
    try {
      if (heldFollowup) {
        const other = await fixture();
        const release = new Promise<void>(resolve => { releaseFollowup = resolve; });
        let admitted = false;
        const listener = createServer(async (incoming, response) => {
          try {
            let body = "";
            for await (const chunk of incoming) body += chunk;
            const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, body));
            expect(run).toMatchObject({ companyId: other.companyId, agentId: other.agent.id, status: "running" });
            admitted = true;
            await release;
            await issueService(db).update(other.issue.id, { status: "done" });
            response.end("ok");
          } catch (error) { providerErrors.push(error); response.statusCode = 500; response.end("failed"); }
        });
        extraStops.push(async () => {
          const closed = new Promise<void>(resolve => listener.close(() => resolve()));
          listener.closeAllConnections(); await closed;
        });
        await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
        const port = (listener.address() as { port: number }).port;
        const script = `fetch("http://127.0.0.1:${port}", {method:"POST",body:process.env.PAPERCLIP_RUN_ID}).then(async response=>{if(!response.ok)throw new Error(await response.text());console.log("held-retry-proof")}).catch(error=>{console.error(error);process.exitCode=1})`;
        await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", script], cwd: process.cwd() } }).where(eq(agents.id, other.agent.id));
        await requestTaskRetry({ db, companyId: other.companyId, issueId: other.issue.id, actorId: other.actorId,
          observedRunId: other.source.id, idempotencyKey: randomUUID() });
        await waitForReal(() => expect(admitted).toBe(true), { timeout: 15_000 });
      }
      await commitEligibility();
      let runId: string | null = null;
      await waitForReal(async () => {
        const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!));
        expect(wake.runId, JSON.stringify(wake)).toBeTruthy(); runId = wake.runId;
      }, { timeout: 15_000 });
      if (heldFollowup) {
        await waitForReal(async () => {
          const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
          expect(run.status).toBe("succeeded"); expect(run.stdoutExcerpt).toContain("receipt-proof");
        }, { timeout: 15_000 });
        draining = heartbeat.drainActiveRunExecutions().then(() => { drained = true; });
        await immediate();
        expect(drained).toBe(false);
      }
      // Observe this Retry before closing the task and draining unrelated runs.
      await waitForReal(async () => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId!));
        expect(run.status, JSON.stringify({ error: run.error, code: run.errorCode })).toBe("succeeded");
        expect(run.stdoutExcerpt).toContain("receipt-proof");
      }, { timeout: 15_000 });
      expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${request.requestId}`)).toHaveLength(1);
      if (heldFollowup) expect(drained).toBe(false);
      releaseFollowup?.();
      await finish(f.issue.id);
      await draining;
      expect(providerErrors).toEqual([]);
      await quiet();
    } finally {
      releaseFollowup?.();
      await draining;
    }
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
    await registerDeferredReceiptWork(db, coordinator, { resume: vi.fn(), settleTaskChat: vi.fn(), createNativeBatch: () => dispatchNative,
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
