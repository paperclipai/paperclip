import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => true),
  hasPermission: vi.fn(async () => false),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(
    async (_companyId: string, config: Record<string, unknown>) => config,
  ),
  normalizeMcpServersForPersistence: vi.fn(
    async (_companyId: string, mcpServers: Record<string, unknown>) => mcpServers,
  ),
  syncEnvBindingsForTarget: vi.fn(async () => []),
  syncMcpBindingsForTarget: vi.fn(async () => []),
}));

const mockCredentialService = vi.hoisted(() => ({
  listForAgent: vi.fn(async () => []),
  setForAgent: vi.fn(async () => ({ ok: true, credentials: [] })),
  validateForAdapterAssignment: vi.fn(async () => ({ ok: true, credentials: [] })),
  getById: vi.fn(async () => null),
  update: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() =>
  vi.fn((_agent: unknown, config: unknown) => config),
);
const mockFindServerAdapter = vi.hoisted(() => vi.fn((_type: string) => ({ type: _type })));
const mockMcpOauthService = vi.hoisted(() => ({
  startAuthorization: vi.fn(),
  handleCallback: vi.fn(),
  refreshExpiringTokensForAgent: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({}),
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    credentialService: () => mockCredentialService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => ({}),
  }));
  vi.doMock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
  vi.doMock("../services/mcp-oauth.js", () => ({ mcpOauthService: () => mockMcpOauthService }));
  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: mockFindServerAdapter,
    listAdapterModels: vi.fn(),
  }));
}

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222";

const boardActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const selfAgentActor = { type: "agent", agentId: AGENT_ID, companyId: "company-1" };
const otherAgentActor = { type: "agent", agentId: OTHER_AGENT_ID, companyId: "company-1" };

async function createApp(actor: Record<string, unknown> = boardActor) {
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
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

function makeAgent(adapterConfig: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig,
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
  };
}

const LINEAR_SERVER = {
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  headers: {
    Authorization: "Bearer lin_api_secret",
    "X-Env": "prod",
  },
};

describe("agent MCP server routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.canUser.mockResolvedValue(true);
    mockFindServerAdapter.mockImplementation((_type: string) => ({ type: _type }));
    mockSecretService.normalizeMcpServersForPersistence.mockImplementation(
      async (_companyId: string, mcpServers: Record<string, unknown>) => mcpServers,
    );
    mockAgentService.getById.mockImplementation(async (id: string) =>
      id === AGENT_ID
        ? makeAgent({ mcpServers: { linear: LINEAR_SERVER } })
        : id === OTHER_AGENT_ID
          ? { ...makeAgent(), id: OTHER_AGENT_ID, role: "engineer" }
          : null,
    );
    mockAgentService.update.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) =>
        makeAgent((patch.adapterConfig as Record<string, unknown>) ?? {}),
    );
  });

  it("GET returns servers with plain sensitive values redacted", async () => {
    const app = await createApp();
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/agents/${AGENT_ID}/mcp-servers`),
    );
    expect(response.status).toBe(200);
    const linear = response.body.mcpServers.linear;
    expect(linear.url).toBe("https://mcp.linear.app/mcp");
    expect(linear.headers.Authorization).toBe("***REDACTED***");
    expect(linear.headers["X-Env"]).toBe("prod");
  });

  it("PUT replaces the record, normalizes, syncs bindings, and logs activity", async () => {
    const app = await createApp();
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .put(`/api/agents/${AGENT_ID}/mcp-servers`)
        .send({
          mcpServers: {
            files: { transport: "stdio", command: "npx", args: ["-y", "files-mcp"] },
          },
        }),
    );
    expect(response.status).toBe(200);
    expect(mockSecretService.normalizeMcpServersForPersistence).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ files: expect.anything() }),
      expect.objectContaining({ strictMode: expect.any(Boolean) }),
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({
        adapterConfig: expect.objectContaining({ mcpServers: expect.anything() }),
      }),
      expect.objectContaining({ recordRevision: expect.anything() }),
    );
    expect(mockSecretService.syncMcpBindingsForTarget).toHaveBeenCalledWith(
      "company-1",
      { targetType: "agent", targetId: AGENT_ID },
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "agent.mcp_servers.replaced" }),
    );
  });

  it("rejects invalid server configs with 400-level errors", async () => {
    const app = await createApp();
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/agents/${AGENT_ID}/mcp-servers`)
        .send({ name: "bad name!", server: { transport: "http", url: "https://x.example/mcp" } }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("allows an agent to manage its own MCP servers", async () => {
    const app = await createApp(selfAgentActor);
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/agents/${AGENT_ID}/mcp-servers`)
        .send({
          name: "context7",
          server: { transport: "http", url: "https://mcp.context7.com/mcp" },
        }),
    );
    expect(response.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalled();
  });

  it("forbids a non-privileged agent from managing another agent's MCP servers", async () => {
    const app = await createApp(otherAgentActor);
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post(`/api/agents/${AGENT_ID}/mcp-servers`)
        .send({
          name: "context7",
          server: { transport: "http", url: "https://mcp.context7.com/mcp" },
        }),
    );
    expect(response.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("DELETE removes a named server and 404s for unknown names", async () => {
    const app = await createApp();
    const missing = await requestApp(app, (baseUrl) =>
      request(baseUrl).delete(`/api/agents/${AGENT_ID}/mcp-servers/nope`),
    );
    expect(missing.status).toBe(404);

    const removed = await requestApp(app, (baseUrl) =>
      request(baseUrl).delete(`/api/agents/${AGENT_ID}/mcp-servers/linear`),
    );
    expect(removed.status).toBe(200);
    const updateCall = mockAgentService.update.mock.calls.at(-1);
    const nextConfig = (updateCall?.[1] as { adapterConfig: { mcpServers: Record<string, unknown> } })
      .adapterConfig;
    expect(nextConfig.mcpServers).toEqual({});
  });

  it("starts OAuth via the broker and returns the authorize URL", async () => {
    mockMcpOauthService.startAuthorization.mockResolvedValue({
      authorizeUrl: "https://auth.example.com/authorize?x=1",
      state: "s",
    });
    const app = await createApp();
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${AGENT_ID}/mcp-servers/linear/oauth/start`).send({}),
    );
    expect(response.status).toBe(200);
    expect(response.body.authorizeUrl).toContain("https://auth.example.com/authorize");
    expect(mockMcpOauthService.startAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ID,
        serverName: "linear",
        serverUrl: "https://mcp.linear.app/mcp",
        redirectUri: expect.stringContaining("/api/mcp-oauth/callback"),
      }),
    );
  });
});
