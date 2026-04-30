import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const PLAINTEXT_KEY = "sk-proj-MUSTNEVERLEAK1234567890ABCDEF";

const baseAgent = {
  id: agentId,
  companyId,
  name: "DevOps",
  urlKey: "devops",
  role: "engineer",
  title: "DevOps",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {
    cwd: "/tmp",
    model: "claude-opus-4-7",
    env: {
      OPENAI_API_KEY: { type: "plain", value: PLAINTEXT_KEY },
      OPENAI_ORG_ID: { type: "plain", value: "org-public-id" },
      DB_PASSWORD: { type: "secret_ref", secretId: "secret-1", version: "latest" },
    },
  },
  runtimeConfig: { heartbeat: { intervalSec: 300 } },
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-04-30T00:00:00.000Z"),
  updatedAt: new Date("2026-04-30T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  getChainOfCommand: vi.fn(),
  list: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  activatePendingApproval: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  getKeyById: vi.fn(),
  revokeKey: vi.fn(),
  listConfigRevisions: vi.fn(),
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
const mockHeartbeatService = vi.hoisted(() => ({ cancelActiveForAgent: vi.fn() }));
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
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({ getTelemetryClient: mockGetTelemetryClient }));

vi.mock("../routes/authz.js", async () => {
  const { forbidden, unauthorized } = await vi.importActual<typeof import("../errors.js")>(
    "../errors.js",
  );
  function assertAuthenticated(req: Express.Request) {
    if (req.actor.type === "none") throw unauthorized();
  }
  function assertBoard(req: Express.Request) {
    if (req.actor.type !== "board") throw forbidden("Board access required");
  }
  function assertCompanyAccess(req: Express.Request, expectedCompanyId: string) {
    assertAuthenticated(req);
    if (req.actor.type === "agent" && req.actor.companyId !== expectedCompanyId) {
      throw forbidden("Agent key cannot access another company");
    }
  }
  function assertInstanceAdmin(req: Express.Request) {
    assertBoard(req);
  }
  function getActorInfo(req: Express.Request) {
    assertAuthenticated(req);
    return {
      actorType: "user" as const,
      actorId: req.actor.userId ?? "board",
      agentId: null,
      runId: req.actor.runId ?? null,
    };
  }
  return { assertAuthenticated, assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo };
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
  | Promise<[typeof import("../middleware/index.js"), typeof import("../routes/agents.js")]>
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

function resetMocks() {
  vi.clearAllMocks();
  for (const mock of Object.values(mockAgentService)) mock.mockReset();
  for (const mock of Object.values(mockAccessService)) mock.mockReset();
  for (const mock of Object.values(mockHeartbeatService)) mock.mockReset();
  mockLogActivity.mockReset();
  mockGetTelemetryClient.mockReset();
  mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
  mockAgentService.getById.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.getChainOfCommand.mockImplementation(async () => []);
  mockAgentService.list.mockImplementation(async () => [{ ...baseAgent }]);
  mockAgentService.pause.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.resume.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.terminate.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.update.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.listConfigRevisions.mockImplementation(async () => []);
  mockAccessService.canUser.mockImplementation(async () => true);
  mockAccessService.hasPermission.mockImplementation(async () => true);
  mockAccessService.listPrincipalGrants.mockImplementation(async () => []);
  mockAccessService.getMembership.mockImplementation(async () => null);
  mockHeartbeatService.cancelActiveForAgent.mockImplementation(async () => undefined);
  mockLogActivity.mockImplementation(async () => undefined);
}

const localBoardActor = {
  type: "board",
  userId: "local-board",
  companyIds: [companyId],
  source: "local_implicit",
  isInstanceAdmin: true,
};

function assertNoLeak(label: string, payload: unknown) {
  const serialized = JSON.stringify(payload);
  expect(serialized, `${label} leaked plaintext`).not.toContain(PLAINTEXT_KEY);
}

describe.sequential("agent secret env redaction", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("GET /api/agents/:id never returns plaintext env values to trusted callers", async () => {
    const app = await createApp(localBoardActor);
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    assertNoLeak("GET /agents/:id", res.body);

    const env = res.body?.adapterConfig?.env;
    expect(env, "env present").toBeTruthy();
    // Plain-typed sensitive entry must be masked, type preserved
    expect(env.OPENAI_API_KEY).toEqual({ type: "plain", value: "***REDACTED***" });
    // Non-sensitive plain entry retains value (no key-name match)
    expect(env.OPENAI_ORG_ID).toEqual({ type: "plain", value: "org-public-id" });
    // Secret-ref pass-through (no resolved value emitted)
    expect(env.DB_PASSWORD).toMatchObject({ type: "secret_ref", secretId: "secret-1" });
    expect(env.DB_PASSWORD).not.toHaveProperty("value");
  });

  it("GET /api/companies/:companyId/agents redacts adapterConfig.env in list view", async () => {
    const app = await createApp(localBoardActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents`),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    assertNoLeak("GET /companies/:companyId/agents", res.body);
    expect(Array.isArray(res.body)).toBe(true);
    const first = res.body[0];
    expect(first.adapterConfig.env.OPENAI_API_KEY).toEqual({
      type: "plain",
      value: "***REDACTED***",
    });
  });

  it("POST /api/agents/:id/pause response does not leak env values", async () => {
    const app = await createApp(localBoardActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/pause`).send({}),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    assertNoLeak("POST /agents/:id/pause", res.body);
  });

  it("POST /api/agents/:id/resume response does not leak env values", async () => {
    const app = await createApp(localBoardActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/resume`).send({}),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    assertNoLeak("POST /agents/:id/resume", res.body);
  });

  it("POST /api/agents/:id/terminate response does not leak env values", async () => {
    const app = await createApp(localBoardActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/terminate`).send({}),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    assertNoLeak("POST /agents/:id/terminate", res.body);
  });

  it("ANY agent response: no `value` field for any entry that matches sensitive key pattern", async () => {
    const sensitiveKeys = ["OPENAI_API_KEY", "GITHUB_ACCESS_TOKEN", "AUTH_BEARER", "DB_PASSWORD_X"];
    mockAgentService.getById.mockImplementation(async () => ({
      ...baseAgent,
      adapterConfig: {
        ...baseAgent.adapterConfig,
        env: Object.fromEntries(
          sensitiveKeys.map((k) => [k, { type: "plain", value: PLAINTEXT_KEY }]),
        ),
      },
    }));
    const app = await createApp(localBoardActor);
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));
    expect(res.status).toBe(200);
    assertNoLeak("ANY sensitive env", res.body);
    for (const key of sensitiveKeys) {
      expect(res.body.adapterConfig.env[key]).toEqual({ type: "plain", value: "***REDACTED***" });
    }
  });
});
