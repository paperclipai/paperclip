import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityRoutes } from "../../routes/activity.js";
import { errorHandler } from "../../middleware/index.js";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  listMentions: vi.fn(),
}));

vi.mock("../../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../../services/index.js", () => ({
  issueService: () => mockIssueService,
}));

vi.mock("../../redaction.js", () => ({
  sanitizeRecord: (r: unknown) => r,
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
  app.use("/api", activityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("activityRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /companies/:companyId/activity", () => {
    it("lists activity for a company", async () => {
      mockActivityService.list.mockResolvedValue([
        { id: "ev-1", action: "agent.created", companyId: "company-1" },
      ]);
      const res = await request(createApp()).get("/api/companies/company-1/activity");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("returns 403 for wrong company", async () => {
      const res = await request(createApp()).get("/api/companies/other-company/activity");
      expect(res.status).toBe(403);
    });
  });

  describe("POST /companies/:companyId/activity", () => {
    it("creates an activity event for board", async () => {
      mockActivityService.create.mockResolvedValue({
        id: "ev-2", action: "custom", companyId: "company-1",
      });
      const res = await request(createApp())
        .post("/api/companies/company-1/activity")
        .send({
          actorId: "user-1",
          action: "custom",
          entityType: "agent",
          entityId: "agent-1",
        });
      expect(res.status).toBe(201);
    });

    it("returns 403 for non-board actor", async () => {
      const res = await request(createApp({ type: "agent", agentId: "a-1", companyId: "company-1" }))
        .post("/api/companies/company-1/activity")
        .send({
          actorId: "agent-1",
          action: "custom",
          entityType: "agent",
          entityId: "agent-1",
        });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /issues/:id/activity", () => {
    it("returns activity for an issue", async () => {
      const issueId = "a0000000-0000-4000-8000-000000000099";
      mockIssueService.getById.mockResolvedValue({ id: issueId, companyId: "company-1" });
      mockActivityService.forIssue.mockResolvedValue([{ id: "ev-1" }]);
      const res = await request(createApp()).get(`/api/issues/${issueId}/activity`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("returns 404 for nonexistent issue", async () => {
      mockIssueService.getById.mockResolvedValue(null);
      const res = await request(createApp()).get("/api/issues/a0000000-0000-4000-8000-000000000000/activity");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /issues/:id/runs", () => {
    it("returns runs for an issue", async () => {
      const issueId = "a0000000-0000-4000-8000-000000000099";
      mockIssueService.getById.mockResolvedValue({ id: issueId, companyId: "company-1" });
      mockActivityService.runsForIssue.mockResolvedValue([{ id: "run-1" }]);
      const res = await request(createApp()).get(`/api/issues/${issueId}/runs`);
      expect(res.status).toBe(200);
    });
  });

  describe("GET /heartbeat-runs/:runId/issues", () => {
    it("returns issues for a run", async () => {
      mockActivityService.issuesForRun.mockResolvedValue([{ id: "issue-1" }]);
      const res = await request(createApp()).get("/api/heartbeat-runs/run-1/issues");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /companies/:companyId/mentions", () => {
    it("lists mentions with unread state for the current user", async () => {
      mockIssueService.listMentions.mockResolvedValue([
        {
          issueId: "issue-1",
          identifier: "PAP-1",
          title: "Mentioned issue",
          status: "todo",
          priority: "medium",
          mentionedAt: new Date("2026-03-15T15:00:00.000Z"),
          commentId: "comment-1",
          isUnread: true,
        },
      ]);

      const res = await request(createApp()).get("/api/companies/company-1/mentions?userId=me");

      expect(res.status).toBe(200);
      expect(mockIssueService.listMentions).toHaveBeenCalledWith("company-1", "user-1");
      expect(res.body).toEqual([
        expect.objectContaining({
          issueId: "issue-1",
          identifier: "PAP-1",
          title: "Mentioned issue",
          commentId: "comment-1",
          isUnread: true,
        }),
      ]);
    });

    it("rejects userId=me without board auth", async () => {
      const res = await request(
        createApp({ type: "agent", agentId: "agent-1", companyId: "company-1" }),
      ).get("/api/companies/company-1/mentions?userId=me");

      expect(res.status).toBe(403);
      expect(mockIssueService.listMentions).not.toHaveBeenCalled();
    });
  });
});
