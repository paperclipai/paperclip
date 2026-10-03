import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const companyId = "22222222-2222-4222-8222-222222222222";
const actorAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: peerAgentId,
    companyId,
    name: "Peer",
    urlKey: "peer",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: { cwd: "/repo", model: "gpt-5", env: { API_KEY: "secret-value" } },
    runtimeConfig: { heartbeat: { enabled: true } },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-03-19T00:00:00.000Z"),
    updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    ...overrides,
  };
}

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  getChainOfCommand: vi.fn(),
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

const mockAgentInstructionsService = vi.hoisted(() => ({}));
const mockApprovalService = vi.hoisted(() => ({}));
const mockBuiltInAgentService = vi.hoisted(() => ({}));
const mockBudgetService = vi.hoisted(() => ({}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({}));
const mockIssueService = vi.hoisted(() => ({ list: vi.fn() }));
const mockEnvironmentService = vi.hoisted(() => ({}));
const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockInstanceSettingsService = vi.hoisted(() => ({ getGeneral: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
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
    agentInstructionsBundleMode: () => "managed",
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
    builtInAgentService: () => mockBuiltInAgentService,
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

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve) =>
            Promise.resolve(
              resolve([
                {
                  id: companyId,
                  name: "Paperclip",
                  requireBoardApprovalForNewAgents: false,
                },
              ]),
            ),
          ),
        }),
      }),
    }),
  };
}

describe.sequential("agent configuration redaction is observable", () => {
  const routeModules = hoistModuleGraph(registerModuleMocks, async () => {
    const [{ errorHandler }, { agentRoutes }] = await Promise.all([
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
      vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    ]);
    return { errorHandler, agentRoutes };
  }, { loadTimeoutMs: 120_000 });

  const peerActor = {
    type: "agent",
    agentId: actorAgentId,
    companyId,
    companyIds: [companyId],
  };

  function createApp(actor: Record<string, unknown>) {
    const { errorHandler, agentRoutes } = routeModules.value;
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

  beforeEach(() => {
    vi.clearAllMocks();
    const peer = makeAgent();
    mockAgentService.getById.mockImplementation(async (id: string) =>
      id === peerAgentId ? peer : { ...peer, id: actorAgentId, name: "Actor", urlKey: "actor" },
    );
    mockAgentService.list.mockResolvedValue([peer]);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    // Peer reads are inside the boundary, but the actor does not hold
    // `agent_config:read` -- the exact condition this issue reports.
    mockAccessService.decide.mockImplementation(
      async ({ action }: { action: string }) => ({ allowed: action !== "agent_config:read" }),
    );
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.canUser.mockResolvedValue(false);
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
    });
  });

  it("marks a restricted peer read as redacted and still reports config key names", async () => {
    const res = await request(createApp(peerActor)).get(`/api/agents/${peerAgentId}`);

    expect(res.status).toBe(200);
    expect(res.body.configurationAccess).toBe("redacted");
    // Values stay hidden...
    expect(res.body.adapterConfig).toEqual({});
    expect(res.body.runtimeConfig).toEqual({});
    // ...but the caller can tell "redacted" from "genuinely empty" and can still
    // answer "is this agent configured?".
    expect(res.body.adapterConfigKeys).toEqual(["cwd", "env", "model"]);
    expect(res.body.runtimeConfigKeys).toEqual(["heartbeat"]);
  });

  it("never leaks config values through the key-name fields", async () => {
    const res = await request(createApp(peerActor)).get(`/api/agents/${peerAgentId}`);

    expect(JSON.stringify(res.body.adapterConfigKeys)).not.toContain("secret-value");
    expect(JSON.stringify(res.body.runtimeConfigKeys)).not.toContain("secret-value");
  });

  it("reports configurationAccess full on a self read", async () => {
    const res = await request(createApp(peerActor)).get(`/api/agents/${actorAgentId}`);

    expect(res.status).toBe(200);
    expect(res.body.configurationAccess).toBe("full");
    // Self-reads are never config-restricted; only values that are secret
    // bindings are masked on the way out.
    expect(res.body.adapterConfigKeys).toEqual(["cwd", "env", "model"]);
    expect(res.body.runtimeConfigKeys).toEqual(["heartbeat"]);
  });

  it("reports configurationAccess full for a caller that may read configs", async () => {
    mockAccessService.decide.mockResolvedValue({ allowed: true });

    const res = await request(createApp(peerActor)).get(`/api/agents/${peerAgentId}`);

    expect(res.status).toBe(200);
    expect(res.body.configurationAccess).toBe("full");
    expect(res.body.adapterConfigKeys).toEqual(["cwd", "env", "model"]);
  });

  it("marks restricted entries in the agent list too", async () => {
    const res = await request(createApp(peerActor)).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].configurationAccess).toBe("redacted");
    expect(res.body[0].adapterConfigKeys).toEqual(["cwd", "env", "model"]);
    expect(res.body[0].adapterConfig).toEqual({});
  });

  it("distinguishes a genuinely empty config from a redacted one", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {},
      runtimeConfig: {},
    });

    const res = await request(createApp(peerActor)).get(`/api/agents/${peerAgentId}`);

    expect(res.status).toBe(200);
    // Both read as an empty object, which is exactly the ambiguity this issue
    // reported -- the marker is what disambiguates them.
    expect(res.body.adapterConfig).toEqual({});
    expect(res.body.configurationAccess).toBe("redacted");
    expect(res.body.adapterConfigKeys).toEqual([]);
  });
});