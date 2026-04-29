/**
 * Tests for the RBAC extension that allows CTO-role agents and agents with
 * canPatchAdapterConfig permission to PATCH other agents' adapterConfig.
 *
 * Acceptance criteria (WEE-2508 / WEE-2498):
 *   1. CEO (role=ceo)                       → 200 on PATCH another agent
 *   2. CTO (role=cto)                        → 200 on PATCH another agent in same company
 *   3. Agent with canPatchAdapterConfig=true  → 200 on PATCH another agent in same company
 *   4. IC agent with no special permission   → 403 on PATCH another agent
 *   5. Self-PATCH                            → 200 regardless of role/permissions
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const companyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const targetAgentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const actorAgentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: targetAgentId,
    companyId,
    name: "Target Agent",
    urlKey: "target-agent",
    role: "engineer",
    title: "Engineer",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: { model: "some-model" },
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false, canPatchAdapterConfig: false },
    lastHeartbeatAt: null,
    metadata: null,
    defaultEnvironmentId: null,
    createdAt: new Date("2026-04-29T00:00:00.000Z"),
    updatedAt: new Date("2026-04-29T00:00:00.000Z"),
    ...overrides,
  };
}

function makeActorAgent(roleOrOverrides: string | Record<string, unknown> = "engineer") {
  const role = typeof roleOrOverrides === "string" ? roleOrOverrides : "engineer";
  const overrides = typeof roleOrOverrides === "object" ? roleOrOverrides : {};
  return {
    id: actorAgentId,
    companyId,
    name: "Actor Agent",
    urlKey: "actor-agent",
    role,
    title: role.toUpperCase(),
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
    permissions: { canCreateAgents: false, canPatchAdapterConfig: false },
    lastHeartbeatAt: null,
    metadata: null,
    defaultEnvironmentId: null,
    createdAt: new Date("2026-04-29T00:00:00.000Z"),
    updatedAt: new Date("2026-04-29T00:00:00.000Z"),
    ...overrides,
  };
}

// ── Mock service factories ────────────────────────────────────────────────────

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  activatePendingApproval: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
  listConfigRevisions: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
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
  wakeup: vi.fn(),
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
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));
const mockRecoveryService = vi.hoisted(() => ({
  listForAgent: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>(
      "@paperclipai/adapter-opencode-local/server",
    );
    return {
      ...actual,
      ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable,
    };
  });

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
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

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/recovery/service.js", () => ({
    recoveryService: () => mockRecoveryService,
  }));
}

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve: (rows: unknown[]) => unknown) =>
            Promise.resolve(
              resolve([
                {
                  id: companyId,
                  name: "WEE",
                  requireBoardApprovalForNewAgents: false,
                },
              ]),
            ),
          ),
        }),
      }),
    }),
  };
}

/** Build an agent-auth actor for the given agent. */
function agentActor(agent: { id: string; companyId: string }) {
  return {
    type: "agent" as const,
    agentId: agent.id,
    companyId: agent.companyId,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { agentRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/agents.js") as Promise<typeof import("../routes/agents.js")>,
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

async function patchAgent(actor: Record<string, unknown>, targetId: string) {
  const app = await createApp(actor);
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");
    const port = address.port;
    return await request(`http://127.0.0.1:${port}`)
      .patch(`/api/agents/${targetId}`)
      .send({ adapterConfig: { model: "new-model" } });
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe.sequential("RBAC — CTO + canPatchAdapterConfig agent update", () => {
  const targetAgent = makeAgent();

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
    vi.doUnmock("../services/recovery/service.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("@paperclipai/adapter-opencode-local/server");
    registerModuleMocks();

    vi.resetAllMocks();

    // Common defaults
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockLogActivity.mockResolvedValue(undefined);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      (_companyId: string, cfg: unknown) => Promise.resolve(cfg),
    );
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(
      (_companyId: string, cfg: unknown) => Promise.resolve({ config: cfg }),
    );
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.getMembership.mockResolvedValue({
      id: "mem-1",
      companyId,
      principalType: "agent",
      principalId: targetAgentId,
      status: "active",
      membershipRole: "member",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({
      ambiguous: false,
      agent: targetAgent,
    });
    mockAgentService.update.mockResolvedValue(targetAgent);
    mockInstanceSettingsService.getGeneral.mockResolvedValue({ censorUsernameInLogs: false });
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockSyncInstructionsBundleConfigFromFilePath.mockImplementation((_a: unknown, cfg: unknown) => cfg);
  });

  it("CEO can PATCH another agent", async () => {
    const ceoActor = makeActorAgent("ceo");
    // getById is called twice: first for the target (param normalization), then for actor lookup
    mockAgentService.getById
      .mockResolvedValueOnce(targetAgent) // param resolution
      .mockResolvedValueOnce(targetAgent) // target in route handler
      .mockResolvedValueOnce(ceoActor);   // actor agent lookup in assertCanUpdateAgent

    const res = await patchAgent(agentActor(ceoActor), targetAgentId);
    expect(res.status).toBe(200);
  });

  it("CTO can PATCH another agent in the same company", async () => {
    const ctoActor = makeActorAgent("cto");
    mockAgentService.getById
      .mockResolvedValueOnce(targetAgent)
      .mockResolvedValueOnce(targetAgent)
      .mockResolvedValueOnce(ctoActor);

    const res = await patchAgent(agentActor(ctoActor), targetAgentId);
    expect(res.status).toBe(200);
  });

  it("agent with canPatchAdapterConfig=true can PATCH another agent", async () => {
    const dirInfraActor = makeActorAgent({
      id: actorAgentId,
      role: "devops",
      permissions: { canCreateAgents: false, canPatchAdapterConfig: true },
    });
    mockAgentService.getById
      .mockResolvedValueOnce(targetAgent)
      .mockResolvedValueOnce(targetAgent)
      .mockResolvedValueOnce(dirInfraActor);

    const res = await patchAgent(agentActor(dirInfraActor), targetAgentId);
    expect(res.status).toBe(200);
  });

  it("agent with canCreateAgents=true can still PATCH another agent", async () => {
    const creatorActor = makeActorAgent({
      id: actorAgentId,
      role: "engineer",
      permissions: { canCreateAgents: true, canPatchAdapterConfig: false },
    });
    mockAgentService.getById
      .mockResolvedValueOnce(targetAgent)
      .mockResolvedValueOnce(targetAgent)
      .mockResolvedValueOnce(creatorActor);

    const res = await patchAgent(agentActor(creatorActor), targetAgentId);
    expect(res.status).toBe(200);
  });

  it("IC agent with no special permissions gets 403 when patching another agent", async () => {
    const icActor = makeActorAgent({
      id: actorAgentId,
      role: "engineer",
      permissions: { canCreateAgents: false, canPatchAdapterConfig: false },
    });
    mockAgentService.getById
      .mockResolvedValueOnce(targetAgent)
      .mockResolvedValueOnce(targetAgent)
      .mockResolvedValueOnce(icActor);

    const res = await patchAgent(agentActor(icActor), targetAgentId);
    expect(res.status).toBe(403);
    expect(res.body.error ?? res.body.message ?? "").toMatch(
      /CEO|CTO|agent creators|canCreateAgents|canPatchAdapterConfig/i,
    );
  });

  it("any agent can PATCH itself (self-PATCH)", async () => {
    const selfActor = makeActorAgent({
      id: targetAgentId, // same ID as target
      role: "engineer",
      permissions: { canCreateAgents: false, canPatchAdapterConfig: false },
    });
    const selfTarget = makeAgent({ id: targetAgentId });
    mockAgentService.getById
      .mockResolvedValueOnce(selfTarget)
      .mockResolvedValueOnce(selfTarget)
      .mockResolvedValueOnce(selfActor);

    const res = await patchAgent({ type: "agent", agentId: targetAgentId, companyId }, targetAgentId);
    expect(res.status).toBe(200);
  });

  it("CTO from a different company cannot PATCH target agent (cross-company blocked)", async () => {
    const otherCompanyId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const ctoOtherCompany = makeActorAgent({
      id: actorAgentId,
      role: "cto",
      companyId: otherCompanyId,
    });
    mockAgentService.getById
      .mockResolvedValueOnce(targetAgent)
      .mockResolvedValueOnce(targetAgent)
      .mockResolvedValueOnce(ctoOtherCompany);

    const res = await patchAgent(
      { type: "agent", agentId: actorAgentId, companyId: otherCompanyId },
      targetAgentId,
    );
    expect(res.status).toBe(403);
  });
});
