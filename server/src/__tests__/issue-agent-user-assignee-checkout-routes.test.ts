import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = {
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  remove: vi.fn(),
  listAttachments: vi.fn(),
  assertCheckoutOwner: vi.fn(),
};

const mockHeartbeatService = {
  wakeup: vi.fn(async () => null),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
  reportRunActivity: vi.fn(async () => null),
};

vi.mock("../services/index.js", () => ({
  accessService: vi.fn(() => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    decide: vi.fn(async () => ({ allowed: true })),
  })),
  agentService: vi.fn(() => ({ getById: vi.fn() })),
  clampIssueListLimit: vi.fn((value: number) => value),
  companySearchService: vi.fn(() => ({ search: vi.fn() })),
  companyService: vi.fn(() => ({ getById: vi.fn() })),
  documentAnnotationService: vi.fn(() => ({})),
  documentService: vi.fn(() => ({})),
  executionWorkspaceService: vi.fn(() => ({})),
  goalService: vi.fn(() => ({ getById: vi.fn() })),
  heartbeatService: vi.fn(() => mockHeartbeatService),
  issueApprovalService: vi.fn(() => ({ listApprovalsForIssue: vi.fn(), link: vi.fn(), unlink: vi.fn() })),
  issueRecoveryActionService: vi.fn(() => ({ getActiveForIssue: vi.fn(async () => null) })),
  issueReferenceService: vi.fn(() => ({})),
  issueService: vi.fn(() => mockIssueService),
  issueThreadInteractionService: vi.fn(() => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  })),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  ISSUE_LIST_MAX_LIMIT: 100,
  logActivity: vi.fn(async () => undefined),
  projectService: vi.fn(() => ({ getById: vi.fn(async () => null) })),
  routineService: vi.fn(() => ({ syncRunStatusForIssue: vi.fn(async () => undefined) })),
  workProductService: vi.fn(() => ({})),
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: vi.fn(() => ({})),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: vi.fn(() => ({})),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({})),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: vi.fn(() => ({})),
}));

import { issueRoutes } from "../routes/issues.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "agent",
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      runId: "22222222-2222-4222-8222-222222222222",
    };
    next();
  });
  app.use("/api", issueRoutes({} as never, { deleteObject: vi.fn() } as never));
  return app;
}

const userAssignedIssue = {
  id: "issue-1",
  companyId: "company-1",
  projectId: null,
  parentId: null,
  assigneeAgentId: null,
  assigneeUserId: "board-user-1",
  status: "todo",
  identifier: "PAP-1",
  title: "User-owned issue",
  createdByUserId: "board-user-1",
};

const unassignedIssue = {
  ...userAssignedIssue,
  assigneeUserId: null,
};

describe("issueRoutes user-assignee checkout boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.listAttachments.mockResolvedValue([]);
  });

  it("rejects agent patches against user-assigned issues", async () => {
    mockIssueService.getById.mockResolvedValue(userAssignedIssue);

    const res = await request(createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "blocked" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Agents cannot mutate or checkout user-assigned issues" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects agent checkout against user-assigned issues", async () => {
    mockIssueService.getById.mockResolvedValue(userAssignedIssue);

    const res = await request(createApp())
      .post("/api/issues/issue-1/checkout")
      .send({ agentId: "11111111-1111-4111-8111-111111111111", expectedStatuses: ["todo"] });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Agents cannot mutate or checkout user-assigned issues" });
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("still allows agent checkout for truly unassigned issues", async () => {
    mockIssueService.getById.mockResolvedValue(unassignedIssue);
    mockIssueService.checkout.mockResolvedValue({
      ...unassignedIssue,
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
      status: "in_progress",
    });

    const res = await request(createApp())
      .post("/api/issues/issue-1/checkout")
      .send({ agentId: "11111111-1111-4111-8111-111111111111", expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
    expect(mockIssueService.checkout).toHaveBeenCalledWith(
      "issue-1",
      "11111111-1111-4111-8111-111111111111",
      ["todo"],
      "22222222-2222-4222-8222-222222222222",
    );
  });
});
