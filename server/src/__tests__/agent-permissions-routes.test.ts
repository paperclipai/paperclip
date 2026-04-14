import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INBOX_MINE_ISSUE_STATUS_FILTER } from "@paperclipai/shared";
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
  createdAt: "2026-03-19T00:00:00.000Z",
  updatedAt: "2026-03-19T00:00:00.000Z",
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  updatePermissions: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
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

describe("agent permission routes", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();

    const db = createDbStub();

    vi.doMock("../db/index.js", () => ({ db }));

    app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.actor = { type: "board", userId: "user-1", isInstanceAdmin: false, companyIds: [companyId] };
      next();
    });

    const agentRouter = agentRoutes(db);
    app.use("/api", agentRouter);
    app.use(errorHandler);

    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAgentService.create.mockResolvedValue(baseAgent);
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.updatePermissions.mockResolvedValue(baseAgent);
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
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockImplementation(async (_companyId, requested) => requested);
    mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
    mockAgentInstructionsService.materializeManagedBundle.mockImplementation(
      async (agent: Record<string, unknown>, files: Record<string, string>) => ({
        bundle: null,
        adapterConfig: {
          ...((agent.adapterConfig as Record<string, unknown> | undefined) ?? {}),
          instructionsBundleMode: "managed",
          instructionsRootPath: `/tmp/${String(agent.id)}/instructions`,
          instructionsEntryFile: "AGENTS.md",
          instructionsFilePath: `/tmp/${String(agent.id)}/instructions/AGENTS.md`,
          promptTemplate: files["AGENTS.md"] ?? "",
        },
      }),
    );
    mockSecretService.normalizeAdapterConfigForPersistence.mockImplementation(
      async (_companyId, config) => config,
    );
  });

  it("grants tasks:assign by default when board creates a new agent", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Builder",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      });

    expect(res.status).toBe(201);
    expect(mockAccessService.ensureMembership).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "member",
      "active",
    );
    expect(mockAccessService.setPrincipalPermission).toHaveBeenCalledWith(
      companyId,
      "agent",
      agentId,
      "tasks:assign",
      true,
      "user-1",
    );
  });

  it("does not auto-grant when agent.canCreateAgents is false", async () => {
    app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.actor = { type: "agent", agentId, companyId };
      next();
    });

    mockAgentService.getById.mockImplementation(async (id) => {
      if (id === agentId) {
        return { ...baseAgent, permissions: { canCreateAgents: false } };
      }
    });

    // Mock hasPermission to return false for agents:create permission
    mockAccessService.hasPermission.mockResolvedValue(false);

    const db = createDbStub();
    const agentRouter = agentRoutes(db);
    app.use("/api", agentRouter);
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: "Worker",
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
      });

    expect(res.status).toBe(403);
  });

  it("shows agent permissions in response", async () => {
    mockAccessService.listPrincipalGrants.mockResolvedValue([
      {
        id: "grant-1",
        companyId,
        principalType: "agent",
        principalId: agentId,
        permission: "tasks:assign",
        allowed: true,
        grantedBy: "user-1",
        grantedAt: new Date("2026-03-19T00:00:00.000Z"),
        revokedBy: null,
        revokedAt: null,
        createdAt: new Date("2026-03-19T00:00:00.000Z"),
        updatedAt: new Date("2026-03-19T00:00:00.000Z"),
      },
    ]);

    const res = await request(app).get(`/api/agents/${agentId}/permissions`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      agent: baseAgent,
      grants: [
        {
          id: "grant-1",
          companyId,
          principalType: "agent",
          principalId: agentId,
          permission: "tasks:assign",
          allowed: true,
          grantedBy: "user-1",
          grantedAt: "2026-03-19T00:00:00.000Z",
          revokedBy: null,
          revokedAt: null,
          createdAt: "2026-03-19T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        },
      ],
    });
  });

  it("allows agent permissions to be bulk-updated with agent ID parameter", async () => {
    const patchRes = await request(app)
      .patch(`/api/agents/${agentId}/permissions`)
      .send({
        grants: [
          {
            permission: "tasks:assign",
            allowed: false,
          },
          {
            permission: "tasks:create",
            allowed: true,
          },
        ],
      });

    expect(patchRes.status).toBe(200);
    expect(mockAgentService.updatePermissions).toHaveBeenCalledWith(
      agentId,
      [
        {
          permission: "tasks:assign",
          allowed: false,
        },
        {
          permission: "tasks:create",
          allowed: true,
        },
      ],
      "user-1",
    );
  });
});