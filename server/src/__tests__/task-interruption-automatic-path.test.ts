import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, applyPendingMigrations, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { createSystemRecovery } from "../services/system-recovery-state.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const externalDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_TASK_INTERRUPTION_TEST_DATABASE_URL");
const support = externalDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
vi.mock("../sentry.js", () => ({ captureTaskInterruptionFailure: vi.fn() }));

describe.skipIf(!support.supported)("Retry is offered only when no automatic path exists", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    if (externalDatabaseUrl) await applyPendingMigrations(externalDatabaseUrl);
    database = externalDatabaseUrl ? { connectionString: externalDatabaseUrl, cleanup: async () => {} }
      : await startEmbeddedPostgresTestDatabase("interruption-automatic-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seedTask(status = "in_progress") {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Swap company", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Swap agent", adapterType: "paperclip_runner" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Work across a release swap",
      status, assigneeAgentId: agentId }).returning();
    return { companyId, agentId, issue: issue! };
  }

  async function seedSwapEndedRun(finishedAt: Date) {
    const task = await seedTask();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: task.companyId, agentId: task.agentId,
      nativeIssueId: task.issue.id, scopeKind: "issue", status: "failed", runtimeMode: "native",
      nativePhase: "terminal_failure", errorCode: "native_restart_recovery_blocked",
      error: "controller_process_space_unverified", startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt });
    await db.insert(nativeRunFinalizations).values({ companyId: task.companyId, issueId: task.issue.id, runId,
      phase: "terminal_failure", attempt: 1, failureCode: "native_restart_recovery_blocked", recoveryState: "blocked" });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: task.companyId, sourceIssueId: task.issue.id,
      kind: "active_run_watchdog", status: "active", ownerType: "system", returnOwnerAgentId: task.agentId,
      cause: "native_restart_recovery_blocked", fingerprint: `native-restart:${runId}`,
      evidence: { runId, reason: "controller_process_space_unverified", executorStopEvidence: "unverified", providerAttempt: 1 },
      nextAction: "The server running this task restarted. Paperclip continues the task in a fresh run from its saved work.",
      maxAttempts: 3, createdAt: finishedAt, updatedAt: finishedAt }).returning();
    return { ...task, runId, hold: hold! };
  }

  it("shows a run ended by a release swap as working while its system hold awaits the automatic continuation", async () => {
    const { issue, runId } = await seedSwapEndedRun(new Date(Date.now() - 5_000));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ responsibility: "system", state: "working",
      canRetry: false, observedRunId: runId });
  });

  it("still offers Retry when the system hold was not taken up by the continuation worker in time", async () => {
    const { issue } = await seedSwapEndedRun(new Date(Date.now() - 10 * 60_000));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("still offers Retry once the continuation worker decided it cannot continue the task", async () => {
    const { issue, hold } = await seedSwapEndedRun(new Date(Date.now() - 5_000));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold.evidence,
      freshContinuationCheck: { kind: "not_applicable", reason: "task_changed", checks: 1, checkedAt: Date.now(), nextCheckAt: null } } })
      .where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("still offers Retry when a person owns the hold", async () => {
    const { issue, hold, companyId } = await seedSwapEndedRun(new Date(Date.now() - 5_000));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold.evidence, ownerGoneAttestation: { companyId } } })
      .where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("still offers Retry when recovery gave up and handed the hold to the board", async () => {
    const { issue, hold } = await seedSwapEndedRun(new Date(Date.now() - 5_000));
    await db.update(issueRecoveryActions).set({ ownerType: "board" }).where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("shows a healthy task as working while the message queued during its succeeded run is delivered", async () => {
    const { companyId, agentId, issue } = await seedTask();
    const runId = randomUUID(), finishedAt = new Date(Date.now() - 3_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue",
      status: "succeeded", runtimeMode: "native", startedAt: new Date(Date.now() - 5 * 60_000), finishedAt });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedAt: new Date(Date.now() - 2 * 60_000),
      payload: { issueId: issue.id } });
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "working", canRetry: false });
    expect(await taskInterruptionPresentation(db, { ...issue, status: "in_review" })).toMatchObject({ state: "working", canRetry: false });
    expect(await taskInterruptionPresentation(db, { ...issue, status: "blocked" })).toMatchObject({ state: "failed", canRetry: true });
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(heartbeatRuns.id, runId));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ canRetry: true });
  });

  async function seedParentWaitingOnSubtasks(childStatus = "in_progress") {
    const { companyId, agentId, issue } = await seedTask("blocked");
    for (const title of ["Subtask 1", "Subtask 2"])
      await db.insert(issues).values({ companyId, title, status: childStatus, assigneeAgentId: agentId, parentId: issue.id });
    const runId = randomUUID(), finishedAt = new Date(Date.now() - 1_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue",
      status: "succeeded", runtimeMode: "native", startedAt: new Date(Date.now() - 25 * 60_000), finishedAt });
    return { companyId, agentId, issue, runId };
  }

  async function seedCommentQueuedDuringRun(companyId: string, agentId: string, issueId: string) {
    const commentId = randomUUID();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
      reason: "issue_execution_deferred", triggerDetail: "system", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "local-board", requestedAt: new Date(Date.now() - 13 * 60_000),
      payload: { issueId, mutation: "comment", commentId,
        _paperclipWakeContext: { source: "issue.comment", issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId] } },
    }).returning();
    return wake!;
  }

  it("shows a parent whose run just succeeded waiting on its subtasks as working while its queued message is settled", async () => {
    const { companyId, agentId, issue, runId } = await seedParentWaitingOnSubtasks();
    await seedCommentQueuedDuringRun(companyId, agentId, issue.id);
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ responsibility: "system", state: "working",
      canRetry: false, observedRunId: runId });
  });

  it("shows the parent as resolved once its queued message is cancelled as already delivered", async () => {
    const { companyId, agentId, issue } = await seedParentWaitingOnSubtasks();
    const wake = await seedCommentQueuedDuringRun(companyId, agentId, issue.id);
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date(),
      error: "Queued messages were already delivered to a completed run" }).where(eq(agentWakeupRequests.id, wake.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "resolved", canRetry: false });
  });

  it("shows the parent as working once its queued message is promoted to a new run", async () => {
    const { companyId, agentId, issue } = await seedParentWaitingOnSubtasks();
    const wake = await seedCommentQueuedDuringRun(companyId, agentId, issue.id);
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue",
      status: "queued", runtimeMode: "native", wakeupRequestId: wake.id });
    await db.update(agentWakeupRequests).set({ status: "queued", runId: nextRunId }).where(eq(agentWakeupRequests.id, wake.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "working", canRetry: false, observedRunId: nextRunId });
  });

  it("offers Retry on the parent once its queued message is not settled within the grace", async () => {
    const { companyId, agentId, issue, runId } = await seedParentWaitingOnSubtasks();
    await seedCommentQueuedDuringRun(companyId, agentId, issue.id);
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 3 * 60_000) }).where(eq(heartbeatRuns.id, runId));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("still offers Retry on a blocked task with a queued message and no open subtasks", async () => {
    for (const childStatus of [null, "done", "cancelled"]) {
      const { companyId, agentId, issue } = await seedTask("blocked");
      if (childStatus) await db.insert(issues).values({ companyId, title: "Finished subtask", status: childStatus,
        assigneeAgentId: agentId, parentId: issue.id });
      await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue",
        status: "succeeded", runtimeMode: "native", finishedAt: new Date(Date.now() - 1_000) });
      await seedCommentQueuedDuringRun(companyId, agentId, issue.id);
      expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
    }
  });

  it("still offers Retry on a parent with open subtasks when its queued wake carries no message", async () => {
    const { companyId, agentId, issue } = await seedParentWaitingOnSubtasks();
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", reason: "issue_assigned",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedAt: new Date(Date.now() - 13 * 60_000),
      payload: { issueId: issue.id } });
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("still offers Retry on a parent with open subtasks and a queued message when its run failed and recovery gave up", async () => {
    const { companyId, agentId, issue, runId, hold } = await seedSwapEndedRun(new Date(Date.now() - 5_000));
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issue.id));
    await db.insert(issues).values({ companyId, title: "Open subtask", status: "in_progress", assigneeAgentId: agentId, parentId: issue.id });
    await seedCommentQueuedDuringRun(companyId, agentId, issue.id);
    await db.update(issueRecoveryActions).set({ ownerType: "board" }).where(eq(issueRecoveryActions.id, hold.id));
    const blocked = { ...issue, status: "blocked" };
    expect(await taskInterruptionPresentation(db, blocked)).toMatchObject({ state: "failed", canRetry: true, observedRunId: runId });
  });

  it("still offers Retry on a parent with open subtasks and a queued message when saved-work recovery is exhausted", async () => {
    const { companyId, agentId, issue, runId } = await seedParentWaitingOnSubtasks();
    await seedCommentQueuedDuringRun(companyId, agentId, issue.id);
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue.id, kind: "active_run_watchdog",
      status: "escalated", ownerType: "system", returnOwnerAgentId: agentId, cause: "native_restart_recovery_blocked",
      fingerprint: `exhausted:${runId}`, nextAction: "Retry to continue.", maxAttempts: 3,
      evidence: { runId, systemRecovery: { ...createSystemRecovery(runId), state: "exhausted", attempts: 3, retriesUsed: 3 } } });
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  it("does not show a failed attempt on a parent whose run succeeded with no queued message", async () => {
    for (const childStatus of ["in_progress", "blocked", "cancelled"]) {
      const { issue } = await seedParentWaitingOnSubtasks(childStatus);
      expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "resolved", canRetry: false });
    }
  });

  it("does not offer Retry on a parent whose run succeeded and that waits for its subtasks", async () => {
    const { companyId, agentId, issue } = await seedTask();
    await db.insert(issues).values({ companyId, title: "Subtask", status: "in_progress", assigneeAgentId: agentId, parentId: issue.id });
    await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue",
      status: "succeeded", runtimeMode: "native", finishedAt: new Date(Date.now() - 3_000) });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", reason: "issue_children_completed",
      status: "queued", requestedByActorType: "system", payload: { issueId: issue.id } });
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ canRetry: false });
  });
});
