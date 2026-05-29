import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  update: vi.fn(),
}));

const mockExecutionWorkspaceReaperService = vi.hoisted(() => ({
  reap: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  executionWorkspaceReaperService: () => mockExecutionWorkspaceReaperService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

function createApp(companyIds = ["company-1"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds,
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("execution workspace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutionWorkspaceService.list.mockResolvedValue([]);
    mockExecutionWorkspaceService.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockExecutionWorkspaceReaperService.reap.mockResolvedValue({
      companyId: "company-1",
      dryRun: true,
      deleteFiles: false,
      checkedCount: 0,
      candidateCount: 0,
      archivedCount: 0,
      excludedActiveCount: 0,
      noopArchivedCount: 0,
      noopNoReasonCount: 0,
      items: [],
    });
  });

  it("uses summary mode for lightweight workspace lookups", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/execution-workspaces?summary=true&reuseEligible=true");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    expect(mockExecutionWorkspaceService.listSummaries).toHaveBeenCalledWith("company-1", {
      projectId: undefined,
      projectWorkspaceId: undefined,
      issueId: undefined,
      status: undefined,
      reuseEligible: true,
    });
    expect(mockExecutionWorkspaceService.list).not.toHaveBeenCalled();
  });

  it("runs the reaper as a dry-run by default", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/execution-workspaces/reap");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      companyId: "company-1",
      dryRun: true,
      deleteFiles: false,
    });
    expect(mockExecutionWorkspaceReaperService.reap).toHaveBeenCalledWith("company-1", {
      dryRun: true,
      deleteFiles: false,
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("logs a bulk reaper activity entry when records are archived", async () => {
    mockExecutionWorkspaceReaperService.reap.mockResolvedValue({
      companyId: "company-1",
      dryRun: false,
      deleteFiles: false,
      checkedCount: 3,
      candidateCount: 2,
      archivedCount: 2,
      excludedActiveCount: 1,
      noopArchivedCount: 0,
      noopNoReasonCount: 0,
      items: [],
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/execution-workspaces/reap")
      .send({ dryRun: false });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceReaperService.reap).toHaveBeenCalledWith("company-1", {
      dryRun: false,
      deleteFiles: false,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "execution_workspace.reaped",
      entityType: "company",
      entityId: "company-1",
      details: expect.objectContaining({
        archivedCount: 2,
        excludedActiveCount: 1,
      }),
    }));
  });

});
