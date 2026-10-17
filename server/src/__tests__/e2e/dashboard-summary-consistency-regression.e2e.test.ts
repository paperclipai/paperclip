import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, gte, sql } from "drizzle-orm";
import {
  agents,
  approvals,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../helpers/embedded-postgres.js";
import { dashboardService, getUtcMonthStart } from "../../services/dashboard.js";
import { budgetService } from "../../services/budgets.js";
import { dashboardRoutes } from "../../routes/dashboard.js";
import { errorHandler } from "../../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping dashboard summary consistency regression tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function monthStartUtc(now = new Date()): Date {
  return getUtcMonthStart(now);
}

function uniquePrefix(): string {
  return `T${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("dashboard summary consistency regression (issue #123)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dashboard-consistency-");
    db = createDb(tempDb.connectionString);
  }, 90_000);

  afterEach(async () => {
    vi.useRealTimers();
    await db.delete(costEvents);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
      next();
    });
    app.use("/api", dashboardRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("keeps dashboard summary internally consistent with agents, issues, approvals, and cost events", async () => {
    // Pin the clock mid-month so a UTC month rollover during the run cannot
    // split the expected spend and the service's month window. Only Date is
    // faked, so the database and HTTP timers still run normally.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));

    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const budgetMonthlyCents = 100_000;

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Consistency Co",
        issuePrefix: uniquePrefix(),
        requireBoardApprovalForNewAgents: false,
        budgetMonthlyCents,
      },
      {
        id: otherCompanyId,
        name: "Other Co",
        issuePrefix: uniquePrefix(),
        requireBoardApprovalForNewAgents: false,
        budgetMonthlyCents,
      },
    ]);

    // Representative agent mix. "idle" counts as "active" in the summary.
    const agentSeeds: Array<{ id: string; companyId: string; status: string; name: string }> = [
      { id: randomUUID(), companyId, status: "active", name: "Active One" },
      { id: randomUUID(), companyId, status: "active", name: "Active Two" },
      { id: randomUUID(), companyId, status: "idle", name: "Idle Counts As Active" },
      { id: randomUUID(), companyId, status: "running", name: "Runner" },
      { id: randomUUID(), companyId, status: "paused", name: "Paused" },
      { id: randomUUID(), companyId, status: "error", name: "Errored" },
    ];
    const otherAgentId = randomUUID();
    await db.insert(agents).values([
      ...agentSeeds.map((a) => ({
        id: a.id,
        companyId: a.companyId,
        name: a.name,
        role: "engineer",
        status: a.status,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "Other Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    // Representative task mix plus rows the summary must exclude:
    // hidden, harness, and other-company issues, plus an old ("stale") open task
    // that must still count because the summary has no age filter.
    const staleDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const issueSeeds: Array<{ status: string; extra?: Record<string, unknown> }> = [
      { status: "todo" },
      { status: "todo" },
      { status: "todo", extra: { createdAt: staleDate, updatedAt: staleDate } },
      { status: "in_progress" },
      { status: "blocked" },
      { status: "blocked", extra: { updatedAt: staleDate } },
      { status: "in_review" },
      { status: "backlog" },
      { status: "done" },
      { status: "done" },
      { status: "cancelled" },
    ];
    let issueCounter = 0;
    await db.insert(issues).values(
      issueSeeds.map((seed) => {
        issueCounter += 1;
        return {
          id: randomUUID(),
          companyId,
          title: `Task ${issueCounter} (${seed.status})`,
          status: seed.status,
          priority: "medium",
          issueNumber: issueCounter,
          identifier: `CST-${issueCounter}-${companyId.slice(0, 4)}`,
          ...(seed.extra ?? {}),
        };
      }),
    );
    // Excluded rows: hidden, harness container, and another company's task.
    await db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "Hidden task",
        status: "todo",
        priority: "medium",
        issueNumber: 900,
        identifier: `CST-HID-${companyId.slice(0, 4)}`,
        hiddenAt: new Date(),
      },
      {
        id: randomUUID(),
        companyId,
        title: "Harness container",
        status: "todo",
        priority: "medium",
        issueNumber: 901,
        identifier: `CST-HAR-${companyId.slice(0, 4)}`,
        harnessKind: "skill_test",
        workMode: "skill_test",
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        title: "Other company task",
        status: "todo",
        priority: "medium",
        issueNumber: 1,
        identifier: `OCT-1-${otherCompanyId.slice(0, 4)}`,
      },
    ]);

    await db.insert(approvals).values([
      {
        id: randomUUID(),
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: {},
      },
      {
        id: randomUUID(),
        companyId,
        type: "hire_agent",
        status: "pending",
        payload: {},
      },
      {
        id: randomUUID(),
        companyId,
        type: "hire_agent",
        status: "approved",
        payload: {},
      },
      {
        id: randomUUID(),
        companyId,
        type: "hire_agent",
        status: "rejected",
        payload: {},
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        type: "hire_agent",
        status: "pending",
        payload: {},
      },
    ]);

    // Month spend: only events on/after the UTC month start count.
    const now = new Date();
    const start = monthStartUtc(now);
    const inMonth = [
      { costCents: 1000, occurredAt: now },
      { costCents: 2500, occurredAt: now },
      { costCents: 1500, occurredAt: start },
    ];
    const outOfMonth = new Date(start.getTime() - 24 * 60 * 60 * 1000);
    const costAgentId = agentSeeds[0]!.id;
    await db.insert(costEvents).values([
      ...inMonth.map((e) => ({
        id: randomUUID(),
        companyId,
        agentId: costAgentId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        costCents: e.costCents,
        occurredAt: e.occurredAt,
      })),
      {
        id: randomUUID(),
        companyId,
        agentId: costAgentId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        costCents: 9999,
        occurredAt: outOfMonth,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        costCents: 7777,
        occurredAt: now,
      },
    ]);

    const expectedMonthSpend = inMonth.reduce((sum, e) => sum + e.costCents, 0);
    const expectedUtilization = Number(((expectedMonthSpend / budgetMonthlyCents) * 100).toFixed(2));

    // Real service path.
    const summary = await dashboardService(db).summary(companyId);

    // Agents: idle folds into active; other-company agents are excluded.
    expect(summary.agents).toEqual({
      active: 3,
      running: 1,
      paused: 1,
      error: 1,
    });

    // Tasks: backlog/todo/in_progress/in_review/blocked feed "open";
    // only "done" feeds "done"; "cancelled" feeds neither. Hidden, harness,
    // and other-company rows are excluded by the execution-issue filter.
    // Seeds: todo*3 + in_progress + blocked*2 + in_review + backlog = 8 open.
    expect(summary.tasks).toMatchObject({
      open: 8,
      inProgress: 1,
      blocked: 2,
      done: 2,
    });

    // Approvals: only pending rows in this company count.
    expect(summary.pendingApprovals).toBe(2);

    // Costs: month spend derives from in-month cost events; utilization
    // derives from month spend and the company budget.
    expect(summary.costs.monthSpendCents).toBe(expectedMonthSpend);
    expect(summary.costs.monthBudgetCents).toBe(budgetMonthlyCents);
    expect(summary.costs.monthUtilizationPercent).toBe(expectedUtilization);

    // Cross-check against independent queries over the same tables.
    const [spendRow] = await db
      .select({
        total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, start)));
    expect(Number(spendRow?.total ?? 0)).toBe(summary.costs.monthSpendCents);

    const [pendingRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")));
    expect(Number(pendingRow?.count ?? 0)).toBe(summary.pendingApprovals);

    // Budgets overview stays consistent with the summary rollup. With no budget
    // policies seeded, the budget rollup is empty: this is distinct from the
    // generic approvals table and the agent paused status above.
    const overview = await budgetService(db).overview(companyId);
    expect(summary.budgets.activeIncidents).toBe(overview.activeIncidents.length);
    expect(summary.budgets.pendingApprovals).toBe(overview.pendingApprovalCount);
    expect(summary.budgets.pausedAgents).toBe(overview.pausedAgentCount);
    expect(summary.budgets.pausedProjects).toBe(overview.pausedProjectCount);
    expect(summary.budgets).toMatchObject({
      activeIncidents: 0,
      pendingApprovals: 0,
      pausedAgents: 0,
      pausedProjects: 0,
    });

    // Real route path returns the same consistent summary.
    const app = createApp();
    const res = await request(app).get(`/api/companies/${companyId}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual(summary.agents);
    expect(res.body.tasks).toEqual(summary.tasks);
    expect(res.body.costs).toEqual(summary.costs);
    expect(res.body.pendingApprovals).toBe(summary.pendingApprovals);
    expect(res.body.budgets).toEqual(summary.budgets);
    expect(res.body.companyId).toBe(companyId);
  });
});
