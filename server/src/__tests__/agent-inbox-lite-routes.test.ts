import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const managerId = "33333333-3333-4333-8333-333333333333";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: managerId,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const managerAgent = {
  ...baseAgent,
  id: managerId,
  name: "Manager",
  urlKey: "manager",
  role: "general",
  title: "Technical Lead",
  reportsTo: null,
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: companyId,
            name: "Paperclip",
            requireBoardApprovalForNewAgents: false,
          }]),
        }),
      }),
    }),
  };
}

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

const sampleIssues = [
  {
    id: "issue-1",
    identifier: "DSPA-100",
    title: "Fix login bug",
    status: "todo",
    priority: "high",
    projectId: null,
    goalId: "goal-1",
    parentId: null,
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    activeRun: null,
  },
  {
    id: "issue-2",
    identifier: "DSPA-101",
    title: "Add feature",
    status: "in_progress",
    priority: "medium",
    projectId: "proj-1",
    goalId: "goal-1",
    parentId: "issue-1",
    updatedAt: new Date("2026-04-02T00:00:00.000Z"),
    activeRun: { id: "run-1", status: "running", agentId },
  },
];

describe("GET /api/agents/:id/inbox-lite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === agentId) return baseAgent;
      if (id === managerId) return managerAgent;
      return null;
    });
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAccessService.getMembership.mockResolvedValue({
      id: "membership-1",
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockIssueService.list.mockResolvedValue(sampleIssues);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns inbox-lite for a report when called by a manager agent", async () => {
    const app = createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId: "run-mgr",
      source: "agent_key",
    });

    const res = await request(app).get(`/api/agents/${agentId}/inbox-lite`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(companyId, {
      assigneeAgentId: agentId,
      status: "todo,in_progress,blocked",
    });
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual(
      expect.objectContaining({
        id: "issue-1",
        identifier: "DSPA-100",
        title: "Fix login bug",
        status: "todo",
      }),
    );
    // Verify only lean fields are returned (no description, etc.)
    expect(res.body[0]).not.toHaveProperty("description");
  });

  it("returns inbox-lite for a report when called by a board user", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/agents/${agentId}/inbox-lite`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(companyId, {
      assigneeAgentId: agentId,
      status: "todo,in_progress,blocked",
    });
    expect(res.body).toHaveLength(2);
  });

  it("returns inbox-lite when agent queries its own ID", async () => {
    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-self",
      source: "agent_key",
    });

    const res = await request(app).get(`/api/agents/${agentId}/inbox-lite`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(companyId, {
      assigneeAgentId: agentId,
      status: "todo,in_progress,blocked",
    });
  });

  it("returns 404 for non-existent agent", async () => {
    const unknownId = "99999999-9999-4999-8999-999999999999";
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === managerId) return managerAgent;
      if (id === agentId) return baseAgent;
      return null;
    });

    const app = createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId: "run-mgr",
      source: "agent_key",
    });

    const res = await request(app).get(`/api/agents/${unknownId}/inbox-lite`);

    expect(res.status).toBe(404);
  });

  it("returns empty array when agent has no assigned issues", async () => {
    mockIssueService.list.mockResolvedValue([]);

    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/agents/${agentId}/inbox-lite`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
