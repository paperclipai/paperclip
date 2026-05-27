import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const actorAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const targetAgentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const failedRunId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const activeIssueId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const baseTargetAgent = {
  id: targetAgentId,
  companyId,
  name: "Target",
  urlKey: "target",
  role: "engineer",
  title: "Target Agent",
  icon: null,
  status: "error",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: {},
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  activatePendingApproval: vi.fn(),
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
  addComment: vi.fn(),
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
const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

// DB stub that captures SQL queries for reset-infrastructure tests
let dbStubOverride: Record<string, unknown> | null = null;

function createDbStub(options: {
  lastFailedRunCauseClass?: string | null | undefined;
  activeIssueId?: string | null;
} = {}) {
  if (dbStubOverride) return dbStubOverride;

  const causeClass = options.lastFailedRunCauseClass;
  const resolvedCauseClass = causeClass === undefined ? "infrastructure" : causeClass;
  const issueId = options.activeIssueId ?? activeIssueId;

  // Track select call count: first select().from().where().orderBy().limit() is the runs query,
  // second is the issues query.
  let limitCallCount = 0;

  return {
    select: vi.fn().mockImplementation(() => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      chain.orderBy = vi.fn().mockReturnValue(chain);
      chain.limit = vi.fn().mockImplementation((_n: number) => {
        limitCallCount++;
        if (limitCallCount === 1) {
          // Runs query
          if (resolvedCauseClass === null) {
            return Promise.resolve([]);
          }
          return Promise.resolve([{ id: failedRunId, processLossCauseClass: resolvedCauseClass }]);
        }
        // Issues query
        return Promise.resolve(issueId ? [{ id: issueId }] : []);
      });
      chain.then = vi.fn((resolve: (v: unknown) => unknown) =>
        Promise.resolve(resolve([{ id: issueId }])),
      );
      return chain;
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockReturnValue({
            then: vi.fn((resolve: (v: unknown) => unknown) =>
              Promise.resolve(resolve([{ ...baseTargetAgent, status: "idle", pauseReason: null }])),
            ),
          }),
        }),
      }),
    }),
    transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(Promise.resolve()),
        }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue(Promise.resolve()),
        }),
      };
      return fn(tx);
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue(Promise.resolve()),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(Promise.resolve()),
    }),
  };
}

function registerModuleMocks() {
  vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>("@paperclipai/adapter-opencode-local/server");
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

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/approvals.js", () => ({
    approvalService: () => mockApprovalService,
  }));

  vi.doMock("../services/company-skills.js", () => ({
    companySkillService: () => mockCompanySkillService,
  }));

  vi.doMock("../services/budgets.js", () => ({
    budgetService: () => mockBudgetService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/issue-approvals.js", () => ({
    issueApprovalService: () => mockIssueApprovalService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/agent-instructions.js", () => ({
    agentInstructionsService: () => mockAgentInstructionsService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  }));

  vi.doMock("../services/workspace-operations.js", () => ({
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
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
    environmentService: () => mockEnvironmentService,
  }));
}

