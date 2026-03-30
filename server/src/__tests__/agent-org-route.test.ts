import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "22222222-2222-4222-8222-222222222222";

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
  orgForCompany: vi.fn(),
}));

const mockSeatService = vi.hoisted(() => ({
  orgForCompany: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  seatService: () => mockSeatService,
  agentInstructionsService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    getMembership: vi.fn(),
    ensureMembership: vi.fn(),
    listPrincipalGrants: vi.fn(),
    setPrincipalPermission: vi.fn(),
  }),
  approvalService: () => ({}),
  companySkillService: () => ({
    listRuntimeSkillEntries: vi.fn(),
    resolveRequestedSkillKeys: vi.fn(),
  }),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: vi.fn(),
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(),
    resolveAdapterConfigForRuntime: vi.fn(),
  }),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
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

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: [companyId],
    };
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

describe("agent org route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSeatService.orgForCompany.mockResolvedValue([
      {
        id: "agent-root",
        seatId: "seat-root",
        name: "Platform Seat",
        role: "engineer",
        seatType: "manager",
        operatingMode: "assisted",
        status: "active",
        reports: [],
      },
    ]);
  });

  it("reads org tree from seatService", async () => {
    const app = createApp();
    const res = await request(app).get(`/api/companies/${companyId}/org`);

    expect(res.status).toBe(200);
    expect(mockSeatService.orgForCompany).toHaveBeenCalledWith(companyId);
    expect(mockAgentService.orgForCompany).not.toHaveBeenCalled();
    expect(res.body).toEqual([
      {
        id: "agent-root",
        seatId: "seat-root",
        name: "Platform Seat",
        role: "engineer",
        seatType: "manager",
        operatingMode: "assisted",
        status: "active",
        reports: [],
      },
    ]);
  });
});
