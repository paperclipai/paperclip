import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBoardBriefService = vi.hoisted(() => ({
  build: vi.fn(),
  listHistory: vi.fn(),
  projectDashboardSummary: vi.fn(),
  projectExecutiveSummary: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardBriefService: () => mockBoardBriefService,
}));

let boardBriefRoutesFactory: typeof import("../routes/board-brief.js").boardBriefRoutes;
let errorHandlerMiddleware: typeof import("../middleware/index.js").errorHandler;

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", boardBriefRoutesFactory({} as any));
  app.use(errorHandlerMiddleware);
  return app;
}

describe("board brief routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ boardBriefRoutes: boardBriefRoutesFactory } = await import("../routes/board-brief.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
    vi.resetAllMocks();
    mockBoardBriefService.build.mockResolvedValue({
      meta: {
        companyId: "company-1",
        schemaVersion: 1,
        generatedAt: new Date("2026-04-15T12:00:00.000Z"),
        windowStart: new Date("2026-04-14T12:00:00.000Z"),
        windowEnd: new Date("2026-04-15T12:00:00.000Z"),
      },
      totals: {
        agents: { active: 1, running: 0, paused: 0, error: 0 },
        tasks: { open: 1, inProgress: 0, blocked: 0, done: 0 },
        costs: { monthSpendCents: 100, monthBudgetCents: 1_000, monthUtilizationPercent: 10 },
        budgets: { activeIncidents: 0, pendingApprovals: 0, pausedAgents: 0, pausedProjects: 0 },
        pendingApprovals: 0,
      },
      health: { tone: "healthy", reasons: [] },
      freshness: {
        execution: { status: "fresh", lastUpdatedAt: null, reason: null },
        work: { status: "fresh", lastUpdatedAt: null, reason: null },
        cost: { status: "fresh", lastUpdatedAt: null, reason: null },
        approvals: { status: "fresh", lastUpdatedAt: null, reason: null },
        outputs: { status: "fresh", lastUpdatedAt: null, reason: null },
      },
      confidence: "high",
      snapshot: {
        progress: { value: "0", label: "In flight", headline: "Quiet", detail: "None", tone: "healthy" },
        risk: { value: "0", label: "Blocked", headline: "Quiet", detail: "None", tone: "healthy" },
        decisions: { value: "0", label: "Waiting", headline: "Quiet", detail: "None", tone: "healthy" },
        spend: { value: "$1.00", label: "Spend", headline: "Quiet", detail: "None", tone: "healthy" },
        outputs: { value: "0", label: "Outputs", headline: "Quiet", detail: "None", tone: "healthy" },
      },
      focusAreas: [],
      actionQueue: [],
      incidents: [],
      outputs: [],
      manualKpis: [],
    });
    mockBoardBriefService.listHistory.mockResolvedValue([]);
  });

  it("allows board users to fetch the live board brief and history", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    await request(app).get("/api/companies/company-1/board-brief").expect(200);
    await request(app).get("/api/companies/company-1/board-brief/history").expect(200);

    expect(mockBoardBriefService.build).toHaveBeenCalledWith("company-1");
    expect(mockBoardBriefService.listHistory).toHaveBeenCalledWith("company-1", { limit: undefined, source: undefined });
  });

  it("rejects cross-company agent access", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-2",
      source: "agent_key",
      runId: "run-1",
    });

    const response = await request(app).get("/api/companies/company-1/board-brief");
    expect(response.status).toBe(403);
    expect(mockBoardBriefService.build).not.toHaveBeenCalled();
  });
});
