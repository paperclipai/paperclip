import { randomUUID } from "node:crypto";
import { and, eq, sql as sqlTag } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, agentTaskSessions, agentWakeupRequests, approvals, companies, createDb, heartbeatRuns, issueApprovals,
  issueRecoveryActions, issueRelations, issues, issueThreadInteractions, nativeRunFinalizations,
} from "@paperclipai/db";
import { recoveryService } from "../services/recovery/service.js";
import { heartbeatService } from "../services/heartbeat.js";
import { assignedWorkSweep, ASSIGNED_WORK_CONTINUED_ACTION, ASSIGNED_WORK_REPAIRS_PER_MINUTE } from "../services/recovery/assigned-work-sweep.js";
import { CONTINUATION_CAP } from "../services/recovery/assigned-work-invariant.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping assigned-work invariant tests: ${recoveryPostgresSupport.reason}`);

const HOUR = 60 * 60_000;

/**
 * The assigned-work invariant on real rows. Each stranded shape below was
 * measured on staging on 2026-11-12; the existing stranded sweep leaves each
 * of them with nothing pending, and the invariant sweep gives each exactly one
 * ordinary continuation wake.
 */
describePostgres("assigned-work invariant sweep", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("assigned-work-invariant-");
    db = createDb(temporary.connectionString);
  }, 240_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  /** A wake queue stand-in that records each wake as a durable pending row. */
  function wakeQueue() {
    const calls: Array<{ agentId: string; issueId: string; source: unknown }> = [];
    const enqueueWakeup = vi.fn(async (agentId: string, opts?: { payload?: Record<string, unknown> | null; contextSnapshot?: Record<string, unknown>; reason?: string | null }) => {
      const issueId = String(opts?.payload?.issueId);
      const [issue] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId));
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: issue.companyId, agentId, source: "automation",
        triggerDetail: "system", reason: opts?.reason ?? null, payload: opts?.payload ?? null, status: "queued" }).returning();
      calls.push({ agentId, issueId, source: opts?.contextSnapshot?.source });
      return { id: wake.id } as never;
    });
    return { calls, enqueueWakeup };
  }

  async function seedCompany() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Invariant fixture", issuePrefix: `I${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Builder", adapterType: "codex_local", status: "idle", adapterConfig: {} });
    let number = 0;
    async function issue(values: Partial<typeof issues.$inferInsert> = {}) {
      const id = randomUUID();
      number += 1;
      await db.insert(issues).values({ id, companyId, title: `Task ${number}`, status: "in_progress", assigneeAgentId: agentId,
        issueNumber: number, identifier: `I${companyId.slice(0, 7)}-${number}`, updatedAt: new Date(Date.now() - 3 * HOUR),
        createdAt: new Date(Date.now() - 5 * HOUR), ...values });
      return id;
    }
    async function run(issueId: string, values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "on_demand", status: "interrupted",
        errorCode: "server_shutdown_interrupted", startedAt: new Date(Date.now() - 4 * HOUR), finishedAt: new Date(Date.now() - 3 * HOUR),
        livenessState: "needs_followup", contextSnapshot: { issueId, taskId: issueId }, createdAt: new Date(Date.now() - 4 * HOUR),
        ...values }).returning();
      return row;
    }
    return { companyId, agentId, issue, run };
  }

  it("a deploy-interrupted in_progress task with nothing pending gets exactly one continuation; the stranded sweep leaves it", async () => {
    const f = await seedCompany();
    const issueId = await f.issue();
    // The staging run: a person's Retry, stopped by a deploy's shutdown during
    // setup, certified as no provider work, its hold already resolved.
    await f.run(issueId, { resultJson: { stopReason: "interrupted", workspaceRestoreFailure: "restore_failed",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId, taskId: issueId, explicitUserContinuation: { previousRunId: randomUUID() } } });
    const queue = wakeQueue();
    // Production wiring: the bounded retry scheduler declines (not_scheduled).
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup, scheduleRecoveryRetry: async () => null });

    await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId, skipRelatedRecovery: true });
    expect(queue.calls).toHaveLength(0);
    const [stillStranded] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(stillStranded.status).toBe("in_progress");

    const check = await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId });
    // What staging shows for this shape: a Retry button that only the system can act on.
    expect(check).toMatchObject({ outcome: "repaired", verdict: { kind: "violation", reason: "retry_offered" } });
    expect(queue.calls).toEqual([{ agentId: f.agentId, issueId, source: "issue.assigned_work_invariant" }]);
    const [activity] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId),
      eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION)));
    expect(activity.details).toMatchObject({ message: expect.stringContaining("Continued automatically") });
    expect(String(activity.details?.message)).not.toMatch(/_|[0-9a-f]{8}-/);

    // The next sweep sees the pending wake and leaves the task alone.
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId }))
      .toMatchObject({ outcome: "ok", verdict: { clause: "pending_intent", intent: "queued_wake" } });
    expect(queue.calls).toHaveLength(1);
  }, 60_000);

  it("a wake deferred behind a run that ended long ago is not a pending path; a fresh one still is", async () => {
    const f = await seedCompany();
    const issueId = await f.issue();
    await f.run(issueId, { status: "failed", errorCode: "native_restart_recovery_blocked" });
    const deferred = (createdAt: Date) => db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "local-board", payload: { issueId }, createdAt, updatedAt: new Date() });
    await deferred(new Date(Date.now() - 30 * 60_000));
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup, scheduleRecoveryRetry: async () => null });
    expect((await recovery.assignedWork.listSuspects({ companyId: f.companyId }, null, 50)).map(row => row.id)).toContain(issueId);
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId }))
      .toMatchObject({ outcome: "repaired", verdict: { kind: "violation", reason: "no_pending_path" } });

    const freshIssue = await f.issue();
    await f.run(freshIssue, { status: "failed", errorCode: "native_restart_recovery_blocked" });
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      triggerDetail: "system", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      payload: { issueId: freshIssue }, createdAt: new Date(Date.now() - 60_000) });
    expect((await recovery.assignedWork.listSuspects({ companyId: f.companyId }, null, 50)).map(row => row.id)).not.toContain(freshIssue);
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId: freshIssue }))
      .toMatchObject({ outcome: "ok", verdict: { clause: "pending_intent", intent: "queued_wake" } });
  }, 60_000);

  it("a wake claimed long ago that never became a run is not a pending path", async () => {
    const f = await seedCompany();
    const issueId = await f.issue();
    await f.run(issueId, { status: "succeeded", errorCode: null, livenessState: null });
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      triggerDetail: "system", reason: "issue_children_completed", status: "claimed", payload: { issueId },
      claimedAt: new Date(Date.now() - 15 * 60_000), createdAt: new Date(Date.now() - 40 * 60_000) });
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup, scheduleRecoveryRetry: async () => null });
    expect((await recovery.assignedWork.listSuspects({ companyId: f.companyId }, null, 50)).map(row => row.id)).toContain(issueId);
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId }))
      .toMatchObject({ verdict: { kind: "violation", reason: "no_pending_path" } });
  }, 60_000);

  it("an in_progress task whose native run failed needing reconciliation (silently skipped today) gets one continuation", async () => {
    const f = await seedCompany();
    const issueId = await f.issue();
    await f.run(issueId, { runtimeMode: "native", status: "failed", errorCode: "native_continuation_requires_reconciliation",
      livenessState: "failed" });
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup, scheduleRecoveryRetry: async () => null });
    await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId, skipRelatedRecovery: true });
    expect(queue.calls).toHaveLength(0);
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId })).toMatchObject({ outcome: "repaired" });
    expect(queue.calls).toHaveLength(1);
  }, 60_000);

  it("a task blocked after a legacy run's retries ran out, with no hold left, is restored and continued once", async () => {
    // The shape the fresh-continuation fallback does not cover: retries spent
    // on a restart-caused failure (controller lease lost), block written by
    // the stranded sweep, and the hold already resolved.
    const f = await seedCompany();
    const blockedAt = new Date(Date.now() - 2 * HOUR);
    const issueId = await f.issue({ status: "blocked", blockedTransitionAt: blockedAt });
    const run = await f.run(issueId, { status: "failed", errorCode: "controller_lease_lost", livenessState: "failed" });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: issueId, kind: "stranded_assigned_issue",
      status: "resolved", outcome: "blocked", ownerType: "board", cause: "stranded_assigned_issue",
      fingerprint: `source_scoped_recovery:${f.companyId}:${issueId}:stranded_assigned_issue`,
      evidence: { previousStatus: "in_progress", latestRunId: run.id, latestRunErrorCode: "controller_lease_lost" },
      nextAction: "Inspect the retry history.", attemptCount: 3, resolvedAt: blockedAt });
    await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "system", action: "issue.updated",
      entityType: "issue", entityId: issueId, details: { status: "blocked", previousStatus: "in_progress",
        source: "recovery.reconcile_stranded_assigned_issue" }, createdAt: blockedAt });
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup });

    expect((await recovery.assignedWork.listSuspects({ companyId: f.companyId }, null, 100)).map(row => row.id)).toContain(issueId);
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId }))
      .toMatchObject({ outcome: "repaired", verdict: { reason: "recovery_block" } });
    expect(queue.calls).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("in_progress");
  }, 60_000);

  it("leaves a task blocked under an active recovery hold to the hold's owner and reports it", async () => {
    const f = await seedCompany();
    const issueId = await f.issue({ status: "blocked", blockedTransitionAt: new Date(Date.now() - 2 * HOUR) });
    const run = await f.run(issueId, { status: "failed", errorCode: "process_lost", livenessState: "failed" });
    // Old-shaped row: a board-owned stranded action written by an older release.
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: issueId, kind: "stranded_assigned_issue",
      status: "active", ownerType: "board", cause: "stranded_assigned_issue", fingerprint: `source_scoped_recovery:${f.companyId}:${issueId}:stranded_assigned_issue`,
      evidence: { previousStatus: "in_progress", latestRunId: run.id, latestRunErrorCode: "process_lost" },
      nextAction: "Board operator: inspect the retry history, then explicitly retry the original owner, reassign, or intentionally resolve the task.",
      attemptCount: 1 });
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup });
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId }))
      .toMatchObject({ outcome: "left_to_hold_owner", verdict: { kind: "violation", reason: "recovery_block" } });
    expect(queue.calls).toHaveLength(0);
    expect((await recovery.assignedWork.listSuspects({ companyId: f.companyId }, null, 100)).map(row => row.id)).not.toContain(issueId);
    expect(await recovery.assignedWork.report(f.companyId)).toMatchObject({ violationCount: 1, heldByRecoveryOwner: 1 });
  }, 60_000);

  it("Retry-started tasks the scheduler refused to revalidate get one continuation, even with a question asked before the Retry", async () => {
    // Nine staging tasks: a person's Retry, stopped by a deploy during setup,
    // certified as no provider work; the scheduler then refused with
    // continuation_user_authorization_missing on every sweep. One of them
    // also had a question the agent asked before the person pressed Retry.
    const f = await seedCompany();
    const plain = await f.issue();
    const withQuestion = await f.issue();
    for (const issueId of [plain, withQuestion]) {
      await f.run(issueId, { resultJson: { stopReason: "interrupted", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
        contextSnapshot: { issueId, taskId: issueId, explicitUserContinuation: { previousRunId: randomUUID() } },
        createdAt: new Date(Date.now() - 4 * HOUR) });
    }
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: withQuestion, kind: "ask_user_questions",
      status: "pending", continuationPolicy: "wake_assignee", payload: {}, createdAt: new Date(Date.now() - 12 * HOUR) } as never);
    const queue = wakeQueue();
    // On staging the refusal also left the sweep's escalation without effect
    // (its stale-snapshot guard): the tasks stayed in_progress with nothing
    // pending. Model that by changing the task under the sweep's snapshot.
    const scheduleRecoveryRetry = vi.fn(async (runId: string, outcome?: { continuationRefused?: boolean }) => {
      if (outcome) outcome.continuationRefused = true;
      const [run] = await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      await db.update(issues).set({ updatedAt: new Date(Date.now() - 2 * HOUR) }).where(eq(issues.id, String(run.context?.issueId)));
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup, scheduleRecoveryRetry });
    await recovery.reconcileStrandedAssignedIssues({ companyId: f.companyId, skipRelatedRecovery: true });
    expect(queue.calls).toHaveLength(0);

    for (const issueId of [plain, withQuestion]) {
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("in_progress");
      expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId }))
        .toMatchObject({ outcome: "repaired", verdict: { reason: "retry_offered" } });
    }
    expect(queue.calls.map(call => call.issueId).sort()).toEqual([plain, withQuestion].sort());
  }, 60_000);

  it("an unknown block reason is repaired, not treated as a reason to wait", async () => {
    const f = await seedCompany();
    const issueId = await f.issue({ status: "blocked", blockedTransitionAt: new Date(Date.now() - HOUR) });
    await f.run(issueId, { status: "failed", errorCode: "something_new", livenessState: "failed" });
    const queue = wakeQueue();
    const recovery = recoveryService(db, { enqueueWakeup: queue.enqueueWakeup });
    expect(await recovery.assignedWork.checkIssue({ companyId: f.companyId, issueId }))
      .toMatchObject({ outcome: "repaired", verdict: { reason: "unknown_block" } });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("todo");
    expect(queue.calls).toHaveLength(1);
  }, 60_000);

  it("two servers sweeping the same violation at once create one wake", async () => {
    const f = await seedCompany();
    const issueId = await f.issue();
    await f.run(issueId);
    const queue = wakeQueue();
    const serverA = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup });
    const serverB = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup });
    const results = await Promise.all([serverA.checkIssue({ companyId: f.companyId, issueId }), serverB.checkIssue({ companyId: f.companyId, issueId })]);
    expect(queue.calls).toHaveLength(1);
    expect(results.map(result => result?.outcome).sort()).toEqual(["repaired", expect.stringMatching(/changed|deferred_rate_limit/)].sort());
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION))))
      .toHaveLength(1);
  }, 60_000);

  it("leaves a run owned by another live server alone, and settles one whose owner is proven gone", async () => {
    const f = await seedCompany();
    const otherBoot = randomUUID();
    const controllerProcess = { bootId: otherBoot, pid: 4242, hostHash: "host-b", processStartedAt: new Date(Date.now() - HOUR).toISOString() };
    // Deploy overlap: the other server holds the lease.
    const leased = await f.issue();
    await f.run(leased, { status: "running", errorCode: null, finishedAt: null, controllerBootId: otherBoot, controllerProcess,
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000) });
    // Lease lapsed, but the owner proof says its server is still alive.
    const lapsedAlive = await f.issue();
    await f.run(lapsedAlive, { status: "running", errorCode: null, finishedAt: null, controllerBootId: otherBoot, controllerProcess,
      controllerLeaseExpiresAt: new Date(Date.now() - 60_000) });
    const queue = wakeQueue();
    const alive = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup,
      proveOwner: async () => ({ verdict: "alive", reason: "controller_lease_held" }) });
    expect(await alive.checkIssue({ companyId: f.companyId, issueId: leased })).toMatchObject({ verdict: { clause: "live_run" } });
    expect(await alive.checkIssue({ companyId: f.companyId, issueId: lapsedAlive })).toMatchObject({ verdict: { clause: "live_run" } });
    expect(queue.calls).toHaveLength(0);

    const settle = vi.fn(async () => undefined);
    const gone = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup, settleLostRunProcess: settle,
      proveOwner: async () => ({ verdict: "gone", reason: "controller_stopped" }) });
    expect(await gone.checkIssue({ companyId: f.companyId, issueId: leased })).toMatchObject({ verdict: { clause: "live_run" } });
    const goneCheck = await gone.checkIssue({ companyId: f.companyId, issueId: lapsedAlive });
    expect(goneCheck)
      .toMatchObject({ outcome: "settled_lost_run", verdict: { reason: "run_owner_gone" } });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(queue.calls).toHaveLength(0);
  }, 60_000);

  it("leaves tasks waiting on an approval, a question, a dependency or a declared unblock action", async () => {
    const f = await seedCompany();
    const approvalTask = await f.issue();
    const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "plan", status: "pending", payload: {} } as never).returning();
    await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: approvalTask, approvalId: approval.id } as never);
    const questionTask = await f.issue({ status: "blocked", blockedTransitionAt: new Date(Date.now() - HOUR) });
    await f.run(questionTask, { runtimeMode: "native", status: "failed", errorCode: "native_continuation_requires_reconciliation" });
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: questionTask, kind: "request_confirmation",
      status: "pending", continuationPolicy: "wake_assignee", payload: {} } as never);
    const dependent = await f.issue({ status: "blocked", blockedTransitionAt: new Date(Date.now() - HOUR) });
    const blocker = await f.issue({ status: "todo", assigneeAgentId: null });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker, relatedIssueId: dependent, type: "blocks" } as never);
    const declared = await f.issue({ status: "blocked", blockedTransitionAt: new Date(Date.now() - HOUR),
      unblockDescriptor: { owner: "board", action: "Share the deploy key for the staging project." } });

    const queue = wakeQueue();
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: approvalTask })).toMatchObject({ verdict: { reason: "approval" } });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: questionTask })).toMatchObject({ verdict: { reason: "question" } });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: dependent })).toMatchObject({ verdict: { reason: "dependency" } });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: declared })).toMatchObject({ verdict: { reason: "assignee_declared_block" } });
    expect(queue.calls).toHaveLength(0);
    // The indexed pre-filter leaves all four out of the sweep entirely.
    const suspects = await sweep.listSuspects({ companyId: f.companyId }, null, 100);
    expect(suspects.map(row => row.id)).not.toEqual(expect.arrayContaining([approvalTask]));
    for (const id of [approvalTask, questionTask, dependent, declared]) expect(suspects.map(row => row.id)).not.toContain(id);
  }, 60_000);

  it("a refused or later-declined continuation stays a violation, says so, and is tried again under the cap", async () => {
    const f = await seedCompany();
    const issueId = await f.issue();
    await f.run(issueId);
    let admit = false;
    const enqueueWakeup = vi.fn(async (agentId: string, opts?: { payload?: Record<string, unknown> | null; reason?: string | null }) => {
      if (!admit) return null;
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId, source: "automation",
        triggerDetail: "system", reason: opts?.reason ?? null, payload: opts?.payload ?? null, status: "queued" }).returning();
      return { id: wake.id } as never;
    });
    let clock = new Date();
    const sweep = assignedWorkSweep(db, { enqueueWakeup, now: () => clock });
    const deadlines: number[] = [];
    // Admission refuses: the entry says nothing started, and a re-check is due.
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId, onDeferredDeadline: at => deadlines.push(at) }))
      .toMatchObject({ outcome: "enqueue_refused" });
    const activity = async () => db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId),
      eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION)));
    expect((await activity())[0].details).toMatchObject({ outcome: "not_started", message: expect.stringContaining("could not start") });
    expect(deadlines).toHaveLength(1);
    // Too soon: spaced, not repaired and not reported as fine.
    clock = new Date(clock.getTime() + 60_000);
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId })).toMatchObject({ outcome: "deferred_rate_limit", verdict: { kind: "violation" } });
    // After the spacing it is admitted; the queue later declines the claim
    // (for example behind the old run's pending cleanup) and the wake is skipped.
    admit = true;
    clock = new Date(clock.getTime() + 2 * 60_000);
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId })).toMatchObject({ outcome: "repaired" });
    expect((await activity()).map(row => row.details?.outcome).sort()).toEqual(["not_started", "queued"]);
    await db.update(agentWakeupRequests).set({ status: "skipped" }).where(eq(agentWakeupRequests.companyId, f.companyId));
    clock = new Date(clock.getTime() + 5 * 60_000);
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId })).toMatchObject({ outcome: "repaired" });
    expect(enqueueWakeup).toHaveBeenCalledTimes(3);
  }, 60_000);

  it("with the real wake queue, a hold reached by the sweep's wake becomes one pending fresh continuation", async () => {
    // The task's last run left a legacy reconciliation hold. The sweep's
    // ordinary continuation wake reaches the fresh-continuation fallback,
    // which settles the hold and records one pending continuation (owned by
    // the execution-continuation worker). The next sweep adds no attempt.
    const f = await seedCompany();
    const issueId = await f.issue();
    const run = await f.run(issueId, { status: "failed", errorCode: "process_lost", livenessState: "failed" });
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${run.id}`,
      evidence: { runId: run.id, originalFailureCode: "process_lost" }, nextAction: "Reconcile the stopped run.", attemptCount: 1 });
    const heartbeat = heartbeatService(db);
    try {
      const first = await heartbeat.checkAssignedWorkInvariant({ companyId: f.companyId, issueId });
      expect(first).toMatchObject({ outcome: "enqueue_refused", verdict: { kind: "violation" } });
      const queued = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sqlTag`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`));
      expect(queued).toHaveLength(0);
      const pending = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
        sqlTag`${agentWakeupRequests.status} in ('queued', 'deferred_issue_execution', 'claimed')`));
      expect(pending).toHaveLength(0);
      const [entry] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId),
        eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION)));
      expect(entry.details).toMatchObject({ outcome: "not_started" });
      const [record] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, issueId),
        sqlTag`${issueRecoveryActions.evidence}->'freshContinuation' is not null`));
      expect(record!.evidence).toMatchObject({ continuationDelivery: "pending" });
      // A second sweep right away adds no attempt.
      expect(await heartbeat.checkAssignedWorkInvariant({ companyId: f.companyId, issueId }))
        .not.toMatchObject({ outcome: "repaired" });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId),
        eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION)))).toHaveLength(1);
    } finally {
      await heartbeat.drainActiveRunExecutions();
    }
  }, 120_000);

  it("routine touches on a stranded task (a comment, a read, a label) do not postpone its repair", async () => {
    const f = await seedCompany();
    const issueId = await f.issue();
    await f.run(issueId);
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issueId));
    const queue = wakeQueue();
    expect(await assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup }).checkIssue({ companyId: f.companyId, issueId }))
      .toMatchObject({ outcome: "repaired" });
    expect(queue.calls).toHaveLength(1);
  }, 60_000);

  it("restores a block made through the normal update route to its recorded status, and a review block back to review without a wake", async () => {
    const f = await seedCompany();
    const queue = wakeQueue();
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup });
    const blockedAt = new Date(Date.now() - 2 * HOUR);
    const cases = [["in_progress", "in_progress", 1], ["in_review", "in_review", 0]] as const;
    for (const [before, expected, wakes] of cases) {
      const issueId = await f.issue({ status: "blocked", blockedTransitionAt: blockedAt });
      await f.run(issueId, { status: "failed", errorCode: "process_lost", livenessState: "failed" });
      // The shape the normal issue update route writes.
      await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "system", action: "issue.updated",
        entityType: "issue", entityId: issueId, details: { status: "blocked", _previous: { status: before } }, createdAt: blockedAt });
      const callsBefore = queue.calls.length;
      expect(await sweep.checkIssue({ companyId: f.companyId, issueId })).toMatchObject({ outcome: "repaired" });
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe(expected);
      expect(queue.calls.length - callsBefore).toBe(wakes);
    }
  }, 60_000);

  it("puts a lifted block back when admission refuses the continuation", async () => {
    const f = await seedCompany();
    const blockedAt = new Date(Date.now() - 2 * HOUR);
    const issueId = await f.issue({ status: "blocked", blockedTransitionAt: blockedAt });
    await f.run(issueId, { status: "failed", errorCode: "controller_lease_lost", livenessState: "failed" });
    const notifiedAt = new Date(Date.now() - HOUR);
    const descriptor = { owner: { agentId: f.agentId }, action: "Retry the build once the cache is warm." };
    await db.update(issues).set({ unblockDescriptor: descriptor as never, blockedOwnerNotifiedAt: notifiedAt }).where(eq(issues.id, issueId));
    const sweep = assignedWorkSweep(db, { enqueueWakeup: async () => null });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId })).toMatchObject({ outcome: "enqueue_refused" });
    const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(after.status).toBe("blocked");
    expect(after.blockedTransitionAt?.getTime()).toBe(blockedAt.getTime());
    expect(after.unblockDescriptor).toEqual(descriptor);
    expect(after.blockedOwnerNotifiedAt?.getTime()).toBe(notifiedAt.getTime());
  }, 60_000);

  it("re-runs the predicate under the row lock: a question asked after the first read stops the repair", async () => {
    const f = await seedCompany();
    const issueId = await f.issue();
    await f.run(issueId);
    const queue = wakeQueue();
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup });
    // The first read sees a violation; the person's question lands just before
    // the claim's transaction takes the row lock.
    const original = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce((async (work: never, config?: never) => {
      await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId, kind: "ask_user_questions",
        status: "pending", continuationPolicy: "wake_assignee", payload: {} } as never);
      return original(work, config);
    }) as never);
    try {
      expect(await sweep.checkIssue({ companyId: f.companyId, issueId })).toMatchObject({ outcome: "changed", verdict: { kind: "violation" } });
    } finally { spy.mockRestore(); }
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, issueId),
      eq(activityLog.action, ASSIGNED_WORK_CONTINUED_ACTION)))).toHaveLength(0);
    expect(queue.calls).toHaveLength(0);
  }, 60_000);

  it("reports only tasks the caller may read; the sweep still evaluates private tasks", async () => {
    const f = await seedCompany();
    const open = await f.issue();
    await f.run(open);
    const hidden = await f.issue();
    await f.run(hidden);
    const queue = wakeQueue();
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup });
    // A caller whose read condition excludes the private task.
    const report = await sweep.report(f.companyId, { readCondition: sqlTag<boolean>`${issues.id} <> ${hidden}` });
    expect(report).toMatchObject({ checked: 1, violationCount: 1 });
    expect(report.sample.map(row => row.identifier)).not.toContain((await db.select().from(issues).where(eq(issues.id, hidden)))[0].identifier);
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: hidden })).toMatchObject({ outcome: "repaired" });
  }, 60_000);

  it("completes a claim on a one-connection pool: the locked re-check reads through the transaction", async () => {
    const single = createDb(temporary.connectionString, { maxConnections: 1 });
    try {
      const f = await seedCompany();
      const issueId = await f.issue({ status: "blocked", blockedTransitionAt: new Date(Date.now() - 2 * HOUR) });
      await f.run(issueId, { status: "failed", errorCode: "controller_lease_lost", livenessState: "failed" });
      const queue = wakeQueue();
      const sweep = assignedWorkSweep(single, { enqueueWakeup: queue.enqueueWakeup });
      const result = await Promise.race([sweep.checkIssue({ companyId: f.companyId, issueId }),
        new Promise(resolve => setTimeout(() => resolve("deadlocked"), 20_000))]);
      expect(result).toMatchObject({ outcome: "repaired" });
      expect(queue.calls).toHaveLength(1);
    } finally { await single.$client.end({ timeout: 0 }); }
  }, 60_000);

  it("says when the report is capped, and that the violation count is then a lower bound", async () => {
    const f = await seedCompany();
    const issueId = await f.issue();
    await f.run(issueId);
    const report = await assignedWorkSweep(db, { enqueueWakeup: wakeQueue().enqueueWakeup }).report(f.companyId);
    expect(report).toMatchObject({ checked: 1, openTasks: 1, truncated: false, violationCountIsLowerBound: false, violationCount: 1 });
  }, 60_000);

  it("a running run whose owner is proven gone is settled first, then the task gets its continuation within the bound", async () => {
    const f = await seedCompany();
    const issueId = await f.issue();
    const otherBoot = randomUUID();
    const run = await f.run(issueId, { status: "running", errorCode: null, finishedAt: null, controllerBootId: otherBoot,
      controllerProcess: { bootId: otherBoot, pid: 4242, hostHash: "host-b", processStartedAt: new Date(Date.now() - HOUR).toISOString() },
      controllerLeaseExpiresAt: new Date(Date.now() - 60_000) });
    const queue = wakeQueue();
    // Heartbeat's lost-process settle path ends the run, as it does in production.
    const settle = vi.fn(async ({ runId }: { runId: string }) => {
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "process_lost", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    });
    let clock = new Date();
    const started = clock.getTime();
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup, settleLostRunProcess: settle,
      proveOwner: async () => ({ verdict: "gone", reason: "controller_stopped" }), now: () => clock });
    const deadlines: number[] = [];
    const pass = () => sweep.checkIssue({ companyId: f.companyId, issueId, onDeferredDeadline: at => deadlines.push(at) });
    // Pass 1: the owner is proven gone outside any lock; the run goes to the settle path, no claim is tried.
    expect(await pass()).toMatchObject({ outcome: "settled_lost_run", verdict: { reason: "run_owner_gone", runId: run.id } });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(queue.calls).toHaveLength(0);
    // Pass 2 at its deadline: the run has ended and the task is repaired.
    clock = new Date(deadlines.at(-1)! + 1_000);
    expect(await pass()).toMatchObject({ outcome: "repaired" });
    expect(queue.calls).toHaveLength(1);
    expect(clock.getTime() - started).toBeLessThan(5 * 60_000);
  }, 60_000);

  it("does not count a native run left running in awaiting evidence with no renewal as live, and reports it with its agent's held slot", async () => {
    // The graceful hand-off repro: the new server's startup recovery parked
    // the run in awaiting evidence; nothing renews or settles it.
    const f = await seedCompany();
    const stuck = await f.issue();
    const stuckRun = await f.run(stuck, { runtimeMode: "native", status: "running", errorCode: null, finishedAt: null, nativeIssueId: stuck });
    const old = new Date(Date.now() - 10 * 60_000);
    await db.insert(nativeRunFinalizations).values({ runId: stuckRun.id, companyId: f.companyId, issueId: stuck, phase: "observed",
      recoveryState: "awaiting_evidence", leaseExpiresAt: old, updatedAt: old });
    // A recent claim is still a live path.
    const fresh = await f.issue();
    const freshRun = await f.run(fresh, { runtimeMode: "native", status: "running", errorCode: null, finishedAt: null, nativeIssueId: fresh });
    await db.insert(nativeRunFinalizations).values({ runId: freshRun.id, companyId: f.companyId, issueId: fresh, phase: "observed",
      recoveryState: "awaiting_evidence", leaseExpiresAt: new Date(Date.now() + 60_000) });
    // Queued work for the same agent that cannot dispatch behind the held slot.
    const waiting = await f.issue({ status: "todo" });
    await f.run(waiting, { status: "queued", errorCode: null, finishedAt: null, startedAt: null });
    const queue = wakeQueue();
    const settle = vi.fn(async () => undefined);
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup, settleLostRunProcess: settle });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: stuck }))
      .toMatchObject({ outcome: "left_to_native_recovery", verdict: { kind: "violation", reason: "native_run_stalled", runId: stuckRun.id } });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: fresh })).toMatchObject({ verdict: { clause: "live_run" } });
    expect(queue.calls).toHaveLength(0);
    expect(settle).not.toHaveBeenCalled();
    const report = await sweep.report(f.companyId);
    expect(report.violations).toMatchObject({ native_run_stalled: 1 });
    expect(report.agentsWithStalledSlots).toEqual([{ agentName: "Builder", stalledRuns: 1, queuedRuns: 1 }]);
    // A caller who cannot read those tasks sees none of their runs counted.
    const hiddenIds = [stuck, waiting];
    const filtered = await sweep.report(f.companyId, { readCondition: sqlTag<boolean>`${issues.id} not in (${sqlTag.join(hiddenIds.map(id => sqlTag`${id}::uuid`), sqlTag`, `)})` });
    expect(filtered.violations.native_run_stalled ?? 0).toBe(0);
    expect(filtered.agentsWithStalledSlots).toEqual([]);
  }, 60_000);

  it("stops scheduling a task once it leaves eligibility", async () => {
    const f = await seedCompany();
    const done = await f.issue();
    await f.run(done);
    for (let index = 0; index < CONTINUATION_CAP; index++) {
      await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "system", action: ASSIGNED_WORK_CONTINUED_ACTION,
        entityType: "issue", entityId: done, details: {}, createdAt: new Date(Date.now() - (index + 1) * 8 * 60_000) });
    }
    const queue = wakeQueue();
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup });
    const deadlines: number[] = [];
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: done, onDeferredDeadline: at => deadlines.push(at) }))
      .toMatchObject({ outcome: "deferred_cap" });
    expect(deadlines).toHaveLength(1);
    for (const change of [{ status: "done" }, { status: "cancelled" }, { assigneeAgentId: null, assigneeUserId: "person-1" }] as const) {
      await db.update(issues).set({ status: "in_progress", assigneeAgentId: f.agentId, assigneeUserId: null, ...change }).where(eq(issues.id, done));
      expect(await sweep.checkIssue({ companyId: f.companyId, issueId: done, onDeferredDeadline: at => deadlines.push(at) })).toBeNull();
      expect((await sweep.listSuspects({ companyId: f.companyId }, null, 100)).map(row => row.id)).not.toContain(done);
    }
    expect(deadlines).toHaveLength(1);
    expect(queue.calls).toHaveLength(0);
  }, 60_000);

  it("treats a stopped or blocked session goal as the person's move and only a running goal as pending", async () => {
    const f = await seedCompany();
    const sweep = assignedWorkSweep(db, { enqueueWakeup: wakeQueue().enqueueWakeup });
    const cases = [
      { goalStatus: "active", goalDesiredState: "active", expected: { clause: "pending_intent", intent: "session_goal" } },
      { goalStatus: "blocked", goalDesiredState: "paused", expected: { clause: "waiting", reason: "user_stop" } },
      { goalStatus: "active", goalDesiredState: "paused", expected: { clause: "waiting", reason: "user_stop" } },
    ];
    for (const entry of cases) {
      const issueId = await f.issue();
      await f.run(issueId);
      await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agentId, adapterType: "codex_local", taskKey: issueId,
        goalStatus: entry.goalStatus, goalDesiredState: entry.goalDesiredState } as never);
      expect(await sweep.checkIssue({ companyId: f.companyId, issueId })).toMatchObject({ outcome: "ok", verdict: entry.expected });
    }
  }, 60_000);

  it("leaves a task whose run ended seconds ago, and asks to look again after the grace", async () => {
    const f = await seedCompany();
    const issueId = await f.issue();
    const finishedAt = new Date(Date.now() - 2_000);
    await f.run(issueId, { status: "failed", errorCode: "process_lost", finishedAt });
    const queue = wakeQueue();
    const deadlines: number[] = [];
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId, onDeferredDeadline: at => deadlines.push(at) }))
      .toMatchObject({ outcome: "settling" });
    expect(queue.calls).toHaveLength(0);
    expect(deadlines).toEqual([finishedAt.getTime() + 90_000]);
  }, 60_000);

  it("honours the per-task cap and the per-process repair budget; never charges the failure allowance", async () => {
    const f = await seedCompany();
    const capped = await f.issue();
    await f.run(capped);
    for (let index = 0; index < CONTINUATION_CAP; index++) {
      await db.insert(activityLog).values({ companyId: f.companyId, actorType: "system", actorId: "system", action: ASSIGNED_WORK_CONTINUED_ACTION,
        entityType: "issue", entityId: capped, details: {}, createdAt: new Date(Date.now() - (index + 1) * 8 * 60_000) });
    }
    const queue = wakeQueue();
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup });
    const deadlines: number[] = [];
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: capped, onDeferredDeadline: at => deadlines.push(at) }))
      .toMatchObject({ outcome: "deferred_cap" });
    expect(queue.calls).toHaveLength(0);
    expect(deadlines[0]).toBeGreaterThan(Date.now());
    // The task stays as it was: never blocked for a person.
    expect((await db.select().from(issues).where(eq(issues.id, capped)))[0].status).toBe("in_progress");

    const many = [];
    for (let index = 0; index < ASSIGNED_WORK_REPAIRS_PER_MINUTE + 2; index++) {
      const id = await f.issue();
      await f.run(id);
      many.push(id);
    }
    const outcomes = [];
    for (const id of many) outcomes.push((await sweep.checkIssue({ companyId: f.companyId, issueId: id }))?.outcome);
    expect(outcomes.filter(outcome => outcome === "repaired")).toHaveLength(ASSIGNED_WORK_REPAIRS_PER_MINUTE);
    expect(outcomes.filter(outcome => outcome === "deferred_rate_limit")).toHaveLength(2);
    // Plain wakes: no retry-of link, so no failure-budget accounting.
    const wake = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wake.every(row => !("retryOfRunId" in (row.payload ?? {})))).toBe(true);
  }, 120_000);

  it("evaluates old-shaped rows: native awaiting reattach, a running run saved without its controller process, and stale blocks", async () => {
    const f = await seedCompany();
    const reattach = await f.issue();
    const native = await f.run(reattach, { runtimeMode: "native", status: "failed", errorCode: "native_session_interrupted",
      nativeIssueId: reattach });
    await db.insert(nativeRunFinalizations).values({ runId: native.id, companyId: f.companyId, issueId: reattach, phase: "observed",
      recoveryState: "awaiting_runner_reattach" });
    const retryable = await f.issue();
    const failedNative = await f.run(retryable, { runtimeMode: "native", status: "failed", errorCode: "saved_native_failure", nativeIssueId: retryable });
    await db.insert(nativeRunFinalizations).values({ runId: failedNative.id, companyId: f.companyId, issueId: retryable,
      phase: "retryable_failure", nextAttemptAt: new Date(Date.now() - 1_000) });
    const unstamped = await f.issue();
    await f.run(unstamped, { status: "running", errorCode: null, finishedAt: null, controllerBootId: randomUUID(), controllerProcess: null,
      controllerLeaseExpiresAt: new Date(Date.now() - HOUR) });
    const stale = await f.issue({ status: "blocked", blockedTransitionAt: new Date(Date.now() - 8 * 24 * HOUR) });
    await f.run(stale, { status: "failed", errorCode: "process_lost", finishedAt: new Date(Date.now() - 8 * 24 * HOUR) });
    const queue = wakeQueue();
    const settle = vi.fn(async () => undefined);
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup, settleLostRunProcess: settle,
      proveOwner: async () => ({ verdict: "gone", reason: "pid_dead" }) });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: reattach })).toMatchObject({ verdict: { intent: "native_recovery" } });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: retryable })).toMatchObject({ verdict: { intent: "native_recovery" } });
    // No recorded controller process: the owner is unprovable, so it stays live.
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: unstamped })).toMatchObject({ verdict: { clause: "live_run" } });
    expect(await sweep.checkIssue({ companyId: f.companyId, issueId: stale })).toMatchObject({ outcome: "stale_reported" });
    expect(queue.calls).toHaveLength(0);
    expect(settle).not.toHaveBeenCalled();
    expect((await sweep.listSuspects({ companyId: f.companyId }, null, 100)).map(row => row.id)).not.toContain(stale);
    const report = await sweep.report(f.companyId);
    expect(report).toMatchObject({ staleBlocked: 1, violationCount: 0 });
  }, 60_000);

  it("stays cheap at staging size: 800 open tasks and a week of runs at 2,000 a day", async () => {
    const f = await seedCompany();
    const issueRows = Array.from({ length: 800 }, (_, index) => ({ id: randomUUID(), companyId: f.companyId, title: `Load ${index}`,
      status: index % 3 === 0 ? "blocked" : index % 3 === 1 ? "in_progress" : "todo", assigneeAgentId: f.agentId,
      issueNumber: 10_000 + index, identifier: `L${f.companyId.slice(0, 6)}-${index}`,
      blockedTransitionAt: index % 3 === 0 ? new Date(Date.now() - (index % 10) * 24 * HOUR) : null,
      updatedAt: new Date(Date.now() - index * 60_000) }));
    for (let index = 0; index < issueRows.length; index += 200) await db.insert(issues).values(issueRows.slice(index, index + 200));
    const runs = Array.from({ length: 14_000 }, (_, index) => {
      const issueId = issueRows[index % issueRows.length].id;
      const at = new Date(Date.now() - (index / 14_000) * 7 * 24 * HOUR);
      return { companyId: f.companyId, agentId: f.agentId, invocationSource: "automation", status: index < 40 ? "running" : "succeeded",
        startedAt: at, finishedAt: index < 40 ? null : at, createdAt: at, contextSnapshot: { issueId, taskId: issueId },
        controllerLeaseExpiresAt: index < 40 ? new Date(Date.now() + 60_000) : null, controllerBootId: index < 40 ? randomUUID() : null };
    });
    for (let index = 0; index < runs.length; index += 1_000) await db.insert(heartbeatRuns).values(runs.slice(index, index + 1_000));
    await db.execute(sqlTag`analyze`);
    const queue = wakeQueue();
    const sweep = assignedWorkSweep(db, { enqueueWakeup: queue.enqueueWakeup });

    const time = async <T>(work: () => Promise<T>) => { const started = performance.now(); const value = await work();
      return { value, ms: Math.round(performance.now() - started) }; };
    await sweep.listSuspects({ companyId: f.companyId }, null, 100);
    const suspects = await time(() => sweep.listSuspects({ companyId: f.companyId }, null, 100));
    const one = await time(() => sweep.checkIssue({ companyId: f.companyId, issueId: suspects.value[0].id }));
    const report = await time(() => sweep.report(f.companyId));
    const plan = await db.execute<{ "QUERY PLAN": string }>(sqlTag`explain (analyze, buffers) select count(*) from issues i
      where i.company_id = ${f.companyId} and i.status in ('todo','in_progress','blocked') and i.assignee_agent_id is not null
        and not exists (select 1 from heartbeat_runs r where r.company_id = i.company_id and (r.context_snapshot->>'issueId') = i.id::text
          and r.status in ('queued','running','scheduled_retry'))`);
    const planText = (Array.isArray(plan) ? plan : (plan as { rows: Array<{ "QUERY PLAN": string }> }).rows).map(row => row["QUERY PLAN"]).join("\n");
    console.info(JSON.stringify({ assignedWorkQueryCost: { suspectPageMs: suspects.ms, suspects: suspects.value.length,
      checkOneIssueMs: one.ms, fullReportMs: report.ms, reportChecked: report.value.checked } }));
    console.info(planText);
    expect(planText).not.toMatch(/Seq Scan on heartbeat_runs/);
    expect(suspects.ms).toBeLessThan(1_000);
    expect(one.ms).toBeLessThan(1_000);
  }, 240_000);
});

