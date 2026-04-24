import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mockHeartbeatService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

vi.mock("../services/index.js", () => ({
  agentService: () => ({
    getById: vi.fn(),
    listByCompany: vi.fn(),
    getChainOfCommand: vi.fn(),
  }),
  agentInstructionsService: () => ({
    getBundle: vi.fn(),
    readFile: vi.fn(),
    updateBundle: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    exportFiles: vi.fn(),
    ensureManagedBundle: vi.fn(),
    materializeManagedBundle: vi.fn(),
  }),
  agentHeartbeatModelService: () => ({
    ensureCompanyHasQaReleaseEngineer: vi.fn(),
  }),
  roleRequiresQaCoverage: vi.fn(() => false),
  resolveRoleForCooCoordinatorModel: vi.fn(),
  normalizeRuntimeConfigForCooHeartbeatModel: vi.fn(
    ({ runtimeConfig }: { runtimeConfig?: Record<string, unknown> }) => runtimeConfig ?? {},
  ),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    getMembership: vi.fn(),
    listPrincipalGrants: vi.fn(),
    ensureMembership: vi.fn(),
    setPrincipalPermission: vi.fn(),
  }),
  approvalService: () => ({}),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(),
    resolveRequestedSkillKeys: vi.fn(),
  }),
  budgetService: () => ({
    upsertPolicy: vi.fn(),
  }),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({
    linkManyForApproval: vi.fn(),
  }),
  issueService: () => ({}),
  logActivity: vi.fn(),
  parseSchedulerHeartbeatPolicy: vi.fn(),
  secretService: () => ({
    resolveAdapterConfigForRuntime: vi.fn(),
    normalizeAdapterConfigForPersistence: vi.fn(
      async (_companyId: string, config: Record<string, unknown>) => config,
    ),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn(
    (_agent: unknown, config: Record<string, unknown>) => config,
  ),
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

let agentRoutesFactory: typeof import("../routes/agents.js").agentRoutes;

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
  app.use("/api", agentRoutesFactory({} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("heartbeat runs route guardrail", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ agentRoutes: agentRoutesFactory } = await import("../routes/agents.js"));
    vi.clearAllMocks();
    mockHeartbeatService.list.mockResolvedValue([
      {
        id: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        status: "failed",
      },
    ]);
  });

  it.sequential("logs a structured warning when company heartbeat history is requested without a limit", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/heartbeat-runs");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.list).toHaveBeenCalledWith("company-1", undefined, undefined);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        agentId: null,
        rowCount: 1,
        responseBytes: expect.any(Number),
      }),
      "unbounded heartbeat-runs response",
    );
  });

  it.sequential("does not warn when the route is explicitly bounded", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/heartbeat-runs?limit=10");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.list).toHaveBeenCalledWith("company-1", undefined, 10);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});
