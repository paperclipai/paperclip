import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";

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
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  updatedAt: new Date("2026-04-11T00:00:00.000Z"),
};

const baseKey = {
  id: keyId,
  agentId,
  companyId,
  name: "exploit",
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  revokedAt: null,
};

let currentKeyAgentId = agentId;
let currentAccessCanUser = false;

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  getKeyById: vi.fn(),
  revokeKey: vi.fn(),
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
  cancelActiveForAgent: vi.fn(),
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
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../routes/authz.js", async () => {
  const { forbidden, unauthorized } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
  function assertAuthenticated(req: Express.Request) {
    if (req.actor.type === "none") {
      throw unauthorized();
    }
  }

  function assertBoard(req: Express.Request) {
    if (req.actor.type !== "board") {
      throw forbidden("Board access required");
    }
  }

  function assertCompanyAccess(req: Express.Request, expectedCompanyId: string) {
    assertAuthenticated(req);
    if (req.actor.type === "agent" && req.actor.companyId !== expectedCompanyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
      const allowedCompanies = req.actor.companyIds ?? [];
      if (!allowedCompanies.includes(expectedCompanyId)) {
        throw forbidden("User does not have access to this company");
      }
    }
  }

  function assertInstanceAdmin(req: Express.Request) {
    assertBoard(req);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    throw forbidden("Instance admin access required");
  }

  function getActorInfo(req: Express.Request) {
    assertAuthenticated(req);
    if (req.actor.type === "agent") {
      return {
        actorType: "agent" as const,
        actorId: req.actor.agentId ?? "unknown-agent",
        agentId: req.actor.agentId ?? null,
        runId: req.actor.runId ?? null,
      };
    }
    return {
      actorType: "user" as const,
      actorId: req.actor.userId ?? "board",
      agentId: null,
      runId: req.actor.runId ?? null,
    };
  }

  return {
    assertAuthenticated,
    assertBoard,
    assertCompanyAccess,
    assertInstanceAdmin,
    getActorInfo,
  };
});

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

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

let routeModules:
  | Promise<[
    typeof import("../middleware/index.js"),
    typeof import("../routes/agents.js"),
  ]>
  | null = null;

async function loadRouteModules() {
  routeModules ??= Promise.all([
    import("../middleware/index.js"),
    import("../routes/agents.js"),
  ]);
  return routeModules;
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { agentRoutes }] = await loadRouteModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
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

function resetMockDefaults() {
  vi.clearAllMocks();
  for (const mock of Object.values(mockAgentService)) mock.mockReset();
  for (const mock of Object.values(mockAccessService)) mock.mockReset();
  for (const mock of Object.values(mockApprovalService)) mock.mockReset();
  for (const mock of Object.values(mockBudgetService)) mock.mockReset();
  for (const mock of Object.values(mockHeartbeatService)) mock.mockReset();
  for (const mock of Object.values(mockIssueApprovalService)) mock.mockReset();
  for (const mock of Object.values(mockIssueService)) mock.mockReset();
  for (const mock of Object.values(mockSecretService)) mock.mockReset();
  for (const mock of Object.values(mockAgentInstructionsService)) mock.mockReset();
  for (const mock of Object.values(mockCompanySkillService)) mock.mockReset();
  mockLogActivity.mockReset();
  mockGetTelemetryClient.mockReset();
  mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
  currentKeyAgentId = agentId;
  currentAccessCanUser = false;
  mockAgentService.getById.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.pause.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.resume.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.terminate.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.remove.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.listKeys.mockImplementation(async () => []);
  mockAgentService.createApiKey.mockImplementation(async () => ({
    id: keyId,
    name: baseKey.name,
    token: "pcp_test_token",
    createdAt: baseKey.createdAt,
  }));
  mockAgentService.getKeyById.mockImplementation(async () => ({
    ...baseKey,
    agentId: currentKeyAgentId,
  }));
  mockAgentService.revokeKey.mockImplementation(async () => ({
    ...baseKey,
    revokedAt: new Date("2026-04-11T00:05:00.000Z"),
  }));
  mockAccessService.canUser.mockImplementation(async () => currentAccessCanUser);
  mockAccessService.hasPermission.mockImplementation(async () => false);
  mockAccessService.getMembership.mockImplementation(async () => null);
  mockAccessService.listPrincipalGrants.mockImplementation(async () => []);
  mockAccessService.ensureMembership.mockImplementation(async () => undefined);
  mockAccessService.setPrincipalPermission.mockImplementation(async () => undefined);
  mockHeartbeatService.cancelActiveForAgent.mockImplementation(async () => undefined);
  mockLogActivity.mockImplementation(async () => undefined);
}

describe.sequential("agent cross-tenant route authorization", () => {
  beforeEach(() => {
    resetMockDefaults();
  });

  it("enforces company boundaries before mutating or reading agent keys", async () => {
    const crossTenantActor = {
      type: "board",
      userId: "mallory",
      companyIds: [],
      source: "session",
      isInstanceAdmin: false,
    };
    const deniedCases = [
      {
        label: "pause",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).post(`/api/agents/${agentId}/pause`).send({})),
        untouched: [mockAgentService.pause, mockHeartbeatService.cancelActiveForAgent],
      },
      {
        label: "list keys",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}/keys`)),
        untouched: [mockAgentService.listKeys],
      },
      {
        label: "create key",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).post(`/api/agents/${agentId}/keys`).send({ name: "exploit" })),
        untouched: [mockAgentService.createApiKey],
      },
      {
        label: "revoke key",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).delete(`/api/agents/${agentId}/keys/${keyId}`)),
        untouched: [mockAgentService.getKeyById, mockAgentService.revokeKey],
      },
    ];

    for (const deniedCase of deniedCases) {
      resetMockDefaults();
      const app = await createApp(crossTenantActor);
      const res = await deniedCase.request(app);

      expect(res.status, `${deniedCase.label}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.error).toContain("User does not have access to this company");
      expect(mockAgentService.getById).toHaveBeenCalledWith(agentId);
      for (const mock of deniedCase.untouched) {
        expect(mock).not.toHaveBeenCalled();
      }
    }

    resetMockDefaults();
    currentKeyAgentId = "44444444-4444-4444-8444-444444444444";
    currentAccessCanUser = true;

    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).delete(`/api/agents/${agentId}/keys/${keyId}`));

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Key not found");
    expect(mockAgentService.getKeyById).toHaveBeenCalledWith(keyId);
    expect(mockAgentService.revokeKey).not.toHaveBeenCalled();
  });
});
