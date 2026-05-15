import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
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

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
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
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            requireBoardApprovalForNewAgents: false,
          },
        ]),
      })),
    })),
  };
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

function makeAgent(overrides: Partial<{
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  name: string;
  urlKey: string;
}>) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: overrides.name ?? "Test Agent",
    urlKey: overrides.urlKey ?? "test-agent",
    role: "general",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: overrides.adapterType ?? "claude_local",
    adapterConfig: overrides.adapterConfig ?? { model: "claude-opus-4-7" },
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("POST /agents/:id/preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns ok:true for a supported claude_local agent (permissive default)", async () => {
    mockAgentService.getById.mockResolvedValue(
      makeAgent({ adapterType: "claude_local", adapterConfig: { model: "claude-opus-4-7" } }),
    );
    const app = await createApp();
    const res = await request(app).post("/api/agents/11111111-1111-4111-8111-111111111111/preflight");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.adapterType).toBe("claude_local");
    expect(res.body.model).toBe("claude-opus-4-7");
    expect(res.body.mode).toBe("shape_only");
    expect(res.body.check.available).toBe(true);
  });

  it("returns ok:false with unsupported_model for codex_local + gpt-5.3-codex-spark", async () => {
    mockAgentService.getById.mockResolvedValue(
      makeAgent({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.3-codex-spark" } }),
    );
    const app = await createApp();
    const res = await request(app).post("/api/agents/11111111-1111-4111-8111-111111111111/preflight");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.adapterType).toBe("codex_local");
    expect(res.body.model).toBe("gpt-5.3-codex-spark");
    expect(res.body.check.available).toBe(false);
    expect(res.body.check.code).toBe("unsupported_model");
    expect(res.body.check.supportedModels.length).toBeGreaterThan(0);
    expect(res.body.check.supportedModels).not.toContain("gpt-5.3-codex-spark");
  });

  it("returns 404 for an unknown agent", async () => {
    mockAgentService.getById.mockResolvedValue(null);
    const app = await createApp();
    const res = await request(app).post(
      "/api/agents/22222222-2222-4222-8222-222222222222/preflight",
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
  });

  it("returns ok:false with adapter_unknown when adapterType is empty", async () => {
    mockAgentService.getById.mockResolvedValue(
      makeAgent({ adapterType: "", adapterConfig: { model: "anything" } }),
    );
    const app = await createApp();
    const res = await request(app).post("/api/agents/11111111-1111-4111-8111-111111111111/preflight");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.adapterType).toBe(null);
    expect(res.body.check.code).toBe("adapter_unknown");
  });
});
