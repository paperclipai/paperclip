import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateAgentSchema } from "@paperclipai/shared";

// ──────────────────────────────────────────────────────────────
// Unit: updateAgentSchema validates notes field correctly
// ──────────────────────────────────────────────────────────────

describe("B3 — updateAgentSchema notes field validation", () => {
  it("accepts a string notes value", () => {
    const result = updateAgentSchema.safeParse({ notes: "## Task 2026-06-16\nMigration files go to packages/db/src/migrations/" });
    expect(result.success).toBe(true);
  });

  it("accepts null to clear notes", () => {
    const result = updateAgentSchema.safeParse({ notes: null });
    expect(result.success).toBe(true);
  });

  it("accepts absent notes (partial schema)", () => {
    const result = updateAgentSchema.safeParse({ name: "CTO" });
    expect(result.success).toBe(true);
  });

  it("rejects notes exceeding 50k characters", () => {
    const result = updateAgentSchema.safeParse({ notes: "x".repeat(50_001) });
    expect(result.success).toBe(false);
  });

  it("accepts exactly 50k characters", () => {
    const result = updateAgentSchema.safeParse({ notes: "x".repeat(50_000) });
    expect(result.success).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────
// Route: PATCH /agents/:id passes notes through to svc.update
// ──────────────────────────────────────────────────────────────

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Architect",
  urlKey: "architect",
  role: "engineer",
  title: "Codebase Expert Architect",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: {},
  lastHeartbeatAt: null,
  notes: null,
  metadata: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
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

const mockApprovalService = vi.hoisted(() => ({ create: vi.fn(), getById: vi.fn() }));
const mockBudgetService = vi.hoisted(() => ({ upsertPolicy: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
}));
const mockIssueApprovalService = vi.hoisted(() => ({ linkManyForApproval: vi.fn() }));
const mockIssueService = vi.hoisted(() => ({ list: vi.fn() }));
const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
  syncEnvBindingsForTarget: vi.fn(),
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
const mockEnvironmentService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockInstanceSettingsService = vi.hoisted(() => ({ getGeneral: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>("@paperclipai/adapter-opencode-local/server");
    return { ...actual, ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable };
  });
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: mockTrackAgentCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({ getTelemetryClient: mockGetTelemetryClient }));
  vi.doMock("../services/agents.js", () => ({ agentService: () => mockAgentService }));
  vi.doMock("../services/access.js", () => ({ accessService: () => mockAccessService }));
  vi.doMock("../services/approvals.js", () => ({ approvalService: () => mockApprovalService }));
  vi.doMock("../services/company-skills.js", () => ({ companySkillService: () => mockCompanySkillService }));
  vi.doMock("../services/budgets.js", () => ({ budgetService: () => mockBudgetService }));
  vi.doMock("../services/heartbeat.js", () => ({ heartbeatService: () => mockHeartbeatService }));
  vi.doMock("../services/issue-approvals.js", () => ({ issueApprovalService: () => mockIssueApprovalService }));
  vi.doMock("../services/issues.js", () => ({ issueService: () => mockIssueService }));
  vi.doMock("../services/secrets.js", () => ({ secretService: () => mockSecretService }));
  vi.doMock("../services/environments.js", () => ({ environmentService: () => mockEnvironmentService }));
  vi.doMock("../services/agent-instructions.js", () => ({
    agentInstructionsService: () => mockAgentInstructionsService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  }));
  vi.doMock("../services/workspace-operations.js", () => ({ workspaceOperationService: () => mockWorkspaceOperationService }));
  vi.doMock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
  vi.doMock("../services/instance-settings.js", () => ({ instanceSettingsService: () => mockInstanceSettingsService }));
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

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve) =>
            Promise.resolve(resolve([{
              id: companyId,
              name: "Acme",
              requireBoardApprovalForNewAgents: false,
            }])),
          ),
        }),
      }),
    }),
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
    (req as any).actor = { ...actor, companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds };
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(app: express.Express, buildRequest: (baseUrl: string) => request.Test) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => { if (err) reject(err); else resolve(); });
      });
    }
  }
}

const boardActor = {
  type: "board",
  userId: "user-1",
  companyId,
  companyIds: [companyId],
  isInstanceAdmin: true,
  source: "session",
  memberships: [{ companyId, status: "active", membershipRole: "owner" }],
};

describe.sequential("B3 — PATCH /agents/:id notes field", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agent-instructions.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/approvals.js");
    vi.doUnmock("../services/budgets.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issue-approvals.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/secrets.js");
    vi.doUnmock("../services/workspace-operations.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("@paperclipai/adapter-opencode-local/server");
    registerModuleMocks();
  });

  it("PATCH with notes persists via svc.update and returns the updated agent", async () => {
    const note = "## task-b3 2026-06-16\nMigration files: packages/db/src/migrations/";
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.update.mockResolvedValue({ ...baseAgent, notes: note });
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_explicit_grant", explanation: "test" });
    mockLogActivity.mockResolvedValue(undefined);

    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base).patch(`/api/agents/${agentId}`).send({ notes: note }),
    );

    expect(res.status).toBe(200);
    expect(res.body.notes).toBe(note);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ notes: note }),
      expect.anything(),
    );
  });

  it("PATCH with notes: null clears notes", async () => {
    mockAgentService.getById.mockResolvedValue({ ...baseAgent, notes: "old notes" });
    mockAgentService.update.mockResolvedValue({ ...baseAgent, notes: null });
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_explicit_grant", explanation: "test" });
    mockLogActivity.mockResolvedValue(undefined);

    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base).patch(`/api/agents/${agentId}`).send({ notes: null }),
    );

    expect(res.status).toBe(200);
    expect(res.body.notes).toBeNull();
    expect(mockAgentService.update).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({ notes: null }),
      expect.anything(),
    );
  });

  it("PATCH with notes too long returns 422", async () => {
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAccessService.decide.mockResolvedValue({ allowed: true, reason: "allow_explicit_grant", explanation: "test" });

    const app = await createApp(boardActor);
    const res = await requestApp(app, (base) =>
      request(base).patch(`/api/agents/${agentId}`).send({ notes: "x".repeat(50_001) }),
    );

    expect(res.status).toBe(400);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
