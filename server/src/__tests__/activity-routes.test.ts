import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
  create: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
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
  heartbeatService: () => mockHeartbeatService,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  const [{ errorHandler }, { activityRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/activity.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", activityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("activity routes", () => {
  beforeEach(() => {
    vi.resetModules();
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
        adapterType: "codex_local",
      },
    ]);

    const app = await createApp();
    const res = await request(app).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1");
    expect(res.body).toEqual([{ runId: "run-1", adapterType: "codex_local" }]);
  });

  it("requires company access before creating activity events", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-2/activity")
      .send({
        actorId: "user-1",
        action: "test.event",
        entityType: "issue",
        entityId: "issue-1",
      });

    expect(res.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("requires company access before listing issues for another company's run", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-2",
      companyId: "company-2",
    });

    const app = await createApp();
    const res = await request(app).get("/api/heartbeat-runs/run-2/issues");

    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("rejects anonymous heartbeat run issue lookups before run existence checks", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/heartbeat-runs/missing-run/issues");

    expect(res.status).toBe(401);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });
});
