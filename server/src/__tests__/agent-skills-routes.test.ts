import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
}));
const mockBudgetService = vi.hoisted(() => ({}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
  materializeManagedBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  syncEnvBindingsForTarget: vi.fn(),
}));

const mockCredentialService = vi.hoisted(() => ({
  listForAgent: vi.fn(async () => []),
  setForAgent: vi.fn(async () => ({ ok: true, credentials: [] })),
  validateForAdapterAssignment: vi.fn(async () => ({ ok: true, credentials: [] })),
  getById: vi.fn(async () => null),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockRunIdempotentAgentHire = vi.hoisted(() => vi.fn());

const mockAdapter = vi.hoisted(() => ({
  listSkills: vi.fn(),
  syncSkills: vi.fn(),
}));

function expectResponseId(value: unknown): string {
  expect(value).toEqual(expect.any(String));
  expect(value).not.toBe("");
  expect(value).not.toBe("undefined");
  return String(value);
}

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: mockTrackAgentCreated,
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  environmentService: () => mockEnvironmentService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  credentialService: () => mockCredentialService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/instance-settings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/instance-settings.js")>()),
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(() => mockAdapter),
  findActiveServerAdapter: vi.fn(() => mockAdapter),
  listAdapterModels: vi.fn(),
  detectAdapterModel: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: mockTrackAgentCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/agent-hire-idempotency.js", async () => {
    const actual = await vi.importActual<typeof import("../services/agent-hire-idempotency.js")>(
      "../services/agent-hire-idempotency.js",
    );
    return {
      ...actual,
      runIdempotentAgentHire: mockRunIdempotentAgentHire,
    };
  });

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
    credentialService: () => mockCredentialService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/instance-settings.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../services/instance-settings.js")>()),
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: vi.fn(() => mockAdapter),
    findActiveServerAdapter: vi.fn(() => mockAdapter),
    listAdapterModels: vi.fn(),
    detectAdapterModel: vi.fn(),
  }));
}

function createDb(requireBoardApprovalForNewAgents = false) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            requireBoardApprovalForNewAgents,
          },
        ]),
      })),
    })),
  };
}

async function createApp(db: Record<string, unknown> = createDb()) {
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

function makeAgent(adapterType: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType,
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
  };
}

