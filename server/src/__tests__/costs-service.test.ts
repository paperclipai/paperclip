import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createDb,
  companies,
  agents,
  activityLog,
  costEvents,
  financeEvents,
  heartbeatRuns,
  issues,
  projects,
  routines,
  routineRuns,
} from "@paperclipai/db";
import { costService } from "../services/costs.ts";
import { financeService } from "../services/finance.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

function makeDb(overrides: Record<string, unknown> = {}) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue([]),
  };

  const thenableChain = Object.assign(Promise.resolve([]), selectChain);

  return {
    select: vi.fn().mockReturnValue(thenableChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    ...overrides,
  };
}

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  cancelBudgetScopeWork: vi.fn().mockResolvedValue(undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFetchAllQuotaWindows = vi.hoisted(() => vi.fn());
const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ spendCents: 0 }),
  byAgent: vi.fn().mockResolvedValue([]),
  byAgentModel: vi.fn().mockResolvedValue([]),
  byProvider: vi.fn().mockResolvedValue([]),
  byBiller: vi.fn().mockResolvedValue([]),
  issueTreeSummary: vi.fn().mockResolvedValue({
    issueId: "issue-1",
    issueCount: 1,
    includeDescendants: true,
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    runCount: 0,
    runtimeMs: 0,
  }),
  windowSpend: vi.fn().mockResolvedValue([]),
  byProject: vi.fn().mockResolvedValue([]),
}));
const mockFinanceService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ debitCents: 0, creditCents: 0, netCents: 0, estimatedDebitCents: 0, eventCount: 0 }),
  byBiller: vi.fn().mockResolvedValue([]),
  byKind: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([]),
}));
const mockBudgetService = vi.hoisted(() => ({
  overview: vi.fn().mockResolvedValue({
    companyId: "company-1",
    policies: [],
    activeIncidents: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
    pendingApprovalCount: 0,
  }),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    budgetService: () => mockBudgetService,
    costService: () => mockCostService,
    financeService: () => mockFinanceService,
    companyService: () => mockCompanyService,
    agentService: () => mockAgentService,
    issueService: () => mockIssueService,
    heartbeatService: () => mockHeartbeatService,
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/quota-windows.js", () => ({
    fetchAllQuotaWindows: mockFetchAllQuotaWindows,
  }));
}

