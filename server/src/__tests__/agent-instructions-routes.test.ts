import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockBuiltInAgentService = vi.hoisted(() => ({
  ensureCompanyDefaultAgentGrants: vi.fn(),
}));

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

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({ addComment: vi.fn() }));
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  builtInAgentService: () => mockBuiltInAgentService,
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  environmentService: () => mockEnvironmentService,
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => ({}),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
  listAdapterModels: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => ({}),
    builtInAgentService: () => mockBuiltInAgentService,
    companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
    budgetService: () => ({}),
    heartbeatService: () => ({}),
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../adapters/index.js", () => ({
    findServerAdapter: mockFindServerAdapter,
    listAdapterModels: vi.fn(),
  }));
}

function boardActor() {
  return {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  };
}

async function createApp(
  actor: Record<string, unknown> = boardActor(),
  db: Record<string, unknown> = {},
) {
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

function makeAgent() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    permissions: null,
    updatedAt: new Date(),
  };
}

function linkedIssueDb() {
  let selectCount = 0;
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => {
          selectCount += 1;
          return selectCount === 1
            ? [{ contextSnapshot: { issueId: "33333333-3333-4333-8333-333333333333" } }]
            : [{
                id: "33333333-3333-4333-8333-333333333333",
                parentId: "44444444-4444-4444-8444-444444444444",
              }];
        }),
      })),
    })),
  };
}

function makeReflectionCoachAgent(overrides: Record<string, unknown> = {}) {
  return {
    ...makeAgent(),
    id: "22222222-2222-4222-8222-222222222222",
    name: "Reflection Coach",
    metadata: {
      paperclipBuiltInAgent: {
        key: "reflection-coach",
        featureKeys: ["reflection-coach"],
      },
    },
    ...overrides,
  };
}

