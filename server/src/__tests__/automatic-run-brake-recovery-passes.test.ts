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
import { CONTINUATION_CAP } from "../services/recovery/assigned-work-invariant.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { continueHeldExecutions, resetBacklogContinuationPacingForTests } from "../services/fresh-continuation-fallback.js";
import { createSystemRecovery } from "../services/system-recovery-state.js";

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

  async function openBrake(options: { startingAutomaticRun?: boolean } = { startingAutomaticRun: true }) {
    const failures = await db.insert(heartbeatRuns).values(Array.from({ length: 20 }, (_, index) => ({ companyId, agentId,
      invocationSource: "automation", triggerDetail: "system", runtimeMode: "legacy", status: "failed",
      errorCode: "environment_provider_unavailable", executionStage: "preparing", createdAt: ago(4 * MINUTE + index),
      startedAt: ago(3 * MINUTE + index), finishedAt: ago(MINUTE - index * 100),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { wakeReason: "transient_failure_retry", issueId: randomUUID() } }))).returning();
    if (options.startingAutomaticRun) {
      await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", triggerDetail: "system",
        status: "running", runtimeMode: "legacy", executionStage: "preparing", startedAt: ago(20_000),
        contextSnapshot: { wakeReason: "issue_continuation_needed", previousRunId: failures[0]!.id, issueId: randomUUID() } });
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

  it("the sweep still continues one task a minute while open when no automatic run is starting", async () => {
    await seedCompany();
    const [first, second] = [await strandedTask(), await strandedTask()];
    await openBrake({ startingAutomaticRun: false });
    const enqueueWakeup = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry: async () => null });
    expect(await recovery.assignedWork.checkIssue({ companyId, issueId: first })).toMatchObject({ outcome: "repaired" });
    expect(await recovery.assignedWork.checkIssue({ companyId, issueId: second })).toMatchObject({ outcome: "deferred_rate_limit" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("a task that loses the creation slot to another sweep check gains no extra wait", async () => {
    await seedCompany();
    const [first, second] = [await strandedTask(), await strandedTask()];
    await openBrake({ startingAutomaticRun: false });
    const enqueueWakeup = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry: async () => null });
    const checks = await Promise.all([first, second].map(issueId => recovery.assignedWork.checkIssue({ companyId, issueId })));
    expect(checks.map(check => check!.outcome).sort()).toEqual(["deferred_rate_limit", "repaired"]);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const loser = checks[0]!.outcome === "deferred_rate_limit" ? first : second;
    expect(await ledger(loser)).toBe(0);
  }, 120_000);

  it("leaves every pass exactly as before when the company has no pause record", async () => {
    await seedCompany();
    const issueId = await strandedTask();
    const action = await pendingContinuation();
    const enqueueWakeup = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry: async () => null });
    const wake = vi.fn(async (wakeAgentId: string, opts: { contextSnapshot: Record<string, unknown> }) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: wakeAgentId, invocationSource: "automation",
        triggerDetail: "system", status: "queued", contextSnapshot: opts.contextSnapshot }).returning();
      return run!;
    });
    expect(await recovery.assignedWork.checkIssue({ companyId, issueId })).toMatchObject({ outcome: "repaired" });
    await deliverReconciledExecutions(db, wake as never);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![1]).toMatchObject({ reason: "issue_recovery_action_restored", contextSnapshot: { recoveryActionId: action.id } });
    expect(await db.select().from(automaticRunBrakes)).toHaveLength(0);
  }, 120_000);

  it("tries again on another agent when the waiting automatic run cannot start, and closes once it works", async () => {
    await seedCompany();
    const otherAgent = randomUUID();
    await db.insert(agents).values({ id: otherAgent, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
    const failures = await openBrake({ startingAutomaticRun: false });
    await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", triggerDetail: "system", status: "queued",
      createdAt: ago(10 * MINUTE), contextSnapshot: { wakeReason: "issue_continuation_needed", previousRunId: failures[0]!.id, issueId: randomUUID() } });
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Review the work", status: "in_progress", assigneeAgentId: otherAgent,
      updatedAt: ago(3 * HOUR), createdAt: ago(5 * HOUR) });
    await db.insert(heartbeatRuns).values({ companyId, agentId: otherAgent, invocationSource: "on_demand", status: "interrupted",
      errorCode: "server_shutdown_interrupted", startedAt: ago(4 * HOUR), finishedAt: ago(3 * HOUR), livenessState: "needs_followup",
      createdAt: ago(4 * HOUR), contextSnapshot: { issueId, taskId: issueId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    const enqueueWakeup = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry: async () => null });
    expect(await recovery.assignedWork.checkIssue({ companyId, issueId })).toMatchObject({ outcome: "repaired" });
    expect(enqueueWakeup.mock.calls[0]![0]).toBe(otherAgent);

    await db.update(heartbeatRuns).set({ finishedAt: sql`finished_at - interval '1 hour'` }).where(inArray(heartbeatRuns.id, failures.map(run => run.id)));
    await db.insert(heartbeatRuns).values({ companyId, agentId: otherAgent, invocationSource: "automation", triggerDetail: "system",
      status: "succeeded", runtimeMode: "legacy", executionStage: "dispatching", startedAt: ago(40_000), finishedAt: ago(1_000),
      contextSnapshot: { wakeReason: "issue_continuation_needed", previousRunId: randomUUID(), issueId } });
    await db.update(automaticRunBrakes).set({ stateChangedAt: sql`state_changed_at - ${`${AUTOMATIC_RUN_BRAKE.minOpenMs} milliseconds`}::interval` })
      .where(eq(automaticRunBrakes.companyId, companyId));
    expect((await automaticRunBrake.refresh(db, companyId)).state).toBe("half_open");
    await db.update(automaticRunBrakes).set({ stateChangedAt: sql`state_changed_at
      - ${`${AUTOMATIC_RUN_BRAKE.releaseSteps * AUTOMATIC_RUN_BRAKE.releaseIntervalMs} milliseconds`}::interval` })
      .where(eq(automaticRunBrakes.companyId, companyId));
    expect((await automaticRunBrake.refresh(db, companyId)).state).toBe("closed");
  }, 120_000);

  it("a delivery its agent refuses gives the creation slot back to the next continuation in the same pass", async () => {
    await seedCompany();
    const otherAgent = randomUUID();
    await db.insert(agents).values({ id: otherAgent, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
    const refused = await pendingContinuation();
    const accepted = await pendingContinuation(otherAgent, 3 * MINUTE);
    await openBrake({ startingAutomaticRun: false });
    const wake = vi.fn(async (wakeAgentId: string, opts: { contextSnapshot: Record<string, unknown> }) => {
      if (wakeAgentId === agentId) return null;
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: wakeAgentId, invocationSource: "automation",
        triggerDetail: "system", status: "queued", contextSnapshot: opts.contextSnapshot }).returning();
      return run!;
    });
    await deliverReconciledExecutions(db, wake as never);
    expect(wake.mock.calls.map(call => call[0])).toEqual([agentId, otherAgent]);
    const delivery = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!
      .evidence.continuationDelivery;
    expect(await delivery(refused.id)).toBe("pending");
    expect(await delivery(accepted.id)).toBe("delivered");
    expect((await db.select().from(automaticRunBrakes))[0]!.nextCreationAt).not.toBeNull();
  }, 120_000);

  it("a capped task gives the creation slot back to the next task the sweep checks", async () => {
    await seedCompany();
    const [capped, next] = [await strandedTask(), await strandedTask()];
    await openBrake({ startingAutomaticRun: false });
    await db.insert(activityLog).values(Array.from({ length: CONTINUATION_CAP }, (_, index) => ({ companyId, actorType: "system",
      actorId: "assigned-work-invariant", action: ASSIGNED_WORK_CONTINUED_ACTION, entityType: "issue", entityId: capped,
      createdAt: ago(10 * MINUTE + index), details: {} })));
    const enqueueWakeup = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry: async () => null });
    expect(await recovery.assignedWork.checkIssue({ companyId, issueId: capped })).toMatchObject({ outcome: "deferred_cap" });
    expect((await db.select().from(automaticRunBrakes))[0]!.nextCreationAt).toBeNull();
    expect(await recovery.assignedWork.checkIssue({ companyId, issueId: next })).toMatchObject({ outcome: "repaired" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  }, 120_000);

  for (const createdBeforeError of [true, false]) {
    it(`a delivery whose wake fails ${createdBeforeError ? "after creating its run keeps" : "before creating a run gives back"} the creation slot`, async () => {
      await seedCompany();
      const otherAgent = randomUUID();
      await db.insert(agents).values({ id: otherAgent, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "codex_local",
        adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
      await pendingContinuation();
      await pendingContinuation(otherAgent, 3 * MINUTE);
      await openBrake({ startingAutomaticRun: false });
      const wake = vi.fn(async (wakeAgentId: string, opts: { contextSnapshot: Record<string, unknown> }) => {
        if (wakeAgentId === agentId && !createdBeforeError) throw new Error("wake refused before creating a run");
        const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: wakeAgentId, invocationSource: "automation",
          triggerDetail: "system", status: "queued", contextSnapshot: opts.contextSnapshot }).returning();
        if (wakeAgentId === agentId) throw new Error("dispatch failed after the run was committed");
        return run!;
      });
      await deliverReconciledExecutions(db, wake as never);
      expect(wake.mock.calls.map(call => call[0])).toEqual(createdBeforeError ? [agentId] : [agentId, otherAgent]);
      expect((await db.select().from(automaticRunBrakes))[0]!.nextCreationAt).not.toBeNull();
    }, 120_000);

    it(`a sweep whose wake fails ${createdBeforeError ? "after creating its run keeps" : "before creating a run gives back"} the creation slot`, async () => {
      await seedCompany();
      const [first, second] = [await strandedTask(), await strandedTask()];
      await openBrake({ startingAutomaticRun: false });
      const enqueueWakeup = vi.fn(async (wakeAgentId: string, opts?: { payload?: Record<string, unknown> | null; contextSnapshot?: Record<string, unknown> }) => {
        const issueId = String(opts?.payload?.issueId);
        if (issueId === first && !createdBeforeError) throw new Error("wake refused before creating a run");
        const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: wakeAgentId, invocationSource: "automation",
          triggerDetail: "system", status: "queued", contextSnapshot: opts?.contextSnapshot ?? { issueId } }).returning();
        if (issueId === first) throw new Error("dispatch failed after the run was committed");
        return { id: run!.id } as never;
      });
      const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry: async () => null });
      await recovery.assignedWork.checkIssue({ companyId, issueId: first });
      expect(await recovery.assignedWork.checkIssue({ companyId, issueId: second }))
        .toMatchObject({ outcome: createdBeforeError ? "deferred_rate_limit" : "repaired" });
    }, 120_000);
  }

  async function pendingContinuation(ownerAgentId = agentId, endedAgoMs = 2 * MINUTE) {
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue the work", status: "todo", assigneeAgentId: ownerAgentId });
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: ownerAgentId, issueId, invocationSource: "assignment", status: "failed",
      errorCode: "server_shutdown_interrupted", startedAt: ago(endedAgoMs + MINUTE), finishedAt: ago(endedAgoMs), createdAt: ago(endedAgoMs + 2 * MINUTE),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" } }).returning();
    const recordedAt = new Date().toISOString();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "resolved", outcome: "handed_back", resolvedAt: new Date(), ownerType: "board", returnOwnerAgentId: ownerAgentId,
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
    await db.delete(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
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

  function runWake() {
    return vi.fn(async (wakeAgentId: string, opts: { contextSnapshot: Record<string, unknown> }) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: wakeAgentId, invocationSource: "automation",
        triggerDetail: "system", status: "queued", contextSnapshot: opts.contextSnapshot }).returning();
      return run!;
    });
  }

  const continuationRecords = async (runId: string) => db.select().from(issueRecoveryActions)
    .where(sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,sourceRunId}' = ${runId}`);

  it("the held backlog records its continuation for free and the delivery creates the run only after the pause", async () => {
    await seedCompany();
    const held = await heldBacklog();
    const failures = await openBrake();
    expect(await continueHeldExecutions(db, new Date())).toMatchObject({ continued: 1 });
    expect(await continuationRecords(held.runId)).toHaveLength(1);
    const wake = runWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
    expect((await db.select().from(automaticRunBrakes))[0]!.nextCreationAt).toBeNull();
    await recover(failures);
    await db.delete(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("the sweep's continuation behind a run refused at dispatch only records, and its delivery creates the run only after the pause", async () => {
    await seedCompany();
    const issueId = randomUUID();
    const blockedAt = ago(20 * MINUTE);
    await db.insert(issues).values({ id: issueId, companyId, title: "Finish the report", status: "blocked", assigneeAgentId: agentId,
      statusVersion: 3, blockedTransitionAt: blockedAt, updatedAt: ago(2 * HOUR), createdAt: ago(5 * HOUR) });
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", status: "failed",
      runtimeMode: "legacy", errorCode: "adapter_failed", error: "native_instruction_materialization_handoff_unavailable",
      startedAt: new Date(blockedAt.getTime() - MINUTE), finishedAt: new Date(blockedAt.getTime() - 500),
      createdAt: new Date(blockedAt.getTime() - 2 * MINUTE), livenessState: "failed",
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } }, resultJson: { workspaceRestoreFailure: "restore_failed" },
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_children_completed" } }).returning();
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", status: "active",
      ownerType: "board", returnOwnerAgentId: agentId, cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${source!.id}`, nextAction: "Held.", createdAt: blockedAt,
      evidence: { runId: source!.id, originalFailureCode: "adapter_failed", workspaceRestoreFailure: "restore_failed",
        systemRecovery: { ...createSystemRecovery(source!.id), state: "complete" } } });
    await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", status: "cancelled",
      errorCode: "execution_reconciliation_required", startedAt: null, retryOfRunId: source!.id, runtimeMode: "legacy",
      finishedAt: new Date(blockedAt.getTime() + 1_000), createdAt: new Date(blockedAt.getTime() - 100), resultJson: {},
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_continuation_needed", retryReason: "issue_continuation_needed" } });
    const enqueueWakeup = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry: async () => null } as never);
    const runsBefore = (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).length;
    expect(await recovery.assignedWork.checkIssue({ companyId, issueId })).toMatchObject({ outcome: "repaired" });
    expect((await continuationRecords(source!.id))[0]?.evidence).toMatchObject({ continuationDelivery: "pending" });
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect((await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).length).toBe(runsBefore);
    const failures = await openBrake();
    const wake = runWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
    await recover(failures);
    await db.delete(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running")));
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
  }, 120_000);

  it("one held task spends one creation slot while open", async () => {
    await seedCompany();
    await heldBacklog();
    await openBrake({ startingAutomaticRun: false });
    expect(await continueHeldExecutions(db, new Date())).toMatchObject({ continued: 1 });
    expect((await db.select().from(automaticRunBrakes))[0]!.nextCreationAt).toBeNull();
    const wake = runWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    expect((await db.select().from(automaticRunBrakes))[0]!.nextCreationAt).not.toBeNull();
  }, 120_000);

  const userWake = (issueId: string, values: Partial<typeof agentWakeupRequests.$inferInsert>) => db.insert(agentWakeupRequests).values({
    companyId, agentId, source: "on_demand", triggerDetail: "manual", reason: "task_retry", status: "deferred_issue_execution",
    requestedByActorType: "user", requestedByActorId: "board", payload: { issueId }, ...values });

  const deliveryShapes: Array<[string, (issueId: string, sourceRunId: string) => Promise<unknown>]> = [
    ["a Retry waiting behind the task", issueId => userWake(issueId, {})],
    ["a move-forward Retry queued for the task", issueId => userWake(issueId, { status: "queued",
      payload: { issueId, taskRetry: { schema: "paperclip.task-retry.v1", sourceRunId: randomUUID() } } })],
    ["a Retry folded into the continuation", issueId => userWake(issueId, { status: "coalesced", finishedAt: new Date(),
      payload: { issueId, coalescedIntoFreshContinuationRun: randomUUID() } })],
    ["a person's message", issueId => userWake(issueId, { reason: "issue_commented", status: "skipped", finishedAt: new Date() })],
    ["a Retry refused at dispatch while the task was held", issueId => db.insert(heartbeatRuns).values({ companyId, agentId, issueId,
      invocationSource: "on_demand", triggerDetail: "manual", status: "cancelled", errorCode: "execution_reconciliation_required",
      createdAt: ago(60_000), startedAt: null, finishedAt: ago(59_000),
      contextSnapshot: { issueId, wakeReason: "task_retry", taskRetryRequestId: randomUUID() } })],
    ["a continuation of a person's Retry", (_issueId, sourceRunId) => db.update(heartbeatRuns)
      .set({ contextSnapshot: sql`${heartbeatRuns.contextSnapshot} || '{"wakeReason":"task_retry"}'::jsonb` }).where(eq(heartbeatRuns.id, sourceRunId))],
  ];

  for (const [shape, apply] of deliveryShapes) {
    it(`delivers at once while paused: ${shape}`, async () => {
      await seedCompany();
      const action = await pendingContinuation();
      await openBrake();
      const sourceRunId = (action.evidence.executionReconciliation as { runId: string }).runId;
      await apply(action.sourceIssueId, sourceRunId);
      const wake = runWake();
      await deliverReconciledExecutions(db, wake as never);
      expect(wake).toHaveBeenCalledTimes(1);
      expect((await db.select().from(automaticRunBrakes))[0]).toMatchObject({ state: "open", nextCreationAt: null });
    }, 120_000);
  }

  it("a held automatic continuation does not hide a person's continuation for the same agent", async () => {
    await seedCompany();
    const personAction = await pendingContinuation();
    await userWake(personAction.sourceIssueId, {});
    const automaticAction = await pendingContinuation();
    await openBrake();
    const wake = runWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake.mock.calls[0]![1]).toMatchObject({ payload: { issueId: personAction.sourceIssueId } });
    const delivery = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!
      .evidence.continuationDelivery;
    expect(await delivery(personAction.id)).toBe("delivered");
    expect(await delivery(automaticAction.id)).toBe("pending");
  }, 120_000);

  it("held continuations take turns across passes so they cannot fill every page", async () => {
    await seedCompany();
    const recent = await pendingContinuation(agentId, 2 * HOUR);
    const older = await pendingContinuation(agentId, 3 * HOUR);
    await openBrake();
    const wake = runWake();
    const attempted = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!
      .evidence.continuationDeliveryAttemptedAt;
    await deliverReconciledExecutions(db, wake as never);
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
    expect(await attempted(recent.id)).toBeTruthy();
    expect(await attempted(older.id)).toBeTruthy();
  }, 120_000);

  it("still pauses the delivery of a continuation no person asked for", async () => {
    await seedCompany();
    const action = await pendingContinuation();
    await openBrake();
    await userWake(action.sourceIssueId, { status: "completed", requestedAt: ago(HOUR), finishedAt: ago(HOUR) });
    const wake = runWake();
    await deliverReconciledExecutions(db, wake as never);
    expect(wake).not.toHaveBeenCalled();
  }, 120_000);

  const sweepShapes: Array<[string, (issueId: string) => Promise<unknown>]> = [
    ["the task's last run was a person's Retry", async issueId => {
      const [run] = await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`);
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, taskId: issueId, wakeReason: "task_retry" } }).where(eq(heartbeatRuns.id, run!.id));
    }],
    ["a person assigned the task after its last run", issueId => userWake(issueId, { reason: "issue_assigned", status: "failed", finishedAt: new Date() })],
    ["a person commented after its last run", issueId => userWake(issueId, { reason: "issue_commented", status: "skipped", finishedAt: new Date() })],
  ];

  for (const [shape, apply] of sweepShapes) {
    it(`the sweep continues at once while paused: ${shape}`, async () => {
      await seedCompany();
      const issueId = await strandedTask();
      await openBrake();
      await apply(issueId);
      const enqueueWakeup = wakeQueue();
      const recovery = recoveryService(db, { enqueueWakeup, scheduleRecoveryRetry: async () => null });
      expect(await recovery.assignedWork.checkIssue({ companyId, issueId })).toMatchObject({ outcome: "repaired" });
      expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    }, 120_000);
  }

  it("the held backlog continues a task a person asked for while paused, and its delivery is not paused", async () => {
    await seedCompany();
    const held = await heldBacklog();
    await openBrake();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, held.runId));
    await userWake(source!.issueId!, {});
    expect(await continueHeldExecutions(db, new Date())).toMatchObject({ continued: 1 });
    const wake = runWake();
    await deliverReconciledExecutions(db, wake as never);
    const records = await continuationRecords(held.runId);
    expect(records.map(record => [record.evidence.freshContinuation ? 'record' : 'hold', record.evidence.continuationDelivery ?? null]))
      .not.toContainEqual(['record', 'pending']);
    expect((await db.select().from(automaticRunBrakes))[0]!.nextCreationAt).toBeNull();
  }, 120_000);
});
