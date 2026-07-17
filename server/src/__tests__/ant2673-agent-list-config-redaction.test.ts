/**
 * ANT-2673 regression: GET /companies/:companyId/agents must redact
 * adapterConfig.env for agent-actors with agents:create, while board
 * actors receive raw values.
 *
 * Defect: canReadConfigs=true path on the list endpoint previously
 * returned the full adapterConfig including plaintext env secrets to
 * any agent-actor that passed the agents:create gate.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const actorAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const targetAgentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const PLAINTEXT_SECRET = "ghp_xxxxxxxxxxxxxxxxxxxx";
const REDACTED = "***REDACTED***";

const actorAgentRow = {
  id: actorAgentId,
  companyId,
  name: "CTO Agent",
  urlKey: "cto-agent",
  role: "lead",
  title: "CTO",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: { env: {} },
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: true },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const targetAgentRow = {
  id: targetAgentId,
  companyId,
  name: "Worker Agent",
  urlKey: "worker-agent",
  role: "engineer",
  title: "Worker",
  icon: null,
  status: "idle",
  reportsTo: actorAgentId,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {
    env: {
      GITHUB_TOKEN: { type: "plain", value: PLAINTEXT_SECRET },
      ANTHROPIC_API_KEY: { type: "plain", value: "sk-ant-secret" },
    },
  },
  runtimeConfig: {
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: { type: "plain", value: "oauth-token-value" },
    },
  },
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

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

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  create: vi.fn(),
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
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
  ISSUE_LIST_DEFAULT_LIMIT: 50,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => ({ getById: vi.fn() }),
}));

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => ({}),
}));

vi.mock("../services/recovery/service.js", () => ({
  recoveryService: () => ({}),
}));

vi.mock("../services/trust-preset-resolver.js", () => ({
  resolveCoreTrustPreset: vi.fn(async () => ({ kind: "standard" })),
}));

vi.mock("../routes/workspace-command-authz.js", () => ({
  assertNoAgentHostWorkspaceCommandMutation: vi.fn(),
  collectAgentAdapterWorkspaceCommandPaths: vi.fn(() => []),
}));

vi.mock("../routes/environment-selection.js", () => ({
  assertEnvironmentSelectionForCompany: vi.fn(),
}));

vi.mock("../services/runtime-skill-selections.js", () => ({
  skillVersionSelectionMap: vi.fn(() => ({})),
}));

vi.mock("../services/agent-invokability.js", () => ({
  listInvalidOrgChainDescendantIds: vi.fn(async () => []),
}));

vi.mock("../adapters/index.js", () => ({
  findActiveServerAdapter: vi.fn(() => null),
  findServerAdapter: vi.fn(() => null),
  requireServerAdapter: vi.fn(() => { throw new Error("No adapter"); }),
  listAdapterModels: vi.fn(async () => []),
  listAdapterModelProfiles: vi.fn(async () => []),
  detectAdapterModel: vi.fn(async () => null),
  refreshAdapterModels: vi.fn(async () => []),
  supportedEnvironmentDriversForAdapter: vi.fn(() => []),
}));

vi.mock("@paperclipai/adapter-claude-local/server", () => ({
  runClaudeLogin: vi.fn(),
}));

vi.mock("../services/default-agent-instructions.js", () => ({
  loadDefaultAgentInstructionsBundle: vi.fn(),
  resolveDefaultAgentInstructionsBundleRole: vi.fn(),
}));

vi.mock("../routes/org-chart-svg.js", () => ({
  renderOrgChartSvg: vi.fn(),
  renderOrgChartPng: vi.fn(),
  ORG_CHART_STYLES: [],
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
      companyIds: Array.isArray(actor.companyIds) ? [...(actor.companyIds as unknown[])] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(app: express.Express, buildRequest: (baseUrl: string) => request.Test) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP port");
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
      });
    }
  }
}

const agentActor = {
  type: "agent",
  agentId: actorAgentId,
  companyId,
  runId: "run-1",
};

const boardActor = {
  type: "board",
  userId: "admin-user",
  userName: null,
  userEmail: null,
  source: "session",
  isInstanceAdmin: false,
  companyIds: [companyId],
  memberships: [{ companyId, membershipRole: "admin", status: "active" }],
};

describe.sequential("ANT-2673: GET /companies/:companyId/agents — adapterConfig.env redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentService.list.mockImplementation(async () => [{ ...targetAgentRow }]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === actorAgentId) return { ...actorAgentRow };
      if (id === targetAgentId) return { ...targetAgentRow };
      return null;
    });
    mockAgentService.getChainOfCommand.mockImplementation(async () => []);
    // Allow agent:read for filterAgentsForActor
    mockAccessService.decide.mockImplementation(async () => ({
      allowed: true,
      action: "agent:read",
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    }));
    // Allow agents:create for actorCanReadConfigurationsForCompany
    mockAccessService.hasPermission.mockImplementation(async () => true);
    mockAccessService.getMembership.mockImplementation(async () => null);
    mockAccessService.listPrincipalGrants.mockImplementation(async () => []);
    mockLogActivity.mockImplementation(async () => undefined);
  });

  it("redacts adapterConfig.env and runtimeConfig.env values for agent-actor with agents:create (ANT-2673)", async () => {
    const app = await createApp(agentActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents`),
    );

    expect(res.status).toBe(200);
    const agents = res.body as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
    const agent = agents[0];

    const adapterEnv = (agent.adapterConfig as Record<string, Record<string, unknown>>)?.env;
    expect(adapterEnv).toBeDefined();
    expect(adapterEnv?.GITHUB_TOKEN).toEqual({ type: "plain", value: REDACTED });
    expect(adapterEnv?.ANTHROPIC_API_KEY).toEqual({ type: "plain", value: REDACTED });
    // Ensure no plaintext leaked
    expect(JSON.stringify(adapterEnv)).not.toContain(PLAINTEXT_SECRET);

    const runtimeEnv = (agent.runtimeConfig as Record<string, Record<string, unknown>>)?.env;
    expect(runtimeEnv).toBeDefined();
    expect(runtimeEnv?.CLAUDE_CODE_OAUTH_TOKEN).toEqual({ type: "plain", value: REDACTED });
  });

  it("returns raw adapterConfig.env values for board actor (intentional — no regression)", async () => {
    const app = await createApp(boardActor);
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${companyId}/agents`),
    );

    expect(res.status).toBe(200);
    const agents = res.body as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
    const agent = agents[0];

    const adapterEnv = (agent.adapterConfig as Record<string, Record<string, unknown>>)?.env;
    expect(adapterEnv?.GITHUB_TOKEN).toEqual({ type: "plain", value: PLAINTEXT_SECRET });
    expect(adapterEnv?.ANTHROPIC_API_KEY).toEqual({ type: "plain", value: "sk-ant-secret" });
  });
});
