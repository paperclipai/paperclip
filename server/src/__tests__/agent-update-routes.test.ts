import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Frontend Developer",
  urlKey: "frontend-developer",
  role: "engineer",
  title: "Frontend Developer",
  icon: "code",
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {
    cwd: "/workspace/app",
    model: "claude-sonnet-4-6",
    maxTurnsPerRun: 40,
    chrome: true,
    paperclipSkillSync: {
      desiredSkills: ["paperclipai/paperclip/paperclip"],
    },
    instructionsBundleMode: "managed",
    instructionsRootPath: "/tmp/agent/instructions",
    instructionsEntryFile: "AGENTS.md",
    instructionsFilePath: "/tmp/agent/instructions/AGENTS.md",
  },
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
  update: vi.fn(),
  getChainOfCommand: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({}));
const mockBudgetService = vi.hoisted(() => ({}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({}));
const mockIssueService = vi.hoisted(() => ({}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn((_agent, config) => config));
const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(() => null),
  listAdapterModels: vi.fn(),
}));

vi.mock("@paperclipai/adapter-opencode-local/server", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable,
}));

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: companyId,
            name: "Paperclip",
            requireBoardApprovalForNewAgents: false,
          }]),
        }),
      }),
    }),
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

describe("agent update routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...baseAgent,
      ...patch,
    }));
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("preserves managed instructions and shared runtime config when switching adapters", async () => {
    const app = createApp();

    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterType: "opencode_local",
        adapterConfig: {
          model: "zai-coding-plan/glm-5-turbo",
          command: "/home/victor/.opencode/bin/opencode",
          url: "ws://127.0.0.1:18789",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledTimes(1);

    const [, patch] = mockAgentService.update.mock.calls[0]!;
    expect(patch.adapterType).toBe("opencode_local");
    expect(patch.adapterConfig).toMatchObject({
      cwd: "/workspace/app",
      maxTurnsPerRun: 40,
      model: "zai-coding-plan/glm-5-turbo",
      command: "/home/victor/.opencode/bin/opencode",
      url: "ws://127.0.0.1:18789",
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/paperclip"],
      },
      instructionsBundleMode: "managed",
      instructionsRootPath: "/tmp/agent/instructions",
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: "/tmp/agent/instructions/AGENTS.md",
    });
    expect((patch.adapterConfig as Record<string, unknown>).chrome).toBeUndefined();
  });

  it("preserves promptTemplate, extraArgs, timeoutSec, graceSec across adapter switch", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      adapterConfig: {
        ...baseAgent.adapterConfig,
        promptTemplate: "You are {{agent.name}}. Do your work.",
        bootstrapPromptTemplate: "Bootstrap prompt.",
        extraArgs: ["--verbose"],
        timeoutSec: 600,
        graceSec: 30,
      },
    });

    const app = createApp();
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.3-codex" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, patch] = mockAgentService.update.mock.calls[0]!;
    const cfg = patch.adapterConfig as Record<string, unknown>;
    expect(cfg.promptTemplate).toBe("You are {{agent.name}}. Do your work.");
    expect(cfg.bootstrapPromptTemplate).toBe("Bootstrap prompt.");
    expect(cfg.extraArgs).toEqual(["--verbose"]);
    expect(cfg.timeoutSec).toBe(600);
    expect(cfg.graceSec).toBe(30);
  });

  it("applies dangerouslySkipPermissions default when switching to claude_local", async () => {
    // Start from an opencode_local agent
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      adapterType: "opencode_local",
      adapterConfig: {
        cwd: "/workspace/app",
        model: "anthropic/claude-sonnet-4-5",
        instructionsFilePath: "/tmp/agent/instructions/AGENTS.md",
      },
    });

    const app = createApp();
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterType: "claude_local",
        adapterConfig: { model: "claude-sonnet-4-6" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, patch] = mockAgentService.update.mock.calls[0]!;
    const cfg = patch.adapterConfig as Record<string, unknown>;
    expect(cfg.dangerouslySkipPermissions).toBe(true);
    expect(cfg.cwd).toBe("/workspace/app");
    expect(cfg.instructionsFilePath).toBe("/tmp/agent/instructions/AGENTS.md");
  });

  it("injects OPENCODE_PERMISSION env when switching to opencode_local", async () => {
    const app = createApp();
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterType: "opencode_local",
        adapterConfig: { model: "anthropic/claude-sonnet-4-5" },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, patch] = mockAgentService.update.mock.calls[0]!;
    const cfg = patch.adapterConfig as Record<string, unknown>;
    const env = cfg.env as Record<string, unknown>;
    expect(env).toBeDefined();
    expect(env.OPENCODE_PERMISSION).toBeDefined();
    const perms = JSON.parse(env.OPENCODE_PERMISSION as string);
    expect(perms.edit).toBe("allow");
    expect(perms.bash).toBe("allow");
    expect(perms.skill).toBe("allow");
    expect(perms.task).toBe("allow");
  });

  it("does not override existing OPENCODE_PERMISSION env if already set", async () => {
    const app = createApp();
    const customPerms = JSON.stringify({ edit: "ask", bash: "allow" });
    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterType: "opencode_local",
        adapterConfig: {
          model: "anthropic/claude-sonnet-4-5",
          env: { OPENCODE_PERMISSION: customPerms },
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, patch] = mockAgentService.update.mock.calls[0]!;
    const cfg = patch.adapterConfig as Record<string, unknown>;
    const env = cfg.env as Record<string, unknown>;
    expect(env.OPENCODE_PERMISSION).toBe(customPerms);
  });

  it("strips adapter-specific fields when only adapterType is patched without adapterConfig", async () => {
    const app = createApp();

    const res = await request(app)
      .patch(`/api/agents/${agentId}`)
      .send({
        adapterType: "codex_local",
        // No adapterConfig — only changing adapter type
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [, patch] = mockAgentService.update.mock.calls[0]!;
    const cfg = patch.adapterConfig as Record<string, unknown>;
    // Cross-adapter fields preserved
    expect(cfg.cwd).toBe("/workspace/app");
    expect(cfg.maxTurnsPerRun).toBe(40);
    expect(cfg.instructionsFilePath).toBe("/tmp/agent/instructions/AGENTS.md");
    // Adapter-specific fields from claude_local stripped
    expect(cfg.chrome).toBeUndefined();
    // Model gets codex default from applyCreateDefaultsByAdapterType
    expect(cfg.model).toBe("gpt-5.3-codex");
  });
});
