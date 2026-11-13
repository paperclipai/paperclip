import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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

  async function seedRecordedContinuation(minutesAgo: number) {
    const recordedAt = new Date(Date.now() - minutesAgo * 60_000);
    const task = await seedSwapEndedRun(new Date(recordedAt.getTime() - 30_000));
    const freshContinuation = { schema: "paperclip.fresh-continuation.v1", sourceRunId: task.runId, trigger: "held_recovery",
      failureCode: "native_restart_recovery_blocked", delivery: "recorded", recordedAt: recordedAt.toISOString(),
      isolation: "remote_epoch", stopProof: "unproven_epoch_abandoned", unverifiedActions: [], createdObjects: [] };
    const settlement = { schema: "paperclip.fresh-continuation.v1", actorType: "system", actorId: "fresh-continuation",
      decision: "continue_in_fresh_run", replay: "none", sourceRunId: task.runId, reason: "exact_resumption_unavailable",
      isolation: "remote_epoch", recordedAt: recordedAt.toISOString() };
    const reconciliation = { runId: task.runId, providerStopped: true, providerStopProof: "isolated", actionOutcome: "mixed",
      actorId: "fresh-continuation", recordedAt: recordedAt.toISOString() };
    const [primary] = await db.insert(issueRecoveryActions).values({ companyId: task.companyId, sourceIssueId: task.issue.id,
      kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system", returnOwnerAgentId: task.agentId,
      cause: "native_continuation_requires_reconciliation", fingerprint: `native-continuation:${task.runId}`,
      nextAction: "Paperclip continues the task in a fresh run from its saved work.", resolutionNote: "continued_fresh_from_last_saved",
      resolvedAt: recordedAt, createdAt: recordedAt, updatedAt: recordedAt,
      evidence: { runId: task.runId, executionReconciliation: reconciliation, freshContinuationSettlement: settlement,
        freshContinuation, continuationDelivery: "pending" } }).returning();
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: recordedAt, updatedAt: recordedAt,
      evidence: { ...task.hold.evidence, executionReconciliation: reconciliation, freshContinuationSettlement: settlement,
        continuationDelivery: "coalesced", coalescedIntoRecoveryActionId: primary!.id } })
      .where(eq(issueRecoveryActions.id, task.hold.id));
    return { ...task, primary: primary! };
  }

  it("shows a task whose recorded continuation is still waiting to start as continuing, however long delivery takes", async () => {
    for (const minutesAgo of [1, 14, 30, 110]) {
      const { issue, runId } = await seedRecordedContinuation(minutesAgo);
      expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ responsibility: "system", state: "working",
        canRetry: minutesAgo >= 15, observedRunId: runId });
    }
  });

  it("keeps a recorded continuation as continuing after a refused delivery attempt, since delivery tries again", async () => {
    const { issue, primary } = await seedRecordedContinuation(45);
    await db.update(issueRecoveryActions).set({ evidence: { ...primary.evidence,
      continuationDeliveryAttemptedAt: new Date(Date.now() - 60_000).toISOString() } }).where(eq(issueRecoveryActions.id, primary.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "working", canRetry: true, retryAction: "move_forward" });
  });

  it("offers Retry once the system gives up on a recorded continuation", async () => {
    const { issue, primary, hold } = await seedRecordedContinuation(45);
    await db.update(issueRecoveryActions).set({ evidence: { ...primary.evidence, continuationDelivery: "invalidated" } })
      .where(eq(issueRecoveryActions.id, primary.id));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold.evidence, continuationDelivery: "invalidated",
      coalescedIntoRecoveryActionId: primary.id } }).where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ responsibility: "system", state: "failed", canRetry: true });
  });

  it("follows the new run once a recorded continuation is delivered", async () => {
    const { companyId, agentId, issue, primary } = await seedRecordedContinuation(45);
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue",
      status: "queued", runtimeMode: "native", retryOfRunId: primary.evidence.runId as string });
    await db.update(issueRecoveryActions).set({ evidence: { ...primary.evidence, continuationDelivery: "delivered",
      continuationRunId: nextRunId } }).where(eq(issueRecoveryActions.id, primary.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "working", canRetry: false, observedRunId: nextRunId });
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", finishedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(heartbeatRuns.id, nextRunId));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true, observedRunId: nextRunId });
  });

  async function seedQueuedContinuation(queuedMinutesAgo: number, status: "queued" | "running" = "queued") {
    const task = await seedRecordedContinuation(queuedMinutesAgo + 2);
    await db.update(heartbeatRuns).set({ createdAt: new Date(Date.now() - (queuedMinutesAgo + 4) * 60_000) })
      .where(eq(heartbeatRuns.id, task.runId));
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: task.companyId, agentId: task.agentId, nativeIssueId: task.issue.id,
      scopeKind: "issue", status, runtimeMode: "native", retryOfRunId: task.runId,
      createdAt: new Date(Date.now() - queuedMinutesAgo * 60_000),
      contextSnapshot: { issueId: task.issue.id, wakeReason: "issue_recovery_action_restored", previousRunId: task.runId,
        recoveryActionId: task.primary.id } });
    await db.update(issueRecoveryActions).set({ evidence: { ...task.primary.evidence, continuationDelivery: "delivered",
      continuationRunId: nextRunId } }).where(eq(issueRecoveryActions.id, task.primary.id));
    return { ...task, nextRunId };
  }

  it("offers a person a way to move a continuation forward once it has waited 15 minutes to start, without calling it failed", async () => {
    for (const minutesAgo of [15, 45, 110]) {
      const { issue, nextRunId } = await seedQueuedContinuation(minutesAgo);
      expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ responsibility: "system", state: "working",
        canRetry: true, retryAction: "move_forward", observedRunId: nextRunId });
    }
  });

  it("keeps a continuation that has waited under 15 minutes as continuing with no Retry", async () => {
    const { issue, nextRunId } = await seedQueuedContinuation(14);
    const presentation = await taskInterruptionPresentation(db, issue);
    expect(presentation).toMatchObject({ state: "working", canRetry: false, observedRunId: nextRunId });
    expect(presentation?.retryAction).toBeUndefined();
  });

  it("offers to move a recorded continuation forward once it has waited 15 minutes for delivery, without calling it failed", async () => {
    for (const minutesAgo of [15, 45, 110]) {
      const { issue, runId } = await seedRecordedContinuation(minutesAgo);
      expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ responsibility: "system", state: "working",
        canRetry: true, retryAction: "move_forward", observedRunId: runId });
    }
  });

  it("offers no Retry while a recorded continuation has waited under 15 minutes for delivery", async () => {
    const { issue } = await seedRecordedContinuation(14);
    const presentation = await taskInterruptionPresentation(db, issue);
    expect(presentation).toMatchObject({ state: "working", canRetry: false });
    expect(presentation?.retryAction).toBeUndefined();
  });

  it("offers no Retry for a continuation recorded without a delivery request", async () => {
    const { issue, primary } = await seedRecordedContinuation(45);
    await db.update(issueRecoveryActions).set({ evidence: { ...primary.evidence, continuationDelivery: "not_requested" } })
      .where(eq(issueRecoveryActions.id, primary.id));
    const presentation = await taskInterruptionPresentation(db, issue);
    expect(presentation).toMatchObject({ state: "working", canRetry: false });
    expect(presentation?.retryAction).toBeUndefined();
  });

  it("offers no second Retry once a person already asked to move the undelivered continuation forward", async () => {
    const { companyId, agentId, issue, runId } = await seedRecordedContinuation(45);
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", triggerDetail: "manual",
      reason: "task_retry", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: randomUUID(),
      payload: { issueId: issue.id, taskRetry: { sourceRunId: runId } } });
    const presentation = await taskInterruptionPresentation(db, issue);
    expect(presentation).toMatchObject({ state: "working", canRetry: false });
    expect(presentation?.retryAction).toBeUndefined();
  });

  it("offers no move-forward for an undelivered continuation once the task is reassigned", async () => {
    const { companyId, issue } = await seedRecordedContinuation(45);
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "Other agent", adapterType: "paperclip_runner" });
    const [reassigned] = await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, issue.id)).returning();
    expect((await taskInterruptionPresentation(db, reassigned!))?.retryAction).toBeUndefined();
  });

  it("offers no Retry for a continuation that is already running", async () => {
    const { issue } = await seedQueuedContinuation(45, "running");
    const presentation = await taskInterruptionPresentation(db, issue);
    expect(presentation).toMatchObject({ state: "working", canRetry: false });
    expect(presentation?.retryAction).toBeUndefined();
  });

  it("offers no second Retry once a person already moved the waiting continuation forward", async () => {
    const { companyId, agentId, issue, nextRunId } = await seedQueuedContinuation(45);
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", triggerDetail: "manual",
      reason: "task_retry", status: "coalesced", requestedByActorType: "user", requestedByActorId: randomUUID(),
      runId: nextRunId, finishedAt: new Date(), payload: { issueId: issue.id } });
    const presentation = await taskInterruptionPresentation(db, issue);
    expect(presentation).toMatchObject({ state: "working", canRetry: false });
    expect(presentation?.retryAction).toBeUndefined();
  });

  it("offers no Retry for queued work that is not a recorded continuation, however long it waits", async () => {
    const { companyId, agentId, issue } = await seedTask("todo");
    await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issue.id, scopeKind: "issue", status: "queued",
      runtimeMode: "native", createdAt: new Date(Date.now() - 45 * 60_000), contextSnapshot: { issueId: issue.id, wakeReason: "issue_assigned" } });
    const presentation = await taskInterruptionPresentation(db, issue);
    expect(presentation).toMatchObject({ state: "working", canRetry: false });
    expect(presentation?.retryAction).toBeUndefined();
  });

  it("asks a person to resume a paused agent instead of offering to move its waiting continuation forward", async () => {
    const { agentId, issue } = await seedQueuedContinuation(45);
    await db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, agentId));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ responsibility: "user", state: "waiting_for_user",
      userAction: "resume", canRetry: false });
  });

  it("still offers Retry for a resolved recovery record that recorded no continuation", async () => {
    const { issue, hold } = await seedSwapEndedRun(new Date(Date.now() - 45 * 60_000));
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: new Date(Date.now() - 40 * 60_000),
      evidence: { ...hold.evidence, freshContinuationSettlement: { schema: "paperclip.fresh-continuation.v1", decision: "continue_in_fresh_run" } } })
      .where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ responsibility: "system", state: "failed", canRetry: true });
  });

  it("still offers Retry when the board owns the hold and no continuation is recorded", async () => {
    const { issue, hold } = await seedSwapEndedRun(new Date(Date.now() - 45 * 60_000));
    await db.update(issueRecoveryActions).set({ ownerType: "board" }).where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject({ state: "failed", canRetry: true });
  });

  async function seedProviderTerminalFailure(finishedAt: Date) {
    const task = await seedTask("blocked");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: task.companyId, agentId: task.agentId,
      nativeIssueId: task.issue.id, scopeKind: "issue", status: "failed", runtimeMode: "native",
      nativePhase: "terminal_failure", errorCode: "native_provider_terminal_failed",
      error: "ACP agent reported a terminal service failure.", startedAt: new Date(finishedAt.getTime() - 60_000), finishedAt });
    await db.insert(nativeRunFinalizations).values({ companyId: task.companyId, issueId: task.issue.id, runId,
      phase: "terminal_failure", attempt: 1, failureCode: "native_provider_terminal_failed", updatedAt: finishedAt });
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: task.companyId, sourceIssueId: task.issue.id,
      kind: "active_run_watchdog", status: "active", ownerType: "board", returnOwnerAgentId: task.agentId,
      cause: "native_provider_terminal_failed", fingerprint: `provider-terminal:${runId}`,
      evidence: { runId, nativeFailureBlock: { runId, statusVersion: 1 }, coordinatorAttempt: 1,
        sourceFailureCode: "native_provider_terminal_failed", recoveryDisposition: "native_provider_terminal_failed",
        recoveryMode: "replacement", providerSessionEstablished: true },
      nextAction: "Verify that the failed provider stopped and reconcile its action outcomes.",
      maxAttempts: 3, createdAt: finishedAt, updatedAt: finishedAt }).returning();
    return { ...task, issue: { ...task.issue, status: "blocked" }, runId, hold: hold! };
  }

  it("shows a provider failure the system is still recovering as working through every recovery step, never offering Retry in between", async () => {
    const { issue, runId, hold, companyId } = await seedProviderTerminalFailure(new Date(Date.now() - 2_000));
    const working = { responsibility: "system", state: "working", canRetry: false, observedRunId: runId };
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject(working);

    const running = { ...createSystemRecovery(runId), state: "running" as const, phase: "preserve_files" as const };
    await db.update(issueRecoveryActions).set({ ownerType: "system", updatedAt: new Date(),
      evidence: { ...hold.evidence, systemRecovery: running, systemRecoveryActiveAt: Date.now() } })
      .where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject(working);

    await db.update(issueRecoveryActions).set({ updatedAt: new Date(),
      evidence: { ...hold.evidence, systemRecovery: { ...running, state: "complete" }, systemRecoveryActiveAt: Date.now() - 60_000 } })
      .where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject(working);

    await db.update(nativeRunFinalizations).set({ failureDetail: { replacementDenied: "provider_failure_meaning_unverified" },
      updatedAt: new Date() }).where(eq(nativeRunFinalizations.runId, runId));
    await db.update(issueRecoveryActions).set({ ownerType: "board", cause: "provider_failure_meaning_unverified",
      fingerprint: `native-replacement:${runId}`, evidence: { runId, attempts: 1 }, nextAction: "Review the provider failure.",
      updatedAt: new Date() }).where(and(eq(issueRecoveryActions.id, hold.id), eq(issueRecoveryActions.companyId, companyId)));
    expect(await taskInterruptionPresentation(db, issue)).toMatchObject(working);
  });

  it("offers Retry for a provider failure once the recovery bound passes with nothing recorded", async () => {
    const { issue } = await seedProviderTerminalFailure(new Date(Date.now() - 3 * 60_000));
    expect(await taskInterruptionPresentation(db, { ...issue, status: "todo" })).toMatchObject({ state: "failed", canRetry: true });
  });

  it("offers Retry for a provider failure at once when the continuation worker decided it cannot continue the task", async () => {
    const { issue, hold } = await seedProviderTerminalFailure(new Date(Date.now() - 2_000));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold.evidence,
      freshContinuationCheck: { kind: "not_applicable", reason: "task_changed", checks: 1, checkedAt: Date.now(), nextCheckAt: null } } })
      .where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, { ...issue, status: "todo" })).toMatchObject({ state: "failed", canRetry: true });
  });

  it("offers Retry for a provider failure at once when a person took over its hold", async () => {
    const { issue, hold, companyId } = await seedProviderTerminalFailure(new Date(Date.now() - 2_000));
    await db.update(issueRecoveryActions).set({ evidence: { ...hold.evidence, ownerGoneAttestation: { companyId } } })
      .where(eq(issueRecoveryActions.id, hold.id));
    expect(await taskInterruptionPresentation(db, { ...issue, status: "todo" })).toMatchObject({ state: "failed", canRetry: true });
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
