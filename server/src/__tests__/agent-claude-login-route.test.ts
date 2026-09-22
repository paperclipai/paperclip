import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(async () => null),
  listPrincipalGrants: vi.fn(async () => []),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

const mockRunClaudeLogin = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(async () => []),
    resolveRequestedSkillKeys: vi.fn(async () => []),
  }),
  budgetService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(),
    cancelActiveForAgent: vi.fn(),
  }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/instance-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/instance-settings.js")>()),
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("@paperclipai/adapter-claude-local/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/adapter-claude-local/server")>()),
  runClaudeLogin: mockRunClaudeLogin,
}));

async function createApp() {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("POST /agents/:id/claude-login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockAgentService.getById.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      name: "Claude",
      adapterType: "claude_local",
      adapterConfig: {},
    });
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
    mockRunClaudeLogin.mockResolvedValue({
      status: "url",
      loginUrl: "https://example.invalid/login",
    });
  });

  it("runs the host-local login when execution is unrestricted", async () => {
    const app = await createApp();

    const res = await request(app).post("/api/agents/33333333-3333-4333-8333-333333333333/claude-login").send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockRunClaudeLogin).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({ loginUrl: "https://example.invalid/login" });
  });

  it("responds 409 without spawning anything when execution is forced onto the Kubernetes sandbox", async () => {
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
      executionMode: "kubernetes",
    });
    const app = await createApp();

    const res = await request(app).post("/api/agents/33333333-3333-4333-8333-333333333333/claude-login").send({});

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toMatch(/Kubernetes sandbox/);
    expect(mockRunClaudeLogin).not.toHaveBeenCalled();
  });
});
