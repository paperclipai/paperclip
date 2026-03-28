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

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
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
    mockActivityService.list.mockResolvedValue([]);
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

  it("returns 400 for malformed issue ids on runs route", async () => {
    const res = await request(createApp()).get("/api/issues/not-a-valid-ref/runs");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid issue id");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed issue ids on activity route", async () => {
    const res = await request(createApp()).get("/api/issues/not-a-valid-ref/activity");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid issue id");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockIssueService.getByIdentifier).not.toHaveBeenCalled();
    expect(mockActivityService.forIssue).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid agentId filter on company activity list", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/activity?agentId=not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid agentId filter");
    expect(mockActivityService.list).not.toHaveBeenCalled();
  });

  it("ignores malformed object query values for activity filters instead of forwarding them", async () => {
    const res = await request(createApp()).get(
      "/api/companies/company-1/activity?agentId[bad]=1&entityType[bad]=issue&entityId[bad]=abc",
    );

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: undefined,
      entityId: undefined,
    });
  });
});