describe("agent instructions bundle routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1" });
    mockBuiltInAgentService.ensureCompanyDefaultAgentGrants.mockResolvedValue(0);
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockFindServerAdapter.mockImplementation((_type: string) => ({ type: _type }));
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant",
    });
    mockAgentService.getById.mockResolvedValue(makeAgent());
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeAgent(),
      adapterConfig: patch.adapterConfig ?? {},
    }));
    mockAgentInstructionsService.getBundle.mockResolvedValue({
      agentId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
      resolvedEntryPath: "/tmp/agent-1/AGENTS.md",
      editable: true,
      warnings: [],
      legacyPromptTemplateActive: false,
      legacyBootstrapPromptTemplateActive: false,
      files: [{
        path: "AGENTS.md",
        size: 12,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
      }],
    });
    mockAgentInstructionsService.readFile.mockResolvedValue({
      path: "AGENTS.md",
      size: 12,
      language: "markdown",
      markdown: true,
      isEntryFile: true,
      editable: true,
      deprecated: false,
      virtual: false,
      content: "# Agent\n",
    });
    mockAgentInstructionsService.writeFile.mockResolvedValue({
      bundle: null,
      file: {
        path: "AGENTS.md",
        size: 18,
        language: "markdown",
        markdown: true,
        isEntryFile: true,
        editable: true,
        deprecated: false,
        virtual: false,
        content: "# Updated Agent\n",
      },
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
      },
    });
  });

  it("returns bundle metadata", async () => {
    const res = await requestApp(
      await createApp(),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle?companyId=company-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      mode: "managed",
      rootPath: "/tmp/agent-1",
      managedRootPath: "/tmp/agent-1",
      entryFile: "AGENTS.md",
    });
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
  });

  it("denies non-privileged agents from reading peer instructions bundles", async () => {
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-reader") {
        return {
          ...makeAgent(),
          id: "agent-reader",
          name: "Reader",
          permissions: { canCreateAgents: false },
        };
      }
      return makeAgent();
    });
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      reason: "deny_no_grant",
      explanation: "Missing permission: agents:configure or agents:suggest-changes.",
    });

    const res = await requestApp(
      await createApp({
        type: "agent",
        agentId: "agent-reader",
        companyId: "company-1",
        source: "agent_key",
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Missing permission");
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent_config:read",
      resource: {
        type: "agent",
        companyId: "company-1",
        agentId: "11111111-1111-4111-8111-111111111111",
      },
    }));
    expect(mockAgentInstructionsService.getBundle).not.toHaveBeenCalled();
  });

  it("allows agents to read their own instructions bundles", async () => {
    const res = await requestApp(
      await createApp({
        type: "agent",
        agentId: "11111111-1111-4111-8111-111111111111",
        companyId: "company-1",
        source: "agent_key",
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentInstructionsService.getBundle).toHaveBeenCalled();
  });

  it("allows agents with suggest grants to read peer instructions bundles", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      reason: "allow_explicit_grant",
      explanation: "Allowed by explicit grant agents:suggest-changes.",
      grant: {
        principalType: "agent",
        principalId: "coach-agent",
        permissionKey: "agents:suggest-changes",
        scope: null,
      },
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "coach-agent") {
        return makeReflectionCoachAgent({ id: "coach-agent" });
      }
      return makeAgent();
    });

    const res = await requestApp(
      await createApp({
        type: "agent",
        agentId: "coach-agent",
        companyId: "company-1",
        source: "agent_key",
      }),
      (baseUrl) => request(baseUrl)
        .get("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file")
        .query({ path: "AGENTS.md" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent_config:read",
      resource: {
        type: "agent",
        companyId: "company-1",
        agentId: "11111111-1111-4111-8111-111111111111",
      },
    }));
    expect(mockAgentInstructionsService.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      "AGENTS.md",
    );
  });

  it("writes a bundle file and persists compatibility config", async () => {
    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .put("/api/agents/11111111-1111-4111-8111-111111111111/instructions-bundle/file?companyId=company-1")
      .send({
        path: "AGENTS.md",
        content: "# Updated Agent\n",
        clearLegacyPromptTemplate: true,
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentInstructionsService.writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111" }),
      "AGENTS.md",
      "# Updated Agent\n",
      { clearLegacyPromptTemplate: true },
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("preserves managed instructions config when switching adapters", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterType: "claude_local",
        adapterConfig: {
          model: "claude-sonnet-4",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterType: "claude_local",
        adapterConfig: expect.objectContaining({
          model: "claude-sonnet-4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("preserves paperclip skill-sync selections when switching adapters", async () => {
    // Desired skills live inside the per-adapter config under
    // `paperclipSkillSync`, yet they are adapter-agnostic company-level
    // selections. Switching adapter type must not silently wipe them — the
    // server carries them over from the existing config the same way it
    // preserves env/cwd and the instructions bundle.
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-sonnet-4",
        paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
        _userLocked: ["paperclipSkillSync.desiredSkills"],
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterType: "codex_local",
        replaceAdapterConfig: true,
        adapterConfig: {
          model: "gpt-5.4",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterType: "codex_local",
        adapterConfig: expect.objectContaining({
          model: "gpt-5.4",
          paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
          _userLocked: ["model", "paperclipSkillSync.desiredSkills"],
        }),
      }),
      expect.any(Object),
    );
  });

  it("merges same-adapter config patches so instructions metadata is not dropped", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterConfig: {
          command: "codex --profile engineer",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          command: "codex --profile engineer",
          model: "gpt-5.4",
          instructionsBundleMode: "managed",
          instructionsRootPath: "/tmp/agent-1",
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        }),
      }),
      expect.any(Object),
    );
  });

  it("records changed adapter config fields as user locks", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        model: "gpt-5.4",
        env: { SAFE_FLAG: "before" },
        paperclipSkillSync: {
          desiredSkills: ["research"],
          lastSyncedAt: "2026-07-24T00:00:00.000Z",
        },
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterConfig: {
          model: "gpt-5.6",
          paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          model: "gpt-5.6",
          env: { SAFE_FLAG: "before" },
          paperclipSkillSync: {
            desiredSkills: ["research", "code-review"],
            lastSyncedAt: "2026-07-24T00:00:00.000Z",
          },
          _userLocked: ["model", "paperclipSkillSync.desiredSkills"],
        }),
      }),
      expect.any(Object),
    );
  });

  it.each([
    {
      label: "user",
      actor: boardActor(),
      existingAdapterConfig: { model: "gpt-5.4" },
      requestedAdapterConfig: { model: "gpt-5.6" },
      expectedAdapterConfig: { model: "gpt-5.6", _userLocked: ["model"] },
      expectedActorType: "user",
    },
    {
      label: "agent",
      actor: {
        type: "agent",
        agentId: "agent-editor",
        companyId: "company-1",
        source: "agent_key",
      },
      existingAdapterConfig: { paperclipSkillSync: { desiredSkills: ["research"] } },
      requestedAdapterConfig: {
        paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
      },
      expectedAdapterConfig: {
        paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
        _userLocked: [],
      },
      expectedActorType: "agent",
    },
  ])("uses canonical $label attribution for lock policy and activity", async ({
    actor,
    existingAdapterConfig,
    requestedAdapterConfig,
    expectedAdapterConfig,
    expectedActorType,
  }) => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: existingAdapterConfig,
    });

    const res = await requestApp(await createApp(actor), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({ adapterConfig: requestedAdapterConfig }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining(expectedAdapterConfig),
      }),
      expect.any(Object),
    );
    const activityEntries = mockLogActivity.mock.calls.map(([, entry]) => entry);
    expect(activityEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "agent.updated", actorType: expectedActorType }),
    ]));
    expect(activityEntries.every((entry) => entry.actorType === expectedActorType)).toBe(true);
  });

  it("allows an explicit unlock while locking fields changed in the same user patch", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        model: "gpt-5.4",
        command: "codex",
        _userLocked: ["model"],
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        adapterConfig: {
          command: "codex --profile engineer",
          _userLocked: [],
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          model: "gpt-5.4",
          command: "codex --profile engineer",
          _userLocked: ["command"],
        }),
      }),
      expect.any(Object),
    );
  });

  it("allows agent changes to paperclipSkillSync.desiredSkills", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        model: "gpt-5.4",
        paperclipSkillSync: { desiredSkills: ["research"] },
      },
    });

    const res = await requestApp(await createApp({
      type: "agent",
      agentId: "agent-editor",
      companyId: "company-1",
      source: "agent_key",
    }), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        adapterConfig: {
          paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          model: "gpt-5.4",
          paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
        }),
      }),
      expect.any(Object),
    );
  });

  it("rejects agent changes to locked fields and surfaces only redacted shapes", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        model: "gpt-5.4",
        command: "codex",
        env: { SECRET_TOKEN: "old-secret-value" },
        _userLocked: ["model", "env"],
      },
    });

    const res = await requestApp(await createApp({
      type: "agent",
      agentId: "agent-editor",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
      source: "agent_key",
    }, linkedIssueDb()), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        adapterConfig: {
          model: "gpt-5.6",
          command: "codex --profile engineer",
          env: { SECRET_TOKEN: "new-secret-value" },
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error).toContain("user-locked fields outside the allowlist: env, model");
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.adapter_config_change_skipped",
        details: {
          fields: expect.arrayContaining([
            { path: "command", type: "string", count: 1 },
            { path: "env", type: "object", count: 1 },
            { path: "model", type: "string", count: 1 },
          ]),
          changedCount: 0,
          skippedCount: 2,
          strippedCount: 3,
        },
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("old-secret-value");
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("new-secret-value");
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
      expect.stringContaining("Stripped fields: 3 (`command`, `env`, `model`)"),
      {
        agentId: "agent-editor",
        runId: "55555555-5555-4555-8555-555555555555",
      },
    );
    expect(JSON.stringify(mockIssueService.addComment.mock.calls)).not.toContain("old-secret-value");
    expect(JSON.stringify(mockIssueService.addComment.mock.calls)).not.toContain("new-secret-value");
  });

  it("authorizes before recording a denied agent adapter config attempt", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        model: "gpt-5.4",
        _userLocked: ["model"],
      },
    });
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      reason: "deny_missing_grant",
      explanation: "Missing agent_config:update grant",
    });

    const res = await requestApp(await createApp({
      type: "agent",
      agentId: "agent-editor",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
      source: "agent_key",
    }, linkedIssueDb()), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({ adapterConfig: { model: "gpt-5.6" } }));

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("strips unlocked agent fields, records the strip, and does not introduce env values", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        model: "gpt-5.4",
        paperclipSkillSync: { desiredSkills: ["research"] },
      },
    });

    const res = await requestApp(await createApp({
      type: "agent",
      agentId: "agent-editor",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
      source: "agent_key",
    }, linkedIssueDb()), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        replaceAdapterConfig: true,
        adapterConfig: {
          env: { NEW_VAR: "test-placeholder" },
          instructionsFilePath: "/tmp/untrusted",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const updatePatch = mockAgentService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.adapterConfig).toMatchObject({
      model: "gpt-5.4",
      paperclipSkillSync: { desiredSkills: ["research"] },
      _userLocked: [],
    });
    expect(JSON.stringify(updatePatch)).not.toContain("NEW_VAR");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.adapter_config_change_stripped",
        details: expect.objectContaining({
          changedCount: 0,
          skippedCount: 0,
          strippedCount: 2,
        }),
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
      expect.stringContaining("Stripped fields: 2 (`env`, `instructionsFilePath`)"),
      expect.any(Object),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("test-placeholder");
    expect(JSON.stringify(mockIssueService.addComment.mock.calls)).not.toContain("test-placeholder");
  });

  it("does not record a strip when an agent re-sends a value identical to the existing config", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        model: "gpt-5.4",
        paperclipSkillSync: { desiredSkills: ["research"] },
      },
    });

    const res = await requestApp(await createApp({
      type: "agent",
      agentId: "agent-editor",
      companyId: "company-1",
      source: "agent_key",
    }), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        adapterConfig: {
          model: "gpt-5.4",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const updatePatch = mockAgentService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.adapterConfig).toMatchObject({ model: "gpt-5.4" });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.adapter_config_changed",
        details: expect.objectContaining({
          changedCount: 0,
          skippedCount: 0,
          strippedCount: 0,
        }),
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "agent.adapter_config_change_stripped" }),
    );
  });

  it("still records a strip when an agent introduces a new value for a disallowed field", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp({
      type: "agent",
      agentId: "agent-editor",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
      source: "agent_key",
    }, linkedIssueDb()), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        adapterConfig: {
          model: "gpt-5.6",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const updatePatch = mockAgentService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updatePatch.adapterConfig).toMatchObject({ model: "gpt-5.4" });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.adapter_config_change_stripped",
        details: expect.objectContaining({
          fields: [{ path: "model", type: "string", count: 1 }],
          changedCount: 0,
          skippedCount: 0,
          strippedCount: 1,
        }),
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
      expect.stringContaining("Stripped fields: 1 (`model`)"),
      expect.any(Object),
    );
  });

  it("ignores replace semantics and preserves config when an agent sends only disallowed fields", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        model: "gpt-5.4",
        paperclipSkillSync: {
          desiredSkills: ["research"],
          lastSyncedAt: "2026-07-24T00:00:00.000Z",
        },
        _userLocked: ["paperclipSkillSync.desiredSkills"],
      },
    });

    const res = await requestApp(await createApp({
      type: "agent",
      agentId: "agent-editor",
      companyId: "company-1",
      source: "agent_key",
    }), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        replaceAdapterConfig: true,
        adapterConfig: { model: "gpt-5.6" },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          model: "gpt-5.4",
          paperclipSkillSync: expect.objectContaining({ desiredSkills: ["research"] }),
          _userLocked: ["paperclipSkillSync.desiredSkills"],
        }),
      }),
      expect.any(Object),
    );
  });

  it("classifies an agent acting on behalf of a user as an agent for the lock policy (TEC-7267)", async () => {
    // An agent JWT/key acting on behalf of a user populates `onBehalfOfUserId`.
    // The lock policy must key off `req.actor.type`, not the presence of a
    // responsible user id — otherwise the agent is misclassified as a user and
    // the locked `paperclipSkillSync.desiredSkills` restore is bypassed.
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        model: "gpt-5.4",
        paperclipSkillSync: { desiredSkills: ["research"] },
        _userLocked: ["paperclipSkillSync.desiredSkills"],
      },
    });

    const res = await requestApp(await createApp({
      type: "agent",
      agentId: "agent-editor",
      companyId: "company-1",
      onBehalfOfUserId: "88888888-8888-4888-8888-888888888888",
      onBehalfOfMemberships: [
        { companyId: "company-1", status: "active", membershipRole: "member" },
      ],
      runId: "55555555-5555-4555-8555-555555555555",
      source: "agent_key",
    }, linkedIssueDb()), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        adapterConfig: {
          paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const updatePatch = mockAgentService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    // The locked value is restored: the agent's attempted change is discarded.
    expect(updatePatch.adapterConfig).toMatchObject({
      paperclipSkillSync: { desiredSkills: ["research"] },
      _userLocked: ["paperclipSkillSync.desiredSkills"],
    });
    // The activity log records the skip rather than a persisted change.
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.adapter_config_change_skipped",
        details: expect.objectContaining({
          changedCount: 0,
          skippedCount: 1,
          strippedCount: 0,
        }),
      }),
    );
    // No `_userLocked` entry is authored for an agent attempt.
    expect((updatePatch.adapterConfig as Record<string, unknown>)._userLocked)
      .toEqual(["paperclipSkillSync.desiredSkills"]);
  });

  it("does not report an allowed nested desiredSkills write as a stripped path (TEC-7267)", async () => {
    // The allowlist audit path enumeration must reach the leaf so the allowed
    // `paperclipSkillSync.desiredSkills` write is not misreported as a strip of
    // its top-level `paperclipSkillSync` parent.
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterConfig: {
        model: "gpt-5.4",
        paperclipSkillSync: { desiredSkills: ["research"] },
      },
    });

    const res = await requestApp(await createApp({
      type: "agent",
      agentId: "agent-editor",
      companyId: "company-1",
      runId: "55555555-5555-4555-8555-555555555555",
      source: "agent_key",
    }, linkedIssueDb()), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({
        adapterConfig: {
          paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The write is persisted as a normal change, not a strip.
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.adapter_config_changed",
        details: expect.objectContaining({ strippedCount: 0 }),
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "agent.adapter_config_change_stripped" }),
    );
    // The linked-parent comment must not report a stripped path.
    const commentBodies = mockIssueService.addComment.mock.calls.map((call) => String(call[1]));
    for (const body of commentBodies) {
      expect(body).not.toContain("Stripped fields: 1");
      expect(body).not.toContain("`paperclipSkillSync`");
    }
  });

  it("replaces adapter config when replaceAdapterConfig is true", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...makeAgent(),
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "managed",
        instructionsRootPath: "/tmp/agent-1",
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: "/tmp/agent-1/AGENTS.md",
        model: "gpt-5.4",
      },
    });

    const res = await requestApp(await createApp(), (baseUrl) => request(baseUrl)
      .patch("/api/agents/11111111-1111-4111-8111-111111111111?companyId=company-1")
      .send({
        replaceAdapterConfig: true,
        adapterConfig: {
          command: "codex --profile engineer",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.adapterConfig).toMatchObject({
      command: "codex --profile engineer",
    });
    expect(res.body.adapterConfig.instructionsBundleMode).toBeUndefined();
    expect(res.body.adapterConfig.instructionsRootPath).toBeUndefined();
    expect(res.body.adapterConfig.instructionsEntryFile).toBeUndefined();
    expect(res.body.adapterConfig.instructionsFilePath).toBeUndefined();
  });
});
