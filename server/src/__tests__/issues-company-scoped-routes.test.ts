import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  update: vi.fn(),
  listComments: vi.fn(),
  checkout: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  accessService: () => mockAccessService,
  heartbeatService: () => mockHeartbeatService,
  agentService: () => mockAgentService,
  projectService: () => mockProjectService,
  goalService: () => mockGoalService,
  issueApprovalService: () => mockIssueApprovalService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  workProductService: () => mockWorkProductService,
  documentService: () => mockDocumentService,
  logActivity: mockLogActivity,
}));

const companyId = "company-1";
const issueId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const otherAgentId = "33333333-3333-4333-8333-333333333333";

function createBoardApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
      runId: null,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("company-scoped issue route aliases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectService.listByIds.mockResolvedValue([]);
    mockDocumentService.getIssueDocumentPayload.mockResolvedValue({});
    mockWorkProductService.listForIssue.mockResolvedValue([]);
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
  });

  it("supports company-scoped PATCH for issue assignment updates", async () => {
    mockIssueService.getById.mockResolvedValueOnce({
      id: issueId,
      companyId,
      identifier: "PAP-1",
      status: "todo",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      title: "Test issue",
    });
    mockIssueService.update.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "PAP-1",
      status: "todo",
      assigneeAgentId: otherAgentId,
      assigneeUserId: null,
      title: "Test issue",
    });

    const res = await request(createBoardApp())
      .patch(`/api/companies/${companyId}/issues/${issueId}`)
      .send({ assigneeAgentId: otherAgentId });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(issueId, { assigneeAgentId: otherAgentId });
  });

  it("supports company-scoped checkout aliases for agents", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "PAP-1",
      projectId: null,
    });
    mockIssueService.checkout.mockResolvedValue({
      id: issueId,
      companyId,
      status: "in_progress",
      assigneeAgentId: agentId,
    });

    const res = await request(createAgentApp())
      .post(`/api/companies/${companyId}/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo", "in_review"] });

    expect(res.status).toBe(200);
    expect(mockIssueService.checkout).toHaveBeenCalledWith(issueId, agentId, ["todo", "in_review"], "run-1");
  });

  it("supports company-scoped comment listing aliases", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: issueId,
      companyId,
      identifier: "PAP-1",
    });
    mockIssueService.listComments.mockResolvedValue([{ id: "comment-1", issueId, body: "hi" }]);

    const res = await request(createBoardApp()).get(`/api/companies/${companyId}/issues/${issueId}/comments`);

    expect(res.status).toBe(200);
    expect(mockIssueService.listComments).toHaveBeenCalledWith(issueId, {
      afterCommentId: null,
      order: "desc",
      limit: null,
    });
    expect(res.body).toEqual([{ id: "comment-1", issueId, body: "hi" }]);
  });
});
