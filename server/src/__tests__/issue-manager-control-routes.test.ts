import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const CEO_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const MANAGER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const WORKER_AGENT_ID = "44444444-4444-4444-8444-444444444444";
const ISSUE_ID = "55555555-5555-4555-8555-555555555555";
const RUN_ID = "66666666-6666-4666-8666-666666666666";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getById: vi.fn(),
  release: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  wakeup: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  workProductService: () => ({}),
}));

function createAgentApp({
  agentId = CEO_AGENT_ID,
  runId = RUN_ID,
}: {
  agentId?: string;
  runId?: string | null;
} = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: COMPANY_ID,
      ...(runId ? { runId } : {}),
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue manager control routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("allows a CEO agent to reprioritize another agent's assigned backlog issue", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: CEO_AGENT_ID,
      companyId: COMPANY_ID,
      role: "ceo",
      permissions: null,
    });
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "backlog",
      assigneeAgentId: WORKER_AGENT_ID,
      assigneeUserId: null,
      createdByAgentId: WORKER_AGENT_ID,
      createdByUserId: null,
    });
    mockIssueService.update.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "todo",
      assigneeAgentId: WORKER_AGENT_ID,
      assigneeUserId: null,
      createdByAgentId: WORKER_AGENT_ID,
      createdByUserId: null,
    });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "todo" }),
    );
  });

  it("requires a live run id for CEO queue-control mutations", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: CEO_AGENT_ID,
      companyId: COMPANY_ID,
      role: "ceo",
      permissions: null,
    });
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "backlog",
      assigneeAgentId: WORKER_AGENT_ID,
      assigneeUserId: null,
      createdByAgentId: WORKER_AGENT_ID,
      createdByUserId: null,
    });

    const res = await request(createAgentApp({ runId: null }))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "todo" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Agent run id required" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent with tasks:assign permission to reprioritize another agent's issue", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue({
      id: MANAGER_AGENT_ID,
      companyId: COMPANY_ID,
      role: "manager",
      permissions: null,
    });
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "backlog",
      assigneeAgentId: WORKER_AGENT_ID,
      assigneeUserId: null,
      createdByAgentId: WORKER_AGENT_ID,
      createdByUserId: null,
    });
    mockIssueService.update.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "todo",
      assigneeAgentId: WORKER_AGENT_ID,
      assigneeUserId: null,
      createdByAgentId: WORKER_AGENT_ID,
      createdByUserId: null,
    });

    const res = await request(createAgentApp({ agentId: MANAGER_AGENT_ID }))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "todo" });

    expect(res.status).toBe(200);
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(
      COMPANY_ID,
      "agent",
      MANAGER_AGENT_ID,
      "tasks:assign",
    );
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "todo" }),
    );
  });

  it("allows a CEO agent to release another agent's checked-out issue", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: CEO_AGENT_ID,
      companyId: COMPANY_ID,
      role: "ceo",
      permissions: null,
    });
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "in_progress",
      assigneeAgentId: WORKER_AGENT_ID,
      assigneeUserId: null,
      createdByAgentId: WORKER_AGENT_ID,
      createdByUserId: null,
    });
    mockIssueService.release.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
    });

    const res = await request(createAgentApp())
      .post(`/api/issues/${ISSUE_ID}/release`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.release).toHaveBeenCalledWith(
      ISSUE_ID,
      {
        actorAgentId: CEO_AGENT_ID,
        actorRunId: RUN_ID,
        bypassAssigneeCheck: true,
      },
    );
  });
});
