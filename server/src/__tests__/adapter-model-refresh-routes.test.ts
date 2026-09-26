import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as openCodeFallbackModels } from "@paperclipai/adapter-opencode-local";
import type { ServerAdapterModule } from "../adapters/index.js";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
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
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockListOpenCodeModels = vi.hoisted(() => vi.fn());

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
  vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>("@paperclipai/adapter-opencode-local/server");
    return {
      ...actual,
      listOpenCodeModels: mockListOpenCodeModels,
    };
  });

  vi.doMock("../services/index.js", () => ({
    agentService: () => ({}),
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
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

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
}

const refreshableAdapterType = "refreshable_adapter_route_test";

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

describe("adapter model refresh route", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockEnvironmentService.getById.mockReset();
    mockEnvironmentService.getById.mockResolvedValue(null);
    mockListOpenCodeModels.mockReset();
    mockListOpenCodeModels.mockResolvedValue([{ id: "dynamic-opencode-model", label: "dynamic-opencode-model" }]);
    await unregisterTestAdapter(refreshableAdapterType);
  });

  afterEach(async () => {
    await unregisterTestAdapter(refreshableAdapterType);
  });

  it("uses refreshModels when refresh=1 is requested", async () => {
    const listModels = vi.fn(async () => [{ id: "stale-model", label: "stale-model" }]);
    const refreshModels = vi.fn(async () => [{ id: "fresh-model", label: "fresh-model" }]);
    const { registerServerAdapter } = await import("../adapters/index.js");
    const adapter: ServerAdapterModule = {
      type: refreshableAdapterType,
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: refreshableAdapterType,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      listModels,
      refreshModels,
    };
    registerServerAdapter(adapter);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/company-1/adapters/${refreshableAdapterType}/models?refresh=1`),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([{ id: "fresh-model", label: "fresh-model" }]);
    expect(refreshModels).toHaveBeenCalledTimes(1);
    expect(listModels).not.toHaveBeenCalled();
  });

  it("skips OpenCode model discovery for non-local environments", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: "env-1",
      companyId: "company-1",
      name: "Remote SSH",
      driver: "ssh",
      config: {},
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/adapters/opencode_local/models?environmentId=env-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(openCodeFallbackModels);
    expect(mockListOpenCodeModels).not.toHaveBeenCalled();
  });

  it("serves Devin Fusion leaf models with parsed metadata over the models route", async () => {
    const fusionPair = "fusion-alpha-1-high-sidekick-beta-2-medium";
    const fusionFixture = [
      {
        family_label: "SWE-1.7",
        family_uid: "swe-1.7",
        slug: "swe-1-7",
        aliases: [],
        variants: [
          {
            model_uid: "swe-1-7",
            label: "SWE-1.7 Max",
            max_context_tokens: 200_000,
            max_output_tokens: 8_192,
            cost_tier: "Free",
            cost_summary: null,
            is_new: false,
            is_beta: true,
          },
        ],
      },
      {
        family_label: "Fusion",
        family_uid: "fusion",
        slug: "fusion",
        aliases: [],
        variants: [
          {
            model_uid: fusionPair,
            label: "Fusion (Alpha 1 High + Beta 2 Medium)",
            command: "devin-internal-marker-command",
            install_path: "/private/marker/catalog-path",
            auth_token: "marker-secret-value",
            max_context_tokens: 1_000_000,
            max_output_tokens: 8_192,
            cost_tier: "High cost",
            cost_summary:
              "$2 / 1M Input · $0.2 / 1M Cached input · $8 / 1M Output · $1 / 1M Sidekick input · $0 / 1M Sidekick cached input · $4 / 1M Sidekick output",
            is_new: false,
            is_beta: false,
          },
        ],
      },
    ];
    const { requireServerAdapter, registerServerAdapter } = await import("../adapters/index.js");
    const { buildDiscoveredModels } = await import(
      "../../../packages/adapters/devin-local/src/server/models.js"
    );
    const base = requireServerAdapter("devin_local");
    const projected = buildDiscoveredModels(fusionFixture as never).models;
    registerServerAdapter({
      ...base,
      listModels: async () => projected,
      refreshModels: async () => projected,
    });
    try {
      const app = await createApp();
      const normal = await requestApp(app, (baseUrl) =>
        request(baseUrl).get("/api/companies/company-1/adapters/devin_local/models"),
      );
      const refreshed = await requestApp(app, (baseUrl) =>
        request(baseUrl).get("/api/companies/company-1/adapters/devin_local/models?refresh=1"),
      );
      for (const res of [normal, refreshed]) {
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const leaf = res.body.find((m: { id: string }) => m.id === fusionPair);
        expect(leaf).toBeDefined();
        expect(leaf.fusion).toMatchObject({
          version: 1,
          kind: "fusion",
          components: {
            orchestrator: { id: "alpha-1-high", effortKey: "high", effortSource: "uid" },
            worker: { id: "beta-2-medium", effortKey: "medium", effortSource: "uid" },
          },
          rates: {
            orchestrator: {
              inputPerMillion: 2,
              cachedInputPerMillion: 0.2,
              outputPerMillion: 8,
            },
            worker: {
              inputPerMillion: 1,
              cachedInputPerMillion: 0,
              outputPerMillion: 4,
            },
          },
        });
        expect(leaf.fusion?.costSummary).toContain("Sidekick output");
        expect(Object.keys(leaf).sort()).toEqual(["fusion", "id", "label"]);
        expect(Object.keys(leaf.fusion).sort()).toEqual([
          "components",
          "costSummary",
          "kind",
          "rates",
          "version",
        ]);
        expect(Object.keys(leaf.fusion.components.orchestrator).sort()).toEqual([
          "effortKey",
          "effortLabel",
          "effortSource",
          "id",
          "label",
          "modelKey",
          "modelLabel",
          "modifiers",
        ]);
        expect(Object.keys(leaf.fusion.rates.orchestrator).sort()).toEqual([
          "cachedInputPerMillion",
          "inputPerMillion",
          "outputPerMillion",
        ]);
        const wire = JSON.stringify(res.body);
        for (const marker of [
          "devin-internal-marker-command",
          "/private/marker/catalog-path",
          "marker-secret-value",
        ]) {
          expect(wire).not.toContain(marker);
        }
        expect(res.body.some((m: { id: string }) => m.id === "fusion")).toBe(false);
        expect(res.body.some((m: { id: string }) => m.id === "swe-1.7")).toBe(true);
      }
    } finally {
      await unregisterTestAdapter("devin_local");
    }
  });

  it("keeps OpenCode model discovery enabled for local environments", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: "env-1",
      companyId: "company-1",
      name: "Local",
      driver: "local",
      config: {},
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/adapters/opencode_local/models?environmentId=env-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([{ id: "dynamic-opencode-model", label: "dynamic-opencode-model" }]);
    expect(mockListOpenCodeModels).toHaveBeenCalledTimes(1);
  });
});