async function createApp(actor: Record<string, unknown>, dbOptions: Parameters<typeof createDbStub>[0] = {}) {
  const [{ errorHandler }, { agentRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/agents.js") as Promise<typeof import("../routes/agents.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes(createDbStub(dbOptions) as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

const boardActor = {
  type: "board",
  userId: "board-user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: [companyId],
};

const agentActor = {
  type: "agent",
  agentId: actorAgentId,
  companyId,
  companyIds: [companyId],
};

describe.sequential("POST /agents/:id/reset-infrastructure-status", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agent-instructions.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/approvals.js");
    vi.doUnmock("../services/budgets.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issue-approvals.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/secrets.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/workspace-operations.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("@paperclipai/adapter-opencode-local/server");
    registerModuleMocks();
    vi.resetAllMocks();
    dbStubOverride = null;

    mockAgentService.getById.mockResolvedValue({ ...baseTargetAgent });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.decide.mockImplementation(async () => ({ allowed: true, reason: "allow_explicit_grant", explanation: "" }));
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.getMembership.mockResolvedValue({ id: "m-1", companyId, principalType: "agent", principalId: targetAgentId, status: "active", membershipRole: "member", createdAt: new Date(), updatedAt: new Date() });
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockLogActivity.mockResolvedValue(undefined);
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(async (_id: string, keys: string[]) => keys);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_id: string, cfg: unknown) => cfg);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_id: string, cfg: unknown) => ({ config: cfg }));
  });

  it("rejects self-reset: actor cannot reset itself (403)", async () => {
    const selfActor = { ...agentActor, agentId: targetAgentId };
    const app = await createApp(selfActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${targetAgentId}/reset-infrastructure-status`)
        .send({ comment: "trying to self-reset" }),
    );
    expect(res.status).toBe(403);
  }, 20_000);

  it("rejects caller without agents.status.reset_infrastructure grant (403)", async () => {
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.canUser.mockResolvedValue(false);
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${targetAgentId}/reset-infrastructure-status`)
        .send({ comment: "reset attempt" }),
    );
    expect(res.status).toBe(403);
  }, 20_000);

  it("rejects agent with status 'idle' — not eligible (422)", async () => {
    mockAgentService.getById.mockResolvedValue({ ...baseTargetAgent, status: "idle" });
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${targetAgentId}/reset-infrastructure-status`)
        .send({ comment: "reset attempt" }),
    );
    expect(res.status).toBe(422);
  }, 20_000);

  it("rejects Class A failure (provider limit, causeClass != infrastructure) (422)", async () => {
    // Simulate last run had causeClass = 'agent' (no infra signals)
    const app = await createApp(boardActor, { lastFailedRunCauseClass: "agent" });
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${targetAgentId}/reset-infrastructure-status`)
        .send({ comment: "provider limit reset" }),
    );
    expect(res.status).toBe(422);
  }, 20_000);

  it("rejects when no failed run exists (422)", async () => {
    const app = await createApp(boardActor, { lastFailedRunCauseClass: null });
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${targetAgentId}/reset-infrastructure-status`)
        .send({ comment: "reset attempt" }),
    );
    expect(res.status).toBe(422);
  }, 20_000);

  it("succeeds for Class B (infrastructure) with error status and writes audit comment (200)", async () => {
    const app = await createApp(boardActor, { lastFailedRunCauseClass: "infrastructure" });
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${targetAgentId}/reset-infrastructure-status`)
        .send({ comment: "host was unstable, resetting" }),
    );
    expect(res.status).toBe(200);
    // audit comment must have been written
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      activeIssueId,
      expect.stringContaining("Infrastructure Status Reset"),
      expect.any(Object),
    );
    // audit comment must contain required fields
    const body = mockIssueService.addComment.mock.calls[0][1] as string;
    expect(body).toContain("actor");
    expect(body).toContain("target_agent");
    expect(body).toContain("prev_state");
    expect(body).toContain("new_state");
    expect(body).toContain("host was unstable");
  }, 20_000);

  it("succeeds for paused agent with host_unstable pauseReason (200)", async () => {
    mockAgentService.getById.mockResolvedValue({ ...baseTargetAgent, status: "paused", pauseReason: "host_unstable" });
    const app = await createApp(boardActor, { lastFailedRunCauseClass: "infrastructure" });
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${targetAgentId}/reset-infrastructure-status`)
        .send({ comment: "host_unstable reset" }),
    );
    expect(res.status).toBe(200);
  }, 20_000);

  it("agent without grant receives 403 even if board actor has it", async () => {
    // Agent actor without the grant
    mockAccessService.hasPermission.mockResolvedValue(false);
    const app = await createApp(agentActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .post(`/api/agents/${targetAgentId}/reset-infrastructure-status`)
        .send({ comment: "attempt from unpermissioned agent" }),
    );
    expect(res.status).toBe(403);
  }, 20_000);
});

describe.sequential("PUT /agents/:id/grants", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agent-instructions.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/approvals.js");
    vi.doUnmock("../services/budgets.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issue-approvals.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/secrets.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/workspace-operations.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("@paperclipai/adapter-opencode-local/server");
    registerModuleMocks();
    vi.resetAllMocks();
    dbStubOverride = null;

    mockAgentService.getById.mockResolvedValue({ ...baseTargetAgent });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.decide.mockImplementation(async () => ({ allowed: true, reason: "allow_explicit_grant", explanation: "" }));
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(async (_id: string, keys: string[]) => keys);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_id: string, cfg: unknown) => cfg);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_id: string, cfg: unknown) => ({ config: cfg }));
  });

  it("PUT /agents/:id/grants replaces grants successfully (200)", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .put(`/api/agents/${targetAgentId}/grants`)
        .send({ grants: [{ permissionKey: "agents.status.reset_infrastructure" }] }),
    );
    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "agent.grants_updated" }),
    );
  }, 20_000);

  it("DELETE /agents/:id/grants removes a specific grant (204)", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base)
        .delete(`/api/agents/${targetAgentId}/grants`)
        .send({ permissionKey: "agents.status.reset_infrastructure" }),
    );
    expect(res.status).toBe(204);
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      companyId,
      "agent",
      targetAgentId,
      "agents.status.reset_infrastructure",
      false,
      expect.anything(),
    );
  }, 20_000);
});
