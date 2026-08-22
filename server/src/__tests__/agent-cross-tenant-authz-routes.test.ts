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
  list: vi.fn(),
  getChainOfCommand: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  clearError: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  getKeyById: vi.fn(),
  revokeKey: vi.fn(),
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

  function hasCompanyAccess(req: Express.Request, expectedCompanyId: string): boolean {
    if (req.actor.type === "none") return false;
    if (req.actor.type === "agent") return req.actor.companyId === expectedCompanyId;
    if (req.actor.source === "local_implicit") return true;
    return (req.actor.companyIds ?? []).includes(expectedCompanyId);
  }

  async function getAccessibleResource<T extends { companyId: string }>(
    req: Express.Request,
    res: { status(code: number): { json(body: unknown): unknown } },
    resource: T | null | undefined | Promise<T | null | undefined>,
    notFoundMessage: string,
  ): Promise<T | null> {
    const resolved = await resource;
    if (!resolved || !hasCompanyAccess(req, resolved.companyId)) {
      res.status(404).json({ error: notFoundMessage });
      return null;
    }
    assertCompanyAccess(req, resolved.companyId);
    return resolved;
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
    getAccessibleResource,
    getActorInfo,
    hasCompanyAccess,
  };
});

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
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

function buildStubDb(): Record<string, unknown> {
  const chain = {
    from() { return chain; },
    leftJoin() { return chain; },
    innerJoin() { return chain; },
    where() { return chain; },
    orderBy() { return chain; },
    limit() { return chain; },
    then(onfulfilled: (rows: unknown[]) => unknown) { return Promise.resolve([]).then(onfulfilled); },
  };
  return {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
  };
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
  app.use("/api", agentRoutes(buildStubDb() as any));
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
  mockAgentService.list.mockImplementation(async () => [{ ...baseAgent }]);
  mockAgentService.getChainOfCommand.mockImplementation(async () => []);
  mockAgentService.pause.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.resume.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.clearError.mockImplementation(async () => ({ ...baseAgent, status: "idle" }));
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
  mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
    const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit"
      ? true
      : currentAccessCanUser;
    return {
      allowed,
      action: input.action,
      reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
      explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
    };
  });
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
        label: "clear error",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({})),
        untouched: [mockAgentService.clearError],
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

      expect(res.status, `${deniedCase.label}: ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body.error).toBe("Agent not found");
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

  it("requires board access before clearing an agent error", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
    expect(mockAgentService.clearError).not.toHaveBeenCalled();
  });

  it("clears error agents and records a distinct audit action", async () => {
    const errorAgent = {
      ...baseAgent,
      status: "error",
      pauseReason: "system",
      pausedAt: new Date("2026-04-11T00:02:00.000Z"),
    };
    mockAgentService.getById.mockImplementation(async () => ({ ...errorAgent }));
    mockAgentService.clearError.mockImplementation(async () => ({
      ...errorAgent,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
      updatedAt: new Date("2026-04-11T00:03:00.000Z"),
    }));
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: agentId,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    });
    expect(mockAgentService.clearError).toHaveBeenCalledWith(agentId);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "agent.error_cleared",
      entityType: "agent",
      entityId: agentId,
    }));
  });

  it("returns 409 and does not mutate when the agent org chain is invalid", async () => {
    mockAgentService.getById.mockImplementation(async () => ({
      ...baseAgent,
      status: "error",
      orgChainHealth: {
        status: "invalid_org_chain",
        reason: "missing_manager",
        repairGuidance: "Repair the reporting chain first.",
      },
    }));
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Repair the reporting chain first");
    expect(mockAgentService.clearError).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns a clear 409 for non-error agents", async () => {
    const { conflict } = await import("../errors.js");
    mockAgentService.getById.mockImplementation(async () => ({ ...baseAgent, status: "idle" }));
    mockAgentService.clearError.mockImplementation(async () => {
      throw conflict("Only agents in error status can have their error cleared");
    });
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Only agents in error status can have their error cleared");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

describe.sequential("agent adapterConfig.env redaction on cross-actor reads (BASA-29461)", () => {
  const peerAgentId = "44444444-4444-4444-8444-444444444444";

  const sensitiveAdapterConfig = {
    workspaceRoot: "/srv/agent",
    env: {
      OPENAI_API_KEY: "sk-live-do-not-leak",
      GITHUB_TOKEN: "ghp_live-do-not-leak",
      LOG_LEVEL: "info",
    },
  };

  const sensitiveRuntimeConfig = {
    schedulerHeartbeat: { enabled: true, intervalSec: 30 },
    ANTHROPIC_API_KEY: "sk-ant-do-not-leak",
  };

  const targetAgent = {
    ...baseAgent,
    id: agentId,
    adapterConfig: sensitiveAdapterConfig,
    runtimeConfig: sensitiveRuntimeConfig,
  };

  beforeEach(() => {
    resetMockDefaults();
  });

  function mockAgentLookup(actorAgentOverrides?: Record<string, unknown>) {
    const actorAgent = { ...baseAgent, id: peerAgentId, ...actorAgentOverrides };
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === peerAgentId) return { ...actorAgent };
      if (id === agentId) return { ...targetAgent };
      return null;
    });
    mockAgentService.list.mockImplementation(async () => [{ ...targetAgent }]);
  }

  it("GET /api/agents/:id as privileged peer agent → env keys preserved, values redacted (leak does not return)", async () => {
    currentAccessCanUser = true;
    mockAgentLookup({ permissions: { canCreateAgents: true } });

    const app = await createApp({
      type: "agent",
      agentId: peerAgentId,
      companyId,
      runId: "run-peer",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.workspaceRoot).toBe("/srv/agent");
    expect(res.body.adapterConfig.env).toMatchObject({
      OPENAI_API_KEY: "***REDACTED***",
      GITHUB_TOKEN: "***REDACTED***",
    });
    expect(res.body.adapterConfig.env.LOG_LEVEL).toBe("info");
    expect(JSON.stringify(res.body)).not.toContain("sk-live-do-not-leak");
    expect(JSON.stringify(res.body)).not.toContain("ghp_live-do-not-leak");
    expect(res.body.runtimeConfig.ANTHROPIC_API_KEY).toBe("***REDACTED***");
    expect(res.body.runtimeConfig.schedulerHeartbeat).toEqual({ enabled: true, intervalSec: 30 });
    expect(JSON.stringify(res.body)).not.toContain("sk-ant-do-not-leak");
  });

  it("GET /api/agents/:id as self → plaintext present (adapter boot path still works)", async () => {
    currentAccessCanUser = true;
    mockAgentService.getById.mockImplementation(async () => ({ ...targetAgent }));

    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-self",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.env.OPENAI_API_KEY).toBe("sk-live-do-not-leak");
    expect(res.body.adapterConfig.env.GITHUB_TOKEN).toBe("ghp_live-do-not-leak");
    expect(res.body.runtimeConfig.ANTHROPIC_API_KEY).toBe("sk-ant-do-not-leak");
  });

  // Restricted-path coverage lives in `agent-permissions-routes.test.ts`
  // ("redacts agent detail for authenticated company members without agent admin
  // permission"). With dbebf30's `assertAgentReadAllowed` 403 gate landing on master,
  // a peer-agent caller without grants 403s before reaching the restricted body.

  it("GET /api/companies/:companyId/agents as board user → every element has env values redacted, key names preserved", async () => {
    const secondAgentId = "55555555-5555-4555-8555-555555555555";
    const secondAgent = {
      ...targetAgent,
      id: secondAgentId,
      adapterConfig: {
        env: { STRIPE_SECRET_KEY: "sk_live_stripe_do_not_leak" },
      },
      runtimeConfig: {},
    };
    mockAgentService.list.mockImplementation(async () => [{ ...targetAgent }, { ...secondAgent }]);

    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/companies/${companyId}/agents`));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].adapterConfig.env).toMatchObject({
      OPENAI_API_KEY: "***REDACTED***",
      GITHUB_TOKEN: "***REDACTED***",
      LOG_LEVEL: "info",
    });
    expect(res.body[1].adapterConfig.env).toEqual({
      STRIPE_SECRET_KEY: "***REDACTED***",
    });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("sk-live-do-not-leak");
    expect(body).not.toContain("ghp_live-do-not-leak");
    expect(body).not.toContain("sk_live_stripe_do_not_leak");
  });

  it("GET /api/agents/:id as board user with non-low-trust target → env values redacted (BASA-29460 carve-out scoped to low-trust only)", async () => {
    mockAgentService.getById.mockImplementation(async () => ({ ...targetAgent }));

    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.env).toMatchObject({
      OPENAI_API_KEY: "***REDACTED***",
      GITHUB_TOKEN: "***REDACTED***",
      LOG_LEVEL: "info",
    });
    expect(res.body.runtimeConfig.ANTHROPIC_API_KEY).toBe("***REDACTED***");
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("sk-live-do-not-leak");
    expect(body).not.toContain("ghp_live-do-not-leak");
    expect(body).not.toContain("sk-ant-do-not-leak");
  });

  it("GET /api/agents/:id as board user with low-trust target → plaintext returned (containment-audit carve-out per PR #7530)", async () => {
    const lowTrustAgent = {
      ...targetAgent,
      permissions: { canCreateAgents: false, trustPreset: "low_trust_review" },
    };
    mockAgentService.getById.mockImplementation(async () => ({ ...lowTrustAgent }));

    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.env.OPENAI_API_KEY).toBe("sk-live-do-not-leak");
    expect(res.body.runtimeConfig.ANTHROPIC_API_KEY).toBe("sk-ant-do-not-leak");
  });

  it("GET /api/agents/:id as privileged peer agent reading low-trust target → STILL redacted (carve-out is board-only)", async () => {
    currentAccessCanUser = true;
    const lowTrustTarget = {
      ...targetAgent,
      permissions: { canCreateAgents: false, trustPreset: "low_trust_review" },
    };
    const actorAgent = { ...baseAgent, id: peerAgentId, permissions: { canCreateAgents: true } };
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === peerAgentId) return { ...actorAgent };
      if (id === agentId) return { ...lowTrustTarget };
      return null;
    });

    const app = await createApp({
      type: "agent",
      agentId: peerAgentId,
      companyId,
      runId: "run-peer-lowtrust",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.env.OPENAI_API_KEY).toBe("***REDACTED***");
    expect(res.body.runtimeConfig.ANTHROPIC_API_KEY).toBe("***REDACTED***");
    expect(JSON.stringify(res.body)).not.toContain("sk-live-do-not-leak");
  });

  it("GET /api/agents/:id with {type:'secret_ref'} env binding → envelope passes through unchanged", async () => {
    currentAccessCanUser = true;
    const secretRefAgent = {
      ...targetAgent,
      adapterConfig: {
        env: {
          OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-001", version: 3 },
        },
      },
      runtimeConfig: {},
    };
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === peerAgentId) {
        return { ...baseAgent, id: peerAgentId, permissions: { canCreateAgents: true } };
      }
      if (id === agentId) return { ...secretRefAgent };
      return null;
    });

    const app = await createApp({
      type: "agent",
      agentId: peerAgentId,
      companyId,
      runId: "run-peer-secretref",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.env.OPENAI_API_KEY).toEqual({
      type: "secret_ref",
      secretId: "secret-001",
      version: 3,
    });
  });
});
