import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, budgetEvaluationWork, budgetPolicies, budgetReservations, companies, costAdjustments, costEvents, createDb, heartbeatRuns,
  issues, nativeRunFinalizations, runUsageReceipts, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { accountingIntegrityService } from "./accounting-integrity.js";
import { budgetService } from "./budgets.js";
import { reserveRunBudget } from "./budget-reservations.js";
import { costDataQualityReport } from "./cost-data-quality.js";
import { ACCOUNTING_CLOSURE_TIMEOUT_MS, OWNER_SETTLEMENT_WAIT_MS, accountRunCost, reconcileRunCosts } from "./run-cost-accounting.js";
import { REMOTE_RUNNER_RECONNECT_GRACE_MS } from "./native-runtime/native-runner-recovery-contract.js";
import { persistUsageReceipt, spoolUsageReceipt, type UsageReceiptEnvelope } from "./usage-receipts.js";
import * as usageReceipts from "./usage-receipts.js";

/** A run that stopped without its final usage receipt, and without evidence
 * Paperclip can use to prove that it stopped, used to stay pending forever.
 * Its held reservation kept counting against the budget and no supported
 * action could release it. */
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("owner-approved settlement of runs without a final usage receipt", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("run-accounting-settlement-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { await database?.cleanup(); });

  const service = (live = new Set<string>()) =>
    accountingIntegrityService(db, {}, async () => false, runId => live.has(runId));

  /** A company at 1000 cents with 400-cent run reservations, and a legacy run
   * that a restart interrupted in an earlier server boot. Its process identity
   * belongs to a process space this server cannot inspect. */
  async function fixture(change: Partial<typeof heartbeatRuns.$inferInsert> = {}, adapterType = "pi_local") {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Settlement lab", issuePrefix: `S${companyId.slice(0, 5)}` });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType },
      { id: otherAgentId, companyId, name: "Other", role: "engineer", status: "idle", adapterType: "process" },
    ]);
    await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId, metric: "billed_cents",
      windowKind: "lifetime", amount: 1_000, reservationCents: "400", notifyEnabled: false, unpricedUsagePolicy: "block" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Interrupted task", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    const finishedAt = new Date(Date.now() - 86_400_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "assignment", issueId: issue.id,
      runtimeMode: "legacy", status: "interrupted", errorCode: "server_shutdown_interrupted", finishedAt,
      controllerBootId: randomUUID(), controllerLeaseExpiresAt: null, processPid: 4242, processGroupId: 4242,
      processStartedAt: new Date(finishedAt.getTime() - 600_000), processHostHash: "earlier-container",
      costAccountingPending: true,
      usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 1, accountingReceiptReady: false,
        provider: "deepseek", biller: "deepseek", model: "synthetic-model", billingType: "metered_api",
        costStatus: "estimated", costUsd: 1.5, inputTokens: 1200, cachedInputTokens: 300, outputTokens: 200,
        budgetExposure: { sourceId, sequence: 1, costCents: "150.0000000" },
        ledgerScope: { issueId: issue.id, projectId: null } },
      ...change }).returning();
    await db.insert(budgetReservations).values({ companyId, runId: run.id, agentId, amountCents: "400", state: "held",
      providerStartedAt: run.processStartedAt ?? finishedAt });
    // Earlier spend leaves room for exactly one more reserved run.
    await db.insert(costEvents).values({ companyId, agentId: otherAgentId, provider: "test", model: "test",
      costCents: 200, occurredAt: new Date(finishedAt.getTime() - 3_600_000) });
    const queuedRun = async () => {
      const [queued] = await db.insert(heartbeatRuns).values({ companyId, agentId: otherAgentId, invocationSource: "assignment",
        status: "queued" }).returning();
      return queued;
    };
    return { companyId, agentId, otherAgentId, sourceId, issue, run, queuedRun };
  }

  /** A native run that stopped after its provider started. */
  const native = { runtimeMode: "native", status: "failed", errorCode: "native_runner_process_exited",
    controllerBootId: null, processPid: null, processGroupId: null, processStartedAt: null, processHostHash: null,
    finishedAt: new Date() } as const;
  const longAgo = () => new Date(Date.now() - 86_400_000);
  /** A POST that never saw a preview, so only the endpoint's own checks apply. */
  const post = (f: Awaited<ReturnType<typeof fixture>>, expectedRevision = "0".repeat(64), live = new Set<string>()) =>
    service(live).settle(f.companyId, f.run.id, { idempotencyKey: randomUUID(), expectedRevision, estimatedCents: "200",
      reason: "Owner review", confirmStopped: true }, "owner-user");
  const charges = (runId: string) => db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
  const readRun = async (runId: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];

  async function settle(f: Awaited<ReturnType<typeof fixture>>, change: Record<string, unknown> = {}, actorId = "owner-user") {
    const preview = await service().settlementPreview(f.companyId, f.run.id);
    return service().settle(f.companyId, f.run.id, { idempotencyKey: `settle:${f.run.id}`, expectedRevision: preview.revision,
      estimatedCents: preview.proposedCents, reason: "Provider console shows the interrupted turn", confirmStopped: true,
      ...change }, actorId);
  }

  it("reproduces the deadlock: retry and the reconciler leave the run holding the budget forever", async () => {
    const f = await fixture();
    expect(await service().retry(f.companyId, f.run.id, "owner-user")).toEqual({ accounted: false });
    await reconcileRunCosts(db);
    expect(await readRun(f.run.id)).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
    // 200 spent + 400 held by the interrupted run + 400 for the next run fills 1000.
    await expect(reserveRunBudget(db, f.companyId, (await f.queuedRun()).id, null)).resolves.toMatchObject({ state: "held" });
    await expect(reserveRunBudget(db, f.companyId, (await f.queuedRun()).id, null)).rejects.toThrow(/reserved by unfinished runs/);
    expect(await charges(f.run.id)).toEqual([]);
  });

  it("previews the recorded usage, the reservation and the best estimate without changing anything", async () => {
    const f = await fixture();
    const before = await readRun(f.run.id);
    const preview = await service().settlementPreview(f.companyId, f.run.id);
    expect(preview).toMatchObject({ runId: f.run.id, agentId: f.agentId, status: "interrupted", provider: "deepseek",
      model: "synthetic-model", billingType: "metered_api", inputTokens: 1200, cachedInputTokens: 300, outputTokens: 200,
      recordedCents: "150.0000000", reservedCents: "400.0000000", proposedCents: "150.0000000" });
    expect(preview.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(await readRun(f.run.id)).toEqual(before);
    expect(await charges(f.run.id)).toEqual([]);
  });

  it("settles at the owner's estimate, keeps the original evidence and releases the budget", async () => {
    const f = await fixture();
    const before = await readRun(f.run.id);
    const evaluations = async () => (await db.select({ id: budgetEvaluationWork.id }).from(budgetEvaluationWork)
      .where(and(eq(budgetEvaluationWork.companyId, f.companyId), eq(budgetEvaluationWork.agentId, f.agentId)))).length;
    const queuedBefore = await evaluations();
    const preview = await service().settlementPreview(f.companyId, f.run.id);
    const result = await service().settle(f.companyId, f.run.id, { idempotencyKey: "owner-decision-1",
      expectedRevision: preview.revision, estimatedCents: "250", reason: "Provider console shows about $2.50",
      confirmStopped: true }, "owner-user");
    expect(result).toMatchObject({ accounted: true, settledBy: "owner_estimate" });

    const [charge] = await charges(f.run.id);
    expect(await charges(f.run.id)).toHaveLength(1);
    expect(charge).toMatchObject({ idempotencyKey: `heartbeat:${f.run.id}:final`, costCents: 250, costStatus: "estimated",
      reportedCostCents: "150.0000000", inputTokens: 1200, cachedInputTokens: 300, outputTokens: 200, provider: "deepseek",
      issueId: f.issue.id });
    expect(charge.pricingProvenance).toMatchObject({ source: "operator" });
    expect(String(charge.pricingProvenance?.evidence)).toMatch(/owner-approved estimate.*may have spent more/i);
    const [adjustment] = await db.select().from(costAdjustments).where(eq(costAdjustments.costEventId, charge.id));
    expect(adjustment).toMatchObject({ idempotencyKey: "run-settlement:owner-decision-1", previousCents: "150.0000000",
      correctedCents: "250.0000000", previousStatus: "estimated", actorId: "owner-user",
      reason: "Provider console shows about $2.50" });

    const after = await readRun(f.run.id);
    expect(after).toMatchObject({ costAccountingPending: false, status: "interrupted", errorCode: "server_shutdown_interrupted",
      processPid: 4242, processHostHash: "earlier-container", legacyProcessSettlement: null });
    expect(after.costAccountedAt).toBeInstanceOf(Date);
    // Settlement adds markers. It never removes or rewrites the recorded usage.
    for (const key of ["provider", "model", "inputTokens", "cachedInputTokens", "outputTokens", "costUsd", "budgetExposure",
      "accountingReceiptReady", "accountingReceiptSourceId"]) expect(after.usageJson?.[key]).toEqual(before.usageJson?.[key]);
    expect(after.usageJson).toMatchObject({ accountingReceiptUnavailable: true,
      accountingOwnerSettlement: { actorId: "owner-user", estimatedCents: "250.0000000", recordedCents: "150.0000000" } });
    expect(await db.select({ state: budgetReservations.state }).from(budgetReservations)
      .where(eq(budgetReservations.runId, f.run.id))).toEqual([{ state: "settled" }]);

    const [activity] = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "cost.accounting_owner_settled")));
    expect(activity).toMatchObject({ actorType: "user", actorId: "owner-user", entityId: f.run.id });
    expect(activity.details).toMatchObject({ recordedCents: "150.0000000", estimatedCents: "250.0000000",
      reservedCents: "400.0000000", providerReceipt: false, additionalUsageMayExist: true });

    // The budget is evaluated again at the estimate, and every spend
    // projection still matches the ledger.
    expect(await evaluations()).toBeGreaterThan(queuedBefore);
    expect((await service().inspect(f.companyId)).findings).toEqual([]);

    // 200 + 250 settled leaves room for one more 400-cent reservation.
    await expect(reserveRunBudget(db, f.companyId, (await f.queuedRun()).id, null)).resolves.toMatchObject({ state: "held" });
    await expect(reserveRunBudget(db, f.companyId, (await f.queuedRun()).id, null)).rejects.toThrow(/reserved by unfinished runs/);
  });

  it("replays the same decision, refuses a different one under the same key, and never charges twice", async () => {
    const f = await fixture();
    const preview = await service().settlementPreview(f.companyId, f.run.id);
    const input = { idempotencyKey: "owner-decision", expectedRevision: preview.revision, estimatedCents: "150",
      reason: "Accept the recorded usage", confirmStopped: true as const };
    const first = await service().settle(f.companyId, f.run.id, input, "owner-user");
    expect(await service().settle(f.companyId, f.run.id, input, "owner-user")).toEqual(first);
    await expect(service().settle(f.companyId, f.run.id, { ...input, estimatedCents: "300" }, "owner-user"))
      .rejects.toMatchObject({ status: 409 });
    await expect(service().settle(f.companyId, f.run.id, { ...input, idempotencyKey: "another" }, "owner-user"))
      .rejects.toMatchObject({ status: 409 });
    expect(await service().retry(f.companyId, f.run.id, "owner-user")).toEqual({ accounted: false });
    await reconcileRunCosts(db);
    expect(await charges(f.run.id)).toHaveLength(1);
    expect(await db.select().from(costAdjustments).where(eq(costAdjustments.companyId, f.companyId))).toHaveLength(1);
  });

  it("serializes concurrent settlements and accounting retries into one charge", async () => {
    const f = await fixture();
    const preview = await service().settlementPreview(f.companyId, f.run.id);
    const attempts = await Promise.allSettled([
      ...["a", "b", "c"].map(key => service().settle(f.companyId, f.run.id, { idempotencyKey: key,
        expectedRevision: preview.revision, estimatedCents: "200", reason: "Concurrent owner", confirmStopped: true }, "owner-user")),
      accountRunCost(db, f.run.id), reconcileRunCosts(db),
    ]);
    const settled = attempts.slice(0, 3).filter(outcome => outcome.status === "fulfilled");
    expect(settled).toHaveLength(1);
    for (const outcome of attempts.slice(0, 3)) if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ status: 409 });
    const [charge] = await charges(f.run.id);
    expect(await charges(f.run.id)).toHaveLength(1);
    expect(charge.costCents).toBe(200);
  });

  it("answers concurrent requests with the same key with the one decision they record", async () => {
    const f = await fixture();
    const preview = await service().settlementPreview(f.companyId, f.run.id);
    const input = { idempotencyKey: "double-click", expectedRevision: preview.revision, estimatedCents: "200",
      reason: "Owner retried the request", confirmStopped: true as const };
    const results = await Promise.all([1, 2, 3].map(() => service().settle(f.companyId, f.run.id, input, "owner-user")));
    const [charge] = await charges(f.run.id);
    expect(await charges(f.run.id)).toHaveLength(1);
    for (const result of results) expect(result).toEqual({ accounted: true, settledBy: "owner_estimate", costEventId: charge.id });
  });

  it("refuses an estimate below the recorded usage or a review of changed usage", async () => {
    const f = await fixture();
    await expect(settle(f, { estimatedCents: "149.99" })).rejects.toMatchObject({ status: 422 });
    const preview = await service().settlementPreview(f.companyId, f.run.id);
    await db.update(heartbeatRuns).set({ usageJson: sql`${heartbeatRuns.usageJson} || '{"outputTokens":900}'::jsonb` })
      .where(eq(heartbeatRuns.id, f.run.id));
    await expect(service().settle(f.companyId, f.run.id, { idempotencyKey: "stale", expectedRevision: preview.revision,
      estimatedCents: "500", reason: "Stale review", confirmStopped: true }, "owner-user")).rejects.toMatchObject({ status: 409 });
    expect(await readRun(f.run.id)).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
    expect(await charges(f.run.id)).toEqual([]);
  });

  it("refuses runs that may still be executing or that Paperclip can still account by itself", async () => {
    const f = await fixture();
    const live = new Set([f.run.id]);
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["live in this server", () => service(live).settlementPreview(f.companyId, f.run.id)],
    ];
    for (const change of [
      { status: "running", finishedAt: null },
      { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) },
      { scheduledRetryAt: new Date(Date.now() + 60_000) },
      { usageJson: sql`${heartbeatRuns.usageJson} || '{"accountingReceiptReady":true}'::jsonb` },
      { costAccountingPending: false },
    ] as Array<Partial<typeof heartbeatRuns.$inferInsert>>) {
      cases.push([JSON.stringify(Object.keys(change)), async () => {
        await db.update(heartbeatRuns).set(change).where(eq(heartbeatRuns.id, f.run.id));
        try { return await service().settlementPreview(f.companyId, f.run.id); }
        finally { await db.update(heartbeatRuns).set({ ...f.run, usageJson: f.run.usageJson }).where(eq(heartbeatRuns.id, f.run.id)); }
      }]);
    }
    for (const [, attempt] of cases) await expect(attempt()).rejects.toMatchObject({ status: 409 });
    await expect(service().settlementPreview(randomUUID(), f.run.id)).rejects.toMatchObject({ status: 404 });
    expect(await charges(f.run.id)).toEqual([]);
  });

  it("refuses a native run while its recovery may run the provider or its closure timeout will settle it", async () => {
    const f = await fixture(native, "paperclip_runner");
    await db.update(heartbeatRuns).set({ nativeIssueId: f.issue.id }).where(eq(heartbeatRuns.id, f.run.id));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issue.id, runId: f.run.id,
      phase: "observed", attempt: 1 });
    await expect(service().settlementPreview(f.companyId, f.run.id)).rejects.toMatchObject({ status: 409 });
    await expect(settle({ ...f }, { expectedRevision: "0".repeat(64) })).rejects.toMatchObject({ status: 409 });
    // Recovery ended. A remote runner may still reconnect within its grace,
    // and the closure timeout settles the run by itself after that, so an
    // owner's estimate would only run ahead of real evidence.
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure" }).where(eq(nativeRunFinalizations.runId, f.run.id));
    await expect(service().settlementPreview(f.companyId, f.run.id)).rejects.toThrow(/Retry cost recording/);
    await expect(post(f)).rejects.toMatchObject({ status: 409 });
    expect(await accountRunCost(db, f.run.id)).toBe(false);
    expect(await charges(f.run.id)).toEqual([]);

    // Past its closure bound, a native run settles by itself. It needs no owner.
    const old = await fixture({ ...native, finishedAt: new Date(Date.now() - 86_400_000) }, "paperclip_runner");
    await db.update(heartbeatRuns).set({ nativeIssueId: old.issue.id }).where(eq(heartbeatRuns.id, old.run.id));
    await db.insert(nativeRunFinalizations).values({ companyId: old.companyId, issueId: old.issue.id, runId: old.run.id,
      phase: "terminal_failure", attempt: 1 });
    await expect(service().settlementPreview(old.companyId, old.run.id)).rejects.toThrow(/Retry cost recording/);
    expect(await accountRunCost(db, old.run.id)).toBe(true);
  });

  it("settles any adapter and terminal status without adapter-specific evidence", async () => {
    for (const adapterType of ["claude_local", "codex_local", "cursor", "opencode_local", "pi_local", "gemini_local", "process"]) {
      for (const status of ["failed", "cancelled", "timed_out", "interrupted", "succeeded"] as const) {
        const f = await fixture({ status, errorCode: status === "cancelled" ? "cancelled" : "process_lost",
          resultJson: status === "cancelled" ? { cancellation: { state: "settled" } } : null }, adapterType);
        expect(await accountRunCost(db, f.run.id)).toBe(false);
        expect(await settle(f)).toMatchObject({ accounted: true });
        expect(await charges(f.run.id)).toHaveLength(1);
      }
    }
  });

  it("settles a run whose usage was never priced as an owner estimate instead of an unpriced charge", async () => {
    const f = await fixture({ usageJson: { accountingReceiptReady: false, provider: "unknown", model: "unknown",
      billingType: "unknown", inputTokens: 0, outputTokens: 0 } });
    const preview = await service().settlementPreview(f.companyId, f.run.id);
    expect(preview).toMatchObject({ recordedCents: "0.0000000", proposedCents: "0.0000000" });
    await settle(f, { estimatedCents: "75" });
    const [charge] = await charges(f.run.id);
    expect(charge).toMatchObject({ costCents: 75, costStatus: "estimated" });
    expect(charge.pricingProvenance).toMatchObject({ source: "operator" });
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.otherAgentId)).toBeNull();
  });

  it("keeps a genuine receipt that arrives after settlement without charging it again", async () => {
    const f = await fixture();
    await settle(f, { estimatedCents: "250" });
    const late: UsageReceiptEnvelope = { schema: "paperclip/accounting-receipt/v1", companyId: f.companyId, runId: f.run.id,
      id: randomUUID(), sourceId: f.sourceId, sequence: 2, adapterType: "pi_local", receivedAt: new Date().toISOString(),
      receipt: { complete: true, usageBasis: "per_run", usage: { inputTokens: 1500, cachedInputTokens: 300, outputTokens: 400 },
        provider: "deepseek", biller: "deepseek", model: "synthetic-model", billingType: "metered_api", costUsd: 3,
        costStatus: "reported", pricingProvenance: { source: "provider_reported", version: "test" } } };
    await persistUsageReceipt(db, late);
    await accountRunCost(db, f.run.id);
    await reconcileRunCosts(db);
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.id, late.id))).toHaveLength(1);
    const ledger = await charges(f.run.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].costCents).toBe(250);
    // The owner's valuation stands. The receipt stays visible for review and
    // holds no budget: the run is already accounted.
    expect((await readRun(f.run.id)).usageJson).toMatchObject({ accountingLateReceiptPending: true });
    await expect(reserveRunBudget(db, f.companyId, (await f.queuedRun()).id, null)).resolves.toMatchObject({ state: "held" });
  });

  it("waits past every automatic bound before an owner can settle, and the API enforces it", async () => {
    expect(OWNER_SETTLEMENT_WAIT_MS).toBeGreaterThan(ACCOUNTING_CLOSURE_TIMEOUT_MS);
    expect(ACCOUNTING_CLOSURE_TIMEOUT_MS).toBeGreaterThan(REMOTE_RUNNER_RECONNECT_GRACE_MS);
    const stoppedAt = new Date(Date.now() - ACCOUNTING_CLOSURE_TIMEOUT_MS - 60_000);
    const f = await fixture({ finishedAt: stoppedAt, processStartedAt: new Date(stoppedAt.getTime() - 600_000) });
    await expect(service().settlementPreview(f.companyId, f.run.id)).rejects.toThrow(/still waiting for this run's final usage/);
    // A direct POST is refused too, whatever revision it carries.
    await expect(post(f)).rejects.toMatchObject({ status: 409 });
    expect(await readRun(f.run.id)).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
    expect(await charges(f.run.id)).toEqual([]);
    // The Costs page offers no settlement either.
    const waiting = await costDataQualityReport(db, f.companyId, true);
    expect(waiting.runs).toEqual([expect.objectContaining({ runId: f.run.id, reason: "waiting_for_receipt", settleable: false })]);

    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - OWNER_SETTLEMENT_WAIT_MS - 1_000) })
      .where(eq(heartbeatRuns.id, f.run.id));
    const due = await costDataQualityReport(db, f.companyId, true);
    expect(due.runs).toEqual([expect.objectContaining({ runId: f.run.id, reason: "receipt_unavailable", settleable: true })]);
    expect(await settle(f)).toMatchObject({ accounted: true, settledBy: "owner_estimate" });
    expect(await charges(f.run.id)).toHaveLength(1);
  });

  it("leaves a failed capture to its automatic bound, and settles one that no bound can reach", async () => {
    const captureFailed = sql`${heartbeatRuns.usageJson} || '{"accountingCaptureFailed":true}'::jsonb`;
    // Outside native recovery the capture bound settles the run by itself.
    const legacy = await fixture({ finishedAt: new Date() });
    await db.update(heartbeatRuns).set({ usageJson: captureFailed }).where(eq(heartbeatRuns.id, legacy.run.id));
    await expect(service().settlementPreview(legacy.companyId, legacy.run.id)).rejects.toThrow(/Retry cost recording/);
    await expect(post(legacy)).rejects.toMatchObject({ status: 409 });
    expect(await charges(legacy.run.id)).toEqual([]);
    expect((await costDataQualityReport(db, legacy.companyId, true)).runs[0]).toMatchObject({ settleable: false });
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - OWNER_SETTLEMENT_WAIT_MS - 1_000) })
      .where(eq(heartbeatRuns.id, legacy.run.id));
    await expect(service().settlementPreview(legacy.companyId, legacy.run.id)).rejects.toThrow(/Retry cost recording/);
    expect((await costDataQualityReport(db, legacy.companyId, true)).runs[0]).toMatchObject({ settleable: false });
    expect(await accountRunCost(db, legacy.run.id)).toBe(true);
    expect(await charges(legacy.run.id)).toHaveLength(1);
    expect(await db.select().from(costAdjustments).where(eq(costAdjustments.companyId, legacy.companyId))).toEqual([]);
    expect((await readRun(legacy.run.id)).usageJson?.accountingOwnerSettlement).toBeUndefined();

    // A native run without a recovery coordinator has no bound: only an owner can settle it.
    const stranded = await fixture({ ...native, finishedAt: longAgo() }, "paperclip_runner");
    await db.update(heartbeatRuns).set({ usageJson: captureFailed }).where(eq(heartbeatRuns.id, stranded.run.id));
    expect(await accountRunCost(db, stranded.run.id)).toBe(false);
    expect((await costDataQualityReport(db, stranded.companyId, true)).runs[0]).toMatchObject({ settleable: true });
    expect(await settle(stranded)).toMatchObject({ accounted: true, settledBy: "owner_estimate" });
    expect(await charges(stranded.run.id)).toHaveLength(1);
  });

  it("refuses a run whose environment is still being cleaned up, including one that started after review", async () => {
    const f = await fixture();
    const cleanup = (owner: string | null) => db.update(heartbeatRuns)
      .set({ runnerProfileJson: owner ? { nativeWorkspaceFinalizationOwner: owner } : {} }).where(eq(heartbeatRuns.id, f.run.id));
    await cleanup("workspace-finalizer");
    await expect(service().settlementPreview(f.companyId, f.run.id)).rejects.toThrow(/still being cleaned up/);
    await cleanup(null);
    const preview = await service().settlementPreview(f.companyId, f.run.id);
    await cleanup("workspace-finalizer");
    await expect(post(f, preview.revision)).rejects.toThrow(/still being cleaned up/);
    expect(await charges(f.run.id)).toEqual([]);
    await cleanup(null);
    expect(await post(f, preview.revision)).toMatchObject({ accounted: true, settledBy: "owner_estimate" });
  });

  it("refuses a run that became active between the owner's review and the POST", async () => {
    const f = await fixture();
    const preview = await service().settlementPreview(f.companyId, f.run.id);
    // This server took the run up again.
    await expect(post(f, preview.revision, new Set([f.run.id]))).rejects.toThrow(/may still be working/);
    // Another server holds its controller lease.
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(post(f, preview.revision)).rejects.toThrow(/may still be working/);
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: null }).where(eq(heartbeatRuns.id, f.run.id));
    // Execution control still owns the run.
    await db.update(heartbeatRuns).set({ executionControlDeadlineAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(post(f, preview.revision)).rejects.toThrow(/may still be working/);
    await db.update(heartbeatRuns).set({ executionControlDeadlineAt: null }).where(eq(heartbeatRuns.id, f.run.id));
    // Recovery resumed the same run.
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(post(f, preview.revision)).rejects.toThrow(/may still be working/);
    expect(await charges(f.run.id)).toEqual([]);
    expect(await db.select().from(costAdjustments).where(eq(costAdjustments.companyId, f.companyId))).toEqual([]);
    expect(await readRun(f.run.id)).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
  });

  it("records a native run's spooled final receipt instead of the owner's estimate", async () => {
    const f = await fixture({ ...native, finishedAt: longAgo() }, "paperclip_runner");
    const preview = await service().settlementPreview(f.companyId, f.run.id);
    // The receipt reached the spool after the owner's review.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "run-settlement-spool-"));
    const receipt: UsageReceiptEnvelope = { schema: "paperclip/accounting-receipt/v1", companyId: f.companyId, runId: f.run.id,
      id: randomUUID(), sourceId: f.sourceId, sequence: 2, adapterType: "paperclip_runner", receivedAt: new Date().toISOString(),
      receipt: { complete: true, usageBasis: "per_run", usage: { inputTokens: 1500, cachedInputTokens: 300, outputTokens: 400 },
        provider: "deepseek", biller: "deepseek", model: "synthetic-model", billingType: "metered_api", costUsd: 3,
        costStatus: "reported", pricingProvenance: { source: "provider_reported", version: "test" } } };
    const file = await spoolUsageReceipt(receipt, directory);
    const read = usageReceipts.readPendingRunUsageReceipts;
    const spool = vi.spyOn(usageReceipts, "readPendingRunUsageReceipts").mockImplementation(input => read(input, directory));
    try {
      expect(await service().settle(f.companyId, f.run.id, { idempotencyKey: "recovered", expectedRevision: preview.revision,
        estimatedCents: "250", reason: "Provider console", confirmStopped: true }, "owner-user"))
        .toEqual({ accounted: true, settledBy: "recovered_receipt", costEventId: null });
      const ledger = await charges(f.run.id);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ costCents: 300, costStatus: "reported", outputTokens: 400 });
      expect(await db.select().from(costAdjustments).where(eq(costAdjustments.companyId, f.companyId))).toEqual([]);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
        eq(activityLog.action, "cost.accounting_owner_settled")))).toEqual([]);
      const after = await readRun(f.run.id);
      expect(after).toMatchObject({ costAccountingPending: false });
      expect(after.usageJson?.accountingOwnerSettlement).toBeUndefined();
      expect(await db.select({ state: budgetReservations.state }).from(budgetReservations)
        .where(eq(budgetReservations.runId, f.run.id))).toEqual([{ state: "settled" }]);
      await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      spool.mockRestore();
      await fs.rm(directory, { force: true, recursive: true });
    }
  });
});
