import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  getLabelById: vi.fn(),
  deleteLabel: vi.fn(),
  listLabels: vi.fn(),
  createLabel: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue label route validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getLabelById.mockResolvedValue(null);
    mockIssueService.deleteLabel.mockResolvedValue(null);
    mockIssueService.listLabels.mockResolvedValue([]);
    mockIssueService.createLabel.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: COMPANY_ID,
      name: "Ops",
      color: "#123456",
    });
  });

  it("returns 400 for malformed label ids instead of querying the DB", async () => {
    const res = await request(createApp()).delete("/api/labels/not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid labelId");
    expect(mockIssueService.getLabelById).not.toHaveBeenCalled();
    expect(mockIssueService.deleteLabel).not.toHaveBeenCalled();
  });

  it("normalizes companyId path for label listing", async () => {
    const res = await request(createApp()).get(`/api/companies/%20${COMPANY_ID.toUpperCase()}%20/labels`);

    expect(res.status).toBe(200);
    expect(mockIssueService.listLabels).toHaveBeenCalledWith(COMPANY_ID);
  });

  it("normalizes companyId path for label creation", async () => {
    const res = await request(createApp())
      .post(`/api/companies/%20${COMPANY_ID.toUpperCase()}%20/labels`)
      .send({ name: "Ops", color: "#123456" });

    expect(res.status).toBe(201);
    expect(mockIssueService.createLabel).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({ name: "Ops", color: "#123456" }),
    );
  });
});
