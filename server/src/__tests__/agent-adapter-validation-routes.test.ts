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

function registerModuleMocks() {
  vi.doMock("../routes/agents.js", async () =>
    vi.importActual<typeof import("../routes/agents.ts")>("../routes/agents.ts"),
  );
  vi.doMock("../routes/agents.ts", async () =>
    vi.importActual<typeof import("../routes/agents.ts")>("../routes/agents.ts"),
  );
  vi.doMock("../middleware/index.js", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/index.ts", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/validate.ts", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../adapters/index.js", async () =>
    vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  );
  vi.doMock("../adapters/index.ts", async () =>
    vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts"),
  );
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  const servicesIndexMock = () => ({
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
  });
  vi.doMock("../services/index.js", servicesIndexMock);
  vi.doMock("../services/index.ts", servicesIndexMock);

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
  vi.doMock("../services/instance-settings.ts", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));
}

function resetAgentRouteModules() {
  vi.resetModules();
  vi.doUnmock("@paperclipai/shared/telemetry");
  vi.doUnmock("../telemetry.js");
  vi.doUnmock("../telemetry.ts");
  vi.doUnmock("../routes/agents.js");
  vi.doUnmock("../routes/agents.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../routes/workspace-command-authz.js");
  vi.doUnmock("../routes/workspace-command-authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../middleware/validate.ts");
  vi.doUnmock("../middleware/logger.js");
  vi.doUnmock("../middleware/logger.ts");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/index.ts");
  vi.doUnmock("../services/agent-service-health.js");
  vi.doUnmock("../services/agent-service-health.ts");
  vi.doUnmock("../services/default-agent-instructions.js");
  vi.doUnmock("../services/default-agent-instructions.ts");
  vi.doUnmock("../services/instance-settings.js");
  vi.doUnmock("../services/instance-settings.ts");
  vi.doUnmock("../adapters/index.js");
  vi.doUnmock("../adapters/index.ts");
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
  resetAgentRouteModules();
  registerModuleMocks();
  const routeModulePath = "../routes/agents.ts?agent-adapter-validation-routes";
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/agents.ts")>,
    import("../middleware/index.ts"),
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

async function unregisterTestAdapter(type: string) {
  const { unregisterServerAdapter } = await import("../adapters/index.ts");
  unregisterServerAdapter(type);
}

describe("agent routes adapter validation", () => {
  beforeEach(async () => {
    resetAgentRouteModules();
    registerModuleMocks();
    vi.resetAllMocks();
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
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
    resetAgentRouteModules();
  });

  it("creates agents for dynamically registered external adapter types", async () => {
    const app = await createApp();
    const { registerServerAdapter } = await import("../adapters/index.ts");
    registerServerAdapter(externalAdapter);

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
