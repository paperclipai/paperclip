import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TARGET_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  updatePermissions: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  resolveByReference: vi.fn(),
  getChainOfCommand: vi.fn(),
  activatePendingApproval: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({ create: vi.fn(), getById: vi.fn() }));
const mockBudgetService = vi.hoisted(() => ({ upsertPolicy: vi.fn() }));
const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
}));
const mockIssueApprovalService = vi.hoisted(() => ({ linkManyForApproval: vi.fn() }));
const mockIssueService = vi.hoisted(() => ({ list: vi.fn() }));
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
const mockInstanceSettingsService = vi.hoisted(() => ({ getGeneral: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());

const mockAdapter = vi.hoisted(() => ({
  listSkills: vi.fn(),
  syncSkills: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../routes/agents.js", async () => vi.importActual("../routes/agents.js"));
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
  vi.doMock("../middleware/index.js", async () => vi.importActual("../middleware/index.js"));
  vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>(
      "@paperclipai/adapter-opencode-local/server",
    );
    return {
      ...actual,
      ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable,
    };
  });

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: mockTrackAgentCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(() => mockAdapter),
    findActiveServerAdapter: vi.fn(() => mockAdapter),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
  }));
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    budgetService: () => mockBudgetService,
    companySkillService: () => mockCompanySkillService,
    environmentService: () => mockEnvironmentService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => mockIssueService,
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));
  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
}

function createDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          { id: COMPANY_ID, requireBoardApprovalForNewAgents: false },
        ]),
      })),
    })),
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/agents.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDb() as any));
  app.use(errorHandler);
  return app;
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_AGENT_ID,
    companyId: COMPANY_ID,
    name: "Target",
    urlKey: "target",
    role: "engineer",
    title: "Target",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeActorAgent(overrides: Record<string, unknown> = {}) {
  return makeAgent({
    id: ACTOR_AGENT_ID,
    urlKey: "actor",
    name: "Actor",
    title: "Actor",
    ...overrides,
  });
}

