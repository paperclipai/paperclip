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
  name: "Dot",
  urlKey: "dot",
  role: "pm",
  title: "PM",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "openclaw_gateway",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-04-01T00:00:00.000Z"),
  updatedAt: new Date("2026-04-01T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeKey: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => ({}),
  approvalService: () => ({}),
  companySkillService: () => ({ listRuntimeSkillEntries: vi.fn() }),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
    resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(),
  listAdapterModels: vi.fn(),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("agent key routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAgentService.listKeys.mockResolvedValue([
      {
        id: "key-1",
        name: "Default",
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        revokedAt: null,
      },
    ]);
    mockAgentService.createApiKey.mockResolvedValue({
      id: "key-2",
      name: "Default",
      token: "pcp_test_token",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    mockAgentService.revokeKey.mockResolvedValue({
      id: "key-1",
      agentId,
      revokedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lists keys when the route is addressed by agent shortname", async () => {
    const res = await request(createApp())
      .get(`/api/agents/dot/keys?companyId=${companyId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith(companyId, "dot");
    expect(mockAgentService.listKeys).toHaveBeenCalledWith(agentId);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: "key-1", name: "Default" });
  });

  it("creates a key when the route is addressed by agent shortname", async () => {
    const res = await request(createApp())
      .post(`/api/agents/dot/keys?companyId=${companyId}`)
      .send({ name: "Default" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith(companyId, "dot");
    expect(mockAgentService.createApiKey).toHaveBeenCalledWith(agentId, "Default");
    expect(res.body).toMatchObject({ id: "key-2", name: "Default", token: "pcp_test_token" });
  });

  it("scopes key revocation to the resolved agent id", async () => {
    const res = await request(createApp())
      .delete(`/api/agents/dot/keys/key-1?companyId=${companyId}`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAgentService.resolveByReference).toHaveBeenCalledWith(companyId, "dot");
    expect(mockAgentService.revokeKey).toHaveBeenCalledWith(agentId, "key-1");
    expect(res.body).toEqual({ ok: true });
  });
});
