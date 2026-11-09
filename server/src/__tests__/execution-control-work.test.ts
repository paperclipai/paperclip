import { writeExecutionControl } from "../services/execution-control-notifications.js";
import { reconcileSafeNativeReplacements } from "../services/native-runtime/native-safe-replacement.js";
import { localAiLoginService } from "../services/local-ai-login.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations, applyPendingMigrations } from "@paperclipai/db";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { executionControlSchedule, registerExecutionControlWork } from "../services/execution-control-work.js";
import { deliverExecutionStatuses } from "../services/execution-status-delivery.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
import { reconcileAbandonedExecutionControl } from "../services/execution-control-reconciliation.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { markExecutionReconciliation, deliverReconciledExecutions, settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => { for (const worker of coordinators.splice(0)) await worker.stop(); vi.useRealTimers(); });
function coordinator(owner: object, canRun = () => true, onError: (error: unknown) => void = vi.fn()) {
  const c = createDeliveryWorkCoordinator({ owner, canRun, canReconcile: () => true, onError });
  coordinators.push(c); return c;
}
function fakeOwner() {
  const execute = vi.fn(async () => [{ xid: "42" }]);
  const owner = installDatabaseWorkSignals({ execute, async transaction(fn: (tx: any) => Promise<any>): Promise<any> {
    return fn({ execute, transaction: owner.transaction });
  } });
  return owner;
}