describe.sequential("POST /agents/:id/skills/sync — narrow grant fall-through", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("@paperclipai/adapter-opencode-local/server");
    registerModuleMocks();
    vi.resetAllMocks();

    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === TARGET_AGENT_ID) return makeAgent();
      if (id === ACTOR_AGENT_ID) return makeActorAgent();
      return null;
    });
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: makeAgent() });
    mockAgentService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => ({
        ...makeAgent(),
        adapterConfig: patch.adapterConfig ?? {},
      }),
    );
    mockAgentService.updatePermissions.mockResolvedValue(makeAgent());
    mockAgentService.rollbackConfigRevision.mockResolvedValue(makeAgent());
    mockAgentService.activatePendingApproval.mockResolvedValue({
      agent: makeAgent(),
      activated: false,
    });

    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);

    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_companyId: string, config: Record<string, unknown>) => config,
    );
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({ config: { env: {} } });

    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => requested,
    );

    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: [],
      entries: [],
      warnings: [],
    });
    mockAdapter.syncSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: [],
      entries: [],
      warnings: [],
    });

    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>, files: Record<string, string>) => ({
        bundle: null,
        adapterConfig: {
          ...((agent.adapterConfig as Record<string, unknown> | undefined) ?? {}),
          promptTemplate: files["AGENTS.md"] ?? "",
        },
      }),
    );

    mockInstanceSettingsService.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  function actorAgentCaller() {
    return {
      type: "agent" as const,
      agentId: ACTOR_AGENT_ID,
      companyId: COMPANY_ID,
      source: "agent_key" as const,
      runId: "run-1",
      companyIds: [COMPANY_ID],
    };
  }

  it("403s when actor is an agent without agents:create or agents:skills:sync", async () => {
    mockAccessService.hasPermission.mockResolvedValue(false);

    const app = await createApp(actorAgentCaller());

    const res = await request(app)
      .post(`/api/agents/${TARGET_AGENT_ID}/skills/sync`)
      .send({ desiredSkills: [] });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("200s when actor holds agents:skills:sync and does NOT hold agents:create", async () => {
    mockAccessService.hasPermission.mockImplementation(
      async (
        _companyId: string,
        _principalType: string,
        _principalId: string,
        permissionKey: string,
      ) => permissionKey === "agents:skills:sync",
    );

    const app = await createApp(actorAgentCaller());

    const res = await request(app)
      .post(`/api/agents/${TARGET_AGENT_ID}/skills/sync`)
      .send({ desiredSkills: [] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      TARGET_AGENT_ID,
      expect.any(Object),
      expect.objectContaining({
        recordRevision: expect.objectContaining({
          source: "skill-sync",
          createdByAgentId: ACTOR_AGENT_ID,
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.skills_synced",
        agentId: ACTOR_AGENT_ID,
        entityId: TARGET_AGENT_ID,
      }),
    );
  });

  it("does NOT leak into PATCH /agents/:id when only agents:skills:sync is granted", async () => {
    mockAccessService.hasPermission.mockImplementation(
      async (
        _companyId: string,
        _principalType: string,
        _principalId: string,
        permissionKey: string,
      ) => permissionKey === "agents:skills:sync",
    );

    const app = await createApp(actorAgentCaller());

    const res = await request(app)
      .patch(`/api/agents/${TARGET_AGENT_ID}`)
      .send({ title: "renamed" });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalledWith(
      TARGET_AGENT_ID,
      expect.objectContaining({ title: "renamed" }),
      expect.anything(),
    );
  });

  it("does NOT leak into POST /agents/:id/config-revisions/:revisionId/rollback when only agents:skills:sync is granted", async () => {
    mockAccessService.hasPermission.mockImplementation(
      async (
        _companyId: string,
        _principalType: string,
        _principalId: string,
        permissionKey: string,
      ) => permissionKey === "agents:skills:sync",
    );

    const app = await createApp(actorAgentCaller());

    const res = await request(app)
      .post(`/api/agents/${TARGET_AGENT_ID}/config-revisions/rev-1/rollback`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
  });

  it("still 200s for self-sync without any narrow grant (fall-through to assertCanUpdateAgent)", async () => {
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) =>
      id === TARGET_AGENT_ID ? makeAgent() : makeAgent({ id }),
    );

    const app = await createApp({
      type: "agent",
      agentId: TARGET_AGENT_ID,
      companyId: COMPANY_ID,
      source: "agent_key",
      runId: "run-1",
      companyIds: [COMPANY_ID],
    });

    const res = await request(app)
      .post(`/api/agents/${TARGET_AGENT_ID}/skills/sync`)
      .send({ desiredSkills: [] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("still 200s for CEO actor without any narrow grant", async () => {
    mockAccessService.hasPermission.mockResolvedValue(false);
    const ceoAgent = makeActorAgent({ role: "ceo" });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === TARGET_AGENT_ID) return makeAgent();
      if (id === ACTOR_AGENT_ID) return ceoAgent;
      return null;
    });

    const app = await createApp(actorAgentCaller());

    const res = await request(app)
      .post(`/api/agents/${TARGET_AGENT_ID}/skills/sync`)
      .send({ desiredSkills: [] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe.sequential("PATCH /agents/:id/permissions — canSyncOtherAgentSkills mirror", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("@paperclipai/adapter-opencode-local/server");
    registerModuleMocks();
    vi.resetAllMocks();

    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.updatePermissions.mockResolvedValue(makeAgent());
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: makeAgent() });

    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);

    mockInstanceSettingsService.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("mirrors canSyncOtherAgentSkills=true into the agents:skills:sync principal grant", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [COMPANY_ID],
    });

    const res = await request(app)
      .patch(`/api/agents/${TARGET_AGENT_ID}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: false, canSyncOtherAgentSkills: true });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      COMPANY_ID,
      "agent",
      TARGET_AGENT_ID,
      "agents:skills:sync",
      true,
      "board-user",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.permissions_updated",
        details: expect.objectContaining({
          canSyncOtherAgentSkills: true,
        }),
      }),
    );
  });

  it("clears agents:skills:sync grant when canSyncOtherAgentSkills is false and no implicit coupling", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [COMPANY_ID],
    });

    const res = await request(app)
      .patch(`/api/agents/${TARGET_AGENT_ID}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: false, canSyncOtherAgentSkills: false });

    expect(res.status).toBe(200);
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      COMPANY_ID,
      "agent",
      TARGET_AGENT_ID,
      "agents:skills:sync",
      false,
      "board-user",
    );
  });

  it("keeps agents:skills:sync grant enabled when agent has canCreateAgents (implicit coupling)", async () => {
    mockAgentService.updatePermissions.mockResolvedValue(
      makeAgent({ permissions: { canCreateAgents: true } }),
    );

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [COMPANY_ID],
    });

    const res = await request(app)
      .patch(`/api/agents/${TARGET_AGENT_ID}/permissions`)
      .send({ canCreateAgents: true, canAssignTasks: false, canSyncOtherAgentSkills: false });

    expect(res.status).toBe(200);
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      COMPANY_ID,
      "agent",
      TARGET_AGENT_ID,
      "agents:skills:sync",
      true,
      "board-user",
    );
  });

  it("defaults canSyncOtherAgentSkills to false when omitted (backwards compatible payload)", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [COMPANY_ID],
    });

    const res = await request(app)
      .patch(`/api/agents/${TARGET_AGENT_ID}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: false });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      COMPANY_ID,
      "agent",
      TARGET_AGENT_ID,
      "agents:skills:sync",
      false,
      "board-user",
    );
  });
});
