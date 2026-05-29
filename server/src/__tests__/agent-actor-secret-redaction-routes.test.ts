import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const companyId = "22222222-2222-4222-8222-222222222222";
const selfAgentId = "11111111-1111-4111-8111-111111111111";
const otherAgentId = "44444444-4444-4444-8444-444444444444";
const ceoAgentId = "55555555-5555-4555-8555-555555555555";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBgkqhkiG9w0BAQEFAASCAUAwggE8AgEAAkEArealkey...\n-----END PRIVATE KEY-----\n";

const openclawAgent = {
  id: selfAgentId,
  companyId,
  name: "openclaw-gateway",
  urlKey: "openclaw-gateway",
  role: "engineer",
  title: "Gateway",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {
    devicePrivateKeyPem: PEM,
    apiKey: "sk-live-shouldredact",
    desiredSkills: ["alpha", "beta"],
    paperclipSkillSync: { mode: "managed" },
    databaseToken: { type: "secret_ref", secretId: "vault:secrets/foo" },
    friendlyName: "keep-me",
  },
  runtimeConfig: {
    authToken: "tok-shouldredact",
    something: "kept",
  },
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-05-29T00:00:00.000Z"),
  updatedAt: new Date("2026-05-29T00:00:00.000Z"),
};

const secondAgent = {
  ...openclawAgent,
  id: otherAgentId,
  name: "other-agent",
  urlKey: "other-agent",
};

let currentAccessCanUser = false;

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
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
  listRuntimeSkillEntries: vi.fn(async () => []),
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
    (req as any).actor = { ...actor };
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
  for (const m of Object.values(mockAgentService)) m.mockReset();
  for (const m of Object.values(mockAccessService)) m.mockReset();
  currentAccessCanUser = false;
  mockAgentService.list.mockImplementation(async () => [
    { ...openclawAgent, adapterConfig: { ...openclawAgent.adapterConfig }, runtimeConfig: { ...openclawAgent.runtimeConfig } },
    { ...secondAgent, adapterConfig: { ...secondAgent.adapterConfig }, runtimeConfig: { ...secondAgent.runtimeConfig } },
  ]);
  mockAgentService.getById.mockImplementation(async (id: string) => {
    if (id === selfAgentId) {
      return { ...openclawAgent, adapterConfig: { ...openclawAgent.adapterConfig }, runtimeConfig: { ...openclawAgent.runtimeConfig } };
    }
    if (id === otherAgentId) {
      return { ...secondAgent, adapterConfig: { ...secondAgent.adapterConfig }, runtimeConfig: { ...secondAgent.runtimeConfig } };
    }
    return null;
  });
  mockAgentService.getChainOfCommand.mockImplementation(async () => []);
  mockAccessService.canUser.mockImplementation(async () => currentAccessCanUser);
  mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
    const allowed =
      input.actor?.type === "board" && input.actor.source === "local_implicit"
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
  mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
  mockLogActivity.mockImplementation(async () => undefined);
}

const REDACTED = "***REDACTED***";

const agentActor = (agentId: string) => ({
  type: "agent",
  agentId,
  companyId,
  source: "agent_jwt",
});

const boardActor = (opts: { canRead: boolean }) => {
  currentAccessCanUser = opts.canRead;
  return {
    type: "board",
    userId: "board-user",
    companyIds: [companyId],
    source: "session",
    isInstanceAdmin: false,
  };
};

describe.sequential("agent-actor secret redaction on agents-endpoint reads", () => {
  beforeEach(() => {
    resetMocks();
  });

  it("Case 1 — list, CEO agent token, openclaw-gateway entry has PEM redacted but desiredSkills + secret_ref intact", async () => {
    currentAccessCanUser = true;
    const app = await createApp(agentActor(ceoAgentId));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents`),
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const found = res.body.find((a: any) => a.id === selfAgentId);
    expect(found).toBeTruthy();
    expect(found.adapterConfig.devicePrivateKeyPem).toBe(REDACTED);
    expect(found.adapterConfig.apiKey).toBe(REDACTED);
    expect(found.adapterConfig.desiredSkills).toEqual(["alpha", "beta"]);
    expect(found.adapterConfig.paperclipSkillSync).toEqual({ mode: "managed" });
    expect(found.adapterConfig.databaseToken).toEqual({ type: "secret_ref", secretId: "vault:secrets/foo" });
    expect(found.adapterConfig.friendlyName).toBe("keep-me");
    expect(found.runtimeConfig.authToken).toBe(REDACTED);
    expect(found.runtimeConfig.something).toBe("kept");
  });

  it("Case 2 — list, human board actor with agent_config:read, raw devicePrivateKeyPem present (back-compat)", async () => {
    const app = await createApp(boardActor({ canRead: true }));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents`),
    );
    expect(res.status).toBe(200);
    const found = res.body.find((a: any) => a.id === selfAgentId);
    expect(found.adapterConfig.devicePrivateKeyPem).toBe(PEM);
    expect(found.adapterConfig.apiKey).toBe("sk-live-shouldredact");
    expect(found.runtimeConfig.authToken).toBe("tok-shouldredact");
  });

  it("Case 3 — list, agent without agent_config:read, adapterConfig blanked (restricted view back-compat)", async () => {
    currentAccessCanUser = false;
    const app = await createApp(agentActor(ceoAgentId));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents`),
    );
    expect(res.status).toBe(200);
    const found = res.body.find((a: any) => a.id === selfAgentId);
    expect(found.adapterConfig).toEqual({});
    expect(found.runtimeConfig).toEqual({});
  });

  it("Case 4 — detail, isSelf agent self-fetch of openclaw-gateway record, PEM REDACTED", async () => {
    const app = await createApp(agentActor(selfAgentId));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/agents/${selfAgentId}`),
    );
    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.devicePrivateKeyPem).toBe(REDACTED);
    expect(res.body.adapterConfig.apiKey).toBe(REDACTED);
    expect(res.body.adapterConfig.desiredSkills).toEqual(["alpha", "beta"]);
    expect(res.body.runtimeConfig.authToken).toBe(REDACTED);
  });

  it("Case 5 — detail, CEO agent token reading another agent's detail, PEM REDACTED with desiredSkills preserved", async () => {
    currentAccessCanUser = true;
    const app = await createApp(agentActor(ceoAgentId));
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/agents/${otherAgentId}`),
    );
    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.devicePrivateKeyPem).toBe(REDACTED);
    expect(res.body.adapterConfig.apiKey).toBe(REDACTED);
    expect(res.body.adapterConfig.desiredSkills).toEqual(["alpha", "beta"]);
    expect(res.body.adapterConfig.databaseToken).toEqual({ type: "secret_ref", secretId: "vault:secrets/foo" });
    expect(res.body.runtimeConfig.authToken).toBe(REDACTED);
  });
});