describe("cost routes", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [costsRouteModule, middlewareModule] = await Promise.all([
      vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    return { ...costsRouteModule, errorHandler: middlewareModule.errorHandler };
  });

  function createApp() {
    const { costRoutes, errorHandler } = routeModules.value;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
      next();
    });
    app.use("/api", costRoutes(makeDb() as any));
    app.use(errorHandler);
    return app;
  }

  function createAppWithActor(actor: any) {
    const { costRoutes, errorHandler } = routeModules.value;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", costRoutes(makeDb() as any));
    app.use(errorHandler);
    return app;
  }

  function loadCostParsers() {
    const { parseCostDateRange, parseCostLimit } = routeModules.value;
    return { parseCostDateRange, parseCostLimit };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockCompanyService.update.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      budgetMonthlyCents: 100,
      spentMonthlyCents: 0,
    });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      name: "Budget Agent",
      budgetMonthlyCents: 100,
      spentMonthlyCents: 0,
    });
    mockAgentService.update.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      name: "Budget Agent",
      budgetMonthlyCents: 100,
      spentMonthlyCents: 0,
    });
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PC1A2-1",
    });
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PC1A2-1",
    });
    mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
  });

  it("accepts valid ISO date strings", async () => {
    const { parseCostDateRange } = loadCostParsers();
    expect(parseCostDateRange({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T23:59:59.999Z",
    })).toEqual({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-31T23:59:59.999Z"),
    });
  });

  it("returns 400 for an invalid 'from' date string", async () => {
    const { parseCostDateRange } = loadCostParsers();
    expect(() => parseCostDateRange({ from: "not-a-date" })).toThrow(/invalid 'from' date/i);
  });

  it("returns 400 for an invalid 'to' date string", async () => {
    const { parseCostDateRange } = loadCostParsers();
    expect(() => parseCostDateRange({ to: "banana" })).toThrow(/invalid 'to' date/i);
  });

  it("returns finance summary rows for valid requests", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/finance-summary")
      .query({ from: "2026-02-01T00:00:00.000Z", to: "2026-02-28T23:59:59.999Z" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
  });

  it("returns issue subtree cost summaries for issue refs", async () => {
    const app = createApp();
    const res = await request(app).get("/api/issues/pc1a2-1/cost-summary");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PC1A2-1");
    expect(mockCostService.issueTreeSummary).toHaveBeenCalledWith("company-1", "issue-1", {
      excludeRoot: false,
    });
    expect(res.body).toEqual({
      issueId: "issue-1",
      issueCount: 1,
      includeDescendants: true,
      costCents: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      runCount: 0,
      runtimeMs: 0,
    });
  });

  it("returns 400 for invalid finance event list limits", async () => {
    const { parseCostLimit } = loadCostParsers();
    expect(() => parseCostLimit({ limit: "0" })).toThrow(/invalid 'limit'/i);
  });

  it("accepts valid finance event list limits", async () => {
    const { parseCostLimit } = loadCostParsers();
    expect(parseCostLimit({ limit: "25" })).toBe(25);
  });

  it("rejects company budget updates for board users outside the company", async () => {
    const app = createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/companies/company-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates for board users outside the agent company", async () => {
    const app = createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates from the target agent without changing the budget policy", async () => {
    const app = createAppWithActor({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates from another same-company agent without changing the budget policy", async () => {
    const app = createAppWithActor({
      type: "agent",
      agentId: "agent-2",
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("allows authorized board users to update an agent budget and budget policy", async () => {
    mockAgentService.update.mockResolvedValueOnce({
      id: "agent-1",
      companyId: "company-1",
      name: "Budget Agent",
      budgetMonthlyCents: 2500,
      spentMonthlyCents: 0,
    });
    const app = createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith("agent-1", { budgetMonthlyCents: 2500 });
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
      "company-1",
      {
        scopeType: "agent",
        scopeId: "agent-1",
        amount: 2500,
        windowKind: "calendar_month_utc",
      },
      "board-user",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "board-user",
        agentId: null,
        action: "agent.budget_updated",
        entityType: "agent",
        entityId: "agent-1",
        details: { budgetMonthlyCents: 2500 },
      }),
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cost and finance aggregate overflow handling", () => {
  let db!: ReturnType<typeof createDb>;
  let costs!: ReturnType<typeof costService>;
  let finance!: ReturnType<typeof financeService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-costs-service-");
    db = createDb(tempDb.connectionString);
    costs = costService(db);
    finance = financeService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists unpriced token usage without inflating monthly spend", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CLI Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const event = await costs.createEvent(companyId, {
      agentId,
      provider: "openai",
      biller: "chatgpt",
      billingType: "subscription_included",
      costStatus: "unpriced",
      model: "gpt-5.6-terra",
      inputTokens: 2_732_577,
      cachedInputTokens: 2_632_998,
      outputTokens: 32_644,
      costCents: 0,
      occurredAt: new Date("2026-07-13T14:22:54.000Z"),
    });

    expect(event.costStatus).toBe("unpriced");
    expect(event.inputTokens).toBe(2_732_577);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agent?.spentMonthlyCents).toBe(0);
  });

  it("aggregates cost event sums above int32 without raising Postgres integer overflow", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Overflow Project",
      status: "active",
    });

    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 2_000_000_000,
        cachedInputTokens: 0,
        outputTokens: 200_000_000,
        costCents: 2_000_000_000,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 2_000_000_000,
        cachedInputTokens: 10,
        outputTokens: 200_000_000,
        costCents: 2_000_000_000,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const [byAgentRow] = await costs.byAgent(companyId, range);
    const [byProjectRow] = await costs.byProject(companyId, range);
    const [byAgentModelRow] = await costs.byAgentModel(companyId, range);

    expect(byAgentRow?.costCents).toBe(4_000_000_000);
    expect(byAgentRow?.inputTokens).toBe(4_000_000_000);
    expect(byProjectRow?.costCents).toBe(4_000_000_000);
    expect(byAgentModelRow?.costCents).toBe(4_000_000_000);
  });

  it("aggregates issue costs across recursive descendants only", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const harnessIssueId = randomUUID();
    const siblingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
      {
        id: grandchildIssueId,
        companyId,
        parentId: childIssueId,
        title: "Grandchild",
        status: "done",
        priority: "medium",
        issueNumber: 3,
        identifier: "TST-3",
      },
      {
        id: harnessIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Hidden skill test harness",
        status: "done",
        priority: "medium",
        issueNumber: 5,
        identifier: "TST-5",
        workMode: "skill_test",
        harnessKind: "skill_test",
      },
      {
        id: siblingIssueId,
        companyId,
        title: "Sibling",
        status: "done",
        priority: "medium",
        issueNumber: 4,
        identifier: "TST-4",
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: rootIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 2,
        costCents: 100,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 20,
        cachedInputTokens: 2,
        outputTokens: 4,
        costCents: 200,
        occurredAt: new Date("2026-04-10T00:01:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: grandchildIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 30,
        cachedInputTokens: 3,
        outputTokens: 6,
        costCents: 300,
        occurredAt: new Date("2026-04-10T00:02:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: siblingIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 40,
        cachedInputTokens: 4,
        outputTokens: 8,
        costCents: 400,
        occurredAt: new Date("2026-04-10T00:03:00.000Z"),
      },
    ]);

    const summary = await costs.issueTreeSummary(companyId, rootIssueId);

    expect(summary).toEqual({
      issueId: rootIssueId,
      issueCount: 3,
      includeDescendants: true,
      costCents: 600,
      inputTokens: 60,
      cachedInputTokens: 6,
      outputTokens: 12,
      runCount: 0,
      runtimeMs: 0,
    });
  });

  it("aggregates run wall-clock duration across the recursive issue tree", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const harnessIssueId = randomUUID();
    const siblingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Run Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child",
        status: "in_progress",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
      {
        id: grandchildIssueId,
        companyId,
        parentId: childIssueId,
        title: "Grandchild",
        status: "done",
        priority: "medium",
        issueNumber: 3,
        identifier: "TST-3",
      },
      {
        id: siblingIssueId,
        companyId,
        title: "Sibling",
        status: "done",
        priority: "medium",
        issueNumber: 4,
        identifier: "TST-4",
      },
      {
        id: harnessIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Harness child",
        status: "done",
        priority: "medium",
        workMode: "skill_test",
        harnessKind: "skill_test",
        issueNumber: 5,
        identifier: "TST-5",
      },
    ]);

    const linkedViaContextRunId = randomUUID();
    const linkedViaActivityRunId = randomUUID();
    const grandchildRunId = randomUUID();
    const harnessRunId = randomUUID();
    const siblingRunId = randomUUID();
    const livePartialRunId = randomUUID();

    await db.insert(heartbeatRuns).values([
      // 60s run linked to root via contextSnapshot.issueId
      {
        id: linkedViaContextRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:00:00.000Z"),
        finishedAt: new Date("2026-04-10T00:01:00.000Z"),
        contextSnapshot: { issueId: rootIssueId },
      },
      // 120s run linked to child via activity_log
      {
        id: linkedViaActivityRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:05:00.000Z"),
        finishedAt: new Date("2026-04-10T00:07:00.000Z"),
      },
      // 30s run linked to grandchild
      {
        id: grandchildRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:10:00.000Z"),
        finishedAt: new Date("2026-04-10T00:10:30.000Z"),
        contextSnapshot: { issueId: grandchildIssueId },
      },
      // 45s harness run under root - should be excluded from visible issue tree rollups
      {
        id: harnessRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:15:00.000Z"),
        finishedAt: new Date("2026-04-10T00:15:45.000Z"),
        contextSnapshot: { issueId: harnessIssueId },
      },
      // sibling run NOT under root – should be excluded
      {
        id: siblingRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "completed",
        startedAt: new Date("2026-04-10T00:20:00.000Z"),
        finishedAt: new Date("2026-04-10T00:21:00.000Z"),
        contextSnapshot: { issueId: siblingIssueId },
      },
      // Still-running run on child (no finishedAt) – should contribute (now - startedAt)
      {
        id: livePartialRunId,
        companyId,
        agentId,
        invocationSource: "on_demand",
        status: "running",
        startedAt: new Date(Date.now() - 5_000),
        contextSnapshot: { issueId: childIssueId },
      },
    ]);

    await db.insert(activityLog).values({
      companyId,
      runId: linkedViaActivityRunId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: childIssueId,
      details: {},
    });

    const summary = await costs.issueTreeSummary(companyId, rootIssueId);

    expect(summary.issueCount).toBe(3);
    // 3 finished runs in tree (root, child via activity, grandchild) + 1 live run
    expect(summary.runCount).toBe(4);
    // 60s + 120s + 30s = 210s = 210_000ms from finished runs.
    // Live run adds ~5_000ms; allow some slack so the assertion isn't flaky.
    expect(summary.runtimeMs).toBeGreaterThanOrEqual(210_000 + 4_000);
    expect(summary.runtimeMs).toBeLessThan(210_000 + 60_000);

    // excludeRoot drops the root issue's own runs (the 60s contextSnapshot run)
    // while keeping the child + grandchild runs and any live child run.
    const descendantsOnly = await costs.issueTreeSummary(companyId, rootIssueId, {
      excludeRoot: true,
    });
    expect(descendantsOnly.issueCount).toBe(2);
    expect(descendantsOnly.runCount).toBe(3);
    // 120s + 30s = 150s + ~5s live run
    expect(descendantsOnly.runtimeMs).toBeGreaterThanOrEqual(150_000 + 4_000);
    expect(descendantsOnly.runtimeMs).toBeLessThan(150_000 + 60_000);
  });

  it("aggregates finance event sums above int32 without raising Postgres integer overflow", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(financeEvents).values([
      {
        companyId,
        biller: "openai",
        eventKind: "invoice",
        amountCents: 2_000_000_000,
        currency: "USD",
        direction: "debit",
        estimated: false,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        biller: "openai",
        eventKind: "invoice",
        amountCents: 2_000_000_000,
        currency: "USD",
        direction: "debit",
        estimated: true,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const summary = await finance.summary(companyId, range);
    const [byKindRow] = await finance.byKind(companyId, range);

    expect(summary.debitCents).toBe(4_000_000_000);
    expect(summary.estimatedDebitCents).toBe(2_000_000_000);
    expect(byKindRow?.debitCents).toBe(4_000_000_000);
    expect(byKindRow?.netCents).toBe(4_000_000_000);
  });

  /**
   * The scenario that made per-task numbers untrustworthy: one run touches many
   * issues, and `GET /issues/{id}/runs` hands the full usage to each of them.
   * Summing that way inflated the company total by 87%. These tests assert the
   * property that failure violates — per-issue rows must sum to the company
   * total, not to a multiple of it.
   */
  it("attributes a multi-issue run to one owner so per-issue tokens sum to the company total", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerIssueId = randomUUID();
    const touchedIssueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: ownerIssueId,
        companyId,
        title: "Owner",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: touchedIssueId,
        companyId,
        title: "Merely touched",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
    ]);

    // One run, owned by TST-1, that also wrote to TST-2. The activity_log rows
    // are what make the run *appear* under both issues.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "succeeded",
      startedAt: new Date("2026-04-10T00:00:00.000Z"),
      finishedAt: new Date("2026-04-10T00:10:00.000Z"),
      contextSnapshot: { issueId: ownerIssueId },
      usageJson: { costUsd: 3.5, billingType: "subscription_included" },
    });
    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "issue.updated",
        entityType: "issue",
        entityId: ownerIssueId,
        runId,
      },
      {
        companyId,
        actorType: "agent",
        actorId: agentId,
        action: "issue.commented",
        entityType: "issue",
        entityId: touchedIssueId,
        runId,
      },
    ]);

    // Subscription usage: real tokens, zero billed cents. Exactly the shape
    // that made the cost panel read $0 while the account burned its quota.
    await db.insert(costEvents).values({
      companyId,
      agentId,
      issueId: ownerIssueId,
      heartbeatRunId: runId,
      provider: "anthropic",
      biller: "claude",
      billingType: "subscription_included",
      costStatus: "unpriced",
      model: "claude-opus-5",
      inputTokens: 1_000,
      cachedInputTokens: 10_000,
      outputTokens: 100,
      costCents: 0,
      occurredAt: new Date("2026-04-10T00:10:00.000Z"),
    });

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const byIssue = await costService(db).byIssue(companyId, range);
    const summary = await costService(db).summary(companyId, range);

    // The run is charged once, to its owner — not to both issues it touched.
    expect(byIssue).toHaveLength(1);
    expect(byIssue[0]?.issueIdentifier).toBe("TST-1");
    expect(byIssue[0]?.totalTokens).toBe(11_100);
    expect(byIssue[0]?.runCount).toBe(1);

    // The conservation property the acceptance criterion turns on.
    const summedOverIssues = byIssue.reduce((acc, row) => acc + Number(row.totalTokens), 0);
    expect(summedOverIssues).toBe(summary.totalTokens);

    // Subscription dollars are visible even though billed cents are zero.
    expect(summary.spendCents).toBe(0);
    expect(summary.subscriptionCostUsd).toBeCloseTo(3.5, 5);
    expect(byIssue[0]?.subscriptionCostUsd).toBeCloseTo(3.5, 5);
  });

  it("counts runs that recorded no usage instead of silently under-reporting", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // A run whose process was lost mid-flight: the model worked, the usage was
    // never persisted. It burned real tokens and wrote no cost event, so it
    // must be counted, not silently dropped.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      errorCode: "process_lost",
      startedAt: new Date("2026-04-10T00:00:00.000Z"),
      finishedAt: new Date("2026-04-10T00:05:00.000Z"),
      usageJson: null,
    });

    const summary = await costService(db).summary(companyId, {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    });

    expect(summary.unmeteredRunCount).toBe(1);
    expect(summary.lostRunCount).toBe(1);
    expect(summary.totalTokens).toBe(0);
  });

  it("does not report a run that died before the model ran as lost consumption", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // The ACP session never completed `session/new`, so no prompt reached the
    // model. This run is a true zero — counting it as missing consumption is
    // what made the gap look ~9x larger than it is.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      errorCode: "acpx_session_init_failed",
      startedAt: new Date("2026-04-10T00:00:00.000Z"),
      finishedAt: new Date("2026-04-10T00:05:00.000Z"),
      usageJson: null,
    });

    const summary = await costService(db).summary(companyId, {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    });

    expect(summary.unmeteredRunCount).toBe(1);
    expect(summary.neverRanRunCount).toBe(1);
    // The number that says "the totals are a floor" must stay clean.
    expect(summary.lostRunCount).toBe(0);
  });

  // A `succeeded` status is not proof that the run accounted for itself. On the
  // live company database (2026-09-08) 8 of 1.478 succeeded runs carry no
  // `usage_json`: usage and `result_json` are written by one guarded update that
  // is skipped when the run already left `running`, so both are missing on
  // exactly the same rows. Classifying by status would file these as fine and
  // hide real consumption, so the gap must key off `error_code` only.
  it("counts a succeeded run that never persisted usage as lost consumption", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      status: "succeeded",
      // The shape observed live: no error code to excuse it, and the whole
      // finalization write (usage and result alike) never landed.
      errorCode: null,
      startedAt: new Date("2026-04-10T00:00:00.000Z"),
      finishedAt: new Date("2026-04-10T00:05:00.000Z"),
      usageJson: null,
      resultJson: null,
    });

    const summary = await costService(db).summary(companyId, {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    });

    expect(summary.unmeteredRunCount).toBe(1);
    expect(summary.lostRunCount).toBe(1);
    // It must not be excused as "never reached the model" just for succeeding.
    expect(summary.neverRanRunCount).toBe(0);
  });

  // `cancelled` is written by `cancelActiveForAgentInternal`, which terminates a
  // child process that is already running, so the run can be cancelled mid-turn
  // after the provider has billed the tokens. Live data (2026-09-08): of 28 such
  // runs 15 recorded `process_started_at` and 26 emitted output (median
  // `last_output_seq` 120, max 645, versus max 4 for the pre-dispatch
  // `acpx_session_*` codes), and one `cancelled` run carries `usage_json` with
  // 4.57M tokens. Excusing the code as "never reached the model" therefore
  // deleted real consumption from the declared gap.
  it("counts a cancelled run that was killed mid-turn as lost consumption", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "automation",
      status: "cancelled",
      errorCode: "cancelled",
      // The live shape: the child process was up and streaming when the cancel
      // landed, which is exactly why the tokens were already spent.
      startedAt: new Date("2026-04-10T00:00:00.000Z"),
      processStartedAt: new Date("2026-04-10T00:00:04.000Z"),
      finishedAt: new Date("2026-04-10T00:05:34.000Z"),
      lastOutputAt: new Date("2026-04-10T00:05:30.000Z"),
      lastOutputSeq: 405,
      usageJson: null,
    });

    const summary = await costService(db).summary(companyId, {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    });

    expect(summary.unmeteredRunCount).toBe(1);
    expect(summary.lostRunCount).toBe(1);
    // Being cancelled is not evidence that no prompt reached the model.
    expect(summary.neverRanRunCount).toBe(0);
  });

  it("reports usage measured on a run but never aggregated as stranded, not lost", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // The adapter failed but still reported usage. The tokens are recorded on the
    // run and absent from cost_events, so every endpoint that aggregates cost
    // events silently omits them. That is recoverable, not a blind spot.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-04-10T00:00:00.000Z"),
      finishedAt: new Date("2026-04-10T00:05:00.000Z"),
      usageJson: { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 300 },
    });

    const summary = await costService(db).summary(companyId, {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    });

    expect(summary.unmeteredRunCount).toBe(1);
    expect(summary.strandedRunCount).toBe(1);
    expect(summary.strandedTokens).toBe(1500);
    // It was measured, so it is neither a true zero nor an unknown.
    expect(summary.neverRanRunCount).toBe(0);
    expect(summary.lostRunCount).toBe(0);
  });

  it("rolls every firing of a routine up to the routine, including child issues", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const firingOneIssueId = randomUUID();
    const firingTwoIssueId = randomUUID();
    const childOfFiringTwoId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Triage Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Triagem de Slack",
      assigneeAgentId: agentId,
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: firingOneIssueId,
        companyId,
        title: "Triagem 2026-04-10",
        status: "done",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: firingTwoIssueId,
        companyId,
        title: "Triagem 2026-04-11",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
      {
        id: childOfFiringTwoId,
        companyId,
        parentId: firingTwoIssueId,
        title: "Follow-up spawned by the firing",
        status: "done",
        priority: "medium",
        issueNumber: 3,
        identifier: "TST-3",
      },
    ]);
    await db.insert(routineRuns).values([
      {
        companyId,
        routineId,
        source: "schedule",
        status: "completed",
        linkedIssueId: firingOneIssueId,
      },
      {
        companyId,
        routineId,
        source: "schedule",
        status: "completed",
        linkedIssueId: firingTwoIssueId,
      },
    ]);

    const baseEvent = {
      companyId,
      agentId,
      provider: "anthropic",
      biller: "claude",
      billingType: "subscription_included" as const,
      model: "claude-haiku-4-5",
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 0,
    };
    await db.insert(costEvents).values([
      {
        ...baseEvent,
        issueId: firingOneIssueId,
        heartbeatRunId: null,
        inputTokens: 100,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        ...baseEvent,
        issueId: firingTwoIssueId,
        heartbeatRunId: null,
        inputTokens: 200,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
      {
        ...baseEvent,
        issueId: childOfFiringTwoId,
        heartbeatRunId: null,
        inputTokens: 400,
        occurredAt: new Date("2026-04-11T00:05:00.000Z"),
      },
    ]);

    const rows = await costService(db).byRoutine(companyId, {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.routineTitle).toBe("Triagem de Slack");
    // Both firings plus the child issue spawned by the second one.
    expect(Number(rows[0]?.totalTokens)).toBe(700);
    expect(Number(rows[0]?.issueCount)).toBe(3);
  });

  // A run is claimed (`startedAt`) long before it finalizes, and the cost event
  // is written only at finalization. Counting by start time therefore reported
  // every run currently in flight as consumption that was lost.
  it("does not report a still-running run as lost consumption", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      startedAt: new Date("2026-04-10T00:00:00.000Z"),
      finishedAt: null,
      usageJson: null,
    });

    const summary = await costService(db).summary(companyId, {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    });

    expect(summary.unmeteredRunCount).toBe(0);
    expect(summary.lostRunCount).toBe(0);
  });

  // The gap count is windowed on finalization so it lines up with
  // `cost_events.occurred_at`. A run that starts before the window and finishes
  // inside it belongs to the window its ledger event would have landed in.
  it("windows unmetered runs on finalization, not on start", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Started 31 Mar, finished 1 Apr: the ledger would have dated it 1 Apr.
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "failed",
      errorCode: "process_lost",
      startedAt: new Date("2026-03-31T23:50:00.000Z"),
      finishedAt: new Date("2026-04-01T00:10:00.000Z"),
      usageJson: null,
    });

    const inWindow = await costService(db).summary(companyId, {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    });
    expect(inWindow.lostRunCount).toBe(1);

    const previousWindow = await costService(db).summary(companyId, {
      from: new Date("2026-03-01T00:00:00.000Z"),
      to: new Date("2026-03-31T23:59:59.999Z"),
    });
    expect(previousWindow.lostRunCount).toBe(0);
  });

  // Nothing forbids parenting a routine firing to another routine's firing, and
  // when that happened the nested subtree was summed into both routine rows, so
  // the routine totals could exceed the company total.
  it("does not count a nested routine firing against both routines", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const outerRoutineId = randomUUID();
    const innerRoutineId = randomUUID();
    const outerFiringIssueId = randomUUID();
    const innerFiringIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Triage Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(routines).values([
      {
        id: outerRoutineId,
        companyId,
        title: "Rotina externa",
        assigneeAgentId: agentId,
        status: "active",
      },
      {
        id: innerRoutineId,
        companyId,
        title: "Rotina aninhada",
        assigneeAgentId: agentId,
        status: "active",
      },
    ]);
    await db.insert(issues).values([
      {
        id: outerFiringIssueId,
        companyId,
        title: "Disparo externo",
        status: "done",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: innerFiringIssueId,
        companyId,
        // The nested firing hangs off the outer firing's issue.
        parentId: outerFiringIssueId,
        title: "Disparo aninhado",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
    ]);
    await db.insert(routineRuns).values([
      {
        companyId,
        routineId: outerRoutineId,
        source: "schedule",
        status: "completed",
        linkedIssueId: outerFiringIssueId,
      },
      {
        companyId,
        routineId: innerRoutineId,
        source: "schedule",
        status: "completed",
        linkedIssueId: innerFiringIssueId,
      },
    ]);

    const baseEvent = {
      companyId,
      agentId,
      provider: "anthropic",
      biller: "claude",
      billingType: "subscription_included" as const,
      model: "claude-haiku-4-5",
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      heartbeatRunId: null,
    };
    await db.insert(costEvents).values([
      {
        ...baseEvent,
        issueId: outerFiringIssueId,
        inputTokens: 100,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        ...baseEvent,
        issueId: innerFiringIssueId,
        inputTokens: 400,
        occurredAt: new Date("2026-04-10T00:05:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };
    const rows = await costService(db).byRoutine(companyId, range);
    const summary = await costService(db).summary(companyId, range);

    const outer = rows.find((row) => row.routineId === outerRoutineId);
    const inner = rows.find((row) => row.routineId === innerRoutineId);

    // The nested firing's tokens belong to the routine that opened it, once.
    expect(Number(outer?.totalTokens)).toBe(100);
    expect(Number(inner?.totalTokens)).toBe(400);

    // The property the acceptance criterion turns on: routines cannot sum to
    // more than the company consumed.
    const summedOverRoutines = rows.reduce(
      (acc, row) => acc + Number(row.totalTokens),
      0,
    );
    expect(summedOverRoutines).toBe(summary.totalTokens);
  });

  // A firing root that was hidden, or that is harness work, is excluded from
  // `byIssue`. Counting it in the routine rollup made the two views disagree.
  it("excludes a hidden firing root from the routine rollup", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const visibleFiringId = randomUUID();
    const hiddenFiringId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Triage Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Triagem de Slack",
      assigneeAgentId: agentId,
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: visibleFiringId,
        companyId,
        title: "Disparo visivel",
        status: "done",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: hiddenFiringId,
        companyId,
        title: "Disparo oculto",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
        hiddenAt: new Date("2026-04-12T00:00:00.000Z"),
      },
    ]);
    await db.insert(routineRuns).values([
      {
        companyId,
        routineId,
        source: "schedule",
        status: "completed",
        linkedIssueId: visibleFiringId,
      },
      {
        companyId,
        routineId,
        source: "schedule",
        status: "completed",
        linkedIssueId: hiddenFiringId,
      },
    ]);

    const baseEvent = {
      companyId,
      agentId,
      provider: "anthropic",
      biller: "claude",
      billingType: "subscription_included" as const,
      model: "claude-haiku-4-5",
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      heartbeatRunId: null,
    };
    await db.insert(costEvents).values([
      {
        ...baseEvent,
        issueId: visibleFiringId,
        inputTokens: 100,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        ...baseEvent,
        issueId: hiddenFiringId,
        inputTokens: 900,
        occurredAt: new Date("2026-04-10T00:05:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };
    const rows = await costService(db).byRoutine(companyId, range);

    expect(rows).toHaveLength(1);
    // The hidden firing's 900 tokens stay out, matching `byIssue`.
    expect(Number(rows[0]?.totalTokens)).toBe(100);
    expect(Number(rows[0]?.issueCount)).toBe(1);
  });

  // `limit` is capped at 500, so without an offset a company with more
  // cost-bearing issues than the cap could never read the rows past it, and
  // summing the endpoint could not reproduce the company total.
  it("pages past the ranked cap so the rows still sum to the company total", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const issueIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issues).values(
      issueIds.map((id, index) => ({
        id,
        companyId,
        title: `Task ${index + 1}`,
        status: "done",
        priority: "medium" as const,
        issueNumber: index + 1,
        identifier: `TST-${index + 1}`,
      })),
    );

    const baseEvent = {
      companyId,
      agentId,
      provider: "anthropic",
      biller: "claude",
      billingType: "subscription_included" as const,
      model: "claude-haiku-4-5",
      cachedInputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      heartbeatRunId: null,
    };
    await db.insert(costEvents).values(
      issueIds.map((issueId, index) => ({
        ...baseEvent,
        issueId,
        inputTokens: (index + 1) * 100,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      })),
    );

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };
    const service = costService(db);
    const summary = await service.summary(companyId, range);

    // Walk the whole aggregate one page at a time.
    const firstPage = await service.byIssue(companyId, range, 2, 0);
    const secondPage = await service.byIssue(companyId, range, 2, 2);

    expect(firstPage).toHaveLength(2);
    expect(secondPage).toHaveLength(1);

    // No row is served twice and none is skipped.
    const paged = [...firstPage, ...secondPage];
    expect(new Set(paged.map((row) => row.issueId)).size).toBe(3);

    const summedOverPages = paged.reduce(
      (acc, row) => acc + Number(row.totalTokens),
      0,
    );
    expect(summedOverPages).toBe(summary.totalTokens);
  });
});
