import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { ASSIGNED_WORK_CONTINUED_ACTION } from "../services/recovery/assigned-work-sweep.js";
import { FRESH_CONTINUATION_SCHEMA, continueHeldExecutions, resetBacklogContinuationPacingForTests } from "../services/fresh-continuation-fallback.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping failed continuation tests: ${recoveryPostgresSupport.reason}`);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAYTONA_TIMEOUT = "HTTP request timed out after 300000ms waiting for a response. This is a client-side deadline (DaytonaConfig.timeout)";

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
});
