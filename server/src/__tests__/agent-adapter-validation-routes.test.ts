import express from "express";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import type { ServerAdapterModule } from "../adapters/index.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";

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

const mockAgentHeartbeatModel = vi.hoisted(() => ({
  ensureCompanyHasQaReleaseEngineer: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockNormalizeRuntimeConfigForCooHeartbeatModel = vi.hoisted(() =>
  vi.fn(({ runtimeConfig }: { runtimeConfig?: Record<string, unknown> }) => runtimeConfig ?? {}),
);
const mockResolveRoleForCooCoordinatorModel = vi.hoisted(() =>
  vi.fn(({ role }: { role?: string }) => role ?? "general"),
);
const mockRoleRequiresQaCoverage = vi.hoisted(() => vi.fn(() => false));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  agentHeartbeatModelService: () => mockAgentHeartbeatModel,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  normalizeRuntimeConfigForCooHeartbeatModel: mockNormalizeRuntimeConfigForCooHeartbeatModel,
  roleRequiresQaCoverage: mockRoleRequiresQaCoverage,
  resolveRoleForCooCoordinatorModel: mockResolveRoleForCooCoordinatorModel,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

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

function createApp() {
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

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function requestWithApp<T>(
  app: express.Express,
  run: (agent: request.SuperTest<request.Test>) => Promise<T>,
) {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await run(request(server));
  } finally {
    await closeServer(server);
  }
}

describe.sequential("agent routes adapter validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    unregisterServerAdapter("external_test");
    mockRoleRequiresQaCoverage.mockReturnValue(false);
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
  });

  afterEach(() => {
    unregisterServerAdapter("external_test");
  });

  it.sequential("creates agents for dynamically registered external adapter types", async () => {
    registerServerAdapter(externalAdapter);

    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .post("/api/companies/company-1/agents")
        .send({
          name: "External Agent",
          adapterType: "external_test",
        })
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.adapterType).toBe("external_test");
  });

  it.sequential("rejects unknown adapter types even when schema accepts arbitrary strings", async () => {
    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .post("/api/companies/company-1/agents")
        .send({
          name: "Missing Adapter",
          adapterType: "missing_adapter",
        })
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error ?? res.body.message ?? "")).toContain("Unknown adapter type: missing_adapter");
  });
});
