import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({}));
const mockBudgetService = vi.hoisted(() => ({}));
const mockHeartbeatService = vi.hoisted(() => ({}));
const mockIssueApprovalService = vi.hoisted(() => ({}));
const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));
const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAdapter = vi.hoisted(() => ({
  testEnvironment: vi.fn(),
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
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(() => mockAdapter),
  listAdapterModels: vi.fn(),
  detectAdapterModel: vi.fn(),
}));

function createDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{
          id: companyId,
          requireBoardApprovalForNewAgents: false,
        }]),
      })),
    })),
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
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(createDb() as any));
  app.use(errorHandler);
  return app;
}

describe("agent adapter environment route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(async (_companyId, config) => config);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(async (_companyId, config) => ({ config }));
    mockAdapter.testEnvironment.mockResolvedValue({
      adapterType: "claude_local",
      status: "pass",
      checks: [],
      testedAt: new Date("2026-04-04T01:00:00.000Z").toISOString(),
    });
  });

  it("forwards an existing agentId to adapter testEnvironment", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId,
      adapterType: "claude_local",
    });

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/adapters/claude_local/test-environment`)
      .send({
        agentId,
        adapterConfig: { env: { CLAUDE_CONFIG_DIR: "/tmp/custom" } },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAdapter.testEnvironment).toHaveBeenCalledWith({
      companyId,
      agentId,
      adapterType: "claude_local",
      config: { env: { CLAUDE_CONFIG_DIR: "/tmp/custom" } },
    });
  });

  it("returns 404 when agentId is outside the requested company", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId: "33333333-3333-4333-8333-333333333333",
      adapterType: "claude_local",
    });

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/adapters/claude_local/test-environment`)
      .send({
        agentId,
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body).toEqual({ error: "Agent not found" });
    expect(mockAdapter.testEnvironment).not.toHaveBeenCalled();
  });

  it("returns 400 when agentId does not match the requested adapter type", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId,
      adapterType: "codex_local",
    });

    const res = await request(createApp())
      .post(`/api/companies/${companyId}/adapters/claude_local/test-environment`)
      .send({
        agentId,
        adapterConfig: {},
      });

    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toEqual({ error: "Agent adapter type does not match requested adapter type" });
    expect(mockAdapter.testEnvironment).not.toHaveBeenCalled();
  });
});
