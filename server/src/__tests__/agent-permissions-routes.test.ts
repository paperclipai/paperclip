import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENCODE_LOCAL_MODEL } from "@paperclipai/adapter-opencode-local";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const agentId = "11111111-1111-4111-8111-111111111111";
const watchdogAgentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  activatePendingApproval: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>("@paperclipai/adapter-opencode-local/server");
    return {
      ...actual,
      ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable,
    };
  });

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: mockTrackAgentCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/approvals.js", () => ({
    approvalService: () => mockApprovalService,
  }));

  vi.doMock("../services/company-skills.js", () => ({
    companySkillService: () => mockCompanySkillService,
  }));

  vi.doMock("../services/budgets.js", () => ({
    budgetService: () => mockBudgetService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/issue-approvals.js", () => ({
    issueApprovalService: () => mockIssueApprovalService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/agent-instructions.js", () => ({
    agentInstructionsService: () => mockAgentInstructionsService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  }));

  vi.doMock("../services/workspace-operations.js", () => ({
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
    workspaceOperationService: () => mockWorkspaceOperationService,
    environmentService: () => mockEnvironmentService,
  }));
}

function createDbStub(options: { requireBoardApprovalForNewAgents?: boolean } = {}) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve) =>
            Promise.resolve(resolve([{
              id: companyId,
              name: "Paperclip",
              requireBoardApprovalForNewAgents: options.requireBoardApprovalForNewAgents ?? false,
            }])),
          ),
        }),
      }),
    }),
  };
}

