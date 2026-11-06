import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents, budgetIncidents, budgetPolicies, budgetReservations, companies, costEvents, createDb, heartbeatRunEvents, heartbeatRuns, issues,
  nativeRunFinalizations, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { budgetService, flushBudgetEvaluationWork } from "../services/budgets.js";
import { accountRunCost, reconcileRunCosts } from "../services/run-cost-accounting.js";
import { persistUsageReceipt } from "../services/usage-receipts.js";

// A control-plane SIGKILL during a provider turn that reports usage only at
// turn end leaves the run terminal with an incomplete receipt. Once native
// recovery has given up and verified the provider process stopped, no producer
// can deliver that receipt. The debt must leave "awaiting receipt" or every
// later admission in the company refuses forever, whatever the budget allows.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("closed native receipt accounting", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("closed-native-receipt-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(options: {
    unpricedUsagePolicy?: "block" | "allow";
    phase?: string;
    processPid?: number | null;
    stopEvidence?: boolean;
    failureCode?: string;
  } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID(), sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Chaos Lab", issuePrefix: "CHA" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Claude", role: "engineer", status: "idle", adapterType: "paperclip_runner" },
      { id: otherAgentId, companyId, name: "Codex", role: "engineer", status: "idle", adapterType: "paperclip_runner" },
    ]);
    const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 500, notifyEnabled: false,
      unpricedUsagePolicy: options.unpricedUsagePolicy ?? "allow" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Interrupted task", status: "blocked",
      assigneeAgentId: agentId }).returning();
    // The shape persisted for the killed ACPX Claude run: the final provider
    // turn failed without a per-turn usage report, so the receipt never closed.
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation",
      scopeKind: "issue", issueId: issue.id, nativeIssueId: issue.id, runtimeMode: "native", status: "failed",
      errorCode: "native_provider_terminal_failed", finishedAt: new Date(), costAccountingPending: true,
      processPid: options.processPid ?? null, processGroupId: options.processPid ?? null,
      processStartedAt: options.processPid ? new Date() : null,
      usageJson: { accountingReceiptOwner: "native_producer", accountingReceiptSourceId: sourceId,
        accountingReceiptSequence: 1, accountingReceiptReady: false, provider: "anthropic", biller: "anthropic",
        model: "claude-sonnet-5", billingType: "metered_api", costStatus: "unpriced", costUsd: null,
        inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, usageSource: "per_run",
        budgetExposure: { sourceId, sequence: 1, costCents: "0.0000000" },
        ledgerScope: { issueId: issue.id, projectId: null, billingCode: null } } }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId: run.id,
      phase: options.phase ?? "terminal_failure", attempt: 3, failureCode: options.failureCode ?? "native_provider_terminal_failed" });
    // Server-authored process trail: launch, recorded identity, then the
    // verified local stop recovery writes before clearing the identity.
    await db.insert(heartbeatRunEvents).values([
      { companyId, runId: run.id, agentId, seq: 1, eventType: "native.process_start_requested", stream: "system" },
      { companyId, runId: run.id, agentId, seq: 2, eventType: "native.process_identity_recorded", stream: "system" },
      ...(options.stopEvidence === false ? [] : [
        { companyId, runId: run.id, agentId, seq: 3, eventType: "native.local_process_stopped", stream: "system" }]),
    ]);
    await db.insert(budgetReservations).values({ companyId, runId: run.id, agentId, amountCents: "0",
      state: "held", providerStartedAt: new Date() });
    const readRun = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0];
    const charges = () => db.select().from(costEvents).where(and(eq(costEvents.companyId, companyId),
      eq(costEvents.heartbeatRunId, run.id)));
    const reservation = async () => (await db.select().from(budgetReservations)
      .where(eq(budgetReservations.runId, run.id)))[0];
    const block = () => budgetService(db).getInvocationBlock(companyId, otherAgentId, { issueId: null, projectId: null });
    return { companyId, agentId, otherAgentId, sourceId, policy, issue, run, readRun, charges, reservation, block };
  }

  it("settles a stopped native terminal failure without a final receipt as unpriced usage", async () => {
    const f = await fixture();
    expect(await f.block()).toMatchObject({ reason: "New work must wait while a native run recovers its unfinished accounting." });

    // The background reconciler must select this debt; it is not merely retryable by hand.
    expect(await reconcileRunCosts(db)).toMatchObject({ accounted: 1 });
    await flushBudgetEvaluationWork(db);

    const settled = await f.readRun();
    expect(settled.costAccountingPending).toBe(false);
    expect(settled.costAccountedAt).not.toBeNull();
    const charges = await f.charges();
    expect(charges).toHaveLength(1);
    // Unknown spend is never presented as a zero-cost receipt.
    expect(charges[0]).toMatchObject({ costStatus: "unpriced", model: "claude-sonnet-5", provider: "anthropic" });
    expect((await f.reservation()).state).toBe("settled");
    // The operator's unpriced-usage policy now decides admission.
    expect(await f.block()).toBeNull();
  });

  // Chaos wave: under the default blocking policy, a lost zero-token receipt
  // opened a hard stop at 0 of 500 cents and blocked every task.
  it("does not hard-stop a blocking policy for a lost receipt with no usage", async () => {
    const f = await fixture({ unpricedUsagePolicy: "block" });
    expect(await accountRunCost(db, f.run.id)).toBe(true);
    await budgetService(db).evaluateAffectedScopes(f.companyId, f.agentId, null);
    await flushBudgetEvaluationWork(db);
    expect(await f.charges()).toMatchObject([{ costStatus: "unpriced" }]);
    const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
    expect(company).toMatchObject({ status: "active", pauseReason: null });
    expect(await f.block()).toBeNull();
  });

  it("keeps a blocking policy for lost-receipt usage that has tokens but no price", async () => {
    const f = await fixture({ unpricedUsagePolicy: "block" });
    await db.update(heartbeatRuns).set({ usageJson: sql`${heartbeatRuns.usageJson} || '{"inputTokens":1200,"outputTokens":80}'::jsonb` })
      .where(eq(heartbeatRuns.id, f.run.id));
    expect(await accountRunCost(db, f.run.id)).toBe(true);
    await flushBudgetEvaluationWork(db);
    expect((await f.block())?.reason).toMatch(/no reliable price|budget hard-stop/);
  });

  it("keeps the debt pending while the provider process identity is still recorded", async () => {
    const f = await fixture({ processPid: 424242 });
    expect(await reconcileRunCosts(db)).toMatchObject({ accounted: 0 });
    expect(await accountRunCost(db, f.run.id)).toBe(false);
    expect((await f.readRun()).costAccountingPending).toBe(true);
    expect(await f.charges()).toHaveLength(0);
    expect((await f.reservation()).state).toBe("held");
  });

  // Between a native terminal failure and the verified provider stop, the debt
  // is closing, not over budget. A hard stop here paused the company and
  // cancelled an unrelated running task in the live restart wave.
  it("holds new work without a hard stop while a terminal native receipt is closing", async () => {
    const f = await fixture({ processPid: 424242 });
    await budgetService(db).evaluateAffectedScopes(f.companyId, f.agentId, null);
    await flushBudgetEvaluationWork(db);
    const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
    expect(company.status).toBe("active");
    expect(company.pauseReason).toBeNull();
    expect(await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, f.companyId))).toHaveLength(0);
    expect(await f.block()).toMatchObject({ reason: "New work must wait while a native run recovers its unfinished accounting." });
  });

  // Chaos waves: a run that had just succeeded was terminal for ~100 ms before
  // its charge committed. The evaluator read that gap as a hard stop, paused the
  // company and cancelled unrelated running work, which then never settled.
  it("holds admission without a hard stop while a finished run's charge commits", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null,
      usageJson: sql`${heartbeatRuns.usageJson} || '{"accountingReceiptReady":true,"costUsd":0.1}'::jsonb` })
      .where(eq(heartbeatRuns.id, f.run.id));
    // Its coordinator already applied the result, so nothing counts it as recovering.
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id));
    const runningId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runningId, companyId: f.companyId, agentId: f.otherAgentId,
      invocationSource: "assignment", status: "running" });
    await budgetService(db).evaluateAffectedScopes(f.companyId, f.agentId, null);
    await flushBudgetEvaluationWork(db);
    const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
    expect(company).toMatchObject({ status: "active", pauseReason: null });
    expect(await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, f.companyId))).toHaveLength(0);
    const [policy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, f.policy.id));
    expect(policy.enforcementVersion).toBe(f.policy.enforcementVersion);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runningId)))[0].status).toBe("running");
    expect(await f.block()).toMatchObject({ reason: "Company cannot start work while completed runs await accounting." });
  });

  it("settles a finalization-deadline failure once its local stop is verified", async () => {
    const f = await fixture({ failureCode: "execution_finalization_deadline_exceeded" });
    expect(await f.block()).not.toBeNull();
    expect(await reconcileRunCosts(db)).toMatchObject({ accounted: 1 });
    await flushBudgetEvaluationWork(db);
    expect(await f.block()).toBeNull();
  });

  it.each([
    ["no verified stop event", { stopEvidence: false }],
    ["a finalization deadline without a verified stop", { failureCode: "execution_finalization_deadline_exceeded", stopEvidence: false }],
  ] as const)("keeps the debt pending with %s", async (_label, options) => {
    const f = await fixture(options);
    expect(await reconcileRunCosts(db)).toMatchObject({ accounted: 0 });
    expect(await accountRunCost(db, f.run.id)).toBe(false);
    expect((await f.readRun()).costAccountingPending).toBe(true);
    expect(await f.charges()).toHaveLength(0);
  });

  // Upgrade path: an older release paused the company for pending accounting.
  it("releases a budget-owned pause that only pending accounting kept", async () => {
    const f = await fixture({ stopEvidence: false });
    await db.update(companies).set({ status: "paused", pauseReason: "budget", pausedAt: new Date() })
      .where(eq(companies.id, f.companyId));
    await db.insert(budgetIncidents).values({ companyId: f.companyId, policyId: f.policy.id, scopeType: "company",
      scopeId: f.companyId, metric: "billed_cents", windowKind: "calendar_month_utc",
      windowStart: new Date(Date.UTC(2026, 10, 1)), windowEnd: new Date(Date.UTC(2026, 11, 1)),
      thresholdType: "hard", amountLimit: 500, amountObserved: 0 });
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id));
    await budgetService(db).evaluateAffectedScopes(f.companyId, f.agentId, null);
    await flushBudgetEvaluationWork(db);
    const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
    expect(company).toMatchObject({ status: "active", pauseReason: null });
    expect((await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, f.companyId)))[0].status).not.toBe("open");
    expect(await f.block()).toMatchObject({ reason: "Company cannot start work while completed runs await accounting." });
    const [policy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, f.policy.id));
    expect((await budgetService(db).overview(f.companyId)).policies[0]?.status).not.toBe("hard_stop");
    expect(policy.id).toBe(f.policy.id);
  });

  it("keeps the debt pending while native recovery can still produce a result", async () => {
    const f = await fixture({ phase: "observed" });
    expect(await reconcileRunCosts(db)).toMatchObject({ accounted: 0 });
    expect((await f.readRun()).costAccountingPending).toBe(true);
    expect(await f.charges()).toHaveLength(0);
  });

  it("reconciles a final receipt that arrives after the unavailable receipt settled", async () => {
    const f = await fixture();
    expect(await accountRunCost(db, f.run.id)).toBe(true);
    await persistUsageReceipt(db, { schema: "paperclip/accounting-receipt/v1", id: randomUUID(),
      companyId: f.companyId, runId: f.run.id, adapterType: "paperclip_runner", sourceId: f.sourceId, sequence: 2,
      receivedAt: new Date().toISOString(), receipt: { complete: true, usageBasis: "per_run", provider: "anthropic",
        biller: "anthropic", model: "claude-sonnet-5", billingType: "metered_api",
        usage: { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 80 } } });
    const late = await f.readRun();
    expect(late.costAccountingPending).toBe(true);
    expect(late.usageJson).toMatchObject({ accountingLateReceiptPending: true });
  });

  it("does not reopen the hold for a later receipt the rate card could price but that carries no price", async () => {
    const f = await fixture();
    expect(await accountRunCost(db, f.run.id)).toBe(true);
    await persistUsageReceipt(db, { schema: "paperclip/accounting-receipt/v1", id: randomUUID(),
      companyId: f.companyId, runId: f.run.id, adapterType: "paperclip_runner", sourceId: f.sourceId, sequence: 2,
      receivedAt: new Date().toISOString(),
      producerEvent: { sourceEventId: randomUUID(), eventType: "turn.completed" },
      receipt: { complete: true, usageBasis: "per_run", provider: "anthropic", biller: "anthropic",
        model: "claude-sonnet-5", billingType: "metered_api",
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cacheWriteTokens: 0 } } });
    expect((await f.readRun()).costAccountingPending).toBe(false);
    expect(await f.block()).toBeNull();
  });

  it("does not reopen the hold for a later complete receipt that adds no price or usage", async () => {
    const f = await fixture();
    expect(await accountRunCost(db, f.run.id)).toBe(true);
    await persistUsageReceipt(db, { schema: "paperclip/accounting-receipt/v1", id: randomUUID(),
      companyId: f.companyId, runId: f.run.id, adapterType: "paperclip_runner", sourceId: f.sourceId, sequence: 2,
      receivedAt: new Date().toISOString(),
      producerEvent: { sourceEventId: randomUUID(), eventType: "turn.completed" },
      receipt: { complete: true, usageBasis: "per_run", provider: "anthropic", biller: "anthropic",
        model: "claude-sonnet-5", billingType: "metered_api", costStatus: "unpriced",
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } } });
    expect((await f.readRun()).costAccountingPending).toBe(false);
    expect(await f.block()).toBeNull();
  });

  // A producer receipt priced only from the rate card is normally not a money
  // correction. For a charge settled without its receipt, it is the first price.
  it("prices the unavailable charge when a complete rate-card receipt arrives later", async () => {
    const f = await fixture({ unpricedUsagePolicy: "block" });
    expect(await accountRunCost(db, f.run.id)).toBe(true);
    await persistUsageReceipt(db, { schema: "paperclip/accounting-receipt/v1", id: randomUUID(),
      companyId: f.companyId, runId: f.run.id, adapterType: "paperclip_runner", sourceId: f.sourceId, sequence: 2,
      receivedAt: new Date().toISOString(),
      producerEvent: { sourceEventId: randomUUID(), eventType: "turn.completed" },
      receipt: { complete: true, usageBasis: "per_run", provider: "anthropic", biller: "anthropic",
        model: "claude-sonnet-5", billingType: "metered_api", costUsd: 0.25, costStatus: "estimated",
        pricingProvenance: { source: "rate_card", version: "anthropic-test" },
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } } });
    expect((await f.readRun()).usageJson).toMatchObject({ accountingLateReceiptPending: true });
    await accountRunCost(db, f.run.id);
    await flushBudgetEvaluationWork(db);
    expect((await f.readRun()).costAccountingPending).toBe(false);
    const charges = await f.charges();
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ costStatus: "estimated" });
    expect(Number(charges[0].costCents)).toBeCloseTo(25, 5);
    expect(await f.block()).toBeNull();
  });
});
