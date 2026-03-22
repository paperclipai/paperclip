import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const PARENT_ISSUE_ID = "66666666-6666-4666-8666-666666666666";
const RUN_ID = "55555555-5555-4555-8555-555555555555";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
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

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: ACTOR_AGENT_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function createAgentAppWithoutRun() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: ACTOR_AGENT_ID,
      companyId: COMPANY_ID,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue assignment permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockResolvedValue({
      id: ACTOR_AGENT_ID,
      companyId: COMPANY_ID,
      role: "researcher",
      permissions: null,
    });
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("blocks an agent from creating a self-assigned issue without tasks:assign", async () => {
    const res = await request(createAgentApp())
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({
        title: "Self assigned follow-up",
        status: "todo",
        assigneeAgentId: ACTOR_AGENT_ID,
        assigneeUserId: null,
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Missing permission: tasks:assign" });
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(COMPANY_ID, "agent", ACTOR_AGENT_ID, "tasks:assign");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("requires a live run id for agent-created issues", async () => {
    const res = await request(createAgentAppWithoutRun())
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({
        parentId: PARENT_ISSUE_ID,
        title: "Delegated follow-up",
        status: "todo",
      });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Agent run id required" });
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("allows an agent to create a delegated subtask without tasks:assign", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: PARENT_ISSUE_ID,
      companyId: COMPANY_ID,
      identifier: "NOV-90",
      title: "Parent issue",
      status: "todo",
      assigneeAgentId: ACTOR_AGENT_ID,
      assigneeUserId: null,
    });
    mockIssueService.create.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      identifier: "NOV-104",
      title: "Delegated follow-up",
      status: "todo",
      assigneeAgentId: OTHER_AGENT_ID,
      assigneeUserId: null,
    });

    const res = await request(createAgentApp())
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({
        parentId: PARENT_ISSUE_ID,
        title: "Delegated follow-up",
        status: "todo",
        assigneeAgentId: OTHER_AGENT_ID,
        assigneeUserId: null,
      });

    expect(res.status).toBe(201);
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(
      COMPANY_ID,
      "agent",
      ACTOR_AGENT_ID,
      "tasks:assign",
    );
    expect(mockIssueService.create).toHaveBeenCalledWith(
      COMPANY_ID,
      expect.objectContaining({
        parentId: PARENT_ISSUE_ID,
        title: "Delegated follow-up",
        assigneeAgentId: OTHER_AGENT_ID,
        createdByAgentId: ACTOR_AGENT_ID,
      }),
    );
  });

  it("blocks an agent from creating a top-level issue without tasks:assign", async () => {
    const res = await request(createAgentApp())
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({
        title: "Top-level draft issue",
        status: "todo",
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Missing permission: tasks:assign" });
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(COMPANY_ID, "agent", ACTOR_AGENT_ID, "tasks:assign");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("still blocks an agent from creating a top-level issue assigned to another agent", async () => {
    const res = await request(createAgentApp())
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({
        title: "Top-level delegated issue",
        status: "todo",
        assigneeAgentId: OTHER_AGENT_ID,
        assigneeUserId: null,
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Missing permission: tasks:assign" });
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(COMPANY_ID, "agent", ACTOR_AGENT_ID, "tasks:assign");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("blocks an agent from self-assigning its own unassigned issue without tasks:assign", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      identifier: "NOV-102",
      title: "Agent-created follow-up",
      status: "todo",
      createdByAgentId: ACTOR_AGENT_ID,
      createdByUserId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
    });
    mockIssueService.update.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      identifier: "NOV-102",
      title: "Agent-created follow-up",
      status: "todo",
      assigneeAgentId: ACTOR_AGENT_ID,
      assigneeUserId: null,
    });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        assigneeAgentId: ACTOR_AGENT_ID,
        assigneeUserId: null,
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Missing permission: tasks:assign" });
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(COMPANY_ID, "agent", ACTOR_AGENT_ID, "tasks:assign");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows an agent to assign its own unassigned subtask to another agent without tasks:assign", async () => {
    mockIssueService.getById
      .mockResolvedValueOnce({
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        identifier: "NOV-105",
        title: "Delegated follow-up",
        status: "todo",
        parentId: PARENT_ISSUE_ID,
        createdByAgentId: ACTOR_AGENT_ID,
        createdByUserId: null,
        assigneeAgentId: null,
        assigneeUserId: null,
      })
      .mockResolvedValueOnce({
        id: PARENT_ISSUE_ID,
        companyId: COMPANY_ID,
        identifier: "NOV-90",
        title: "Parent issue",
        status: "todo",
        assigneeAgentId: ACTOR_AGENT_ID,
        assigneeUserId: null,
      });
    mockIssueService.update.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      identifier: "NOV-105",
      title: "Delegated follow-up",
      status: "todo",
      assigneeAgentId: OTHER_AGENT_ID,
      assigneeUserId: null,
    });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        assigneeAgentId: OTHER_AGENT_ID,
        assigneeUserId: null,
      });

    expect(res.status).toBe(200);
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(
      COMPANY_ID,
      "agent",
      ACTOR_AGENT_ID,
      "tasks:assign",
    );
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({
        assigneeAgentId: OTHER_AGENT_ID,
        assigneeUserId: null,
      }),
    );
  });

  it("blocks an agent from assigning its own unassigned child issue to itself", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      identifier: "NOV-105",
      title: "Delegated follow-up",
      status: "todo",
      parentId: PARENT_ISSUE_ID,
      createdByAgentId: ACTOR_AGENT_ID,
      createdByUserId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
    });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        assigneeAgentId: ACTOR_AGENT_ID,
        assigneeUserId: null,
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Missing permission: tasks:assign" });
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(COMPANY_ID, "agent", ACTOR_AGENT_ID, "tasks:assign");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("still blocks an agent from assigning its own top-level unassigned issue to another agent", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      identifier: "NOV-106",
      title: "Top-level delegated issue",
      status: "todo",
      parentId: null,
      createdByAgentId: ACTOR_AGENT_ID,
      createdByUserId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
    });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        assigneeAgentId: OTHER_AGENT_ID,
        assigneeUserId: null,
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Missing permission: tasks:assign" });
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(COMPANY_ID, "agent", ACTOR_AGENT_ID, "tasks:assign");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("still blocks an agent from self-assigning someone else's unassigned issue", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      identifier: "NOV-103",
      title: "Someone else's follow-up",
      status: "todo",
      createdByAgentId: OTHER_AGENT_ID,
      createdByUserId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
    });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        assigneeAgentId: ACTOR_AGENT_ID,
        assigneeUserId: null,
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Agents can only mutate their own assigned issues" });
    expect(mockAccessService.hasPermission).toHaveBeenCalledWith(
      COMPANY_ID,
      "agent",
      ACTOR_AGENT_ID,
      "tasks:assign",
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
