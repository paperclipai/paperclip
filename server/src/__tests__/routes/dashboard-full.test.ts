import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardRoutes } from "../../routes/dashboard.js";
import { errorHandler } from "../../middleware/index.js";

const mockDashboardService = vi.hoisted(() => ({
  summary: vi.fn(),
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
  app.use("/api", dashboardRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("dashboardRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /companies/:companyId/dashboard", () => {
    it("returns dashboard summary", async () => {
      mockDashboardService.summary.mockResolvedValue({
        agentCount: 3,
        issueCount: 10,
        approvalCount: 2,
      });
      const res = await request(createApp()).get("/api/companies/company-1/dashboard");
      expect(res.status).toBe(200);
      expect(res.body.agentCount).toBe(3);
    });

    it("returns 403 for wrong company", async () => {
      const res = await request(createApp()).get("/api/companies/other-company/dashboard");
      expect(res.status).toBe(403);
    });
  });
});
