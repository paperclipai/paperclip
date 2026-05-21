import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
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

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

const mockAdapter = vi.hoisted(() => ({
  type: "hermes_local",
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  ensureRuntimeIdentity: vi.fn(async (ctx: {
    adapterConfig: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
  }) => ({
    adapterConfig: {
      ...ctx.adapterConfig,
      env: {
        ...(ctx.adapterConfig.env as Record<string, unknown> | undefined),
        HERMES_HOME: "/tmp/paperclip/runtimes/hermes/profiles/acme-reviewer",
      },
    },
    metadata: {
      ...(ctx.metadata ?? {}),
      runtimeIdentity: {
        adapter: "hermes_local",
        profileSlug: "acme-reviewer",
        hermesHome: "/tmp/paperclip/runtimes/hermes/profiles/acme-reviewer",
      },
    },
  })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

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
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueRecoveryActionService: () => ({}),
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

vi.mock("../services/environment-runtime.js", () => ({
  environmentRuntimeService: () => ({}),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => ({ getById: vi.fn() }),
}));

vi.mock("../services/recovery/service.js", () => ({
  recoveryService: () => ({}),
}));

vi.mock("../adapters/index.js", () => ({
  detectAdapterModel: vi.fn(),
  findActiveServerAdapter: vi.fn(() => mockAdapter),
  findServerAdapter: vi.fn(() => mockAdapter),
  listAdapterModels: vi.fn(),
  listAdapterModelProfiles: vi.fn(async () => []),
  refreshAdapterModels: vi.fn(),
  requireServerAdapter: vi.fn(() => mockAdapter),
}));

function createDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            name: "Acme",
            requireBoardApprovalForNewAgents: false,
          },
        ]),
      })),
    })),
  };
}

function makeAgent(input: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Reviewer",
    urlKey: "reviewer",
    role: "engineer",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    defaultEnvironmentId: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...input,
  };
}

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
  app.use("/api", agentRoutes(createDb() as any));
  app.use(errorHandler);
  return app;
}

describe("Hermes runtime identity routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    let persistedAgent: ReturnType<typeof makeAgent> | null = null;
    mockAgentService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => {
      persistedAgent = makeAgent({
        ...input,
        adapterConfig: input.adapterConfig ?? {},
        runtimeConfig: input.runtimeConfig ?? {},
      });
      return persistedAgent;
    });
    mockAgentService.getById.mockImplementation(async () => persistedAgent ?? makeAgent());
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      persistedAgent = makeAgent({
        ...(persistedAgent ?? makeAgent()),
        ...patch,
        adapterConfig: patch.adapterConfig ?? (persistedAgent ?? makeAgent()).adapterConfig,
        metadata: patch.metadata ?? (persistedAgent ?? makeAgent()).metadata,
      });
      return persistedAgent;
    });
  });

  it("reconciles runtime identity when creating a Hermes agent", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "Reviewer",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.adapterConfig.env.HERMES_HOME).toContain("/runtimes/hermes/profiles/");
    expect(res.body.metadata.runtimeIdentity.profileSlug).toBe("acme-reviewer");
  });

  it("keeps agent creation non-fatal when runtime identity reconciliation fails", async () => {
    mockAdapter.ensureRuntimeIdentity.mockRejectedValueOnce(new Error("disk full"));

    const res = await request(await createApp())
      .post("/api/companies/company-1/agents")
      .send({
        name: "Reviewer",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.adapterConfig).toEqual({});
    expect(res.body.metadata).toBeNull();
  });

  it("reconciles runtime identity when updating an agent to Hermes", async () => {
    const existing = makeAgent({
      adapterType: "process",
      adapterConfig: { command: "node worker.js" },
    });
    mockAgentService.getById.mockResolvedValueOnce(existing);

    const res = await request(await createApp())
      .patch(`/api/agents/${existing.id}`)
      .send({
        adapterType: "hermes_local",
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.adapterConfig.env.HERMES_HOME).toContain("/runtimes/hermes/profiles/");
    expect(res.body.metadata.runtimeIdentity.adapter).toBe("hermes_local");
    expect(mockAgentService.update).toHaveBeenLastCalledWith(
      existing.id,
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          env: expect.objectContaining({
            HERMES_HOME: "/tmp/paperclip/runtimes/hermes/profiles/acme-reviewer",
          }),
        }),
      }),
      {
        recordRevision: {
          createdByAgentId: null,
          createdByUserId: "local-board",
          source: "adapter_runtime_identity_update",
        },
      },
    );
  });

  it("does not overwrite existing metadata when runtime identity returns null metadata", async () => {
    const existing = makeAgent({
      adapterType: "hermes_local",
      adapterConfig: {},
      metadata: { existing: true },
    });
    let persistedAgent = existing;
    mockAgentService.getById.mockResolvedValue(existing);
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      persistedAgent = makeAgent({
        ...persistedAgent,
        ...patch,
        adapterConfig: patch.adapterConfig ?? persistedAgent.adapterConfig,
        ...(Object.prototype.hasOwnProperty.call(patch, "metadata") ? { metadata: patch.metadata } : {}),
      });
      return persistedAgent;
    });
    mockAdapter.ensureRuntimeIdentity.mockResolvedValueOnce({
      adapterConfig: {
        env: {
          HERMES_HOME: "/tmp/paperclip/runtimes/hermes/profiles/acme-reviewer",
        },
      },
      metadata: null,
    });

    const res = await request(await createApp())
      .patch(`/api/agents/${existing.id}`)
      .send({
        adapterConfig: {
          timeoutSec: 30,
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.metadata).toEqual({ existing: true });
    const runtimeIdentityUpdate = mockAgentService.update.mock.calls.find((call) =>
      call[2]?.recordRevision?.source === "adapter_runtime_identity_update",
    );
    expect(runtimeIdentityUpdate?.[1]).not.toHaveProperty("metadata");
  });
});
