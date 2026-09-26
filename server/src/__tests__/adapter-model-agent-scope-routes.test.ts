import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
  resolveEnvBindings: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
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

const mockBudgetService = vi.hoisted(() => ({ upsertPolicy: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({ cancelActiveForAgent: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({ linkManyForApproval: vi.fn() }));
const mockApprovalService = vi.hoisted(() => ({ create: vi.fn(), getById: vi.fn() }));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
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

  // The route imports secretService from the module directly, not the index.
  vi.doMock("../services/secrets.js", async () => {
    const actual = await vi.importActual<typeof import("../services/secrets.js")>("../services/secrets.js");
    return { ...actual, secretService: () => mockSecretService };
  });

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
}

const adapterType = "agent_scope_adapter_route_test";
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";

type Actor = Record<string, unknown>;

const boardActor: Actor = {
  type: "board",
  userId: "local-board",
  companyIds: [COMPANY_ID],
  source: "local_implicit",
  isInstanceAdmin: false,
};

function agentActor(agentId: string): Actor {
  return { type: "agent", agentId, companyId: COMPANY_ID, source: "agent_jwt" };
}

async function createApp(actor: Actor) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
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
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

/** Register a probe adapter that records the discovery context it receives. */
async function registerProbeAdapter() {
  const listModels = vi.fn(async () => [{ id: "probe-model", label: "probe-model" }]);
  const { registerServerAdapter } = await import("../adapters/index.js");
  const adapter: ServerAdapterModule = {
    type: adapterType,
    execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
    testEnvironment: async () => ({
      adapterType,
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    }),
    listModels,
  };
  registerServerAdapter(adapter);
  return listModels;
}

async function unregisterProbeAdapter() {
  const { unregisterServerAdapter } = await import("../adapters/index.js");
  unregisterServerAdapter(adapterType);
}

describe("adapter model route agent scoping", () => {
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
    mockLogActivity.mockResolvedValue(undefined);
    mockEnvironmentService.getById.mockResolvedValue(null);
    mockAgentService.getById.mockImplementation(async (id: string) => ({
      id,
      companyId: COMPANY_ID,
      adapterConfig: {
        env: {
          ANTHROPIC_BASE_URL: "http://gateway.local:8317",
          ANTHROPIC_API_KEY: { type: "secret_ref", id: "secret-1" },
          // Not a discovery key, so it must never reach the adapter.
          GITHUB_TOKEN: "ghp-unrelated",
        },
      },
    }));
    // Echo the bindings back as resolved values.
    mockSecretService.resolveEnvBindings.mockImplementation(
      async (_companyId: string, bindings: Record<string, unknown>) => ({
        env: Object.fromEntries(
          Object.keys(bindings).map((key) => [
            key,
            key === "ANTHROPIC_API_KEY" ? "sk-resolved" : String((bindings as any)[key]),
          ]),
        ),
      }),
    );
    await unregisterProbeAdapter();
  });

  afterEach(async () => {
    await unregisterProbeAdapter();
  });

  it("forwards the named agent's discovery env to the adapter", async () => {
    const listModels = await registerProbeAdapter();
    const app = await createApp(boardActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${COMPANY_ID}/adapters/${adapterType}/models?agentId=${AGENT_ID}`,
      ),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([{ id: "probe-model", label: "probe-model" }]);
    const ctx = listModels.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined;
    expect(ctx?.env).toEqual({
      ANTHROPIC_BASE_URL: "http://gateway.local:8317",
      ANTHROPIC_API_KEY: "sk-resolved",
    });
  });

  it("forwards only the discovery env keys, never unrelated agent secrets", async () => {
    await registerProbeAdapter();
    const app = await createApp(boardActor);

    await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${COMPANY_ID}/adapters/${adapterType}/models?agentId=${AGENT_ID}`,
      ),
    );

    const bindings = mockSecretService.resolveEnvBindings.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(bindings).sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
    expect(bindings).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("supplies an egress-guarded fetch alongside the agent env", async () => {
    const listModels = await registerProbeAdapter();
    const app = await createApp(boardActor);

    await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${COMPANY_ID}/adapters/${adapterType}/models?agentId=${AGENT_ID}`,
      ),
    );

    const ctx = listModels.mock.calls[0]?.[0] as { fetch?: unknown } | undefined;
    expect(typeof ctx?.fetch).toBe("function");
    expect(ctx?.fetch).not.toBe(globalThis.fetch);
  });

  it("ignores agentId when an agent caller names a different agent", async () => {
    const listModels = await registerProbeAdapter();
    const app = await createApp(agentActor(OTHER_AGENT_ID));

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${COMPANY_ID}/adapters/${adapterType}/models?agentId=${AGENT_ID}`,
      ),
    );

    // The request still succeeds, so the response reveals nothing about the
    // named agent — it simply falls back to the server's own environment.
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(listModels).toHaveBeenCalledWith(undefined);
    expect(mockSecretService.resolveEnvBindings).not.toHaveBeenCalled();
  });

  it("allows an agent caller to name itself", async () => {
    const listModels = await registerProbeAdapter();
    const app = await createApp(agentActor(AGENT_ID));

    await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${COMPANY_ID}/adapters/${adapterType}/models?agentId=${AGENT_ID}`,
      ),
    );

    const ctx = listModels.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined;
    expect(ctx?.env?.ANTHROPIC_BASE_URL).toBe("http://gateway.local:8317");
  });

  it("ignores an agent that belongs to another company", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: AGENT_ID,
      companyId: "99999999-9999-4999-8999-999999999999",
      adapterConfig: { env: { ANTHROPIC_BASE_URL: "http://elsewhere.local" } },
    });
    const listModels = await registerProbeAdapter();
    const app = await createApp(boardActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${COMPANY_ID}/adapters/${adapterType}/models?agentId=${AGENT_ID}`,
      ),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(listModels).toHaveBeenCalledWith(undefined);
    expect(mockSecretService.resolveEnvBindings).not.toHaveBeenCalled();
  });

  it("keeps the pre-existing behavior when no agentId is given", async () => {
    const listModels = await registerProbeAdapter();
    const app = await createApp(boardActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/${COMPANY_ID}/adapters/${adapterType}/models`),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(listModels).toHaveBeenCalledWith(undefined);
    expect(mockAgentService.getById).not.toHaveBeenCalled();
  });

  it("falls back to the server environment when secret resolution fails", async () => {
    mockSecretService.resolveEnvBindings.mockRejectedValue(new Error("secret unavailable"));
    const listModels = await registerProbeAdapter();
    const app = await createApp(boardActor);

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        `/api/companies/${COMPANY_ID}/adapters/${adapterType}/models?agentId=${AGENT_ID}`,
      ),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(listModels).toHaveBeenCalledWith(undefined);
  });
});
