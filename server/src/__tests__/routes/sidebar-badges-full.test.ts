import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sidebarBadgeRoutes } from "../../routes/sidebar-badges.js";
import { errorHandler } from "../../middleware/index.js";

const mockBadgeService = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockDashboardService = vi.hoisted(() => ({
  summary: vi.fn(),
}));

vi.mock("../../services/sidebar-badges.js", () => ({
  sidebarBadgeService: () => mockBadgeService,
}));

vi.mock("../../services/access.js", () => ({
  accessService: () => mockAccessService,
}));

vi.mock("../../services/dashboard.js", () => ({
  dashboardService: () => mockDashboardService,
}));

function createApp(actorOverrides: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
      ...actorOverrides,
    };
    next();
  });

  // Create a mock db that allows the direct query chain for join request count
  const fakeDb = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockImplementation((cb: any) => cb([{ count: 0 }])),
        }),
      }),
    }),
  };

  app.use("/api", sidebarBadgeRoutes(fakeDb as any));
  app.use(errorHandler);
  return app;
}

describe("sidebarBadgeRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDashboardService.summary.mockResolvedValue({
      agents: { error: 0 },
      costs: { monthBudgetCents: 1000, monthUtilizationPercent: 50 },
    });
  });

  describe("GET /companies/:companyId/sidebar-badges", () => {
    it("returns badge counts for board user with joins:approve", async () => {
      mockAccessService.canUser.mockResolvedValue(true);
      mockBadgeService.get.mockResolvedValue({
        failedRuns: 1,
        approvals: 2,
        inbox: 0,
      });
      const res = await request(createApp()).get("/api/companies/company-1/sidebar-badges");
      expect(res.status).toBe(200);
      expect(res.body.failedRuns).toBe(1);
      expect(res.body.approvals).toBe(2);
    });

    it("returns zero join requests when user lacks joins:approve", async () => {
      mockAccessService.canUser.mockResolvedValue(false);
      mockBadgeService.get.mockResolvedValue({
        failedRuns: 0,
        approvals: 0,
        inbox: 0,
      });
      const res = await request(createApp()).get("/api/companies/company-1/sidebar-badges");
      expect(res.status).toBe(200);
      // joinRequestCount passed as 0 since canApproveJoins is false
      expect(mockBadgeService.get).toHaveBeenCalledWith("company-1", { joinRequests: 0 });
    });

    it("returns 403 for wrong company", async () => {
      const res = await request(createApp()).get("/api/companies/other-company/sidebar-badges");
      expect(res.status).toBe(403);
    });

    it("checks agent permission for agent actors", async () => {
      mockAccessService.hasPermission.mockResolvedValue({ granted: true });
      mockBadgeService.get.mockResolvedValue({
        failedRuns: 0,
        approvals: 0,
        inbox: 0,
      });
      const res = await request(createApp({
        type: "agent", agentId: "agent-1", companyId: "company-1",
      })).get("/api/companies/company-1/sidebar-badges");
      expect(res.status).toBe(200);
      expect(mockAccessService.hasPermission).toHaveBeenCalledWith(
        "company-1", "agent", "agent-1", "joins:approve",
      );
    });
  });
});
