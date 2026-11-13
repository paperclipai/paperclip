import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, authUsers, companies, createDb, heartbeatRuns, issueRecoveryActions, issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { deliverReconciledExecutions } from "./execution-recovery-resolution.js";
import { FRESH_CONTINUATIONS_PER_HOUR, FRESH_CONTINUATION_SCHEMA, ensureFreshContinuation,
  resetBacklogContinuationPacingForTests } from "./fresh-continuation-fallback.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { heartbeatService } from "./heartbeat.js";
import { queuedRunDispatchClass } from "./heartbeat/queued-run-dispatch-order.js";
import { ASSIGNED_WORK_CONTINUED_ACTION } from "./recovery/task-automatic-attempts.js";
import { CONTINUATION_CAP } from "./recovery/assigned-work-invariant.js";
import { requestTaskRetry } from "./task-retry.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

const KINDS = ["fresh_isolated_workspace", "writer_ended", "native"] as const;
type Kind = (typeof KINDS)[number];
const RECORDED_ISOLATION: Record<Kind, string> = {
  fresh_isolated_workspace: "fresh_isolated_workspace", writer_ended: "writer_ended", native: "remote_epoch" };

suite("a person's Retry while a continuation waits for delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId = "", agentId = "", userId = "";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-retry-delivery-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "FRD",
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} });
  }, 60_000);

  afterEach(async () => {
    resetBacklogContinuationPacingForTests(db);
    await db.execute(sql`truncate table issue_recovery_actions, native_run_finalizations, activity_log,
      agent_wakeup_requests, heartbeat_runs, issues cascade`);
  });

  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function pendingContinuation(kind: Kind, endedAgoMs = 60_000) {
    const issueId = randomUUID(), runId = randomUUID();
    const finishedAt = new Date(Date.now() - endedAgoMs);
    const native = kind === "native";
    await db.insert(issues).values({ id: issueId, companyId, title: "Ship the release notes", status: "blocked",
      assigneeAgentId: agentId, statusVersion: 4, blockedTransitionAt: finishedAt });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", issueId,
      nativeIssueId: native ? issueId : null, runtimeMode: native ? "native" : "legacy",
      status: "failed", errorCode: native ? "native_session_interrupted" : kind === "writer_ended" ? "process_lost" : "controller_lease_lost",
      error: "cut off", startedAt: new Date(finishedAt.getTime() - 10 * 60_000), finishedAt,
      createdAt: new Date(finishedAt.getTime() - 11 * 60_000), responsibleUserId: userId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      ...(native ? { nativePhase: "terminal_failure", runnerProfileJson: { remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1",
        workspaceId: randomUUID(), leaseId: randomUUID(), providerLeaseId: "sandbox-1", remoteCwd: "/home/daytona/work", epoch: 3,
        state: "prepared", snapshotId: null } } }
        : { runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } } }),
      ...(kind === "fresh_isolated_workspace"
        ? { processPid: 4242, processHostHash: "replaced-server", processStartedAt: new Date(Date.now() - 600_000) } : {}) });
    if (native) {
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
        recoveryState: "blocked", failureCode: "native_continuation_requires_reconciliation", leaseOwner: null });
    }
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "board", returnOwnerAgentId: agentId,
      cause: native ? "native_continuation_requires_reconciliation" : "legacy_execution_requires_reconciliation",
      fingerprint: `${native ? "native-continuation" : "legacy-execution"}:${runId}`, nextAction: "Held.", maxAttempts: 3,
      createdAt: finishedAt, evidence: { runId, originalFailureCode: "cut_off", nativeFailureBlock: { runId, statusVersion: 4 } } })
      .returning();
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: null }).where(eq(issues.id, issueId));
    expect(await ensureFreshContinuation(db, { companyId, runId, trigger: "recovery_refused" }))
      .toMatchObject({ kind: "continued", delivery: "recorded", isolation: RECORDED_ISOLATION[kind] });
    return { issueId, runId, actionId: action!.id, isolation: RECORDED_ISOLATION[kind] };
  }

  async function occupySlot() {
    const [other] = await db.insert(issues).values({ companyId, title: "Other work", status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "running", contextSnapshot: { issueId: other!.id } });
  }
  const taskRuns = (f: { issueId: string; runId: string }) => db.select().from(heartbeatRuns).where(and(
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`, sql`${heartbeatRuns.id} <> ${f.runId}`));
  const record = async (actionId: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)))[0]!;
  const wake = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;
  const deliveryPass = () => deliverReconciledExecutions(db, heartbeatService(db).wakeup);
  async function deliver() { await deliveryPass(); await deliveryPass(); }
  async function requestRetry(issueId: string, observedRunId: string) {
    const receipt = await requestTaskRetry({ db, companyId, issueId, actorId: userId, observedRunId,
      idempotencyKey: randomUUID(), actorSource: "local_implicit" });
    expect(receipt).toMatchObject({ accepted: true });
    return receipt.requestId!;
  }
  async function pressRetry(f: { issueId: string; runId: string }) {
    const requestId = await requestRetry(f.issueId, f.runId);
    await heartbeatService(db).resumeTaskRetry(companyId, requestId);
    return requestId;
  }

  async function expectSingleContinuationRun(f: Awaited<ReturnType<typeof pendingContinuation>>, requestId: string) {
    const runs = await taskRuns(f);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.contextSnapshot).toMatchObject({ recoveryActionId: f.actionId, previousRunId: f.runId, forceFreshSession: true });
    expect(run.retryOfRunId).toBe(f.runId);
    if (f.isolation === "fresh_isolated_workspace") {
      expect(run.contextSnapshot).toMatchObject({ freshContinuationIsolation: f.actionId });
      expect(await readFreshWorkspaceReadiness(db, run)).toMatchObject({ mode: "fresh_isolated_workspace", retryIntentId: f.actionId });
    } else expect(run.contextSnapshot?.freshContinuationIsolation).toBeUndefined();
    expect(await wake(requestId)).toMatchObject({ status: "coalesced", runId: run.id });
    expect((await record(f.actionId)).evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: run.id });
    return run;
  }

  it.each(KINDS)("runs a Retry pressed before delivery as the recorded continuation itself, ranked as person work (%s)", async kind => {
    const f = await pendingContinuation(kind);
    await occupySlot();
    const requestId = await pressRetry(f);
    const run = await expectSingleContinuationRun(f, requestId);
    expect(run.contextSnapshot).toMatchObject({ wakeReason: "task_retry", taskRetryRequestId: requestId });
    const [runWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId!));
    expect(runWake!.requestedByActorType).toBe("user");
    expect(queuedRunDispatchClass({ id: run.id, createdAt: run.createdAt, wakeReason: "task_retry", requestedByUser: true,
      sourceEndedAt: null, readinessRank: 1, priorityRank: 0 }, new Date())).toBe("person");
    await deliver();
    expect((await taskRuns(f)).map(row => row.id)).toEqual([run.id]);
  }, 60_000);

  it.each(KINDS)("moves a recorded continuation forward as the one run when delivery has not happened yet (%s)", async kind => {
    const f = await pendingContinuation(kind);
    await occupySlot();
    const receipt = await requestTaskRetry({ db, companyId, issueId: f.issueId, actorId: userId, observedRunId: f.runId,
      idempotencyKey: randomUUID(), actorSource: "local_implicit", retryAction: "move_forward" });
    expect(receipt).toMatchObject({ accepted: true });
    await heartbeatService(db).resumeTaskRetry(companyId, receipt.requestId!);
    const run = await expectSingleContinuationRun(f, receipt.requestId!);
    await deliver();
    expect((await taskRuns(f)).map(row => row.id)).toEqual([run.id]);
  }, 60_000);

  it.each(KINDS)("answers a Retry saved before delivery with the delivered continuation, never a second run (%s)", async kind => {
    const f = await pendingContinuation(kind);
    await occupySlot();
    const requestId = await requestRetry(f.issueId, f.runId);
    await deliver();
    await heartbeatService(db).resumeTaskRetry(companyId, requestId);
    const runs = await taskRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contextSnapshot).toMatchObject({ recoveryActionId: f.actionId, wakeReason: "issue_recovery_action_restored" });
    expect(await wake(requestId)).toMatchObject({ status: "coalesced", runId: runs[0]!.id });
    const joined = await requestRetry(f.issueId, runs[0]!.id);
    expect(await wake(joined)).toMatchObject({ status: "coalesced", runId: runs[0]!.id });
    expect(await taskRuns(f)).toHaveLength(1);
  }, 60_000);

  it.each(KINDS)("starts exactly one run when a Retry and the delivery pass race (%s)", async kind => {
    const f = await pendingContinuation(kind);
    await occupySlot();
    const requestId = await requestRetry(f.issueId, f.runId);
    await Promise.all([heartbeatService(db).resumeTaskRetry(companyId, requestId), deliveryPass(), deliveryPass()]);
    await deliver();
    await heartbeatService(db).resumeTaskRetry(companyId, requestId);
    const runs = await taskRuns(f);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.contextSnapshot).toMatchObject({ recoveryActionId: f.actionId });
    if (f.isolation === "fresh_isolated_workspace") expect(runs[0]!.contextSnapshot).toMatchObject({ freshContinuationIsolation: f.actionId });
    expect(await wake(requestId)).toMatchObject({ status: "coalesced", runId: runs[0]!.id });
    expect((await record(f.actionId)).evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: runs[0]!.id });
  }, 60_000);

  it.each(["fresh_isolated_workspace", "writer_ended"] as const)("gives a Retry of the continuation's own failure its own run (%s)", async kind => {
    const f = await pendingContinuation(kind);
    await occupySlot();
    await deliver();
    const [continuation] = await taskRuns(f);
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", startedAt: new Date(), finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, continuation!.id));
    const requestId = await pressRetry({ issueId: f.issueId, runId: continuation!.id });
    const retryWake = await wake(requestId);
    expect(retryWake.runId, JSON.stringify(retryWake)).toBeTruthy();
    expect(retryWake.runId).not.toBe(continuation!.id);
    const [own] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryWake.runId!));
    expect(own!.contextSnapshot).toMatchObject({ wakeReason: "task_retry", previousRunId: continuation!.id });
    expect(own!.contextSnapshot?.recoveryActionId).toBeUndefined();
    expect((await record(f.actionId)).evidence).toMatchObject({ continuationRunId: continuation!.id });
  }, 60_000);

  it("starts the person's run while the delivery is held by pacing and the task's automatic attempts are spent", async () => {
    const f = await pendingContinuation("fresh_isolated_workspace", 45 * 60_000);
    const [other] = await db.insert(issues).values({ companyId, title: "Queued work", status: "todo", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: other!.id, status: "queued", contextSnapshot: { issueId: other!.id } });
    const now = new Date();
    for (let index = 0; index < FRESH_CONTINUATIONS_PER_HOUR; index += 1)
      await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", status: "resolved",
        ownerType: "system", cause: "fresh_continuation", fingerprint: `spent:${index}:${f.issueId}`, nextAction: "Continued.",
        evidence: { freshContinuation: { schema: FRESH_CONTINUATION_SCHEMA, recordedAt: new Date(now.getTime() - 60_000).toISOString() },
          continuationDelivery: "delivered" } });
    for (let index = 0; index < CONTINUATION_CAP; index += 1)
      await db.insert(activityLog).values({ companyId, actorType: "system", actorId: "assigned-work", action: ASSIGNED_WORK_CONTINUED_ACTION,
        entityType: "issue", entityId: f.issueId });
    await deliver();
    expect(await taskRuns(f)).toHaveLength(0);
    expect((await record(f.actionId)).evidence.continuationDelivery).toBe("pending");
    const requestId = await pressRetry(f);
    await expectSingleContinuationRun(f, requestId);
  }, 60_000);
});
