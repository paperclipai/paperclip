import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { planRoutes } from "../routes/plans.js";
import { HttpError } from "../errors.js";

/**
 * E — PATCH /plans/:issueId/gate-profile
 * Route-level tests: 400 on invalid body, 404 on missing plan, 409 on same
 * profile, 200 on success with service result passed through.
 */

const mockPlanService = vi.hoisted(() => ({
  createPlan: vi.fn(),
  listPlans: vi.fn(),
  getPlan: vi.fn(),
  updateTiers: vi.fn(),
  setBudgetCaps: vi.fn(),
  setGateProfile: vi.fn(),
  activate: vi.fn(),
  markStopped: vi.fn(),
  subtreeIssueIds: vi.fn(),
  deletePlanSubtree: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/plans.js", () => ({
  planService: () => mockPlanService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  agentService: () => mockAgentService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  ISSUE_LIST_DEFAULT_LIMIT: 500,
}));

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const planIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const planIssue = {
  id: planIssueId,
  companyId,
  title: "My Plan",
  status: "todo",
  workMode: "planning",
  assigneeAgentId: null,
};

const boardActor = {
  type: "board",
  userId: "user-1",
  companyIds: [companyId],
  isInstanceAdmin: true,
  source: "session",
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = boardActor;
    next();
  });
  app.use("/api", planRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("E — PATCH /plans/:issueId/gate-profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 for invalid gateProfile value", async () => {
    const app = createApp();
    const res = await request(app)
      .patch(`/api/plans/${planIssueId}/gate-profile`)
      .send({ gateProfile: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid gate-profile payload");
  });

  it("returns 404 when plan issue not found", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const app = createApp();
    const res = await request(app)
      .patch(`/api/plans/${planIssueId}/gate-profile`)
      .send({ gateProfile: "dev_team" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Plan not found");
  });

  it("returns 409 when service throws conflict (same profile)", async () => {
    mockIssueService.getById.mockResolvedValue(planIssue);
    mockPlanService.setGateProfile.mockRejectedValue(
      new HttpError(409, "Plan already has gateProfile 'dev_team'"),
    );

    const app = createApp();
    const res = await request(app)
      .patch(`/api/plans/${planIssueId}/gate-profile`)
      .send({ gateProfile: "dev_team" });

    expect(res.status).toBe(409);
  });

  it("returns 200 with planDetails and approval ids on success", async () => {
    mockIssueService.getById.mockResolvedValue(planIssue);
    mockPlanService.setGateProfile.mockResolvedValue({
      planDetails: { issueId: planIssueId, gateProfile: "dev_team", state: "draft" },
      createdApprovalIds: ["approval-1"],
      cancelledApprovalIds: [],
    });

    const app = createApp();
    const res = await request(app)
      .patch(`/api/plans/${planIssueId}/gate-profile`)
      .send({ gateProfile: "dev_team" });

    expect(res.status).toBe(200);
    expect(res.body.planDetails.gateProfile).toBe("dev_team");
    expect(res.body.createdApprovalIds).toEqual(["approval-1"]);
    expect(res.body.cancelledApprovalIds).toEqual([]);
    expect(mockPlanService.setGateProfile).toHaveBeenCalledWith(
      planIssueId,
      "dev_team",
      expect.objectContaining({ userId: "user-1" }),
    );
  });
});