describe.sequential("agent skill routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    for (const mock of Object.values(mockAgentService)) mock.mockReset();
    for (const mock of Object.values(mockAccessService)) mock.mockReset();
    for (const mock of Object.values(mockApprovalService)) mock.mockReset();
    for (const mock of Object.values(mockIssueApprovalService)) mock.mockReset();
    for (const mock of Object.values(mockAgentInstructionsService)) mock.mockReset();
    for (const mock of Object.values(mockCompanySkillService)) mock.mockReset();
    for (const mock of Object.values(mockInstanceSettingsService)) mock.mockReset();
    for (const mock of Object.values(mockSecretService)) mock.mockReset();
    for (const mock of Object.values(mockCredentialService)) mock.mockReset();
    mockLogActivity.mockReset();
    mockTrackAgentCreated.mockReset();
    mockGetTelemetryClient.mockReset();
    mockSyncInstructionsBundleConfigFromFilePath.mockReset();
    mockRunIdempotentAgentHire.mockReset();
    mockAdapter.listSkills.mockReset();
    mockAdapter.syncSkills.mockReset();
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    let persistedAgent: Record<string, unknown> | null = null;
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: makeAgent("claude_local"),
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValue({ config: { env: {} } });
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableBetaSkills: false });
    mockSecretService.syncEnvBindingsForTarget.mockResolvedValue(undefined);
    mockCredentialService.listForAgent.mockResolvedValue([]);
    mockCredentialService.setForAgent.mockResolvedValue({ ok: true, credentials: [] });
    mockCredentialService.validateForAdapterAssignment.mockResolvedValue({ ok: true, credentials: [] });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([
      {
        key: "paperclipai/paperclip/paperclip",
        runtimeName: "paperclip",
        source: "/tmp/paperclip",
      },
    ]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) =>
        requested.map((value) =>
          value === "paperclip"
            ? "paperclipai/paperclip/paperclip"
            : value,
        ),
    );
    mockCompanySkillService.resolveRequestedSkillEntries.mockImplementation(
      async (_companyId: string, requested: Array<{ key: string; versionId?: string | null }>) => ({
        resolved: requested.map((entry) => ({
          key: entry.key === "paperclip" ? "paperclipai/paperclip/paperclip" : entry.key,
          versionId: entry.versionId ?? null,
        })),
        unresolved: [],
      }),
    );
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });
    mockAdapter.syncSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      const previousAgent = persistedAgent ?? makeAgent("claude_local");
      persistedAgent = {
        ...previousAgent,
        ...patch,
        adapterConfig: patch.adapterConfig ?? previousAgent.adapterConfig ?? {},
      };
      return persistedAgent;
    });
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => {
      persistedAgent = {
        ...makeAgent(String(input.adapterType ?? "claude_local")),
        ...input,
        adapterConfig: input.adapterConfig ?? {},
        runtimeConfig: input.runtimeConfig ?? {},
        budgetMonthlyCents: Number(input.budgetMonthlyCents ?? 0),
        permissions: null,
      };
      return persistedAgent;
    });
    mockApprovalService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      id: "approval-1",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: input.payload ?? {},
    }));
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>, files: Record<string, string>) => ({
        bundle: null,
        adapterConfig: {
          ...((agent.adapterConfig as Record<string, unknown> | undefined) ?? {}),
          instructionsBundleMode: "managed",
          instructionsRootPath: `/tmp/${String(agent.id)}/instructions`,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: `/tmp/${String(agent.id)}/instructions/AGENTS.md`,
          promptTemplate: files["AGENTS.md"] ?? "",
        },
      }),
    );
    mockLogActivity.mockResolvedValue(undefined);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockRunIdempotentAgentHire.mockImplementation(
      async (_db: unknown, _input: unknown, create: () => Promise<unknown>) => ({
        value: await create(),
        replayed: false,
      }),
    );
  });

  it("skips runtime materialization when listing Claude skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", expect.objectContaining({
      materializeMissing: false,
      versionSelections: expect.any(Map),
    }));
    expect(mockAdapter.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "claude_local",
        config: expect.objectContaining({
          paperclipRuntimeSkills: expect.any(Array),
        }),
      }),
    );
  }, 10_000);

  it("lists skills without resolving required user-secret env bindings", async () => {
    const adapterConfig = {
      env: {
        HOME: "/home/agent",
        GH_TOKEN: {
          type: "user_secret_ref" as const,
          key: "github_pat_read_only",
          version: "latest" as const,
          required: true,
        },
      },
    };
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent("claude_local"),
      adapterConfig,
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementationOnce(
      async (
        _companyId: string,
        config: Record<string, unknown>,
        context?: unknown,
        opts?: { skipUserSecrets?: boolean },
      ) => {
        expect(config).toBe(adapterConfig);
        // Audit-only actor context is threaded through for company `secret_ref`
        // attribution; user secrets are still skipped (skipUserSecrets: true).
        expect(context).toEqual({
          consumerType: "agent",
          consumerId: "11111111-1111-4111-8111-111111111111",
          actorType: "user",
          actorId: "local-board",
          actorSource: "local_implicit",
          responsibleUserId: "local-board",
        });
        expect(opts).toEqual({ adapterType: "claude_local", skipUserSecrets: true });
        return { config: { env: { HOME: "/home/agent" } } };
      },
    );

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAdapter.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "claude_local",
        config: expect.objectContaining({
          env: { HOME: "/home/agent" },
          paperclipRuntimeSkills: expect.any(Array),
        }),
      }),
    );
  });

  it("threads a non-undefined actor secret context into resolveAdapterConfigForRuntime on both skills routes (audit fidelity, skipUserSecrets preserved)", async () => {
    const expectedContext = {
      consumerType: "agent",
      consumerId: "11111111-1111-4111-8111-111111111111",
      actorType: "user",
      actorId: "local-board",
      actorSource: "local_implicit",
      responsibleUserId: "local-board",
    };

    // GET /agents/:id/skills
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));
    const listRes = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1"),
    );
    expect(listRes.status, JSON.stringify(listRes.body)).toBe(200);
    const listCall = mockSecretService.resolveAdapterConfigForRuntime.mock.calls.at(-1);
    expect(listCall?.[2]).toBeDefined();
    expect(listCall?.[2]).toEqual(expectedContext);
    expect(listCall?.[3]).toEqual({ adapterType: "claude_local", skipUserSecrets: true });

    // POST /agents/:id/skills/sync
    mockAdapter.syncSkills.mockResolvedValue({
      adapterType: "claude_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });
    const syncRes = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
        .send({ desiredSkills: ["paperclip"], mode: "replace" }),
    );
    expect(syncRes.status, JSON.stringify(syncRes.body)).toBe(200);
    const syncCall = mockSecretService.resolveAdapterConfigForRuntime.mock.calls.at(-1);
    expect(syncCall?.[2]).toBeDefined();
    expect(syncCall?.[2]).toEqual(expectedContext);
    expect(syncCall?.[3]).toEqual({ adapterType: "claude_local", skipUserSecrets: true });
  });

  it("skips runtime materialization when listing Codex skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("codex_local"));
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "codex_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", expect.objectContaining({
      materializeMissing: false,
      versionSelections: expect.any(Map),
    }));
  });

  it("passes ACPX Claude config through the agent skill listing route", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent("acpx_local"),
      adapterConfig: { agent: "claude" },
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValueOnce({
      config: { agent: "claude" },
    });
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "acpx_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", expect.objectContaining({
      materializeMissing: false,
      versionSelections: expect.any(Map),
    }));
    expect(mockAdapter.listSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "acpx_local",
        config: expect.objectContaining({
          agent: "claude",
          paperclipRuntimeSkills: expect.any(Array),
        }),
      }),
    );
  });

  it("persists ACPX Codex desired skills through the agent skill sync route", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent("acpx_local"),
      adapterConfig: { agent: "codex" },
    });
    mockAgentService.update.mockImplementationOnce(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent("acpx_local"),
      adapterConfig: patch.adapterConfig ?? {},
    }));
    mockSecretService.resolveAdapterConfigForRuntime.mockResolvedValueOnce({
      config: {
        agent: "codex",
        paperclipSkillSync: {
          desiredSkills: ["paperclipai/paperclip/paperclip"],
        },
      },
    });
    mockAdapter.syncSkills.mockResolvedValue({
      adapterType: "acpx_local",
      supported: true,
      mode: "ephemeral",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclip"], mode: "replace" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          agent: "codex",
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
      expect.any(Object),
    );
    expect(mockAdapter.syncSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "acpx_local",
        config: expect.objectContaining({
          agent: "codex",
          paperclipRuntimeSkills: expect.any(Array),
        }),
      }),
      ["paperclipai/paperclip/paperclip"],
    );
  });

  it("requires an explicit actionable merge mode for skill sync", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclip"] }));

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain('"add", "remove", or "replace"');
    expect(res.body.error).toContain('"replace" only to overwrite');
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("adds only named desired skills while preserving existing assignments", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent("claude_local"),
      adapterConfig: {
        paperclipSkillSync: { desiredSkills: ["company-1/keep"] },
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclip"], mode: "add" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: {
            desiredSkills: ["company-1/keep", "paperclipai/paperclip/paperclip"],
          },
        }),
      }),
      expect.any(Object),
    );
  });

  it("removes only named desired skills while preserving other assignments", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent("claude_local"),
      adapterConfig: {
        paperclipSkillSync: {
          desiredSkills: ["company-1/keep", "paperclipai/paperclip/paperclip"],
        },
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclip"], mode: "remove" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: { desiredSkills: ["company-1/keep"] },
        }),
      }),
      expect.any(Object),
    );
  });

  it("replaces the complete desired skill set only when explicitly requested", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent("claude_local"),
      adapterConfig: {
        paperclipSkillSync: { desiredSkills: ["company-1/keep"] },
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclip"], mode: "replace" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: {
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          },
        }),
      }),
      expect.any(Object),
    );
  });

  it("rejects version pins while beta skills are disabled", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({
        mode: "replace",
        desiredSkills: [{
          key: "paperclipai/paperclip/paperclip",
          versionId: "22222222-2222-4222-8222-222222222222",
        }],
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toContain("Beta skills experimental setting");
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("accepts version pins while beta skills are enabled", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableBetaSkills: true });
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));
    const versionId = "22222222-2222-4222-8222-222222222222";

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({
        mode: "replace",
        desiredSkills: [{ key: "paperclipai/paperclip/paperclip", versionId }],
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: [{ key: "paperclipai/paperclip/paperclip", versionId }],
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it("preserves stale desired keys instead of 422-ing when syncing (PAP-13222)", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("acpx_local"));
    // The agent already carries a stale desired key that no longer resolves to a
    // company-library skill. Toggling a resolvable skill must still succeed and
    // keep the stale key so it stays visible/removable in the UI.
    mockCompanySkillService.resolveRequestedSkillEntries.mockImplementationOnce(
      async (
        _companyId: string,
        requested: Array<{ key: string; versionId?: string | null }>,
        options?: { tolerateUnknownReferences?: boolean },
      ) => {
        expect(options?.tolerateUnknownReferences).toBe(true);
        const resolved: Array<{ key: string; versionId: string | null }> = [];
        const unresolved: string[] = [];
        for (const entry of requested) {
          if (entry.key === "stale/removed/skill") {
            unresolved.push(entry.key);
          } else {
            resolved.push({
              key: entry.key === "paperclip" ? "paperclipai/paperclip/paperclip" : entry.key,
              versionId: entry.versionId ?? null,
            });
          }
        }
        return { resolved, unresolved };
      },
    );

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclip", "stale/removed/skill"], mode: "replace" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Stale key preserved in the persisted config alongside the resolved skill.
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip", "stale/removed/skill"],
          }),
        }),
      }),
      expect.any(Object),
    );
    // Runtime version selection only considers resolvable keys.
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ versionSelections: expect.any(Map) }),
    );
    const versionSelections = mockCompanySkillService.listRuntimeSkillEntries.mock.calls.at(-1)?.[1]
      ?.versionSelections as Map<string, unknown> | undefined;
    expect(versionSelections?.has("stale/removed/skill")).toBe(false);
  });

  it("skips runtime materialization when listing persistent skill adapters", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("cursor"));
    mockAdapter.listSkills.mockResolvedValue({
      adapterType: "cursor",
      supported: true,
      mode: "persistent",
      desiredSkills: ["paperclipai/paperclip/paperclip"],
      entries: [],
      warnings: [],
    });

    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/skills?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockCompanySkillService.listRuntimeSkillEntries).toHaveBeenCalledWith("company-1", expect.objectContaining({
      materializeMissing: false,
      versionSelections: expect.any(Map),
    }));
  });

  it("skips runtime materialization when syncing Claude skills", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclipai/paperclip/paperclip"], mode: "replace" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAdapter.syncSkills).toHaveBeenCalled();
  });

  it("syncs skills without resolving required user-secret env bindings", async () => {
    const adapterConfig = {
      env: {
        HOME: "/home/agent",
        GH_TOKEN: {
          type: "user_secret_ref" as const,
          key: "github_pat_read_only",
          version: "latest" as const,
          required: true,
        },
      },
    };
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent("claude_local"),
      adapterConfig,
    });
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementationOnce(
      async (
        _companyId: string,
        config: Record<string, unknown>,
        context?: unknown,
        opts?: { skipUserSecrets?: boolean },
      ) => {
        expect((config.env as Record<string, unknown>).GH_TOKEN).toMatchObject({
          type: "user_secret_ref",
          key: "github_pat_read_only",
        });
        // Audit-only actor context is threaded through for company `secret_ref`
        // attribution; user secrets are still skipped (skipUserSecrets: true).
        expect(context).toEqual({
          consumerType: "agent",
          consumerId: "11111111-1111-4111-8111-111111111111",
          actorType: "user",
          actorId: "local-board",
          actorSource: "local_implicit",
          responsibleUserId: "local-board",
        });
        expect(opts).toEqual({ adapterType: "claude_local", skipUserSecrets: true });
        return {
          config: {
            ...config,
            env: { HOME: "/home/agent" },
          },
        };
      },
    );

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclipai/paperclip/paperclip"], mode: "replace" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAdapter.syncSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterType: "claude_local",
        config: expect.objectContaining({
          env: { HOME: "/home/agent" },
          paperclipRuntimeSkills: expect.any(Array),
        }),
      }),
      ["paperclipai/paperclip/paperclip"],
    );
  });

  it("canonicalizes desired skill references before syncing", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent("claude_local"));

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/agents/11111111-1111-4111-8111-111111111111/skills/sync?companyId=company-1")
      .send({ desiredSkills: ["paperclip"], mode: "replace" }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it("persists canonical desired skills when creating an agent directly", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const createdAgentId = expectResponseId(res.body.id);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
    expect(mockTrackAgentCreated).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: createdAgentId,
        agentRole: "engineer",
      }),
    );
  });

  it("validates and persists an explicit credential assignment when creating an agent", async () => {
    const credentialIds = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];
    const credentials = credentialIds.map((id, index) => ({
      id,
      name: `Claude ${index + 1}`,
      type: "claude_api_key",
    }));
    mockCredentialService.validateForAdapterAssignment.mockResolvedValue({ ok: true, credentials });
    mockCredentialService.setForAgent.mockResolvedValue({ ok: true, credentials });
    mockCredentialService.listForAgent.mockResolvedValue(credentials);

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "Credential Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        credentialIds,
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCredentialService.validateForAdapterAssignment).toHaveBeenCalledWith({
      companyId: "company-1",
      adapterType: "claude_local",
      adapterConfig: expect.any(Object),
      credentialIds,
    });
    expect(mockCredentialService.setForAgent).toHaveBeenCalledWith(
      expect.any(String),
      credentialIds,
      expect.objectContaining({ adapterType: "claude_local" }),
    );
    expect(res.body.credentials).toEqual(credentials);
  }, 30_000);

  it("replaces an agent's credential assignment through PATCH", async () => {
    const agent = makeAgent("claude_local");
    const credentialIds = ["33333333-3333-4333-8333-333333333333"];
    const credentials = [{ id: credentialIds[0], name: "Claude staging", type: "claude_api_key" }];
    mockAgentService.getById.mockResolvedValue(agent);
    mockCredentialService.validateForAdapterAssignment.mockResolvedValue({ ok: true, credentials });
    mockCredentialService.setForAgent.mockResolvedValue({ ok: true, credentials });
    mockCredentialService.listForAgent.mockResolvedValue(credentials);

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agent.id}`)
      .send({ credentialIds }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      agent.id,
      {},
      expect.any(Object),
    );
    expect(mockCredentialService.setForAgent).toHaveBeenCalledWith(
      agent.id,
      credentialIds,
      expect.objectContaining({ adapterType: "claude_local" }),
    );
    expect(res.body.credentials).toEqual(credentials);
  }, 30_000);

  it("persists credential assignment when hiring an agent", async () => {
    const credentialIds = ["44444444-4444-4444-8444-444444444444"];
    const credentials = [{ id: credentialIds[0], name: "Claude hire", type: "claude_api_key" }];
    mockCredentialService.validateForAdapterAssignment.mockResolvedValue({ ok: true, credentials });
    mockCredentialService.setForAgent.mockResolvedValue({ ok: true, credentials });
    mockCredentialService.listForAgent.mockResolvedValue(credentials);

    const res = await requestApp(await createApp(createDb(true)), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "Credential Hire",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        credentialIds,
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockCredentialService.validateForAdapterAssignment).toHaveBeenCalledWith({
      companyId: "company-1",
      adapterType: "claude_local",
      adapterConfig: expect.any(Object),
      credentialIds,
    });
    expect(mockCredentialService.setForAgent).toHaveBeenCalledWith(
      expect.any(String),
      credentialIds,
      expect.objectContaining({ adapterType: "claude_local" }),
    );
    expect(res.body.agent.credentials).toEqual(credentials);
  }, 30_000);

  it("rejects version pins when creating an agent while beta skills are disabled", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: [{
          key: "paperclipai/paperclip/paperclip",
          versionId: "22222222-2222-4222-8222-222222222222",
        }],
        adapterConfig: {},
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toContain("Beta skills experimental setting");
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("accepts the security role on direct agent creation and preserves it in telemetry", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "Security Engineer",
        role: "security",
        adapterType: "claude_local",
        adapterConfig: {},
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const createdAgentId = expectResponseId(res.body.id);
    expect(res.body).toMatchObject({
      role: "security",
    });
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        role: "security",
      }),
    );
    expect(mockTrackAgentCreated).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: createdAgentId,
        agentRole: "security",
      }),
    );
  });

  it("materializes a managed AGENTS.md for directly created local agents", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        instructionsBundle: {
          files: {
            "AGENTS.md": "You are QA.",
          },
        },
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const createdAgentId = expectResponseId(res.body.id);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      createdAgentId,
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsEntryFile: "AGENTS.md",
          instructionsRootPath: `/tmp/${createdAgentId}/instructions`,
          instructionsFilePath: `/tmp/${createdAgentId}/instructions/AGENTS.md`,
        }),
      }),
      expect.objectContaining({ allowPendingApprovalConfigUpdate: true }),
    );
    expect(mockAgentService.update.mock.calls.at(-1)?.[1]).not.toMatchObject({
      adapterConfig: expect.objectContaining({
        promptTemplate: expect.anything(),
      }),
    });
  });

  it("rejects legacy prompt templates for directly created local agents", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          instructionsFilePath: "/tmp/existing/AGENTS.md",
          promptTemplate: "You are QA.",
          bootstrapPromptTemplate: "Bootstrap QA.",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("New agents must use instructionsBundle/AGENTS.md");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.materializeManagedBundle).not.toHaveBeenCalled();
  });

  it("materializes the bundled CEO instruction set for default CEO agents", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "CEO",
        role: "ceo",
        adapterType: "claude_local",
        adapterConfig: {},
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const createdAgentId = expectResponseId(res.body.id);
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        id: createdAgentId,
        role: "ceo",
        adapterType: "claude_local",
      }),
      expect.objectContaining({
        "AGENTS.md": expect.stringMatching(/You are the CEO\.[\s\S]*Operating harness bootstrap \(critical\)[\s\S]*smallest complete set of capability lanes/),
        "HEARTBEAT.md": expect.stringMatching(/CEO Heartbeat Checklist[\s\S]*Operating Harness Refresh[\s\S]*Capability fit is authoritative/),
        "SOUL.md": expect.stringContaining("CEO Persona"),
        "TOOLS.md": expect.stringContaining("# Tools"),
      }),
      { entryFile: "AGENTS.md", replaceExisting: false },
    );

    const ceoBundle = mockAgentInstructionsService.materializeManagedBundle.mock.calls
      .find((call) => call[0]?.role === "ceo")?.[1] as Record<string, string> | undefined;
    expect(ceoBundle).toBeDefined();
    expect(ceoBundle?.["AGENTS.md"]).toContain("structured issue interaction");
    expect(ceoBundle?.["AGENTS.md"]).toContain("required evidence outputs");
    expect(ceoBundle?.["AGENTS.md"]).toContain("explicit escalation path");
    expect(ceoBundle?.["AGENTS.md"]).toContain("Do not treat a pending hire as a reason to stop useful planning");
    expect(ceoBundle?.["AGENTS.md"]).not.toMatch(/founding[ _-]?engineer/i);
    expect(ceoBundle?.["AGENTS.md"]).not.toContain("default to the CTO");
    expect(ceoBundle?.["AGENTS.md"]).not.toContain("hire one before delegating");
  });

  it("materializes the bundled default instruction set for non-CEO agents with no prompt template", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/agents")
      .send({
        name: "Engineer",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
      }));

    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    const createdAgentId = expectResponseId(res.body.id);
    await vi.waitFor(() => {
      expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          id: createdAgentId,
          role: "engineer",
          adapterType: "claude_local",
        }),
        expect.objectContaining({
          "AGENTS.md": expect.stringMatching(/Start actionable work in the same heartbeat\.[\s\S]*Keep the work moving until it is done\./),
        }),
        { entryFile: "AGENTS.md", replaceExisting: false },
      );
      expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          "AGENTS.md": expect.stringContaining('kind: "request_confirmation"'),
        }),
        expect.any(Object),
      );
      expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          "AGENTS.md": expect.stringContaining("confirmation:{issueId}:plan:{revisionId}"),
        }),
        expect.any(Object),
      );
      expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          "AGENTS.md": expect.stringMatching(/PUT \/issues\/\{id\}\/documents\/plan[\s\S]*Re-`GET \/documents\/plan`, assert it returns `200`[\s\S]*latestRevisionId[\s\S]*target=\{ type: 'issue_document', key: 'plan', revisionId: latestRevisionId \}[\s\S]*Never present a plan only in a thread comment or through `ask_user_questions`/),
        }),
        expect.any(Object),
      );
      expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          "AGENTS.md": expect.stringContaining("skills/paperclip/scripts/paperclip-upload-artifact.sh"),
        }),
        expect.any(Object),
      );
    });
  });

  it("includes canonical desired skills in hire approvals", async () => {
    const db = createDb(true);

    const res = await request(await createApp(db))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          desiredSkills: ["paperclipai/paperclip/paperclip"],
          requestedConfigurationSnapshot: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
  });

  it("passes a company-scoped key and normalized request fingerprint through keyed hires", async () => {
    const db = createDb(true);

    const res = await request(await createApp(db))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
        idempotencyKey: "  harness:quality-verifier:v1  ",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockRunIdempotentAgentHire).toHaveBeenCalledWith(
      db,
      {
        companyId: "company-1",
        idempotencyKey: "harness:quality-verifier:v1",
        requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      expect.any(Function),
    );
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          _paperclipHireRequest: {
            idempotencyKey: "harness:quality-verifier:v1",
            requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        }),
      }),
      { allowServerManagedHireMetadata: true },
    );
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          idempotencyKey: "harness:quality-verifier:v1",
          requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
  });

  it("rejects client injection of server-managed hire metadata on create, hire, and update routes", async () => {
    const app = await createApp(createDb(false));
    const reservedMetadata = {
      _paperclipHireRequest: {
        idempotencyKey: "harness:squatted:v1",
        requestFingerprint: "f".repeat(64),
      },
    };

    const [directCreate, hireCreate, update] = await Promise.all([
      request(app)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Injected Direct Agent",
          role: "engineer",
          adapterType: "process",
          adapterConfig: {},
          metadata: reservedMetadata,
        }),
      request(app)
        .post("/api/companies/company-1/agent-hires")
        .send({
          name: "Injected Hire Agent",
          role: "engineer",
          adapterType: "process",
          adapterConfig: {},
          metadata: reservedMetadata,
        }),
      request(app)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ metadata: reservedMetadata }),
    ]);

    expect(directCreate.status).toBe(400);
    expect(hireCreate.status).toBe(400);
    expect(update.status).toBe(400);
    expect(JSON.stringify(directCreate.body)).toContain("reserved for server-managed hire idempotency");
    expect(JSON.stringify(hireCreate.body)).toContain("reserved for server-managed hire idempotency");
    expect(JSON.stringify(update.body)).toContain("reserved for server-managed hire idempotency");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("returns an existing keyed hire without repeating creation side effects", async () => {
    const existingAgent = {
      ...makeAgent("claude_local"),
      status: "pending_approval",
    };
    const existingApproval = {
      id: "approval-existing",
      companyId: "company-1",
      type: "hire_agent",
      status: "pending",
      payload: { agentId: existingAgent.id },
    };
    mockRunIdempotentAgentHire.mockResolvedValueOnce({
      value: { agent: existingAgent, approval: existingApproval },
      replayed: true,
    });

    const res = await request(await createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        idempotencyKey: "harness:quality-verifier:v1",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.agent.id).toBe(existingAgent.id);
    expect(res.body.approval.id).toBe(existingApproval.id);
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockTrackAgentCreated).not.toHaveBeenCalled();
    expect(mockAccessService.setPrincipalPermission).not.toHaveBeenCalled();
  });

  it("keeps keyed fingerprints stable across generated gateway device keys", async () => {
    const db = createDb(true);
    const app = await createApp(db);
    const payload = {
      name: "Gateway Operator",
      role: "engineer",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      idempotencyKey: "harness:gateway-operator:v1",
    };

    const first = await request(app)
      .post("/api/companies/company-1/agent-hires")
      .send(payload);
    const second = await request(app)
      .post("/api/companies/company-1/agent-hires")
      .send(payload);

    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const keyedCalls = mockRunIdempotentAgentHire.mock.calls.map((call) => call[1] as {
      requestFingerprint: string;
    });
    expect(keyedCalls).toHaveLength(2);
    expect(keyedCalls[0]?.requestFingerprint).toBe(keyedCalls[1]?.requestFingerprint);
    const generatedDeviceKeys = mockAgentService.create.mock.calls.map((call) =>
      (call[1] as { adapterConfig?: { devicePrivateKeyPem?: string } })
        .adapterConfig?.devicePrivateKeyPem,
    );
    expect(generatedDeviceKeys).toHaveLength(2);
    expect(generatedDeviceKeys.every((value) => typeof value === "string" && value.length > 0)).toBe(true);
    expect(generatedDeviceKeys[0]).not.toBe(generatedDeviceKeys[1]);
  });

  it("rejects version pins in agent hires while beta skills are disabled", async () => {
    const res = await request(await createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        desiredSkills: [{
          key: "paperclipai/paperclip/paperclip",
          versionId: "22222222-2222-4222-8222-222222222222",
        }],
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toContain("Beta skills experimental setting");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("preserves hire source issues, icons, desired skills, and approval payload details", async () => {
    const db = createDb(true);
    const sourceIssueId = "22222222-2222-4222-8222-222222222222";

    const res = await request(await createApp(db))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "Security Engineer",
        role: "engineer",
        icon: "crown",
        adapterType: "claude_local",
        desiredSkills: ["paperclip"],
        adapterConfig: {},
        sourceIssueId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        icon: "crown",
        adapterConfig: expect.objectContaining({
          paperclipSkillSync: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          icon: "crown",
          desiredSkills: ["paperclipai/paperclip/paperclip"],
          requestedConfigurationSnapshot: expect.objectContaining({
            desiredSkills: ["paperclipai/paperclip/paperclip"],
          }),
        }),
      }),
    );
    expect(mockIssueApprovalService.linkManyForApproval).toHaveBeenCalledWith(
      "approval-1",
      [sourceIssueId],
      { agentId: null, userId: "local-board" },
    );
  });

  it("uses managed AGENTS config in hire approval payloads", async () => {
    const res = await request(await createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {},
        instructionsBundle: {
          files: {
            "AGENTS.md": "You are QA.",
          },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const approvalInput = mockApprovalService.create.mock.calls.at(-1)?.[1] as
      | { payload?: { agentId?: string; adapterConfig?: Record<string, unknown> } }
      | undefined;
    const hiredAgentId = expectResponseId(approvalInput?.payload?.agentId);
    expect(mockApprovalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          adapterConfig: expect.objectContaining({
            instructionsBundleMode: "managed",
            instructionsEntryFile: "AGENTS.md",
            instructionsRootPath: `/tmp/${hiredAgentId}/instructions`,
            instructionsFilePath: `/tmp/${hiredAgentId}/instructions/AGENTS.md`,
          }),
        }),
      }),
    );
    expect(approvalInput?.payload?.adapterConfig?.promptTemplate).toBeUndefined();
  });

  it("rejects legacy prompt templates for hire approval payloads", async () => {
    const res = await request(await createApp(createDb(true)))
      .post("/api/companies/company-1/agent-hires")
      .send({
        name: "QA Agent",
        role: "engineer",
        adapterType: "claude_local",
        adapterConfig: {
          instructionsFilePath: "/tmp/existing/AGENTS.md",
          promptTemplate: "You are QA.",
          bootstrapPromptTemplate: "Bootstrap QA.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("New agents must use instructionsBundle/AGENTS.md");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockAgentInstructionsService.materializeManagedBundle).not.toHaveBeenCalled();
  });
});
