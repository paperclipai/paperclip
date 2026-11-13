import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentTaskSessions, agentWakeupRequests, chatActions, chatConversations, chatEndpoints, companies, budgetPolicies, costEvents, createDb, type Db, environmentLeases, environments, executionWorkspaces, executionWorkspaceSnapshots, workspaceOperations, heartbeatRunEvents, heartbeatRuns, issueComments, issues, approvals, issueApprovals, issueRecoveryActions, nativeRunFinalizations, toolApplications, toolConnections, toolInvocations, applyPendingMigrations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { priorRecoveryApiReceipt, unresolvedRecoveryToolInvocation } from "./recovery-effect-receipts.js";
import { requestTaskRetry } from "./task-retry.js";
import { HttpError } from "../errors.js";
import { NativeChatReviewPresentationContentionError } from "./native-runtime/native-chat-review-presentation.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { settleUnrecoverableExecutions } from "./execution-recovery-resolution.js";
import { createSystemRecovery, failSystemRecovery, readSystemRecovery, SystemRecoveryFailure } from "./system-recovery-state.js";
import { instanceSettingsService } from "./instance-settings.js";
import { heartbeatService } from "./heartbeat.js";
import { taskChatRetryCanAwaitRecovery, taskChatRetryExecutionStopped } from "./chat-channels/task-retry-authority.js";
import { admitExplicitNativeContinuation } from "./explicit-native-continuation.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { taskRetryRunAncestry } from "./recovery-run-ancestry.js";
import { hasVerifiedWorkspaceRepair } from "./workspace-recovery-receipt.js";
import { isInterruptedNativePreparation } from "./cancelled-native-startup.js";
import { isPreDispatchExecutionWaitVerified } from "./pre-dispatch-execution-wait.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { currentControllerProcessStamp } from "./controller-process-identity.js";

