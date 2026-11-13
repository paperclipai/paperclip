import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, approvals, authUsers, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issueApprovals, issueRecoveryActions, issueThreadInteractions,
  heartbeatRunEvents, issueComments, issues, nativeRunFinalizations, toolInvocations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { PENDING_CONTINUATION_BOUND_MS } from "./recovery-continuation-pacing.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import {
  FRESH_CONTINUATIONS_PER_HOUR, FRESH_CONTINUATION_SCHEMA, PERSON_OWNED_FAILURE_CODES, continueHeldExecutions, ensureFreshContinuation,
  resetBacklogContinuationPacingForTests,
  freshContinuationNote, heldExecutionsAwaitingFreshContinuation, nextFreshContinuationCheckAt, recordFreshContinuationCheck, FRESH_CONTINUATION_PENDING_BOUND_MS, FRESH_CONTINUATION_PROGRESS_BOUND_MS, FRESH_CONTINUATION_SAVED_WORK_BOUND_MS,
} from "./fresh-continuation-fallback.js";
import { heartbeatService } from "./heartbeat.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { currentProcessSpaceHash } from "./controller-process-identity.js";
import { executionControlSchedule } from "./execution-control-work.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { taskInterruptionPresentation } from "./task-interruption-presentation.js";
import { agentRunWritesRevoked, assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { loadAgentRunAuthentication } from "../middleware/agent-run-authentication.js";
import { SERVER_RESTART_RETRY_MAX_ATTEMPTS, SERVER_RESTART_RETRY_WINDOW_MS } from "./execution-recovery-attempt.js";
import { FRESH_CONTINUATION_WINDOW_MS } from "./fresh-continuation-fallback.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

// Copy shown to people never asks them to inspect or repair a sandbox, workspace or run.
const adminText = /sandbox|inspect|repair|administrator|reconcile/i;

type Seed = {
  runtime: "native" | "legacy"; status?: "failed" | "interrupted" | "timed_out" | "cancelled";
  errorCode: string; error?: string;
  /** How today's code leaves the run: an active hold (before disposition) or a settled-but-blocked hold (older releases). */
  hold?: "active" | "settled_blocked" | "none";
  coordinatorState?: string;
};

suite("fresh-continuation fallback", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", agentId = "", userId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-fresh-continuation-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "FCF",
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }, 60_000);

  afterEach(async () => {
    resetBacklogContinuationPacingForTests(db);
    await db.execute(sql`truncate table issue_recovery_actions, native_run_finalizations, tool_invocations,
      issue_approvals, approvals, issue_thread_interactions, activity_log, agent_wakeup_requests, environment_leases, execution_workspaces, heartbeat_runs, issues cascade`);
  });

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  /** A run that ended without finishing, in the shape today's release leaves it. */
  async function unfinishedRun(seed: Seed) {
    const issueId = randomUUID(), runId = randomUUID();
    const finishedAt = new Date(Date.now() - 60_000);
    await db.insert(issues).values({ id: issueId, companyId, title: "Ship the release notes", status: "blocked",
      assigneeAgentId: agentId, statusVersion: 4, blockedTransitionAt: finishedAt });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", issueId,
      nativeIssueId: seed.runtime === "native" ? issueId : null, runtimeMode: seed.runtime,
      status: seed.status ?? "failed", errorCode: seed.errorCode, error: seed.error ?? seed.errorCode,
      startedAt: new Date(finishedAt.getTime() - 10 * 60_000), finishedAt, createdAt: new Date(finishedAt.getTime() - 11 * 60_000),
      responsibleUserId: userId, contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      ...(seed.runtime === "native" ? { nativePhase: "terminal_failure" }
        : { runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } } }) });
    if (seed.runtime === "native") {
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
        recoveryState: seed.coordinatorState ?? "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
    }
    let actionId: string | null = null;
    if ((seed.hold ?? "active") !== "none") {
      const native = seed.runtime === "native";
      const settled = seed.hold === "settled_blocked";
      const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        status: settled ? "resolved" : "active", outcome: settled ? "blocked" : null, resolvedAt: settled ? finishedAt : null,
        ownerType: "board", returnOwnerAgentId: agentId,
        cause: native ? "native_continuation_requires_reconciliation" : "legacy_execution_requires_reconciliation",
        fingerprint: native ? `native-continuation:${runId}` : `legacy-execution:${runId}`,
        nextAction: "Inspect the original failure and reconcile the previous execution before continuing. Automatic recovery cannot start another incident.",
        maxAttempts: 3, createdAt: finishedAt,
        evidence: { runId, originalFailureCode: seed.errorCode, nativeFailureBlock: { runId, statusVersion: 4 },
          ...(settled ? { automaticRecovery: { policy: "preserve_without_replay_v1", runId, replay: "blocked",
            actionOutcome: "unknown", recordedAt: finishedAt.toISOString() } } : {}) } }).returning();
      actionId = action!.id;
    }
    return { issueId, runId, actionId };
  }

  const issue = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const successors = async (runId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  /** Keeps the agent's only slot busy, so a delivered continuation stays observable as queued. */
  async function occupySlot() {
    const [other] = await db.insert(issues).values({ companyId, title: "Other work", status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "running", contextSnapshot: { issueId: other!.id } });
  }
  async function deliver() {
    const heartbeat = heartbeatService(db);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
  }

  async function expectOneFreshSuccessor(f: { issueId: string; runId: string }) {
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toBeNull();
    expect(await issue(f.issueId)).toMatchObject({ status: "todo" });
    await occupySlot();
    await deliver();
    const next = await successors(f.runId);
    expect(next).toHaveLength(1);
    expect(next[0]!.contextSnapshot).toMatchObject({ issueId: f.issueId, previousRunId: f.runId, forceFreshSession: true,
      wakeReason: "issue_recovery_action_restored" });
    const [record] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.issueId),
      sql`${issueRecoveryActions.evidence}->'freshContinuation' is not null`));
    expect(record!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: next[0]!.id,
      freshContinuation: { schema: FRESH_CONTINUATION_SCHEMA, sourceRunId: f.runId },
      executionReconciliation: { runId: f.runId, providerStopped: true, actionOutcome: "mixed" } });
    expect(record!.nextAction).not.toMatch(adminText);
    expect(record!.ownerType).toBe("system");
    return next[0]!;
  }

  // The five most frequent endings on staging (2026-11-12): each left the task
  // Blocked for a person with no successor run.
  it.each([
    { errorCode: "native_continuation_requires_reconciliation", error: "runner_remote_process_identity_unavailable", runtime: "native" as const },
    { errorCode: "controller_lease_lost", error: "Legacy controller lease lost", runtime: "legacy" as const },
    { errorCode: "process_lost", error: "Process lost -- server may have restarted; retrying once", runtime: "legacy" as const },
    { errorCode: "server_shutdown_interrupted", error: "Interrupted by graceful server shutdown (SIGTERM)", runtime: "legacy" as const,
      status: "interrupted" as const },
    { errorCode: "native_session_interrupted", error: "runner_ingress_auth_failed: Runner ingress did not complete PRP authentication",
      runtime: "native" as const },
  ])("continues a task whose run ended with $errorCode in exactly one fresh run from saved work", async seed => {
    const f = await unfinishedRun(seed);
    await settleUnrecoverableExecutions(db);
    const hold = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!)))[0]!;
    expect(hold).toMatchObject({ status: "resolved", outcome: "restored" });
    expect(hold.evidence.automaticRecovery).toBeUndefined();
    await expectOneFreshSuccessor(f);
  }, 60_000);

  // The only native swap failure left on a later staging swap: the Runner
  // resumed a harness that was not suspended or was gone.
  // Exact resume is fixed elsewhere; whatever still fails must fall back.
  it.each([
    { errorCode: "native_session_interrupted",
      error: "runner_ingress_unavailable: runnerd process failed: runner_harness_state_mismatch: resumed_not_suspended" },
    { errorCode: "native_session_interrupted",
      error: "runner_ingress_unavailable: runnerd process failed: runner_harness_state_mismatch: resumed_unavailable" },
    { errorCode: "runner_harness_state_mismatch", error: "runner_harness_state_mismatch: resumed_unavailable" },
  ])("continues a task whose resumed Runner harness was in the wrong state ($error)", async seed => {
    const f = await unfinishedRun({ runtime: "native", ...seed });
    await settleUnrecoverableExecutions(db);
    await expectOneFreshSuccessor(f);
  }, 60_000);

  // Staging: the person had already pressed Retry, and the automatic successor
  // could not carry that authorization forward. That is the system's failure,
  // not the person's: the task continues under its responsible user.
  it("starts the continuation when the failed run's exhaustion hold lands after the continuation was recorded", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_runner_process_exited",
      error: "native_session_recovery_failed: Error: runner_local_connect_failed: runnerd exited unexpectedly" });
    await settleUnrecoverableExecutions(db);
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", status: "active",
      ownerType: "board", returnOwnerAgentId: agentId, cause: "native_session_retry_exhausted", fingerprint: `native-retry:${f.runId}`,
      nextAction: "Automatic recovery stopped.", maxAttempts: 3,
      evidence: { runId: f.runId, coordinatorAttempt: 3, recoveryDisposition: "native_session_retry_exhausted" } });
    await deliver();
    await continueHeldExecutions(db); await settleUnrecoverableExecutions(db); await deliver();
    expect(await successors(f.runId)).toHaveLength(1);
  }, 60_000);

  it("keeps a person's newer block when the failed run's exhaustion hold lands after the continuation was recorded", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_runner_process_exited",
      error: "native_session_recovery_failed: Error: runner_local_connect_failed: runnerd exited unexpectedly" });
    await settleUnrecoverableExecutions(db);
    const decisionId = randomUUID();
    await db.update(issues).set({ status: "blocked", statusVersion: 9, lastStatusDecisionId: decisionId, blockedTransitionAt: new Date() })
      .where(eq(issues.id, f.issueId));
    const [late] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", status: "active",
      ownerType: "board", returnOwnerAgentId: agentId, cause: "native_session_retry_exhausted", fingerprint: `native-retry:${f.runId}`,
      nextAction: "Automatic recovery stopped.", maxAttempts: 3,
      evidence: { runId: f.runId, coordinatorAttempt: 3, recoveryDisposition: "native_session_retry_exhausted", nativeFailureBlock: { runId: f.runId, statusVersion: 4 } } }).returning();
    await settleUnrecoverableExecutions(db);
    expect(await issue(f.issueId)).toMatchObject({ status: "blocked", lastStatusDecisionId: decisionId });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, late!.id)))[0]).toMatchObject({ status: "resolved", ownerType: "system" });
  }, 60_000);

  it("continues a task whose automatic retry lost the person's continuation authorization", async () => {
    expect(PERSON_OWNED_FAILURE_CODES).not.toContain("continuation_user_authorization_missing");
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "continuation_user_authorization_missing",
      error: "The automatic retry could not revalidate the original user continuation" });
    await settleUnrecoverableExecutions(db);
    const next = await expectOneFreshSuccessor(f);
    expect(next.responsibleUserId).toBe(userId);
  }, 60_000);

  it("falls back for a failure code nobody has classified yet", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "runner_new_failure_added_next_week" });
    await settleUnrecoverableExecutions(db);
    await expectOneFreshSuccessor(f);
  }, 60_000);

  it("creates one successor when two servers call it at once", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable" });
    const results = await Promise.all([
      ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }),
      ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }),
      settleUnrecoverableExecutions(db).then(() => null),
    ]);
    expect(results.filter(result => result?.kind === "continued")).toHaveLength(1);
    expect(results.filter(result => result && result.kind !== "continued").map(result => result!.kind))
      .toEqual([expect.stringMatching(/already_continued|successor_exists/)]);
    await expectOneFreshSuccessor(f);
    // A later call, from either server or a sweep, adds nothing.
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: expect.stringMatching(/already_continued|successor_exists/) });
    await deliver();
    expect(await successors(f.runId)).toHaveLength(1);
  }, 60_000);

  // Upgrade safety: rows saved by the previous release (a settled-but-blocked
  // no-replay hold, its coordinator still awaiting a runner reattach) and a
  // task already Blocked continue on the first pass after deploy, without Retry.
  it("continues tasks that older releases left blocked by these codes", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable", hold: "settled_blocked", coordinatorState: "awaiting_runner_reattach" });
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId });
    await settleUnrecoverableExecutions(db);
    await expectOneFreshSuccessor(f);
  }, 60_000);

  /** A held record from an older release (settled blocked), its source run ended `ageMs` ago with `errorCode`. */
  async function heldBacklog(errorCode: string, ageMs: number) {
    const f = await unfinishedRun({ runtime: "native", errorCode, hold: "settled_blocked" });
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - ageMs) }).where(eq(heartbeatRuns.id, f.runId));
    return f;
  }
  const continuedFrom = async (runId: string) => db.select().from(issueRecoveryActions)
    .where(sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,sourceRunId}' = ${runId}`);
  const evidenceOf = async (actionId: string) =>
    (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)))[0]!;

  it("continues only recent interruptions from the held backlog, newest first, and leaves the rest untouched (staging herd)", async () => {
    // paperclip.staging, 22:53Z: the first release with the fallback continued 176 held tasks in 30 minutes;
    // 74 had a source run that ended more than 7 days ago, many with configuration or provider failures.
    const HOUR = 60 * 60_000;
    const recentOld = await heldBacklog("native_restart_recovery_blocked", 6 * HOUR);
    const recentNew = await heldBacklog("native_continuation_requires_reconciliation", 1 * HOUR);
    const weekOld = await heldBacklog("native_restart_recovery_blocked", 3 * 24 * HOUR);
    const monthOld = await heldBacklog("native_session_interrupted", 28 * 24 * HOUR);
    const providerFailure = await heldBacklog("runner_remote_provider_artifact_incompatible", 2 * HOUR);
    const adapterFailure = await heldBacklog("adapter_failed", 2 * HOUR);
    const untouched = [weekOld, monthOld, providerFailure, adapterFailure];
    const before = await Promise.all(untouched.map(f => evidenceOf(f.actionId!)));

    expect(await continueHeldExecutions(db, new Date(), 1)).toMatchObject({ continued: 1 });
    expect(await continuedFrom(recentNew.runId)).toHaveLength(1);
    expect(await continuedFrom(recentOld.runId)).toHaveLength(0);
    for (let pass = 0; pass < 3; pass += 1) await continueHeldExecutions(db, new Date());
    expect(await continuedFrom(recentOld.runId)).toHaveLength(1);
    for (const [index, f] of untouched.entries()) {
      expect(await continuedFrom(f.runId)).toHaveLength(0);
      const after = await evidenceOf(f.actionId!);
      expect({ status: after.status, evidence: after.evidence, updatedAt: after.updatedAt })
        .toEqual({ status: before[index]!.status, evidence: before[index]!.evidence, updatedAt: before[index]!.updatedAt });
    }
  }, 120_000);

  it("paces the held backlog to ten continuations a minute per server", async () => {
    const records = [];
    for (let index = 0; index < 12; index += 1) records.push(await heldBacklog("native_restart_recovery_blocked", (index + 1) * 60_000));
    const now = new Date();
    for (let pass = 0; pass < 4; pass += 1) await continueHeldExecutions(db, now);
    const started = (await Promise.all(records.map(f => continuedFrom(f.runId)))).filter(rows => rows.length > 0).length;
    expect(started).toBe(10);
    // The next minute has room again.
    await continueHeldExecutions(db, new Date(now.getTime() + 61_000));
    expect((await Promise.all(records.map(f => continuedFrom(f.runId)))).filter(rows => rows.length > 0).length).toBe(12);
  }, 180_000);

  const sweepWake = (issueId: string) => heartbeatService(db).wakeup(agentId, { source: "automation", triggerDetail: "system",
    reason: "issue_continuation_needed", payload: { issueId }, requestedByActorType: "system",
    requestedByActorId: "idle-task-sweep", contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_continuation_needed" } });
  const pendingRecord = async (issueId: string) => (await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.sourceIssueId, issueId), sql`${issueRecoveryActions.evidence}->'freshContinuation' is not null`)))[0];

  // An ordinary system wake (the idle-task sweep's) reaches the fallback. The
  // continuation is recorded pending and counts as delivered only once a run
  // for it exists.
  it("records a pending continuation for an ordinary continuation wake and delivers it once", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable", hold: "settled_blocked" });
    await occupySlot();
    expect(await sweepWake(f.issueId)).toBeNull();
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toBeNull();
    expect((await pendingRecord(f.issueId))!.evidence).toMatchObject({ continuationDelivery: "pending",
      freshContinuation: { sourceRunId: f.runId, trigger: "continuation_wake", delivery: "recorded" } });
    // A second sweep wake adds nothing.
    expect(await sweepWake(f.issueId)).toBeNull();
    await deliver();
    expect(await successors(f.runId)).toHaveLength(1);
    expect((await pendingRecord(f.issueId))!.evidence.continuationDelivery).toBe("delivered");
  }, 60_000);

  it("re-drives an isolated continuation pending past the bound itself; a repair wake never replaces it", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost", error: "Legacy controller lease lost" });
    await db.update(heartbeatRuns).set({ processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace", delivery: "recorded" });
    await occupySlot();
    const taskRuns = async () => db.select().from(heartbeatRuns).where(and(
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, sql`${heartbeatRuns.id} <> ${f.runId}`));
    expect(await sweepWake(f.issueId)).toBeNull();
    expect(await taskRuns()).toHaveLength(0);
    const recordedAt = new Date(Date.now() - PENDING_CONTINUATION_BOUND_MS - 60_000).toISOString();
    await db.update(issueRecoveryActions).set({ resolvedAt: new Date(recordedAt), evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{freshContinuation,recordedAt}', to_jsonb(${recordedAt}::text))` }).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await sweepWake(f.issueId)).toBeNull();
    expect(await taskRuns()).toHaveLength(0);
    await deliver();
    const runs = await taskRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contextSnapshot).toMatchObject({ freshContinuationIsolation: f.actionId, forceFreshSession: true });
    expect(await readFreshWorkspaceReadiness(db, runs[0]!)).toMatchObject({ mode: "fresh_isolated_workspace", retryIntentId: f.actionId });
    const [record] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(record!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: runs[0]!.id });
    await sweepWake(f.issueId);
    await deliver();
    expect(await taskRuns()).toHaveLength(1);
  }, 60_000);

  // A gate after the hook must never consume the recovery: it stays pending
  // and is delivered once the gate clears.
  it("keeps the continuation pending while the agent's daily run limit declines it, then delivers it", async () => {
    // The daily limit counts runs started in the current UTC day, and it reads
    // the clock on every check. Freeze Date (timers stay real) so every check in
    // this test sees the same day, even when UTC midnight passes mid-test.
    const now = new Date();
    vi.useFakeTimers({ toFake: ["Date"], now });
    try {
      const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted", hold: "settled_blocked" });
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, maxDailyRuns: 1 } } }).where(eq(agents.id, agentId));
      // Pin the runs to that day so the result does not depend on the hour:
      // the source run started yesterday (as it does just after 00:00 UTC), and
      // another run started today used the single run.
      const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      await db.update(heartbeatRuns).set({ startedAt: new Date(todayStart - 60_000), createdAt: new Date(todayStart - 120_000) })
        .where(eq(heartbeatRuns.id, f.runId));
      const [other] = await db.insert(issues).values({ companyId, title: "Used today's run", status: "done", assigneeAgentId: agentId }).returning();
      await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "succeeded",
        startedAt: now, finishedAt: now, contextSnapshot: { issueId: other!.id } });
      expect(await sweepWake(f.issueId)).toBeNull();
      await deliver();
      expect(await successors(f.runId)).toHaveLength(0);
      expect((await pendingRecord(f.issueId))!.evidence.continuationDelivery).toBe("pending");
      // The limit clears: the next pass delivers it.
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
      await occupySlot();
      await deliver();
      expect(await successors(f.runId)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, agentId));
    }
  }, 60_000);

  it("leaves a paused agent's task waiting with that reason, not idle and not consumed", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted", hold: "settled_blocked" });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    try {
      expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "continuation_wake" }))
        .toEqual({ kind: "person_owned", reason: "agent_not_available" });
      expect(await pendingRecord(f.issueId)).toBeUndefined();
      expect(await getExecutionBlocker(db, companyId, f.issueId)).toMatchObject({ recoveryActionId: f.actionId });
    } finally {
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    }
  }, 60_000);

  // The chaos repro: the agent's only slot is held. The delivered continuation
  // waits queued (never lost) and starts as soon as the slot frees.
  it("leaves the delivered continuation queued while the agent's slot is full and starts it when the slot frees", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const [other] = await db.insert(issues).values({ companyId, title: "Holds the slot", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [holder] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "running",
      contextSnapshot: { issueId: other!.id } }).returning();
    await deliver();
    const [next] = await successors(f.runId);
    expect(next).toMatchObject({ status: "queued" });
    expect((await pendingRecord(f.issueId))!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: next!.id });
    // The slot frees: the queued continuation is dispatched.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holder!.id));
    await heartbeatService(db).resumeQueuedRuns();
    await vi.waitFor(async () => {
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next!.id));
      expect(current!.status).not.toBe("queued");
    }, { timeout: 20_000, interval: 100 });
  }, 60_000);

  // The Retry banner never shows while Paperclip is continuing the task itself.
  it("presents a task whose continuation is recorded or scheduled as continuing, with no Retry", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_restart_recovery_blocked" });
    const presentation = async () => {
      const task = await issue(f.issueId);
      return taskInterruptionPresentation(db, { id: task.id, companyId, status: task.status,
        assigneeAgentId: task.assigneeAgentId, projectId: task.projectId });
    };
    // A scheduled check (exact recovery still has its chance): a timed wait, no Retry.
    await recordFreshContinuationCheck(db, { companyId, actionId: f.actionId! },
      { kind: "exact_recovery_pending", reason: "native_finalizer_active", retryAt: new Date(Date.now() + 60_000) });
    expect(await presentation()).toMatchObject({ state: "retry_scheduled", canRetry: false });
    // Recorded, not yet started: continuing, no Retry.
    await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} - 'freshContinuationCheck'` })
      .where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    expect(await presentation()).toMatchObject({ state: "working", canRetry: false });
  }, 60_000);

  it("never starts a second run when a person's Retry already continued the task", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    // A person's Retry started a run before the continuation was delivered.
    const [retry] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
      status: "queued", contextSnapshot: { issueId: f.issueId, wakeReason: "task_retry" } }).returning();
    await deliver();
    expect(await successors(f.runId)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issueId))).toHaveLength(2);
    expect((await pendingRecord(f.issueId))!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: retry!.id });
  }, 60_000);

  /** The continuation's own wake, exactly as the delivery worker sends it, without its pre-check. */
  async function deliveryWake(f: { issueId: string; runId: string }) {
    const record = (await pendingRecord(f.issueId))!;
    return heartbeatService(db).wakeup(agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_recovery_action_restored", idempotencyKey: `execution-reconciliation:${record.id}`,
      payload: { issueId: f.issueId, recoveryActionId: record.id }, requestedByActorType: "system", requestedByActorId: "execution-recovery",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, recoveryActionId: record.id, previousRunId: f.runId,
        retryOfRunId: f.runId, forceFreshSession: true, wakeReason: "issue_recovery_action_restored", source: "execution.reconciled" } });
  }

  it("lets a run that started and finished in the delivery window consume the continuation under the task lock", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    // Between the worker's pre-check and admission, saved input ran and finished.
    const [intervening] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
      status: "succeeded", finishedAt: new Date(), contextSnapshot: { issueId: f.issueId, wakeReason: "issue_commented" } }).returning();
    await occupySlot();
    expect(await deliveryWake(f)).toBeNull();
    expect(await successors(f.runId)).toHaveLength(0);
    expect((await pendingRecord(f.issueId))!.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: intervening!.id });
  }, 60_000);

  it("starts no run for a task that moved to review in the delivery window", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, f.issueId));
    await occupySlot();
    expect(await deliveryWake(f)).toBeNull();
    expect(await successors(f.runId)).toHaveLength(0);
    expect((await pendingRecord(f.issueId))!.evidence.continuationDelivery).toBe("invalidated");
  }, 60_000);

  it("settles coalesced holds with their primary, so a task back in todo is not shown as working and the sweep sees it", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    // A second no-replay hold of the same run, settled together with the first.
    const [sibling] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      status: "resolved", outcome: "blocked", ownerType: "board", cause: "native_restart_recovery_blocked",
      fingerprint: `native-restart:${f.runId}`, nextAction: "held", resolvedAt: new Date(),
      evidence: { runId: f.runId, automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked" } } }).returning();
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, sibling!.id)))[0]!.evidence.continuationDelivery)
      .toBe("coalesced");
    // The task moves to review before delivery: the primary is cancelled, and so is its sibling.
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, f.issueId));
    await occupySlot();
    expect(await deliveryWake(f)).toBeNull();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, sibling!.id)))[0]!.evidence.continuationDelivery)
      .toBe("invalidated");
    // Back to todo with nothing pending: a failed attempt with Retry, not "working".
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    const task = await issue(f.issueId);
    expect(await taskInterruptionPresentation(db, { id: task.id, companyId, status: task.status,
      assigneeAgentId: task.assigneeAgentId, projectId: task.projectId })).toMatchObject({ state: "failed", canRetry: true });
    // The assigned-work sweep sees it as left with nothing pending: inside its
    // settle window after the recent change it schedules the recheck, never "ok".
    const check = await heartbeatService(db).checkAssignedWorkInvariant({ companyId, issueId: f.issueId });
    expect(["violation", "settling"]).toContain(check?.verdict.kind);
  }, 60_000);

  // The agent is told to check, redo what is missing, and ask only through the
  // normal approval step; never that someone must restore the previous attempt.
  it("guides the agent to check and redo, never to wait for an operator to recover the previous attempt", async () => {
    for (const unverified of [[], ["github.merge_pull_request"]]) {
      const note = freshContinuationNote({ runId: randomUUID(), unverified, workspace: "restored_last_save" });
      if (unverified.length) expect(note).toContain("first check whether it took effect");
      expect(note).toContain("do it again and continue the task");
      // It does not contradict "do not repeat completed actions": it scopes itself to unknown outcomes.
      expect(note).toContain("Completed actions with recorded results are still not repeated");
      expect(note).toContain("request it through the normal approval step");
      expect(note).not.toMatch(/operator|recover its result|execution state|authorize rerunning/i);
    }
    // The same holds for the continuation context the agent actually receives.
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const continuation = await buildExecutionContinuation({ db, companyId, issueId: f.issueId, agentId,
      context: { previousRunId: f.runId }, summary: null, exposeLowTrustRaw: false });
    const text = JSON.stringify(continuation);
    expect(text).toContain("was cut off before it finished");
    expect(text).not.toMatch(/operator must|recover its result|recover .*execution state|authorize rerunning/i);
  }, 60_000);

  // A task whose run completes normally gets no fallback activity at all, even
  // with an older hold on the task (a run queued across a swap that then ran).
  it("leaves a task that completes normally alone, even with an older run's hold", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation", hold: "settled_blocked" });
    const [later] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: f.issueId, nativeIssueId: f.issueId,
      status: "succeeded", startedAt: new Date(), finishedAt: new Date(), contextSnapshot: { issueId: f.issueId } }).returning();
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" })).toEqual({ kind: "successor_exists" });
    expect(await ensureFreshContinuation(db, { companyId, runId: later!.id, trigger: "held_recovery" }))
      .toEqual({ kind: "not_applicable", reason: "run_not_unfinished" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    await settleUnrecoverableExecutions(db);
    await occupySlot();
    expect(await sweepWake(f.issueId)).toBeNull();
    await deliver();
    expect(await pendingRecord(f.issueId)).toBeUndefined();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issueId))).toHaveLength(2);
  }, 60_000);

  it("starts no run for a task that finished while its continuation was pending", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    await deliver();
    expect(await successors(f.runId)).toHaveLength(0);
    expect((await pendingRecord(f.issueId))!.evidence.continuationDelivery).toBe("invalidated");
  }, 60_000);

  // Crash between writes: the decision committed, the process died before any
  // run was created. Nothing is lost: the next delivery pass starts it.
  it("delivers a committed continuation after a crash before its run was created", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    expect(await successors(f.runId)).toHaveLength(0);
    // A new process: a fresh service instance and worker pass.
    await occupySlot();
    await deliver();
    expect(await successors(f.runId)).toHaveLength(1);
  }, 60_000);

  // The cut-off run's agent may still be alive in its old, unreachable sandbox.
  // Once the continuation is recorded it can neither write to the task through
  // the API nor publish its workspace, and the next run restores the last save
  // into a new root on a new allocation.
  it("fences the cut-off run: its API writes are refused and its workspace epoch is abandoned", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable" });
    const workspaceId = randomUUID(), snapshotId = null, leaseId = randomUUID(), environmentId = randomUUID();
    const location = { environmentId, leaseId, providerLeaseId: "sandbox-1", remoteCwd: "/home/daytona/.paperclip-workspaces/a" };
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: f.issueId, mode: "isolated",
      strategyType: "remote", name: "Task workspace", providerType: "remote", providerRef: location.remoteCwd,
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 3, snapshotId,
        source: { kind: "empty" }, location, writerRunId: f.runId, dirty: true } } });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1",
      workspaceId, leaseId, providerLeaseId: location.providerLeaseId, remoteCwd: location.remoteCwd, epoch: 3,
      state: "prepared", snapshotId } } }).where(eq(heartbeatRuns.id, f.runId));
    // Today a failed run's token still writes.
    const [before] = await loadAgentRunAuthentication(db, { runId: f.runId, companyId, agentId });
    expect(agentRunWritesRevoked(before)).toBe(false);

    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });

    // The auth middleware's own row read refuses every write of the old token.
    const [after] = await loadAgentRunAuthentication(db, { runId: f.runId, companyId, agentId });
    expect(agentRunWritesRevoked(after)).toBe(true);
    await expect(db.transaction(tx => assertAgentRunWriteAllowed(tx as unknown as typeof db, companyId, { agentId, runId: f.runId })))
      .rejects.toMatchObject({ status: 403, details: { code: "agent_run_superseded" } });
    // The workspace writer is fenced out and the next preparation starts from the last save in a new root.
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    expect(workspace!.metadata!.remoteWorkspace).toMatchObject({ epoch: 4, writerRunId: null, dirty: false, location: null });
    expect(workspace!.providerRef).toBeNull();
    expect(workspace!.metadata!.remoteWorkspaceAbandonedEpochs).toEqual([expect.objectContaining({ epoch: 3, runId: f.runId, location })]);
    // The continuation's own token is unaffected.
    await occupySlot();
    await deliver();
    const [next] = await successors(f.runId);
    await expect(db.transaction(tx => assertAgentRunWriteAllowed(tx as unknown as typeof db, companyId, { agentId, runId: next!.id })))
      .resolves.toBeTruthy();
  }, 60_000);

  // The staging shape: the new server cannot re-reach the old Runner, so the old
  // run's sandbox lease is still active (or its cleanup is pending) with no stop
  // receipt. The continuation must still start, not wait behind that cleanup.
  it.each(["active", "pending_cleanup"] as const)("starts the continuation while the unreachable old lease is %s", async leaseStatus => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable" });
    const [environment] = await db.insert(environments).values({ name: `sandbox-${f.runId}`, driver: "sandbox" }).returning();
    await db.insert(environmentLeases).values({ companyId, issueId: f.issueId, heartbeatRunId: f.runId,
      environmentId: environment!.id, provider: "daytona", providerLeaseId: `sandbox-${f.runId}`, status: leaseStatus,
      leasePolicy: "retain_on_failure", metadata: { remoteCwd: "/home/daytona/work", driver: "sandbox" } });
    await settleUnrecoverableExecutions(db);
    await deliver();
    const [next] = await successors(f.runId);
    expect(next).toBeTruthy();
    // Admission claims it: it leaves the queue instead of being declined for the old run's cleanup.
    await vi.waitFor(async () => {
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next!.id));
      expect(current!.status).not.toBe("queued");
    }, { timeout: 20_000, interval: 100 });
    // The abandoned allocation stays fenced: the old run still cannot write.
    const [old] = await loadAgentRunAuthentication(db, { runId: f.runId, companyId, agentId });
    expect(agentRunWritesRevoked(old)).toBe(true);
  }, 60_000);

  // A legacy run whose local process may still be alive: the continuation must
  // never write the same directory. It gets a new isolated workspace and the
  // decision records the stop as unproven.
  it("gives the continuation a new isolated workspace while the old local writer may be alive", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost", error: "Legacy controller lease lost" });
    // Its controller ran on another host (the replaced server), so no probe from here can prove it gone.
    await db.update(heartbeatRuns).set({ processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace" });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(hold!.evidence).toMatchObject({ freshContinuation: { isolation: "fresh_isolated_workspace", stopProof: "unproven_isolated" },
      executionReconciliation: { providerStopProof: "isolated" } });
    await occupySlot();
    await deliver();
    const [next] = await successors(f.runId);
    expect(next!.contextSnapshot).toMatchObject({ freshContinuationIsolation: f.actionId });
    // Workspace selection gives it a new isolated workspace, never the old directory.
    expect(await readFreshWorkspaceReadiness(db, next!)).toEqual({ mode: "fresh_isolated_workspace", retryIntentId: f.actionId,
      sourceRunId: f.runId, retainedSourceIds: [] });
  }, 60_000);

  // The recorded process identity (host, PID space, start time) of this process.
  const liveIdentity = () => ({ processPid: process.pid, processHostHash: currentProcessSpaceHash(),
    processStartedAt: new Date(Date.now() - process.uptime() * 1_000) });

  /** Moves the recorded start of the pending wait into the past. */
  async function waitedFor(actionId: string, ms: number) {
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{freshContinuationCheck,firstPendingAt}', to_jsonb(${Date.now() - ms}::bigint))` }).where(eq(issueRecoveryActions.id, actionId));
  }

  it("lets a previous process still running on this host settle first, for about ten minutes at most", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "process_lost" });
    await db.update(heartbeatRuns).set(liveIdentity()).where(eq(heartbeatRuns.id, f.runId));
    const first = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" });
    expect(first).toMatchObject({ kind: "exact_recovery_pending", reason: "previous_process_running" });
    // Rechecks back off from one minute.
    expect((first as { retryAt: Date }).retryAt.getTime()).toBeLessThanOrEqual(Date.now() + 61_000);
    await recordFreshContinuationCheck(db, { companyId, actionId: f.actionId! }, first);
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(hold!.evidence.freshContinuationCheck).toMatchObject({ checks: 1, firstPendingAt: expect.any(Number) });
    // Past the bound it stops waiting and continues in a new isolated workspace.
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PENDING_BOUND_MS + 1_000);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace" });
  }, 60_000);

  it("keeps waiting up to fifteen minutes while the exact-recovery owner shows progress", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost" });
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 365 * 86_400_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    const waiting = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" });
    await recordFreshContinuationCheck(db, { companyId, actionId: f.actionId! }, waiting);
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PENDING_BOUND_MS + 1_000);
    // The owner renewed its lease since the last check: progress.
    await db.update(heartbeatRuns).set({ lastOutputAt: new Date(Date.now() + 1_000) }).where(eq(heartbeatRuns.id, f.runId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "exact_recovery_pending", reason: "controller_lease_live" });
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PROGRESS_BOUND_MS + 1_000);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace" });
  }, 60_000);

  it("does not mistake a recycled PID for the old writer", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "process_lost" });
    // The PID is alive now, but it belongs to a process that started after the old one was recorded.
    await db.update(heartbeatRuns).set({ ...liveIdentity(), processStartedAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued" });
  }, 60_000);

  /** A saved-work (workspace) recovery generation on the run's hold, as workspace recovery records it. */
  async function savedWorkRecovery(f: { runId: string; actionId: string | null }, state: "awaiting_evidence" | "running") {
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold!.evidence,
      systemRecovery: { schema: "paperclip.system-recovery.v1", policyVersion: 1, phase: "reconcile_effects", state,
        sourceRunId: f.runId, attempts: 1, retriesUsed: 0, revision: 2, failure: null, intentId: null, deadlineAt: null,
        nextAttemptAt: null, firstFailureAt: null, freshAttemptRunId: null, providerCooldownAt: null,
        attemptId: randomUUID(), generationId: randomUUID(), preservationOperationIds: [] } } })
      .where(eq(issueRecoveryActions.id, f.actionId!));
  }

  it("bounds a saved-work recovery that is waiting with no progress, on a scheduled deadline", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "server_shutdown_interrupted", status: "interrupted" });
    await savedWorkRecovery(f, "awaiting_evidence");
    // The held-run scan selects it: exact recovery keeps its first chance.
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 0 });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(hold!.evidence.freshContinuationCheck).toMatchObject({ kind: "exact_recovery_pending", reason: "saved_work_recovery_running" });
    // With no other event, the worker is scheduled for the next check.
    expect(await nextFreshContinuationCheckAt(db)).toBe((hold!.evidence.freshContinuationCheck as { nextCheckAt: number }).nextCheckAt);
    // No progress by the bound: the task continues fresh in a new root, and the
    // preempted recovery is no longer scheduled (its hold carries the decision),
    // so a late result cannot reach the new workspace.
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PENDING_BOUND_MS + 1_000);
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{freshContinuationCheck,nextCheckAt}', to_jsonb(${Date.now() - 1_000}::bigint))` }).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 1 });
    const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(settled!.evidence).toMatchObject({ executionReconciliation: { runId: f.runId },
      freshContinuation: { isolation: "fresh_isolated_workspace" } });
  }, 60_000);

  it("lets a running saved-work recovery that keeps advancing use its own budget", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "server_shutdown_interrupted", status: "interrupted" });
    await savedWorkRecovery(f, "running");
    const first = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" });
    await recordFreshContinuationCheck(db, { companyId, actionId: f.actionId! }, first);
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PROGRESS_BOUND_MS + 1_000);
    // The recovery advanced (a new attempt) since the last check: it keeps going past 15 minutes.
    await db.update(issueRecoveryActions).set({ updatedAt: new Date(Date.now() + 1_000),
      evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{systemRecovery,attempts}', '2'::jsonb)` })
      .where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "exact_recovery_pending", reason: "saved_work_recovery_running" });
    // Its 30-minute budget is the cap.
    await waitedFor(f.actionId!, FRESH_CONTINUATION_SAVED_WORK_BOUND_MS + 1_000);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace" });
  }, 60_000);

  it("bounds every exact-recovery wait, here a controller lease that never lapses", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost" });
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 365 * 86_400_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    const waiting = await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" });
    expect(waiting).toMatchObject({ kind: "exact_recovery_pending", reason: "controller_lease_live" });
    await recordFreshContinuationCheck(db, { companyId, actionId: f.actionId! }, waiting);
    await waitedFor(f.actionId!, FRESH_CONTINUATION_PENDING_BOUND_MS + 1_000);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace" });
  }, 60_000);

  it("keeps the task workspace when the old local writer is proven gone", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "process_lost" });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "writer_ended" });
  }, 60_000);

  it("settles only the reconciliation holds it owns and leaves restore holds and history alone", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    const [history] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      status: "cancelled", outcome: "cancelled", ownerType: "board", cause: "native_restart_recovery_blocked",
      fingerprint: `history:${f.runId}`, nextAction: "Old note", resolutionNote: "kept", resolvedAt: new Date(),
      evidence: { runId: f.runId } }).returning();
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const [untouched] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, history!.id));
    expect(untouched).toMatchObject({ status: "cancelled", nextAction: "Old note", resolutionNote: "kept", ownerType: "board" });
    expect(untouched!.evidence).toEqual({ runId: f.runId });

    // A restore hold that workspace recovery has not finished keeps the task with it.
    const g = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    const [restore] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: g.issueId, kind: "active_run_watchdog",
      status: "resolved", outcome: "blocked", ownerType: "system", cause: "native_continuation_requires_reconciliation",
      fingerprint: `native-workspace:${g.runId}`, nextAction: "Recovering saved work", resolvedAt: new Date(),
      evidence: { runId: g.runId, workspaceRestoreFailure: "restore_unsafe_archive",
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: g.runId, replay: "blocked" } } }).returning();
    expect(await ensureFreshContinuation(db, { companyId, runId: g.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "exact_recovery_pending", reason: "workspace_recovery_owns_restore" });
    const [kept] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, restore!.id));
    expect(kept!.evidence).toMatchObject({ workspaceRestoreFailure: "restore_unsafe_archive", automaticRecovery: { replay: "blocked" } });
    expect(kept!.evidence.executionReconciliation).toBeUndefined();
  }, 60_000);

  it("schedules no recheck for a held task nothing would act on", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted", hold: "settled_blocked" });
    await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
      freshContinuationCheck: { kind: "person_owned", reason: "approval_pending", checkedAt: Date.now() - 7_200_000,
        nextCheckAt: Date.now() - 3_600_000 } })}::jsonb` }).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await nextFreshContinuationCheckAt(db)).not.toBeNull();
    // The task was cancelled after that check: the schedule goes quiet.
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    expect(await nextFreshContinuationCheckAt(db)).toBeNull();
    expect(await heldExecutionsAwaitingFreshContinuation(db, new Date(), 10)).toEqual([]);
    expect(await executionControlSchedule(db).disposition()).toBeNull();
  }, 60_000);

  it("schedules no disposition scan for a held record the backlog pass leaves alone, and still does for an eligible one", async () => {
    const overdueCheck = (actionId: string) => db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
      freshContinuationCheck: { kind: "backoff", checkedAt: Date.now() - 7_200_000, nextCheckAt: Date.now() - 3_600_000 } })}::jsonb` })
      .where(eq(issueRecoveryActions.id, actionId));
    const old = await heldBacklog("native_restart_recovery_blocked", 3 * 24 * 60 * 60_000);
    await overdueCheck(old.actionId!);
    expect(await nextFreshContinuationCheckAt(db)).toBeNull();
    expect(await executionControlSchedule(db).disposition()).toBeNull();
    const recent = await heldBacklog("native_restart_recovery_blocked", 60 * 60_000);
    await overdueCheck(recent.actionId!);
    expect(await nextFreshContinuationCheckAt(db)).not.toBeNull();
  }, 60_000);

  it("tells the agent the previous attempt was cut off and which actions are unverified", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_session_interrupted" });
    await db.insert(toolInvocations).values({ companyId, agentId, issueId: f.issueId, runId: f.runId, toolName: "github.create_pull_request",
      riskLevel: "write", status: "executing", startedAt: new Date() } as typeof toolInvocations.$inferInsert);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    const decision = hold!.evidence.executionReconciliation as Record<string, string>;
    expect(decision.outcomeEvidence).toContain(`run ${f.runId}) was cut off`);
    expect(decision.outcomeEvidence).toContain("github.create_pull_request");
    expect(decision.outcomeEvidence).not.toMatch(adminText);
  }, 60_000);

  it("names the subtasks, comments and documents the cut-off run already created, so the fresh run does not repeat them", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_restart_recovery_blocked" });
    for (const title of ["SM sub 1 b3d70e77s1", "SM sub 2 b3d70e77s2"])
      await db.insert(issues).values({ companyId, title, status: "todo", assigneeAgentId: agentId, parentId: f.issueId,
        originRunId: f.runId } as typeof issues.$inferInsert);
    await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorAgentId: agentId, createdByRunId: f.runId,
      body: "DONE-0d981334" } as typeof issueComments.$inferInsert);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    const decision = hold!.evidence.executionReconciliation as Record<string, string>;
    expect(decision.outcomeEvidence).toContain('"SM sub 1 b3d70e77s1"');
    expect(decision.outcomeEvidence).toContain('"SM sub 2 b3d70e77s2"');
    expect(decision.outcomeEvidence).toContain('"DONE-0d981334"');
    expect(decision.outcomeEvidence).toContain("Do not create or post them again");
    expect(hold!.evidence.freshContinuation).toMatchObject({ createdObjects: { subtasks: expect.arrayContaining([expect.stringContaining("SM sub 1")]) } });
  }, 60_000);

  it("names the follow-up the cut-off run had read and its own final comment, so the agent answers once (t003)", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_restart_recovery_blocked" });
    const [followUp] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "board-user", body: "Additional requirement: include the line FOLLOWUP-0d981334" } as typeof issueComments.$inferInsert).returning();
    await db.insert(heartbeatRunEvents).values({ companyId, runId: f.runId, agentId, seq: 1, eventType: "task_history.read",
      stream: "system", level: "info", payload: { comments: { [followUp!.id]: followUp!.updatedAt.toISOString() } },
    } as typeof heartbeatRunEvents.$inferInsert);
    await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorAgentId: agentId, createdByRunId: f.runId,
      body: "DONE-0d981334" } as typeof issueComments.$inferInsert);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    const note = (hold!.evidence.executionReconciliation as Record<string, string>).outcomeEvidence;
    expect(note).toContain("had already read these messages");
    expect(note).toContain("FOLLOWUP-0d981334");
    expect(note).toContain('posted comments "DONE-0d981334"');
    expect(note.indexOf("had already read")).toBeLessThan(note.indexOf("DONE-0d981334"));
  }, 60_000);

  it("does not list a follow-up edited after the cut-off run read it as already read; it is marked as changed", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_restart_recovery_blocked" });
    const [followUp] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "board-user", body: "Additional requirement: include the line FOLLOWUP-OLD" } as typeof issueComments.$inferInsert).returning();
    await db.insert(heartbeatRunEvents).values({ companyId, runId: f.runId, agentId, seq: 1, eventType: "task_history.read",
      stream: "system", level: "info", payload: { comments: { [followUp!.id]: followUp!.updatedAt.toISOString() } },
    } as typeof heartbeatRunEvents.$inferInsert);
    await db.update(issueComments).set({ body: "Additional requirement: include the line FOLLOWUP-NEW",
      updatedAt: new Date(followUp!.updatedAt.getTime() + 60_000) }).where(eq(issueComments.id, followUp!.id));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" })).toMatchObject({ kind: "continued" });
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    const note = (hold!.evidence.executionReconciliation as Record<string, string>).outcomeEvidence;
    expect(note).not.toContain("had already read");
    expect(note).toContain("edited these messages after that run read them");
    expect(note).toContain("FOLLOWUP-NEW");
  }, 60_000);

  it.each([true, false])("relies on saved input only while it still holds an undelivered message (already taken by the cut-off run: %s)", async taken => {
    // R2 cell t003: the cut-off run had taken the follow-up into its turn; the fallback chose saved_input,
    // promotion settled the message as delivered, and no run followed.
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_restart_recovery_blocked" });
    const [comment] = await db.insert(issueComments).values({ companyId, issueId: f.issueId, authorType: "user",
      authorUserId: userId, body: "Additional requirement: include FOLLOWUP-1" } as typeof issueComments.$inferInsert).returning();
    if (taken) await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, wakeCommentIds: [comment!.id] } })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: userId,
      payload: { issueId: f.issueId, _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [comment!.id] } },
    } as typeof agentWakeupRequests.$inferInsert);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", delivery: taken ? "recorded" : "saved_input" });
  }, 60_000);

  it.each([
    { title: "a pending approval", setup: "approval" as const, errorCode: "native_continuation_requires_reconciliation" },
    { title: "a credential the person has not shared", setup: "none" as const, errorCode: "configuration_incomplete" },
    { title: "a budget stop", setup: "none" as const, errorCode: "budget_blocked" },
  ])("leaves a task waiting on $title for the person", async ({ setup, errorCode }) => {
    expect(PERSON_OWNED_FAILURE_CODES).toContain("configuration_incomplete");
    const f = await unfinishedRun({ runtime: "native", errorCode });
    if (setup === "approval") {
      const [approval] = await db.insert(approvals).values({ companyId, type: "approve_ceo_strategy", status: "pending",
        payload: {} } as typeof approvals.$inferInsert).returning();
      await db.insert(issueApprovals).values({ companyId, issueId: f.issueId, approvalId: approval!.id } as typeof issueApprovals.$inferInsert);
    }
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "person_owned" });
    await settleUnrecoverableExecutions(db);
    expect(await issue(f.issueId)).toMatchObject({ status: "blocked" });
    await deliver();
    expect(await successors(f.runId)).toHaveLength(0);
  }, 60_000);

  it("bounds continuations with the server-restart lane's hourly cap", () => {
    expect(FRESH_CONTINUATIONS_PER_HOUR).toBe(SERVER_RESTART_RETRY_MAX_ATTEMPTS);
    expect(FRESH_CONTINUATION_WINDOW_MS).toBe(SERVER_RESTART_RETRY_WINDOW_MS);
  });

  // Governance gates are never retired or bypassed by the fallback.
  it.each(["question_pending", "user_owned_hold", "operator_continuation_recorded", "owner_gone_attestation"] as const)(
    "leaves a task behind a real governance gate (%s) for the person", async gate => {
      const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation" });
      if (gate === "question_pending") await db.insert(issueThreadInteractions).values({ companyId, issueId: f.issueId,
        kind: "ask_user_questions", status: "pending", payload: { questions: [] } } as unknown as typeof issueThreadInteractions.$inferInsert);
      if (gate === "user_owned_hold") await db.update(issueRecoveryActions).set({ ownerType: "user", ownerUserId: userId })
        .where(eq(issueRecoveryActions.id, f.actionId!));
      if (gate === "operator_continuation_recorded" || gate === "owner_gone_attestation") {
        const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
        await db.update(issueRecoveryActions).set({ evidence: { ...hold!.evidence,
          ...(gate === "owner_gone_attestation" ? { ownerGoneAttestation: { actorId: userId } } : { explicitUserContinuation: { actorId: userId } }) } })
          .where(eq(issueRecoveryActions.id, f.actionId!));
      }
      const before = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!)))[0]!;
      expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
        .toMatchObject({ kind: "person_owned" });
      const after = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!)))[0]!;
      expect(after.evidence).toEqual(before.evidence);
      expect(after.status).toBe(before.status);
      await deliver();
      expect(await successors(f.runId)).toHaveLength(0);
    }, 60_000);

  // Interruption with an unknown outcome is not a governance gate: the task
  // continues, but as a fresh run, never a replay, and with an audit trail.
  it("continues an interrupted governed action as a fresh run, never a replay, and keeps the audit trail", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable", hold: "settled_blocked" });
    const [inFlight] = await db.insert(toolInvocations).values({ companyId, agentId, issueId: f.issueId, runId: f.runId,
      toolName: "github.merge_pull_request", riskLevel: "write", status: "executing", startedAt: new Date() } as typeof toolInvocations.$inferInsert)
      .returning();
    const original = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!)))[0]!.evidence.automaticRecovery;
    await settleUnrecoverableExecutions(db);
    const next = await expectOneFreshSuccessor(f);
    // A fresh session: the interrupted turn is not re-sent.
    expect(next.contextSnapshot).toMatchObject({ forceFreshSession: true });
    expect(next.sessionIdBefore).toBeNull();
    // The cut-off tool call is not re-executed: it stays as recorded and no new invocation exists.
    const invocations = await db.select().from(toolInvocations).where(eq(toolInvocations.issueId, f.issueId));
    expect(invocations).toEqual([expect.objectContaining({ id: inFlight!.id, runId: f.runId, status: "executing" })]);
    // The earlier no-replay decision stays as history beside the attributed fallback decision.
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(hold!.evidence.automaticRecoveryHistory).toEqual(original);
    expect(hold!.evidence.freshContinuationSettlement).toMatchObject({ actorType: "system", actorId: "fresh-continuation",
      decision: "continue_in_fresh_run", replay: "none", reason: "exact_resumption_unavailable",
      unverifiedActions: ["github.merge_pull_request"], recordedAt: expect.any(String) });
    expect((hold!.evidence.executionReconciliation as Record<string, string>).outcomeEvidence).toContain("github.merge_pull_request");
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
      eq(activityLog.action, "issue.continued_from_saved_work")))).toHaveLength(1);
  }, 60_000);

  // The isolation decision is a property of the task's next run, whatever path starts it.
  it("moves the task off the old writer's workspace and runs the isolated continuation before saved input", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost", error: "Legacy controller lease lost" });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, sourceIssueId: f.issueId, mode: "isolated",
      strategyType: "git_worktree", name: "Task workspace", cwd: "/tmp/old-writer" }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace!.id, workspaceBindingRevision: 2 }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000),
      contextSnapshot: { issueId: f.issueId, executionWorkspaceId: workspace!.id } }).where(eq(heartbeatRuns.id, f.runId));
    // A person's saved message is waiting. It carries no isolation marker, so it cannot prepare the
    // new workspace (a projectless task would be refused at admission once the binding is cleared):
    // the isolated continuation runs first and the saved message follows it.
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: userId, payload: { issueId: f.issueId } });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace", delivery: "recorded" });
    // No delivery path can reach the old directory: the task is no longer bound to it.
    expect(await issue(f.issueId)).toMatchObject({ executionWorkspaceId: null, workspaceBindingRevision: 3 });
    const [kept] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace!.id));
    expect(kept!.cwd).toBe("/tmp/old-writer");
  }, 60_000);

  it("records its own isolated continuation when saved input could not avoid a shared directory", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "controller_lease_lost" });
    await db.update(heartbeatRuns).set({ processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000) })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: userId, payload: { issueId: f.issueId } });
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", isolation: "fresh_isolated_workspace", delivery: "recorded" });
  }, 60_000);

  it("backs off instead of blocking once a task used its hourly continuations", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "process_lost" });
    for (let index = 0; index < FRESH_CONTINUATIONS_PER_HOUR; index++) {
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", status: "resolved",
        outcome: "restored", ownerType: "system", cause: "fresh_continuation", fingerprint: `fresh-continuation:${randomUUID()}`,
        nextAction: "continued", evidence: { runId: randomUUID(), continuationDelivery: "delivered",
          freshContinuation: { schema: FRESH_CONTINUATION_SCHEMA, sourceRunId: randomUUID(),
            recordedAt: new Date(Date.now() - (index + 1) * 60_000).toISOString() } } });
    }
    await settleUnrecoverableExecutions(db);
    const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    // Not blocked for a person: the hold stays with the system and is checked again when the window frees a slot.
    expect(hold).toMatchObject({ status: "active" });
    expect(hold!.evidence.freshContinuationCheck).toMatchObject({ kind: "backoff", nextCheckAt: expect.any(Number) });
    expect(await continueHeldExecutions(db)).toMatchObject({ continued: 0 });
    // With no other event, the disposition worker is scheduled for exactly the
    // moment the window has room again.
    const retryAt = (hold!.evidence.freshContinuationCheck as { nextCheckAt: number }).nextCheckAt;
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(await nextFreshContinuationCheckAt(db)).toBe(retryAt);
    expect(await executionControlSchedule(db).disposition()).toBe(retryAt);
    // The hour passes (the window's records age out and the check falls due);
    // the scheduled pass alone continues the task.
    await db.execute(sql`update issue_recovery_actions set evidence = jsonb_set(evidence, '{freshContinuation,recordedAt}',
      to_jsonb((now() - interval '2 hours')::text)) where evidence ? 'freshContinuation'`);
    await db.update(issueRecoveryActions).set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence},
      '{freshContinuationCheck,nextCheckAt}', to_jsonb(${Date.now() - 1_000}::bigint))` }).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(await executionControlSchedule(db).disposition()).toBeLessThanOrEqual(Date.now() + 60_000);
    await settleUnrecoverableExecutions(db);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "already_continued" });
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toHaveLength(0);
  }, 60_000);
});
