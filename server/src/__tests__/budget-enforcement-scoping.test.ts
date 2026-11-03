import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, budgetPolicies, budgetReservations, companies, costEvents, createDb, heartbeatRuns, projects, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { budgetService, computeObservedSpend } from "../services/budgets.js";
import { reserveRunBudget } from "../services/budget-reservations.js";
import { accountRunCost } from "../services/run-cost-accounting.js";
import { persistUsageReceipt, type UsageReceiptEnvelope } from "../services/usage-receipts.js";
import { configureAgentLifecycle } from "../services/agent-lifecycle.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("scoped live budget enforcement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("budget-live-scoping-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture(options: { scope?: "company" | "agent" | "project"; amount?: number; reservationCents?: string } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
    const projectId = randomUUID(), runId = randomUUID(), sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Budget live", issuePrefix: "BLIVE" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Running", role: "engineer", status: "active", adapterType: "process" },
      { id: otherAgentId, companyId, name: "Unrelated idle", role: "engineer", status: "idle", adapterType: "process" },
    ]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Scoped project", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "running",
      costAccountingPending: true, usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0,
        accountingReceiptReady: false, ledgerScope: { projectId } } });
    const scopeType = options.scope ?? "agent";
    const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType,
      scopeId: scopeType === "company" ? companyId : scopeType === "project" ? projectId : agentId,
      metric: "billed_cents", windowKind: "lifetime", amount: options.amount ?? 100,
      reservationCents: options.reservationCents ?? "0", notifyEnabled: false }).returning();
    const readRun = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
    const exposure = () => computeObservedSpend(db, policy);
    const receipt = (sequence: number, costUsd?: number, extra: Partial<UsageReceiptEnvelope["receipt"]> = {}): UsageReceiptEnvelope => ({
      schema: "paperclip/accounting-receipt/v1", id: randomUUID(), companyId, runId, sourceId, sequence,
      receivedAt: new Date().toISOString(), adapterType: "process", receipt: {
        complete: false, usageBasis: "per_run", provider: "test", biller: "test", model: "budget-fixture",
        billingType: "metered_api", costStatus: "unpriced", ...(costUsd === undefined ? {} : { costUsd }), ...extra,
      },
    });
    const queuedRun = async (id = randomUUID()) => {
      await db.insert(heartbeatRuns).values({ id, companyId, agentId, invocationSource: "on_demand", status: "queued" });
      return id;
    };
    return { companyId, agentId, otherAgentId, projectId, runId, sourceId, policy, readRun, exposure, receipt, queuedRun };
  }

  it("blocks a known streaming overrun without charging checkpoints or touching unrelated agents", async () => {
    const f = await fixture();
    const [before] = await db.select().from(agents).where(eq(agents.id, f.otherAgentId));
    await persistUsageReceipt(db, f.receipt(1, 0.6));
    expect((await f.exposure()).totalExact).toBe("60.0000000");
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.agentId, { projectId: f.projectId })).toBeNull();
    await persistUsageReceipt(db, f.receipt(2, 1.1));
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [policy] = await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, f.policy.id));
    const [other] = await db.select().from(agents).where(eq(agents.id, f.otherAgentId));
    expect(agent.lifecycleHolds).toContain("budget");
    expect(policy.enforcementVersion).toBeGreaterThan(policy.enforcementDeliveredVersion);
    expect(other).toEqual(before);
    expect(await db.select().from(costEvents)).toHaveLength(0);
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.agentId, { projectId: f.projectId })).not.toBeNull();
    expect((await f.exposure()).liveObservedCents).toBe("110.0000000");
  });

  it("replaces cumulative observations and preserves known exposure across missing, stale, and lower partial costs", async () => {
    const f = await fixture({ amount: 1000 });
    const first = f.receipt(1, 0.4);
    await persistUsageReceipt(db, first);
    await persistUsageReceipt(db, f.receipt(2, 0.7));
    await persistUsageReceipt(db, first);
    await persistUsageReceipt(db, f.receipt(3));
    await persistUsageReceipt(db, { ...f.receipt(1, 20), sourceId: randomUUID() });
    await persistUsageReceipt(db, f.receipt(4, 0.5));
    expect((await f.exposure()).liveObservedCents).toBe("70.0000000");
    expect((await f.readRun()).usageJson?.budgetExposure).toMatchObject({ sourceId: f.sourceId, sequence: 4, costCents: "70.0000000" });
    expect(await db.select().from(costEvents)).toHaveLength(0);
  });

  it("counts the maximum of a reservation and live spend once at final dispatch", async () => {
    const f = await fixture({ reservationCents: "40" });
    await db.insert(budgetReservations).values({ companyId: f.companyId, runId: f.runId, agentId: f.agentId,
      projectId: f.projectId, amountCents: "50", providerStartedAt: new Date() });
    await persistUsageReceipt(db, f.receipt(1, 0.6));
    expect((await f.exposure()).effectiveHeldCents).toBe("60.0000000");
    const nextRunId = await f.queuedRun();
    expect((await reserveRunBudget(db, f.companyId, nextRunId, f.projectId)).amountCents).toBe("40.0000000");
    expect((await f.exposure()).effectiveHeldCents).toBe("100.0000000");
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.agentId, { projectId: f.projectId })).toBeNull();
    await expect(reserveRunBudget(db, f.companyId, await f.queuedRun(), f.projectId)).rejects.toThrow("reserved");
  });

  it("serializes competing dispatch reservations without overspending available capacity", async () => {
    const f = await fixture({ reservationCents: "60" });
    const first = await f.queuedRun(), second = await f.queuedRun();
    const outcomes = await Promise.allSettled([
      reserveRunBudget(db, f.companyId, first, f.projectId), reserveRunBudget(db, f.companyId, second, f.projectId),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await f.exposure()).effectiveHeldCents).toBe("60.0000000");
  });

  it("commits a budget release while dispatch waits for asynchronous lifecycle readiness", async () => {
    const f = await fixture();
    const worker = configureAgentLifecycle(db, {
      requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete",
    });
    try {
      await persistUsageReceipt(db, f.receipt(1, 1.1));
      await worker.process(f.agentId);
      expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0].lifecycleState).toBe("paused");
      await db.update(budgetPolicies).set({ amount: 200 }).where(eq(budgetPolicies.id, f.policy.id));
      const nextRunId = await f.queuedRun();
      await expect(reserveRunBudget(db, f.companyId, nextRunId, f.projectId)).rejects.toThrow("lifecycle");
      const [resuming] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      expect(resuming.lifecycleHolds).not.toContain("budget");
      expect(resuming.lifecycleState).toBe("resuming");
      expect(await db.select().from(budgetReservations).where(eq(budgetReservations.runId, nextRunId))).toHaveLength(0);
      await worker.process(f.agentId);
      expect((await db.select().from(agents).where(eq(agents.id, f.agentId)))[0].lifecycleState).toBe("ready");
      await expect(reserveRunBudget(db, f.companyId, nextRunId, f.projectId)).resolves.toMatchObject({ reused: false });
    } finally { await worker.stop(); }
  });

  it("atomically replaces live exposure and its hold with one final ledger charge", async () => {
    const f = await fixture({ amount: 1000 });
    await db.insert(budgetReservations).values({ companyId: f.companyId, runId: f.runId, agentId: f.agentId,
      projectId: f.projectId, amountCents: "50", providerStartedAt: new Date() });
    await persistUsageReceipt(db, f.receipt(1, 0.6));
    await persistUsageReceipt(db, f.receipt(2, 0.8, { complete: true, costStatus: "reported" }));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    expect(await accountRunCost(db, f.runId)).toBe(true);
    expect(await accountRunCost(db, f.runId)).toBe(false);
    expect(await f.exposure()).toMatchObject({ ledgerCents: "80.0000000", liveObservedCents: "0.0000000",
      effectiveHeldCents: "0.0000000", totalExact: "80.0000000", pendingTerminalRunCount: 0 });
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId))).toHaveLength(1);
    const [hold] = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, f.runId));
    expect(hold.state).toBe("settled");
  });

  it("keeps an over-budget hold stable while replacing live usage with a multipart final receipt", async () => {
    const f = await fixture();
    await persistUsageReceipt(db, f.receipt(1, 1.1));
    await persistUsageReceipt(db, f.receipt(2, 1.2, { complete: true, costStatus: "reported", usage: { inputTokens: 2, outputTokens: 2 },
      usageByModel: [
        { model: "first", costUsd: 0.3, usage: { inputTokens: 1, outputTokens: 1 } },
        { model: "second", costUsd: 0.9, usage: { inputTokens: 1, outputTokens: 1 } },
      ] }));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    const [before] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(before.lifecycleHolds).toContain("budget");
    await accountRunCost(db, f.runId);
    const [after] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(after.lifecycleHolds).toContain("budget");
    expect(after.lifecycleVersion).toBe(before.lifecycleVersion);
    expect(after.lifecycleOperation).toEqual(before.lifecycleOperation);
    expect(await f.exposure()).toMatchObject({ ledgerCents: "120.0000000", liveObservedCents: "0.0000000" });
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId))).toHaveLength(2);
  });

  it("recognizes legacy active-run usage without a projection and excludes subscription charges", async () => {
    const f = await fixture();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ usageJson: { ...run.usageJson, costUsd: 0.75, usageSource: "per_run", billingType: "metered_api" } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect((await f.exposure()).liveObservedCents).toBe("75.0000000");
    await persistUsageReceipt(db, f.receipt(1, 10, { billingType: "subscription_included" }));
    expect((await f.exposure()).liveObservedCents).toBe("0.0000000");
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.agentId, { projectId: f.projectId })).toBeNull();
  });

  it("retains established per-run exposure when a later receipt has an unreconciled session basis", async () => {
    const f = await fixture();
    await persistUsageReceipt(db, f.receipt(1, 0.7));
    await persistUsageReceipt(db, f.receipt(2, 99, { usageBasis: "session_cumulative" }));
    expect((await f.exposure()).liveObservedCents).toBe("70.0000000");
    expect((await f.readRun()).usageJson?.budgetExposure).toMatchObject({ costCents: "70.0000000" });
  });

  it("ignores out-of-range legacy numeric text without losing a usable fallback price", async () => {
    const f = await fixture();
    const run = await f.readRun();
    await db.update(heartbeatRuns).set({ usageJson: { ...run.usageJson, usageSource: "per_run", billingType: "metered_api",
      cacheAdjustedCostUsd: "1e999", costUsdExact: "1e999", costUsd: 0.25 } }).where(eq(heartbeatRuns.id, f.runId));
    expect((await f.exposure()).liveObservedCents).toBe("25.0000000");
  });

  it("rounds each legacy run to nanodollars before aggregating its exposure", async () => {
    const f = await fixture();
    const secondRunId = randomUUID();
    const usage = { usageSource: "per_run", billingType: "metered_api", costUsdExact: "0.0000000004" };
    await db.update(heartbeatRuns).set({ usageJson: usage }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(heartbeatRuns).values({ id: secondRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "running", costAccountingPending: true, usageJson: usage });
    expect((await f.exposure()).liveObservedCents).toBe("0.0000000");
    await db.update(heartbeatRuns).set({ usageJson: { ...usage, costUsdExact: "0.0000000005" } })
      .where(eq(heartbeatRuns.companyId, f.companyId));
    expect((await f.exposure()).liveObservedCents).toBe("0.0000002");
  });

  it("limits project enforcement to that project while the same agent can serve another", async () => {
    const f = await fixture({ scope: "project" });
    const [otherProject] = await db.insert(projects).values({ companyId: f.companyId, name: "Other project", status: "in_progress" }).returning();
    await persistUsageReceipt(db, f.receipt(1, 1.1));
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [project] = await db.select().from(projects).where(eq(projects.id, f.projectId));
    expect(project.pauseReason).toBe("budget");
    expect(agent.lifecycleHolds).not.toContain("budget");
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.agentId, { projectId: f.projectId })).not.toBeNull();
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.agentId, { projectId: otherProject.id })).toBeNull();
    await expect(reserveRunBudget(db, f.companyId, await f.queuedRun(), otherProject.id)).resolves.toMatchObject({ reused: false });
  });

  it("keeps missing-price terminal work held until accounting evidence arrives", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.agentId, { projectId: f.projectId })).not.toBeNull();
    expect(await f.exposure()).toMatchObject({ pendingTerminalRunCount: 1, ledgerCents: "0.0000000", liveObservedCents: "0.0000000" });
    expect(await accountRunCost(db, f.runId)).toBe(false);
    expect((await f.readRun()).costAccountingPending).toBe(true);
    expect(await db.select().from(costEvents).where(and(eq(costEvents.companyId, f.companyId), eq(costEvents.heartbeatRunId, f.runId)))).toHaveLength(0);
  });

  it.each(["pre-provider release", "stale pending marker"])("releases accounting-induced holds after %s", async kind => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    expect(await budgetService(db).getInvocationBlock(f.companyId, f.agentId, { projectId: f.projectId })).not.toBeNull();
    const [held] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(held.lifecycleHolds).toContain("budget");
    await db.update(heartbeatRuns).set(kind === "pre-provider release"
      ? { resultJson: { executionRecovery: { providerWorkStarted: false } } }
      : { costAccountedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    expect(await accountRunCost(db, f.runId)).toBe(kind === "pre-provider release");
    const [released] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(released.lifecycleHolds).not.toContain("budget");
    expect((await f.readRun()).costAccountingPending).toBe(false);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId))).toHaveLength(0);
  });
});