describe("durable task Retry admission", () => {
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    const externalUrl = process.env.PAPERCLIP_TASK_RETRY_TEST_DATABASE_URL;
    if (externalUrl) {
      await applyPendingMigrations(externalUrl);
      db = createDb(externalUrl);
    } else {
      postgres = await startEmbeddedPostgresTestDatabase("task-retry-");
      db = createDb(postgres.connectionString);
    }
  }, 30_000);
  afterAll(async () => { await db?.$client.end(); await postgres?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retry company", issuePrefix: `T${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue saved work", status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "failed",
      contextSnapshot: { issueId }, finishedAt: new Date() });
    return { db, companyId, issueId, actorId: "board", observedRunId: runId, idempotencyKey: randomUUID() };
  }
  it.each(["valid", "wrong_run", "wrong_actor", "wrong_source", "wrong_generation", "unadmitted", "missing_authorization"])(
    "dispatches a preparation Retry with no recovery-action row only from its exact admitted receipt: %s", async state => {
      const input = await seed();
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, input.issueId));
      const [source] = await db.update(heartbeatRuns).set({ runtimeMode: "legacy", errorCode: "setup_failed",
        executionStage: "preparing", runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      }).where(eq(heartbeatRuns.id, input.observedRunId)).returning();
      const receipt = await requestTaskRetry(input), successorRunId = randomUUID();
      const continuation = await db.transaction(async tx => {
        await tx.select().from(issues).where(eq(issues.id, input.issueId)).for("update");
        const result = await admitExplicitNativeContinuation({ db: tx as unknown as Db,
          companyId: input.companyId, issueId: input.issueId, agentId: source.agentId,
          actorId: input.actorId, actorType: "user", reason: "task_retry", commentId: null,
          successorRunId, taskRetryRequestId: receipt.requestId!,
        });
        await tx.insert(heartbeatRuns).values({ id: successorRunId, companyId: input.companyId, agentId: source.agentId,
          issueId: input.issueId, status: "queued", contextSnapshot: { issueId: input.issueId } });
        await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: successorRunId })
          .where(eq(agentWakeupRequests.id, receipt.requestId!));
        return result;
      });
      expect(continuation).toMatchObject({ previousRunId: source.id, taskRetryRequestId: receipt.requestId });
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, input.issueId))).toHaveLength(0);
      const [admitted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      const taskRetry = admitted.payload!.taskRetry as Record<string, unknown>;
      if (state !== "valid") await db.update(agentWakeupRequests).set({
        ...(state === "wrong_run" ? { runId: source.id } : {}),
        ...(state === "wrong_actor" ? { requestedByActorId: "other-user" } : {}),
        ...(state === "unadmitted" ? { status: "deferred_issue_execution" } : {}),
        ...(state === "wrong_source" ? { payload: { ...admitted.payload, taskRetry: { ...taskRetry, sourceRunId: randomUUID() } } } : {}),
        ...(state === "wrong_generation" ? { payload: { ...admitted.payload, taskRetry: { ...taskRetry, generationId: randomUUID() } } } : {}),
        ...(state === "missing_authorization" ? { payload: { ...admitted.payload,
          taskRetry: Object.fromEntries(Object.entries(taskRetry).filter(([key]) => key !== "continuation")) } } : {}),
      }).where(eq(agentWakeupRequests.id, admitted.id));
      const result = buildExecutionContinuation({ db, companyId: input.companyId, issueId: input.issueId,
        agentId: source.agentId, runId: successorRunId,
        context: { issueId: input.issueId, explicitUserContinuation: continuation }, summary: null, exposeLowTrustRaw: false });
      if (state === "valid") await expect(result).resolves.toMatchObject({ interruptedRunId: source.id });
      else await expect(result).rejects.toThrow("continuation_user_authorization_missing");
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id)))[0])
        .toMatchObject({ status: "failed", resultJson: source.resultJson });
    });
  // A run admitted by Retry can fail before provider dispatch, for example when
  // a saved-workspace download is reset. Its bounded transient retry carries
  // the same Retry authority, recorded for the new run.
  async function seedFailedRetryAdmittedRun() {
    const input = await seed();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, input.issueId));
    const [source] = await db.update(heartbeatRuns).set({ runtimeMode: "legacy", errorCode: "setup_failed",
      executionStage: "preparing", runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, input.observedRunId)).returning();
    const receipt = await requestTaskRetry(input), parentId = randomUUID();
    const continuation = await db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, input.issueId)).for("update");
      const result = await admitExplicitNativeContinuation({ db: tx as unknown as Db,
        companyId: input.companyId, issueId: input.issueId, agentId: source.agentId,
        actorId: input.actorId, actorType: "user", reason: "task_retry", commentId: null,
        successorRunId: parentId, taskRetryRequestId: receipt.requestId!,
      });
      await tx.insert(heartbeatRuns).values({ id: parentId, companyId: input.companyId, agentId: source.agentId,
        issueId: input.issueId, status: "queued", contextSnapshot: { issueId: input.issueId } });
      await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: parentId })
        .where(eq(agentWakeupRequests.id, receipt.requestId!));
      return result;
    });
    expect(continuation).toMatchObject({ previousRunId: source.id, commentId: null, taskRetryRequestId: receipt.requestId });
    const now = new Date();
    const [parent] = await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "failed", responsibleUserId: input.actorId,
      errorCode: "remote_workspace_restore_failed", executionStage: "preparing", startedAt: now, finishedAt: now,
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        remoteWorkspaceRestore: { step: "snapshot_download", retryable: true } },
      contextSnapshot: { issueId: input.issueId, wakeReason: "task_retry", taskRetryRequestId: receipt.requestId,
        previousRunId: source.id, explicitUserContinuation: continuation },
    }).where(eq(heartbeatRuns.id, parentId)).returning();
    await db.update(issues).set({ status: "in_progress", executionRunId: parent.id }).where(eq(issues.id, input.issueId));
    return { input, source, parent, now, retryRequestId: receipt.requestId! };
  }
  const dispatchRun = (input: { companyId: string; issueId: string }, run: typeof heartbeatRuns.$inferSelect) =>
    buildExecutionContinuation({ db, companyId: input.companyId, issueId: input.issueId, agentId: run.agentId,
      runId: run.id, context: run.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
  it("retries a transient preparation failure of a Retry-admitted run under the same Retry authority", async () => {
    const f = await seedFailedRetryAdmittedRun();
    await expect(dispatchRun(f.input, f.parent)).resolves.toMatchObject({ interruptedRunId: f.source.id });
    const heartbeat = heartbeatService(db);
    const first = await heartbeat.scheduleBoundedRetry(f.parent.id, { now: f.now, delayMs: 1000 });
    expect(first.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled") return;
    expect(first.run).toMatchObject({ retryOfRunId: f.parent.id, scheduledRetryAttempt: 1 });
    expect(first.run.contextSnapshot?.explicitUserContinuation).toEqual({
      previousRunId: f.parent.id, commentId: null, taskRetryRequestId: f.retryRequestId });
    // The Retry receipt stays bound to the run it admitted.
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.retryRequestId)))[0])
      .toMatchObject({ status: "coalesced", runId: f.parent.id });
    await expect(dispatchRun(f.input, first.run)).resolves.toMatchObject({ interruptedRunId: f.parent.id });
    // A repeated request adopts the same successor without another receipt.
    expect(await heartbeat.scheduleBoundedRetry(f.parent.id, { now: f.now })).toMatchObject({
      outcome: "scheduled", run: { id: first.run.id } });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.input.issueId)))
      .toHaveLength(1);
    // A second transient failure retries from its immediate parent, then the budget ends.
    const later = new Date(f.now.getTime() + 2000);
    const [failedFirst] = await db.update(heartbeatRuns).set({ status: "failed", errorCode: "remote_workspace_restore_failed",
      startedAt: later, finishedAt: later, resultJson: f.parent.resultJson }).where(eq(heartbeatRuns.id, first.run.id)).returning();
    await db.update(issues).set({ executionRunId: failedFirst.id }).where(eq(issues.id, f.input.issueId));
    const second = await heartbeat.scheduleBoundedRetry(failedFirst.id, { now: later });
    expect(second.outcome).toBe("scheduled");
    if (second.outcome !== "scheduled") return;
    expect(second.run).toMatchObject({ retryOfRunId: failedFirst.id, scheduledRetryAttempt: 2 });
    await expect(dispatchRun(f.input, second.run)).resolves.toMatchObject({ interruptedRunId: failedFirst.id });
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "remote_workspace_restore_failed",
      startedAt: later, finishedAt: later }).where(eq(heartbeatRuns.id, second.run.id));
    await db.update(issues).set({ executionRunId: second.run.id }).where(eq(issues.id, f.input.issueId));
    expect(await heartbeat.scheduleBoundedRetry(second.run.id, { now: later })).toMatchObject({ outcome: "retry_exhausted" });
    // Removing the successor's own receipt reproduces the dispatch refusal.
    const receipts = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.input.issueId));
    expect(receipts).toHaveLength(2);
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id,
      receipts.find(row => (row.evidence.explicitUserContinuation as Record<string, unknown>).runId === second.run.id)!.id));
    await expect(dispatchRun(f.input, second.run)).rejects.toThrow("continuation_user_authorization_missing");
  });
  it.each(["wrong_actor", "unadmitted", "wrong_generation", "other_run", "chat_retry", "fresh_workspace", "reassigned", "superseded"] as const)(
    "does not lend Retry authority to an automatic retry after %s", async kind => {
      const f = await seedFailedRetryAdmittedRun();
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.retryRequestId));
      const taskRetry = wake.payload!.taskRetry as Record<string, unknown>;
      if (["wrong_actor", "unadmitted", "wrong_generation", "other_run", "chat_retry"].includes(kind))
        await db.update(agentWakeupRequests).set({
          ...(kind === "wrong_actor" ? { requestedByActorId: "other-user" } : {}),
          ...(kind === "unadmitted" ? { status: "deferred_issue_execution" } : {}),
          ...(kind === "other_run" ? { runId: f.source.id } : {}),
          ...(kind === "wrong_generation" ? { payload: { ...wake.payload, taskRetry: { ...taskRetry, generationId: randomUUID() } } } : {}),
          ...(kind === "chat_retry" ? { payload: { ...wake.payload, taskRetry: { ...taskRetry, chatActionId: randomUUID() } } } : {}),
        }).where(eq(agentWakeupRequests.id, f.retryRequestId));
      if (kind === "fresh_workspace") await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.parent.contextSnapshot,
        explicitUserContinuation: { ...(f.parent.contextSnapshot!.explicitUserContinuation as Record<string, unknown>),
          readiness: { mode: "fresh_isolated_workspace", retryIntentId: f.retryRequestId, sourceRunId: f.source.id, retainedSourceIds: [] } } },
      }).where(eq(heartbeatRuns.id, f.parent.id));
      if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.input.issueId));
      if (kind === "superseded") await db.insert(heartbeatRuns).values({ companyId: f.input.companyId, agentId: f.parent.agentId,
        status: "succeeded", contextSnapshot: { issueId: f.input.issueId }, createdAt: new Date(f.now.getTime() + 1000) });
      const result = await heartbeatService(db).scheduleBoundedRetry(f.parent.id, { now: f.now });
      expect(result.outcome).not.toBe("scheduled");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.parent.id))).toHaveLength(0);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.input.issueId)))
        .toHaveLength(0);
    });
  // Production shape (staging upgrades): a person's Retry admitted a run that was
  // still preparing, with no provider work started, when the upgrade stopped its
  // server gracefully. The interruption is not a failure and the Retry already
  // authorized this work, so recovery continues it with no new click.
  async function seedPreparingRetryAdmittedRun() {
    const f = await seedFailedRetryAdmittedRun();
    const [parent] = await db.update(heartbeatRuns).set({ status: "running", errorCode: null, finishedAt: null,
      controllerBootId: legacyControllerBootId, controllerProcess: currentControllerProcessStamp(),
      controllerLeaseExpiresAt: sql`clock_timestamp() + interval '1 minute'`,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, f.parent.id)).returning();
    return { ...f, parent };
  }
  const successorsOf = (runId: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  it("continues a Retry-admitted run that a graceful shutdown stopped while it was preparing", async () => {
    const f = await seedPreparingRetryAdmittedRun();
    const drained = await heartbeatService(db).drainRunningRunsForShutdown("SIGTERM", new Date(), [f.parent.id]);
    expect(drained.interruptedRunIds).toEqual([f.parent.id]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.parent.id)))[0])
      .toMatchObject({ status: "interrupted", errorCode: "server_shutdown_interrupted" });
    const successors = await successorsOf(f.parent.id);
    // The uncharged preparation lane: due at once, no failure retry spent.
    expect(successors).toEqual([expect.objectContaining({ status: "scheduled_retry",
      scheduledRetryReason: "interrupted_preparation", scheduledRetryAttempt: 1 })]);
    expect(drained.retryRunIds).toEqual([successors[0]!.id]);
    expect(successors[0]!.contextSnapshot?.executionRetryAccounting).toMatchObject({ failureRetries: 0, interruptedPreparations: 1 });
    expect(successors[0]!.contextSnapshot?.explicitUserContinuation).toEqual({
      previousRunId: f.parent.id, commentId: null, taskRetryRequestId: f.retryRequestId });
    // The continuation holds the task's claim, and dispatch accepts it from its own receipt.
    expect((await db.select().from(issues).where(eq(issues.id, f.input.issueId)))[0]!.executionRunId).toBe(successors[0]!.id);
    await expect(dispatchRun(f.input, successors[0]!)).resolves.toMatchObject({ interruptedRunId: f.parent.id });
    // The replacement servers' own sweeps reuse the one continuation.
    await Promise.all([heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.input.companyId }),
      heartbeatService(db).scheduleBoundedRetry(f.parent.id)]);
    expect(await successorsOf(f.parent.id)).toEqual([expect.objectContaining({ id: successors[0]!.id })]);
  });
  // Tasks a release without this fix already refused: the refusal released the
  // task's claim and left it in progress with no run. The periodic sweep admits
  // them now, once, with no manual step.
  async function seedRefusedShutdownContinuation(chained = false) {
    const f = await seedPreparingRetryAdmittedRun();
    let interruptedId = f.parent.id;
    if (chained) {
      // The person's Retry run failed transiently first; its automatic retry
      // (with its own receipt) is the run the shutdown stopped.
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "remote_workspace_restore_failed", finishedAt: f.now })
        .where(eq(heartbeatRuns.id, f.parent.id));
      const first = await heartbeatService(db).scheduleBoundedRetry(f.parent.id, { now: f.now, delayMs: 0 });
      if (first.outcome !== "scheduled") throw new Error(`automatic retry not scheduled: ${first.outcome}`);
      interruptedId = first.run.id;
    }
    const finishedAt = new Date(Date.now() - 60_000);
    const [parent] = await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "server_shutdown_interrupted",
      error: "Interrupted by graceful server shutdown (SIGTERM)", startedAt: finishedAt, finishedAt,
      runtimeMode: "legacy", executionStage: "preparing", controllerLeaseExpiresAt: null, controllerBootId: randomUUID(),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, interruptedId)).returning();
    await db.update(issues).set({ status: "in_progress", executionRunId: null, executionLockedAt: null })
      .where(eq(issues.id, f.input.issueId));
    return { ...f, parent };
  }
  it.each([{ chained: false, name: "Retry run" }, { chained: true, name: "automatic retry of a Retry run" }])(
    "continues a task an earlier release left waiting after refusing its shutdown continuation: $name", async ({ chained }) => {
      const f = await seedRefusedShutdownContinuation(chained);
      const scope = { companyId: f.input.companyId };
      await Promise.all([heartbeatService(db).reconcileStrandedAssignedIssues(scope),
        heartbeatService(db).reconcileStrandedAssignedIssues(scope)]);
      const successors = await successorsOf(f.parent.id);
      expect(successors).toEqual([expect.objectContaining({ status: "scheduled_retry",
        scheduledRetryReason: "interrupted_preparation" })]);
      expect(successors[0]!.contextSnapshot?.explicitUserContinuation).toEqual({
        previousRunId: f.parent.id, commentId: null, taskRetryRequestId: f.retryRequestId });
      // The released claim passes to the continuation, as on the shutdown path.
      expect((await db.select().from(issues).where(eq(issues.id, f.input.issueId)))[0]!.executionRunId).toBe(successors[0]!.id);
      await expect(dispatchRun(f.input, successors[0]!)).resolves.toMatchObject({ interruptedRunId: f.parent.id });
    });
  it.each(["provider_work_started", "no_bootstrap_proof", "operator_interrupt", "claimed_by_other_run", "reassigned",
    "superseded", "wrong_actor", "cancelled_task"] as const)(
    "does not continue a shutdown-interrupted Retry run without its original authority: %s", async kind => {
      const f = await seedRefusedShutdownContinuation();
      if (kind === "provider_work_started" || kind === "no_bootstrap_proof") await db.update(heartbeatRuns).set({
        resultJson: kind === "no_bootstrap_proof" ? {} : { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } },
      }).where(eq(heartbeatRuns.id, f.parent.id));
      if (kind === "operator_interrupt") await db.update(heartbeatRuns).set({ errorCode: "operator_interrupted" })
        .where(eq(heartbeatRuns.id, f.parent.id));
      if (kind === "claimed_by_other_run") {
        const [other] = await db.insert(heartbeatRuns).values({ companyId: f.input.companyId, agentId: f.parent.agentId,
          status: "failed", finishedAt: f.parent.finishedAt, createdAt: new Date(f.parent.createdAt.getTime() - 1000),
          contextSnapshot: { issueId: f.input.issueId } }).returning();
        await db.update(issues).set({ executionRunId: other.id }).where(eq(issues.id, f.input.issueId));
      }
      if (kind === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.input.issueId));
      if (kind === "cancelled_task") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.input.issueId));
      if (kind === "superseded") await db.insert(heartbeatRuns).values({ companyId: f.input.companyId, agentId: f.parent.agentId,
        status: "succeeded", contextSnapshot: { issueId: f.input.issueId }, createdAt: new Date() });
      if (kind === "wrong_actor") await db.update(agentWakeupRequests).set({ requestedByActorId: "other-user" })
        .where(eq(agentWakeupRequests.id, f.retryRequestId));
      const [parent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.parent.id));
      const result = await heartbeatService(db).scheduleBoundedRetry(parent.id, { now: new Date() });
      expect(result.outcome).not.toBe("scheduled");
      expect(await successorsOf(f.parent.id)).toHaveLength(0);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.input.issueId)))
        .toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, f.input.issueId)))[0]!.executionRunId)
        .toEqual(kind === "claimed_by_other_run" ? expect.any(String) : null);
    });
  // Staging: a Retry that selected a fresh isolated
  // workspace (at admission, or when its preparation found the saved files
  // unrestorable) was stopped by an upgrade before provider work. The person
  // asked for that fresh attempt and it never ran, so it continues as the same
  // attempt: the successor prepares the workspace this Retry selected.
  async function seedFreshAttemptStoppedByShutdown(selectedAt: "admission" | "preparation") {
    const f = await seedRefusedShutdownContinuation();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.retryRequestId));
    await db.update(agentWakeupRequests).set({ payload: { ...wake.payload,
      taskRetry: { ...(wake.payload!.taskRetry as Record<string, unknown>), strategy: "fresh_isolated_workspace" } } })
      .where(eq(agentWakeupRequests.id, f.retryRequestId));
    const readiness = { mode: "fresh_isolated_workspace", retryIntentId: f.retryRequestId, sourceRunId: f.source.id,
      retainedSourceIds: [] as string[] };
    if (selectedAt === "admission") await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.parent.contextSnapshot,
      explicitUserContinuation: { ...(f.parent.contextSnapshot!.explicitUserContinuation as Record<string, unknown>), readiness } },
    }).where(eq(heartbeatRuns.id, f.parent.id));
    const [parent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.parent.id));
    return { ...f, parent, readiness };
  }
  it.each(["admission", "preparation"] as const)(
    "continues a fresh-workspace Retry that a shutdown stopped before provider work (selected at %s)", async selectedAt => {
      const f = await seedFreshAttemptStoppedByShutdown(selectedAt);
      const refusal = { intentId: f.retryRequestId, workspaceId: randomUUID(), leaseId: randomUUID() };
      if (selectedAt === "preparation") {
        await db.insert(environmentLeases).values({ id: refusal.leaseId, companyId: f.input.companyId,
          heartbeatRunId: f.parent.id, issueId: f.input.issueId, status: "released",
          releasedAt: new Date(), cleanupStatus: "success", provider: "plugin:test:tasks" });
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.parent.contextSnapshot, retryWorkspaceRefusal: refusal } })
          .where(eq(heartbeatRuns.id, f.parent.id));
      }
      const scope = { companyId: f.input.companyId };
      await Promise.all([heartbeatService(db).reconcileStrandedAssignedIssues(scope),
        heartbeatService(db).reconcileStrandedAssignedIssues(scope)]);
      const successors = await successorsOf(f.parent.id);
      expect(successors).toEqual([expect.objectContaining({ status: "scheduled_retry" })]);
      const successor = successors[0]!;
      expect(successor.contextSnapshot?.explicitUserContinuation).toEqual({
        previousRunId: f.parent.id, commentId: null, taskRetryRequestId: f.retryRequestId });
      expect((await db.select().from(issues).where(eq(issues.id, f.input.issueId)))[0]!.executionRunId).toBe(successor.id);
      await expect(dispatchRun(f.input, successor)).resolves.toMatchObject({ interruptedRunId: f.parent.id });
      // Preparation of the successor selects the same fresh attempt.
      expect(await readFreshWorkspaceReadiness(db, successor)).toEqual(f.readiness);
      if (selectedAt === "preparation") {
        expect(successor.contextSnapshot?.retryWorkspaceRefusal).toEqual({ ...refusal, leaseId: null });
        const [parent] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.parent.id));
        expect(parent.contextSnapshot?.retryWorkspaceRefusal).toEqual(refusal);
      }
      // A second upgrade stops the continuation too: it carries the same attempt on.
      const finishedAt = new Date(Date.now() - 30_000);
      const [stopped] = await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "server_shutdown_interrupted",
        startedAt: finishedAt, finishedAt, runtimeMode: "legacy", executionStage: "preparing", controllerBootId: randomUUID(),
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      }).where(eq(heartbeatRuns.id, successor.id)).returning();
      await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.input.issueId));
      await heartbeatService(db).reconcileStrandedAssignedIssues(scope);
      const next = await successorsOf(stopped.id);
      expect(next).toHaveLength(1);
      await expect(dispatchRun(f.input, next[0]!)).resolves.toMatchObject({ interruptedRunId: stopped.id });
      expect(await readFreshWorkspaceReadiness(db, next[0]!)).toEqual(f.readiness);
    });
  it("leaves the parent verification lease with cleanup before scheduling a shutdown successor", async () => {
    const f = await seedFreshAttemptStoppedByShutdown("preparation");
    const refusal = { intentId: f.retryRequestId, workspaceId: randomUUID(), leaseId: randomUUID() };
    await db.insert(environmentLeases).values({ id: refusal.leaseId, companyId: f.input.companyId,
      heartbeatRunId: f.parent.id, issueId: f.input.issueId, status: "pending_cleanup",
      releasedAt: new Date(), cleanupStatus: "failed", provider: "plugin:test:tasks" });
    const [parent] = await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.parent.contextSnapshot, retryWorkspaceRefusal: refusal } })
      .where(eq(heartbeatRuns.id, f.parent.id)).returning();
    expect(await heartbeatService(db).scheduleBoundedRetry(parent.id, { now: new Date() }))
      .toMatchObject({ outcome: "not_scheduled", errorCode: "workspace_verification_cleanup_pending" });
    expect(await successorsOf(parent.id)).toHaveLength(0);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, refusal.leaseId));
    expect(lease).toMatchObject({ status: "pending_cleanup", heartbeatRunId: parent.id });
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success" })
      .where(eq(environmentLeases.id, refusal.leaseId));
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.input.companyId });
    const successors = await successorsOf(parent.id);
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot?.retryWorkspaceRefusal).toEqual({ ...refusal, leaseId: null });
    await expect(dispatchRun(f.input, successors[0])).resolves.toMatchObject({ interruptedRunId: parent.id });
    expect(await readFreshWorkspaceReadiness(db, successors[0])).toEqual(f.readiness);
  });
  it.each(["other_retry", "other_source", "failed_not_stopped"] as const)(
    "keeps a fresh-workspace Retry's own contract when it does not match: %s", async kind => {
      const f = await seedFreshAttemptStoppedByShutdown("admission");
      const explicit = f.parent.contextSnapshot!.explicitUserContinuation as Record<string, unknown>;
      if (kind !== "failed_not_stopped") await db.update(heartbeatRuns).set({ contextSnapshot: { ...f.parent.contextSnapshot,
        explicitUserContinuation: { ...explicit, readiness: { ...f.readiness,
          ...(kind === "other_retry" ? { retryIntentId: randomUUID() } : { sourceRunId: randomUUID() }) } } },
      }).where(eq(heartbeatRuns.id, f.parent.id));
      else await db.update(heartbeatRuns).set({ status: "failed", errorCode: "remote_workspace_restore_failed" })
        .where(eq(heartbeatRuns.id, f.parent.id));
      if (kind === "failed_not_stopped") await db.update(issues).set({ executionRunId: f.parent.id }).where(eq(issues.id, f.input.issueId));
      const result = await heartbeatService(db).scheduleBoundedRetry(f.parent.id, { now: new Date() });
      expect(result.outcome).not.toBe("scheduled");
      expect(await successorsOf(f.parent.id)).toHaveLength(0);
    });
  // Staging: the Retry replaced a native session that had
  // left session state behind. The sweep treated that state as the task's live
  // path and never offered the stopped Retry run its continuation.
  it.each(["unfinished_goal", "superseded_native_finalization"] as const)(
    "continues a shutdown-stopped Retry whose replaced session left state behind: %s", async state => {
      const f = await seedRefusedShutdownContinuation();
      if (state === "unfinished_goal") await db.insert(agentTaskSessions).values({ companyId: f.input.companyId,
        agentId: f.parent.agentId, adapterType: "paperclip_runner", taskKey: f.input.issueId, goalStatus: "active" });
      else {
        const [native] = await db.insert(heartbeatRuns).values({ companyId: f.input.companyId, agentId: f.parent.agentId,
          status: "failed", runtimeMode: "native", errorCode: "native_continuation_requires_reconciliation", nativeIssueId: f.input.issueId,
          nativePhase: "retryable_failure", createdAt: new Date(f.parent.createdAt.getTime() - 5000),
          finishedAt: new Date(f.parent.createdAt.getTime() - 4000), contextSnapshot: { issueId: f.input.issueId } }).returning();
        await db.insert(nativeRunFinalizations).values({ runId: native.id, companyId: f.input.companyId, issueId: f.input.issueId,
          phase: "retryable_failure", attempt: 2, recoveryState: "resuming_session",
          failureDetail: { replacementDenied: "explicit_user_continuation" } });
      }
      await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.input.companyId });
      const successors = await successorsOf(f.parent.id);
      expect(successors).toEqual([expect.objectContaining({ status: "scheduled_retry" })]);
      await expect(dispatchRun(f.input, successors[0]!)).resolves.toMatchObject({ interruptedRunId: f.parent.id });
    });
  it("looks again at a shutdown-stopped Retry run once another server's lease on it lapses", async () => {
    const f = await seedRefusedShutdownContinuation();
    await db.insert(agentTaskSessions).values({ companyId: f.input.companyId, agentId: f.parent.agentId,
      adapterType: "paperclip_runner", taskKey: f.input.issueId, goalStatus: "active" });
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: sql`clock_timestamp() + interval '1 minute'` })
      .where(eq(heartbeatRuns.id, f.parent.id));
    const deadlines: number[] = [];
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.input.companyId,
      onDeferredDeadline: at => deadlines.push(at) });
    expect(await successorsOf(f.parent.id)).toHaveLength(0);
    expect(deadlines).toEqual([expect.any(Number)]);
    expect(deadlines[0]!).toBeGreaterThan(Date.now());
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: null }).where(eq(heartbeatRuns.id, f.parent.id));
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.input.companyId });
    expect(await successorsOf(f.parent.id)).toHaveLength(1);
  });
  // A refusal that cannot succeed later ends automatic recovery once, with a
  // plain notice and a Retry that works, instead of a refusal every sweep.
  it("escalates a refused shutdown continuation once instead of refusing it on every sweep", async () => {
    const f = await seedRefusedShutdownContinuation();
    await db.update(agentWakeupRequests).set({ requestedByActorId: "other-user" }).where(eq(agentWakeupRequests.id, f.retryRequestId));
    const scope = { companyId: f.input.companyId };
    await heartbeatService(db).reconcileStrandedAssignedIssues(scope);
    await heartbeatService(db).reconcileStrandedAssignedIssues(scope);
    expect(await successorsOf(f.parent.id)).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, f.input.issueId)))[0]).toMatchObject({ status: "blocked" });
    const notices = await db.select().from(issueComments).where(eq(issueComments.issueId, f.input.issueId));
    expect(notices.filter(row => row.body.includes("Press Retry to continue"))).toHaveLength(1);
    const refusals = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.parent.id),
      sql`${heartbeatRunEvents.message} like 'The automatic retry could not revalidate%'`));
    expect(refusals).toHaveLength(1);
  });
  // Staging: a Retry run failed before provider work with a transient
  // sandbox resume failure. The sweep escalated the task while the run's own
  // executor was still settling it, which cleared the claim its bounded retry
  // needed. The sweep now leaves the task to that executor.
  it("leaves a failed Retry run to its own executor while that executor still settles it", async () => {
    const f = await seedFailedRetryAdmittedRun();
    // The server running the failed run is still settling it: its controller
    // lease is live until it has scheduled the retry and released the claim.
    await db.update(heartbeatRuns).set({ errorCode: "reusable_sandbox_resume_failed", controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: sql`clock_timestamp() + interval '1 minute'`,
    }).where(eq(heartbeatRuns.id, f.parent.id));
    await db.update(issues).set({ status: "in_progress", executionRunId: f.parent.id }).where(eq(issues.id, f.input.issueId));
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.input.companyId });
    expect((await db.select().from(issues).where(eq(issues.id, f.input.issueId)))[0])
      .toMatchObject({ status: "in_progress", executionRunId: f.parent.id });
    const retry = await heartbeatService(db).scheduleBoundedRetry(f.parent.id, { now: new Date() });
    expect(retry.outcome).toBe("scheduled");
    if (retry.outcome !== "scheduled") return;
    await expect(dispatchRun(f.input, retry.run)).resolves.toMatchObject({ interruptedRunId: f.parent.id });
  });
  // Staging shape: a person's Retry failed before provider work because the
  // saved sandbox resume timed out. The run is already `failed`, but its
  // executor has not scheduled the bounded retry yet: settling took longer than
  // the controller lease that stopped renewing at the failed write, or the
  // server running it stopped. Another server's sweep then reads the task.
  it.each(["slow_executor", "executor_gone"] as const)(
    "retries a failed Retry run's transient preparation failure when the sweep reaches it first: %s", async executor => {
      const f = await seedFailedRetryAdmittedRun();
      await db.update(heartbeatRuns).set({ errorCode: "reusable_sandbox_resume_failed", controllerBootId: randomUUID(),
        controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      }).where(eq(heartbeatRuns.id, f.parent.id));
      const heartbeat = heartbeatService(db);
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.input.companyId });
      expect((await db.select().from(issues).where(eq(issues.id, f.input.issueId)))[0]).toMatchObject({ status: "in_progress" });
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.parent.id));
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "transient_failure",
        scheduledRetryAttempt: 1 });
      if (executor === "slow_executor") {
        // The executor's own scheduling adopts the sweep's successor.
        expect(await heartbeat.scheduleBoundedRetry(f.parent.id, { now: new Date() })).toMatchObject({
          outcome: "scheduled", run: { id: successors[0].id } });
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.parent.id))).toHaveLength(1);
      }
      await expect(dispatchRun(f.input, successors[0])).resolves.toMatchObject({ interruptedRunId: f.parent.id });
    });
  it.each(["reusable_sandbox_resume_failed", "repository_catalog_unavailable"])(
    "escalates a failed Retry run's transient preparation failure once when the scheduler declines it permanently: %s", async errorCode => {
    const f = await seedFailedRetryAdmittedRun();
    // An external Dot execution is never retried by the bounded scheduler.
    await db.update(heartbeatRuns).set({ errorCode,
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" },
        nativeExecutionInput: { provider: { kind: "openai_dot" } } },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, f.parent.id));
    const heartbeat = heartbeatService(db);
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.input.companyId });
    expect((await db.select().from(issues).where(eq(issues.id, f.input.issueId)))[0]).toMatchObject({ status: "blocked" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.parent.id))).toHaveLength(0);
    const notices = async () => (await db.select().from(issueComments).where(eq(issueComments.issueId, f.input.issueId))).length;
    const escalated = await notices();
    await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.input.companyId });
    expect(await notices()).toBe(escalated);
  });
  it("still escalates a failed Retry run's transient preparation failure once its bounded retries are spent", async () => {
    const f = await seedFailedRetryAdmittedRun();
    await db.update(heartbeatRuns).set({ errorCode: "reusable_sandbox_resume_failed",
      scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, f.parent.id));
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.input.companyId });
    expect((await db.select().from(issues).where(eq(issues.id, f.input.issueId)))[0]).toMatchObject({ status: "blocked" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.parent.id))).toHaveLength(0);
  });
  async function seedRefusedRetry() {
    const input = await seed();
    const now = Date.now();
    const [source] = await db.update(heartbeatRuns).set({
      runtimeMode: "legacy", errorCode: "setup_failed", executionStage: "preparing",
      createdAt: new Date(now - 3000), finishedAt: new Date(now - 2000),
      runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, input.observedRunId)).returning();
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: input.companyId, sourceIssueId: input.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: source.id,
      status: "resolved", outcome: "blocked", nextAction: "Continue after recovery.",
      evidence: { runId: source.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }).returning();
    const [refused] = await db.insert(heartbeatRuns).values({ companyId: input.companyId, agentId: source.agentId,
      issueId: input.issueId, status: "cancelled", errorCode: "execution_reconciliation_required",
      retryOfRunId: source.id, createdAt: new Date(now - 1000), finishedAt: new Date(now - 500),
      contextSnapshot: { issueId: input.issueId, retryOfRunId: source.id },
      resultJson: { stopReason: "execution_reconciliation_required", timeoutSource: "stale_queued_run_gate",
        executionWait: { issueId: input.issueId, recoveryActionId: hold.id } } }).returning();
    return { input: { ...input, actorSource: "local_implicit", observedRunId: refused.id }, source, refused, hold };
  }

  it.each(["ready", "provider_event", "provider_event_with_hold", "retained_lease", "started", "missing_receipt", "foreign_receipt", "live_ancestor"] as const)(
    "admits Retry after a refused automatic attempt only with no provider work: %s", async gate => {
    const { input, source, refused, hold } = await seedRefusedRetry();
    if (gate === "provider_event_with_hold") await db.insert(issueRecoveryActions).values({ companyId: input.companyId, sourceIssueId: input.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: refused.id,
      status: "resolved", outcome: "blocked", nextAction: "Continue after recovery.", evidence: { runId: refused.id } });
    if (gate === "provider_event" || gate === "provider_event_with_hold") await db.insert(heartbeatRunEvents).values({ companyId: input.companyId,
      agentId: source.agentId, runId: refused.id, seq: 1, eventType: "tool.execution.started" });
    if (gate === "retained_lease") await db.insert(environmentLeases).values({ companyId: input.companyId,
      issueId: input.issueId, heartbeatRunId: refused.id, provider: "local", status: "released", leasePolicy: "ephemeral",
      releasedAt: new Date(), cleanupStatus: "success" });
    if (gate === "started") await db.update(heartbeatRuns).set({ startedAt: refused.createdAt }).where(eq(heartbeatRuns.id, refused.id));
    if (gate === "missing_receipt") await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, refused.id));
    if (gate === "foreign_receipt") await db.update(heartbeatRuns).set({ resultJson: { ...refused.resultJson,
      executionWait: { issueId: randomUUID(), recoveryActionId: hold.id } } }).where(eq(heartbeatRuns.id, refused.id));
    if (gate === "live_ancestor") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, source.id));
    const receipt = await requestTaskRetry(input);
    expect(receipt).toMatchObject({ accepted: true, observedRunId: refused.id });
    const successorRunId = randomUUID();
    const continuation = await db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, input.issueId)).for("update");
      const continuation = await admitExplicitNativeContinuation({ db: tx as unknown as Db, companyId: input.companyId,
        issueId: input.issueId, agentId: source.agentId, actorId: input.actorId, actorType: "user",
        reason: "task_retry", commentId: null, successorRunId, taskRetryRequestId: receipt.requestId! });
      if (continuation) {
        await tx.insert(heartbeatRuns).values({ id: successorRunId, companyId: input.companyId, agentId: source.agentId,
          issueId: input.issueId, status: "queued", contextSnapshot: { issueId: input.issueId, explicitUserContinuation: continuation } });
        await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: successorRunId }).where(eq(agentWakeupRequests.id, receipt.requestId!));
      }
      return continuation;
    });
    if (gate === "ready") {
      expect(continuation).toMatchObject({ previousRunId: refused.id, taskRetryRequestId: receipt.requestId });
      await expect(buildExecutionContinuation({ db, companyId: input.companyId, issueId: input.issueId,
        agentId: source.agentId, runId: successorRunId, context: { issueId: input.issueId, explicitUserContinuation: continuation },
        summary: null, exposeLowTrustRaw: false })).resolves.toMatchObject({ interruptedRunId: refused.id });
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id)))[0].evidence.automaticRecovery)
        .toMatchObject({ actionOutcome: "unknown", replay: "explicit_user_continuation" });
    } else {
      expect(continuation).toBeNull();
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id)))[0].evidence.explicitUserContinuation)
        .toBeUndefined();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, successorRunId))).toHaveLength(0);
    }
  });

  async function seedRecoveredLostPreparation(refusedCount: number) {
    const { input, source, refused, hold } = await seedRefusedRetry();
    const workspaceId = randomUUID(), leaseId = randomUUID(), snapshotId = randomUUID();
    const snapshotOperationId = randomUUID(), recoveryOperationId = randomUUID();
    const providerLeaseId = `fixture-sandbox-${randomUUID()}`, sha256 = "a".repeat(64);
    const restore = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [leaseId] };
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: input.companyId,
      sourceIssueId: input.issueId, mode: "isolated_workspace", strategyType: "isolated_workspace", name: "Recovered work",
      metadata: { remoteWorkspace: { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId,
        source: { kind: "empty" }, location: null, writerRunId: null, dirty: false } } });
    const [recoveredSource] = await db.update(heartbeatRuns).set({ errorCode: "process_lost",
      startedAt: source.createdAt, controllerBootId: randomUUID(), controllerLeaseExpiresAt: source.finishedAt,
      runnerProfileJson: { ...source.runnerProfileJson, remoteWorkspace: { schema: "paperclip.remote-workspace-run.v1",
        workspaceId, leaseId, providerLeaseId, remoteCwd: "/fixture/saved-work", epoch: 1, state: "saved", snapshotId } },
      resultJson: { stopReason: "process_lost", executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: restore },
    }).where(eq(heartbeatRuns.id, source.id)).returning();
    await db.insert(environmentLeases).values({ id: leaseId, companyId: input.companyId, issueId: input.issueId,
      heartbeatRunId: source.id, executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId,
      status: "expired", leasePolicy: "ephemeral", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId: input.companyId,
        runId: source.id, leaseId, provider: "daytona", providerLeaseId, state: "destroyed", confirmedAt: new Date().toISOString() } } });
    await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId: input.companyId,
      executionWorkspaceId: workspaceId, sourceOperationId: snapshotOperationId, sourceRunId: source.id,
      generation: 1, epoch: 1, status: "committed", sha256 });
    const scope = { companyId: input.companyId, issueId: input.issueId, heartbeatRunId: source.id,
      executionWorkspaceId: workspaceId, status: "succeeded", finishedAt: new Date() };
    await db.insert(workspaceOperations).values([
      { ...scope, id: snapshotOperationId, phase: "remote_workspace_snapshot", metadata: { snapshotId, sha256, epoch: 1, generation: 1 } },
      { ...scope, id: recoveryOperationId, phase: "workspace_recovery", metadata: { recoveryActionId: hold.id,
        storage: "remote_workspace", leaseId, providerLeaseId, snapshotId, sha256, epoch: 1, generation: 1 } },
      { ...scope, phase: "workspace_finalize", metadata: { owningService: "workspace_recovery", preservationOperationIds: [recoveryOperationId] } },
    ]);
    await db.update(issueRecoveryActions).set({ evidence: { ...hold.evidence, workspaceRestoreFailure: "restore_failed",
      workspaceRestoreRecovery: restore, continuationDelivery: "invalidated",
      systemRecovery: { ...createSystemRecovery(source.id), state: "complete", phase: "reconcile_effects", attempts: 1,
        preservationOperationIds: [recoveryOperationId] },
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: source.id, status: "recovered",
        stage: "saving_receipts", attempt: 1, attemptLimit: 6, requestIds: [] } } }).where(eq(issueRecoveryActions.id, hold.id));
    let latest = refused;
    if (refusedCount === 2) [latest] = await db.insert(heartbeatRuns).values({ companyId: input.companyId,
      agentId: source.agentId, issueId: input.issueId, status: "cancelled", errorCode: refused.errorCode,
      retryOfRunId: refused.id, createdAt: new Date(refused.finishedAt!.getTime() + 1), finishedAt: new Date(),
      contextSnapshot: { issueId: input.issueId, retryOfRunId: refused.id }, resultJson: refused.resultJson }).returning();
    expect(await hasVerifiedWorkspaceRepair(db, recoveredSource)).toBe(true);
    expect(await isInterruptedNativePreparation(db, recoveredSource)).toBe(true);
    expect(await isPreDispatchExecutionWaitVerified(db, latest)).toBe(true);
    return { input: { ...input, observedRunId: latest.id }, source: recoveredSource, refused: latest,
      hold, leaseId, snapshotId };
  }

  it.each([1, 2])("dispatches a recovered process-lost preparation after %i refused automatic attempts", async refusedCount => {
    const { input, source, refused, hold } = await seedRecoveredLostPreparation(refusedCount);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, source.agentId));
    await db.insert(heartbeatRuns).values({ companyId: input.companyId, agentId: source.agentId, status: "running" });
    const receipt = await requestTaskRetry(input);
    expect((await requestTaskRetry({ ...input, idempotencyKey: randomUUID() })).requestId).toBe(receipt.requestId);
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeTaskRetry(input.companyId, receipt.requestId!),
      heartbeat.resumeTaskRetry(input.companyId, receipt.requestId!)]);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
    const queued = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.status, "queued")));
    expect(queued, JSON.stringify(wake.payload)).toHaveLength(1);
    expect(wake).toMatchObject({ status: "coalesced", runId: queued[0].id });
    await expect(dispatchRun(input, queued[0])).resolves.toMatchObject({ interruptedRunId: refused.id });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, refused.id)))[0])
      .toMatchObject({ status: "cancelled", resultJson: refused.resultJson });
    const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id));
    expect(settled.evidence.systemRecovery).toMatchObject({ attempts: 1, retriesUsed: 0 });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source.id)))[0])
      .toMatchObject({ status: "failed", resultJson: source.resultJson });
  });

  it.each(["provider_work_started", "provider_event", "native_checkpoint", "missing_bootstrap_proof",
    "missing_stop_receipt", "changed_snapshot", "pending_approval", "late_operator_stop", "agent_paused", "company_paused", "budget_hard_stop"] as const)(
    "holds a recovered process-lost preparation Retry when a current gate changes: %s", async gate => {
      const { input, source, hold, leaseId, snapshotId } = await seedRecoveredLostPreparation(2);
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, source.agentId));
      await db.insert(heartbeatRuns).values({ companyId: input.companyId, agentId: source.agentId, status: "running" });
      const receipt = await requestTaskRetry(input);
      if (gate === "provider_work_started" || gate === "missing_bootstrap_proof") await db.update(heartbeatRuns)
        .set({ resultJson: { ...source.resultJson, executionRecovery: { kind: "bootstrap",
          ...(gate === "provider_work_started" ? { providerWorkStarted: true } : {}) } } }).where(eq(heartbeatRuns.id, source.id));
      if (gate === "provider_event") await db.insert(heartbeatRunEvents).values({ companyId: input.companyId,
        agentId: source.agentId, runId: source.id, seq: 1, eventType: "tool.execution.started" });
      if (gate === "native_checkpoint") {
        await db.update(heartbeatRuns).set({ nativeIssueId: input.issueId }).where(eq(heartbeatRuns.id, source.id));
        await db.insert(nativeRunFinalizations).values({ companyId: input.companyId, issueId: input.issueId,
          runId: source.id, phase: "running", attempt: 1, controllerGeneration: 1 });
      }
      if (gate === "missing_stop_receipt") await db.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.id, leaseId));
      if (gate === "changed_snapshot") await db.update(executionWorkspaceSnapshots).set({ sha256: "b".repeat(64) })
        .where(eq(executionWorkspaceSnapshots.id, snapshotId));
      if (gate === "pending_approval") {
        const [approval] = await db.insert(approvals).values({ companyId: input.companyId, type: "hire_agent", status: "pending", payload: {} }).returning();
        await db.insert(issueApprovals).values({ companyId: input.companyId, issueId: input.issueId, approvalId: approval.id });
      }
      if (gate === "late_operator_stop") await db.update(issues).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(issues.id, input.issueId));
      if (gate === "agent_paused") await db.update(agents).set({ status: "paused", pausedAt: new Date() }).where(eq(agents.id, source.agentId));
      if (gate === "company_paused") await db.update(companies).set({ status: "paused", pausedAt: new Date() }).where(eq(companies.id, input.companyId));
      if (gate === "budget_hard_stop") {
        await db.insert(budgetPolicies).values({ companyId: input.companyId, scopeType: "company", scopeId: input.companyId,
          metric: "billed_cents", windowKind: "lifetime", amount: 1, notifyEnabled: false });
        await db.insert(costEvents).values({ companyId: input.companyId, agentId: source.agentId, heartbeatRunId: source.id,
          provider: "fixture", model: "fixture", costCents: 1, occurredAt: new Date() });
      }
      const heartbeat = heartbeatService(db);
      const attempts = await Promise.allSettled([heartbeat.resumeTaskRetry(input.companyId, receipt.requestId!),
        heartbeat.resumeTaskRetry(input.companyId, receipt.requestId!)]);
      for (const attempt of attempts) {
        if (["agent_paused", "company_paused", "budget_hard_stop"].includes(gate)) {
          expect(attempt.status).toBe("rejected");
          if (attempt.status === "rejected") {
            expect(attempt.reason).toBeInstanceOf(HttpError);
            expect(attempt.reason.status).toBe(409);
            expect(attempt.reason.message).toMatch(/not invokable|not active|budget hard-stop/);
          }
        } else expect(attempt.status).toBe("fulfilled");
      }
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
      if (!["late_operator_stop", "agent_paused", "company_paused", "budget_hard_stop"].includes(gate)) {
        expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id)))[0].evidence.explicitUserContinuation)
          .toBeUndefined();
      }
    });

  it("dispatches one Retry continuation after a refused automatic attempt", async () => {
    const { input, source, refused } = await seedRefusedRetry();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, source.agentId));
    await db.insert(heartbeatRuns).values({ companyId: input.companyId, agentId: source.agentId, status: "running" });
    const receipt = await requestTaskRetry(input);
    const duplicate = await requestTaskRetry({ ...input, idempotencyKey: randomUUID() });
    expect(duplicate.requestId).toBe(receipt.requestId);
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeTaskRetry(input.companyId, receipt.requestId!),
      heartbeat.resumeTaskRetry(input.companyId, receipt.requestId!)]);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
    const queued = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.status, "queued")));
    expect(queued, JSON.stringify(wake.payload)).toHaveLength(1);
    expect(wake).toMatchObject({ status: "coalesced", runId: queued[0].id });
    expect(queued[0].contextSnapshot).toMatchObject({ previousRunId: refused.id,
      explicitUserContinuation: { previousRunId: refused.id, taskRetryRequestId: receipt.requestId } });
    await expect(dispatchRun(input, queued[0])).resolves.toMatchObject({ interruptedRunId: refused.id });
  });

  it("serializes concurrent clicks and remembers each key after completion", async () => {
    const input = await seed();
    const second = { ...input, idempotencyKey: randomUUID() };
    const [one, two] = await Promise.all([requestTaskRetry(input), requestTaskRetry(second)]);
    expect(one.requestId).toBe(two.requestId);
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId));
    expect(rows.filter(row => row.status === "deferred_issue_execution")).toHaveLength(1);
    expect(rows).toHaveLength(2);
    await db.update(agentWakeupRequests).set({ status: "failed" }).where(eq(agentWakeupRequests.id, one.requestId!));
    expect((await requestTaskRetry(input)).requestId).toBe(one.requestId);
    expect((await requestTaskRetry(second)).requestId).toBe(one.requestId);
    const next = await requestTaskRetry({ ...input, idempotencyKey: randomUUID() });
    expect(next.requestId).not.toBe(one.requestId);
  });
  it.each(["within_limit", "over_limit", "newer_predecessor"] as const)("validates the complete persisted Retry ancestry: %s", async gate => {
    const input = await seed();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.observedRunId));
    const [ancestor] = await db.insert(heartbeatRuns).values({ companyId: input.companyId, issueId: input.issueId,
      agentId: source.agentId, status: "failed", finishedAt: new Date(), createdAt: new Date(source.createdAt.getTime() +
        (gate === "newer_predecessor" ? 1000 : -1000)) }).returning();
    const systemRecovery = createSystemRecovery(ancestor.id);
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: input.companyId, sourceIssueId: input.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: ancestor.id,
      nextAction: "Existing recovery", evidence: { runId: ancestor.id, systemRecovery } }).returning();
    let previous = ancestor.id;
    const length = gate === "over_limit" ? 31 : gate === "within_limit" ? 30 : 0;
    for (let index = 0; index < length; index++) {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: input.companyId, issueId: input.issueId,
        agentId: source.agentId, status: "failed", finishedAt: new Date(), createdAt: ancestor.createdAt,
        retryOfRunId: previous }).returning();
      previous = run.id;
    }
    await db.update(heartbeatRuns).set({ retryOfRunId: previous }).where(eq(heartbeatRuns.id, source.id));
    const ancestry = await taskRetryRunAncestry({ db, companyId: input.companyId, issueId: input.issueId,
      agentId: source.agentId, sourceRunId: source.id });
    const receipt = await requestTaskRetry(input);
    const state = readSystemRecovery((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id)))[0].evidence);
    if (gate === "within_limit") {
      expect(ancestry).toHaveLength(32);
      expect(ancestry).toContain(ancestor.id);
      expect(state?.intentId).toBe(receipt.requestId);
    } else {
      expect(ancestry).toBeNull();
      expect(state).toEqual(systemRecovery);
    }
  });
  it("does not resurrect completed tasks or retry an obsolete assignment", async () => {
    const input = await seed();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, input.issueId));
    expect(await requestTaskRetry(input)).toMatchObject({ accepted: false, stale: true });
    await db.update(issues).set({ status: "blocked", assigneeAgentId: null }).where(eq(issues.id, input.issueId));
    expect(await requestTaskRetry(input)).toMatchObject({ accepted: false, stale: true });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId))).toHaveLength(0);
  });
  it.each(["stopped", "running", "owned", "changed_workspace", "changed_source", "missing_stop", "destroyed", "foreign_task"].flatMap(state =>
    ["retry", "message"].map(entry => ({ state, entry }))).concat([{ state: "stopped", entry: "preview" }]))(
    "preserves the actual remote writer behind a newer setup failure only with exact stopped authority: $entry $state", async ({ state, entry }) => {
      const input = await seed();
      const [latest] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.observedRunId));
      const writerId = randomUUID(), workspaceId = randomUUID(), pluginId = randomUUID();
      const sourceIssueId = state === "foreign_task" ? randomUUID() : input.issueId;
      if (sourceIssueId !== input.issueId) await db.insert(issues).values({ id: sourceIssueId,
        companyId: input.companyId, title: "Another task", status: "blocked", assigneeAgentId: latest.agentId });
      await db.update(heartbeatRuns).set({ errorCode: "setup_failed", resultJson: {
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      } }).where(eq(heartbeatRuns.id, latest.id));
      await db.insert(heartbeatRuns).values({ id: writerId, companyId: input.companyId, agentId: latest.agentId,
        issueId: sourceIssueId, nativeIssueId: sourceIssueId, runtimeMode: "native",
        status: state === "running" ? "running" : "failed", finishedAt: state === "running" ? null : new Date(),
        createdAt: new Date(latest.createdAt.getTime() - 60_000),
        contextSnapshot: { issueId: sourceIssueId, executionWorkspaceId: workspaceId },
        resultJson: { workspaceRestoreFailure: "restore_failed", originalDiagnostic: true },
      });
      await db.insert(nativeRunFinalizations).values({ companyId: input.companyId, issueId: sourceIssueId,
        runId: writerId, phase: "terminal_failure", leaseOwner: state === "owned" ? "live-controller" : null });
      const [environment] = await db.insert(environments).values({ name: `Stopped source ${writerId}`, driver: "sandbox" }).returning();
      const [lease] = await db.insert(environmentLeases).values({ companyId: input.companyId, issueId: sourceIssueId,
        heartbeatRunId: writerId, environmentId: environment.id, provider: "daytona", providerLeaseId: randomUUID(),
        status: "released", cleanupStatus: "success", leasePolicy: "reuse_by_environment", acquiredAt: new Date(Date.now() - 60_000),
        releasedAt: new Date(),
      }).returning();
      const confirmedAt = lease.releasedAt!.toISOString();
      const identity = { companyId: input.companyId, runId: writerId, leaseId: lease.id,
        provider: lease.provider, providerLeaseId: lease.providerLeaseId, confirmedAt };
      const metadata = { driver: "sandbox", pluginId, sandboxProviderPlugin: true, remoteCwd: "/work",
        ...(state === "missing_stop" ? {} : {
          remoteExecutionTermination: { ...identity, schema: "paperclip.remote-termination.v1", state: state === "destroyed" ? "destroyed" : "stopped" },
          sandboxStopAndRetainReceipt: { ...identity, schema: "paperclip.sandbox-stop-and-retain-receipt.v1",
            pluginId, method: "environmentStopLease", requestId: randomUUID() },
        }),
      };
      await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, lease.id));
      const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, epoch: 3,
        snapshotId: randomUUID(), leaseId: lease.id, providerLeaseId: lease.providerLeaseId, remoteCwd: "/work", state: "prepared" };
      await db.update(heartbeatRuns).set({ runnerProfileJson: { remoteWorkspace: {
        ...reference, ...(state === "changed_source" ? { providerLeaseId: randomUUID() } : {}),
      } } }).where(eq(heartbeatRuns.id, writerId));
      const authority = { schema: "paperclip.remote-workspace.v1", epoch: state === "changed_workspace" ? 4 : 3,
        snapshotId: reference.snapshotId, source: { kind: "empty" }, writerRunId: writerId, dirty: true,
        location: { environmentId: environment.id, leaseId: lease.id, providerLeaseId: lease.providerLeaseId, remoteCwd: "/work" } };
      await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: input.companyId, sourceIssueId,
        name: "Unfinished remote writer", mode: "isolated_workspace", strategyType: "project_primary", cwd: "/work",
        providerType: "cloud_sandbox", metadata: { remoteWorkspace: authority } });
      await db.update(environmentLeases).set({ executionWorkspaceId: workspaceId }).where(eq(environmentLeases.id, lease.id));
      await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, input.issueId));

      if (entry === "retry") {
        const receipt = await requestTaskRetry(input);
        expect((await requestTaskRetry(input)).requestId).toBe(receipt.requestId);
      } else {
        const [comment] = await db.insert(issueComments).values({ companyId: input.companyId, issueId: input.issueId,
          authorType: "user", authorUserId: input.actorId, body: "Continue from saved work.",
          createdAt: new Date() }).returning();
        for (let attempt = 0; attempt < 2; attempt++) await db.transaction(tx => admitExplicitNativeContinuation({
          db: tx as unknown as typeof db, companyId: input.companyId, issueId: input.issueId, agentId: latest.agentId,
          actorType: "user", actorId: input.actorId, commentId: comment.id, successorRunId: randomUUID(),
          reason: "issue_commented", dryRun: entry === "preview",
        }));
      }
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, writerId));
      const repairs = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, input.issueId)))
        .filter(action => action.evidence.workspaceRestoreRecovery);
      if (state === "stopped" && entry !== "preview") {
        expect(source.resultJson).toMatchObject({ originalDiagnostic: true,
          workspaceRestoreRecovery: { leaseIds: [lease.id] } });
        expect(repairs).toHaveLength(1);
        expect(repairs[0].evidence.runId).toBe(writerId);
      } else {
        expect(source.resultJson).not.toHaveProperty("workspaceRestoreRecovery");
        expect(repairs).toHaveLength(0);
      }
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0])
        .toMatchObject({ status: "released", leasePolicy: "reuse_by_environment", metadata });
      expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)))[0].metadata?.remoteWorkspace)
        .toEqual(authority);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, input.companyId))).toHaveLength(2);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId))).toHaveLength(entry === "retry" ? 1 : 0);
    });
  it.each(["prepared", "mismatched", "owned"] as const)("reconstructs missing native preservation on deliberate Retry only for an exact unowned source: %s", async state => {
    const input = await seed();
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    const [environment] = await db.insert(environments).values({ name: input.observedRunId, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: input.companyId, issueId: input.issueId,
      heartbeatRunId: input.observedRunId, environmentId: environment.id, provider: "daytona", providerLeaseId: randomUUID(),
      status: "active", leasePolicy: "reuse_by_environment", metadata: { remoteCwd: "/work" },
    }).returning();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: input.issueId,
      nativePhase: "terminal_failure", errorCode: "execution_finalization_deadline_exceeded", runnerProfileJson: {
        nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
          descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
          workspaceId: input.observedRunId, leaseId: lease.id,
          providerLeaseId: state === "mismatched" ? randomUUID() : lease.providerLeaseId,
          remoteCwd: "/work", resourceDisposition: "keep_running" },
      } }).where(eq(heartbeatRuns.id, input.observedRunId));
    await db.insert(nativeRunFinalizations).values({ companyId: input.companyId, issueId: input.issueId,
      runId: input.observedRunId, phase: "terminal_failure", leaseOwner: state === "owned" ? "live-controller" : null });
    await db.insert(issueRecoveryActions).values({ companyId: input.companyId, sourceIssueId: input.issueId,
      kind: "active_run_watchdog", status: "resolved", ownerType: "board",
      cause: "execution_finalization_deadline_exceeded", fingerprint: randomUUID(), outcome: "blocked",
      nextAction: "Inspect the failed run.", evidence: { runId: input.observedRunId,
        providerOwnership: "unverified", automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });

    const receipt = await requestTaskRetry(input);
    expect((await requestTaskRetry(input)).requestId).toBe(receipt.requestId);
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.observedRunId));
    const [retained] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    const repairs = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, input.issueId)))
      .filter(action => action.evidence.workspaceRestoreRecovery);
    if (state === "prepared") {
      expect(source.resultJson).toMatchObject({ workspaceRestoreRecovery: { leaseIds: [lease.id] } });
      expect(retained).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
      expect(repairs).toHaveLength(1);
      expect(readSystemRecovery(repairs[0].evidence)).toMatchObject({ state: "scheduled", intentId: receipt.requestId });
      expect(await taskChatRetryCanAwaitRecovery(db, source, input.issueId, receipt.requestId!)).toBe(true);
    } else {
      expect(source.resultJson).toBeNull();
      expect(retained).toMatchObject({ status: "active", leasePolicy: "reuse_by_environment" });
      expect(repairs).toHaveLength(0);
    }
    expect(await taskChatRetryExecutionStopped(db, source)).toBe(false);
    expect(retained.metadata).not.toHaveProperty("remoteExecutionTermination");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, input.companyId))).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, input.issueId)))[0])
      .toMatchObject({ status: "blocked", assigneeAgentId: issue.assigneeAgentId, executionRunId: null, checkoutRunId: null });
  });
  it("requires current Chat ownership and ignores retired off values when replaying a retry receipt", async () => {
    const input = await seed();
    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAgentChat: true });
    await db.update(issues).set({ conversationAgentId: (await db.select().from(issues).where(eq(issues.id, input.issueId)))[0].assigneeAgentId,
      conversationUserId: input.actorId, conversationState: "waiting" }).where(eq(issues.id, input.issueId));
    try {
      await expect(requestTaskRetry({ ...input, actorId: "another-user" })).rejects.toMatchObject({ status: 403 });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId))).toHaveLength(0);
      const accepted = await requestTaskRetry(input);
      expect(accepted.accepted).toBe(true);
      await settings.updateExperimental({ enableAgentChat: false });
      expect((await requestTaskRetry(input)).requestId).toBe(accepted.requestId);
      await settings.updateExperimental({ enableAgentChat: true });
      await db.update(issues).set({ conversationUserId: "new-owner" }).where(eq(issues.id, input.issueId));
      await expect(requestTaskRetry(input)).rejects.toMatchObject({ status: 403 });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId))).toHaveLength(1);
      const next = await requestTaskRetry({ ...input, actorId: "new-owner", idempotencyKey: randomUUID() });
      expect(next.requestId).not.toBe(accepted.requestId);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, accepted.requestId!)))[0].status).toBe("failed");
    } finally { await settings.updateExperimental({ enableAgentChat: false }); }
  });
  it.each(["owner", "feature"] as const)("rechecks Chat ownership and ignores retired $0 values after waiting for the issue lock", async gate => {
    const input = { ...await seed(), actorId: "local-board", actorSource: "local_implicit" };
    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableAgentChat: true, enableNativeRunner: true });
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    await db.update(issues).set({ conversationAgentId: issue.assigneeAgentId, conversationUserId: input.actorId,
      conversationState: "waiting" }).where(eq(issues.id, input.issueId));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, issue.assigneeAgentId!));
    await db.insert(heartbeatRuns).values({ companyId: input.companyId, agentId: issue.assigneeAgentId!, status: "running" });
    const receipt = await requestTaskRetry(input);
    let release!: () => void, ready!: () => void, holderPid = 0;
    const held = new Promise<void>(resolve => { ready = resolve; });
    const unlock = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      holderPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0].pid;
      await tx.select().from(issues).where(eq(issues.id, issue.id)).for("update");
      ready(); await unlock;
      if (gate === "owner") await tx.update(issues).set({ conversationUserId: "new-owner" }).where(eq(issues.id, issue.id));
      else await instanceSettingsService(tx as unknown as typeof db).updateExperimental({ enableAgentChat: false });
    });
    let dispatch: Promise<unknown> | undefined;
    try {
      await held;
      dispatch = heartbeatService(db).resumeTaskRetry(input.companyId, receipt.requestId!).catch(error => error);
      await expect.poll(async () => (await db.execute<{ waiting: boolean }>(sql`select exists(
        select 1 from pg_stat_activity where datname = current_database()
          and ${holderPid} = any(pg_blocking_pids(pid))) as waiting`))[0].waiting, { timeout: 5_000 }).toBe(true);
      release(); await holder;
      if (gate === "owner") expect(await dispatch).toMatchObject({ status: 403 });
      else await dispatch;
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.status, "queued")))).toHaveLength(gate === "owner" ? 0 : 1);
      // Restore current authority; the same saved receipt can then admit one run.
      await settings.updateExperimental({ enableAgentChat: true });
      await db.update(issues).set({ conversationUserId: input.actorId }).where(eq(issues.id, issue.id));
      await heartbeatService(db).resumeTaskRetry(input.companyId, receipt.requestId!);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.status, "queued")))).toHaveLength(1);
    } finally {
      release(); await Promise.allSettled([holder, dispatch]);
      await settings.updateExperimental({ enableAgentChat: false, enableNativeRunner: false });
    }
  }, 30_000);
  it("replaces an exhausted unadmitted generation only on a new deliberate click", async () => {
    const input = await seed();
    const first = await requestTaskRetry(input);
    const state = failSystemRecovery(createSystemRecovery(input.observedRunId, first.requestId!),
      new SystemRecoveryFailure("source_unavailable", "service_required"));
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: input.companyId, sourceIssueId: input.issueId, kind: "active_run_watchdog",
      ownerType: "system", cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(),
      nextAction: "System recovery", evidence: { runId: input.observedRunId, systemRecovery: state },
    }).returning();
    expect((await requestTaskRetry(input)).requestId).toBe(first.requestId);
    const nextInput = { ...input, idempotencyKey: randomUUID() };
    const next = await requestTaskRetry(nextInput);
    expect(next.requestId).not.toBe(first.requestId);
    const [updated] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(readSystemRecovery(updated.evidence)).toMatchObject({ generationId: next.requestId, attempts: 0 });
    expect((await requestTaskRetry(nextInput)).requestId).toBe(next.requestId);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId));
    expect(wakes.find(row => row.id === first.requestId)?.status).toBe("failed");
    expect(wakes.filter(row => row.status === "deferred_issue_execution")).toHaveLength(1);
  });
  it("accepts Retry for an old-release retained-export hold whose source ownership could not be verified", async () => {
    // State saved by an earlier release: a board-owned export hold whose only
    // attempt ended with a permanent ownership refusal. The task UI now offers
    // Retry for it; Retry must open one new bounded generation that re-verifies
    // the source, keep the hold in place, and never resolve or bypass it.
    const input = await seed();
    const previous = { ...failSystemRecovery({ ...createSystemRecovery(input.observedRunId), revision: 4 },
      new SystemRecoveryFailure("allocation_ownership_ambiguous", "service_required")), revision: 5 };
    expect(previous.state).toBe("exhausted");
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: input.companyId, sourceIssueId: input.issueId, kind: "active_run_watchdog", status: "active",
      ownerType: "board", cause: "native_workspace_sync_out_retry_exhausted", fingerprint: randomUUID(),
      nextAction: "Automatic recovery of saved work stopped after 1 attempts (last failure: allocation_ownership_ambiguous).",
      evidence: { runId: input.observedRunId, systemRecovery: previous,
        workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: input.observedRunId, stage: "verifying_stop",
          status: "blocked", attempt: 1, attemptLimit: 6, requestIds: [], retryable: true, message: "Retry recovery." },
        coordinatorAttempt: 1, originalFailureCode: "native_workspace_sync_out_failed",
        workspaceFinalizeAttempt: 3, previousWorkspaceRecovery: null },
    }).returning();
    const receipt = await requestTaskRetry(input);
    expect(receipt).toMatchObject({ accepted: true, stale: false, observedRunId: input.observedRunId });
    const [updated] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(updated.status).toBe("active");
    expect(updated.resolvedAt).toBeNull();
    expect(readSystemRecovery(updated.evidence)).toMatchObject({ generationId: receipt.requestId, sourceRunId: input.observedRunId,
      attempts: 0, failure: null, revision: 6, freshAttemptRunId: null, preservationOperationIds: [] });
    // File recovery is queued again for the worker, which re-verifies the source.
    expect(updated.evidence.workspaceRecovery).toMatchObject({ runId: input.observedRunId, status: "queued",
      stage: "verifying_stop", attemptLimit: 6, retryable: true });
    // A replayed click is idempotent and does not open another generation.
    expect((await requestTaskRetry(input)).requestId).toBe(receipt.requestId);
    const [replayed] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(readSystemRecovery(replayed.evidence)?.revision).toBe(6);
  });
  it("binds a key to its company, task and actor across all statuses", async () => {
    const input = await seed();
    const receipt = await requestTaskRetry(input);
    await db.update(agentWakeupRequests).set({ status: "completed" }).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, receipt.requestId!)));
    await expect(requestTaskRetry({ ...input, actorId: "another-user" })).rejects.toThrow("different task or user");
    expect((await requestTaskRetry(input)).requestId).toBe(receipt.requestId);
    const other = await seed();
    expect((await requestTaskRetry({ ...other, idempotencyKey: input.idempotencyKey })).requestId).not.toBe(receipt.requestId);
  });
  it("keeps an adopted historical hold with its maintenance owner", async () => {
    const input = await seed();
    const system = createSystemRecovery(input.observedRunId);
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: input.companyId, sourceIssueId: input.issueId, kind: "active_run_watchdog",
      status: "active", ownerType: "system", returnOwnerAgentId: null,
      cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(),
      nextAction: "System preservation", evidence: { runId: input.observedRunId, systemRecovery: system },
    }).returning();
    await settleUnrecoverableExecutions(db);
    const [current] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(current.status).toBe("active");
    expect(current.ownerType).toBe("system");
    expect(current.evidence.systemRecovery).toEqual(system);
    expect(current.evidence.automaticRecovery).toBeUndefined();
  });
  it.each(["evaluate", "continue"])("keeps an admitted %s retry isolated after a failure without a preserved workspace", async strategy => {
    const input = await seed();
    const receipt = await requestTaskRetry(input);
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.observedRunId));
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: input.companyId,
      agentId: source.agentId, issueId: input.issueId, status: "queued",
      contextSnapshot: { issueId: input.issueId, taskRetryRequestId: receipt.requestId } }).returning();
    expect(await readFreshWorkspaceReadiness(db, successor)).toBeNull();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
    await db.update(agentWakeupRequests).set({ runId: successor.id, status: "coalesced",
      payload: { ...wake.payload, taskRetry: { ...(wake.payload!.taskRetry as object), strategy } } })
      .where(eq(agentWakeupRequests.id, receipt.requestId!));
    const readiness = await readFreshWorkspaceReadiness(db, successor);
    expect(readiness).toMatchObject({ mode: "fresh_isolated_workspace", retryIntentId: receipt.requestId,
      sourceRunId: source.id });
    expect(await readFreshWorkspaceReadiness(db, successor)).toEqual(readiness);
    expect(await readFreshWorkspaceReadiness(db, { ...successor, id: randomUUID() })).toBeNull();
  });
  it("reuses completed API effects only from the retry ancestry while retaining unrelated uncertainty", async () => {
    const input = await seed();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.observedRunId));
    const receipt = { operationId: "PATCH /api/issues/{id}", digest: "same-title", state: "completed",
      result: { ok: true, status: 200, data: { title: "Earlier title" } } };
    const [earlier] = await db.insert(heartbeatRuns).values({ companyId: input.companyId, issueId: input.issueId,
      agentId: source.agentId, status: "succeeded", createdAt: new Date(1_000), resultJson: { apiToolReceipts: { receipt } } }).returning();
    const accepted = await requestTaskRetry(input);
    const [successor] = await db.insert(heartbeatRuns).values({ companyId: input.companyId, issueId: input.issueId,
      agentId: source.agentId, status: "running", createdAt: new Date(Date.now() + 1_000) }).returning();
    await db.update(agentWakeupRequests).set({ status: "coalesced", runId: successor.id })
      .where(eq(agentWakeupRequests.id, accepted.requestId!));
    const call = { companyId: input.companyId, issueId: input.issueId, runId: successor.id,
      operationId: receipt.operationId, digest: receipt.digest };
    expect(await priorRecoveryApiReceipt(db, call)).toBeNull();
    // An actual predecessor edge makes the exact receipt relevant, even across multiple attempts.
    await db.update(heartbeatRuns).set({ retryOfRunId: earlier.id }).where(eq(heartbeatRuns.id, source.id));
    expect(await priorRecoveryApiReceipt(db, call)).toEqual(receipt);
    await db.update(heartbeatRuns).set({ retryOfRunId: null }).where(eq(heartbeatRuns.id, source.id));
    await db.update(heartbeatRuns).set({ resultJson: { apiToolReceipts: { receipt: { ...receipt,
      state: "pending", result: { ok: false, outcome: "unknown" } } } } }).where(eq(heartbeatRuns.id, earlier.id));
    expect(await priorRecoveryApiReceipt(db, call)).toMatchObject({ state: "pending", result: { outcome: "unknown" } });
  });

  async function automaticSuccessorOfTaskRetry() {
    const input = await seed();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.observedRunId));
    const intent = await requestTaskRetry(input);
    const [retry] = await db.insert(heartbeatRuns).values({ companyId: input.companyId, issueId: input.issueId,
      agentId: source.agentId, runtimeMode: "native", status: "failed", createdAt: new Date(Date.now() + 1_000) }).returning();
    await db.update(agentWakeupRequests).set({ status: "coalesced", runId: retry.id })
      .where(eq(agentWakeupRequests.id, intent.requestId!));
    const [automatic] = await db.insert(heartbeatRuns).values({ companyId: input.companyId, issueId: input.issueId,
      agentId: source.agentId, runtimeMode: "native", status: "running", retryOfRunId: retry.id,
      createdAt: new Date(Date.now() + 2_000) }).returning();
    await db.insert(agentWakeupRequests).values({ companyId: input.companyId, agentId: source.agentId,
      runId: automatic.id, source: "automation", reason: "transient_failure", status: "coalesced",
      requestedByActorType: "system", payload: { issueId: input.issueId, retryOfRunId: retry.id } });
    return { input, retry, automatic };
  }

  it.each(["completed", "pending"] as const)("automatic successors inherit %s API receipts after task Retry", async state => {
    const { input, retry, automatic } = await automaticSuccessorOfTaskRetry();
    const receipt = { operationId: "POST /api/companies/{companyId}/projects", digest: "same-project", state,
      result: state === "completed" ? { ok: true, status: 201 } : { ok: false, outcome: "unknown" } };
    await db.update(heartbeatRuns).set({ resultJson: { apiToolReceipts: { receipt } } }).where(eq(heartbeatRuns.id, retry.id));
    const call = { companyId: input.companyId, issueId: input.issueId, runId: automatic.id,
      operationId: receipt.operationId, digest: receipt.digest };
    expect(await priorRecoveryApiReceipt(db, call)).toMatchObject({ state, result: receipt.result });
    // A transcript predecessor is insufficient; the persisted run edge owns lineage.
    await db.update(heartbeatRuns).set({ retryOfRunId: null, contextSnapshot: { previousRunId: retry.id } })
      .where(eq(heartbeatRuns.id, automatic.id));
    expect(await priorRecoveryApiReceipt(db, call)).toBeNull();
  });

  it("automatic successors retain uncertain upstream mutation fences after task Retry", async () => {
    const { input, retry, automatic } = await automaticSuccessorOfTaskRetry();
    const [application] = await db.insert(toolApplications).values({ companyId: input.companyId,
      name: "Test API", type: "rest_api" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: input.companyId, applicationId: application.id,
      name: "Test API", uid: randomUUID(), transport: "rest_api" }).returning();
    const [invocation] = await db.insert(toolInvocations).values({ companyId: input.companyId, issueId: input.issueId,
      runId: retry.id, connectionId: connection.id, toolName: "create_project", riskLevel: "write",
      status: "timed_out", startedAt: new Date() }).returning();
    const call = { companyId: input.companyId, issueId: input.issueId, runId: automatic.id,
      connectionId: connection.id, toolName: "create_project", risk: "write" };
    expect(await unresolvedRecoveryToolInvocation(db, call)).toBe(invocation.id);
    expect(await unresolvedRecoveryToolInvocation(db, { ...call, risk: "read" })).toBeNull();
  });

  it("retires a deferred Retry when newer work appears while dispatch waits for the issue lock", async () => {
    const input = { ...await seed(), actorId: "local-board", actorSource: "local_implicit" };
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true });
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, issue.assigneeAgentId!));
    await db.insert(heartbeatRuns).values({ companyId: input.companyId, agentId: issue.assigneeAgentId!, status: "running" });
    const receipt = await requestTaskRetry(input);
    let release!: () => void, ready!: () => void, holderPid = 0;
    const held = new Promise<void>(resolve => { ready = resolve; });
    const unlock = new Promise<void>(resolve => { release = resolve; });
    const newerRunId = randomUUID();
    const holder = db.transaction(async tx => {
      holderPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0].pid;
      await tx.select().from(issues).where(eq(issues.id, issue.id)).for("update");
      ready(); await unlock;
      await tx.insert(heartbeatRuns).values({ id: newerRunId, companyId: input.companyId, issueId: issue.id,
        agentId: issue.assigneeAgentId!, status: "succeeded", finishedAt: new Date(), createdAt: new Date(Date.now() + 1_000) });
      await tx.update(issues).set({ status: "in_progress", executionRunId: newerRunId }).where(eq(issues.id, issue.id));
    });
    let dispatch: Promise<unknown> | undefined;
    try {
      await held;
      dispatch = heartbeatService(db).resumeTaskRetry(input.companyId, receipt.requestId!);
      await expect.poll(async () => (await db.execute<{ waiting: boolean }>(sql`select exists(
        select 1 from pg_stat_activity where datname = current_database()
          and ${holderPid} = any(pg_blocking_pids(pid))) as waiting`))[0].waiting, { timeout: 5_000 }).toBe(true);
      release(); await holder; await dispatch;
      await heartbeatService(db).resumeTaskRetry(input.companyId, receipt.requestId!);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.status, "queued")))).toHaveLength(0);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!)))[0])
        .toMatchObject({ status: "skipped", runId: null, error: "task_retry_superseded" });
    } finally {
      release(); await Promise.allSettled([holder, dispatch]);
      await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
    }
  }, 30_000);

  it("does not attach a new deliberate Retry to an unadmitted request for an older run", async () => {
    const input = await seed();
    const old = await requestTaskRetry(input);
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    const [newer] = await db.insert(heartbeatRuns).values({ companyId: input.companyId, issueId: input.issueId,
      agentId: issue.assigneeAgentId!, status: "failed", finishedAt: new Date(), createdAt: new Date(Date.now() + 1_000) }).returning();
    const next = await requestTaskRetry({ ...input, observedRunId: newer.id, idempotencyKey: randomUUID() });
    expect(next.requestId).not.toBe(old.requestId);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, old.requestId!)))[0])
      .toMatchObject({ status: "skipped", error: "task_retry_superseded" });
  });

  async function seedChatTask() {
    const input = await seed();
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    const [application] = await db.insert(toolApplications).values({ companyId: input.companyId, name: "Slack", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: input.companyId, applicationId: application.id,
      name: "Slack", uid: randomUUID(), transport: "chat_sdk", connectionPurpose: "channel" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: input.companyId, connectionId: connection.id,
      provider: "slack", publicId: randomUUID(), assignedAgentId: issue.assigneeAgentId!, status: "active" }).returning();
    await db.insert(chatConversations).values({ companyId: input.companyId, endpointId: endpoint.id, issueId: input.issueId,
      externalConversationId: "channel", externalThreadId: randomUUID(), externalLabel: "#retry", state: "waiting" });
    return input;
  }
  const chatIdentityLock = (companyId: string, principalId: string) =>
    sql`pg_try_advisory_xact_lock(hashtextextended(${`chat-identity:${companyId}:${principalId}`}, 0))`;

  it("waits out brief chat authorization contention without a second request", async () => {
    const input = await seedChatTask();
    const principalId = randomUUID(), actionId = randomUUID();
    let calls = 0, locked!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const mayRelease = new Promise<void>(resolve => { release = resolve; });
    // Another chat transaction owns this principal's authorization lock.
    const holder = db.transaction(async tx => {
      expect((await tx.execute<{ locked: boolean }>(sql`select ${chatIdentityLock(input.companyId, principalId)} as locked`))[0].locked).toBe(true);
      locked(); await mayRelease;
    });
    await held;
    const prepareChatRetry = async (tx: Db) => {
      calls += 1;
      if (calls === 2) release();
      // Mirror the production authorization check, including its rollback.
      const [row] = await tx.execute<{ locked: boolean }>(sql`select ${chatIdentityLock(input.companyId, principalId)} as locked`);
      if (!row?.locked) throw new NativeChatReviewPresentationContentionError();
      return { actionId };
    };
    try {
      const receipt = await requestTaskRetry({ ...input, prepareChatRetry });
      expect(receipt).toMatchObject({ accepted: true, chatActionId: actionId });
      expect(calls).toBeGreaterThan(1);
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: receipt.requestId, status: "deferred_issue_execution",
        payload: { taskRetry: { chatActionId: actionId } } });
      expect((await requestTaskRetry({ ...input, prepareChatRetry })).requestId).toBe(receipt.requestId);
    } finally { release(); await holder; }
  });

  it("returns a retryable conflict when chat authorization stays busy", async () => {
    const input = await seedChatTask();
    let calls = 0;
    const failure = await requestTaskRetry({ ...input, prepareChatRetry: async () => {
      calls += 1;
      throw new NativeChatReviewPresentationContentionError();
    } }).catch(error => error);
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).toMatchObject({ status: 409, details: { code: "task_retry_busy", retryable: true } });
    expect(calls).toBe(10);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId))).toHaveLength(0);
  });

  const refusedExactChatReplay = (reason?: string) => async (tx: Db, scope: { companyId: string; issueId: string; failedRunId: string }) => {
    const [endpoint] = await tx.select().from(chatEndpoints).where(eq(chatEndpoints.companyId, scope.companyId));
    await tx.insert(chatActions).values({ companyId: scope.companyId, endpointId: endpoint.id, kind: "failed_run_retry",
      status: "issued", providerActionId: randomUUID(), payload: { issueId: scope.issueId, failedRunId: scope.failedRunId } });
    throw new HttpError(409, "refused", { code: "chat_failed_run_retry_not_authorized", ...(reason ? { reason } : {}) });
  };

  it.each([undefined, "accepted_result_without_new_input", "prior_result_publication", "source_authorization"])(
    "continues a connected task from saved work when its exact chat request cannot be repeated: %s", async reason => {
      const input = await seedChatTask();
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.observedRunId));
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: input.issueId, source: "issue.monitor",
        wakeReason: "issue_monitor_due" } }).where(eq(heartbeatRuns.id, source.id));
      const receipt = await requestTaskRetry({ ...input, actorSource: "local_implicit", prepareChatRetry: refusedExactChatReplay(reason) });
      expect(receipt).toMatchObject({ accepted: true, stale: false, observedRunId: source.id });
      expect(receipt.chatActionId).toBeUndefined();
      expect(await db.select().from(chatActions).where(eq(chatActions.companyId, input.companyId))).toHaveLength(0);
      const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      expect(intent).toMatchObject({ status: "deferred_issue_execution", reason: "task_retry", requestedByActorId: input.actorId,
        payload: { issueId: input.issueId, taskRetry: { sourceRunId: source.id, actorId: input.actorId } } });
      expect((intent.payload!.taskRetry as Record<string, unknown>).chatActionId).toBeUndefined();
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, source.agentId));
      await db.insert(heartbeatRuns).values({ companyId: input.companyId, agentId: source.agentId, status: "running" });
      await heartbeatService(db).resumeTaskRetry(input.companyId, receipt.requestId!);
      const queued = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.status, "queued")));
      expect(queued).toHaveLength(1);
      expect(queued[0].contextSnapshot).toMatchObject({ issueId: input.issueId, previousRunId: source.id,
        taskRetryRequestId: receipt.requestId, forceFreshSession: true, responsibleUserId: input.actorId });
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!)))[0])
        .toMatchObject({ status: "coalesced", runId: queued[0].id });
    });

  it.each(["person", "automatic"] as const)(
    "continues a person's saved board turn on a connected task from saved work without replaying it: %s", async initiator => {
      const input = await seedChatTask();
      const [source] = await db.update(heartbeatRuns).set({ runtimeMode: "legacy", errorCode: "adapter_failed",
        error: "Provider stopped", responsibleUserId: input.actorId, sessionIdAfter: "provider-session",
        contextSnapshot: { issueId: input.issueId, source: "issue.comment.reopen", wakeCommentId: randomUUID() } })
        .where(eq(heartbeatRuns.id, input.observedRunId)).returning();
      let calls = 0;
      const request = { ...input, actorSource: "local_implicit" as const,
        ...(initiator === "automatic" ? { initiatedBy: "restart_recovery" as const } : {}),
        prepareChatRetry: async () => { calls += 1; return { actionId: randomUUID() }; } };
      if (initiator === "automatic") {
        await expect(requestTaskRetry(request)).rejects.toMatchObject({ status: 409,
          details: { code: "chat_failed_run_retry_not_authorized", reason: "saved_board_message_not_replayable" } });
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId))).toHaveLength(0);
        expect(calls).toBe(0);
        return;
      }
      const receipt = await requestTaskRetry(request);
      expect(receipt).toMatchObject({ accepted: true, stale: false, observedRunId: source.id });
      expect(receipt.chatActionId).toBeUndefined();
      expect(calls).toBe(0);
      const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
      const taskRetry = intent.payload!.taskRetry as Record<string, unknown>;
      expect(taskRetry).toMatchObject({ sourceRunId: source.id, actorId: input.actorId });
      expect(taskRetry.chatActionId).toBeUndefined();
      expect(taskRetry.boardMessageOrigin).toBeUndefined();
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, source.agentId));
      await db.insert(heartbeatRuns).values({ companyId: input.companyId, agentId: source.agentId, status: "running" });
      await heartbeatService(db).resumeTaskRetry(input.companyId, receipt.requestId!);
      const queued = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.status, "queued")));
      expect(queued).toHaveLength(1);
      expect(queued[0].contextSnapshot).toMatchObject({ previousRunId: source.id, taskRetryRequestId: receipt.requestId,
        forceFreshSession: true, responsibleUserId: input.actorId });
      expect(queued[0].contextSnapshot?.boardMessageRetry).toBeUndefined();
      expect(queued[0].contextSnapshot?.wakeCommentId).toBeUndefined();
    });

  it("continues a person's Retry on a connected task when no chat retry owner is available", async () => {
    const input = await seedChatTask();
    const receipt = await requestTaskRetry({ ...input, actorSource: "local_implicit" });
    expect(receipt).toMatchObject({ accepted: true, chatActionId: undefined });
    const automatic = await seedChatTask();
    await expect(requestTaskRetry({ ...automatic, initiatedBy: "provider_limit_reset" })).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, automatic.companyId))).toHaveLength(0);
  });

  it("keeps an automatic Retry from continuing a connected task without the exact chat request", async () => {
    const input = await seedChatTask();
    await expect(requestTaskRetry({ ...input, initiatedBy: "restart_recovery", prepareChatRetry: refusedExactChatReplay() }))
      .rejects.toMatchObject({ status: 409, details: { code: "chat_failed_run_retry_not_authorized" } });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, input.companyId))).toHaveLength(0);
    expect(await db.select().from(chatActions).where(eq(chatActions.companyId, input.companyId))).toHaveLength(0);
  });

  it("does not retry an authorization denial", async () => {
    const input = await seedChatTask();
    let calls = 0;
    await expect(requestTaskRetry({ ...input, prepareChatRetry: async () => {
      calls += 1;
      throw new HttpError(403, "denied");
    } })).rejects.toMatchObject({ status: 403 });
    expect(calls).toBe(1);
  });
});
