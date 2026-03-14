import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { activityRoutes } from "../routes/activity.js";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
  create: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
}));

/** Board user scoped to company-a only. */
function createAppForBoardCompanyA() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-a",
      companyIds: ["company-a"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", activityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

/** Agent scoped to company-a. */
function createAppForAgentCompanyA() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-a",
      companyId: "company-a",
      source: "agent_key",
    };
    next();
  });
  app.use("/api", activityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("activity routes: cross-company isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("board user scoped to company-a", () => {
    it("GET /companies/company-b/activity returns 403", async () => {
      const res = await request(createAppForBoardCompanyA()).get(
        "/api/companies/company-b/activity",
      );

      expect(res.status).toBe(403);
      expect(mockActivityService.list).not.toHaveBeenCalled();
    });

    it("POST /companies/company-b/activity returns 403", async () => {
      const res = await request(createAppForBoardCompanyA())
        .post("/api/companies/company-b/activity")
        .send({
          actorId: "system",
          action: "test.event",
          entityType: "test",
          entityId: "test-1",
        });

      expect(res.status).toBe(403);
      expect(mockActivityService.create).not.toHaveBeenCalled();
    });

    it("GET /issues/:id/activity returns 403 for issue belonging to company-b", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "issue-b1",
        companyId: "company-b",
      });

      const res = await request(createAppForBoardCompanyA()).get("/api/issues/issue-b1/activity");

      expect(res.status).toBe(403);
      expect(mockActivityService.forIssue).not.toHaveBeenCalled();
    });

    it("GET /issues/:id/runs returns 403 for issue belonging to company-b", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "issue-b1",
        companyId: "company-b",
      });

      const res = await request(createAppForBoardCompanyA()).get("/api/issues/issue-b1/runs");

      expect(res.status).toBe(403);
      expect(mockActivityService.runsForIssue).not.toHaveBeenCalled();
    });

    it("GET /heartbeat-runs/:runId/issues returns 403 for run belonging to company-b", async () => {
      mockActivityService.issuesForRun.mockResolvedValue({
        companyId: "company-b",
        issues: [],
      });

      const res = await request(createAppForBoardCompanyA()).get(
        "/api/heartbeat-runs/run-b1/issues",
      );

      expect(res.status).toBe(403);
    });

    it("GET /heartbeat-runs/:runId/issues returns 404 for nonexistent run", async () => {
      mockActivityService.issuesForRun.mockResolvedValue({
        companyId: null,
        issues: [],
      });

      const res = await request(createAppForBoardCompanyA()).get(
        "/api/heartbeat-runs/nonexistent/issues",
      );

      expect(res.status).toBe(404);
    });

    it("GET /heartbeat-runs/:runId/issues succeeds for run belonging to company-a", async () => {
      mockActivityService.issuesForRun.mockResolvedValue({
        companyId: "company-a",
        issues: [{ issueId: "issue-a1", title: "Test" }],
      });

      const res = await request(createAppForBoardCompanyA()).get(
        "/api/heartbeat-runs/run-a1/issues",
      );

      expect(res.status).toBe(200);
      expect(mockActivityService.issuesForRun).toHaveBeenCalledWith("run-a1");
    });
  });

  describe("agent scoped to company-a", () => {
    it("GET /companies/company-b/activity returns 403 for agent scoped to company-a", async () => {
      const res = await request(createAppForAgentCompanyA()).get(
        "/api/companies/company-b/activity",
      );

      expect(res.status).toBe(403);
      expect(mockActivityService.list).not.toHaveBeenCalled();
    });

    it("GET /heartbeat-runs/:runId/issues returns 403 for run belonging to company-b", async () => {
      mockActivityService.issuesForRun.mockResolvedValue({
        companyId: "company-b",
        issues: [],
      });

      const res = await request(createAppForAgentCompanyA()).get(
        "/api/heartbeat-runs/run-b1/issues",
      );

      expect(res.status).toBe(403);
    });

    it("GET /issues/:id/activity returns 403 for issue belonging to company-b", async () => {
      mockIssueService.getById.mockResolvedValue({
        id: "issue-b1",
        companyId: "company-b",
      });

      const res = await request(createAppForAgentCompanyA()).get("/api/issues/issue-b1/activity");

      expect(res.status).toBe(403);
      expect(mockActivityService.forIssue).not.toHaveBeenCalled();
    });
  });
});
