import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(async () => 0),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({
    getBundle: vi.fn(),
    readFile: vi.fn(),
    updateBundle: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    exportFiles: vi.fn(),
    ensureManagedBundle: vi.fn(),
    materializeManagedBundle: vi.fn(),
  }),
  accessService: () => mockAccessService,
  approvalService: () => ({}),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(),
    resolveRequestedSkillKeys: vi.fn(async (_companyId: string, requested: string[]) => requested),
  }),
  budgetService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../adapters/index.js", () => ({
  findServerAdapter: vi.fn(() => null),
  listAdapterModels: vi.fn(),
  detectAdapterModel: vi.fn(),
}));

function createDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [
          {
            id: "company-1",
            requireBoardApprovalForNewAgents: false,
          },
        ]),
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

function makeAgent(runtimeConfig: Record<string, unknown>) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    status: "running",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig,
    permissions: null,
    updatedAt: new Date(),
  };
}

describe("agent stop routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_companyId: string, config: Record<string, unknown>) => config,
    );
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("cancels active runs when a patch disables heartbeats", async () => {
    mockAgentService.getById.mockResolvedValue(
      makeAgent({ heartbeat: { enabled: true, intervalSec: 3600 } }),
    );
    mockAgentService.update.mockResolvedValue(
      makeAgent({ heartbeat: { enabled: false, intervalSec: 3600 } }),
    );

    const res = await request(createApp())
      .patch("/api/agents/11111111-1111-4111-8111-111111111111")
      .send({ runtimeConfig: { heartbeat: { enabled: false, intervalSec: 3600 } } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Cancelled because heartbeat was disabled",
    );
  });

  it("exposes an explicit stop endpoint for operators", async () => {
    mockAgentService.getById.mockResolvedValue(makeAgent({ heartbeat: { enabled: true } }));
    mockHeartbeatService.cancelActiveForAgent.mockResolvedValue(2);

    const res = await request(createApp())
      .post("/api/agents/11111111-1111-4111-8111-111111111111/stop")
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.cancelledRuns).toBe(2);
    expect(mockHeartbeatService.cancelActiveForAgent).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Cancelled by operator",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        entityType: "agent",
        entityId: "11111111-1111-4111-8111-111111111111",
        details: expect.objectContaining({
          cancelledRuns: 2,
          source: "agent_stop",
        }),
      }),
    );
  });
});
