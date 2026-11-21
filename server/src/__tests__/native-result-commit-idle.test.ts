import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, completionContracts, createDb, heartbeatRuns, issueRecoveryActions, issues,
  nativeRunFinalizations, nativeRunResults, statusDecisions, workspaceOperations, type Db } from "@paperclipai/db";
import { subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyNativeFinalizationWork } from "../services/native-finalization-notifications.js";
import { notifyNativeResultCommit } from "../services/native-result-commit-notifications.js";
import { nativeStatusReassessmentWork } from "../services/native-runtime/native-status-reassessment-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { buildIssueMonitorTriggeredPatch, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { nativeResultCommitWork } from "../services/native-runtime/native-result-commit-work.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import * as monitorDelivery from "../services/native-runtime/native-monitor-delivery.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("native result commit of a recorded unfinalizable result", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-result-commit-idle-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; passes.length = 0;
    vi.useRealTimers();
    expect(errors.splice(0)).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  type Shape = "in_progress" | "blocked";
  const syncReference = { schema: "paperclip.native-workspace-sync/v3", state: "finalized", descriptorSha256: "a".repeat(64),
    baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: "workspace", leaseId: "lease",
    providerLeaseId: "provider-lease", remoteCwd: "/workspace" };
  async function seed(shape: Shape = "in_progress") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Idle commits", issuePrefix: `I${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "active" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Saved check", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const nextCheckAt = new Date(Date.now() + 60_000).toISOString();
    await new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId }).execute({
      tool: "set_task_monitor", callId: randomUUID(), arguments: { idempotencyKey: "saved-monitor",
        monitor: { nextCheckAt, notes: "Check the saved result." } } });
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "test", criteria: [] }, canonicalSha256: randomUUID(),
      createdByActorType: "system", createdByActorId: "test" });
    const accepted = { result: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded",
      summary: "Wait for the saved check.", completionClaim: { contractRevision: "test", objectiveSatisfied: false,
        criteria: [], remainingWork: [{ description: "Check again", blocksCompletion: true }] },
      continuation: { kind: "monitor", summary: "Wait for the check", idempotencyKey: "provider-selected" },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] },
      terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "yielded" } };
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(Date.now() - 3_600_000),
      completionContractId: contractId, ...(shape === "blocked" ? { errorCode: "native_workspace_sync_out_retry_exhausted",
        runnerProfileJson: { nativeWorkspaceSync: syncReference } } : {}) }).where(eq(heartbeatRuns.id, runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
      serverFingerprint: randomUUID(), canonicalSha256: randomUUID(), schemaStatus: "accepted", resultJson: accepted });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "retryable_failure", resultId,
      attempt: shape === "blocked" ? 1 : 0 });
    await db.insert(workspaceOperations).values({ companyId, issueId, heartbeatRunId: runId,
      phase: "workspace_finalize", status: "succeeded" });
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    await db.update(issues).set({ ...buildIssueMonitorTriggeredPatch({ issue: task!,
      policy: normalizeIssueExecutionPolicy(task!.executionPolicy), triggeredAt: new Date() }), executionRunId: null, checkoutRunId: null,
      ...(shape === "blocked" ? { status: "blocked" } : {}),
    }).where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, runId, nextCheckAt };
  }

  const passes: string[] = [];
  const counted: typeof finalizeNativeRun = input => { passes.push(input.runId); return finalizeNativeRun(input); };
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => errors.push(error) });
    const commits = nativeResultCommitWork(db, counted).register(coordinator, () => true);
    const reassessments = nativeStatusReassessmentWork(db).register(coordinator, () => true);
    await Promise.all([commits.ready, reassessments.ready]);
  }
  async function advance(ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await vi.advanceTimersByTimeAsync(Math.min(1_000, until - Date.now())); await delay(1);
      while (idleWorkSnapshot().active > 0) await delay(5);
    }
  }
  async function observe(work: () => Promise<unknown>) {
    const statements: string[] = [], signals: string[] = [], prior = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { statements.push(query); };
    const unsubscribe = Object.values(DELIVERY_QUEUES).map(queue =>
      subscribeDatabaseWork(db, queue, event => { if (event === "settled") signals.push(queue); }));
    const before = passes.length;
    try { await work(); } finally {
      db.$client.options.debug = prior;
      for (const stop of unsubscribe) stop();
    }
    return { statements: statements.length, signals: signals.length, passes: passes.length - before };
  }
  const coordinatorRow = async (runId: string) =>
    (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0]!;

  async function recordLostMonitor(shape: Shape = "in_progress") {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const f = await seed(shape);
    const first = await observe(async () => { await start(); await advance(60_000); });
    expect(first.passes).toBe(1);
    const recorded = await coordinatorRow(f.runId);
    expect(recorded).toMatchObject({ phase: "retryable_failure", failureCode: "monitor_wait_authority_lost" });
    const decisions = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId));
    expect(decisions.map(decision => decision.reasonCode)).toEqual(["monitor_wait_authority_lost"]);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)))
      .toMatchObject([{ status: "active", kind: "active_run_watchdog" }]);
    return { ...f, recorded };
  }

  it.each<Shape>(["in_progress", "blocked"])("stays quiet for half an hour once a %s task's lost monitor authority is recorded", async shape => {
    const f = await recordLostMonitor(shape);
    const runBefore = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    const idle = await observe(() => advance(30 * 60_000));
    expect(idle).toEqual({ statements: 0, signals: 0, passes: 0 });
    const runAfter = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    expect(runAfter.updatedAt).toEqual(runBefore.updatedAt);
    expect(await coordinatorRow(f.runId)).toMatchObject({ phase: "retryable_failure", failureCode: "monitor_wait_authority_lost",
      decisionId: f.recorded.decisionId, updatedAt: f.recorded.updatedAt });
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId))).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!.status).toBe(shape);
  }, 300_000);

  it("ignores repeated hints for a recorded result without finalizing it again", async () => {
    const f = await recordLostMonitor();
    const hinted = await observe(async () => {
      for (let index = 0; index < 3; index += 1) {
        await db.transaction(async tx => { await notifyNativeFinalizationWork(tx, { companyId: f.companyId, runId: f.runId }); });
        await advance(5_000);
      }
    });
    expect(hinted.passes).toBe(0);
    expect(await coordinatorRow(f.runId)).toMatchObject({ updatedAt: f.recorded.updatedAt });
  }, 300_000);

  it("still commits promptly once a failed workspace save is followed by a successful one", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const f = await seed();
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "failed", projectRunStatus: true });
    expect(await coordinatorRow(f.runId)).toMatchObject({ phase: "retryable_failure", failureCode: "workspace_finalization_failed" });
    await start();
    await advance(60_000);
    expect(passes.filter(runId => runId === f.runId)).toHaveLength(1);
    expect(await coordinatorRow(f.runId)).toMatchObject({ phase: "retryable_failure", failureCode: "monitor_wait_authority_lost" });
    const idle = await observe(() => advance(30 * 60_000));
    expect(idle).toEqual({ statements: 0, signals: 0, passes: 0 });
  }, 300_000);

  it("still finalizes a new accepted result for the same run", async () => {
    const f = await recordLostMonitor();
    const [result] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
    const resultId = randomUUID();
    await db.transaction(async tx => {
      await notifyNativeResultCommit(tx, { companyId: f.companyId, runId: f.runId });
      await tx.insert(nativeRunResults).values({ ...result!, id: resultId, serverFingerprint: randomUUID(), canonicalSha256: randomUUID() });
      await tx.update(nativeRunFinalizations).set({ resultId }).where(eq(nativeRunFinalizations.runId, f.runId));
    });
    await advance(5_000);
    expect(passes.filter(runId => runId === f.runId)).toHaveLength(2);
    expect(await coordinatorRow(f.runId)).toMatchObject({ resultId, failureCode: "monitor_wait_authority_lost" });
  }, 300_000);

  it("settles a recorded result promptly once its monitor wake reaches a successor run", async () => {
    const f = await recordLostMonitor();
    await advance(10 * 60_000);
    const successorId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: successorId, companyId: f.companyId, agentId: f.agentId, status: "running",
      contextSnapshot: { issueId: f.issueId }, createdAt: new Date() });
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "issue_monitor_due", status: "claimed", runId: successorId,
      idempotencyKey: `issue-monitor:${f.issueId}:${f.nextCheckAt}`, payload: { issueId: f.issueId, nextCheckAt: f.nextCheckAt } });
    await db.transaction(async tx => {
      await notifyNativeResultCommit(tx, { companyId: f.companyId, issueId: f.issueId });
      await tx.update(issues).set({ executionRunId: successorId, checkoutRunId: successorId, updatedAt: new Date() })
        .where(eq(issues.id, f.issueId));
    });
    await advance(5_000);
    expect(passes.filter(runId => runId === f.runId)).toHaveLength(2);
    expect(await coordinatorRow(f.runId)).toMatchObject({ phase: "committed" });
    expect((await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId))).map(row => row.reasonCode))
      .toContain("scheduled_monitor_dispatched");
    const idle = await observe(() => advance(30 * 60_000));
    expect(idle).toEqual({ statements: 0, signals: 0, passes: 0 });
  }, 300_000);

  it("reassesses a recorded result once the board changes its task", async () => {
    const f = await recordLostMonitor("blocked");
    await advance(10 * 60_000);
    await db.transaction(async tx => {
      await notifyNativeResultCommit(tx, { companyId: f.companyId, issueId: f.issueId });
      await tx.update(issues).set({ assigneeAgentId: null, updatedAt: new Date() }).where(eq(issues.id, f.issueId));
    });
    await advance(5_000);
    expect(passes.filter(runId => runId === f.runId)).toHaveLength(2);
    const idle = await observe(() => advance(30 * 60_000));
    expect(idle).toEqual({ statements: 0, signals: 0, passes: 0 });
  }, 300_000);

  it("settles a monitor wake that reaches a successor run during finalization", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const f = await seed();
    const successorId = randomUUID();
    const original = monitorDelivery.readNativeMonitorDelivery;
    const race = vi.spyOn(monitorDelivery, "readNativeMonitorDelivery").mockImplementationOnce(async (...args) => {
      const before = await original(...args);
      await db.insert(heartbeatRuns).values({ id: successorId, companyId: f.companyId, agentId: f.agentId, status: "running",
        contextSnapshot: { issueId: f.issueId }, createdAt: new Date(Date.now() - 1_000) });
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
        reason: "issue_monitor_due", status: "claimed", runId: successorId,
        idempotencyKey: `issue-monitor:${f.issueId}:${f.nextCheckAt}`, payload: { issueId: f.issueId, nextCheckAt: f.nextCheckAt } });
      await db.update(issues).set({ executionRunId: successorId, checkoutRunId: successorId, updatedAt: new Date(Date.now() - 1_000) })
        .where(eq(issues.id, f.issueId));
      return before;
    });
    try {
      await start();
      await advance(60_000);
    } finally { race.mockRestore(); }
    expect(await coordinatorRow(f.runId)).toMatchObject({ phase: "committed" });
    expect((await db.select().from(statusDecisions).where(eq(statusDecisions.runId, f.runId))).map(row => row.reasonCode))
      .toEqual(["scheduled_monitor_dispatched"]);
    const idle = await observe(() => advance(30 * 60_000));
    expect(idle).toEqual({ statements: 0, signals: 0, passes: 0 });
  }, 300_000);
});
