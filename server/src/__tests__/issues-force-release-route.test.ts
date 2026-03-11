import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  forceReleaseExecutionLock: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: vi.fn(() => ({})),
  agentService: vi.fn(() => ({})),
  goalService: vi.fn(() => ({})),
  heartbeatService: vi.fn(() => ({})),
  issueApprovalService: vi.fn(() => ({})),
  issueService: vi.fn(() => mockIssueService),
  logActivity: mockLogActivity,
  projectService: vi.fn(() => ({})),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

const baseIssue = {
  id: "issue-1",
  companyId: "company-1",
  checkoutRunId: "run-checkout-1",
  executionRunId: "run-exec-1",
  executionAgentNameKey: "ceo",
  executionLockedAt: new Date("2026-03-11T01:58:32.374Z"),
};

describe("POST /issues/:id/force-release", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getByIdentifier.mockResolvedValue(null);
  });

  it("rejects non-board actors", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue);
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });

    const res = await request(app).post("/api/issues/issue-1/force-release").send({});

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board or admin authentication required" });
    expect(mockIssueService.forceReleaseExecutionLock).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("allows board actors and logs force-release details", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue);
    mockIssueService.forceReleaseExecutionLock.mockResolvedValue({
      ...baseIssue,
      checkoutRunId: null,
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    const app = createApp({
      type: "board",
      userId: "board-user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).post("/api/issues/issue-1/force-release").send({});

    expect(res.status).toBe(200);
    expect(res.body.checkoutRunId).toBeNull();
    expect(res.body.executionRunId).toBeNull();
    expect(mockIssueService.forceReleaseExecutionLock).toHaveBeenCalledWith("issue-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "issue.force_released",
        entityType: "issue",
        entityId: "issue-1",
        details: {
          previousCheckoutRunId: "run-checkout-1",
          previousExecutionRunId: "run-exec-1",
          previousExecutionAgentNameKey: "ceo",
          previousExecutionLockedAt: new Date("2026-03-11T01:58:32.374Z"),
        },
      }),
    );
  });
});
