import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sidebarBadgeRoutes } from "../routes/sidebar-badges.js";
import { errorHandler } from "../middleware/index.js";

const mockSidebarBadgeService = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  staleCount: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockDashboardService = vi.hoisted(() => ({
  summary: vi.fn(),
}));

vi.mock("../services/sidebar-badges.js", () => ({
  sidebarBadgeService: () => mockSidebarBadgeService,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../services/dashboard.js", () => ({
  dashboardService: () => mockDashboardService,
}));

function createApp(actor: Record<string, unknown>, joinRequestCount = 0) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });

  const mockDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockImplementation((cb: (rows: unknown[]) => unknown) =>
            Promise.resolve(cb([{ count: joinRequestCount }])),
          ),
        }),
      }),
    }),
  };

  app.use("/api", sidebarBadgeRoutes(mockDb as any));
  app.use(errorHandler);
  return app;
}

function defaultSummary() {
  return {
    agents: { total: 2, running: 1, idle: 1, error: 0, terminated: 0 },
    costs: { monthBudgetCents: 1000, monthSpentCents: 100, monthUtilizationPercent: 10 },
    issues: { total: 5, open: 3, done: 2 },
  };
}

describe("GET /companies/:companyId/sidebar-badges — inbox formula", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockIssueService.staleCount.mockResolvedValue(0);
    mockDashboardService.summary.mockResolvedValue(defaultSummary());
  });

  it("includes approvals count in the inbox total", async () => {
    mockSidebarBadgeService.get.mockResolvedValue({
      inbox: 3,
      approvals: 2,
      failedRuns: 1,
      joinRequests: 0,
    });

    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/sidebar-badges");

    expect(res.status).toBe(200);
    // inbox = failedRuns(1) + alertsCount(0) + staleIssueCount(0) + joinRequestCount(0) + approvals(2) = 3
    expect(res.body.inbox).toBe(3);
    expect(res.body.approvals).toBe(2);
  });

  it("sums failedRuns, alerts, staleIssues, joinRequests, and approvals into inbox", async () => {
    mockSidebarBadgeService.get.mockResolvedValue({
      inbox: 6,
      approvals: 2,
      failedRuns: 1,
      joinRequests: 3,
    });
    mockIssueService.staleCount.mockResolvedValue(4);
    mockDashboardService.summary.mockResolvedValue({
      agents: { total: 2, running: 1, idle: 0, error: 1, terminated: 0 },
      costs: { monthBudgetCents: 1000, monthSpentCents: 900, monthUtilizationPercent: 90 },
      issues: { total: 5, open: 3, done: 2 },
    });

    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        source: "local_implicit",
      },
      3,
    );

    const res = await request(app).get("/api/companies/company-1/sidebar-badges");

    expect(res.status).toBe(200);
    // inbox = failedRuns(1) + alertsCount(1 for budget) + staleIssueCount(4) + joinRequestCount(3) + approvals(2) = 11
    expect(res.body.inbox).toBe(11);
  });

  it("does not drop approvals from the inbox count (regression test for overwrite bug)", async () => {
    mockSidebarBadgeService.get.mockResolvedValue({
      inbox: 5,
      approvals: 5,
      failedRuns: 0,
      joinRequests: 0,
    });

    const app = createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "local_implicit",
    });

    const res = await request(app).get("/api/companies/company-1/sidebar-badges");

    expect(res.status).toBe(200);
    expect(res.body.inbox).toBe(5);
    expect(res.body.approvals).toBe(5);
  });
});
