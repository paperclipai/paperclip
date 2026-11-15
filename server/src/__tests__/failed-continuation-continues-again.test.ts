import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { ASSIGNED_WORK_CONTINUED_ACTION, ASSIGNED_WORK_REPAIRS_PER_MINUTE, assignedWorkSweep } from "../services/recovery/assigned-work-sweep.js";
import { taskAutomaticAttempts, transientRetryWithinTaskCap } from "../services/recovery/task-automatic-attempts.js";
import { FRESH_CONTINUATION_SCHEMA, continueHeldExecutions, ensureFreshContinuation, resetBacklogContinuationPacingForTests } from "../services/fresh-continuation-fallback.js";
import { PERMANENT_FAILURE_CODES, PERSON_OWNED_FAILURE_CODES } from "../services/continuation-cause.js";
import { AUTOMATIC_RETRY_REASONS, SHARED_CONTINUATION_WINDOW_MS, sharedContinuationAttempts } from "../services/recovery/continuation-ledger.js";
import { SERVER_RESTART_RETRY_MAX_ATTEMPTS, SERVER_RESTART_RETRY_REASON, SERVER_RESTART_RETRY_WINDOW_MS } from "../services/execution-recovery-attempt.js";
import { FRESH_CONTINUATIONS_PER_HOUR } from "../services/fresh-continuation-fallback.js";
import { createSystemRecovery } from "../services/system-recovery-state.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping failed continuation tests: ${recoveryPostgresSupport.reason}`);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAYTONA_TIMEOUT = "HTTP request timed out after 300000ms waiting for a response. This is a client-side deadline (DaytonaConfig.timeout)";

describe("shared continuation ledger", () => {
  it("uses the server-restart lane's window, cap and retry reason", () => {
    expect(SHARED_CONTINUATION_WINDOW_MS).toBe(SERVER_RESTART_RETRY_WINDOW_MS);
    expect(FRESH_CONTINUATIONS_PER_HOUR).toBe(SERVER_RESTART_RETRY_MAX_ATTEMPTS);
    expect(AUTOMATIC_RETRY_REASONS).toContain(SERVER_RESTART_RETRY_REASON);
  });
});

