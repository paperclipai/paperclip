import express from "express";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
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

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
  normalizeSecretRefBindingForPersistence: vi.fn(async (_companyId: string, value: Record<string, unknown>) => value),
  create: vi.fn(async () => ({ id: "secret-1" })),
  rotate: vi.fn(async () => ({ id: "secret-1" })),
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
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      id,
      companyId: "company-1",
      name: "Agent",
      urlKey: "agent",
      role: "general",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: (patch.metadata as Record<string, unknown> | undefined) ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    await unregisterTestAdapter("external_test");
    await unregisterTestAdapter(missingAdapterType);
    await unregisterTestAdapter("openclaw_gateway");
  });

  afterEach(async () => {
    await unregisterTestAdapter("external_test");
    await unregisterTestAdapter(missingAdapterType);
    await unregisterTestAdapter("openclaw_gateway");
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

  it("stores OpenClaw gateway tokens as secret refs during create", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter({
      type: "openclaw_gateway",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "openclaw_gateway",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/agents")
      .send({
        name: "CEO",
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: "ws://citro-openclaw.internal:18789",
          authToken: "gateway-token",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockSecretService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        provider: "local_encrypted",
        value: "gateway-token",
      }),
      expect.any(Object),
    );
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          url: "ws://citro-openclaw.internal:18789",
          authTokenRef: {
            type: "secret_ref",
            secretId: "secret-1",
            version: "latest",
          },
        }),
      }),
    );
    expect(mockAgentService.create.mock.calls[0]?.[1]?.adapterConfig).not.toHaveProperty("authToken");
    expect(mockAgentService.create.mock.calls[0]?.[1]?.adapterConfig).not.toHaveProperty("devicePrivateKeyPem");
  });

  it("generates an OpenClaw device key only when pairing mode is explicit", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter({
      type: "openclaw_gateway",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "openclaw_gateway",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/agents")
      .send({
        name: "CEO",
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: "ws://citro-openclaw.internal:18789",
          authToken: "gateway-token",
          disableDeviceAuth: false,
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const adapterConfig = mockAgentService.create.mock.calls[0]?.[1]?.adapterConfig as
      | Record<string, unknown>
      | undefined;
    expect(adapterConfig?.disableDeviceAuth).toBe(false);
    expect(typeof adapterConfig?.devicePrivateKeyPem).toBe("string");
    expect(String(adapterConfig?.devicePrivateKeyPem ?? "")).toContain("BEGIN PRIVATE KEY");
  });

  it("reuses OpenClaw device key from existing agent with same gateway url", async () => {
    const sharedPem = "-----BEGIN PRIVATE KEY-----\nshared\n-----END PRIVATE KEY-----";
    mockAgentService.list.mockResolvedValue([
      {
        id: "existing-1",
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: "ws://citro-openclaw.internal:18789",
          disableDeviceAuth: false,
          devicePrivateKeyPem: sharedPem,
        },
      },
    ]);

    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter({
      type: "openclaw_gateway",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "openclaw_gateway",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/agents")
      .send({
        name: "CTO",
        adapterType: "openclaw_gateway",
        adapterConfig: {
          url: "ws://citro-openclaw.internal:18789",
          authToken: "gateway-token",
          disableDeviceAuth: false,
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const adapterConfig = mockAgentService.create.mock.calls[0]?.[1]?.adapterConfig as
      | Record<string, unknown>
      | undefined;
    expect(adapterConfig?.devicePrivateKeyPem).toBe(sharedPem);
  });

  it("persists normalized OpenClaw connection status on agent metadata", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter({
      type: "openclaw_gateway",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "openclaw_gateway",
        status: "warn",
        testedAt: "2026-04-23T12:00:00.000Z",
        checks: [
          {
            code: "openclaw_gateway_pairing_required",
            level: "warn",
            message: "Gateway requires device pairing before the connection can be approved.",
          },
        ],
      }),
    });
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111112",
      companyId: "company-1",
      name: "CEO",
      urlKey: "ceo",
      role: "ceo",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "ws://citro-openclaw.internal:18789",
        authTokenRef: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
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
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: {
        url: "ws://citro-openclaw.internal:18789",
        authToken: "resolved-token",
      },
      secretKeys: new Set(["authToken"]),
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/agents/11111111-1111-4111-8111-111111111112/openclaw/connection-test")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      agentId: "11111111-1111-4111-8111-111111111112",
      adapterType: "openclaw_gateway",
      status: "pairing_required",
      checkedAt: "2026-04-23T12:00:00.000Z",
    });
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111112",
      expect.objectContaining({
        metadata: {
          openclawConnection: {
            status: "pairing_required",
            checkedAt: "2026-04-23T12:00:00.000Z",
            message: "Gateway requires device pairing before the connection can be approved.",
          },
        },
      }),
    );
  });

  it("treats unknown passing OpenClaw checks as connected", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter({
      type: "openclaw_gateway",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "openclaw_gateway",
        status: "pass",
        testedAt: "2026-04-23T12:30:00.000Z",
        checks: [
          {
            code: "openclaw_gateway_probe_ok_with_warning",
            level: "info",
            message: "Gateway probe passed with additional adapter detail.",
          },
        ],
      }),
    });
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111112",
      companyId: "company-1",
      name: "CEO",
      urlKey: "ceo",
      role: "ceo",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "ws://citro-openclaw.internal:18789",
        authTokenRef: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
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
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: {
        url: "ws://citro-openclaw.internal:18789",
        authToken: "resolved-token",
      },
      secretKeys: new Set(["authToken"]),
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/agents/11111111-1111-4111-8111-111111111112/openclaw/connection-test")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      agentId: "11111111-1111-4111-8111-111111111112",
      adapterType: "openclaw_gateway",
      status: "connected",
      checkedAt: "2026-04-23T12:30:00.000Z",
    });
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111112",
      expect.objectContaining({
        metadata: {
          openclawConnection: {
            status: "connected",
            checkedAt: "2026-04-23T12:30:00.000Z",
            message: null,
          },
        },
      }),
    );
  });

  it("returns persisted OpenClaw connection status", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111112",
      companyId: "company-1",
      name: "CEO",
      urlKey: "ceo",
      role: "ceo",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "ws://citro-openclaw.internal:18789",
        authTokenRef: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: {
        openclawConnection: {
          status: "connected",
          checkedAt: "2026-04-23T12:30:00.000Z",
          message: "Gateway probe passed.",
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await createApp();
    const res = await request(app)
      .get("/api/agents/11111111-1111-4111-8111-111111111112/openclaw/connection-status")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      status: "connected",
      checkedAt: "2026-04-23T12:30:00.000Z",
      message: "Gateway probe passed.",
    });
  });

  it("keeps the flat OpenClaw connection status path as a compatibility alias", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111112",
      companyId: "company-1",
      name: "CEO",
      urlKey: "ceo",
      role: "ceo",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "ws://citro-openclaw.internal:18789",
        authTokenRef: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: {
        openclawConnection: {
          status: "connected",
          checkedAt: "2026-04-23T12:30:00.000Z",
          message: "Gateway probe passed.",
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = await createApp();
    const res = await request(app)
      .get("/api/agents/11111111-1111-4111-8111-111111111112/openclaw-connection-status")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      status: "connected",
      checkedAt: "2026-04-23T12:30:00.000Z",
      message: "Gateway probe passed.",
    });
  });

  it("treats adapterConfig null as no override and persists OpenClaw connection status", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter({
      type: "openclaw_gateway",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: "openclaw_gateway",
        status: "fail",
        testedAt: "2026-04-23T13:00:00.000Z",
        checks: [
          {
            code: "openclaw_gateway_invalid_token",
            level: "error",
            message: "OpenClaw rejected the gateway access token.",
          },
        ],
      }),
    });
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111112",
      companyId: "company-1",
      name: "CEO",
      urlKey: "ceo",
      role: "ceo",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "ws://citro-openclaw.internal:18789",
        authTokenRef: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: {
        openclawConnection: {
          status: "connected",
          checkedAt: "2026-04-23T12:00:00.000Z",
          message: null,
        },
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({
      config: {
        url: "ws://citro-openclaw.internal:18789",
        authToken: "preview-token",
      },
      secretKeys: new Set(["authToken"]),
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/agents/11111111-1111-4111-8111-111111111112/openclaw/connection-test")
      .send({
        adapterConfig: null,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      agentId: "11111111-1111-4111-8111-111111111112",
      adapterType: "openclaw_gateway",
      status: "invalid_token",
      checkedAt: "2026-04-23T13:00:00.000Z",
    });
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111112",
      expect.objectContaining({
        metadata: {
          openclawConnection: {
            status: "invalid_token",
            checkedAt: "2026-04-23T13:00:00.000Z",
            message: "OpenClaw rejected the gateway access token.",
          },
        },
      }),
    );
  });

  it("rejects inline OpenClaw auth token overrides on the saved-agent connection-test route", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111112",
      companyId: "company-1",
      name: "CEO",
      urlKey: "ceo",
      role: "ceo",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "openclaw_gateway",
      adapterConfig: {
        url: "ws://citro-openclaw.internal:18789",
        authTokenRef: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
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
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/agents/11111111-1111-4111-8111-111111111112/openclaw/connection-test")
      .send({
        adapterConfig: {
          authToken: "preview-token",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("adapterConfig.authTokenRef");
    expect(res.body.error).toContain("test-environment");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
