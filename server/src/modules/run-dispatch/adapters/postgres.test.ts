import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  budgetReservations,
  companies,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueDocuments,
  issueRelations,
  issueRecoveryActions,
  issueTreeHolds,
  issues,
  nativeRunFinalizations,
  projects,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "./postgres.js";
import { settleUnrecoverableExecutions } from "../../../services/execution-recovery-resolution.js";
import { getExecutionBlocker } from "../../../services/execution-blocker.js";
import { reserveRunBudget } from "../../../services/budget-reservations.js";
import { budgetService, recheckAdmittedRunBudgetReadOnly } from "../../../services/budgets.js";
import { costService } from "../../../services/costs.js";

// Proves the DB-to-facts mapping this adapter owns for each state the two
// run-dispatch gates decide on. `application/use-cases.test.ts` and
// `domain/policy.test.ts` cover the gates' branching with hand-built facts;
// this file proves the adapter reads the right rows into those facts, then
// feeds the mapped facts back through the real gate to prove the wiring
// produces the same suppression a caller would have seen before this module
// existed.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-dispatch adapter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("run-dispatch postgres adapter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-dispatch-postgres-adapter-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(environmentLeases);
    await db.delete(nativeRunFinalizations);
    await db.delete(activityLog);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueTreeHolds);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(): Promise<{ companyId: string; agentId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedAgent(input: {
    id: string;
    companyId: string;
    name: string;
    role?: string;
  }) {
    await db.insert(agents).values({
      id: input.id,
      companyId: input.companyId,
      name: input.name,
      role: input.role ?? "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
  }

  async function seedIssue(input: {
    companyId: string;
    issueId: string;
    status: string;
    assigneeAgentId?: string | null;
    executionState?: Record<string, unknown> | null;
  }) {
    await db.insert(issues).values({
      id: input.issueId,
      companyId: input.companyId,
      title: "Run-dispatch adapter fixture issue",
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      executionState: input.executionState ?? null,
    });
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    contextSnapshot?: Record<string, unknown>;
    status?: "queued" | "running" | "scheduled_retry";
    scheduledRetryReason?: string | null;
    now?: Date;
  }) {
    const runId = randomUUID();
    const now = input.now ?? new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "retry",
      status: input.status ?? "queued",
      contextSnapshot: input.contextSnapshot ?? {},
      scheduledRetryReason: input.scheduledRetryReason ?? null,
      scheduledRetryAt: input.status === "scheduled_retry" ? now : null,
      createdAt: now,
      updatedAt: now,
    });
    return runId;
  }

  async function seedCleanupRetry(status: "scheduled_retry" | "queued" = "scheduled_retry") {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const now = new Date();
    await seedIssue({ companyId, issueId, assigneeAgentId: agentId, status: "in_progress" });
    const sourceId = await seedRun({ companyId, agentId, contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: now,
      resultJson: { conversationContinuation: "continue_conversation_v1", workspaceRestoreFailure: "restore_failed" },
    }).where(eq(heartbeatRuns.id, sourceId));
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId,
      heartbeatRunId: sourceId, status: "pending_cleanup", cleanupStatus: "failed",
    }).returning();
    const runId = await seedRun({ companyId, agentId, status, now,
      contextSnapshot: { issueId, retryOfRunId: sourceId, executionRetryAccounting: { version: 1, failureRetries: 1, maxTurnContinuations: 0 } },
      scheduledRetryReason: "transient_failure",
    });
    await db.update(heartbeatRuns).set({ retryOfRunId: sourceId, scheduledRetryAttempt: 1,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, sourceId, leaseId: lease!.id, runId, now };
  }

  it("keeps one scheduled retry through cleanup and promotes it once after release", async () => {
    const f = await seedCleanupRetry();
    let adapter = createPostgresRunDispatchAdapter(db);
    for (let attempt = 0; attempt < 4; attempt++) {
      expect(await adapter.promoteOrCancelDueRetry({ ...f, now: new Date(f.now.getTime() + attempt * 60_000) }))
        .toMatchObject({ outcome: "not_promoted" });
      // Reconstruct the service to prove the wait survives controller restart.
      adapter = createPostgresRunDispatchAdapter(db);
    }
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run).toMatchObject({ status: "scheduled_retry", startedAt: null, finishedAt: null,
      retryOfRunId: f.sourceId, scheduledRetryAttempt: 1,
      contextSnapshot: { executionRetryAccounting: { failureRetries: 1 } },
    });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(2);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    expect(events.filter(e => e.message?.includes("waiting for execution cleanup"))).toHaveLength(1);
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() })
      .where(eq(environmentLeases.id, f.leaseId));
    const now = new Date(f.now.getTime() + 300_000);
    const outcomes = await Promise.all([
      adapter.promoteOrCancelDueRetry({ ...f, now }), adapter.promoteOrCancelDueRetry({ ...f, now }),
    ]);
    expect(outcomes.filter(o => o.outcome === "promoted")).toHaveLength(1);
    const [resumed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(resumed).toMatchObject({ status: "queued", scheduledRetryAttempt: 1 });
    expect(resumed.resultJson).not.toHaveProperty("executionWait");
    expect(await adapter.cancelStaleQueuedRun({ ...f, now, expectedStatus: "queued" }))
      .toMatchObject({ outcome: "not_stale" });
  });

  it("parks the same unstarted retry if cleanup becomes pending after promotion", async () => {
    const f = await seedCleanupRetry("queued");
    const adapter = createPostgresRunDispatchAdapter(db);
    expect(await adapter.cancelStaleQueuedRun({ ...f, expectedStatus: "queued" }))
      .toMatchObject({ outcome: "deferred" });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1, startedAt: null, finishedAt: null });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBe(f.runId);
  });

  it("still suppresses a cleanup-waiting retry when the task is cancelled", async () => {
    const f = await seedCleanupRetry();
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    expect(await createPostgresRunDispatchAdapter(db).promoteOrCancelDueRetry(f))
      .toMatchObject({ outcome: "gate_suppressed", errorCode: "issue_cancelled" });
  });

  it("still suppresses a cleanup-waiting retry after reassignment", async () => {
    const f = await seedCleanupRetry();
    const newOwnerId = randomUUID();
    await seedAgent({ id: newOwnerId, companyId: f.companyId, name: "New owner" });
    await db.update(issues).set({ assigneeAgentId: newOwnerId }).where(eq(issues.id, f.issueId));
    expect(await createPostgresRunDispatchAdapter(db).promoteOrCancelDueRetry(f))
      .toMatchObject({ outcome: "gate_suppressed", errorCode: "issue_reassigned" });
  });

  it("retains a no-replay hold after cleanup releases ownership", async () => {
    const f = await seedCleanupRetry();
    const adapter = createPostgresRunDispatchAdapter(db);
    await db.insert(issueRecoveryActions).values({
      companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      ownerType: "board", cause: "uncertain_external_action", status: "resolved",
      evidence: { automaticRecovery: { replay: "blocked" } }, fingerprint: f.sourceId,
      nextAction: "Verify the external action before continuing.",
    });
    expect(await adapter.promoteOrCancelDueRetry(f)).toMatchObject({ outcome: "not_promoted" });
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() })
      .where(eq(environmentLeases.id, f.leaseId));
    const now = new Date(f.now.getTime() + 60_000);
    expect(await adapter.promoteOrCancelDueRetry({ ...f, now })).toMatchObject({ outcome: "promoted" });
    expect(await adapter.cancelStaleQueuedRun({ ...f, now, expectedStatus: "queued" }))
      .toMatchObject({ outcome: "cancelled", errorCode: "execution_reconciliation_required" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ cause: "uncertain_external_action" });
  });

  it.each(["native", "started", "non-conversation"])("does not park a %s run behind cleanup", async (mode) => {
    const f = await seedCleanupRetry("queued");
    await db.update(heartbeatRuns).set(mode === "native" ? { runtimeMode: "native" }
      : mode === "started" ? { startedAt: f.now } : { resultJson: {} })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({ ...f, expectedStatus: "queued" }))
      .toMatchObject({ outcome: "cancelled", errorCode: "execution_reconciliation_required" });
  });

  async function seedContinuationSummary(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    body: string;
  }) {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId: input.companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: input.body,
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: input.agentId,
      updatedByAgentId: input.agentId,
    });
    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId: input.companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: input.body,
      createdByAgentId: input.agentId,
    });
    await db.insert(issueDocuments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    });
  }

  it.each([
    ["executionRunId", "native_safe_replacement"], ["checkoutRunId", "native_safe_replacement"],
    ["executionRunId", "native_provider_overloaded"], ["checkoutRunId", "native_provider_overloaded"],
  ] as const)("suppresses delayed retry after another run acquires %s (%s)", async (lock, retryReason) => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await seedIssue({ companyId, issueId, assigneeAgentId: agentId, status: "in_progress" });
    const contextSnapshot = { issueId, wakeReason: retryReason, retryReason, forceFreshSession: true };
    const replacementId = await seedRun({ companyId, agentId, status: "scheduled_retry", contextSnapshot });
    const competingId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ [lock]: competingId }).where(eq(issues.id, issueId));
    const adapter = createPostgresRunDispatchAdapter(db);
    expect(await adapter.evaluateScheduledRetryGate({ companyId, runId: replacementId, retryReasonOverride: retryReason, now: new Date() }))
      .toMatchObject({ allowed: false, errorCode: "issue_execution_lock_changed" });
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, replacementId));
    const reservation = await reserveRunBudget(db, companyId, replacementId, null);
    expect(await adapter.cancelStaleQueuedRun({ companyId, runId: replacementId, expectedStatus: "queued", now: new Date() }))
      .toMatchObject({ outcome: "cancelled", errorCode: "issue_execution_lock_changed" });

    // A competing owner can also appear after queue validation. The final
    // dispatch gate must prevent any provider call, even from a running row.
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, replacementId));
    let dispatched = false;
    const outcome = await adapter.dispatchResolvedInteractionIfCurrent({ companyId, runId: replacementId,
      reservationId: reservation.id, expectedStatus: "running", now: new Date(), dispatch: async () => { dispatched = true; } });
    expect(outcome).toMatchObject({ dispatched: false, cancellation: { outcome: "cancelled" } });
    expect(dispatched).toBe(false);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]![lock]).toBe(competingId);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, competingId)))[0]?.status).toBe("running");
  });

  it.each(["native_safe_replacement", "native_provider_overloaded"])("does not dispatch %s when the task becomes blocked after scheduling", async retryReason => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await seedIssue({ companyId, issueId, assigneeAgentId: agentId, status: "in_progress" });
    const contextSnapshot = { issueId, wakeReason: retryReason, retryReason: retryReason, forceFreshSession: true };
    const replacementId = await seedRun({ companyId, agentId, status: "scheduled_retry", contextSnapshot });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
    const adapter = createPostgresRunDispatchAdapter(db);
    expect(await adapter.evaluateScheduledRetryGate({ companyId, runId: replacementId, retryReasonOverride: retryReason, now: new Date() }))
      .toMatchObject({ allowed: false, errorCode: "issue_blocked" });
    await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, replacementId));
    const reservation = await reserveRunBudget(db, companyId, replacementId, null);
    expect(await adapter.cancelStaleQueuedRun({ companyId, runId: replacementId, expectedStatus: "queued", now: new Date() }))
      .toMatchObject({ outcome: "cancelled", errorCode: "issue_blocked" });
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, replacementId));
    const dispatch = vi.fn(async () => undefined);
    expect(await adapter.dispatchResolvedInteractionIfCurrent({ companyId, runId: replacementId, reservationId: reservation.id, expectedStatus: "running", now: new Date(), dispatch }))
      .toMatchObject({ dispatched: false, cancellation: { outcome: "cancelled" } });
    expect(dispatch).not.toHaveBeenCalled();
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("blocked");
  });

  it.each(["queued", "final", "resolved"] as const)("rechecks late native replacement dependencies at %s dispatch", async mode => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID(), blockerId = randomUUID();
    await seedIssue({ companyId, issueId, assigneeAgentId: agentId, status: "in_progress" });
    await seedIssue({ companyId, issueId: blockerId, status: "todo" });
    const contextSnapshot = { issueId, wakeReason: "native_safe_replacement", retryReason: "native_safe_replacement", forceFreshSession: true };
    const replacementId = await seedRun({ companyId, agentId, status: "scheduled_retry", contextSnapshot });
    const adapter = createPostgresRunDispatchAdapter(db);
    expect(await adapter.evaluateScheduledRetryGate({ companyId, runId: replacementId, retryReasonOverride: "native_safe_replacement", now: new Date() }))
      .toMatchObject({ allowed: true });
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    const dispatch = vi.fn(async () => undefined);
    if (mode === "queued") {
      await db.update(heartbeatRuns).set({ status: "queued" }).where(eq(heartbeatRuns.id, replacementId));
      expect(await adapter.cancelStaleQueuedRun({ companyId, runId: replacementId, expectedStatus: "queued", now: new Date() }))
        .toMatchObject({ outcome: "cancelled", errorCode: "issue_dependencies_blocked" });
    } else {
      if (mode === "resolved") await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerId));
      await db.update(issues).set({ executionRunId: replacementId }).where(eq(issues.id, issueId));
      await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, replacementId));
      const reservation = await reserveRunBudget(db, companyId, replacementId, null);
      const result = await adapter.dispatchResolvedInteractionIfCurrent({ companyId, runId: replacementId, reservationId: reservation.id, expectedStatus: "running", now: new Date(), dispatch });
      expect(result).toMatchObject(mode === "resolved" ? { dispatched: true } : {
        dispatched: false, cancellation: { outcome: "cancelled", errorCode: "issue_dependencies_blocked" },
      });
    }
    expect(dispatch).toHaveBeenCalledTimes(mode === "resolved" ? 1 : 0);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.status).toBe("in_progress");
  });

  it("commits the handoff without awaiting a recovered provider that fails before spawning", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await seedIssue({ companyId, issueId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const adapter = createPostgresRunDispatchAdapter(db);
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    const gate = await adapter.dispatchResolvedInteractionIfCurrent({
      companyId, runId, reservationId: reservation.id, expectedStatus: "running", now: new Date(),
      dispatch: async () => {
        // The incident's third attempt failed here before onSpawn. A held
        // admission lock makes this finalization fail with lock_timeout.
        await db.transaction(async tx => {
          await tx.execute(sql`select set_config('lock_timeout', '1000', true)`);
          await tx.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
          await tx.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
        });
        return "provider_checkpoint_failed_terminal";
      },
    });
    expect(gate.dispatched).toBe(true);
    if (gate.dispatched) expect(await gate.resultPromise).toBe("provider_checkpoint_failed_terminal");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status).toBe("failed");
  });

  it("commits dispatch authority before provider HTTP and permits accounting while that provider waits", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    await budgetService(db).upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, notifyEnabled: false }, null);
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    let readyToCommit!: () => void, commit!: () => void, providerArrived!: () => void, finishProvider!: () => void;
    let readyToHandoff!: () => void, commitHandoff!: () => void;
    const ready = new Promise<void>(resolve => { readyToCommit = resolve; });
    const commitAllowed = new Promise<void>(resolve => { commit = resolve; });
    const arrived = new Promise<void>(resolve => { providerArrived = resolve; });
    const providerResponse = new Promise<void>(resolve => { finishProvider = resolve; });
    const handoffReady = new Promise<void>(resolve => { readyToHandoff = resolve; });
    const handoffCommit = new Promise<void>(resolve => { commitHandoff = resolve; });
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      providerArrived();
      void providerResponse.then(() => response.end("provider result"));
    });
    await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a provider HTTP fixture port");
    const dispatch = vi.fn(async () => (await fetch(`http://127.0.0.1:${address.port}`)).text());
    const transaction = db.transaction.bind(db);
    let transactionNumber = 0;
    // Freeze the exact SQL commit boundary. A provider callback inside the
    // accounting transaction would contact this server before we release it.
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      const phase = ++transactionNumber;
      return transaction(async tx => {
        const value = await callback(tx);
        if (phase === 1) { readyToCommit(); await commitAllowed; }
        if (phase === 2) { readyToHandoff(); await handoffCommit; }
        return value;
      }, config);
    });
    const admission = createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({
      companyId, runId, reservationId: reservation.id, expectedStatus: "running", now: new Date(), dispatch,
    });
    let result: Promise<string> | undefined;
    let charge: Promise<unknown> | undefined;
    try {
      await ready;
      expect(dispatch).not.toHaveBeenCalled();
      expect(requests).toBe(0);
      commit();
      await Promise.all([arrived, handoffReady]);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(run.usageJson?.budgetDispatch).toMatchObject({ reservationId: reservation.id, recoveryLeaseOwner: null });
      // This charge serializes after dispatch admission. It creates stop intent
      // for already-admitted work without waiting for the provider's response.
      let charged = false;
      charge = costService(db).createEvent(companyId, { agentId, provider: "fixture", model: "post-admission-charge",
        costCents: 100, inputTokens: 1, outputTokens: 1, occurredAt: new Date() }).then(() => { charged = true; });
      void charge.catch(() => {});
      // Phase two still owns issue/run locks and the provider is waiting.
      // Holding company accounting here would stall this independent charge.
      await vi.waitFor(() => expect(charged).toBe(true), { timeout: 2_000 });
      const [policy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId));
      expect(policy.enforcementVersion).toBeGreaterThan(policy.enforcementDeliveredVersion);
      expect(requests).toBe(1);
      commitHandoff();
      const gate = await admission;
      transactionSpy.mockRestore();
      expect(gate.dispatched).toBe(true);
      if (!gate.dispatched) throw new Error("Expected committed provider admission");
      result = gate.resultPromise;
      finishProvider();
      expect(await result).toBe("provider result");
    } finally {
      commit();
      commitHandoff();
      finishProvider();
      transactionSpy.mockRestore();
      await admission.catch(() => undefined);
      await result?.catch(() => undefined);
      await charge?.catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>(resolve => { server.close(() => resolve()); });
    }
  });

  it("does not hand off when another run takes issue ownership after accounting admission commits", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    const competingId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    const transaction = db.transaction.bind(db);
    let admitted = false;
    const race = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      const value = await transaction(callback, config);
      if (!admitted) { admitted = true; await db.update(issues).set({ executionRunId: competingId }).where(eq(issues.id, issueId)); }
      return value;
    });
    const dispatch = vi.fn(async () => "must not run");
    try {
      expect(await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({ companyId, runId,
        reservationId: reservation.id, expectedStatus: "running", now: new Date(), dispatch })).toMatchObject({ dispatched: false,
          cancellation: { outcome: "cancelled", errorCode: "issue_execution_lock_changed" } });
      expect(dispatch).not.toHaveBeenCalled();
      expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBe(competingId);
    } finally { race.mockRestore(); }
  });

  it.each(["charge", "budget reduction"] as const)("rejects a committed %s between accounting admission and final ownership handoff", async change => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    const budgets = budgetService(db);
    await budgets.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, reservationCents: "60", notifyEnabled: false }, null);
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    const transaction = db.transaction.bind(db);
    let admitted = false;
    const race = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      const value = await transaction(callback, config);
      if (!admitted) {
        admitted = true;
        if (change === "charge") await costService(db).createEvent(companyId, { agentId, provider: "fixture",
          model: "between-phase-charge", inputTokens: 1, outputTokens: 1, costCents: 50, occurredAt: new Date() });
        else await budgets.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
          metric: "billed_cents", windowKind: "lifetime", amount: 50 }, null);
      }
      return value;
    });
    const dispatch = vi.fn(async () => "must not run");
    try {
      expect(await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({ companyId, runId,
        reservationId: reservation.id, expectedStatus: "running", now: new Date(), dispatch })).toMatchObject({ dispatched: false,
          admissionBlockReason: "Available budget is reserved by unfinished runs" });
      expect(dispatch).not.toHaveBeenCalled();
      // Neither case has actually spent its hard-stop limit. The denial must
      // observe capacity, rather than relying only on a projected pause flag.
      expect((await db.select().from(companies).where(eq(companies.id, companyId)))[0].status).toBe("active");
    } finally { race.mockRestore(); }
  });

  it("performs the post-admission capacity check in a PostgreSQL read-only transaction", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    await budgetService(db).upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, reservationCents: "60", notifyEnabled: false }, null);
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    await db.transaction(async tx => {
      await tx.execute(sql`set transaction read only`);
      // PostgreSQL rejects both writes and SELECT FOR UPDATE in this mode.
      expect(await recheckAdmittedRunBudgetReadOnly(tx as unknown as typeof db,
        { companyId, agentId, runId, projectId: null, reservationId: reservation.id })).toBeNull();
    });
  });

  it("does not dispatch into an archival project deleted after accounting admission", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    const [project] = await db.insert(projects).values({ companyId, name: "Dispatch project" }).returning();
    const reservation = await reserveRunBudget(db, companyId, runId, project.id);
    const transaction = db.transaction.bind(db);
    let admitted = false;
    const race = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      const value = await transaction(callback, config);
      if (!admitted) { admitted = true; await db.delete(projects).where(eq(projects.id, project.id)); }
      return value;
    });
    const dispatch = vi.fn(async () => "must not run");
    try {
      expect(await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({ companyId, runId,
        reservationId: reservation.id, expectedStatus: "running", now: new Date(), dispatch })).toMatchObject({ dispatched: false,
          admissionBlockReason: "Reserved project no longer exists" });
      expect(dispatch).not.toHaveBeenCalled();
      expect((await db.select().from(budgetReservations).where(eq(budgetReservations.id, reservation.id)))[0])
        .toMatchObject({ state: "held", projectId: project.id });
    } finally { race.mockRestore(); }
  });

  it("initiates the provider callback while the final issue ownership lock is held without awaiting its response", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: agentId });
    const runId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    const competingId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    const transaction = db.transaction.bind(db);
    let phase = 0, finishProvider!: () => void;
    const response = new Promise<void>(resolve => { finishProvider = resolve; });
    const ordering: string[] = [];
    const race = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      const current = ++phase;
      const value = await transaction(callback, config);
      if (current === 2) {
        await db.update(issues).set({ executionRunId: competingId }).where(eq(issues.id, issueId));
        ordering.push("competing-owner");
      }
      return value;
    });
    try {
      const gate = await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({ companyId, runId,
        reservationId: reservation.id, expectedStatus: "running", now: new Date(),
        dispatch: () => { ordering.push("handoff"); return response; } });
      expect(gate.dispatched).toBe(true);
      expect(ordering).toEqual(["handoff", "competing-owner"]);
      finishProvider();
      if (gate.dispatched) await gate.resultPromise;
    } finally { finishProvider(); race.mockRestore(); }
  });

  it.each(["0", "25"])("fences duplicate handoff of a %s-cent reservation generation", async reservationCents => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    await budgetService(db).upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, reservationCents, notifyEnabled: false }, null);
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    const dispatch = vi.fn(async () => "one handoff");
    const input = { companyId, runId, reservationId: reservation.id, expectedStatus: "running" as const, now: new Date(), dispatch };
    const adapter = createPostgresRunDispatchAdapter(db);
    const first = await adapter.dispatchResolvedInteractionIfCurrent(input);
    expect(first.dispatched).toBe(true);
    if (first.dispatched) await first.resultPromise;
    expect(await adapter.dispatchResolvedInteractionIfCurrent(input)).toMatchObject({ dispatched: false,
      admissionBlockReason: "Provider dispatch already admitted this reservation generation" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("does not enter a provider when its dispatch claim rolls back", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    const transaction = db.transaction.bind(db);
    const rollback = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => transaction(async tx => {
      await callback(tx);
      throw new Error("fixture commit rejected");
    }, config));
    const dispatch = vi.fn(async () => "must not run");
    try {
      await expect(createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({ companyId, runId,
        reservationId: reservation.id, expectedStatus: "running", now: new Date(), dispatch })).rejects.toThrow("fixture commit rejected");
      expect(dispatch).not.toHaveBeenCalled();
    } finally { rollback.mockRestore(); }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].usageJson?.budgetDispatch).toBeUndefined();
  });

  it("retains uncertain dispatch authority when the ownership commit fails after callback entry", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    const transaction = db.transaction.bind(db);
    let phase = 0;
    const rollback = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      const current = ++phase;
      return transaction(async tx => {
        const value = await callback(tx);
        if (current === 2) throw new Error("fixture ownership commit rejected");
        return value;
      }, config);
    });
    const dispatch = vi.fn(async () => "provider already entered");
    const input = { companyId, runId, reservationId: reservation.id, expectedStatus: "running" as const, now: new Date(), dispatch };
    try {
      await expect(createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent(input)).rejects.toThrow("fixture ownership commit rejected");
      expect(dispatch).toHaveBeenCalledOnce();
    } finally { rollback.mockRestore(); }
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({ costAccountingPending: true, costAccountedAt: null,
      usageJson: { budgetDispatch: { reservationId: reservation.id } } });
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.id, reservation.id)))[0].state).toBe("held");
    expect(await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent(input))
      .toMatchObject({ dispatched: false, admissionBlockReason: "Provider dispatch already admitted this reservation generation" });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(await db.select().from(costEvents)).toHaveLength(0);
  });

  it("commits the ownership handoff when a provider callback throws synchronously", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    const failure = new Error("synchronous provider bootstrap failure");
    const dispatch = vi.fn(() => { throw failure; });
    const input = { companyId, runId, reservationId: reservation.id, expectedStatus: "running" as const, now: new Date(), dispatch };
    const gate = await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent(input);
    expect(gate.dispatched).toBe(true);
    if (gate.dispatched) await expect(gate.resultPromise).rejects.toBe(failure);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].usageJson?.budgetDispatch)
      .toMatchObject({ reservationId: reservation.id, handedOffAt: expect.any(String) });
    expect(await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent(input))
      .toMatchObject({ dispatched: false, admissionBlockReason: "Provider dispatch already admitted this reservation generation" });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it.each(["charge", "budget reduction"] as const)("rechecks a late %s after ordinary run preparation before any provider handoff", async change => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    const budgets = budgetService(db);
    await budgets.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, reservationCents: "60", notifyEnabled: false }, null);
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    let finishPreparation!: () => void;
    const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
    const dispatch = vi.fn(async () => "provider started");
    const preparedDispatch = preparation.then(() => createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({
      companyId, runId, reservationId: reservation.id, expectedStatus: "running", now: new Date(), dispatch,
    }));
    try {
      if (change === "charge") await costService(db).createEvent(companyId, {
        agentId, provider: "test", model: "dispatch-race", costCents: 50,
        inputTokens: 1, outputTokens: 1, occurredAt: new Date(),
      });
      else await budgets.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
        metric: "billed_cents", windowKind: "lifetime", amount: 50 }, null);
      finishPreparation();
      expect(await preparedDispatch).toMatchObject({ dispatched: false,
        admissionBlockReason: "Available budget is reserved by unfinished runs" });
      expect(dispatch).not.toHaveBeenCalled();
    } finally { finishPreparation(); await preparedDispatch; }
  });

  it("does not count its own existing reservation twice at final handoff", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    await budgetService(db).upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, reservationCents: "100", notifyEnabled: false }, null);
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    const dispatch = vi.fn(async () => "started");
    const gate = await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({
      companyId, runId, reservationId: reservation.id, expectedStatus: "running", now: new Date(), dispatch,
    });
    expect(gate.dispatched).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    if (gate.dispatched) expect(await gate.resultPromise).toBe("started");
  });

  it("does not dispatch a zero reservation once other work has fully reserved capacity", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    const budgets = budgetService(db);
    await budgets.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, reservationCents: "0", notifyEnabled: false }, null);
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    await budgets.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "lifetime", reservationCents: "100" }, null);
    const otherRunId = await seedRun({ companyId, agentId, status: "running" });
    await reserveRunBudget(db, companyId, otherRunId, null);
    const dispatch = vi.fn(async () => undefined);
    expect(await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({
      companyId, runId, reservationId: reservation.id, expectedStatus: "running", now: new Date(), dispatch,
    })).toMatchObject({ dispatched: false, admissionBlockReason: "Available budget is reserved by unfinished runs" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("commits a discovered budget stop even when final handoff is denied", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const runId = await seedRun({ companyId, agentId, status: "running" });
    await budgetService(db).upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, notifyEnabled: false }, null);
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    // Seed committed historical spend whose lifecycle projection has not yet
    // been repaired. The gate must persist that repair rather than roll it back.
    await db.insert(costEvents).values({ companyId, agentId, provider: "test", model: "unprojected-charge",
      inputTokens: 1, outputTokens: 1, costCents: 110, occurredAt: new Date() });
    const dispatch = vi.fn(async () => undefined);
    expect(await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({
      companyId, runId, reservationId: reservation.id, expectedStatus: "running", now: new Date(), dispatch,
    })).toMatchObject({ dispatched: false, admissionBlockReason: expect.any(String) });
    expect(dispatch).not.toHaveBeenCalled();
    expect((await db.select().from(companies).where(eq(companies.id, companyId)))[0])
      .toMatchObject({ status: "paused", pauseReason: "budget" });
    const [policy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId));
    expect(policy.enforcementVersion).toBeGreaterThan(policy.enforcementDeliveredVersion);
  });

  it.each([false, true])("preserves accepted non-assignee work while retaining its final budget gate (late reduction: %s)", async reduceBudget => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const assigneeId = randomUUID(), issueId = randomUUID();
    await seedAgent({ id: assigneeId, companyId, name: "Assigned owner" });
    await seedIssue({ companyId, issueId, assigneeAgentId: assigneeId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "running",
      contextSnapshot: { issueId, wakeReason: "issue_comment_mentioned", commentId: randomUUID() } });
    const budgets = budgetService(db);
    await budgets.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, reservationCents: "60", notifyEnabled: false }, null);
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    if (reduceBudget) await budgets.upsertPolicy(companyId, { scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "lifetime", amount: 50 }, null);
    const dispatch = vi.fn(async () => "accepted mention delivered");
    const gate = await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({ companyId, runId,
      reservationId: reservation.id, expectedStatus: "running", enforceContinuationOwnership: false, now: new Date(), dispatch });
    expect(gate.dispatched).toBe(!reduceBudget);
    expect(dispatch).toHaveBeenCalledTimes(reduceBudget ? 0 : 1);
    if (!gate.dispatched) expect(gate).toMatchObject({ admissionBlockReason: "Available budget is reserved by unfinished runs" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ assigneeAgentId: assigneeId, executionRunId: null });
  });

  async function seedRecoveryAdmission() {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID(), owner = `recovery:${randomUUID()}`;
    await seedIssue({ companyId, issueId, assigneeAgentId: agentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const reservation = await reserveRunBudget(db, companyId, runId, null);
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed",
      leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + 60_000) });
    return { companyId, agentId, issueId, runId, owner, reservation };
  }

  it.each(["reservation", "dispatch"] as const)("orders recovery %s behind a coordinator before taking finalization's issue and run locks", async boundary => {
    const f = await seedRecoveryAdmission();
    let signalLocked!: () => void, allowFinalization!: () => void;
    const locked = new Promise<void>(resolve => { signalLocked = resolve; });
    const proceed = new Promise<void>(resolve => { allowFinalization = resolve; });
    const finalization = db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '2000ms'`);
      await tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, f.runId)).for("update");
      signalLocked();
      await proceed;
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
      await tx.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    });
    await Promise.race([locked, finalization]);
    const dispatch = vi.fn(async () => "one provider handoff");
    const gateInput = { companyId: f.companyId, runId: f.runId, reservationId: f.reservation.id,
      expectedStatus: "running" as const, recoveryLeaseOwner: f.owner, now: new Date(), dispatch };
    const recovery = boundary === "dispatch"
      ? createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent(gateInput)
      : reserveRunBudget(db, f.companyId, f.runId, null, {}, f.owner).then(reservation => {
          expect(reservation.reused).toBe(true);
          return createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({ ...gateInput, reservationId: reservation.id });
        });
    try {
      expect(await waitForBlockedForUpdate("native_run_finalizations")).toBe(true);
      allowFinalization();
      await finalization;
      const gate = await recovery;
      expect(gate.dispatched).toBe(true);
      if (gate.dispatched) expect(await gate.resultPromise).toBe("one provider handoff");
      expect(await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent(gateInput))
        .toMatchObject({ dispatched: false, admissionBlockReason: "Provider dispatch already admitted this reservation generation" });
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      allowFinalization();
      await Promise.allSettled([finalization, recovery]);
    }
  });

  it.each(["expired", "replaced"] as const)("does not admit recovery under an %s coordinator owner", async ownership => {
    const f = await seedRecoveryAdmission();
    await db.update(nativeRunFinalizations).set(ownership === "expired"
      ? { leaseExpiresAt: new Date(Date.now() - 1) } : { leaseOwner: "another-owner" }).where(eq(nativeRunFinalizations.runId, f.runId));
    await expect(reserveRunBudget(db, f.companyId, f.runId, null, {}, f.owner)).rejects.toThrow("Native recovery no longer owns provider dispatch");
    const dispatch = vi.fn(async () => undefined);
    await expect(createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({ companyId: f.companyId, runId: f.runId,
      reservationId: f.reservation.id, recoveryLeaseOwner: f.owner, expectedStatus: "running", now: new Date(), dispatch }))
      .rejects.toThrow("Native recovery no longer owns provider dispatch");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("rechecks recovery lease expiry after waiting for the issue lock", async () => {
    const f = await seedRecoveryAdmission();
    const expiresAt = new Date(Date.now() + 1_000);
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: expiresAt }).where(eq(nativeRunFinalizations.runId, f.runId));
    let signalLocked!: () => void, releaseIssue!: () => void;
    const locked = new Promise<void>(resolve => { signalLocked = resolve; });
    const release = new Promise<void>(resolve => { releaseIssue = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
      signalLocked();
      await release;
    });
    await Promise.race([locked, holder]);
    const dispatch = vi.fn(async () => undefined);
    const recovery = createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({ companyId: f.companyId,
      runId: f.runId, reservationId: f.reservation.id, recoveryLeaseOwner: f.owner, expectedStatus: "running", now: new Date(), dispatch });
    try {
      expect(await waitForBlockedForUpdate("issues")).toBe(true);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now() + 10)));
      releaseIssue();
      expect(await recovery).toMatchObject({ dispatched: false, admissionBlockReason: "Native recovery no longer owns provider dispatch" });
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      releaseIssue();
      await Promise.allSettled([holder, recovery]);
    }
  });

  async function waitForBlockedForUpdate(tableName: string) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [waiting] = await db.execute<{ waiting: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE ${`%${tableName}%`}
            AND query ILIKE '%for update%'
        ) AS waiting
      `);
      if (waiting?.waiting) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  async function reassignIssueAndLockRunOnceAConcurrentWaiterBlocks(
    issueId: string,
    runId: string,
    newAssigneeAgentId: string,
  ) {
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const transaction = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      signalLocked();
      if (!(await waitForBlockedForUpdate("issues"))) {
        throw new Error("expected a concurrent `for update` waiter on issues");
      }
      // The production claim path locks issue -> wake -> run. Taking the run
      // lock here proves the semantic adapter follows the same ordering: if it
      // held run while waiting for issue, these two transactions would deadlock.
      await tx
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .for("update");
      await tx
        .update(issues)
        .set({ assigneeAgentId: newAssigneeAgentId })
        .where(eq(issues.id, issueId));
    });
    // Await lock acquisition before starting the competing operation. Keep
    // completion separate so setup does not wait for that operation to finish.
    await Promise.race([locked, transaction]);
    return { done: transaction };
  }

  describe("evaluateScheduledRetryGate", () => {
    it("maps a disabled on-demand wake into a blocked scheduled-retry gate decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      await db
        .update(agents)
        .set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } })
        .where(eq(agents.id, agentId));

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({ companyId, agentId });
      const result = await adapter.evaluateScheduledRetryGate({
        runId,
        companyId,
        retryReasonOverride: "other",
        now,
      });

      expect(result).toMatchObject({
        allowed: false,
        errorCode: "heartbeat_wake_on_demand_disabled",
      });
    });

    it("maps an active subtree pause hold into a blocked scheduled-retry gate decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: agentId });
      await db.insert(issueTreeHolds).values({
        companyId,
        rootIssueId: issueId,
        mode: "pause",
        status: "active",
        reason: "manual pause for review",
        releasePolicy: { strategy: "manual" },
      });

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId } });
      const result = await adapter.evaluateScheduledRetryGate({
        runId,
        companyId,
        retryReasonOverride: "other",
        now,
      });

      expect(result).toMatchObject({
        allowed: false,
        errorCode: "issue_paused",
      });
    });

    it("maps an unresolved dependency blocker into a blocked scheduled-retry gate decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      const blockerId = randomUUID();
      await seedIssue({ companyId, issueId, status: "blocked", assigneeAgentId: agentId });
      await seedIssue({ companyId, issueId: blockerId, status: "todo" });
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: issueId,
        type: "blocks",
      });

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId } });
      const result = await adapter.evaluateScheduledRetryGate({
        runId,
        companyId,
        retryReasonOverride: "other",
        now,
      });

      expect(result).toMatchObject({
        allowed: false,
        errorCode: "issue_dependencies_blocked",
        details: { unresolvedBlockerIssueIds: [blockerId] },
      });
    });

    it("maps a changed review participant into a blocked scheduled-retry gate decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const reviewerAgentId = randomUUID();
      await seedAgent({ id: reviewerAgentId, companyId, name: "ReviewerAgent", role: "qa" });
      const issueId = randomUUID();
      await seedIssue({
        companyId,
        issueId,
        status: "in_review",
        assigneeAgentId: agentId,
        executionState: {
          status: "pending",
          currentStageId: randomUUID(),
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
          returnAssignee: { type: "agent", agentId, userId: null },
          reviewRequest: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      });

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId } });
      const result = await adapter.evaluateScheduledRetryGate({
        runId,
        companyId,
        retryReasonOverride: "other",
        now,
      });

      expect(result).toMatchObject({
        allowed: false,
        errorCode: "issue_review_participant_changed",
      });
    });

    it("maps a terminal issue status into a blocked scheduled-retry gate decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      await seedIssue({ companyId, issueId, status: "done", assigneeAgentId: agentId });

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId } });
      const result = await adapter.evaluateScheduledRetryGate({
        runId,
        companyId,
        retryReasonOverride: "other",
        now,
      });

      expect(result).toMatchObject({
        allowed: false,
        errorCode: "issue_terminal_status",
      });
    });
  });

  describe("cancelStaleQueuedRun", () => {
    it.each([
      { label: "chat source", source: "chat:slack", expected: "chat:slack" },
      {
        label: "native status source",
        source: "native_status_decision",
        expected: "native_status_decision",
      },
      { label: "absent source", source: undefined, expected: null },
      { label: "null source", source: null, expected: null },
      { label: "blank source", source: "   ", expected: null },
      { label: "numeric source", source: 42, expected: null },
      { label: "object source", source: { type: "chat:slack" }, expected: null },
      { label: "array source", source: ["chat:slack"], expected: null },
    ])("projects only the committed $label into a cancellation effect", async ({ source, expected }) => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      await seedIssue({ companyId, issueId, status: "done", assigneeAgentId: agentId });
      const runId = await seedRun({
        companyId,
        agentId,
        contextSnapshot: {
          issueId,
          wakeReason: "issue_assigned",
          ...(source === undefined ? {} : { source }),
          paperclipWake: { privateTestMarker: "not-for-the-status-effect" },
        },
      });
      const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        runId,
        companyId,
        expectedStatus: "queued",
        now: new Date(),
      });

      expect(outcome.outcome).toBe("cancelled");
      if (outcome.outcome !== "cancelled") throw new Error("expected stale run cancellation");
      expect(outcome.postCommitEffects).toHaveLength(1);
      const effect = outcome.postCommitEffects[0];
      expect(effect).toMatchObject({
        kind: "run_status_published",
        companyId,
        runId,
        agentId,
        issueId,
        status: "cancelled",
        previousStatus: "queued",
        errorCode: "issue_terminal_status",
        contextSource: expected,
      });
      expect(effect).not.toHaveProperty("contextSnapshot");
      expect(JSON.stringify(effect)).not.toContain("not-for-the-status-effect");
      const persisted = await db
        .select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0]);
      expect(persisted?.status).toBe("cancelled");
      expect(persisted?.contextSnapshot).toMatchObject({
        paperclipWake: { privateTestMarker: "not-for-the-status-effect" },
      });
    });

    it("maps a reassigned issue into a stale queued-run decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const replacementAgentId = randomUUID();
      await seedAgent({ id: replacementAgentId, companyId, name: "ReplacementCoder" });
      const issueId = randomUUID();
      await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: replacementAgentId });

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({
        companyId,
        agentId,
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      });
      const result = await adapter.cancelStaleQueuedRun({
        runId,
        companyId,
        expectedStatus: "queued",
        now,
      });

      expect(result).toMatchObject({
        outcome: "cancelled",
        errorCode: "issue_assignee_changed",
      });
    });

    it(
      "reads the locked issue state and cancels in the same semantic transaction",
      async () => {
        const { companyId, agentId } = await seedCompanyAndAgent();
        const replacementAgentId = randomUUID();
        await seedAgent({ id: replacementAgentId, companyId, name: "ReplacementCoder" });
        const issueId = randomUUID();
        await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: agentId });
        const runId = await seedRun({
          companyId,
          agentId,
          contextSnapshot: { issueId, wakeReason: "issue_assigned" },
        });

        const { done: holderDone } = await reassignIssueAndLockRunOnceAConcurrentWaiterBlocks(
          issueId,
          runId,
          replacementAgentId,
        );
        const outcome = await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
          runId,
          companyId,
          expectedStatus: "queued",
          now: new Date(),
        });
        await holderDone;

        expect(outcome).toMatchObject({
          outcome: "cancelled",
          errorCode: "issue_assignee_changed",
        });
        const persisted = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, runId))
          .then((rows) => rows[0]);
        expect(persisted?.status).toBe("cancelled");
      },
      15_000,
    );

    it("maps a review-parking continuation summary into a stale queued-run decision", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: agentId });
      await seedContinuationSummary({
        companyId,
        issueId,
        agentId,
        body: [
          "# Continuation Summary",
          "",
          "## Next Action",
          "",
          "- Wait for reviewer feedback or approval before continuing executor work.",
        ].join("\n"),
      });

      const adapter = createPostgresRunDispatchAdapter(db);
      const now = new Date();
      const runId = await seedRun({
        companyId,
        agentId,
        contextSnapshot: {
          issueId,
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
        },
      });
      const result = await adapter.cancelStaleQueuedRun({
        runId,
        companyId,
        expectedStatus: "queued",
        now,
      });

      expect(result).toMatchObject({
        outcome: "cancelled",
        errorCode: "issue_continuation_waiting_on_review",
      });
    });
  });

  describe("promoteOrCancelDueRetry", () => {
    async function seedScheduledRetryRun(input: {
      runId: string;
      companyId: string;
      agentId: string;
      issueId: string;
      now: Date;
    }) {
      await db.insert(heartbeatRuns).values({
        id: input.runId,
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "retry",
        status: "scheduled_retry",
        scheduledRetryAttempt: 1,
        scheduledRetryAt: input.now,
        scheduledRetryReason: "max_turns_continuation",
        contextSnapshot: { issueId: input.issueId },
        updatedAt: input.now,
        createdAt: input.now,
      });
    }

    it("promotes an allowed due retry", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      const runId = randomUUID();
      const now = new Date();
      await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: agentId });
      await seedScheduledRetryRun({ runId, companyId, agentId, issueId, now });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

      const adapter = createPostgresRunDispatchAdapter(db);
      const outcome = await adapter.promoteOrCancelDueRetry({
        runId,
        companyId,
        now,
      });

      expect(outcome.outcome).toBe("promoted");
      const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(row?.status).toBe("queued");
    });

    it("cancels a due retry a pause hold blocks", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const issueId = randomUUID();
      const runId = randomUUID();
      const now = new Date();
      await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: agentId });
      await db.insert(issueTreeHolds).values({
        companyId,
        rootIssueId: issueId,
        mode: "pause",
        status: "active",
        reason: "manual pause for review",
        releasePolicy: { strategy: "manual" },
      });
      await seedScheduledRetryRun({ runId, companyId, agentId, issueId, now });
      await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

      const adapter = createPostgresRunDispatchAdapter(db);
      const outcome = await adapter.promoteOrCancelDueRetry({
        runId,
        companyId,
        now,
      });

      expect(outcome.outcome).toBe("gate_suppressed");
      if (outcome.outcome === "gate_suppressed") {
        expect(outcome.errorCode).toBe("issue_paused");
      }
      const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(row?.status).toBe("cancelled");
    });

    it(
      "locks the issue row for the whole decision, so a reassignment committed while it waits is not missed",
      async () => {
        const { companyId, agentId: originalAgentId } = await seedCompanyAndAgent();
        const newAgentId = randomUUID();
        await seedAgent({ id: newAgentId, companyId, name: "ReplacementCoder" });
        const issueId = randomUUID();
        const runId = randomUUID();
        const now = new Date();
        await seedIssue({ companyId, issueId, status: "in_progress", assigneeAgentId: originalAgentId });
        await seedScheduledRetryRun({ runId, companyId, agentId: originalAgentId, issueId, now });
        await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

        // Acquire the issue row lock first and hold it until it observes a
        // concurrent `for update` waiter — the promote call below — proving
        // this is a real block, not a race the assertion got lucky on.
        const { done: holderDone } = await reassignIssueAndLockRunOnceAConcurrentWaiterBlocks(
          issueId,
          runId,
          newAgentId,
        );

        const adapter = createPostgresRunDispatchAdapter(db);
        const outcome = await adapter.promoteOrCancelDueRetry({
          runId,
          companyId,
          now,
        });
        await holderDone;

        // Without the lock, this call would have read the ORIGINAL assignee
        // (captured before the concurrent reassignment committed) and
        // promoted the run. With the lock, it waits for the reassignment to
        // commit, then reads the NEW assignee and cancels instead.
        expect(outcome.outcome).toBe("gate_suppressed");
        if (outcome.outcome === "gate_suppressed") {
          expect(outcome.errorCode).toBe("issue_reassigned");
        }
        const [row] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        expect(row?.status).toBe("cancelled");
      },
      15_000,
    );
  });
  it.each(["active", "resolved"])("blocks a generic retry after %s no-replay disposition", async status => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Uncertain email", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued", contextSnapshot: { issueId, wakeReason: "retry_failed_run" } });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: "board", cause: "uncertain_external_action", status, evidence: status === "resolved" ? { automaticRecovery: { replay: "blocked" } } : {}, fingerprint: runId, nextAction: "Verify whether email-1 was sent before continuing." });
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ cause: "uncertain_external_action", nextAction: "Verify whether email-1 was sent before continuing." });
    expect(await getExecutionBlocker(db, randomUUID(), issueId)).toBeNull();
    const adapter = createPostgresRunDispatchAdapter(db);
    await expect(adapter.cancelStaleQueuedRun({ companyId, runId, expectedStatus: "queued", now: new Date() })).resolves.toMatchObject({ outcome: "cancelled", errorCode: "execution_reconciliation_required" });
  });

  it.each(["active", "resolved"])("allows a new message through a historical %s interruption hold", async status => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, agentId));
    const issueId = randomUUID(), previousRunId = randomUUID(), runId = randomUUID();
    await seedIssue({ companyId, issueId, status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values([
      { id: previousRunId, companyId, agentId, status: "interrupted", errorCode: "server_shutdown_interrupted", contextSnapshot: { issueId } },
      { id: runId, companyId, agentId, status: "queued", contextSnapshot: { issueId, wakeReason: "issue_commented" } },
    ]);
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: previousRunId,
      seq: 1, eventType: "adapter.invoke", payload: { adapterType: "codex_local" } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", ownerType: "board", cause: "legacy_execution_requires_reconciliation", status,
      evidence: { runId: previousRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      fingerprint: previousRunId, nextAction: "Automatic recovery stopped.",
    }).returning();
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    const adapter = createPostgresRunDispatchAdapter(db);
    expect(await adapter.cancelStaleQueuedRun({ companyId, runId, expectedStatus: "queued", now: new Date() })).toMatchObject({ outcome: "not_stale" });
    await settleUnrecoverableExecutions(db);
    const [resolved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(resolved).toMatchObject({ status: "resolved", outcome: "cancelled", evidence: { runId: previousRunId } });
    expect(resolved.evidence.automaticRecovery).toMatchObject({ replay: "conversation_continuation", actionOutcome: "unknown" });
    await settleUnrecoverableExecutions(db);
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ companyId, action: "issue.execution_recovery_settled" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, previousRunId))).toHaveLength(0);
    // The upgrade does not silently resume historical blocked work.
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("blocked");
  });

  it.each(["process", "http", null])("keeps a historical %s hold after switching to a conversation adapter", async historicalAdapter => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, agentId));
    const issueId = randomUUID(), previousRunId = randomUUID();
    await seedIssue({ companyId, issueId, status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: previousRunId, companyId, agentId,
      status: "interrupted", errorCode: "server_shutdown_interrupted", contextSnapshot: { issueId } });
    if (historicalAdapter) await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: previousRunId,
      seq: 1, eventType: "adapter.invoke", payload: { adapterType: historicalAdapter } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId,
      kind: "active_run_watchdog", ownerType: "board", cause: "legacy_execution_requires_reconciliation", status: "active",
      evidence: { runId: previousRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      fingerprint: previousRunId, nextAction: "Inspect previous execution.",
    }).returning();
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: action!.id });
    await settleUnrecoverableExecutions(db);
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: action!.id });
    const [retained] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(retained.evidence.automaticRecovery).toMatchObject({ replay: "blocked", actionOutcome: "unknown" });
  });

  it("links the stopped run's agent instead of its return owner, within the same company", async () => {
    const { companyId, agentId: ownerId } = await seedCompanyAndAgent();
    const reviewerId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await seedAgent({ id: reviewerId, companyId, name: "Reviewer" });
    await seedIssue({ companyId, issueId, status: "in_review", assigneeAgentId: ownerId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: reviewerId, status: "cancelled" });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "active_run_watchdog", ownerType: "board",
      returnOwnerAgentId: ownerId, cause: "legacy_execution_requires_reconciliation", status: "active",
      evidence: { runId }, fingerprint: runId, nextAction: "Inspect the stopped reviewer.",
    }).returning();
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ runId, agentId: reviewerId });
    const other = await seedCompanyAndAgent();
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: other.companyId, agentId: other.agentId, status: "cancelled" });
    await db.update(issueRecoveryActions).set({ evidence: { runId: otherRunId } }).where(eq(issueRecoveryActions.id, action!.id));
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ agentId: null });
    await db.update(issueRecoveryActions).set({ evidence: { runId: "invalid" } }).where(eq(issueRecoveryActions.id, action!.id));
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ runId: null, agentId: null });
  });

});
