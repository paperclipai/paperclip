import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const agentId = "11111111-1111-4111-8111-111111111111";
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
  reportsTo: null,
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
  wakeup: vi.fn(),
  invoke: vi.fn(),
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
  getBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn());
const mockListAdapterModels = vi.hoisted(() => vi.fn());

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

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  listAdapterModels: mockListAdapterModels,
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

describe("agent permission routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindServerAdapter.mockReturnValue({
      testEnvironment: vi.fn().mockResolvedValue({ checks: [] }),
    });
    mockListAdapterModels.mockResolvedValue([]);
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAgentService.create.mockResolvedValue(baseAgent);
    mockAgentService.updatePermissions.mockResolvedValue(baseAgent);
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
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(async (_companyId, requested) => requested);
    mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>, files: Record<string, string>) => ({
        bundle: null,
        adapterConfig: {
          ...((agent.adapterConfig as Record<string, unknown> | undefined) ?? {}),
          instructionsBundleMode: "managed",
          instructionsRootPath: `/tmp/${String(agent.id)}/instructions`,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: `/tmp/${String(agent.id)}/instructions/AGENTS.md`,
          promptTemplate: files["AGENTS.md"] ?? "",
        },
      }),
    );
    mockAgentInstructionsService.getBundle.mockResolvedValue({
      mode: "external",
      rootPath: null,
      entryFile: "AGENTS.md",
      files: [],
    });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => requested,
    );
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockIssueService.list.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockHeartbeatService.invoke.mockResolvedValue({ id: "run-1" });
  });

  it("grants tasks:assign by default when board creates a new agent", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      });

    expect(res.status).toBe(201);
    expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "member",
      "active",
    );
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "board-user",
    );
  });

  it("exposes explicit task assignment access on agent detail", async () => {
    mockAccessService.listPrincipalGrants.mockResolvedValue([
      {
        id: "grant-1",
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "tasks:assign",
        scope: null,
        grantedByUserId: "board-user",
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
        updatedAt: new Date("2026-03-19T00:00:00.000Z"),
      },
    ]);

    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body.access.canAssignTasks).toBe(true);
    expect(res.body.access.taskAssignSource).toBe("explicit_grant");
  });

  it("keeps task assignment enabled when agent creation privilege is enabled", async () => {
    mockAgentService.updatePermissions.mockResolvedValue({
      ...baseAgent,
      permissions: { canCreateAgents: true },
    });

    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/agents/${agentId}/permissions`)
      .send({ canCreateAgents: true, canAssignTasks: false });

    expect(res.status).toBe(200);
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "board-user",
    );
    expect(res.body.access.canAssignTasks).toBe(true);
    expect(res.body.access.taskAssignSource).toBe("agent_creator");
  });

  it("passes forceFreshSession through heartbeat invoke requests", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/agents/${agentId}/heartbeat/invoke`)
      .send({ forceFreshSession: true });

    expect(res.status).toBe(202);
    expect(mockHeartbeatService.invoke).toHaveBeenCalledWith(
      agentId,
      "on_demand",
      expect.objectContaining({
        triggeredBy: "board",
        actorId: "board-user",
        forceFreshSession: true,
      }),
      "manual",
      expect.objectContaining({
        actorType: "user",
        actorId: "board-user",
      }),
    );
  });

  it("passes issue retry context through heartbeat invoke requests", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/agents/${agentId}/heartbeat/invoke`)
      .send({
        forceFreshSession: true,
        issueId: "issue-123",
        taskId: "issue-123",
        taskKey: "issue-123",
        commentId: "comment-123",
        wakeCommentId: "comment-123",
      });

    expect(res.status).toBe(202);
    expect(mockHeartbeatService.invoke).toHaveBeenCalledWith(
      agentId,
      "on_demand",
      expect.objectContaining({
        triggeredBy: "board",
        actorId: "board-user",
        forceFreshSession: true,
        issueId: "issue-123",
        taskId: "issue-123",
        taskKey: "issue-123",
        commentId: "comment-123",
        wakeCommentId: "comment-123",
      }),
      "manual",
      expect.objectContaining({
        actorType: "user",
        actorId: "board-user",
      }),
    );
  });

  it("includes routine execution issues in agent inbox-lite", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "TCN-158",
        title: "Despachar fila de revisão para Revisor PR",
        status: "todo",
        priority: "high",
        projectId: "project-1",
        goalId: "goal-1",
        parentId: "parent-1",
        createdAt: new Date("2026-03-30T18:00:00.000Z"),
        updatedAt: new Date("2026-03-30T18:11:22.699Z"),
        activeRun: null,
        originKind: "routine_execution",
      },
    ]);

    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      source: "api_key",
    });

    const res = await request(app).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(companyId, {
      assigneeAgentId: agentId,
      status: "todo,in_progress,changes_requested,claimed,blocked",
      includeRoutineExecutions: true,
    });
    expect(res.body).toEqual([
      expect.objectContaining({
        identifier: "TCN-158",
        title: "Despachar fila de revisão para Revisor PR",
        status: "todo",
      }),
    ]);
  });

  it("sorts inbox-lite so changes_requested ranks before todo at equal priority", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-todo",
        identifier: "TCN-10",
        title: "New work",
        status: "todo",
        priority: "medium",
        projectId: null,
        goalId: null,
        parentId: null,
        createdAt: new Date("2026-03-29T12:00:00.000Z"),
        updatedAt: new Date("2026-03-30T20:00:00.000Z"),
        activeRun: null,
        originKind: "manual",
      },
      {
        id: "issue-chg",
        identifier: "TCN-11",
        title: "Rework after review",
        status: "changes_requested",
        priority: "medium",
        projectId: null,
        goalId: null,
        parentId: null,
        createdAt: new Date("2026-03-28T12:00:00.000Z"),
        updatedAt: new Date("2026-03-30T10:00:00.000Z"),
        activeRun: null,
        originKind: "manual",
      },
    ]);

    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      source: "api_key",
    });

    const res = await request(app).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(res.body.map((row: { identifier: string }) => row.identifier)).toEqual(["TCN-11", "TCN-10"]);
  });

  it("sorts inbox-lite todos FIFO by createdAt when status and priority tie (older first)", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-new",
        identifier: "TCN-20",
        title: "New todo",
        status: "todo",
        priority: "medium",
        projectId: null,
        goalId: null,
        parentId: null,
        createdAt: new Date("2026-04-02T12:00:00.000Z"),
        updatedAt: new Date("2026-04-04T10:00:00.000Z"),
        activeRun: null,
        originKind: "manual",
      },
      {
        id: "issue-old",
        identifier: "TCN-19",
        title: "Stale todo",
        status: "todo",
        priority: "medium",
        projectId: null,
        goalId: null,
        parentId: null,
        createdAt: new Date("2026-03-01T12:00:00.000Z"),
        updatedAt: new Date("2026-03-05T10:00:00.000Z"),
        activeRun: null,
        originKind: "manual",
      },
    ]);

    const app = createApp({
      type: "agent",
      agentId,
      companyId,
      source: "api_key",
    });

    const res = await request(app).get("/api/agents/me/inbox-lite");

    expect(res.status).toBe(200);
    expect(res.body.map((row: { identifier: string }) => row.identifier)).toEqual(["TCN-19", "TCN-20"]);
  });
});
