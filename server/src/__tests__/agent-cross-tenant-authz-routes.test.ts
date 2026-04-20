import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";

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
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  updatedAt: new Date("2026-04-11T00:00:00.000Z"),
};

const baseKey = {
  id: keyId,
  agentId,
  companyId,
  name: "exploit",
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  revokedAt: null,
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

describe("agent cross-tenant route authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.pause.mockResolvedValue(baseAgent);
    mockAgentService.resume.mockResolvedValue(baseAgent);
    mockAgentService.terminate.mockResolvedValue(baseAgent);
    mockAgentService.remove.mockResolvedValue(baseAgent);
    mockAgentService.listKeys.mockResolvedValue([]);
    mockAgentService.createApiKey.mockResolvedValue({
      id: keyId,
      name: baseKey.name,
      token: "pcp_test_token",
      createdAt: baseKey.createdAt,
    });
    mockAgentService.getKeyById.mockResolvedValue(baseKey);
    mockAgentService.revokeKey.mockResolvedValue({
      ...baseKey,
      revokedAt: new Date("2026-04-11T00:05:00.000Z"),
    });
    mockHeartbeatService.cancelActiveForAgent.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("rejects cross-tenant board pause before mutating the agent", async () => {
    const app = createApp({
      type: "board",
      userId: "mallory",
      companyIds: [],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).post(`/api/agents/${agentId}/pause`).send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("User does not have access to this company");
    expect(mockAgentService.getById).toHaveBeenCalledWith(agentId);
    expect(mockAgentService.pause).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelActiveForAgent).not.toHaveBeenCalled();
  });

  it("rejects cross-tenant board key listing before reading any keys", async () => {
    const app = createApp({
      type: "board",
      userId: "mallory",
      companyIds: [],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).get(`/api/agents/${agentId}/keys`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("User does not have access to this company");
    expect(mockAgentService.getById).toHaveBeenCalledWith(agentId);
    expect(mockAgentService.listKeys).not.toHaveBeenCalled();
  });

  it("rejects cross-tenant board key creation before minting a token", async () => {
    const app = createApp({
      type: "board",
      userId: "mallory",
      companyIds: [],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post(`/api/agents/${agentId}/keys`)
      .send({ name: "exploit" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("User does not have access to this company");
    expect(mockAgentService.getById).toHaveBeenCalledWith(agentId);
    expect(mockAgentService.createApiKey).not.toHaveBeenCalled();
  });

  it("rejects cross-tenant board key revocation before touching the key", async () => {
    const app = createApp({
      type: "board",
      userId: "mallory",
      companyIds: [],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).delete(`/api/agents/${agentId}/keys/${keyId}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("User does not have access to this company");
    expect(mockAgentService.getById).toHaveBeenCalledWith(agentId);
    expect(mockAgentService.getKeyById).not.toHaveBeenCalled();
    expect(mockAgentService.revokeKey).not.toHaveBeenCalled();
  });

  it("requires the key to belong to the route agent before revocation", async () => {
    mockAgentService.getKeyById.mockResolvedValue({
      ...baseKey,
      agentId: "44444444-4444-4444-8444-444444444444",
    });
    mockAccessService.canUser.mockResolvedValue(true);

    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app).delete(`/api/agents/${agentId}/keys/${keyId}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Key not found");
    expect(mockAgentService.getKeyById).toHaveBeenCalledWith(keyId);
    expect(mockAgentService.revokeKey).not.toHaveBeenCalled();
  });
});
