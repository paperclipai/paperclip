import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Heartbeat Agent",
  urlKey: "heartbeat-agent",
  role: "engineer",
  title: null,
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {
    heartbeat: {
      enabled: true,
      prompt: "You are a helpful agent. Do the work.",
      intervalSec: 60,
      maxConcurrentRuns: 1,
      wakeOnAssignment: true,
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
  update: vi.fn(),
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

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn((_agent: unknown, config: unknown) => config));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    companySkillService: () => mockCompanySkillService,
    budgetService: () => ({}),
    heartbeatService: () => ({}),
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => ({
      normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: unknown) => config),
      resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: unknown) => ({ config })),
    }),
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => ({}),
    environmentService: () => ({}),
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => ({
      normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: unknown) => config),
      resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: unknown) => ({ config })),
      syncEnvBindingsForTarget: undefined,
    }),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => ({
      getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
    }),
  }));
}

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: companyId, requireBoardApprovalForNewAgents: false }]),
      }),
    }),
  };
}

async function createApp() {
  const [{ errorHandler }, { agentRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/agents.js") as Promise<typeof import("../routes/agents.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(app: express.Express, buildRequest: (baseUrl: string) => request.Test) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }
}

describe.sequential("PATCH /api/agents/:id runtimeConfig merge", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/secrets.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../adapters/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);

    mockAgentService.getById.mockResolvedValue({ ...baseAgent });
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...baseAgent,
      ...patch,
      runtimeConfig: patch.runtimeConfig ?? baseAgent.runtimeConfig,
    }));
  });

  it("preserves existing heartbeat fields when patching only intervalSec", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ runtimeConfig: { heartbeat: { intervalSec: 900 } } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [, patchArg] = mockAgentService.update.mock.calls[0] as [string, Record<string, unknown>, unknown];
    const savedHeartbeat = (patchArg.runtimeConfig as Record<string, unknown>)?.heartbeat as Record<string, unknown>;

    expect(savedHeartbeat.intervalSec).toBe(900);
    expect(savedHeartbeat.prompt).toBe("You are a helpful agent. Do the work.");
    expect(savedHeartbeat.enabled).toBe(true);
    expect(savedHeartbeat.wakeOnAssignment).toBe(true);
    expect(savedHeartbeat.maxConcurrentRuns).toBe(1);
  });

  it("replaces entire runtimeConfig when replaceRuntimeConfig: true", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({
          runtimeConfig: { heartbeat: { intervalSec: 900 } },
          replaceRuntimeConfig: true,
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [, patchArg] = mockAgentService.update.mock.calls[0] as [string, Record<string, unknown>, unknown];
    const savedHeartbeat = (patchArg.runtimeConfig as Record<string, unknown>)?.heartbeat as Record<string, unknown>;

    expect(savedHeartbeat.intervalSec).toBe(900);
    expect(savedHeartbeat.prompt).toBeUndefined();
    expect(savedHeartbeat.enabled).toBeUndefined();
  });

  it("preserves top-level runtimeConfig keys not present in the patch", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      runtimeConfig: {
        heartbeat: { enabled: true, prompt: "keep-me", intervalSec: 60 },
        budget: { monthlyCents: 5000 },
      },
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ runtimeConfig: { heartbeat: { intervalSec: 900 } } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const [, patchArg] = mockAgentService.update.mock.calls[0] as [string, Record<string, unknown>, unknown];
    const savedRuntimeConfig = patchArg.runtimeConfig as Record<string, unknown>;

    expect((savedRuntimeConfig.budget as Record<string, unknown>)?.monthlyCents).toBe(5000);
    expect((savedRuntimeConfig.heartbeat as Record<string, unknown>)?.prompt).toBe("keep-me");
    expect((savedRuntimeConfig.heartbeat as Record<string, unknown>)?.intervalSec).toBe(900);
  });
});
