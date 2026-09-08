import express from "express";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ServerAdapterModule } from "../adapters/index.js";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  update: vi.fn(),
}));

const mockAdapterPluginStore = vi.hoisted(() => ({
  getDisabledAdapterTypes: vi.fn<() => string[]>(() => []),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
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
  syncEnvBindingsForTarget: vi.fn(),
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
  getExperimental: vi.fn(async () => ({ enableNativeRunner: false })),
}));

const mockManagedAgentProfileService = vi.hoisted(() => ({
  requireQualified: vi.fn(),
}));

const mockRemoteAgentProfileService = vi.hoisted(() => ({
  requireQualified: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
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

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/managed-agent-profiles.js", () => ({
  managedAgentProfileService: () => mockManagedAgentProfileService,
}));

vi.mock("../services/remote-agent-profiles.js", () => ({
  remoteAgentProfileService: () => mockRemoteAgentProfileService,
}));

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

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/managed-agent-profiles.js", () => ({
    managedAgentProfileService: () => mockManagedAgentProfileService,
  }));

  vi.doMock("../services/remote-agent-profiles.js", () => ({
    remoteAgentProfileService: () => mockRemoteAgentProfileService,
  }));

  // The adapter registry reads the disabled set from this store. Mock it so a
  // test can declare an adapter disabled without writing to the real
  // ~/.paperclip/adapter-settings.json.
  vi.doMock("../services/adapter-plugin-store.js", () => ({
    getDisabledAdapterTypes: mockAdapterPluginStore.getDisabledAdapterTypes,
    isAdapterDisabled: (type: string) =>
      mockAdapterPluginStore.getDisabledAdapterTypes().includes(type),
    listAdapterPlugins: () => [],
    getAdapterPluginByType: () => undefined,
    setAdapterDisabled: vi.fn(),
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
  });

  afterEach(async () => {
    await unregisterTestAdapter("external_test");
    await unregisterTestAdapter(missingAdapterType);
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

  it("does not inject CODEX_HOME or OPENAI_API_KEY when creating a keyless codex_local agent", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Codex Agent",
          adapterType: "codex_local",
          adapterConfig: {},
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const createInput = mockAgentService.create.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const adapterConfig = createInput.adapterConfig as Record<string, unknown>;
    const env = (adapterConfig.env as Record<string, unknown> | undefined) ?? {};
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it("does not re-inject CODEX_HOME or OPENAI_API_KEY when updating a keyless codex_local agent", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({
          adapterConfig: { model: "gpt-5.4" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const adapterConfig = patch.adapterConfig as Record<string, unknown>;
    const env = (adapterConfig.env as Record<string, unknown> | undefined) ?? {};
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it("forwards a claude_local→process adapter move that drops the OAuth binding to the service unchanged", async () => {
    // The agent has the fixed Claude Code OAuth binding on the claude_local
    // adapter. A PATCH moves the agent to the process adapter and sends an empty
    // env in the same request. The route must forward the new adapter type and
    // the dropped binding to the service without a re-injection, so the
    // service-enforced binding invariant sees the removal and rejects it.
    const agentId = "11111111-1111-4111-8111-111111111111";
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId: "company-1",
      name: "Claude",
      urlKey: "claude",
      role: "engineer",
      title: null,
      icon: null,
      status: "idle",
      reportsTo: null,
      capabilities: null,
      adapterType: "claude_local",
      adapterConfig: { env: { CLAUDE_CODE_OAUTH_TOKEN: { type: "user_secret_ref", key: "CLAUDE_CODE_OAUTH_TOKEN" } } },
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
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({
          adapterType: "process",
          adapterConfig: { env: {} },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    // The route forwards the requested adapter type, so the service can see the
    // adapter move.
    expect(patch.adapterType).toBe("process");
    // The route does not re-inject the fixed binding from the prior config, so
    // the service invariant sees the removal.
    const env = ((patch.adapterConfig as Record<string, unknown>).env as Record<string, unknown> | undefined) ?? {};
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("isolates CODEX_HOME when updating a codex_local agent to set its own OPENAI_API_KEY", async () => {
    const agentId = "11111111-1111-4111-8111-111111111111";
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({
          adapterConfig: {
            env: {
              OPENAI_API_KEY: "sk-test-key",
            },
          },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patch = mockAgentService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const adapterConfig = patch.adapterConfig as Record<string, unknown>;
    const env = adapterConfig.env as Record<string, unknown>;
    expect(env.OPENAI_API_KEY).toBe("sk-test-key");
    expect(String(env.CODEX_HOME)).toContain(`/companies/company-1/agents/${agentId}/codex-home`);
  });

  it("allows codex_local agents to share the host Codex home", async () => {
    const app = await createApp();
    const sharedHome = path.join(os.homedir(), ".codex");
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Shared Codex",
          adapterType: "codex_local",
          adapterConfig: {
            env: {
              CODEX_HOME: sharedHome,
            },
          },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const createInput = mockAgentService.create.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const adapterConfig = createInput.adapterConfig as Record<string, unknown>;
    const env = adapterConfig.env as Record<string, unknown>;
    expect(env.CODEX_HOME).toBe(sharedHome);
  });

  it("isolates CODEX_HOME when a codex_local agent sets its own OPENAI_API_KEY", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Keyed Codex",
          adapterType: "codex_local",
          adapterConfig: {
            env: {
              OPENAI_API_KEY: "sk-test-key",
            },
          },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const createInput = mockAgentService.create.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    const agentId = String(createInput.id);
    const adapterConfig = createInput.adapterConfig as Record<string, unknown>;
    const env = adapterConfig.env as Record<string, unknown>;
    expect(env.OPENAI_API_KEY).toBe("sk-test-key");
    expect(String(env.CODEX_HOME)).toContain(`/companies/company-1/agents/${agentId}/codex-home`);
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

  it("refuses to create an agent on an adapter the instance has disabled", async () => {
    // A disabled adapter is one the instance cannot run (e.g. curated out of
    // PAPERCLIP_ADAPTERS). Creating an agent on it "succeeds" and then every
    // run of that agent dies at lease time with "not in the configured adapter
    // registry", so the refusal belongs here, where it can name the choices.
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue(["external_test"]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({ name: "Disabled Harness", adapterType: "external_test" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const message = String(res.body.error ?? res.body.message ?? "");
    expect(message).toContain('Adapter "external_test" is not available on this instance');
    // The message must be actionable: it names what CAN be chosen.
    expect(message).toMatch(/Available adapters?: .+/);
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("refuses to switch an existing agent onto a disabled adapter", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue(["external_test"]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterType: "external_test" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(String(res.body.error ?? res.body.message ?? "")).toContain(
      'Adapter "external_test" is not available on this instance',
    );
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("still lets an agent already on a disabled adapter be edited", async () => {
    // Disabling an adapter must not make the agents that already use it
    // uneditable — only NEW selections of it are refused.
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue(["codex_local"]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterType: "codex_local", adapterConfig: { model: "gpt-5.4" } }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("still creates an agent on an adapter that is registered and enabled", async () => {
    const { registerServerAdapter } = await import("../adapters/index.js");
    registerServerAdapter(externalAdapter);
    mockAdapterPluginStore.getDisabledAdapterTypes.mockReturnValue(["some_other_adapter"]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({ name: "Enabled Harness", adapterType: "external_test" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("rejects a new paperclip_runner selection while the rollout flag is off", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({ name: "Native Codex", adapterType: "paperclip_runner" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({ code: "paperclip_runner_rollout_disabled" });
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("allows a new paperclip_runner selection while the rollout flag is on", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Native Codex",
          adapterType: "paperclip_runner",
          adapterConfig: {
            provider: "codex",
            paperclipSkillSync: {
              desiredSkills: ["paperclipai/paperclip/paperclip", "company-1/reviewer"],
            },
          },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          provider: "codex",
          model: "gpt-5.6-sol",
          codexPermissionMode: "never",
          lifecycleMode: "per_turn",
          paperclipSkillSync: { desiredSkills: ["company-1/reviewer"] },
        }),
      }),
      expect.any(Object),
    );
    expect(mockAgentInstructionsService.materializeManagedBundle).toHaveBeenCalledWith(
      expect.objectContaining({ adapterType: "paperclip_runner" }),
      expect.any(Object),
      expect.objectContaining({ entryFile: "AGENTS.md", replaceExisting: false }),
    );
  });

  it("normalizes legacy skills and permissions when switching to paperclip_runner", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({
      ...existing,
      adapterType: "codex_local",
      adapterConfig: {
        model: "gpt-5.5",
        paperclipSkillSync: {
          desiredSkills: ["paperclipai/paperclip/paperclip", "company-1/reviewer"],
        },
      },
    });
    const app = await createApp();

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterType: "paperclip_runner", replaceAdapterConfig: true, adapterConfig: {} }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterType: "paperclip_runner",
        adapterConfig: expect.objectContaining({
          provider: "codex",
          model: "gpt-5.5",
          codexPermissionMode: "never",
          lifecycleMode: "per_turn",
          paperclipSkillSync: { desiredSkills: ["company-1/reviewer"] },
        }),
      }),
      expect.any(Object),
    );
  });

  it("uses the Codex default when a codex_local conversion has no model", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const app = await createApp();

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({
          adapterType: "paperclip_runner",
          replaceAdapterConfig: true,
          adapterConfig: { model: "" },
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({ model: "gpt-5.6-sol" }),
      }),
      expect.any(Object),
    );
  });

  it("rejects conversion from an unsupported provider family", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({
      ...existing,
      adapterType: "claude_local",
      adapterConfig: { model: "claude-sonnet-4-6" },
    });
    const app = await createApp();

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({
          adapterType: "paperclip_runner",
          replaceAdapterConfig: true,
          adapterConfig: {},
        }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.details).toMatchObject({
      code: "paperclip_runner_adapter_conversion_unsupported",
    });
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("accepts qualified local and managed providers on fresh runner agents and hires", async () => {
    mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
    const app = await createApp();
    const createResponse = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Native OpenCode",
          adapterType: "paperclip_runner",
          adapterConfig: {
            provider: "opencode",
            model: "openrouter/deepseek/deepseek-v4-flash-0731",
          },
        }),
    );
    const hireResponse = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agent-hires")
        .send({
          name: "Native ACPX",
          adapterType: "paperclip_runner",
          adapterConfig: {
            provider: "acpx",
            acpxAgent: "claude",
            model: "claude-sonnet-5",
          },
        }),
    );
    const managedResponse = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agents")
        .send({
          name: "Native Claude Managed",
          adapterType: "paperclip_runner",
          adapterConfig: {
            provider: "claude_managed",
            managedProfileId: "managed-primary",
            managedAgentsRetentionAcknowledged: true,
          },
        }),
    );
    const agentCoreResponse = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/agent-hires")
        .send({
          name: "Native AgentCore",
          adapterType: "paperclip_runner",
          adapterConfig: {
            provider: "aws_agentcore",
            agentCoreProfileId: "agentcore-primary",
            agentCoreRetentionAcknowledged: true,
          },
        }),
    );

    expect(createResponse.status, JSON.stringify(createResponse.body)).toBe(201);
    expect(hireResponse.status, JSON.stringify(hireResponse.body)).toBe(201);
    expect(managedResponse.status, JSON.stringify(managedResponse.body)).toBe(201);
    expect(agentCoreResponse.status, JSON.stringify(agentCoreResponse.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledTimes(4);
    expect(mockManagedAgentProfileService.requireQualified).toHaveBeenCalledWith(
      "company-1",
      "managed-primary",
    );
    expect(mockRemoteAgentProfileService.requireQualified).toHaveBeenCalledWith(
      "company-1",
      "agentcore-primary",
      "aws_bedrock_agentcore_harness",
    );
  });

  it.each([
    [
      "nonexistent Claude profile",
      "managed" as const,
      {
        provider: "claude_managed",
        managedProfileId: "managed-missing",
        managedAgentsRetentionAcknowledged: true,
      },
      "not_found" as const,
      404,
    ],
    [
      "disabled Claude profile",
      "managed" as const,
      {
        provider: "claude_managed",
        managedProfileId: "managed-disabled",
        managedAgentsRetentionAcknowledged: true,
      },
      "disabled" as const,
      409,
    ],
    [
      "drifted AgentCore profile",
      "remote" as const,
      {
        provider: "aws_agentcore",
        agentCoreProfileId: "agentcore-drifted",
        agentCoreRetentionAcknowledged: true,
      },
      "drifted" as const,
      409,
    ],
    [
      "cross-company AgentCore profile",
      "remote" as const,
      {
        provider: "aws_agentcore",
        agentCoreProfileId: "agentcore-other-company",
        agentCoreRetentionAcknowledged: true,
      },
      "not_found" as const,
      404,
    ],
  ])(
    "rejects a managed-provider selection with a %s",
    async (_label, service, adapterConfig, failure, expectedStatus) => {
      mockInstanceSettingsService.getExperimental.mockResolvedValue({ enableNativeRunner: true });
      const app = await createApp();
      const { conflict, notFound } = await import("../errors.js");
      const error = failure === "not_found"
        ? notFound("Managed provider profile not found")
        : conflict(
            failure === "disabled"
              ? "Managed provider profile is not enabled and qualified"
              : "Managed provider profile configuration does not match its qualified revision",
          );
      const profileService = service === "managed"
        ? mockManagedAgentProfileService
        : mockRemoteAgentProfileService;
      profileService.requireQualified.mockRejectedValueOnce(error);

      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .post("/api/companies/company-1/agents")
          .send({
            name: "Invalid Managed Selection",
            adapterType: "paperclip_runner",
            adapterConfig,
          }),
      );

      expect(response.status, JSON.stringify(response.body)).toBe(expectedStatus);
      expect(profileService.requireQualified).toHaveBeenCalledWith(
        "company-1",
        service === "managed"
          ? adapterConfig.managedProfileId
          : adapterConfig.agentCoreProfileId,
        ...(service === "remote" ? ["aws_bedrock_agentcore_harness"] : []),
      );
      expect(mockAgentService.create).not.toHaveBeenCalled();
    },
  );

  it("rejects provider changes but preserves edits to historical runner agents", async () => {
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({
      ...existing,
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "opencode", model: "historical" },
    });
    const app = await createApp();
    const ordinaryEdit = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ name: "Historical Runner" }),
    );
    const providerChange = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterConfig: { provider: "acpx" } }),
    );

    expect(ordinaryEdit.status, JSON.stringify(ordinaryEdit.body)).toBe(200);
    expect(providerChange.status, JSON.stringify(providerChange.body)).toBe(422);
    expect(providerChange.body.details).toMatchObject({
      code: "paperclip_runner_acpx_agent_unavailable",
    });
  });

  it.each([
    [
      "cleared managed profile",
      {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
      },
      { managedProfileId: "" },
      "paperclip_runner_claude_managed_profile_required",
    ],
    [
      "withdrawn managed retention",
      {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
      },
      { managedAgentsRetentionAcknowledged: false },
      "paperclip_runner_claude_managed_retention_required",
    ],
    [
      "unqualified managed model",
      {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
      },
      { model: "claude-opus-5" },
      "paperclip_runner_claude_managed_model_unqualified",
    ],
    [
      "invalid managed spend cap",
      {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
      },
      { maxSessionListCostUsd: 0 },
      "paperclip_runner_claude_managed_spend_cap_invalid",
    ],
    [
      "invalid Codex permission",
      { provider: "codex", codexPermissionMode: "never" },
      { codexPermissionMode: "unrestricted" },
      "paperclip_runner_codex_permission_mode_unqualified",
    ],
  ])(
    "rejects a same-provider Paperclip Runner edit with %s",
    async (_label, existingAdapterConfig, adapterConfigPatch, expectedCode) => {
      const existing = await mockAgentService.getById();
      mockAgentService.getById.mockResolvedValue({
        ...existing,
        adapterType: "paperclip_runner",
        adapterConfig: existingAdapterConfig,
      });
      const app = await createApp();
      const response = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .patch("/api/agents/11111111-1111-4111-8111-111111111111")
          .send({ adapterConfig: adapterConfigPatch }),
      );

      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(response.body.details).toMatchObject({ code: expectedCode });
      expect(mockAgentService.update).not.toHaveBeenCalled();
    },
  );

  it("validates a merged same-provider runner config and preserves omitted fields", async () => {
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({
      ...existing,
      adapterType: "paperclip_runner",
      adapterConfig: {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
        maxSessionListCostUsd: 1,
      },
    });
    const app = await createApp();
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ adapterConfig: { maxSessionListCostUsd: 2 } }),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledOnce();
    expect(mockAgentService.update.mock.calls[0]?.[1]).toMatchObject({
      adapterConfig: {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
        maxSessionListCostUsd: 2,
      },
    });
  });

  it("rejects a same-provider rollback to an invalid runner config", async () => {
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({
      ...existing,
      adapterType: "paperclip_runner",
      adapterConfig: {
        provider: "claude_managed",
        managedProfileId: "managed-primary",
        managedAgentsRetentionAcknowledged: true,
      },
    });
    mockAgentService.getConfigRevision.mockResolvedValue({
      afterConfig: {
        adapterType: "paperclip_runner",
        adapterConfig: {
          provider: "claude_managed",
          managedProfileId: "managed-primary",
          managedAgentsRetentionAcknowledged: false,
        },
        runtimeConfig: {},
      },
    });
    const app = await createApp();
    const response = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(
        "/api/agents/11111111-1111-4111-8111-111111111111/config-revisions/33333333-3333-4333-8333-333333333333/rollback",
      ),
    );

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.details).toMatchObject({
      code: "paperclip_runner_claude_managed_retention_required",
    });
    expect(mockAgentService.rollbackConfigRevision).not.toHaveBeenCalled();
  });

  it("keeps an existing paperclip_runner agent editable after the flag is disabled", async () => {
    const existing = await mockAgentService.getById();
    mockAgentService.getById.mockResolvedValue({
      ...existing,
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ name: "Native Codex (recorded)" }),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledOnce();
  });
});
