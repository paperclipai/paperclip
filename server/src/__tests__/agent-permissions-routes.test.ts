import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  list: vi.fn(),
  create: vi.fn(),
  activatePendingApproval: vi.fn(),
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
  getRun: vi.fn(),
  cancelRun: vi.fn(),
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
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: mockTrackAgentCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));
}

function createDbStub(options: { requireBoardApprovalForNewAgents?: boolean } = {}) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve) =>
            Promise.resolve(resolve([{
              id: companyId,
              name: "Paperclip",
              requireBoardApprovalForNewAgents: options.requireBoardApprovalForNewAgents ?? false,
            }])),
          ),
        }),
      }),
    }),
  };
}

async function createApp(actor: Record<string, unknown>, dbOptions: { requireBoardApprovalForNewAgents?: boolean } = {}) {
  const [{ errorHandler }, { agentRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub(dbOptions) as any));
  app.use(errorHandler);
  return app;
}

describe("agent permission routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.list.mockResolvedValue([baseAgent]);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAgentService.create.mockResolvedValue(baseAgent);
    mockAgentService.activatePendingApproval.mockResolvedValue(baseAgent);
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
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => requested,
    );
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("redacts agent detail for authenticated company members without agent admin permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = await createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig).toEqual({});
    expect(res.body.runtimeConfig).toEqual({});
  });

  it("redacts company agent list for authenticated company members without agent admin permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = await createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: agentId,
        adapterConfig: {},
        runtimeConfig: {},
      }),
    ]);
  });

  it("blocks agent updates for authenticated company members without agent admin permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = await createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({ title: "Compromised" });

    expect(res.status).toBe(403);
  });

  it("blocks api key creation for authenticated company members without agent admin permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = await createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/agents/${agentId}/keys`)
      .send({ name: "backdoor" });

    expect(res.status).toBe(403);
  });

  it("blocks wakeups for authenticated company members without agent admin permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = await createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/agents/${agentId}/wakeup`)
      .send({});

    expect(res.status).toBe(403);
  });

  it("blocks agent-authenticated self-updates that set host-executed workspace commands", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          workspaceStrategy: {
            type: "git_worktree",
            provisionCommand: "touch /tmp/paperclip-rce",
          },
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("host-executed workspace commands");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("blocks agent-authenticated self-updates that set instructions bundle roots", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          instructionsRootPath: "/etc",
          instructionsEntryFile: "passwd",
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("instructions path or bundle configuration");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("blocks agent-authenticated instructions-path updates", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch(`/api/agents/${agentId}/instructions-path`)
      .send({ path: "/etc/passwd" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("instructions path or bundle configuration");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("blocks agent-authenticated hires that set instructions bundle config", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);

    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({
        name: "Injected",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {
          instructionsRootPath: "/etc",
          instructionsEntryFile: "passwd",
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("instructions path or bundle configuration");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("blocks direct agent creation for authenticated company members without agent create permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = await createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Backdoor",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("agents:create");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("allows direct agent creation for authenticated board users with agent create permission when approval is not required", async () => {
    mockAccessService.canUser.mockResolvedValue(true);

    const app = await createApp({
      type: "board",
      userId: "agent-admin-user",
      source: "session",
      isInstanceAdmin: false,
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
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        status: "idle",
      }),
    );
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "agent-admin-user",
    );
  });

  it("rejects direct agent creation when new agents require board approval", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
        companyIds: [companyId],
      },
      { requireBoardApprovalForNewAgents: true },
    );

    const res = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("/agent-hires");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("grants tasks:assign by default when board creates a new agent", async () => {
    const app = await createApp({
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

    expect([200, 201]).toContain(res.status);
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

  it("rejects unsupported query parameters on the agent list route", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/agents`)
      .query({ urlKey: "builder" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("urlKey");
    expect(mockAgentService.list).not.toHaveBeenCalled();
  });

  it("normalizes direct agent creation to disable timer heartbeats by default", async () => {
    const app = await createApp({
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
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
      });

    expect([200, 201]).toContain(res.status);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 3600,
            maxConcurrentRuns: 5,
          },
        },
      }),
    );
  });

  it("normalizes hire requests to disable timer heartbeats by default", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
      });

    expect(res.status).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 3600,
            maxConcurrentRuns: 5,
          },
        },
      }),
    );
  });

  it("allows board users to directly approve pending agents", async () => {
    const pendingAgent = {
      ...baseAgent,
      status: "pending_approval",
    };
    const approvedAgent = {
      ...baseAgent,
      status: "idle",
    };
    mockAgentService.getById.mockResolvedValue(pendingAgent);
    mockAgentService.activatePendingApproval.mockResolvedValue({
      agent: approvedAgent,
      activated: true,
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/agents/${agentId}/approve`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith(agentId);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "agent.approved",
      entityType: "agent",
      entityId: agentId,
      details: { source: "agent_detail" },
    }));
  });

  it("rejects direct approval for agents that are not pending approval", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await request(app)
      .post(`/api/agents/${agentId}/approve`)
      .send({});

    expect(res.status).toBe(409);
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent.approved",
    }));
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

    const app = await createApp({
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

    const app = await createApp({
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

  it("exposes a dedicated agent route for the inbox mine view", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-910",
        title: "Inbox follow-up",
        status: "todo",
      },
    ]);

    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
      source: "agent_key",
    });

    const res = await request(app)
      .get("/api/agents/me/inbox/mine")
      .query({ userId: "board-user" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "issue-1",
        identifier: "PAP-910",
        title: "Inbox follow-up",
        status: "todo",
      },
    ]);
    expect(mockIssueService.list).toHaveBeenCalledWith(companyId, {
      touchedByUserId: "board-user",
      inboxArchivedByUserId: "board-user",
      status: "backlog,todo,in_progress,in_review,blocked,done",
      limit: 500,
    });
  });

  it("rejects heartbeat cancellation outside the caller company scope", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "33333333-3333-4333-8333-333333333333",
      agentId,
      status: "running",
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await request(app).post("/api/heartbeat-runs/run-1/cancel").send({});

    expect(res.status).toBe(403);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });
});
