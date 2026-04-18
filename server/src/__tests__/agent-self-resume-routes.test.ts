import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const otherAgentId = "44444444-4444-4444-8444-444444444444";
const companyId = "22222222-2222-4222-8222-222222222222";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "paused" as const,
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 10_000,
  spentMonthlyCents: 2_000,
  pauseReason: "budget" as const,
  pausedAt: new Date("2026-04-11T00:00:00.000Z"),
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  updatedAt: new Date("2026-04-11T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  getKeyById: vi.fn(),
  revokeKey: vi.fn(),
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
  cancelActiveForAgent: vi.fn(),
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

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
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
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

function createApp(actor: Record<string, unknown>) {
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

function agentActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
    runId: "run-1",
    ...overrides,
  };
}

describe("POST /agents/:id/resume — budget-paused self-resume (Option C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.resume.mockImplementation(async () => ({
      ...baseAgent,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    }));
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lets a budget-paused agent resume itself when spend is below budget", async () => {
    const app = createApp(agentActor());

    const res = await request(app).post(`/api/agents/${agentId}/resume`).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("idle");
    expect(mockAgentService.resume).toHaveBeenCalledWith(agentId);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.resumed",
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId: "run-1",
        details: expect.objectContaining({
          selfResume: true,
          pauseReason: "budget",
          budgetMonthlyCents: 10_000,
          spentMonthlyCents: 2_000,
        }),
      }),
    );
  });

  it("rejects self-resume when monthly spend is at or above budget", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      spentMonthlyCents: 10_000,
    });
    const app = createApp(agentActor());

    const res = await request(app).post(`/api/agents/${agentId}/resume`).send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("monthly spend is at or above budget");
    expect(mockAgentService.resume).not.toHaveBeenCalled();
  });

  it("rejects self-resume when the agent was manually paused (not budget)", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      pauseReason: "manual",
    });
    const app = createApp(agentActor());

    const res = await request(app).post(`/api/agents/${agentId}/resume`).send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("budget-paused agents");
    expect(mockAgentService.resume).not.toHaveBeenCalled();
  });

  it("rejects an agent trying to resume a peer", async () => {
    const app = createApp(agentActor({ agentId: otherAgentId, companyId }));

    const res = await request(app).post(`/api/agents/${agentId}/resume`).send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("only resume themselves");
    expect(mockAgentService.resume).not.toHaveBeenCalled();
  });

  it("rejects self-resume across tenants", async () => {
    const app = createApp(
      agentActor({ companyId: "99999999-9999-4999-8999-999999999999" }),
    );

    const res = await request(app).post(`/api/agents/${agentId}/resume`).send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("cannot access another company");
    expect(mockAgentService.resume).not.toHaveBeenCalled();
  });

  it("rejects self-resume when budget is zero (no monthly budget set)", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
    });
    const app = createApp(agentActor());

    const res = await request(app).post(`/api/agents/${agentId}/resume`).send({});

    expect(res.status).toBe(403);
    expect(mockAgentService.resume).not.toHaveBeenCalled();
  });

  it("still allows board users to resume (existing behavior)", async () => {
    mockAccessService.canUser.mockResolvedValue(true);
    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [
        { companyId, status: "active", membershipRole: "admin" },
      ],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).post(`/api/agents/${agentId}/resume`).send({});

    expect(res.status).toBe(200);
    expect(mockAgentService.resume).toHaveBeenCalledWith(agentId);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "agent.resumed",
        actorType: "user",
        actorId: "board-user",
        details: null,
      }),
    );
  });
});
