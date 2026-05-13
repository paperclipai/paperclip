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

  it("forwards a valid ?since= ISO timestamp to the service as a Date", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const res = await request(createApp())
      .get("/api/companies/company-1/activity?since=2026-05-12T17:00:00Z");

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledTimes(1);
    const filters = mockActivityService.list.mock.calls[0][0];
    expect(filters.companyId).toBe("company-1");
    expect(filters.since).toBeInstanceOf(Date);
    expect(filters.since.toISOString()).toBe("2026-05-12T17:00:00.000Z");
  });

  it("returns 400 when ?since= is not a parseable timestamp", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/activity?since=not-a-date");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/since/i);
    expect(mockActivityService.list).not.toHaveBeenCalled();
  });

  it("omits since from filters when ?since= is missing or empty", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const r1 = await request(createApp()).get("/api/companies/company-1/activity");
    expect(r1.status).toBe(200);
    expect(mockActivityService.list.mock.calls[0][0].since).toBeUndefined();

    const r2 = await request(createApp()).get("/api/companies/company-1/activity?since=");
    expect(r2.status).toBe(200);
    expect(mockActivityService.list.mock.calls[1][0].since).toBeUndefined();
  });
});
