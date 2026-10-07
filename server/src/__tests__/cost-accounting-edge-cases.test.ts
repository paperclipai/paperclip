import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, costEvents, createDb, goals, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { costService } from "../services/costs.js";
import { financeService } from "../services/finance.js";
import { budgetService } from "../services/budgets.js";
import { accountRunCost, reconcileRunCosts } from "../services/run-cost-accounting.js";
import { receiptFingerprint } from "../services/receipt-fingerprint.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { logger } from "../middleware/logger.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("accounting validation and recovery edges (PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-accounting-edges-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await database?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Accounting edges", issuePrefix: `E${randomUUID().slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", role: "engineer", adapterType: "process", status: "idle" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Project" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Work", projectId: project.id }).returning();
    const [goal] = await db.insert(goals).values({ companyId: company.id, title: "Goal" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id }).returning();
    const receipt = { agentId: agent.id, provider: "fixture", model: "fixture", billingType: "metered_api", costCents: 0.1234567, occurredAt: new Date() };
    const cost = await costService(db).createEvent(company.id, receipt);
    const finance = { eventKind: "inference_charge", biller: "fixture", amountCents: 123, occurredAt: new Date() };
    return { company, agent, project, issue, goal, run, cost, receipt, finance,
      links: { agentId: agent.id, projectId: project.id, issueId: issue.id, goalId: goal.id, heartbeatRunId: run.id, costEventId: cost.id } };
  }

  it.each(["agentId", "projectId", "issueId", "goalId", "heartbeatRunId", "costEventId"] as const)("rejects foreign and missing finance %s, accepts company-owned links", async field => {
    const a = await fixture(), b = await fixture();
    const service = financeService(db);
    await expect(service.createEvent(a.company.id, { ...a.finance, [field]: b.links[field] })).rejects.toMatchObject({ status: 422 });
    await expect(service.createEvent(a.company.id, { ...a.finance, [field]: randomUUID() })).rejects.toMatchObject({ status: 404 });
    expect(await service.list(a.company.id)).toHaveLength(0);
    const event = await service.createEvent(a.company.id, { ...a.finance, ...a.links }, { actorType: "user", actorId: "board", agentId: a.agent.id });
    expect(event[field]).toBe(a.links[field]);
    expect(await service.list(a.company.id)).toEqual([event]);
  });

  it("normalizes finance retries and rolls back changed keys and invalid amounts/currencies", async () => {
    const f = await fixture(), service = financeService(db);
    const receipt = { ...f.finance, idempotencyKey: "invoice", currency: "usd", metadataJson: { entries: [{ z: 2, a: 1 }, null] } };
    const event = await service.createEvent(f.company.id, receipt);
    expect((await service.createEvent(f.company.id, { ...receipt, currency: "USD", metadataJson: { entries: [{ a: 1, z: 2 }, null] } })).id).toBe(event.id);
    await expect(service.createEvent(f.company.id, { ...receipt, amountCents: 124 })).rejects.toMatchObject({ status: 409 });
    for (const invalid of [{ amountCents: -1 }, { amountCents: "1.2.3" }, { amountCents: Number.POSITIVE_INFINITY }, { currency: "US" }]) {
      await expect(service.createEvent(f.company.id, { ...f.finance, ...invalid })).rejects.toMatchObject({ status: 422 });
    }
    expect(await service.list(f.company.id)).toHaveLength(1);
    expect((await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).filter(row => row.action === "finance_event.reported")).toHaveLength(1);
  });

  it("keeps finance credits, estimates, currencies, dates, and companies separate in every report", async () => {
    const f = await fixture(), foreign = await fixture(), service = financeService(db);
    const date = new Date("2026-08-15T12:00:00Z");
    await service.createEvent(f.company.id, { ...f.finance, occurredAt: date, amountCents: 150, estimated: true });
    await service.createEvent(f.company.id, { ...f.finance, occurredAt: new Date(date.getTime() + 1), eventKind: "credit_refund", direction: "credit", amountCents: 40 });
    await service.createEvent(f.company.id, { ...f.finance, occurredAt: date, amountCents: 900, currency: "EUR" });
    await service.createEvent(f.company.id, { ...f.finance, occurredAt: new Date("2026-08-16T00:00:00Z"), amountCents: 999 });
    await service.createEvent(foreign.company.id, { ...foreign.finance, occurredAt: date, amountCents: 999 });
    const range = { from: date, to: new Date(date.getTime() + 1) };
    expect(await service.summary(f.company.id, range)).toMatchObject({ debitCents: 150, creditCents: 40, estimatedDebitCents: 150, netCents: 110, eventCount: 2,
      currencies: [expect.objectContaining({ currency: "EUR", netCents: 900, eventCount: 1 }), expect.objectContaining({ currency: "USD", netCents: 110, eventCount: 2 })] });
    expect(await service.byBiller(f.company.id, range)).toEqual([
      expect.objectContaining({ biller: "fixture", currency: "EUR", netCents: 900, eventCount: 1, kindCount: 1 }),
      expect.objectContaining({ biller: "fixture", currency: "USD", netCents: 110, eventCount: 2, kindCount: 2 }),
    ]);
    expect(await service.byKind(f.company.id, range)).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventKind: "inference_charge", currency: "EUR", netCents: 900 }),
      expect.objectContaining({ eventKind: "inference_charge", currency: "USD", netCents: 150, estimatedDebitCents: 150 }),
      expect.objectContaining({ eventKind: "credit_refund", currency: "USD", netCents: -40, billerCount: 1 }),
    ]));
    expect(await service.list(f.company.id, range, 1)).toEqual([expect.objectContaining({ direction: "credit", amountCents: 40 })]);
    expect(await service.summary(randomUUID())).toMatchObject({ currencies: [], debitCents: 0, creditCents: 0, netCents: 0, eventCount: 0 });
  });

  it("rejects missing companies, missing links, run/agent mismatches, and invalid cost inputs without side effects", async () => {
    const f = await fixture(), costs = costService(db);
    await expect(costs.createEvent(randomUUID(), f.receipt)).rejects.toMatchObject({ status: 404 });
    await expect(costs.summary(randomUUID())).rejects.toMatchObject({ status: 404 });
    for (const field of ["agentId", "issueId", "projectId", "goalId", "heartbeatRunId"]) {
      await expect(costs.createEvent(f.company.id, { ...f.receipt, [field]: randomUUID() })).rejects.toMatchObject({ status: 404 });
    }
    const [otherAgent] = await db.insert(agents).values({ companyId: f.company.id, name: "Other", role: "engineer", adapterType: "process" }).returning();
    await expect(costs.createEvent(f.company.id, { ...f.receipt, agentId: otherAgent.id, heartbeatRunId: f.run.id })).rejects.toThrow("does not belong to agent");
    for (const invalid of [{ costCents: -1 }, { costCents: NaN }, { inputTokens: 0.5 }, { cachedInputTokens: -1 }, { outputTokens: 2 ** 31 }]) {
      await expect(costs.createEvent(f.company.id, { ...f.receipt, ...invalid })).rejects.toMatchObject({ status: 422 });
    }
    expect((await costs.summary(f.company.id)).spendCents).toBe(f.receipt.costCents);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.company.id))).toHaveLength(1);
  });

  it("aggregates billers with fractional cents, cache tokens, and subscription runs without cross-company leakage", async () => {
    const f = await fixture(), foreign = await fixture(), costs = costService(db);
    const date = new Date("2026-08-15T12:00:00Z");
    await costs.createEvent(f.company.id, { ...f.receipt, occurredAt: date, biller: "gateway", provider: "a", model: "a", heartbeatRunId: f.run.id, inputTokens: 2, cachedInputTokens: 3, outputTokens: 5 });
    await costs.createEvent(f.company.id, { ...f.receipt, occurredAt: date, biller: "gateway", provider: "b", model: "b", heartbeatRunId: f.run.id, billingType: "subscription_included", costCents: 0, inputTokens: 7, cachedInputTokens: 11, outputTokens: 13 });
    await costs.createEvent(foreign.company.id, { ...foreign.receipt, occurredAt: date, biller: "gateway", costCents: 999 });
    expect(await costs.byBiller(f.company.id, { from: date, to: date })).toEqual([{
      biller: "gateway", costCents: 0.1234567, costCentsExact: "0.1234567", inputTokens: 9, cachedInputTokens: 14, outputTokens: 18,
      apiRunCount: 1, subscriptionRunCount: 1, subscriptionInputTokens: 7, subscriptionCachedInputTokens: 11, subscriptionOutputTokens: 13, providerCount: 2, modelCount: 2,
    }]);
  });

  it("commits a receipt and its audit record even when a live subscriber throws", async () => {
    const f = await fixture();
    const listener = vi.fn(() => { throw new Error("Injected disconnected live subscriber"); });
    const unsubscribe = subscribeCompanyLiveEvents(f.company.id, listener);
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const receipt = { ...f.receipt, idempotencyKey: "committed-before-publication" };
      const event = await costService(db).createEvent(f.company.id, receipt, { actorType: "user", actorId: "board" });
      expect((await costService(db).createEvent(f.company.id, receipt)).id).toBe(event.id);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledOnce();
      expect((await costService(db).summary(f.company.id)).spendCents).toBe(0.2469134);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, event.id))).toHaveLength(1);
    } finally { unsubscribe(); warning.mockRestore(); }
  });

  it("reports lifetime history consistently across every cost grouping and finance view", async () => {
    const f = await fixture(), costs = costService(db), finance = financeService(db);
    const occurredAt = new Date("2000-01-01T00:00:00Z");
    await costs.createEvent(f.company.id, { ...f.receipt, occurredAt, costCents: 5, projectId: f.project.id, inputTokens: 2 });
    await finance.createEvent(f.company.id, { ...f.finance, occurredAt });
    const lifetime = { allTime: true };
    for (const read of [costs.byAgent, costs.byAgentModel, costs.byProvider, costs.byBiller, costs.byProject]) {
      const rows = await read(f.company.id, lifetime);
      expect(rows.reduce((sum, row) => sum + row.costCents, 0)).toBe(5.1234567);
      expect(rows.reduce((sum, row) => sum + row.inputTokens, 0)).toBe(2);
    }
    expect((await costs.summary(f.company.id)).spendCents).toBe(0.1234567);
    expect((await costs.summary(f.company.id, lifetime)).spendCents).toBe(5.1234567);
    expect((await finance.summary(f.company.id)).eventCount).toBe(0);
    expect((await finance.summary(f.company.id, lifetime)).debitCents).toBe(123);
    expect(await finance.list(f.company.id, lifetime)).toHaveLength(1);
    expect((await finance.byBiller(f.company.id, lifetime))[0].netCents).toBe(123);
    expect((await finance.byKind(f.company.id, lifetime))[0].netCents).toBe(123);
    await db.update(companies).set({ budgetMonthlyCents: 1 }).where(eq(companies.id, f.company.id));
    expect((await costs.summary(f.company.id)).utilizationPercent).toBe(12.35);
  });

  it.each(["company", "agent", "project"] as const)("rejects nonexistent and foreign %s budget scopes without creating policies", async scopeType => {
    const f = await fixture(), foreign = await fixture(), budgets = budgetService(db);
    await expect(budgets.upsertPolicy(f.company.id, { scopeType, scopeId: randomUUID(), amount: 10 }, "board")).rejects.toMatchObject({ status: 404 });
    await expect(budgets.upsertPolicy(f.company.id, { scopeType, scopeId: foreign[scopeType].id, amount: 10 }, "board")).rejects.toMatchObject({ status: 422 });
    expect(await budgets.listPolicies(f.company.id)).toHaveLength(0);
    if (scopeType !== "company") {
      await expect(budgets.getInvocationBlock(f.company.id, scopeType === "agent" ? foreign.agent.id : f.agent.id,
        scopeType === "project" ? { projectId: foreign.project.id } : undefined)).rejects.toMatchObject({ status: 404 });
    }
  });

  it.each(["unpriced", "pending"] as const)("refuses an incident budget raise while accounting is %s, without partial mutations", async kind => {
    const f = await fixture(), budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "agent", scopeId: f.agent.id, amount: 10 }, "board");
    if (kind === "unpriced") {
      await costService(db).createEvent(f.company.id, { ...f.receipt, costStatus: "unpriced", costCents: 0 });
    } else {
      await db.update(heartbeatRuns).set({ status: "failed", costAccountingPending: true, finishedAt: new Date(), usageJson: { accountingReceiptReady: false } }).where(eq(heartbeatRuns.id, f.run.id));
      await budgets.getInvocationBlock(f.company.id, f.agent.id);
    }
    const [incident] = (await budgets.overview(f.company.id)).activeIncidents;
    const resolution = { action: "raise_budget_and_resume" as const, amount: 100 };
    await expect(budgets.resolveIncident(f.company.id, randomUUID(), resolution, "board")).rejects.toMatchObject({ status: 404 });
    const foreign = await fixture();
    await expect(budgets.resolveIncident(foreign.company.id, incident.id, resolution, "board")).rejects.toMatchObject({ status: 404 });
    await expect(budgets.resolveIncident(f.company.id, incident.id, resolution, "board")).rejects.toThrow(kind === "unpriced" ? /unpriced usage/ : /finish accounting/);
    expect((await budgets.listPolicies(f.company.id))[0].amount).toBe(10);
    expect((await budgets.overview(f.company.id)).activeIncidents).toEqual([expect.objectContaining({ id: incident.id, status: "open" })]);
    expect((await db.select().from(agents).where(eq(agents.id, f.agent.id)))[0].status).toBe("paused");
  });

  it.each(["company", "project"] as const)("preserves an operator's %s pause even without a policy", async scopeType => {
    const f = await fixture();
    if (scopeType === "company") await db.update(companies).set({ status: "paused", pauseReason: "manual", pausedAt: new Date() }).where(eq(companies.id, f.company.id));
    else await db.update(projects).set({ pauseReason: "manual", pausedAt: new Date() }).where(eq(projects.id, f.project.id));
    expect(await budgetService(db).getInvocationBlock(f.company.id, f.agent.id, { projectId: f.project.id }))
      .toMatchObject({ scopeType, reason: expect.stringContaining("paused and cannot start") });
  });

  it("resolves a company incident and updates the legacy monthly budget together", async () => {
    const f = await fixture(), budgets = budgetService(db);
    await budgets.upsertPolicy(f.company.id, { scopeType: "company", scopeId: f.company.id, amount: 1 }, "board");
    await costService(db).createEvent(f.company.id, { ...f.receipt, costCents: 2 });
    const [incident] = (await budgets.overview(f.company.id)).activeIncidents;
    await budgets.resolveIncident(f.company.id, incident.id, { action: "raise_budget_and_resume", amount: 10 }, "board");
    expect((await db.select().from(companies).where(eq(companies.id, f.company.id)))[0]).toMatchObject({ status: "active", pauseReason: null, budgetMonthlyCents: 10 });
    expect((await budgets.listPolicies(f.company.id))[0].amount).toBe(10);
    expect(await budgets.getInvocationBlock(f.company.id, f.agent.id)).toBeNull();
  });

  it.each([false, true])("records subscription tokens at zero incremental charge (split=%s)", async split => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "succeeded", costAccountingPending: true,
      usageJson: { billingType: "subscription_included", costUsd: 1, inputTokens: 3, cachedInputTokens: 5, outputTokens: 7,
        ...(split ? { usageByModel: [{ model: "a", costUsd: 1, usage: { inputTokens: 3, cachedInputTokens: 5, outputTokens: 7 } }] } : {}),
      },
    }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await accountRunCost(db, f.run.id)).toBe(true);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toEqual([
      expect.objectContaining({ costCents: 0, costStatus: "reported", inputTokens: 3, cachedInputTokens: 5, outputTokens: 7, billingType: "subscription_included" }),
    ]);
  });

  it("rotates a full poisoned recovery batch so the next valid receipt cannot starve", async () => {
    const f = await fixture(), foreign = await fixture();
    const poison = await db.insert(heartbeatRuns).values(Array.from({ length: 100 }, () => ({
      companyId: f.company.id, agentId: f.agent.id, status: "failed", costAccountingPending: true, updatedAt: new Date(0),
      usageJson: { accountingReceiptReady: true, costUsd: 0.01, ledgerScope: { projectId: foreign.project.id } },
    }))).returning();
    const [valid] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "succeeded", costAccountingPending: true,
      updatedAt: new Date(1), usageJson: { accountingReceiptReady: true, costUsd: 0.02 },
    }).returning();
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      expect(await reconcileRunCosts(db)).toEqual({ scanned: 100, accounted: 0 });
      expect(await reconcileRunCosts(db)).toEqual({ scanned: 100, accounted: 1 });
      expect(error).toHaveBeenCalledTimes(199);
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, valid.id))).toEqual([expect.objectContaining({ costCents: 2 })]);
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id));
      expect(rows.filter(row => row.costAccountingPending)).toHaveLength(100);
      expect(rows.filter(row => poison.some(bad => bad.id === row.id)).every(row => row.costAccountedAt === null)).toBe(true);
      expect((await costService(db).summary(f.company.id)).spendCents).toBe(2.1234567);
      expect(await accountRunCost(db, valid.id)).toBe(false);
      expect(await accountRunCost(db, randomUUID())).toBe(false);
    } finally { error.mockRestore(); }
  }, 30_000);
});

it("fingerprints nested receipts independently of object order while preserving array order and values", () => {
  const a = { items: [{ z: 2, a: 1 }, null], at: new Date("2026-01-01T00:00:00Z") };
  expect(receiptFingerprint(a)).toBe(receiptFingerprint({ at: a.at, items: [{ a: 1, z: 2 }, null] }));
  expect(receiptFingerprint(a)).not.toBe(receiptFingerprint({ ...a, items: [null, { z: 2, a: 1 }] }));
  expect(receiptFingerprint(a)).not.toBe(receiptFingerprint({ ...a, items: [{ z: 3, a: 1 }, null] }));
});
