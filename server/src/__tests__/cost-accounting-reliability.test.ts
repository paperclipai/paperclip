import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agentRuntimeState, agents, approvals, budgetIncidents, budgetPolicies, companies, costEvents, createDb, financeEvents, goals, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { costService } from "../services/costs.js";
import { budgetService } from "../services/budgets.js";
import { accountRunCost, reconcileRunCosts } from "../services/run-cost-accounting.js";
import { financeService } from "../services/finance.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const support = await getEmbeddedPostgresTestSupport();
const databaseDescribe = support.supported ? describe : describe.skip;

databaseDescribe("cost accounting reliability (PostgreSQL)", () => {
  const services = hoistModuleGraph(() => {}, async () => {
    const [agentModule, companyModule] = await Promise.all([
      import("../services/agents.js"), import("../services/companies.js"),
    ]);
    return { agentService: agentModule.agentService, companyService: companyModule.companyService };
  });
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-cost-reliability-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Accounting", issuePrefix: `T${randomUUID().slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", status: "active", adapterType: "codex_local" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Project", status: "in_progress" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: "Work" }).returning();
    const [goal] = await db.insert(goals).values({ companyId: company.id, title: "Goal" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, invocationSource: "on_demand" }).returning();
    const receipt = { agentId: agent.id, provider: "test", model: "test", billingType: "metered_api", costCents: 100, occurredAt: new Date() };
    return { company, agent, project, issue, goal, run, receipt };
  }

  it.each(["issueId", "projectId", "goalId", "heartbeatRunId"] as const)("rejects a foreign-company %s without writing anything", async (field) => {
    const a = await fixture(); const b = await fixture();
    const foreignIds = { issueId: b.issue.id, projectId: b.project.id, goalId: b.goal.id, heartbeatRunId: b.run.id };
    await expect(costService(db).createEvent(a.company.id, { ...a.receipt, [field]: foreignIds[field] })).rejects.toThrow(/company/);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, a.company.id))).toHaveLength(0);
  });

  it("allows admission inside a caller transaction holding a company foreign-key lock", async () => {
    const f = await fixture();
    // The recovery service dispatches through another connection while its
    // transaction still owns FK KEY SHARE locks on the company. Accounting
    // must serialize without requesting the conflicting FOR UPDATE mode.
    await db.transaction(async (tx) => {
      await tx.insert(issues).values({ companyId: f.company.id, title: "Concurrent recovery" });
      expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    });
  }, 5000);

  it("deduplicates concurrent retries and rejects changed receipt content", async () => {
    const f = await fixture();
    const receipt = { ...f.receipt, idempotencyKey: "provider-receipt-1" };
    const events = await Promise.all(Array.from({ length: 8 }, () => costService(db).createEvent(f.company.id, receipt)));
    expect(new Set(events.map((event) => event.id)).size).toBe(1);
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(100);
    await expect(costService(db).createEvent(f.company.id, { ...receipt, costCents: 200 })).rejects.toThrow(/different|conflict/i);
    // Keys are scoped to the reporting company.
    const other = await fixture();
    await expect(costService(db).createEvent(other.company.id, { ...other.receipt, idempotencyKey: receipt.idempotencyKey })).resolves.toBeTruthy();
  });

  it("retains sub-cent spend and enforces the sum, not rounded individual receipts", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 1 }, "board");
    for (let i = 0; i < 3; i++) await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 0.4 });
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(1.2);
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toMatchObject({ scopeType: "agent" });
  });

  it("conserves project totals when a run touches multiple projects and includes unallocated spend", async () => {
    const f = await fixture();
    const [otherProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Other" }).returning();
    const [otherIssue] = await db.insert(issues).values({ companyId: f.company.id, projectId: otherProject.id, title: "Other" }).returning();
    await db.insert(activityLog).values([f.issue, otherIssue].map((issue) => ({ companyId: f.company.id, actorType: "agent", actorId: f.agent.id, action: "issue.updated", entityType: "issue", entityId: issue.id, runId: f.run.id })));
    await costService(db).createEvent(f.company.id, { ...f.receipt, heartbeatRunId: f.run.id, projectId: f.project.id });
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 30 });
    const rows = await costService(db).byProject(f.company.id);
    expect(rows.reduce((sum, row) => sum + row.costCents, 0)).toBe(130);
    expect(rows.find((row) => row.projectId === f.project.id)?.costCents).toBe(100);
    expect(rows.find((row) => row.projectId === null)?.costCents).toBe(30);
  });

  it("does not enforce inactive policies, and checks both monthly and lifetime limits", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await costService(db).createEvent(f.company.id, f.receipt);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 1, isActive: false }, "board");
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 1000, windowKind: "calendar_month_utc" }, "board");
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 50, windowKind: "lifetime" }, "board");
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 2000, windowKind: "calendar_month_utc" }, "board");
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toMatchObject({ scopeType: "agent" });
  });

  it("creates one approval under concurrent evaluation and opens a new incident after a raised budget is reached", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100 }, "board");
    const event = await costService(db).createEvent(f.company.id, f.receipt);
    await Promise.all(Array.from({ length: 8 }, () => budgets.evaluateCostEvent(event)));
    expect(await db.select().from(approvals).where(eq(approvals.companyId, f.company.id))).toHaveLength(1);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 150 }, "board");
    await costService(db).createEvent(f.company.id, f.receipt);
    expect(await db.select().from(budgetIncidents).where(and(eq(budgetIncidents.companyId, f.company.id), eq(budgetIncidents.thresholdType, "hard"), eq(budgetIncidents.status, "open")))).toHaveLength(1);
    expect(await db.select().from(approvals).where(eq(approvals.companyId, f.company.id))).toHaveLength(2);
  });

  it("commits accounting despite cancellation delivery failure and retries delivery safely", async () => {
    const f = await fixture();
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100 }, "board");
    const cancel = vi.fn().mockRejectedValueOnce(new Error("injected cancellation transport failure")).mockResolvedValue(undefined);
    const costs = costService(db, { cancelWorkForScope: cancel });
    const receipt = { ...f.receipt, idempotencyKey: "retry-after-cancel" };
    await expect(costs.createEvent(f.company.id, receipt)).resolves.toBeTruthy();
    await costs.createEvent(f.company.id, receipt);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect((await costs.summary(f.company.id)).spendCents).toBe(100);
    expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).toMatchObject({ scopeType: "agent" });
  });

  it("recovers live scopes despite deleted agent and project policies and an isolated transaction failure", async () => {
    const f = await fixture(); const other = await fixture(); const budgets = budgetService(db);
    const [removedAgent] = await db.insert(agents).values({ companyId: f.company.id, name: "Removed", adapterType: "process" }).returning();
    const [removedProject] = await db.insert(projects).values({ companyId: f.company.id, name: "Removed" }).returning();
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: removedAgent.id, amount: 100 }, "board");
    await budgets.upsertPolicy(f.company.id, { scopeType: "project", scopeId: removedProject.id, amount: 100 }, "board");
    await db.delete(agents).where(eq(agents.id, removedAgent.id));
    await db.delete(projects).where(eq(projects.id, removedProject.id));
    for (const live of [f, other]) {
      await budgets.upsertPolicy(live.company.id, { scopeType: "agent", scopeId: live.agent.id, amount: 100 }, "board");
      await db.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, live.agent.id));
    }
    // Restrict the scanned scope list so the injected first transaction fails
    // on the stale scope, ahead of both live policies in this real database.
    const query = vi.spyOn(db, "selectDistinct").mockReturnValueOnce({ from: () => ({ orderBy: async () => [
      { companyId: f.company.id, scopeType: "project", scopeId: removedProject.id },
      { companyId: f.company.id, scopeType: "agent", scopeId: removedAgent.id },
      ...[f, other].map(live => ({ companyId: live.company.id, scopeType: "agent", scopeId: live.agent.id })),
    ] }) } as never);
    const transaction = vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("Injected scope recovery failure"));
    try { await budgets.reconcilePolicies(); } finally { query.mockRestore(); transaction.mockRestore(); }
    for (const live of [f, other]) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, live.agent.id));
      expect(agent).toMatchObject({ status: "idle", pauseReason: null });
    }
    // A subsequent sweep uses actual policy discovery and skips both deleted scopes.
    await expect(budgets.reconcilePolicies()).resolves.toBeUndefined();
  });

  it("recovers terminal run accounting exactly once across simultaneous live and recovery workers", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "timed_out", finishedAt: new Date(), costAccountingPending: true,
      usageJson: { inputTokens: 20, cachedInputTokens: 100, outputTokens: 10, costUsd: 0.004, provider: "test", model: "test", billingType: "metered_api", ledgerScope: { issueId: f.issue.id, projectId: f.project.id } },
    }).where(eq(heartbeatRuns.id, f.run.id));
    await Promise.all([accountRunCost(db, f.run.id), accountRunCost(db, f.run.id), reconcileRunCosts(db)]);
    const [totals] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id));
    expect(totals).toMatchObject({ totalInputTokens: 20, totalCachedInputTokens: 100, totalOutputTokens: 10, totalCostCents: 0.4 });
    const events = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ costCents: 0.4, projectId: f.project.id });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run.costAccountingPending).toBe(false);
    expect(run.costAccountedAt).toBeInstanceOf(Date);
    // Late terminal metadata may re-arm the pending flag. The durable
    // acknowledgement, not the delivery flag, owns exactly-once totals.
    await db.update(heartbeatRuns).set({ costAccountingPending: true }).where(eq(heartbeatRuns.id, f.run.id));
    await accountRunCost(db, f.run.id);
    expect((await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id)))[0].totalCostCents).toBe(0.4);
  });

  it("rolls back the ledger and counters on accounting failure, retaining a retryable run", async () => {
    const f = await fixture(); const other = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", costAccountingPending: true, usageJson: {
      inputTokens: 10, costUsd: 1, provider: "test", model: "test", ledgerScope: { projectId: other.project.id },
    } }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(accountRunCost(db, f.run.id)).rejects.toThrow(/company/);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toHaveLength(0);
    expect(await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id))).toHaveLength(0);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].costAccountingPending).toBe(true);
  });

  it("rolls back a receipt, counters, and budget incidents if a later runtime write fails", async () => {
    const f = await fixture();
    await budgetService(db).upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 50 }, "board");
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), costAccountingPending: true, usageJson: {
      inputTokens: 10, costUsd: 1, provider: "test", billingType: "metered_api", model: "test",
    } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.execute(sql`create function reject_runtime_accounting() returns trigger language plpgsql as $$ begin raise exception 'injected runtime write failure'; end $$`);
    await db.execute(sql`create trigger reject_runtime_accounting before insert on agent_runtime_state for each row execute function reject_runtime_accounting()`);
    try {
      await expect(accountRunCost(db, f.run.id)).rejects.toThrow();
      expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toHaveLength(0);
      expect(await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, f.company.id))).toHaveLength(0);
      expect(await db.select().from(approvals).where(eq(approvals.companyId, f.company.id))).toHaveLength(0);
      expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]).toMatchObject({ spentMonthlyCents: 0, status: "active" });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
    } finally {
      await db.execute(sql`drop trigger reject_runtime_accounting on agent_runtime_state`);
      await db.execute(sql`drop function reject_runtime_accounting()`);
    }
    await accountRunCost(db, f.run.id);
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(100);
  });

  it("releases an expired monthly budget pause while preserving manual pauses", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 50 }, "board");
    const event = await costService(db).createEvent(f.company.id, f.receipt);
    const now = new Date();
    await db.update(costEvents).set({ occurredAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)) }).where(eq(costEvents.id, event.id));
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]).toMatchObject({ status: "idle", pauseReason: null });
    await db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, f.agent.id));
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 200 }, "board");
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0]).toMatchObject({ status: "paused", pauseReason: "manual" });
  });

  it("uses live observed spend for incident resolution and synchronizes company budgets", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 50 }, "board");
    await costService(db).createEvent(f.company.id, f.receipt);
    const [incident] = await db.select().from(budgetIncidents).where(and(eq(budgetIncidents.companyId, f.company.id), eq(budgetIncidents.thresholdType, "hard")));
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 25 });
    await expect(budgets.resolveIncident(f.company.id, incident.id, { action: "raise_budget_and_resume", amount: 125 }, "board")).rejects.toThrow("New budget must exceed current observed spend");
    await budgets.resolveIncident(f.company.id, incident.id, { action: "raise_budget_and_resume", amount: 175 }, "board");
    expect((await db.select().from(companies).where(eq(companies.id, f.company.id)))[0]).toMatchObject({ budgetMonthlyCents: 175, status: "active", pauseReason: null });
  });

  it("exposes missing prices and blocks strict budgets until explicitly allowed", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100 }, "board");
    await costService(db).createEvent(f.company.id, { ...f.receipt, inputTokens: 500, costCents: 0, costStatus: "unpriced" });
    expect(await costService(db).summary(f.company.id)).toMatchObject({ spendCents: 0, unpricedEventCount: 1, pricingComplete: false });
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toMatchObject({ reason: "Agent cannot start work because recorded usage has no reliable price." });
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100, unpricedUsagePolicy: "allow" }, "board");
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect((await budgets.overview(f.company.id)).policies[0]).toMatchObject({ unpricedEventCount: 1, unpricedUsagePolicy: "allow" });
  });

  it("keeps subscription-included usage outside monetary pricing gaps", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100 }, "board");
    await costService(db).createEvent(f.company.id, { ...f.receipt, inputTokens: 500, costCents: 0, costStatus: "unpriced", billingType: "subscription_included" });
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect(await costService(db).summary(f.company.id)).toMatchObject({ pricingComplete: true });
  });

  it("defaults reports to the UTC month and excludes future events from rolling spend", async () => {
    const f = await fixture(); const costs = costService(db); const now = new Date();
    await costs.createEvent(f.company.id, { ...f.receipt, occurredAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)) });
    await costs.createEvent(f.company.id, { ...f.receipt, occurredAt: new Date(now.getTime() + 86_400_000) });
    expect((await costs.summary(f.company.id)).spendCents).toBe(0);
    expect((await costs.summary(f.company.id, { allTime: true })).spendCents).toBe(200);
    expect(await costs.windowSpend(f.company.id)).toEqual([]);
  });

  it("keeps finance currencies separate and deduplicates invoice-line retries", async () => {
    const f = await fixture(); const finance = financeService(db);
    const usd = { biller: "vendor", eventKind: "platform_fee", amountCents: 100, currency: "usd", occurredAt: new Date(), idempotencyKey: "invoice:line:1", metadataJson: { a: 1, b: 2 } };
    await Promise.all(Array.from({ length: 6 }, () => finance.createEvent(f.company.id, usd)));
    await finance.createEvent(f.company.id, { ...usd, metadataJson: { b: 2, a: 1 } });
    await finance.createEvent(f.company.id, { ...usd, currency: "EUR", idempotencyKey: "invoice:line:2" });
    const summary = await finance.summary(f.company.id);
    expect(summary).toMatchObject({ currency: "USD", debitCents: 100, netCents: 100 });
    expect(summary.currencies).toEqual(expect.arrayContaining([expect.objectContaining({ currency: "USD", netCents: 100 }), expect.objectContaining({ currency: "EUR", netCents: 100 })]));
    expect(await finance.byBiller(f.company.id)).toHaveLength(2);
    expect(await finance.byKind(f.company.id)).toHaveLength(2);
    expect(await db.select().from(financeEvents).where(eq(financeEvents.companyId, f.company.id))).toHaveLength(2);
    await expect(finance.createEvent(f.company.id, { ...usd, amountCents: 200 })).rejects.toThrow(/different/);
  });

  it("synchronizes budgets through generic agent and company updates", async () => {
    const f = await fixture();
    const { agentService, companyService } = services.value;
    await agentService(db).update(f.agent.id, { budgetMonthlyCents: 50 });
    await companyService(db).update(f.company.id, { budgetMonthlyCents: 75 });
    await costService(db).createEvent(f.company.id, f.receipt);
    const policies = await budgetService(db).listPolicies(f.company.id);
    expect(policies).toEqual(expect.arrayContaining([expect.objectContaining({ scopeType: "agent", amount: 50 }), expect.objectContaining({ scopeType: "company", amount: 75 })]));
    expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id)).toMatchObject({ scopeType: "company" });
  });

  it("conserves both spend and tokens across complete per-model receipts", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), costAccountingPending: true, usageJson: {
      provider: "anthropic", billingType: "metered_api", model: "mixed", costUsd: 0.007,
      inputTokens: 30, outputTokens: 4, cachedInputTokens: 100,
      usageByModel: [
        { model: "large", costUsd: 0.005, usage: { inputTokens: 20, outputTokens: 3, cachedInputTokens: 100 } },
        { model: "small", costUsd: 0.002, usage: { inputTokens: 10, outputTokens: 1 } },
      ],
    } }).where(eq(heartbeatRuns.id, f.run.id));
    await accountRunCost(db, f.run.id);
    const rows = await costService(db).byProvider(f.company.id);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ model: "large", costCents: 0.5, inputTokens: 20 }), expect.objectContaining({ model: "small", costCents: 0.2, inputTokens: 10 })]));
    expect((await costService(db).summary(f.company.id)).spendCents).toBe(0.7);
    const [totals] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id));
    expect(totals).toMatchObject({ totalInputTokens: 30, totalCachedInputTokens: 100, totalOutputTokens: 4, totalCostCents: 0.7 });
  });
  it("blocks admission while a terminal run awaits accounting, even under an allow-unpriced policy", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 1000, unpricedUsagePolicy: "allow" }, "board");
    await db.update(heartbeatRuns).set({ status: "failed", costAccountingPending: true }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toMatchObject({ reason: expect.stringContaining("await accounting") });
    expect(await costService(db).summary(f.company.id)).toMatchObject({ pricingComplete: false, pendingRunCount: 1 });
    await accountRunCost(db, f.run.id);
    expect(await costService(db).summary(f.company.id)).toMatchObject({ pricingComplete: false, pendingRunCount: 0, unpricedEventCount: 1 });
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
  });

  it("waits for a late provider receipt after cancellation instead of acknowledging a zero charge", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "cancelled", costAccountingPending: true, usageJson: { accountingReceiptReady: false } }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await accountRunCost(db, f.run.id)).toBe(false);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toMatchObject({ costAccountingPending: true, costAccountedAt: null });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(0);
    await db.update(heartbeatRuns).set({ usageJson: { accountingReceiptReady: true, costUsd: 0.25, inputTokens: 10 } }).where(eq(heartbeatRuns.id, f.run.id));
    await Promise.all([accountRunCost(db, f.run.id), accountRunCost(db, f.run.id)]);
    expect((await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id)))[0]).toMatchObject({ costCents: 25, inputTokens: 10 });
    expect((await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, f.agent.id)))[0].totalCostCents).toBe(25);
  });

  it("acknowledges proven pre-provider failures without inventing a charge", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", costAccountingPending: true,
      resultJson: { executionRecovery: { providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, f.run.id));
    await accountRunCost(db, f.run.id);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toHaveLength(0);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toMatchObject({ costAccountingPending: false, costAccountedAt: expect.any(Date) });
  });

  it("records spend after attribution targets are deleted", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "failed", costAccountingPending: true, usageJson: {
      costUsd: 0.01, ledgerScope: { projectId: f.project.id, issueId: f.issue.id },
    } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.delete(issues).where(eq(issues.id, f.issue.id));
    await db.delete(projects).where(eq(projects.id, f.project.id));
    await accountRunCost(db, f.run.id);
    expect((await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id)))[0]).toMatchObject({ costCents: 1, issueId: null, projectId: null });
  });

  it("preserves dismissed incidents and warning incidents during admission checks", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 100 }, "board");
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 80 });
    for (let i = 0; i < 3; i++) expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
    expect((await budgets.overview(f.company.id)).activeIncidents).toHaveLength(1);
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 20 });
    const [incident] = await db.select().from(budgetIncidents).where(and(eq(budgetIncidents.companyId, f.company.id), eq(budgetIncidents.thresholdType, "hard")));
    await budgets.resolveIncident(f.company.id, incident.id, { action: "keep_paused" }, "board");
    for (let i = 0; i < 3; i++) expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeTruthy();
    expect(await db.select().from(approvals).where(eq(approvals.companyId, f.company.id))).toHaveLength(1);
  });

  it("does not revive terminated agents or archived companies during budget reconciliation", async () => {
    const f = await fixture(); const budgets = budgetService(db);
    await db.update(agents).set({ status: "terminated", pauseReason: "budget" }).where(eq(agents.id, f.agent.id));
    await db.update(companies).set({ status: "archived", pauseReason: "budget" }).where(eq(companies.id, f.company.id));
    for (const [scopeType, scopeId] of [["agent", f.agent.id], ["company", f.company.id]] as const) {
      await budgets.upsertPolicy(f.company.id, { scopeType, scopeId, amount: 1000 }, "board");
    }
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 2000 });
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].status).toBe("terminated");
    expect((await db.select().from(companies).where(eq(companies.id, f.company.id)))[0].status).toBe("archived");
  });

  it.each(["agent", "company", "project"] as const)("limits delayed %s budget cancellation to work that preceded the policy check", async (scopeType) => {
    const f = await fixture();
    const { heartbeatService } = await import("../services/heartbeat.js");
    const heartbeat = heartbeatService(db);
    const scopeId = scopeType === "agent" ? f.agent.id : scopeType === "company" ? f.company.id : f.project.id;
    const cutoff = new Date();
    await db.update(heartbeatRuns).set({ status: "queued", createdAt: new Date(cutoff.getTime() - 1000), contextSnapshot: { projectId: f.project.id } }).where(eq(heartbeatRuns.id, f.run.id));
    const [newRun] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, invocationSource: "on_demand", status: "scheduled_retry",
      scheduledRetryAt: new Date(cutoff.getTime() + 60000), createdAt: new Date(cutoff.getTime() + 1000), contextSnapshot: { projectId: f.project.id },
    }).returning();
    await heartbeat.cancelBudgetScopeWork({ companyId: f.company.id, scopeType, scopeId, createdBefore: cutoff });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0].status).toBe("cancelled");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, newRun.id)))[0].status).toBe("scheduled_retry");
  });

});
