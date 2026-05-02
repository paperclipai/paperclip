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

const claudeK8sStub: ServerAdapterModule = {
  type: "claude_k8s",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "claude_k8s",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
};

const validClaudeK8sAdapterConfig = {
  model: "claude-sonnet-4-5-20250929",
  tolerations: [
    { key: "dedicated", value: "paperclip", effect: "NoSchedule", operator: "Equal" },
  ],
  nodeSelector: { workload: "paperclip" },
  serviceAccountName: "paperclip",
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
    vi.clearAllMocks();
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
    await unregisterTestAdapter("claude_k8s");
  });

  afterEach(async () => {
    await unregisterTestAdapter("external_test");
    await unregisterTestAdapter(missingAdapterType);
    await unregisterTestAdapter("claude_k8s");
  });

  it("creates agents for dynamically registered external adapter types", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "External Agent",
          adapterType: "external_test",
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.adapterType).toBe("external_test");
  });

  it("rejects unknown adapter types even when schema accepts arbitrary strings", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Missing Adapter",
          adapterType: missingAdapterType,
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error ?? res.body.message ?? "")).toContain(`Unknown adapter type: ${missingAdapterType}`);
  });

  describe("claude_k8s schedulability validation (BLO-2657)", () => {
    async function postClaudeK8sAgent(adapterConfig: Record<string, unknown>) {
      const { registerServerAdapter } = await import("../adapters/index.js");
      registerServerAdapter(claudeK8sStub);
      const app = await createApp();
      return requestApp(app, (baseUrl) =>
        request(baseUrl)
          .post("/api/companies/company-1/agents")
          .send({
            name: "Test K8s Agent",
            adapterType: "claude_k8s",
            adapterConfig,
          }),
      );
    }

    it("accepts a claude_k8s POST that has all schedulability fields (passes validation)", async () => {
      // Mock the instructions-bundle pipeline so the request gets past the
      // claude_k8s schedulability check and through agent creation. The point
      // of this test is to confirm the validation does NOT reject a complete
      // config — the downstream wiring is not the focus.
      mockAgentInstructionsService.materializeManagedBundle.mockResolvedValue({
        adapterConfig: { ...validClaudeK8sAdapterConfig, instructionsFilePath: "/paperclip/agents/test/AGENTS.md" },
      });
      const res = await postClaudeK8sAgent(validClaudeK8sAdapterConfig);
      // 201 (success) is the intended outcome; the assertion is "not 422 from
      // the new claude_k8s schedulability check". Anything other than 422 with
      // a "tolerations|nodeSelector|serviceAccountName" message means the
      // validation accepted the config.
      expect(res.status, JSON.stringify(res.body)).not.toBe(422);
      const errorMessage = String(res.body.error ?? res.body.message ?? "");
      expect(errorMessage).not.toMatch(/tolerations|nodeSelector|serviceAccountName/i);
    });

    it("rejects POST with missing tolerations", async () => {
      const { tolerations: _drop, ...rest } = validClaudeK8sAdapterConfig;
      const res = await postClaudeK8sAgent(rest);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(String(res.body.error ?? res.body.message ?? "")).toContain("tolerations");
    });

    it("rejects POST with empty tolerations array", async () => {
      const res = await postClaudeK8sAgent({ ...validClaudeK8sAdapterConfig, tolerations: [] });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(String(res.body.error ?? res.body.message ?? "")).toContain("tolerations");
    });

    it("rejects POST with missing nodeSelector", async () => {
      const { nodeSelector: _drop, ...rest } = validClaudeK8sAdapterConfig;
      const res = await postClaudeK8sAgent(rest);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(String(res.body.error ?? res.body.message ?? "")).toContain("nodeSelector");
    });

    it("rejects POST with empty nodeSelector object", async () => {
      const res = await postClaudeK8sAgent({ ...validClaudeK8sAdapterConfig, nodeSelector: {} });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(String(res.body.error ?? res.body.message ?? "")).toContain("nodeSelector");
    });

    it("rejects POST with missing serviceAccountName", async () => {
      const { serviceAccountName: _drop, ...rest } = validClaudeK8sAdapterConfig;
      const res = await postClaudeK8sAgent(rest);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(String(res.body.error ?? res.body.message ?? "")).toContain("serviceAccountName");
    });

    it("rejects POST with blank serviceAccountName", async () => {
      const res = await postClaudeK8sAgent({ ...validClaudeK8sAdapterConfig, serviceAccountName: "  " });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(String(res.body.error ?? res.body.message ?? "")).toContain("serviceAccountName");
    });

    it("rejects PATCH that drops tolerations + nodeSelector via replaceAdapterConfig", async () => {
      // The validation throws unprocessable before svc.update is reached, so we
      // only need getById to find the existing claude_k8s agent.
      const { registerServerAdapter } = await import("../adapters/index.js");
      registerServerAdapter(claudeK8sStub);
      const existingAgent = {
        id: "22222222-2222-4222-8222-222222222222",
        companyId: "company-1",
        adapterType: "claude_k8s",
        adapterConfig: { ...validClaudeK8sAdapterConfig },
        permissions: { canCreateAgents: false },
      };
      mockAgentService.getById.mockResolvedValue(existingAgent);

      const app = await createApp();
      const { tolerations: _t, nodeSelector: _n, ...partial } = validClaudeK8sAdapterConfig;
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .patch(`/api/agents/${existingAgent.id}`)
          .send({
            adapterConfig: partial,
            replaceAdapterConfig: true,
          }),
      );

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(String(res.body.error ?? res.body.message ?? "")).toContain("tolerations");
    });
  });
});
