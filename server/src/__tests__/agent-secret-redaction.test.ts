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
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {
    cwd: "/workspace",
    env: {
      OPENAI_API_KEY: "sk-secret-key-12345",
      ANTHROPIC_API_KEY: "sk-ant-secret-67890",
      DATABASE_URL: "postgres://user:pass@host/db",
      PAPERCLIP_API_URL: "http://localhost:3100",
    },
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
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
  orgForCompany: vi.fn(),
  listConfigRevisions: vi.fn(),
  getConfigRevision: vi.fn(),
  rollbackConfigRevision: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
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
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
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

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
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

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "board-user",
  source: "local_implicit",
  isInstanceAdmin: true,
  companyIds: [companyId],
};

const nonAdminBoardActor = {
  type: "board",
  userId: "board-user-2",
  source: "web",
  isInstanceAdmin: false,
  companyIds: [companyId],
};

const agentActor = {
  type: "agent",
  agentId,
  companyId,
  companyIds: [companyId],
};

describe("agent secret redaction in API responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.list.mockResolvedValue([baseAgent]);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
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
    mockAccessService.canUser.mockResolvedValue(true);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("GET /companies/:companyId/agents redacts env values for board users", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const agent = res.body[0];
    expect(agent.adapterConfig.cwd).toBe("/workspace");
    expect(agent.adapterConfig.env).toEqual({
      OPENAI_API_KEY: "***",
      ANTHROPIC_API_KEY: "***",
      DATABASE_URL: "***",
      PAPERCLIP_API_URL: "***",
    });
  });

  it("GET /agents/me redacts env values", async () => {
    const app = createApp(agentActor);
    const res = await request(app).get("/api/agents/me");

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.env).toEqual({
      OPENAI_API_KEY: "***",
      ANTHROPIC_API_KEY: "***",
      DATABASE_URL: "***",
      PAPERCLIP_API_URL: "***",
    });
  });

  it("GET /agents/:id redacts env values", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get(`/api/agents/${agentId}`);

    expect(res.status).toBe(200);
    expect(res.body.adapterConfig.env).toEqual({
      OPENAI_API_KEY: "***",
      ANTHROPIC_API_KEY: "***",
      DATABASE_URL: "***",
      PAPERCLIP_API_URL: "***",
    });
  });

  it("preserves non-env adapterConfig fields", async () => {
    const app = createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body[0].adapterConfig.cwd).toBe("/workspace");
  });

  it("GET /companies/:companyId/agents redacts env values for non-admin board users", async () => {
    mockAccessService.canUser.mockResolvedValue(false);
    const app = createApp(nonAdminBoardActor);
    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const agent = res.body[0];
    expect(agent.adapterConfig.cwd).toBe("/workspace");
    expect(agent.adapterConfig.env).toEqual({
      OPENAI_API_KEY: "***",
      ANTHROPIC_API_KEY: "***",
      DATABASE_URL: "***",
      PAPERCLIP_API_URL: "***",
    });
  });

  it("redacts sensitive runtimeConfig values", async () => {
    mockAgentService.list.mockResolvedValue([{
      ...baseAgent,
      runtimeConfig: { auth_token: "tok_secret_abc123", mode: "production" },
    }]);

    const app = createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    const agent = res.body[0];
    expect(agent.runtimeConfig.auth_token).toBe("***REDACTED***");
    expect(agent.runtimeConfig.mode).toBe("production");
  });

  it("handles agents with no env in adapterConfig", async () => {
    mockAgentService.list.mockResolvedValue([{
      ...baseAgent,
      adapterConfig: { cwd: "/workspace" },
    }]);

    const app = createApp(boardActor);
    const res = await request(app).get(`/api/companies/${companyId}/agents`);

    expect(res.status).toBe(200);
    expect(res.body[0].adapterConfig).toEqual({ cwd: "/workspace" });
  });
});
