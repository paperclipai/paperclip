import express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
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

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
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

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
}

const externalAdapter: ServerAdapterModule = {
  type: "external_test",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "external_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
};

const missingAdapterType = "missing_adapter_validation_test";

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

async function unregisterTestAdapter(type: string) {
  const { unregisterServerAdapter } = await import("../adapters/index.js");
  unregisterServerAdapter(type);
}

describe("agent routes adapter validation", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../routes/agents.js");
    registerModuleMocks();
    vi.resetAllMocks();
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      name: String(input.name ?? "Agent"),
      urlKey: "agent",
      role: String(input.role ?? "general"),
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: String(input.adapterType ?? "process"),
      adapterConfig: (input.adapterConfig as Record<string, unknown> | undefined) ?? {},
      runtimeConfig: (input.runtimeConfig as Record<string, unknown> | undefined) ?? {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    await unregisterTestAdapter("external_test");
    await unregisterTestAdapter(missingAdapterType);
  });

  afterEach(async () => {
    await unregisterTestAdapter("external_test");
    await unregisterTestAdapter(missingAdapterType);
  });

  it("creates agents for dynamically registered external adapter types", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/agents")
      .send({
        name: "External Agent",
        adapterType: "external_test",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.adapterType).toBe("external_test");
  });

  it("rejects unknown adapter types even when schema accepts arbitrary strings", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/agents")
      .send({
        name: "Missing Adapter",
        adapterType: missingAdapterType,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error ?? res.body.message ?? "")).toContain(`Unknown adapter type: ${missingAdapterType}`);
  });
});
