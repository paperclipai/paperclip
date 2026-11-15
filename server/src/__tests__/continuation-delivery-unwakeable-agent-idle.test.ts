import { setImmediate as immediate } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { executionControlSchedule, registerExecutionControlWork } from "../services/execution-control-work.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { deferForUnwakeableAssignee, readmitAgentContinuations } from "../services/recovery/continuation-delivery-attempt.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describeIssueRecovery("continuation delivery to an agent that cannot be woken", () => {
  const state = issueRecoveryFixture();
  const passes = new Set<Promise<unknown>>();
  let lifecycleWorker: ReturnType<typeof configureAgentLifecycle> | undefined;
  const lifecycle = () => lifecycleWorker ??= configureAgentLifecycle(state.db,
    { requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete" });
  afterEach(async () => { await lifecycleWorker?.stop(); lifecycleWorker = undefined; });

  async function seed(status: "paused" | "terminated" | "pending_approval") {
    const f = await state.fixture();
    const db = state.db;
    if (status === "paused") { await createAgentLifecycle(db).pauseAgent(f.agentId); await lifecycle().process(f.agentId); }
    else await db.update(agents).set({ status }).where(eq(agents.id, f.agentId));
    expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0]!.status).toBe(status);
    const [task] = await db.insert(issues).values({ companyId: f.companyId, title: "Continue the work", status: "in_progress",
      assigneeAgentId: f.agentId }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "failed",
      errorCode: "adapter_failed", startedAt: new Date(Date.now() - 3 * MINUTE), finishedAt: new Date(Date.now() - 2 * MINUTE),
      contextSnapshot: { issueId: task!.id } }).returning();
    const recordedAt = new Date().toISOString();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: task!.id,
      kind: "active_run_watchdog", status: "resolved", outcome: "restored", resolvedAt: new Date(), ownerType: "system",
      returnOwnerAgentId: f.agentId, cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${source!.id}`,
      nextAction: "Continue the task.", attemptCount: 1,
      evidence: { runId: source!.id, originalFailureCode: "adapter_failed", continuationDelivery: "pending",
        freshContinuation: { schema: "paperclip.fresh-continuation.v1", sourceRunId: source!.id, trigger: "recovery_refused",
          delivery: "recorded", recordedAt, isolation: "writer_ended", stopProof: "writer_ended" },
        freshContinuationSettlement: { recordedAt },
        executionReconciliation: { runId: source!.id, providerStopped: true, providerStopProof: "writer_ended",
          actionOutcome: "mixed", outcomeEvidence: "The run stopped; the continuation starts from the last saved work.",
          actorId: "fresh-continuation", recordedAt } } }).returning();
    return { ...f, taskId: task!.id, actionId: action!.id };
  }

  async function start(queueOnly = false) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const coordinator = createDeliveryWorkCoordinator({ owner: state.db, canRun: () => true, canReconcile: () => true,
      onError: error => state.errors.push(error) });
    state.coordinator = coordinator;
    const wake = vi.fn(async (agentId: string, opts: Parameters<typeof state.heartbeat.wakeup>[1]) => {
      if (!queueOnly) return state.heartbeat.wakeup(agentId, opts);
      const [agent] = await state.db.select().from(agents).where(eq(agents.id, agentId));
      const [run] = await state.db.insert(heartbeatRuns).values({ companyId: agent!.companyId, agentId, invocationSource: "automation",
        triggerDetail: "system", status: "queued", contextSnapshot: opts?.contextSnapshot ?? {} }).returning();
      return run!;
    });
    const work = registerExecutionControlWork(coordinator, [{ queue: DELIVERY_QUEUES.executionContinuation, run: () => {
      const pass = deliverReconciledExecutions(state.db, wake as never); passes.add(pass);
      void pass.then(() => passes.delete(pass), () => passes.delete(pass));
      return pass;
    }, next: executionControlSchedule(state.db).continuation }]);
    await work.ready;
    return wake;
  }

  async function advance(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await vi.advanceTimersByTimeAsync(Math.min(1_000, until - Date.now()));
      await Promise.allSettled([...passes]); await immediate();
    }
  }

  async function countStatements(work: () => Promise<unknown>) {
    const statements: string[] = [], prior = state.db.$client.options.debug;
    state.db.$client.options.debug = (_connection, query) => { statements.push(query); };
    try { await work(); } finally { state.db.$client.options.debug = prior; }
    return statements;
  }

  const evidence = async (id: string) =>
    (await state.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!.evidence;

  for (const status of ["paused", "terminated", "pending_approval"] as const) {
    it(`waits instead of retrying every pass while the assignee is ${status}`, async () => {
      const f = await seed(status);
      const wake = await start();
      await advance(MINUTE);
      const idle = await countStatements(() => advance(2 * HOUR));
      expect(wake).not.toHaveBeenCalled();
      expect(idle.length).toBeLessThan(300);
      expect(await evidence(f.actionId)).toMatchObject({ continuationDelivery: "pending",
        continuationDeliveryAgentWaits: expect.any(Number) });
      expect(await state.db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId))).toHaveLength(0);
      const [task] = await state.db.select().from(issues).where(eq(issues.id, f.taskId));
      expect(task).toMatchObject({ status: "in_progress", assigneeAgentId: f.agentId });
    }, 600_000);
  }

  it("delivers the continuation within seconds once the paused assignee is resumed", async () => {
    const f = await seed("paused");
    const wake = await start(true);
    await advance(3 * HOUR);
    expect(wake).not.toHaveBeenCalled();
    await createAgentLifecycle(state.db).resumeAgent(f.agentId);
    await lifecycle().process(f.agentId);
    expect((await state.db.select().from(agents).where(eq(agents.id, f.agentId)))[0]!.status).not.toBe("paused");
    await advance(20_000);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await evidence(f.actionId)).toMatchObject({ continuationDelivery: "delivered", continuationRunId: expect.any(String) });
  }, 600_000);

  it("does not store a wait when the assignee is resumed while delivery is checking it", async () => {
    const f = await seed("terminated");
    const [action] = await state.db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>(resolve => { locked = resolve; });
    const resume = state.db.transaction(async tx => {
      await tx.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
      await readmitAgentContinuations(tx as never, { companyId: f.companyId, agentId: f.agentId });
      locked();
      await held;
    });
    await lockTaken;
    const deferred = deferForUnwakeableAssignee(state.db, action!);
    await new Promise(resolve => setTimeout(resolve, 200));
    release();
    await resume;
    expect(await deferred).toBe(false);
    expect(await evidence(f.actionId)).not.toHaveProperty("continuationDeliveryRetryAt");
  }, 60_000);
});
