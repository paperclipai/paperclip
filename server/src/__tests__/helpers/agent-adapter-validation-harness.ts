import express from "express";
import request from "supertest";
import { vi } from "vitest";
import type { ServerAdapterModule } from "../../adapters/index.js";

export const externalAdapter: ServerAdapterModule = {
  type: "external_test",
  execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
  testEnvironment: async () => ({
    adapterType: "external_test",
    status: "pass",
    checks: [],
    testedAt: new Date(0).toISOString(),
  }),
};

export const missingAdapterType = "missing_adapter_validation_test";

export async function createAgentValidationApp(actorOverride: Record<string, unknown> = {}) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../../routes/agents.js")>("../../routes/agents.js"),
    vi.importActual<typeof import("../../middleware/index.js")>("../../middleware/index.js"),
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
      ...actorOverride,
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

export async function requestAgentValidationApp(
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

export async function unregisterTestAdapter(type: string) {
  const { unregisterServerAdapter } = await import("../../adapters/index.js");
  unregisterServerAdapter(type);
}

type AnyMock = ReturnType<typeof vi.fn<(...args: any[]) => any>>;

export interface AgentValidationMockSet {
  mockAgentService: {
    create: AnyMock;
    getById: AnyMock;
    getConfigRevision: AnyMock;
    rollbackConfigRevision: AnyMock;
    update: AnyMock;
  };
  mockAdapterPluginStore: {
    getDisabledAdapterTypes: ReturnType<typeof vi.fn<() => string[]>>;
  };
  mockAccessService: {
    canUser: AnyMock;
    decide: AnyMock;
    hasPermission: AnyMock;
    ensureMembership: AnyMock;
    setPrincipalPermission: AnyMock;
  };
  mockCompanySkillService: {
    listRuntimeSkillEntries: AnyMock;
    resolveRequestedSkillKeys: AnyMock;
  };
  mockSecretService: {
    normalizeAdapterConfigForPersistence: AnyMock;
    resolveAdapterConfigForRuntime: AnyMock;
    syncEnvBindingsForTarget: AnyMock;
  };
  mockAgentInstructionsService: {
    materializeManagedBundle: AnyMock;
    getBundle: AnyMock;
    readFile: AnyMock;
    updateBundle: AnyMock;
    writeFile: AnyMock;
    deleteFile: AnyMock;
    exportFiles: AnyMock;
    ensureManagedBundle: AnyMock;
  };
  mockCheckProtectedKeys: AnyMock;
  mockInstanceSettingsService: {
    get: AnyMock;
    getGeneral: AnyMock;
    getExperimental: AnyMock;
  };
  mockManagedAgentProfileService: { requireQualified: AnyMock };
  mockRemoteAgentProfileService: { requireQualified: AnyMock };
  mockLogActivity: AnyMock;
}

export async function resetAgentValidationMocks(mocks: AgentValidationMockSet) {
  const {
    mockAgentService,
    mockAdapterPluginStore,
    mockAccessService,
    mockCompanySkillService,
    mockSecretService,
    mockAgentInstructionsService,
    mockCheckProtectedKeys,
    mockInstanceSettingsService,
    mockManagedAgentProfileService,
    mockRemoteAgentProfileService,
    mockLogActivity,
  } = mocks;

  vi.clearAllMocks();
  mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue([]);
  mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
  mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
  mockAccessService.canUser.mockResolvedValue(true);
  mockAccessService.decide.mockResolvedValue({
    allowed: true,
    reason: "allow_explicit_grant",
    explanation: "Allowed by test grant",
  });
  mockAccessService.hasPermission.mockResolvedValue(true);
  mockAccessService.ensureMembership.mockResolvedValue(undefined);
  mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  mockLogActivity.mockResolvedValue(undefined);
  mockSecretService.syncEnvBindingsForTarget.mockResolvedValue(undefined);
  mockInstanceSettingsService.get.mockResolvedValue({ defaultEnvironmentId: null });
  mockCheckProtectedKeys.mockReset();
  mockCheckProtectedKeys.mockResolvedValue([]);
  mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: false });
  mockManagedAgentProfileService.requireQualified.mockResolvedValue({
    id: "managed-primary",
    companyId: "company-1",
    enabled: true,
  });
  mockRemoteAgentProfileService.requireQualified.mockResolvedValue({
    id: "agentcore-primary",
    companyId: "company-1",
    enabled: true,
  });
  mockAgentInstructionsService.materializeManagedBundle.mockImplementation(async (agent: { adapterConfig: unknown }) => ({
    adapterConfig: agent.adapterConfig,
  }));
  mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
    id: String(input.id ?? "11111111-1111-4111-8111-111111111111"),
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
  mockAgentService.getById.mockResolvedValue({
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Codex",
    urlKey: "codex",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
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
  mockAgentService.getConfigRevision.mockResolvedValue(null);
  mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
    ...(await mockAgentService.getById()),
    ...patch,
  }));
  await unregisterTestAdapter("external_test");
  await unregisterTestAdapter(missingAdapterType);
}
