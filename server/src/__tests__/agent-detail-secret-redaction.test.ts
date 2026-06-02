import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const SECRET_DEVICE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIMzFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEF\n-----END PRIVATE KEY-----\n";
const SECRET_DEVICE_TOKEN = "fake-device-token-43-char-fixture-FAKEFAKEFAKE";
const SECRET_GATEWAY_TOKEN = "fake-gateway-token-64-char-fixture-FAKEFAKEFAKEFAKEFAKEFAKEFAK";
const SECRET_SESSION_KEY = "fake-session-key-fixture";
const SECRET_ENV_API_KEY = "sk-fake-env-api-key-fixture-not-real";

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
  adapterType: "openclaw_gateway",
  adapterConfig: {
    url: "ws://example.invalid:18789/",
    deviceFamily: "linux",
    scopes: ["operator.read", "operator.write"],
    paperclipApiUrl: "http://api.example.invalid:3100",
    waitTimeoutMs: 120000,
    headers: { "x-openclaw-token": SECRET_GATEWAY_TOKEN },
    devicePrivateKeyPem: SECRET_DEVICE_KEY,
    deviceToken: SECRET_DEVICE_TOKEN,
    sessionKey: SECRET_SESSION_KEY,
    env: { SAMPLE_API_KEY: SECRET_ENV_API_KEY },
  },
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-04-29T00:00:00.000Z"),
  updatedAt: new Date("2026-04-29T00:00:00.000Z"),
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
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({ create: vi.fn(), getById: vi.fn() }));
const mockBudgetService = vi.hoisted(() => ({ upsertPolicy: vi.fn() }));
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
const mockAgentInstructionsService = vi.hoisted(() => ({ materializeManagedBundle: vi.fn() }));
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
const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockInstanceSettingsService = vi.hoisted(() => ({ getGeneral: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>(
      "@paperclipai/adapter-opencode-local/server",
    );
    return { ...actual, ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable };
  });
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: mockTrackAgentCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({ getTelemetryClient: mockGetTelemetryClient }));
  vi.doMock("../services/agents.js", () => ({ agentService: () => mockAgentService }));
  vi.doMock("../services/access.js", () => ({ accessService: () => mockAccessService }));
  vi.doMock("../services/approvals.js", () => ({ approvalService: () => mockApprovalService }));
  vi.doMock("../services/company-skills.js", () => ({ companySkillService: () => mockCompanySkillService }));
  vi.doMock("../services/budgets.js", () => ({ budgetService: () => mockBudgetService }));
  vi.doMock("../services/heartbeat.js", () => ({ heartbeatService: () => mockHeartbeatService }));
  vi.doMock("../services/issue-approvals.js", () => ({ issueApprovalService: () => mockIssueApprovalService }));
  vi.doMock("../services/issues.js", () => ({ issueService: () => mockIssueService }));
  vi.doMock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
  vi.doMock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
  vi.doMock("../services/agent-instructions.js", () => ({
    agentInstructionsService: () => mockAgentInstructionsService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  }));
  vi.doMock("../services/workspace-operations.js", () => ({
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));
  vi.doMock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
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

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve) =>
            Promise.resolve(
              resolve([{ id: companyId, name: "Paperclip", requireBoardApprovalForNewAgents: false }]),
            ),
          ),
        }),
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
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
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

