import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const targetAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const callerAgentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const crossTeamAgentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const managerAgentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const companyId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const sharedReportsTo = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const targetAgent = {
  id: targetAgentId,
  companyId,
  name: "Target Agent",
  urlKey: "target",
  role: "engineer",
  title: "Target Agent",
  reportsTo: sharedReportsTo,
  status: "idle",
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
};

const callerAgent = {
  id: callerAgentId,
  companyId,
  name: "Caller Agent",
  urlKey: "caller",
  role: "engineer",
  title: "Caller Agent",
  reportsTo: sharedReportsTo, // same team as target
  status: "idle",
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
};

const crossTeamAgent = {
  id: crossTeamAgentId,
  companyId,
  name: "Cross-Team Agent",
  urlKey: "crossteam",
  role: "engineer",
  title: "Cross-Team Agent",
  reportsTo: "11111111-1111-4111-8111-111111111111", // different team
  status: "idle",
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
};

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  cancelInvocationsForAgents: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  activatePendingApproval: vi.fn(),
  terminate: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  findOpenHireApprovalForAgent: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));
const mockBudgetService = vi.hoisted(() => ({ upsertPolicy: vi.fn() }));
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
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockInstanceSettingsService = vi.hoisted(() => ({ getGeneral: vi.fn() }));
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>(
      "@paperclipai/adapter-opencode-local/server"
    );
    return { ...actual, ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable };
  });

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: mockTrackAgentCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({ getTelemetryClient: mockGetTelemetryClient }));

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
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
}

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve) =>
            Promise.resolve(resolve([{ id: companyId, name: "Acme", requireBoardApprovalForNewAgents: false }]))
          ),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { agentRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/agents.js") as Promise<typeof import("../routes/agents.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor.type === "board"
      ? { ...actor, companyIds: Array.isArray(actor.companyIds) ? [...(actor.companyIds as string[])] : actor.companyIds }
      : { ...actor };
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(app: express.Express, buildRequest: (baseUrl: string) => request.Test) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => { if (err) reject(err); else resolve(); });
      });
    }
  }
}

describe.sequential("POST /agents/:id/sessions/reset", () => {
  beforeEach(() => {
    vi.resetModules();
    registerModuleMocks();
    mockAgentService.getById.mockResolvedValue(targetAgent);
    mockHeartbeatService.listTaskSessions.mockResolvedValue([{ sessionId: "sess-123" }]);
    mockHeartbeatService.resetRuntimeSession.mockResolvedValue({ sessionId: null });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("board caller can reset any agent session", async () => {
    const app = await createApp({
      type: "board",
      companyIds: [companyId],
      userId: "user-1",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/agents/${targetAgentId}/sessions/reset`)
        .send({ reason: "stuck session" })
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("reset");
    expect(res.body.agentId).toBe(targetAgentId);
    expect(mockHeartbeatService.resetRuntimeSession).toHaveBeenCalledWith(targetAgentId, {});
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "agent.session.reset", entityId: targetAgentId })
    );
  });

  it("same-team peer agent can reset target session", async () => {
    // callerAgent has same reportsTo as targetAgent → peer
    mockAgentService.getById.mockImplementation((id: string) => {
      if (id === targetAgentId) return Promise.resolve(targetAgent);
      if (id === callerAgentId) return Promise.resolve(callerAgent);
      return Promise.resolve(null);
    });

    const app = await createApp({
      type: "agent",
      agentId: callerAgentId,
      companyId,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/agents/${targetAgentId}/sessions/reset`)
        .send({ reason: "peer reset" })
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("reset");
  });

  it("agent can reset its own session", async () => {
    const app = await createApp({
      type: "agent",
      agentId: targetAgentId,
      companyId,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/agents/${targetAgentId}/sessions/reset`)
        .send({ reason: "self-reset" })
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("reset");
  });

  it("cross-team agent is forbidden", async () => {
    mockAgentService.getById.mockImplementation((id: string) => {
      if (id === targetAgentId) return Promise.resolve(targetAgent);
      if (id === crossTeamAgentId) return Promise.resolve(crossTeamAgent);
      return Promise.resolve(null);
    });

    const app = await createApp({
      type: "agent",
      agentId: crossTeamAgentId,
      companyId,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/agents/${targetAgentId}/sessions/reset`)
        .send({ reason: "unauthorized attempt" })
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not in the same team scope/i);
  });

  it("returns no_session when no active session exists (idempotency)", async () => {
    mockHeartbeatService.listTaskSessions.mockResolvedValue([]);

    const app = await createApp({
      type: "board",
      companyIds: [companyId],
      userId: "user-1",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/agents/${targetAgentId}/sessions/reset`)
        .send({ reason: "idempotent call" })
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_session");
    expect(mockHeartbeatService.resetRuntimeSession).not.toHaveBeenCalled();
  });

  it("returns 404 when target agent does not exist", async () => {
    mockAgentService.getById.mockResolvedValue(null);

    const app = await createApp({
      type: "board",
      companyIds: [companyId],
      userId: "user-1",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/agents/${targetAgentId}/sessions/reset`)
        .send({ reason: "nonexistent agent" })
    );

    expect(res.status).toBe(404);
  });

  it("manager agent can reset direct report session", async () => {
    const managerAgent = {
      ...callerAgent,
      id: managerAgentId,
      reportsTo: null, // manager has no reportsTo (or different)
    };
    // target.reportsTo === managerAgentId → manager relationship
    const targetUnderManager = { ...targetAgent, reportsTo: managerAgentId };

    mockAgentService.getById.mockImplementation((id: string) => {
      if (id === targetAgentId) return Promise.resolve(targetUnderManager);
      if (id === managerAgentId) return Promise.resolve(managerAgent);
      return Promise.resolve(null);
    });

    const app = await createApp({
      type: "agent",
      agentId: managerAgentId,
      companyId,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/agents/${targetAgentId}/sessions/reset`)
        .send({ reason: "manager resets report" })
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("reset");
  });
});