describePostgres("a continuation that fails before doing any work is continued again", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("failed-continuation-");
    db = createDb(temporary.connectionString);
  }, 240_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  function wakeQueue() {
    const calls: string[] = [];
    const enqueueWakeup = vi.fn(async (agentId: string, opts?: { payload?: Record<string, unknown> | null; reason?: string | null }) => {
      const issueId = String(opts?.payload?.issueId);
      const [issue] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: issue!.companyId, agentId, source: "automation",
        triggerDetail: "system", reason: opts?.reason ?? null, payload: opts?.payload ?? null, status: "queued" }).returning();
      calls.push(issueId);
      return { id: wake!.id } as never;
    });
    return { calls, enqueueWakeup };
  }

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Continuation fixture", issuePrefix: `C${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", adapterType: "paperclip_runner", status: "idle", adapterConfig: {} });
    let number = 0;
    async function task(values: Partial<typeof issues.$inferInsert> = {}) {
      number += 1;
      const [row] = await db.insert(issues).values({ companyId, title: `Task ${number}`, status: "in_progress", assigneeAgentId: agentId,
        issueNumber: number, identifier: `C${companyId.slice(0, 7)}-${number}`, updatedAt: new Date(Date.now() - 2 * HOUR),
        createdAt: new Date(Date.now() - 5 * HOUR), ...values }).returning();
      return row!;
    }
    async function run(issueId: string, values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
      const finishedAt = values.finishedAt ?? new Date(Date.now() - 10 * MINUTE);
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", status: "failed",
        runtimeMode: "legacy", startedAt: new Date(finishedAt.getTime() - MINUTE), finishedAt,
        createdAt: new Date(finishedAt.getTime() - 2 * MINUTE), livenessState: "failed",
        runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }, ...values,
        contextSnapshot: { issueId, taskId: issueId, ...(values.contextSnapshot ?? {}) } }).returning();
      return row!;
    }
    async function continued(issueId: string, values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
      const source = await run(issueId, { errorCode: "native_restart_recovery_blocked", error: "native_interruption_deadline_exceeded",
        finishedAt: new Date(Date.now() - 70 * MINUTE) });
      const recordId = randomUUID();
      const continuation = await run(issueId, { errorCode: "setup_failed", error: DAYTONA_TIMEOUT, retryOfRunId: source.id, ...values,
        contextSnapshot: { wakeReason: "issue_recovery_action_restored", previousRunId: source.id, forceFreshSession: true,
          freshContinuationIsolation: recordId, ...(values.contextSnapshot ?? {}) } });
      await db.insert(issueRecoveryActions).values({ id: recordId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
        status: "resolved", outcome: "restored", ownerType: "system", returnOwnerAgentId: agentId, cause: "fresh_continuation",
        fingerprint: `fresh-continuation:${source.id}`, nextAction: "Continuing.", resolutionNote: "continued_fresh_from_last_saved",
        resolvedAt: new Date(Date.now() - 60 * MINUTE), attemptCount: 1,
        evidence: { runId: source.id, continuationDelivery: "delivered", continuationRunId: continuation.id,
          freshContinuation: { schema: FRESH_CONTINUATION_SCHEMA, sourceRunId: source.id, isolation: "remote_epoch",
            recordedAt: new Date(Date.now() - 60 * MINUTE).toISOString() } } });
      return continuation;
    }
    return { companyId, agentId, task, run, continued };
  }

  async function heldRun(f: Awaited<ReturnType<typeof seed>>, errorCode: string, contextSnapshot: Record<string, unknown>,
    endedAgo = 2 * HOUR) {
    const task = await f.task({ status: "blocked", blockedTransitionAt: new Date(Date.now() - 30 * MINUTE), statusVersion: 4 });
    const failed = await f.run(task.id, { runtimeMode: "native", nativeIssueId: task.id, issueId: task.id, errorCode, error: errorCode,
      finishedAt: new Date(Date.now() - endedAgo), contextSnapshot });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: task.id, kind: "active_run_watchdog",
      status: "resolved", outcome: "blocked", resolvedAt: new Date(Date.now() - endedAgo), ownerType: "board", returnOwnerAgentId: f.agentId,
      cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuation:${failed.id}`, nextAction: "Held.",
      evidence: { runId: failed.id, originalFailureCode: errorCode, nativeFailureBlock: { runId: failed.id, statusVersion: 4 },
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: failed.id, replay: "blocked", actionOutcome: "unknown",
          recordedAt: new Date(Date.now() - endedAgo).toISOString() } } }).returning();
    return { task, failed, hold: hold! };
  }
  const recoveryContext = { wakeReason: "transient_failure_retry", retryReason: "transient_failure", previousRunId: randomUUID() };
  const personRetryContext = { wakeReason: "task_retry", previousRunId: randomUUID(), explicitUserContinuation: { previousRunId: randomUUID() } };

  const taskRow = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
  const activeStrandedHolds = async (issueId: string) => db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.kind, "stranded_assigned_issue"),
    inArray(issueRecoveryActions.status, ["active", "escalated"])));
  const continuationsOf = async (runId: string) => db.select().from(issueRecoveryActions)
    .where(sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,sourceRunId}' = ${runId}`);

  it("a recorded continuation whose run failed in setup is not escalated to the board, and the sweep continues it again from saved work", async () => {
    const f = await seed();
    const task = await f.task();
    const failed = await f.continued(task.id);
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup, scheduleRecoveryRetry: async () => null });

    await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: task.id, skipRelatedRecovery: true });
    expect((await taskRow(task.id)).status).toBe("in_progress");
    expect(await activeStrandedHolds(task.id)).toHaveLength(0);

    const check = await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId: task.id });
    expect(check).toMatchObject({ outcome: "repaired", verdict: { kind: "violation" } });
    const [record] = await continuationsOf(failed.id);
    expect(record?.evidence).toMatchObject({ continuationDelivery: "pending", freshContinuation: { sourceRunId: failed.id } });
    expect(queue.calls).toHaveLength(0);
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId: task.id }))
      .toMatchObject({ outcome: "ok", verdict: { clause: "pending_intent" } });
  }, 60_000);

  it("a todo task whose assignment recovery run failed in setup is continued, not blocked", async () => {
    const f = await seed();
    const task = await f.task({ status: "todo" });
    const earlier = await f.run(task.id, { errorCode: "controller_lease_lost", finishedAt: new Date(Date.now() - 80 * MINUTE) });
    const failed = await f.run(task.id, { errorCode: "setup_failed", error: DAYTONA_TIMEOUT, retryOfRunId: earlier.id,
      contextSnapshot: { wakeReason: "issue_assignment_recovery", retryReason: "assignment_recovery" } });
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup, scheduleRecoveryRetry: async () => null });

    await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: task.id, skipRelatedRecovery: true });
    expect((await taskRow(task.id)).status).toBe("todo");
    expect(await activeStrandedHolds(task.id)).toHaveLength(0);

    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId: task.id })).toMatchObject({ outcome: "repaired" });
    expect(await continuationsOf(failed.id)).toHaveLength(1);
    expect(queue.calls).toHaveLength(0);
  }, 60_000);

  it("a task an older release already escalated to the board for a failed continuation is continued on the first sweep after deploy", async () => {
    const f = await seed();
    const blockedAt = new Date(Date.now() - 20 * MINUTE);
    const task = await f.task({ status: "blocked", blockedTransitionAt: blockedAt });
    const failed = await f.continued(task.id, { errorCode: "setup_failed",
      error: "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the work",
      finishedAt: new Date(blockedAt.getTime() - 30_000) });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: task.id, kind: "stranded_assigned_issue",
      status: "active", ownerType: "board", cause: "stranded_assigned_issue",
      fingerprint: `source_scoped_recovery:${f.companyId}:${task.id}:stranded_assigned_issue`,
      evidence: { previousStatus: "in_progress", latestRunId: failed.id, latestRunErrorCode: "setup_failed",
        routingPolicy: "board_escalation_no_takeover_v1" }, nextAction: "Board operator: inspect the evidence.", attemptCount: 1 }).returning();
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "system", action: "issue.updated",
      entityType: "issue", entityId: task.id, details: { status: "blocked", previousStatus: "in_progress",
        source: "recovery.reconcile_stranded_assigned_issue" }, createdAt: blockedAt });
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup });

    expect((await recovery.assignedWork.listSuspects({ companyId: f.companyId }, null, 100)).map(row => row.id)).toContain(task.id);
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId: task.id }))
      .toMatchObject({ outcome: "repaired", verdict: { reason: "recovery_block" } });
    expect((await taskRow(task.id)).status).not.toBe("blocked");
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold!.id)))[0])
      .toMatchObject({ status: "resolved", ownerType: "system" });
    expect(await continuationsOf(failed.id)).toHaveLength(1);
    expect(queue.calls).toHaveLength(0);
  }, 60_000);

  it.each([
    ["setup_failed", "Database query failed (40P01)"],
    ["adapter_failed", "native_remote_recovery_lease_mismatch: stage=runner_verification field=replacement_sandbox"],
    ["runner_remote_provider_artifact_incompatible", "provider pack verification failed (exitCode=1; timedOut=false)"],
  ])("the held backlog continues a recovery run that failed with %s, and still leaves an ordinary run's provider failure", async (errorCode, error) => {
    resetBacklogContinuationPacingForTests(db);
    const f = await seed();
    async function held(contextSnapshot: Record<string, unknown>) {
      const task = await f.task({ status: "blocked", blockedTransitionAt: new Date(Date.now() - 30 * MINUTE), statusVersion: 4 });
      const failed = await f.run(task.id, { runtimeMode: "native", nativeIssueId: task.id, issueId: task.id, errorCode, error,
        finishedAt: new Date(Date.now() - 2 * HOUR), contextSnapshot });
      await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: task.id, kind: "active_run_watchdog",
        status: "resolved", outcome: "blocked", resolvedAt: new Date(Date.now() - 2 * HOUR), ownerType: "board", returnOwnerAgentId: f.agentId,
        cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuation:${failed.id}`, nextAction: "Held.",
        evidence: { runId: failed.id, originalFailureCode: errorCode, nativeFailureBlock: { runId: failed.id, statusVersion: 4 },
          automaticRecovery: { policy: "preserve_without_replay_v1", runId: failed.id, replay: "blocked", actionOutcome: "unknown",
            recordedAt: new Date(Date.now() - 2 * HOUR).toISOString() } } });
      return failed;
    }
    const recoveryRun = await held({ wakeReason: "transient_failure_retry", retryReason: "transient_failure", previousRunId: randomUUID() });
    const ordinary = await held({ wakeReason: "issue_assigned" });
    for (let pass = 0; pass < 3; pass += 1) await continueHeldExecutions(db, new Date());
    expect(await continuationsOf(recoveryRun.id)).toHaveLength(1);
    expect(await continuationsOf(ordinary.id)).toHaveLength(0);
  }, 60_000);

  it("a continuation run that failed for a reason a person owns is still escalated as before", async () => {
    const f = await seed();
    const task = await f.task();
    await f.continued(task.id, { errorCode: "provider_tool_definition_invalid", error: "The tool definition was rejected by the provider." });
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup, scheduleRecoveryRetry: async () => null });
    await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: task.id, skipRelatedRecovery: true });
    expect((await taskRow(task.id)).status).toBe("blocked");
  }, 60_000);

  it("past the hourly cap the task waits for the next window, unblocked, and no attempt is spent", async () => {
    const f = await seed();
    const task = await f.task();
    const failed = await f.continued(task.id);
    for (let index = 0; index < 6; index += 1) {
      await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "system", action: ASSIGNED_WORK_CONTINUED_ACTION,
        entityType: "issue", entityId: task.id, details: { outcome: "queued" }, createdAt: new Date(Date.now() - (50 - index * 5) * MINUTE) });
    }
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup, scheduleRecoveryRetry: async () => null });
    await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: task.id, skipRelatedRecovery: true });
    const check = await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId: task.id });
    expect(check).toMatchObject({ outcome: "deferred_cap" });
    expect(check!.retryAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await taskRow(task.id)).status).toBe("in_progress");
    expect(await continuationsOf(failed.id)).toHaveLength(0);
    expect(queue.calls).toHaveLength(0);
  }, 60_000);
  it("a recovery run stopped during preparation with no hold left is continued once the wait bound passes, not waited on forever", async () => {
    const f = await seed();
    const task = await f.task();
    const endedAt = new Date(Date.now() - 5 * MINUTE);
    const stopped = await f.run(task.id, { status: "interrupted", errorCode: "server_shutdown_interrupted", executionStage: "preparing",
      error: "Interrupted by graceful server shutdown (SIGTERM)", finishedAt: endedAt,
      contextSnapshot: { wakeReason: "issue_assignment_recovery", retryReason: "assignment_recovery" } });
    const queue = wakeQueue();
    let clock = new Date();
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup, now: () => clock });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: task.id })).toMatchObject({ outcome: "waiting_on_recovery" });
    expect(await continuationsOf(stopped.id)).toHaveLength(0);
    for (const step of [3, 6, 12]) {
      clock = new Date(Date.now() + step * MINUTE);
      await sweep.checkIssue({ companyId: f.companyId, issueId: task.id });
    }
    expect(await continuationsOf(stopped.id)).toHaveLength(1);
    expect(queue.calls).toHaveLength(0);
  }, 60_000);
  it.each([["20 minutes", 20 * MINUTE, "continued"], ["30 hours", 30 * HOUR, "retry_needed"]] as const)(
    "a saved-work wait on a hold nobody records a check on ends in a named state; run ended %s ago, checked by two servers", async (_label, endedAgo, ending) => {
    const f = await seed();
    const task = await f.task();
    const failed = await f.run(task.id, { errorCode: "setup_failed", error: DAYTONA_TIMEOUT, finishedAt: new Date(Date.now() - endedAgo),
      contextSnapshot: { wakeReason: "transient_failure_retry", retryReason: "transient_failure" } });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: task.id, kind: "active_run_watchdog",
      status: "resolved", outcome: "restored", ownerType: "system", returnOwnerAgentId: f.agentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${failed.id}`, nextAction: "Recovering saved work.",
      resolvedAt: new Date(Date.now() - endedAgo), evidence: { runId: failed.id, systemRecovery: createSystemRecovery(failed.id) } });
    const queue = wakeQueue();
    let clock = new Date();
    const servers = [0, 1].map(() => assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup, now: () => clock }));
    for (const [index, step] of [0, 4, 9, 17, 33].entries()) {
      clock = new Date(Date.now() + step * MINUTE);
      await servers[index % 2]!.checkIssue({ companyId: f.companyId, issueId: task.id });
      if ((await continuationsOf(failed.id)).length || queue.calls.length) break;
    }
    if (ending === "continued") {
      expect(await continuationsOf(failed.id)).toHaveLength(1);
      expect(queue.calls).toHaveLength(0);
    } else {
      expect(await continuationsOf(failed.id)).toHaveLength(0);
      const [entry] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, task.id),
        eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION)));
      expect(entry?.details).toMatchObject({ outcome: "queued" });
      expect(queue.calls).toHaveLength(1);
    }
  }, 60_000);
  it("the held backlog leaves each permanent cause blocked", async () => {
    resetBacklogContinuationPacingForTests(db);
    const f = await seed();
    const left = [];
    for (const code of PERMANENT_FAILURE_CODES) left.push(await heldRun(f, code, recoveryContext));
    for (let pass = 0; pass < 4; pass += 1) await continueHeldExecutions(db, new Date());
    for (const entry of left) {
      expect(await continuationsOf(entry.failed.id)).toHaveLength(0);
      expect((await taskRow(entry.task.id)).status).toBe("blocked");
    }
  }, 120_000);

  const runKinds = {
    personRetry: personRetryContext,
    automatic: recoveryContext,
    firstAssignment: { wakeReason: "issue_assigned" },
  } as const;
  const causes = { setup: "setup_failed", restart: "process_lost", permanent: "low_trust_boundary_mismatch", person: "codex_auth_required" } as const;
  const decision = (kind: keyof typeof runKinds, cause: keyof typeof causes) =>
    cause === "restart" || (kind === "automatic" && cause === "setup");
  it.each(Object.keys(runKinds).flatMap(kind => Object.keys(causes).map(cause => [kind, cause] as [keyof typeof runKinds, keyof typeof causes])))(
    "every entry point makes the same decision for a %s run that failed with the %s cause", async (kind, cause) => {
    resetBacklogContinuationPacingForTests(db);
    const f = await seed();
    const errorCode = causes[cause];
    const continues = decision(kind, cause);
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup, scheduleRecoveryRetry: async () => null });

    const held = await heldRun(f, errorCode, runKinds[kind]);
    await continueHeldExecutions(db, new Date());
    expect(await continuationsOf(held.failed.id)).toHaveLength(continues ? 1 : 0);

    const blockedAt = new Date(Date.now() - 20 * MINUTE);
    const escalated = await f.task({ status: "blocked", blockedTransitionAt: blockedAt });
    const escalatedRun = await f.run(escalated.id, { errorCode, error: errorCode, finishedAt: new Date(blockedAt.getTime() - 30_000),
      contextSnapshot: runKinds[kind] });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: escalated.id, kind: "stranded_assigned_issue",
      status: "active", ownerType: "board", cause: "stranded_assigned_issue",
      fingerprint: `source_scoped_recovery:${f.companyId}:${escalated.id}:stranded_assigned_issue`,
      evidence: { previousStatus: "in_progress", latestRunId: escalatedRun.id, latestRunErrorCode: errorCode }, nextAction: "Held.", attemptCount: 1 });
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "system", action: "issue.updated",
      entityType: "issue", entityId: escalated.id, details: { status: "blocked", previousStatus: "in_progress",
        source: "recovery.reconcile_stranded_assigned_issue" }, createdAt: blockedAt });
    const sweep = await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId: escalated.id });
    expect(sweep?.outcome === "left_to_hold_owner").toBe(!continues);
    const fresh = await continuationsOf(escalatedRun.id);
    if (continues && kind === "automatic") {
      expect(fresh).toHaveLength(1);
      expect(queue.calls).not.toContain(escalated.id);
    }
    if (!continues) {
      expect(fresh).toHaveLength(0);
      expect(queue.calls).not.toContain(escalated.id);
      expect((await taskRow(escalated.id)).status).toBe("blocked");
    }

    if (kind === "automatic" && cause !== "restart") {
      const open = await f.task();
      const failed = await f.run(open.id, { errorCode, error: errorCode, contextSnapshot: runKinds[kind] });
      await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: open.id, skipRelatedRecovery: true });
      if (continues) {
        expect((await taskRow(open.id)).status).toBe("in_progress");
        await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId: open.id });
        expect(await continuationsOf(failed.id)).toHaveLength(1);
      }
    }
  }, 120_000);

  it("no entry point continues a person-owned or permanent cause", async () => {
    resetBacklogContinuationPacingForTests(db);
    const f = await seed();
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup, scheduleRecoveryRetry: async () => null });
    for (const code of [...PERSON_OWNED_FAILURE_CODES, ...PERMANENT_FAILURE_CODES]) {
      const held = await heldRun(f, code, recoveryContext);
      expect(await ensureFreshContinuation(db, { companyId: f.companyId, runId: held.failed.id, trigger: "held_recovery" }))
        .toMatchObject({ kind: "person_owned" });
      const task = await f.task();
      const failed = await f.continued(task.id, { errorCode: code, error: code });
      await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId: task.id });
      expect(await continuationsOf(failed.id)).toHaveLength(0);
    }
    await continueHeldExecutions(db, new Date());
    expect(await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, f.companyId),
      sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,trigger}' in ('held_recovery', 'assigned_work')`))).toHaveLength(0);
  }, 240_000);

  it("six automatic attempts of mixed kinds in the hour stop the held backlog until the next window", async () => {
    resetBacklogContinuationPacingForTests(db);
    const f = await seed();
    const held = await heldRun(f, "setup_failed", recoveryContext);
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MINUTE);
    for (const minutesAgo of [50, 40]) await f.run(held.task.id, { errorCode: "process_lost", scheduledRetryReason: "transient_failure",
      createdAt: at(minutesAgo), finishedAt: at(minutesAgo - 1) });
    for (const minutesAgo of [35, 30]) await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "system",
      action: ASSIGNED_WORK_CONTINUED_ACTION, entityType: "issue", entityId: held.task.id, details: { outcome: "queued" }, createdAt: at(minutesAgo) });
    for (const minutesAgo of [25, 20]) await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: held.task.id,
      kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system", cause: "fresh_continuation",
      fingerprint: `fresh-continuation:${randomUUID()}`, nextAction: "Continuing.", resolvedAt: at(minutesAgo),
      evidence: { runId: randomUUID(), continuationDelivery: "delivered", freshContinuation: { schema: FRESH_CONTINUATION_SCHEMA,
        trigger: "held_recovery", recordedAt: at(minutesAgo).toISOString() } } });
    await db.update(heartbeatRuns).set({ createdAt: at(10), finishedAt: at(9) }).where(eq(heartbeatRuns.id, held.failed.id));
    expect(await continueHeldExecutions(db, new Date())).toMatchObject({ continued: 0 });
    const [checked] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, held.hold.id));
    const nextCheckAt = Number((checked!.evidence.freshContinuationCheck as { nextCheckAt?: number }).nextCheckAt);
    expect(nextCheckAt).toBeGreaterThan(Date.now() + 9 * MINUTE);
    expect(nextCheckAt).toBeLessThanOrEqual(Date.now() + 10 * MINUTE + 5_000);
    expect(await continuationsOf(held.failed.id)).toHaveLength(0);
    expect(await continueHeldExecutions(db, new Date(Date.now() + 11 * MINUTE))).toMatchObject({ continued: 1 });
  }, 60_000);
  it("checks that only waited for exact recovery spend no attempt, so the fallback is reached at the bound", async () => {
    const f = await seed();
    const task = await f.task();
    const stopped = await f.run(task.id, { status: "interrupted", errorCode: "server_shutdown_interrupted", executionStage: "preparing",
      error: "Interrupted by graceful server shutdown (SIGTERM)", finishedAt: new Date(Date.now() - 2 * MINUTE),
      contextSnapshot: { wakeReason: "issue_assignment_recovery", retryReason: "assignment_recovery" } });
    for (const minutesAgo of [40, 36, 32, 28, 24]) await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system",
      actorId: "system", action: ASSIGNED_WORK_CONTINUED_ACTION, entityType: "issue", entityId: task.id,
      details: { outcome: "queued" }, createdAt: new Date(Date.now() - minutesAgo * MINUTE) });
    const queue = wakeQueue();
    let clock = new Date();
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup, now: () => clock });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: task.id })).toMatchObject({ outcome: "waiting_on_recovery" });
    clock = new Date(Date.now() + 16 * MINUTE);
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: task.id })).toMatchObject({ outcome: "repaired" });
    expect(await continuationsOf(stopped.id)).toHaveLength(1);
  }, 60_000);

  async function blockedBehindRefusedRun(f: Awaited<ReturnType<typeof seed>>) {
    const blockedAt = new Date(Date.now() - 20 * MINUTE);
    const task = await f.task({ status: "blocked", blockedTransitionAt: blockedAt, statusVersion: 3 });
    const source = await f.run(task.id, { errorCode: "adapter_failed", error: "native_instruction_materialization_handoff_unavailable",
      finishedAt: new Date(blockedAt.getTime() - 500), resultJson: { workspaceRestoreFailure: "restore_failed" },
      contextSnapshot: { wakeReason: "issue_children_completed" } });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: task.id, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: f.agentId, cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${source.id}`, nextAction: "Held.", createdAt: blockedAt,
      evidence: { runId: source.id, originalFailureCode: "adapter_failed", workspaceRestoreFailure: "restore_failed",
        systemRecovery: { ...createSystemRecovery(source.id), state: "complete" } } }).returning();
    const refused = await f.run(task.id, { status: "cancelled", errorCode: "execution_reconciliation_required", startedAt: null,
      retryOfRunId: source.id, finishedAt: new Date(blockedAt.getTime() + 1_000), createdAt: new Date(blockedAt.getTime() - 100), resultJson: {},
      contextSnapshot: { wakeReason: "issue_continuation_needed", retryReason: "issue_continuation_needed" } });
    return { task, source, hold: hold!, refused };
  }

  it("the sweep continues a blocked task whose system retry was refused at claim behind a recovered saved-work hold", async () => {
    resetBacklogContinuationPacingForTests(db);
    const f = await seed();
    const { task, source, hold, refused } = await blockedBehindRefusedRun(f);
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup, scheduleRecoveryRetry: async () => null });

    expect((await recovery.assignedWork.listSuspects({ companyId: f.companyId }, null, 100)).map(row => row.id)).toContain(task.id);
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId: task.id }))
      .toMatchObject({ outcome: "repaired", verdict: { kind: "violation" } });
    const [record] = await continuationsOf(source.id);
    expect(record?.id).toBe(hold.id);
    expect(record?.evidence).toMatchObject({ continuationDelivery: "pending", freshContinuation: { sourceRunId: source.id, trigger: "assigned_work" },
      freshContinuationSettlement: { refusedAtDispatchRunId: refused.id, requestedBy: "system" } });
    expect((await taskRow(task.id)).status).toBe("todo");
    expect(queue.calls).toHaveLength(0);
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId: task.id }))
      .toMatchObject({ outcome: "ok", verdict: { clause: "pending_intent" } });
  }, 60_000);

  it("a continuation the sweep records behind a refused run counts once toward the task's hourly cap", async () => {
    resetBacklogContinuationPacingForTests(db);
    const f = await seed();
    const { task } = await blockedBehindRefusedRun(f);
    for (const minutesAgo of [50, 45, 40, 35, 30]) await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system",
      actorId: "system", action: ASSIGNED_WORK_CONTINUED_ACTION, entityType: "issue", entityId: task.id,
      details: { outcome: "queued" }, createdAt: new Date(Date.now() - minutesAgo * MINUTE) });
    expect(await transientRetryWithinTaskCap(db, f.companyId, task.id, new Date())).toBe(true);
    const sweep = assignedWorkSweep(db, { enqueueWakeup: wakeQueue().enqueueWakeup });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: task.id })).toMatchObject({ outcome: "repaired" });
    const attempts = await taskAutomaticAttempts(db, f.companyId, task.id, new Date());
    expect(attempts.started).toHaveLength(FRESH_CONTINUATIONS_PER_HOUR);
    expect(await transientRetryWithinTaskCap(db, f.companyId, task.id, new Date())).toBe(false);
  }, 60_000);

  it("continuations behind refused runs spend the sweep's per-minute repair budget", async () => {
    resetBacklogContinuationPacingForTests(db);
    const f = await seed();
    const tasks = [];
    for (let index = 0; index < 20; index++) tasks.push((await blockedBehindRefusedRun(f)).task);
    let clock = new Date();
    const sweep = assignedWorkSweep(db, { enqueueWakeup: wakeQueue().enqueueWakeup, now: () => clock });
    const first = [];
    for (const task of tasks) first.push(await sweep.checkIssue({ companyId: f.companyId, issueId: task.id }));
    expect(first.filter(check => check?.outcome === "repaired")).toHaveLength(ASSIGNED_WORK_REPAIRS_PER_MINUTE);
    const deferred = first.filter(check => check?.outcome === "deferred_rate_limit");
    expect(deferred).toHaveLength(20 - ASSIGNED_WORK_REPAIRS_PER_MINUTE);
    expect(deferred.every(check => check!.retryAt!.getTime() > clock.getTime())).toBe(true);
    clock = new Date(clock.getTime() + 66_000);
    const second = [];
    for (const task of tasks) second.push(await sweep.checkIssue({ companyId: f.companyId, issueId: task.id }));
    expect(second.filter(check => check?.outcome === "repaired")).toHaveLength(20 - ASSIGNED_WORK_REPAIRS_PER_MINUTE);
  }, 120_000);

  it("a sweep continuation interrupted right after it was recorded still counts once", async () => {
    resetBacklogContinuationPacingForTests(db);
    const f = await seed();
    const task = await f.task();
    const failed = await f.continued(task.id);
    for (const minutesAgo of [50, 45, 40, 35]) await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system",
      actorId: "system", action: ASSIGNED_WORK_CONTINUED_ACTION, entityType: "issue", entityId: task.id,
      details: { outcome: "queued" }, createdAt: new Date(Date.now() - minutesAgo * MINUTE) });
    const before = (await taskAutomaticAttempts(db, f.companyId, task.id, new Date())).started.length;
    const crashAfterCommit = new Proxy(db, { get(target, property) {
      if (property === "update") return (table: unknown) => {
        if (table === activityLog) throw new Error("server stopped");
        return target.update(table as typeof activityLog);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const sweep = assignedWorkSweep(crashAfterCommit, { enqueueWakeup: wakeQueue().enqueueWakeup });
    await expect(sweep.checkIssue({ companyId: f.companyId, issueId: task.id })).rejects.toThrow("server stopped");
    expect(await continuationsOf(failed.id)).toHaveLength(1);
    const attempts = await taskAutomaticAttempts(db, f.companyId, task.id, new Date());
    expect(attempts.started).toHaveLength(before + 1);
    expect(attempts.started).toHaveLength(5);
    expect(await sharedContinuationAttempts(db, f.companyId, task.id, new Date())).toHaveLength(before + 1);
    expect(await transientRetryWithinTaskCap(db, f.companyId, task.id, new Date())).toBe(true);
  }, 60_000);
});