describe.sequential("agent detail secret redaction", () => {
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
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.list.mockResolvedValue([baseAgent]);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.getMembership.mockResolvedValue({
      id: "membership-1",
      companyId,
      principalType: "agent",
      principalId: agentId,
      role: "member",
      status: "active",
    });
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
    mockLogActivity.mockResolvedValue(undefined);
  });

  function assertNoSecretLeaks(body: unknown) {
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET_DEVICE_KEY);
    expect(text).not.toContain(SECRET_DEVICE_TOKEN);
    expect(text).not.toContain(SECRET_GATEWAY_TOKEN);
    expect(text).not.toContain(SECRET_SESSION_KEY);
    expect(text).not.toContain(SECRET_ENV_API_KEY);
  }

  it("GET /api/agents/me omits adapterConfig secrets, preserves non-secret fields, includes builder shape", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/agents/me"));

    expect(res.status).toBe(200);

    expect(res.body.adapterConfig).toBeDefined();
    expect(res.body.adapterConfig.devicePrivateKeyPem).toBeUndefined();
    expect(res.body.adapterConfig.deviceToken).toBeUndefined();
    expect(res.body.adapterConfig.headers).toBeUndefined();
    expect(res.body.adapterConfig.sessionKey).toBeUndefined();

    expect(res.body.adapterConfig.url).toBe("ws://example.invalid:18789/");
    expect(res.body.adapterConfig.deviceFamily).toBe("linux");
    expect(res.body.adapterConfig.scopes).toEqual(["operator.read", "operator.write"]);
    expect(res.body.adapterConfig.paperclipApiUrl).toBe("http://api.example.invalid:3100");
    expect(res.body.adapterConfig.waitTimeoutMs).toBe(120000);

    expect(res.body.adapterConfig.env).toBeDefined();
    expect(res.body.adapterConfig.env.SAMPLE_API_KEY).toBe("***REDACTED***");

    expect(res.body.id).toBe(agentId);
    expect(res.body.role).toBe("engineer");
    expect(res.body.chainOfCommand).toBeDefined();
    expect(res.body.access).toBeDefined();

    assertNoSecretLeaks(res.body);
  });

  it("GET /api/agents/:id self path omits adapterConfig secrets", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.devicePrivateKeyPem).toBeUndefined();
    expect(res.body.adapterConfig.deviceToken).toBeUndefined();
    expect(res.body.adapterConfig.headers).toBeUndefined();
    expect(res.body.adapterConfig.sessionKey).toBeUndefined();
    expect(res.body.adapterConfig.url).toBe("ws://example.invalid:18789/");
    expect(res.body.chainOfCommand).toBeDefined();

    assertNoSecretLeaks(res.body);
  });

  it("GET /api/companies/:companyId/agents admin path omits adapterConfig secrets in each list entry", async () => {
    const app = await createApp({
      type: "board",
      userId: "instance-admin",
      source: "local_implicit",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents`),
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);

    const [first] = res.body;
    expect(first.adapterConfig).toBeDefined();
    expect(first.adapterConfig.devicePrivateKeyPem).toBeUndefined();
    expect(first.adapterConfig.deviceToken).toBeUndefined();
    expect(first.adapterConfig.headers).toBeUndefined();
    expect(first.adapterConfig.sessionKey).toBeUndefined();
    expect(first.adapterConfig.url).toBe("ws://example.invalid:18789/");
    expect(first.adapterConfig.env).toBeDefined();
    expect(first.adapterConfig.env.SAMPLE_API_KEY).toBe("***REDACTED***");

    expect(first.chainOfCommand).toBeUndefined();
    expect(first.access).toBeUndefined();

    assertNoSecretLeaks(res.body);
  });

  it("PATCH /api/agents/:id/permissions response omits adapterConfig secrets", async () => {
    mockAgentService.updatePermissions.mockResolvedValue(baseAgent);

    const app = await createApp({
      type: "board",
      userId: "instance-admin",
      source: "local_implicit",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}/permissions`)
        .send({ canCreateAgents: false, canAssignTasks: false }),
    );

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig).toBeDefined();
    expect(res.body.adapterConfig.devicePrivateKeyPem).toBeUndefined();
    expect(res.body.adapterConfig.deviceToken).toBeUndefined();
    expect(res.body.adapterConfig.headers).toBeUndefined();
    expect(res.body.adapterConfig.sessionKey).toBeUndefined();
    expect(res.body.adapterConfig.url).toBe("ws://example.invalid:18789/");
    expect(res.body.adapterConfig.env).toBeDefined();
    expect(res.body.adapterConfig.env.SAMPLE_API_KEY).toBe("***REDACTED***");

    expect(res.body.chainOfCommand).toBeDefined();
    expect(res.body.access).toBeDefined();

    assertNoSecretLeaks(res.body);
  });
});
