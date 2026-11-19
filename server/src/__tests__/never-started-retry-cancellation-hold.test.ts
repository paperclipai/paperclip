import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { heartbeatService } from "../services/heartbeat.js";
import { requestTaskRetry } from "../services/task-retry.js";

// A task moved to backlog while its automatic retry was still waiting for its
// scheduled time. The control plane cancels that retry before it ever starts,
// so no action of it can have taken effect. Moving the task back to todo and
// pressing Retry must continue the task, not leave it held for reconciliation.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("a pending retry cancelled before it started", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("never-started-retry-cancellation-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  // The scheduler retries only a run that needs no reconciliation: a transient
  // failure before provider work, a resource wait it cancelled itself, or (as
  // in the reported incident) an environment wait after a run that succeeded.
  async function seed(predecessor: "failed_before_provider_work" | "succeeded" | "ai_connection_wait" = "failed_before_provider_work") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const sourceRunId = randomUUID(), retryRunId = randomUUID(), wakeupRequestId = randomUUID();
    const now = Date.now();
    const retryReason = { failed_before_provider_work: "transient_failure", succeeded: "native_environment_blocker",
      ai_connection_wait: "ai_connection_busy" }[predecessor];
    await db.insert(companies).values({ id: companyId, name: "Backlog retry", defaultResponsibleUserId: "board",
      issuePrefix: "B" + companyId.replaceAll("-", "").slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer",
      adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Answer the customer", status: "in_progress",
      assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, issueId, runtimeMode: "legacy",
      startedAt: new Date(now - 120_000), finishedAt: new Date(now - 90_000),
      createdAt: new Date(now - 120_000), contextSnapshot: { issueId },
      ...(predecessor === "succeeded" ? { status: "succeeded" }
        : predecessor === "ai_connection_wait" ? { status: "cancelled", errorCode: "ai_connection_busy",
          resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } } }
        : { status: "failed", errorCode: "adapter_failed",
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }) });
    // The scheduler's placeholder: it only waits for its time and has never
    // been claimed, so it has no process, lease, stage or execution events.
    // Its chain has already spent two automatic retries.
    await db.insert(agentWakeupRequests).values({ id: wakeupRequestId, companyId, agentId, source: "automation",
      triggerDetail: "system", reason: "bounded_transient_heartbeat_retry", status: "queued",
      payload: { issueId, retryOfRunId: sourceRunId } });
    await db.insert(heartbeatRuns).values({ id: retryRunId, companyId, agentId, issueId, runtimeMode: "legacy",
      invocationSource: "automation", triggerDetail: "system", status: "scheduled_retry", wakeupRequestId,
      retryOfRunId: sourceRunId, scheduledRetryAt: new Date(now + 60_000), scheduledRetryAttempt: 2,
      scheduledRetryReason: retryReason, createdAt: new Date(now - 60_000),
      contextSnapshot: { issueId, retryOfRunId: sourceRunId, retryReason, scheduledRetryAttempt: 2,
        executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 0 } } });
    await db.update(agentWakeupRequests).set({ runId: retryRunId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.update(issues).set({ executionRunId: retryRunId, executionLockedAt: new Date(now - 60_000) })
      .where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, sourceRunId, retryRunId };
  }

  /** The task moved to backlog: the control plane cancels its pending retry
   * with the same call the issue route makes for a superseded scheduled retry. */
  async function moveToBacklog(f: Awaited<ReturnType<typeof seed>>) {
    await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, f.issueId));
    const cancelled = await heartbeatService(db).cancelRun(f.retryRunId, undefined, { expectedStatus: "scheduled_retry" });
    expect(cancelled).toMatchObject({ status: "cancelled", startedAt: null });
  }

  const holds = (issueId: string) => db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.sourceIssueId, issueId), eq(issueRecoveryActions.cause, "legacy_execution_requires_reconciliation")));

  it.each(["failed_before_provider_work", "succeeded", "ai_connection_wait"] as const)(
    "does not hold the task for reconciliation, so todo and Retry continue it (predecessor %s)", async predecessor => {
    const f = await seed(predecessor);
    await moveToBacklog(f);
    // Red before the fix: an unverified-outcome hold named the cancelled retry.
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await holds(f.issueId)).filter(hold => hold.status !== "resolved" ||
      (hold.evidence.automaticRecovery as Record<string, unknown> | undefined)?.replay === "blocked")).toEqual([]);

    // Back to todo, then Retry. Keep the agent busy so the new run stays
    // queued instead of launching a provider in this test.
    await db.update(issues).set({ status: "todo", executionRunId: null, executionLockedAt: null })
      .where(eq(issues.id, f.issueId));
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running" }).returning();
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
      actorSource: "local_implicit", observedRunId: f.retryRunId, idempotencyKey: randomUUID() });
    expect(receipt).toMatchObject({ accepted: true, observedRunId: f.retryRunId });
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
    const queued = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(queued).toHaveLength(1);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!)))[0])
      .toMatchObject({ status: "coalesced", runId: queued[0].id });
    // The dispatch gate reads this same blocker when the agent becomes free.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  it("releases a hold an earlier release recorded, so Retry starts a fresh run", async () => {
    const f = await seed();
    await moveToBacklog(f);
    // The state tasks were left in before the fix: an automatic no-replay
    // hold on the cancelled retry, and the todo wake refused behind it.
    const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${f.retryRunId}`, status: "resolved", outcome: "blocked", ownerType: "board",
      nextAction: "Automatic recovery stopped.",
      evidence: { runId: f.retryRunId, originalFailureCode: "cancelled", adapterRecovery: "unsupported_or_unknown", attempt: 3,
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.retryRunId, replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    await db.update(issues).set({ status: "todo", executionRunId: null, executionLockedAt: null })
      .where(eq(issues.id, f.issueId));
    const [refused] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, runtimeMode: "legacy", status: "cancelled", errorCode: "execution_reconciliation_required",
      finishedAt: new Date(), contextSnapshot: { issueId: f.issueId },
      resultJson: { stopReason: "execution_reconciliation_required", timeoutSource: "stale_queued_run_gate",
        timeoutFired: false, timeoutConfigured: false, effectiveTimeoutSec: 0,
        executionWait: { issueId: f.issueId, recoveryActionId: hold.id } } }).returning();

    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running" }).returning();
    const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
      actorSource: "local_implicit", observedRunId: refused.id, idempotencyKey: randomUUID() });
    expect(receipt).toMatchObject({ accepted: true, observedRunId: refused.id });
    await heartbeatService(db).resumeTaskRetry(f.companyId, receipt.requestId!);
    const queued = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(queued).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    // The audit row is kept; it no longer blocks execution.
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold.id)))[0])
      .toMatchObject({ status: "resolved", outcome: "blocked" });
  });

  it.each(["started", "process", "stage", "execution_event", "unexpected_cancellation", "predecessor_superseded", "predecessor_blocked", "predecessor_deleted"] as const)(
    "keeps the hold when the cancelled retry shows it may have run: %s", async evidence => {
      const f = await seed();
      await moveToBacklog(f);
      // The retry continues its chain: a predecessor with its own unknown
      // outcome, or one that is gone, keeps the hold on the retry too.
      if (evidence === "predecessor_superseded" || evidence === "predecessor_blocked") await db.insert(issueRecoveryActions).values({
        companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
        cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${f.sourceRunId}`, ownerType: "board",
        ...(evidence === "predecessor_superseded"
          ? { status: "cancelled", outcome: "cancelled", nextAction: "Superseded by a newer hold.", evidence: { runId: f.sourceRunId } }
          : { status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
            evidence: { runId: f.sourceRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }) });
      else if (evidence === "predecessor_deleted") await db.update(heartbeatRuns).set({ retryOfRunId: null })
        .where(eq(heartbeatRuns.id, f.retryRunId));
      else if (evidence === "execution_event") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
        agentId: f.agentId, runId: f.retryRunId, seq: 1000, eventType: "tool.execution.started" });
      else {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.retryRunId));
        await db.update(heartbeatRuns).set({
          ...(evidence === "started" ? { startedAt: new Date() } : {}),
          ...(evidence === "process" ? { processPid: 999_999 } : {}),
          ...(evidence === "stage" ? { executionStage: "preparing" } : {}),
          ...(evidence === "unexpected_cancellation" ? { resultJson: { ...run.resultJson,
            cancellation: { ...(run.resultJson?.cancellation as Record<string, unknown>), expected: false } } } : {}),
        }).where(eq(heartbeatRuns.id, f.retryRunId));
      }
      const [hold] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
        fingerprint: `legacy-execution:${f.retryRunId}`, status: "resolved", outcome: "blocked", ownerType: "board",
        nextAction: "Automatic recovery stopped.",
        evidence: { runId: f.retryRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }).returning();
      // The task stays held (by the retry's hold, or by the predecessor's own one).
      expect(await getExecutionBlocker(db, f.companyId, f.issueId))
        .toMatchObject({ cause: "legacy_execution_requires_reconciliation" });
      expect(await holds(f.issueId)).toContainEqual(expect.objectContaining({ id: hold.id }));
      await db.delete(issueRecoveryActions).where(inArray(issueRecoveryActions.id, [hold.id]));
    });
});
