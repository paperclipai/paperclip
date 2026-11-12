import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, approvals, authUsers, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issueApprovals, issueRecoveryActions,
  issues, nativeRunFinalizations, toolInvocations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { deliverReconciledExecutions, settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import {
  FRESH_CONTINUATIONS_PER_HOUR, FRESH_CONTINUATION_SCHEMA, PERSON_OWNED_FAILURE_CODES, continueHeldExecutions, ensureFreshContinuation,
  heldExecutionsAwaitingFreshContinuation, nextFreshContinuationCheckAt,
} from "./fresh-continuation-fallback.js";
import { heartbeatService } from "./heartbeat.js";
import { currentControllerProcessStamp } from "./controller-process-identity.js";
import { executionControlSchedule } from "./execution-control-work.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
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
    await db.execute(sql`truncate table issue_recovery_actions, native_run_finalizations, tool_invocations,
      issue_approvals, approvals, agent_wakeup_requests, environment_leases, execution_workspaces, heartbeat_runs, issues cascade`);
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

  it("admits an ordinary continuation wake for a held task as the fresh continuation", async () => {
    const f = await unfinishedRun({ runtime: "native", errorCode: "native_continuation_requires_reconciliation",
      error: "runner_remote_process_identity_unavailable", hold: "settled_blocked" });
    await occupySlot();
    const run = await heartbeatService(db).wakeup(agentId, { source: "automation", triggerDetail: "system",
      reason: "issue_continuation_needed", payload: { issueId: f.issueId }, requestedByActorType: "system",
      requestedByActorId: "idle-task-sweep", contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_continuation_needed" } });
    expect(run).toBeTruthy();
    const [queued] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run!.id)));
    expect(queued!.contextSnapshot).toMatchObject({ issueId: f.issueId, forceFreshSession: true, freshContinuationOfRunId: f.runId });
    expect(await getExecutionBlocker(db, companyId, f.issueId)).toBeNull();
    // The wake is the continuation: no second one is recorded for delivery.
    await deliver();
    expect(await successors(f.runId)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`)).toHaveLength(2);
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
    await db.update(heartbeatRuns).set({ processPid: 4242, controllerProcess: { ...currentControllerProcessStamp(), hostHash: "replaced-server" } })
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

  it("lets a previous process still running on this host settle first", async () => {
    const f = await unfinishedRun({ runtime: "legacy", errorCode: "process_lost" });
    await db.update(heartbeatRuns).set({ processPid: process.pid, controllerProcess: currentControllerProcessStamp() })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "exact_recovery_pending", reason: "previous_process_running" });
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
    // Once the window has room, the next pass continues it.
    await db.execute(sql`update issue_recovery_actions set evidence = jsonb_set(evidence, '{freshContinuation,recordedAt}',
      to_jsonb((now() - interval '2 hours')::text)) where evidence ? 'freshContinuation'`);
    await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} - 'freshContinuationCheck'` })
      .where(eq(issueRecoveryActions.id, f.actionId!));
    await settleUnrecoverableExecutions(db);
    expect(await ensureFreshContinuation(db, { companyId, runId: f.runId, trigger: "held_recovery" }))
      .toMatchObject({ kind: "already_continued" });
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toHaveLength(0);
  }, 60_000);
});
