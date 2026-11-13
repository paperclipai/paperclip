import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, automaticRunBrakes, companies, createDb, heartbeatRuns, issueRecoveryActions, issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { AUTOMATIC_RUN_BRAKE, automaticRunBrake } from "../services/recovery/automatic-run-brake.js";
import { recoveryService } from "../services/recovery/service.js";
import { ASSIGNED_WORK_CONTINUED_ACTION } from "../services/recovery/assigned-work-sweep.js";
import { taskAutomaticAttempts } from "../services/recovery/task-automatic-attempts.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { continueHeldExecutions, resetBacklogContinuationPacingForTests } from "../services/fresh-continuation-fallback.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

suite("automatic-run brake in the recovery passes", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", agentId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-automatic-run-brake-passes-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  afterEach(async () => {
    automaticRunBrake.reset();
    resetBacklogContinuationPacingForTests(db);
    await db.execute(sql`truncate table automatic_run_brakes, issue_recovery_actions, native_run_finalizations, activity_log,
      agent_wakeup_requests, heartbeat_runs, issues, agents, companies cascade`);
  }, 120_000);

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); }, 120_000);

  async function seedCompany() {
    companyId = randomUUID(); agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Passes", issuePrefix: `P${companyId.replaceAll("-", "").slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }

  const ago = (ms: number) => new Date(Date.now() - ms);

  async function openBrake(options: { waitingAutomaticRun?: boolean } = { waitingAutomaticRun: true }) {
    const failures = await db.insert(heartbeatRuns).values(Array.from({ length: 20 }, (_, index) => ({ companyId, agentId,
      invocationSource: "automation", triggerDetail: "system", runtimeMode: "legacy", status: "failed",
      errorCode: "environment_provider_unavailable", executionStage: "preparing", createdAt: ago(3 * MINUTE + index),
      startedAt: ago(2 * MINUTE + index), finishedAt: ago(MINUTE - index * 100),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { wakeReason: "transient_failure_retry", issueId: randomUUID() } }))).returning();
    if (options.waitingAutomaticRun) {
      await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", triggerDetail: "system",
        status: "queued", contextSnapshot: { wakeReason: "issue_continuation_needed", previousRunId: failures[0]!.id, issueId: randomUUID() } });
    }
    expect((await automaticRunBrake.refresh(db, companyId)).state).toBe("open");
    return failures;
  }

  async function recover(failures: Array<{ id: string }>) {
    await db.update(heartbeatRuns).set({ createdAt: sql`created_at - interval '1 hour'`, startedAt: sql`started_at - interval '1 hour'`,
      finishedAt: sql`finished_at - interval '1 hour'` }).where(inArray(heartbeatRuns.id, failures.map(run => run.id)));
    await db.insert(heartbeatRuns).values(Array.from({ length: 2 }, () => ({ companyId, agentId, invocationSource: "automation",
      triggerDetail: "system", runtimeMode: "legacy", status: "succeeded", executionStage: "dispatching", createdAt: ago(MINUTE),
      startedAt: ago(50_000), finishedAt: ago(1_000), contextSnapshot: { wakeReason: "transient_failure_retry", issueId: randomUUID() } })));
    await db.update(automaticRunBrakes).set({ stateChangedAt: sql`state_changed_at - ${`${AUTOMATIC_RUN_BRAKE.minOpenMs} milliseconds`}::interval` })
      .where(eq(automaticRunBrakes.companyId, companyId));
    expect((await automaticRunBrake.refresh(db, companyId)).state).toBe("half_open");
  }

  async function strandedTask() {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue the work", status: "in_progress", assigneeAgentId: agentId,
      updatedAt: ago(3 * HOUR), createdAt: ago(5 * HOUR) });
    await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "on_demand", status: "interrupted",
      errorCode: "server_shutdown_interrupted", startedAt: ago(4 * HOUR), finishedAt: ago(3 * HOUR), livenessState: "needs_followup",
      createdAt: ago(4 * HOUR), contextSnapshot: { issueId, taskId: issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    return issueId;
  }

  function wakeQueue() {
    const enqueueWakeup = vi.fn(async (wakeAgentId: string, opts?: { payload?: Record<string, unknown> | null; reason?: string | null }) => {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: wakeAgentId, source: "automation",
        triggerDetail: "system", reason: opts?.reason ?? null, payload: opts?.payload ?? null, status: "queued" }).returning();
      return { id: wake!.id } as never;
    });
    return enqueueWakeup;
  }

  const ledger = async (issueId: string) => (await taskAutomaticAttempts(db, companyId, issueId, new Date())).all.length;
  const continuedActivity = async (issueId: string) => db.select().from(activityLog)
    .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION)));

  it("the assigned-work sweep defers continuations while open without spending the task's attempts, and resumes by itself", async () => {
    await seedCompany();
    const issueId = await strandedTask();
    const failures = await openBrake();
    const enqueueWakeup = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry: async () => null });
    for (let pass = 0; pass < 3; pass += 1) {
      const check = await recovery.assignedWork.checkIssue({ companyId, issueId });
      expect(check).toMatchObject({ outcome: "deferred_rate_limit" });
      expect(check!.retryAt!.getTime()).toBeGreaterThan(Date.now() + 30_000);
    }
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await continuedActivity(issueId)).toHaveLength(0);
    expect(await ledger(issueId)).toBe(0);
    expect(await recovery.assignedWork.report(companyId)).toMatchObject({ automaticWork: { state: "open",
      summary: expect.stringMatching(/^Automatic work is paused for this company since .* because the last 5 automatic runs could not get a sandbox\.$/) } });

    await recover(failures);
    expect(await recovery.assignedWork.checkIssue({ companyId, issueId })).toMatchObject({ outcome: "repaired" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(await ledger(issueId)).toBe(1);

    await db.update(automaticRunBrakes).set({ stateChangedAt: sql`state_changed_at
      - ${`${AUTOMATIC_RUN_BRAKE.releaseSteps * AUTOMATIC_RUN_BRAKE.releaseIntervalMs} milliseconds`}::interval` })
      .where(eq(automaticRunBrakes.companyId, companyId));
    expect((await automaticRunBrake.refresh(db, companyId)).state).toBe("closed");
    expect((await recovery.assignedWork.report(companyId)).automaticWork).toMatchObject({ state: "closed",
      summary: "Automatic work is running normally." });
  }, 120_000);

  it("the sweep still continues one task a minute while open when nothing automatic is waiting", async () => {
    await seedCompany();
    const [first, second] = [await strandedTask(), await strandedTask()];
    await openBrake({ waitingAutomaticRun: false });
    const enqueueWakeup = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry: async () => null });
    expect(await recovery.assignedWork.checkIssue({ companyId, issueId: first })).toMatchObject({ outcome: "repaired" });
    expect(await recovery.assignedWork.checkIssue({ companyId, issueId: second })).toMatchObject({ outcome: "deferred_rate_limit" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  }, 120_000);

  async function pendingContinuation() {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue the work", status: "todo", assigneeAgentId: agentId });
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, invocationSource: "assignment", status: "failed",
      errorCode: "server_shutdown_interrupted", startedAt: ago(3 * MINUTE), finishedAt: ago(2 * MINUTE), createdAt: ago(4 * MINUTE),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" } }).returning();
    const recordedAt = new Date().toISOString();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "resolved", outcome: "handed_back", resolvedAt: new Date(), ownerType: "board", returnOwnerAgentId: agentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${source!.id}`, nextAction: "Continue the task.",
      attemptCount: 1, evidence: { runId: source!.id, originalFailureCode: "server_shutdown_interrupted", continuationDelivery: "pending",
        freshContinuation: { schema: "paperclip.fresh-continuation.v1", reason: "exact_resumption_unavailable", recordedAt },
        freshContinuationSettlement: { recordedAt },
        executionReconciliation: { runId: source!.id, observedOutcome: "unknown", disposition: "continue_fresh",
          actorId: "execution-recovery", recordedAt } } }).returning();
    return action!;
  }

  it("the continuation delivery leaves pending continuations pending while open and delivers them after", async () => {
    await seedCompany();
    const action = await pendingContinuation();
    const failures = await openBrake();
    const wake = vi.fn(async (wakeAgentId: string, opts: { contextSnapshot: Record<string, unknown> }) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: wakeAgentId, invocationSource: "automation",
        triggerDetail: "system", status: "queued", contextSnapshot: opts.contextSnapshot }).returning();
      return run!;
    });
    const delivery = async () => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0]!
      .evidence.continuationDelivery;
    await deliverReconciledExecutions(db, wake as never);
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
    expect(await delivery()).toBe("pending");
    await recover(failures);
    await db.delete(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "queued")));
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(await delivery()).toBe("delivered");
  }, 120_000);

  async function heldBacklog() {
    const issueId = randomUUID(), runId = randomUUID();
    const finishedAt = ago(HOUR);
    await db.insert(issues).values({ id: issueId, companyId, title: "Ship the notes", status: "blocked", assigneeAgentId: agentId,
      statusVersion: 4, blockedTransitionAt: finishedAt });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", errorCode: "native_restart_recovery_blocked", error: "native_restart_recovery_blocked",
      startedAt: new Date(finishedAt.getTime() - 10 * MINUTE), finishedAt, createdAt: new Date(finishedAt.getTime() - 11 * MINUTE),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" }, nativePhase: "terminal_failure" });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure", recoveryState: "blocked",
      failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "resolved", outcome: "blocked", resolvedAt: finishedAt, ownerType: "board", returnOwnerAgentId: agentId,
      cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuation:${runId}`, nextAction: "Continue.",
      maxAttempts: 3, createdAt: finishedAt, evidence: { runId, originalFailureCode: "native_restart_recovery_blocked",
        nativeFailureBlock: { runId, statusVersion: 4 }, automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked",
          actionOutcome: "unknown", recordedAt: finishedAt.toISOString() } } }).returning();
    return { runId, actionId: action!.id };
  }

  it("the held backlog records a wait until the next try while open and continues after", async () => {
    await seedCompany();
    const held = await heldBacklog();
    const failures = await openBrake();
    expect(await continueHeldExecutions(db, new Date())).toMatchObject({ continued: 0 });
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, held.actionId));
    expect(action!.evidence).toMatchObject({ freshContinuationCheck: { kind: "backoff" } });
    expect(action!.evidence.freshContinuation).toBeUndefined();
    const nextCheckAt = Number((action!.evidence.freshContinuationCheck as { nextCheckAt: number }).nextCheckAt);
    expect(nextCheckAt).toBeGreaterThan(Date.now() + 30_000);
    expect(await continueHeldExecutions(db, new Date())).toMatchObject({ checked: 0 });

    await recover(failures);
    resetBacklogContinuationPacingForTests(db);
    expect(await continueHeldExecutions(db, new Date(nextCheckAt + 1_000))).toMatchObject({ continued: 1 });
  }, 120_000);
});
