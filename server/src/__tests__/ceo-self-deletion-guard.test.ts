import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
  wakeup: vi.fn(),
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({
    materializeManagedBundle: vi.fn().mockResolvedValue({ bundle: null, files: {} }),
    readBundle: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    updateBundle: vi.fn(),
    updateInstructionsPath: vi.fn(),
  }),
  accessService: () => mockAccessService,
  approvalService: () => ({ create: vi.fn(), getById: vi.fn() }),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn().mockResolvedValue([]),
    resolveRequestedSkillKeys: vi.fn().mockImplementation(async (_: string, r: string[]) => r),
    listForCompany: vi.fn().mockResolvedValue([]),
  }),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({ linkManyForApproval: vi.fn(), listPendingByAgent: vi.fn().mockResolvedValue([]) }),
  issueService: () => ({ list: vi.fn() }),
  logActivity: mockLogActivity,
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn().mockImplementation((_: string, cfg: unknown) => cfg),
    resolveAdapterConfigForRuntime: vi.fn(),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
  workspaceOperationService: () => ({}),
  instanceSettingsService: () => ({
    getGeneral: vi.fn().mockResolvedValue({ censorUsernameInLogs: false }),
  }),
}));

vi.mock("../adapters/index.js", () => ({
  listAdapterModels: vi.fn().mockResolvedValue([]),
}));

const ceoAgent = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "33333333-3333-4333-8333-333333333333",
  name: "CEO",
  urlKey: "ceo",
  role: "ceo",
  title: "CEO",
  icon: null,
  status: "running",
  reportsTo: null,
  capabilities: null,
  adapterType: "claude_local",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: true },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-03-21T00:00:00.000Z"),
  updatedAt: new Date("2026-03-21T00:00:00.000Z"),
};

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([{
            id: "33333333-3333-4333-8333-333333333333",
            name: "Test",
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
  userId: "board-user-1",
  source: "local_implicit",
  companyIds: ["33333333-3333-4333-8333-333333333333"],
};

const agentActor = {
  type: "agent",
  agentId: "11111111-1111-4111-8111-111111111111",
  companyId: "33333333-3333-4333-8333-333333333333",
  source: "agent_key",
  runId: "run-1",
};

describe("CEO self-deletion guards (#1334)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
  });

  describe("PATCH /agents/:id — agent self-termination blocked", () => {
    it("rejects agents trying to set status to terminated", async () => {
      mockAgentService.getById.mockResolvedValue(ceoAgent);
      const app = createApp(agentActor);

      const res = await request(app)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ status: "terminated" });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("board users");
    });
  });

  describe("PATCH /agents/:id — last CEO role demotion blocked", () => {
    it("blocks demoting the last CEO to another role", async () => {
      mockAgentService.getById.mockResolvedValue(ceoAgent);
      mockAgentService.list.mockResolvedValue([ceoAgent]);
      const app = createApp(boardActor);

      const res = await request(app)
        .patch("/api/agents/11111111-1111-4111-8111-111111111111")
        .send({ role: "general" });

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("last CEO");
    });
  });

  describe("POST /agents/:id/terminate — last CEO guard", () => {
    it("blocks terminating the last CEO", async () => {
      mockAgentService.getById.mockResolvedValue(ceoAgent);
      mockAgentService.list.mockResolvedValue([ceoAgent]);
      const app = createApp(boardActor);

      const res = await request(app).post("/api/agents/11111111-1111-4111-8111-111111111111/terminate");

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("last CEO");
      expect(mockAgentService.terminate).not.toHaveBeenCalled();
    });

    it("allows terminating a non-CEO agent", async () => {
      const engineer = { ...ceoAgent, id: "22222222-2222-4222-8222-222222222222", role: "general" };
      mockAgentService.getById.mockResolvedValue(engineer);
      mockAgentService.terminate.mockResolvedValue({ ...engineer, status: "terminated" });
      mockHeartbeatService.cancelActiveForAgent.mockResolvedValue(undefined);
      const app = createApp(boardActor);

      const res = await request(app).post("/api/agents/22222222-2222-4222-8222-222222222222/terminate");

      expect(res.status).toBe(200);
    });
  });

  describe("DELETE /agents/:id — last CEO guard", () => {
    it("blocks deleting the last CEO", async () => {
      mockAgentService.getById.mockResolvedValue(ceoAgent);
      mockAgentService.list.mockResolvedValue([ceoAgent]);
      const app = createApp(boardActor);

      const res = await request(app).delete("/api/agents/11111111-1111-4111-8111-111111111111");

      expect(res.status).toBe(409);
      expect(res.body.error).toContain("last CEO");
      expect(mockAgentService.remove).not.toHaveBeenCalled();
    });
  });
});