async function createApp(actor: Record<string, unknown>, dbOptions: { requireBoardApprovalForNewAgents?: boolean } = {}) {
  const [{ errorHandler }, { agentRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/agents.js") as Promise<typeof import("../routes/agents.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes(createDbStub(dbOptions) as any));
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

describe.sequential("agent permission routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agent-instructions.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/approvals.js");
    vi.doUnmock("../services/budgets.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issue-approvals.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/secrets.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/workspace-operations.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("@paperclipai/adapter-opencode-local/server");
    registerModuleMocks();
    vi.resetAllMocks();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.create.mockReset();
    mockAgentService.activatePendingApproval.mockReset();
    mockAgentService.update.mockReset();
    mockAgentService.updatePermissions.mockReset();
    mockAgentService.getChainOfCommand.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockAccessService.canUser.mockReset();
    mockAccessService.decide.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockAccessService.getMembership.mockReset();
    mockAccessService.ensureMembership.mockReset();
    mockAccessService.listPrincipalGrants.mockReset();
    mockAccessService.setPrincipalPermission.mockReset();
    mockApprovalService.create.mockReset();
    mockApprovalService.getById.mockReset();
    mockBudgetService.upsertPolicy.mockReset();
    mockHeartbeatService.listTaskSessions.mockReset();
    mockHeartbeatService.resetRuntimeSession.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockIssueService.list.mockReset();
    mockSecretService.normalizeAdapterConfigForPersistence.mockReset();
    mockSecretService.resolveAdapterConfigForRuntime.mockReset();
    mockAgentInstructionsService.materializeManagedBundle.mockReset();
    mockCompanySkillService.listRuntimeSkillEntries.mockReset();
    mockCompanySkillService.resolveRequestedSkillKeys.mockReset();
    mockLogActivity.mockReset();
    mockTrackAgentCreated.mockReset();
    mockGetTelemetryClient.mockReset();
    mockSyncInstructionsBundleConfigFromFilePath.mockReset();
    mockInstanceSettingsService.getGeneral.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockEnsureOpenCodeModelConfiguredAndAvailable.mockReset();
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_agent, config) => config);
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.list.mockResolvedValue([baseAgent]);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAgentService.create.mockResolvedValue(baseAgent);
    mockAgentService.activatePendingApproval.mockResolvedValue({
      agent: baseAgent,
      activated: false,
    });
    mockAgentService.update.mockResolvedValue(baseAgent);
    mockAgentService.updatePermissions.mockResolvedValue(baseAgent);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => {
      const allowed = Boolean(await mockAccessService.canUser());
      return {
        allowed,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant" : `Missing test grant for ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.getMembership.mockResolvedValue({
      id: "membership-1",
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
      createdAt: new Date("2026-03-19T00:00:00.000Z"),
      updatedAt: new Date("2026-03-19T00:00:00.000Z"),
    });
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(async (_companyId, requested) => requested);
    mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
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
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(
      async (_companyId: string, requested: string[]) => requested,
    );
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockInstanceSettingsService.getGeneral.mockResolvedValue({
      censorUsernameInLogs: false,
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("redacts agent detail for authenticated company members without agent admin permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => ({
      allowed: input.action === "agent:read",
      reason: input.action === "agent:read" ? "allow_test_read" : "deny_missing_grant",
      explanation: input.action === "agent:read" ? "Allowed by test read grant." : "Missing test grant.",
    }));

    const app = await createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig).toEqual({});
    expect(res.body.runtimeConfig).toEqual({});
  }, 20_000);

  it("keeps board agent detail unredacted for low-trust agents", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      permissions: {
        ...baseAgent.permissions,
        trustPreset: LOW_TRUST_REVIEW_PRESET,
      },
      adapterConfig: {
        command: "pnpm agent:run",
        env: { PAPERCLIP_API_KEY: "secret-test-key" },
      },
      runtimeConfig: {
        modelProfiles: {
          default: { enabled: true, adapterConfig: { model: "openai/gpt-5.4-mini" } },
        },
      },
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig).toMatchObject({
      command: "pnpm agent:run",
      env: { PAPERCLIP_API_KEY: "secret-test-key" },
    });
    expect(res.body.runtimeConfig).toMatchObject({
      modelProfiles: {
        default: { enabled: true, adapterConfig: { model: "openai/gpt-5.4-mini" } },
      },
    });
    expect(res.body.permissions).toMatchObject({ trustPreset: LOW_TRUST_REVIEW_PRESET });
  }, 20_000);

  it("redacts company agent list for authenticated company members without agent admin permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { action?: string }) => ({
      allowed: input.action === "agent:read",
      reason: input.action === "agent:read" ? "allow_test_read" : "deny_missing_grant",
      explanation: input.action === "agent:read" ? "Allowed by test read grant." : "Missing test grant.",
    }));

    const app = await createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/companies/${companyId}/agents`));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: agentId,
        adapterConfig: {},
        runtimeConfig: {},
      }),
    ]);
  });

  it("blocks agent updates for authenticated company members without agent admin permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = await createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({ title: "Compromised" }));

    expect(res.status).toBe(403);
  });

  it("blocks api key creation for authenticated company members without agent admin permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = await createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/agents/${agentId}/keys`)
      .send({ name: "backdoor" }));

    expect(res.status).toBe(403);
  });

  it("blocks wakeups for authenticated company members without agent admin permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = await createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/agents/${agentId}/wakeup`)
      .send({}));

    expect(res.status).toBe(403);
  });

  it("blocks agent-authenticated self-updates that set host-executed workspace commands", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          workspaceStrategy: {
            type: "git_worktree",
            provisionCommand: "touch /tmp/paperclip-rce",
          },
        },
      }));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("host-executed workspace commands");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("blocks agent-authenticated self-updates that set cheap-profile host-executed workspace commands", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      adapterType: "codex_local",
    });

    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({
        runtimeConfig: {
          modelProfiles: {
            cheap: {
              adapterConfig: {
                workspaceStrategy: {
                  type: "git_worktree",
                  provisionCommand: "touch /tmp/paperclip-rce",
                },
              },
            },
          },
        },
      }));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("host-executed workspace commands");
    expect(res.body.error).toContain(
      "runtimeConfig.modelProfiles.cheap.adapterConfig.workspaceStrategy.provisionCommand",
    );
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("allows board updates that set cheap-profile workspace commands", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      adapterType: "codex_local",
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const runtimeConfig = {
      modelProfiles: {
        cheap: {
          adapterConfig: {
            workspaceStrategy: {
              type: "git_worktree",
              provisionCommand: "bash ./scripts/provision-worktree.sh",
            },
          },
        },
      },
    };

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({ runtimeConfig }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ runtimeConfig }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent.updated",
    }));
  });

  it("normalizes cheap-profile env bindings through the adapter config secret pipeline", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      adapterType: "codex_local",
    });
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => ({
      ...config,
      env: {
        API_TOKEN: {
          type: "secret_ref",
          secretId: "33333333-3333-4333-8333-333333333333",
          version: "latest",
        },
      },
    }));

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({
        runtimeConfig: {
          modelProfiles: {
            cheap: {
              adapterConfig: {
                model: "gpt-5.3-codex-spark",
                env: {
                  API_TOKEN: {
                    type: "secret_ref",
                    secretId: "33333333-3333-4333-8333-333333333333",
                    version: "latest",
                  },
                },
              },
            },
          },
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockSecretService.normalizeAdapterConfigForPersistence).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        model: "gpt-5.3-codex-spark",
        env: expect.any(Object),
      }),
      { strictMode: false },
    );
    expect(mockAgentService.update).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        runtimeConfig: {
          modelProfiles: {
            cheap: {
              adapterConfig: {
                model: "gpt-5.3-codex-spark",
                env: {
                  API_TOKEN: {
                    type: "secret_ref",
                    secretId: "33333333-3333-4333-8333-333333333333",
                    version: "latest",
                  },
                },
              },
            },
          },
        },
      }),
      expect.anything(),
    );
  });

  it("blocks agent-authenticated self-updates that set instructions bundle roots", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterConfig: {
          instructionsRootPath: "/etc",
          instructionsEntryFile: "passwd",
        },
      }));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("instructions path or bundle configuration");
    expect(mockLogActivity).not.toHaveBeenCalled();
  }, 15_000);

  it("blocks agent-authenticated instructions-path updates", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}/instructions-path`)
      .send({ path: "/etc/passwd" }));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("instructions path or bundle configuration");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("blocks agent-authenticated hires that set instructions bundle config", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);

    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({
        name: "Injected",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {
          instructionsRootPath: "/etc",
          instructionsEntryFile: "passwd",
        },
      }));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("instructions path or bundle configuration");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("blocks direct agent creation for authenticated company members without agent create permission", async () => {
    mockAccessService.canUser.mockResolvedValue(false);

    const app = await createApp({
      type: "board",
      userId: "member-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Backdoor",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      }));

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("agents:create");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("allows direct agent creation for authenticated board users with agent create permission when approval is not required", async () => {
    mockAccessService.canUser.mockResolvedValue(true);

    const app = await createApp({
      type: "board",
      userId: "agent-admin-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        status: "idle",
      }),
    );
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "agent-admin-user",
    );
  });

  it("rejects direct agent creation when new agents require board approval", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
        companyIds: [companyId],
      },
      { requireBoardApprovalForNewAgents: true },
    );

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      }));

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("/agent-hires");
    expect(mockAgentService.create).not.toHaveBeenCalled();
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("grants tasks:assign by default when board creates a new agent", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      }));

    expect([200, 201]).toContain(res.status);
    expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "member",
      "active",
    );
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "board-user",
    );
  }, 15_000);

  it("rejects unsupported query parameters on the agent list route", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .get(`/api/companies/${companyId}/agents`)
      .query({ urlKey: "builder" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("urlKey");
    expect(mockAgentService.list).not.toHaveBeenCalled();
  });

  it("normalizes direct agent creation to disable timer heartbeats by default", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
      }));

    expect([200, 201]).toContain(res.status);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 3600,
            maxConcurrentRuns: 20,
          },
        },
      }),
    );
  });

  it("seeds opencode agent creation with the static default model without live discovery", async () => {
    mockEnsureOpenCodeModelConfiguredAndAvailable.mockRejectedValue(
      new Error("`opencode models` should not be called during creation"),
    );

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "OpenCode Builder",
        role: "engineer",
        adapterType: "opencode_local",
        adapterConfig: {},
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockEnsureOpenCodeModelConfiguredAndAvailable).not.toHaveBeenCalled();
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        adapterType: "opencode_local",
        adapterConfig: expect.objectContaining({
          model: DEFAULT_OPENCODE_LOCAL_MODEL,
        }),
      }),
    );
  });

  it("accepts manual opencode provider/model values without host-side discovery", async () => {
    mockEnsureOpenCodeModelConfiguredAndAvailable.mockRejectedValue(
      new Error("`opencode models` should not be called during creation"),
    );

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "OpenCode Builder",
        role: "engineer",
        adapterType: "opencode_local",
        adapterConfig: {
          model: "anthropic/claude-sonnet-4-5",
        },
      }));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockEnsureOpenCodeModelConfiguredAndAvailable).not.toHaveBeenCalled();
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        adapterType: "opencode_local",
        adapterConfig: expect.objectContaining({
          model: "anthropic/claude-sonnet-4-5",
        }),
      }),
    );
  });

  it("normalizes hire requests to disable timer heartbeats by default", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/companies/${companyId}/agent-hires`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            intervalSec: 3600,
          },
        },
      }));

    expect(res.status).toBe(201);
    expect(mockAgentService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 3600,
            maxConcurrentRuns: 20,
          },
        },
      }),
    );
  });

  it("allows board users to directly approve pending agents", async () => {
    const pendingAgent = {
      ...baseAgent,
      status: "pending_approval",
    };
    const approvedAgent = {
      ...baseAgent,
      status: "idle",
    };
    mockAgentService.getById.mockResolvedValue(pendingAgent);
    mockAgentService.activatePendingApproval.mockResolvedValue({
      agent: approvedAgent,
      activated: true,
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/agents/${agentId}/approve`)
      .send({}));

    expect(res.status).toBe(200);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith(agentId);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "agent.approved",
      entityType: "agent",
      entityId: agentId,
      details: { source: "agent_detail" },
    }));
  });

  it("rejects direct approval for agents that are not pending approval", async () => {
    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/agents/${agentId}/approve`)
      .send({}));

    expect(res.status).toBe(409);
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent.approved",
    }));
  });

  it("rejects creating an agent with an environment from another company", async () => {
    const environmentId = "33333333-3333-4333-8333-333333333333";
    mockEnvironmentService.getById.mockResolvedValue({
      id: environmentId,
      companyId: "other-company",
      driver: "local",
      config: {},
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        defaultEnvironmentId: environmentId,
      }));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Environment not found");
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  it("rejects creating an agent with an unsupported default environment driver", async () => {
    const environmentId = "33333333-3333-4333-8333-333333333333";
    mockEnvironmentService.getById.mockResolvedValue({
      id: environmentId,
      companyId,
      driver: "ssh",
      config: {},
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        defaultEnvironmentId: environmentId,
      }));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Environment driver "ssh" is not allowed here');
    expect(mockAgentService.create).not.toHaveBeenCalled();
  });

  const sshCapableAdapterCases = [
    { adapterType: "codex_local", name: "Codex Builder", adapterConfig: {} },
    { adapterType: "claude_local", name: "Claude Builder", adapterConfig: {} },
    { adapterType: "gemini_local", name: "Gemini Builder", adapterConfig: {} },
    { adapterType: "opencode_local", name: "OpenCode Builder", adapterConfig: { model: "opencode/gpt-5-nano" } },
    { adapterType: "cursor", name: "Cursor Builder", adapterConfig: {} },
    { adapterType: "pi_local", name: "Pi Builder", adapterConfig: { model: "openai/gpt-5.4-mini" } },
  ];

  for (const adapterCase of sshCapableAdapterCases) {
    it(`allows creating a ${adapterCase.adapterType} agent with an SSH default environment`, async () => {
      const environmentId = "33333333-3333-4333-8333-333333333333";
      mockEnvironmentService.getById.mockResolvedValue({
        id: environmentId,
        companyId,
        driver: "ssh",
        config: {},
      });
      mockAgentService.create.mockResolvedValue({
        ...baseAgent,
        name: adapterCase.name,
        adapterType: adapterCase.adapterType,
        defaultEnvironmentId: environmentId,
      });

      const app = await createApp({
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
        companyIds: [companyId],
      });

      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .post(`/api/companies/${companyId}/agents`)
        .send({
          name: adapterCase.name,
          role: "engineer",
          adapterType: adapterCase.adapterType,
          adapterConfig: adapterCase.adapterConfig,
          defaultEnvironmentId: environmentId,
        }));

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(mockAgentService.create).toHaveBeenCalledWith(
        companyId,
        expect.objectContaining({
          adapterType: adapterCase.adapterType,
          defaultEnvironmentId: environmentId,
        }),
      );
    });
  }

  it("rejects updating an agent with an unsupported default environment driver", async () => {
    const environmentId = "33333333-3333-4333-8333-333333333333";
    mockEnvironmentService.getById.mockResolvedValue({
      id: environmentId,
      companyId,
      driver: "ssh",
      config: {},
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({
        defaultEnvironmentId: environmentId,
      }));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Environment driver "ssh" is not allowed here');
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  for (const adapterCase of sshCapableAdapterCases) {
    it(`allows updating a ${adapterCase.adapterType} agent with an SSH default environment`, async () => {
      const environmentId = "33333333-3333-4333-8333-333333333333";
      mockEnvironmentService.getById.mockResolvedValue({
        id: environmentId,
        companyId,
        driver: "ssh",
        config: {},
      });
      mockAgentService.getById.mockResolvedValue({
        ...baseAgent,
        adapterType: adapterCase.adapterType,
        adapterConfig: adapterCase.adapterConfig,
        defaultEnvironmentId: null,
      });
      mockAgentService.update.mockResolvedValue({
        ...baseAgent,
        adapterType: adapterCase.adapterType,
        adapterConfig: adapterCase.adapterConfig,
        defaultEnvironmentId: environmentId,
      });

      const app = await createApp({
        type: "board",
        userId: "board-user",
        source: "local_implicit",
        isInstanceAdmin: true,
        companyIds: [companyId],
      });

      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({
          defaultEnvironmentId: environmentId,
        }));

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({
          defaultEnvironmentId: environmentId,
        }),
        expect.anything(),
      );
    });
  }

  it("rejects switching an agent away from an SSH-capable runtime without clearing its SSH default", async () => {
    const environmentId = "33333333-3333-4333-8333-333333333333";
    mockEnvironmentService.getById.mockResolvedValue({
      id: environmentId,
      companyId,
      driver: "ssh",
      config: {},
    });
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      adapterType: "codex_local",
      defaultEnvironmentId: environmentId,
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterType: "process",
      }));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Environment driver "ssh" is not allowed here');
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("exposes explicit task assignment access on agent detail", async () => {
    mockAccessService.listPrincipalGrants.mockResolvedValue([
      {
        id: "grant-1",
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "tasks:assign",
        scope: null,
        grantedByUserId: "board-user",
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
        updatedAt: new Date("2026-03-19T00:00:00.000Z"),
      },
    ]);

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));

    expect(res.status).toBe(200);
    expect(res.body.access.canAssignTasks).toBe(true);
    expect(res.body.access.taskAssignSource).toBe("explicit_grant");
  }, 15_000);

  it("reports simple-mode task assignment as enabled for active company agent members", async () => {
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}`));

    expect(res.status).toBe(200);
    expect(res.body.access.canAssignTasks).toBe(true);
    expect(res.body.access.taskAssignSource).toBe("simple_default");
  }, 15_000);

  it("keeps task assignment enabled when agent creation privilege is enabled", async () => {
    mockAgentService.updatePermissions.mockResolvedValue({
      ...baseAgent,
      permissions: { canCreateAgents: true },
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .patch(`/api/agents/${agentId}/permissions`)
      .send({ canCreateAgents: true, canAssignTasks: false }));

    expect(res.status).toBe(200);
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "board-user",
    );
    expect(res.body.access.canAssignTasks).toBe(true);
    expect(res.body.access.taskAssignSource).toBe("agent_creator");
  });

  it("exposes a dedicated agent route for the inbox mine view", async () => {
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-910",
        title: "Inbox follow-up",
        status: "todo",
      },
    ]);

    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
      source: "agent_key",
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .get("/api/agents/me/inbox/mine")
      .query({ userId: "board-user" }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "issue-1",
        identifier: "PAP-910",
        title: "Inbox follow-up",
        status: "todo",
      },
    ]);
    expect(mockIssueService.list).toHaveBeenCalledWith(companyId, {
      touchedByUserId: "board-user",
      inboxArchivedByUserId: "board-user",
      status: "backlog,todo,in_progress,in_review,blocked,done",
      limit: 500,
    });
  });

  describe("agent configuration read gate", () => {
    it("allows a board member without agents:create to read agent configuration", async () => {
      // Board (human) users with company membership but no agents:create
      // grant should still be able to view agent configuration — this is
      // the read-only permission loosening introduced by this PR.
      mockAccessService.canUser.mockResolvedValue(false);
      mockAccessService.hasPermission.mockResolvedValue(false);

      const app = await createApp({
        type: "board",
        userId: "board-user",
        source: "session",
        isInstanceAdmin: false,
        companyIds: [companyId],
      });

      const res = await request(app).get(`/api/agents/${agentId}/configuration`);

      expect(res.status).toBe(200);
    });

    it("denies an agent actor without agents:create when reading peer config", async () => {
      // Agent actors must still pass the agents:create gate (explicit
      // grant OR canCreateAgents permission on the agent record). A peer
      // agent in the same company without that permission must not be
      // able to read another agent's configuration.
      const peerAgentId = "33333333-3333-4333-8333-333333333333";
      const peerAgent = { ...baseAgent, id: peerAgentId };
      mockAgentService.getById.mockImplementation(async (id: string) => {
        if (id === peerAgentId) return peerAgent;
        if (id === agentId) {
          return { ...baseAgent, permissions: { canCreateAgents: false } };
        }
        return null;
      });
      mockAccessService.hasPermission.mockResolvedValue(false);

      const app = await createApp({
        type: "agent",
        agentId,
        companyId,
        runId: "run-1",
        source: "agent_key",
      });

      const res = await request(app).get(`/api/agents/${peerAgentId}/configuration`);

      expect(res.status).toBe(403);
    });

    it("allows an agent actor with agents:create grant to read peer config", async () => {
      // When an agent actor has an explicit agents:create grant in the
      // access service, the read gate must let them through.
      const peerAgentId = "44444444-4444-4444-8444-444444444444";
      const peerAgent = { ...baseAgent, id: peerAgentId };
      mockAgentService.getById.mockImplementation(async (id: string) => {
        if (id === peerAgentId) return peerAgent;
        if (id === agentId) {
          return { ...baseAgent, permissions: { canCreateAgents: false } };
        }
        return null;
      });
      mockAccessService.hasPermission.mockImplementation(
        async (_companyId: string, _principalType: string, principalId: string, key: string) => {
          return principalId === agentId && key === "agents:create";
        },
      );

      const app = await createApp({
        type: "agent",
        agentId,
        companyId,
        runId: "run-1",
        source: "agent_key",
      });

      const res = await request(app).get(`/api/agents/${peerAgentId}/configuration`);

      expect(res.status).toBe(200);
    });
  });

  it("rejects heartbeat cancellation outside the caller company scope", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "33333333-3333-4333-8333-333333333333",
      agentId,
      status: "running",
    });

    const app = await createApp({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).post("/api/heartbeat-runs/run-1/cancel").send({}));

    expect(res.status).toBe(403);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
  });

  describe("agents:recover_from_error permission", () => {
    const errorAgent = { ...baseAgent, status: "error", pauseReason: null };
    const pausedErrorAgent = { ...baseAgent, status: "error", pauseReason: "budget_exceeded" };
    const idleAgent = { ...baseAgent, status: "idle", pauseReason: null };

    it("allows recovery PATCH when target is in error status, has no pauseReason, and body is exactly { status: idle }", async () => {
      mockAgentService.getById
        .mockResolvedValueOnce({ ...baseAgent, id: watchdogAgentId, role: "engineer" })
        .mockResolvedValueOnce(errorAgent);
      mockAccessService.hasPermission.mockResolvedValue(true);
      mockAgentService.update.mockResolvedValue({ ...errorAgent, status: "idle" });

      const app = await createApp({
        type: "agent",
        agentId: watchdogAgentId,
        companyId,
        source: "agent_key",
        runId: "run-wd-1",
      });

      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ status: "idle" }));

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAgentService.update).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({ status: "idle" }),
        expect.anything(),
      );
    });

    it("blocks recovery PATCH with extra body fields even when permission is held", async () => {
      mockAgentService.getById
        .mockResolvedValueOnce({ ...baseAgent, id: watchdogAgentId, role: "engineer" })
        .mockResolvedValueOnce(errorAgent);
      mockAccessService.hasPermission.mockResolvedValue(true);

      const app = await createApp({
        type: "agent",
        agentId: watchdogAgentId,
        companyId,
        source: "agent_key",
        runId: "run-wd-1",
      });

      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ status: "idle", adapterConfig: {} }));

      expect(res.status).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("blocks recovery PATCH when target has a non-null pauseReason", async () => {
      mockAgentService.getById
        .mockResolvedValueOnce({ ...baseAgent, id: watchdogAgentId, role: "engineer" })
        .mockResolvedValueOnce(pausedErrorAgent);
      mockAccessService.hasPermission.mockResolvedValue(true);

      const app = await createApp({
        type: "agent",
        agentId: watchdogAgentId,
        companyId,
        source: "agent_key",
        runId: "run-wd-1",
      });

      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ status: "idle" }));

      expect(res.status).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("blocks recovery PATCH when target status is not error", async () => {
      mockAgentService.getById
        .mockResolvedValueOnce({ ...baseAgent, id: watchdogAgentId, role: "engineer" })
        .mockResolvedValueOnce(idleAgent);
      mockAccessService.hasPermission.mockResolvedValue(true);

      const app = await createApp({
        type: "agent",
        agentId: watchdogAgentId,
        companyId,
        source: "agent_key",
        runId: "run-wd-1",
      });

      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ status: "idle" }));

      expect(res.status).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("blocks PATCH with status active even when recovery permission is held", async () => {
      mockAgentService.getById
        .mockResolvedValueOnce({ ...baseAgent, id: watchdogAgentId, role: "engineer" })
        .mockResolvedValueOnce(errorAgent);
      mockAccessService.hasPermission.mockResolvedValue(true);

      const app = await createApp({
        type: "agent",
        agentId: watchdogAgentId,
        companyId,
        source: "agent_key",
        runId: "run-wd-1",
      });

      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ status: "active" }));

      expect(res.status).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });

    it("blocks recovery when agent does not hold the permission", async () => {
      mockAgentService.getById
        .mockResolvedValueOnce({ ...baseAgent, id: watchdogAgentId, role: "engineer" })
        .mockResolvedValueOnce(errorAgent);
      mockAccessService.hasPermission.mockResolvedValue(false);

      const app = await createApp({
        type: "agent",
        agentId: watchdogAgentId,
        companyId,
        source: "agent_key",
        runId: "run-wd-1",
      });

      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .patch(`/api/agents/${agentId}`)
        .send({ status: "idle" }));

      expect(res.status).toBe(403);
      expect(mockAgentService.update).not.toHaveBeenCalled();
    });
  });
});
