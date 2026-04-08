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

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  heartbeatService: () => mockHeartbeatService,
}));

function createApp(actorOverrides?: Record<string, unknown>) {
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

describe("activity routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves issue identifiers before loading runs", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
      },
    ]);

    const res = await request(createApp()).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1");
    expect(res.body).toEqual([{ runId: "run-1" }]);
  });

  it("returns 401 for heartbeat run issues when unauthenticated", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
    });

    const res = await request(createApp({ type: "none" })).get("/api/heartbeat-runs/run-1/issues");

    expect(res.status).toBe(401);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("returns 403 for heartbeat run issues when board user lacks company access", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-a",
    });

    const res = await request(
      createApp({
        type: "board",
        userId: "user-1",
        companyIds: ["company-b"],
        source: "session",
        isInstanceAdmin: false,
      }),
    ).get("/api/heartbeat-runs/run-1/issues");

    expect(res.status).toBe(403);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("returns 404 when heartbeat run does not exist", async () => {
    mockHeartbeatService.getRun.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/heartbeat-runs/missing-run/issues");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Heartbeat run not found" });
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("returns issues for a heartbeat run when caller has company access", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
    });
    mockActivityService.issuesForRun.mockResolvedValue([
      { issueId: "issue-1", identifier: "PAP-1", title: "T", status: "todo", priority: "medium" },
    ]);

    const res = await request(createApp()).get("/api/heartbeat-runs/run-1/issues");

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.getRun).toHaveBeenCalledWith("run-1");
    expect(mockActivityService.issuesForRun).toHaveBeenCalledWith("run-1");
    expect(res.body).toEqual([
      { issueId: "issue-1", identifier: "PAP-1", title: "T", status: "todo", priority: "medium" },
    ]);
  });
});