describe("execution-control lifecycle", () => {
  it.each(["startup", "commit", "failure"])("retains %s work through drain without querying while paused", async kind => {
    vi.useFakeTimers();
    const owner = fakeOwner(); let draining = kind === "startup";
    const errors = vi.fn(); const c = coordinator(owner, () => !draining, errors);
    const run = vi.fn(async () => {}), next = vi.fn(async () => null);
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionStatus, run, next }]).ready;
    if (kind !== "startup") {
      if (kind === "failure") run.mockRejectedValueOnce(new Error("delivery unavailable"));
      else draining = true;
      await owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.executionStatus));
      await vi.advanceTimersByTimeAsync(15_000);
      draining = true;
    }
    const reads = next.mock.calls.length, runs = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(next).toHaveBeenCalledTimes(reads); expect(run).toHaveBeenCalledTimes(runs);
    draining = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(run).toHaveBeenCalledTimes(runs + 1);
    expect(c.nextWakeAt()).toBeNull();
  });
  it("keeps a change arriving during a sweep and does not overlap it", async () => {
    vi.useFakeTimers(); const owner = fakeOwner(); const c = coordinator(owner);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const run = vi.fn(async () => {});
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionStatus, run, next: async () => null }]).ready;
    run.mockImplementationOnce(() => gate);
    await owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.executionStatus));
    await vi.advanceTimersByTimeAsync(15_000);
    await owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.executionStatus));
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    release(); await vi.advanceTimersByTimeAsync(15_000);
    expect(run).toHaveBeenCalledTimes(3); expect(c.nextWakeAt()).toBeNull();
  });
  it("coalesces tenant write bursts without repeatedly scanning global queues", async () => {
    vi.useFakeTimers(); const owner = fakeOwner(); const c = coordinator(owner);
    const run = vi.fn(async () => {}), next = vi.fn(async () => null);
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionStatus, run, next }]).ready;
    for (let i = 0; i < 100; i++) {
      await owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.executionStatus, `company-${i % 2}`));
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(run).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(run).toHaveBeenCalledTimes(2); expect(next).toHaveBeenCalledTimes(2);
    expect(c.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])("does not start sweeps or inspect deadlines once server shutdown begins (notification=%s)", async notification => {
    vi.useFakeTimers(); const owner = fakeOwner(); const c = coordinator(owner); let stopping = false;
    const run = vi.fn(async () => {}), next = vi.fn(async () => Date.now() + 1000);
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionStatus, run, next }], () => !stopping).ready;
    stopping = true;
    if (notification) await owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.executionStatus));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(1);
    await c.stop(); expect(c.nextWakeAt()).toBeNull();
  });
  it("keeps other obligations responsive while one is waiting, and awaits shutdown", async () => {
    vi.useFakeTimers(); const owner = fakeOwner(); const c = coordinator(owner);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const status = vi.fn(async () => {});
    const started = registerExecutionControlWork(c, [
      { queue: DELIVERY_QUEUES.executionReplacement, run: () => gate, next: async () => null },
      { queue: DELIVERY_QUEUES.executionStatus, run: status, next: async () => null },
    ]);
    await vi.advanceTimersByTimeAsync(1); expect(status).toHaveBeenCalledTimes(1);
    let stopped = false; const stopping = c.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(1); expect(stopped).toBe(false);
    release(); await started.ready; await stopping; expect(stopped).toBe(true);
  });
});

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_EXECUTION_SLEEP_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("execution-control durable work", () => {
  let db: ReturnType<typeof createDb>, observed: typeof db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let calls: number, companyId: string, agentId: string, issueId: string;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else temporary = await startEmbeddedPostgresTestDatabase("execution-sleep-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6 });
  }, 90000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    companyId = randomUUID(); agentId = randomUUID(); issueId = randomUUID(); calls = 0; errors.length = 0;
    await db.insert(companies).values({ id: companyId, name: "Idle execution", issuePrefix: "EXE" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Execution", status: "in_progress", assigneeAgentId: agentId });
    observed = new Proxy(db, { get(target, key) {
      if (!["select", "update", "insert", "delete", "execute", "transaction"].includes(String(key))) return Reflect.get(target, key);
      return (...args: unknown[]) => { calls++; return Reflect.apply(Reflect.get(target, key), target, args); };
    } });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  });
  async function settle() {
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0), { timeout: 5000 });
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0), { timeout: 5000 });
    expect(errors).toEqual([]);
  }
  async function quiet(c: ReturnType<typeof coordinator>) {
    await settle(); expect(c.nextWakeAt()).toBeNull(); const before = calls;
    await vi.advanceTimersByTimeAsync(90_000); expect(calls).toBe(before);
  }
  async function runRow(status = "running") {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status, runtimeMode: "legacy", contextSnapshot: { issueId } }).returning();
    return run!;
  }
  it("stops all six pending/deadline scans with empty queues and completed history", async () => {
    await runRow("succeeded");
    const schedule = executionControlSchedule(observed);
    const c = coordinator(db, undefined, error => { errors.push(error); });
    const topics = [DELIVERY_QUEUES.executionFinalization, DELIVERY_QUEUES.executionReplacement, DELIVERY_QUEUES.executionContinuation,
      DELIVERY_QUEUES.executionStatus, DELIVERY_QUEUES.executionDisposition, DELIVERY_QUEUES.localLoginCleanup];
    const runs = [() => reconcileAbandonedExecutionControl(observed), () => reconcileSafeNativeReplacements(observed),
      () => deliverReconciledExecutions(observed, vi.fn(async () => null)), () => deliverExecutionStatuses(observed),
      () => settleUnrecoverableExecutions(observed), () => localAiLoginService(observed).reapExpired()];
    await registerExecutionControlWork(c, Object.values(schedule).map((next, i) => ({ queue: topics[i]!, run: runs[i]!, next }))).ready;
    await quiet(c);
  });
  it("bounds real producer bursts with another company's completed history present", async () => {
    const otherCompany = randomUUID(), otherAgent = randomUUID();
    await db.insert(companies).values({ id: otherCompany, name: "Other tenant", issuePrefix: "OTH" });
    await db.insert(agents).values({ id: otherAgent, companyId: otherCompany, name: "Other worker", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ companyId: otherCompany, agentId: otherAgent, status: "succeeded" });
    const run = await runRow(); const publish = vi.fn(); const c = coordinator(db, undefined, error => { errors.push(error); });
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionStatus,
      run: () => deliverExecutionStatuses(observed, { publish }), next: executionControlSchedule(observed).status }]).ready;
    const before = calls;
    for (let i = 0; i < 20; i++) {
      await terminalizeLegacyExecution({ db, run, status: "succeeded", fromStatuses: ["running", "succeeded"] });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(calls).toBe(before); expect(publish).not.toHaveBeenCalled();
    await settle(); expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toMatchObject({ companyId, payload: { runId: run.id } });
    await quiet(c);
  });
  it("wakes status delivery through the real producer only after outer commit, then becomes quiet", async () => {
    const run = await runRow(); const publish = vi.fn(); const c = coordinator(db, undefined, error => { errors.push(error); });
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionStatus,
      run: () => deliverExecutionStatuses(observed, { publish }), next: executionControlSchedule(observed).status }]).ready;
    await quiet(c);
    await db.transaction(async tx => {
      await terminalizeLegacyExecution({ db: tx as unknown as typeof db, run, status: "succeeded", patch: { finishedAt: new Date() } });
      await vi.advanceTimersByTimeAsync(1); expect(publish).not.toHaveBeenCalled();
    });
    await settle(); expect(publish).toHaveBeenCalledTimes(1);
    await quiet(c);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(saved?.status).toBe("succeeded"); expect(saved?.executionStatusDeliveryId).toBeNull();
  });
  it("rolls back a nested producer without delivering or leaving periodic work", async () => {
    const run = await runRow(), publish = vi.fn(); const c = coordinator(db, undefined, error => { errors.push(error); });
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionStatus,
      run: () => deliverExecutionStatuses(observed, { publish }), next: executionControlSchedule(observed).status }]).ready;
    await expect(db.transaction(async tx => {
      await terminalizeLegacyExecution({ db: tx as unknown as typeof db, run, status: "succeeded" });
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await quiet(c); expect(publish).not.toHaveBeenCalled();
  });
  it("restores an exact control deadline on restart without querying before it", async () => {
    const run = await runRow("succeeded"), due = new Date(Date.now() + 60_000);
    await db.update(heartbeatRuns).set({ executionControlDeadlineAt: due }).where(eq(heartbeatRuns.id, run.id));
    const c = coordinator(db, undefined, error => { errors.push(error); });
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionFinalization,
      run: () => reconcileAbandonedExecutionControl(observed), next: executionControlSchedule(observed).finalization }]).ready;
    expect(c.nextWakeAt()).toBe(due.getTime()); const before = calls;
    await vi.advanceTimersByTimeAsync(55_000); expect(calls).toBe(before);
    await vi.advanceTimersByTimeAsync(5000); await settle(); await quiet(c);
  });
  it("retains replacement retries for an unresolved failed execution, excludes completed/denied history", async () => {
    const run = await runRow("failed");
    await db.update(heartbeatRuns).set({ nativeIssueId: issueId }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId, issueId, phase: "terminal_failure", failureCode: "provider_transport_failed" });
    const schedule = executionControlSchedule(observed);
    expect(await schedule.replacement()).toBeGreaterThan(Date.now());
    await db.update(nativeRunFinalizations).set({ failureDetail: { replacementDenied: "operator_reconciled" } }).where(eq(nativeRunFinalizations.runId, run.id));
    expect(await schedule.replacement()).toBeNull();
  });
  it("a recovery-action producer wakes automatic disposition and leaves resolved history quiet", async () => {
    const run = await runRow("failed"); const c = coordinator(db, undefined, error => { errors.push(error); });
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionDisposition,
      run: () => settleUnrecoverableExecutions(observed), next: executionControlSchedule(observed).disposition }]).ready;
    await quiet(c);
    const action = await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "execution_finalization_deadline_exceeded", fingerprint: run.id,
      returnOwnerAgentId: agentId, evidence: { runId: run.id }, nextAction: "Recover execution" });
    await settle();
    expect(await issueRecoveryActionService(db).getActiveForIssue(companyId, issueId)).toBeNull();
    expect(action.id).toBeTruthy(); await quiet(c);
  });
  it("retries a failed broadcast only while its durable marker remains, including after restart", async () => {
    const run = await runRow();
    const publish = vi.fn(() => { throw new Error("receiver unavailable"); });
    let c = coordinator(db, undefined, error => { errors.push(error); });
    const duty = { queue: DELIVERY_QUEUES.executionStatus,
      run: () => deliverExecutionStatuses(observed, { publish }), next: executionControlSchedule(observed).status };
    await registerExecutionControlWork(c, [duty]).ready;
    await terminalizeLegacyExecution({ db, run, status: "succeeded" });
    await settle(); expect(publish).toHaveBeenCalledTimes(1);
    const before = calls;
    await vi.advanceTimersByTimeAsync(10_000); expect(calls).toBe(before);
    await c.stop();
    publish.mockImplementation(() => undefined);
    c = coordinator(db, undefined, error => { errors.push(error); });
    await registerExecutionControlWork(c, [duty]).ready;
    expect(publish).toHaveBeenCalledTimes(2); await quiet(c);
  });
  it("reschedules an earlier deadline and disarms a cancelled deadline", async () => {
    const run = await runRow("succeeded"); const c = coordinator(db, undefined, error => { errors.push(error); });
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionFinalization,
      run: () => reconcileAbandonedExecutionControl(observed), next: executionControlSchedule(observed).finalization }]).ready;
    const due = new Date(Date.now() + 120_000), earlier = new Date(Date.now() + 60_000);
    for (const at of [due, earlier]) {
      await writeExecutionControl(db, DELIVERY_QUEUES.executionFinalization, tx => tx.update(heartbeatRuns)
        .set({ executionControlDeadlineAt: at }).where(eq(heartbeatRuns.id, run.id)));
      await settle(); expect(c.nextWakeAt()).toBe(at.getTime());
    }
    await writeExecutionControl(db, DELIVERY_QUEUES.executionFinalization, tx => tx.update(heartbeatRuns)
      .set({ executionControlDeadlineAt: null }).where(eq(heartbeatRuns.id, run.id)));
    await quiet(c);
  });
  it("delivers a reconciled continuation when marking and resolving commit together", async () => {
    const run = await runRow("failed"), successor = await runRow("queued");
    const action = await issueRecoveryActionService(db).upsertSourceScoped({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", cause: "execution_finalization_deadline_exceeded", fingerprint: run.id,
      returnOwnerAgentId: agentId, evidence: { runId: run.id }, nextAction: "Recover execution" });
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, recoveryActionId: action.id, previousRunId: run.id } })
      .where(eq(heartbeatRuns.id, successor.id));
    const wake = vi.fn(async () => successor), c = coordinator(db, undefined, error => { errors.push(error); });
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
      run: () => deliverReconciledExecutions(observed, wake), next: executionControlSchedule(observed).continuation }]).ready;
    await db.transaction(async tx => {
      await markExecutionReconciliation(tx as unknown as typeof db, action,
        { runId: run.id, providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: "Verified the provider stopped without performing an external action." }, "operator");
      await issueRecoveryActionService(tx).resolveActiveForIssue({ companyId, sourceIssueId: issueId, actionId: action.id, status: "resolved", outcome: "restored" });
      await vi.advanceTimersByTimeAsync(1); expect(wake).not.toHaveBeenCalled();
    });
    await settle(); expect(wake).toHaveBeenCalledTimes(1); await quiet(c);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successor.id));
    expect(saved?.retryOfRunId).toBe(run.id);
  });

});
