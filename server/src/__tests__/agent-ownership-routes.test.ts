import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `../errors.js` is intentionally NOT statically imported here. `vi.resetModules()`
// runs in `beforeEach` below, which clears the module registry that
// `routes/agents.js`'s `err instanceof HttpError` check relies on. A
// top-level static import would be bound to a *different* HttpError class
// instance than the one the freshly-imported route module checks against,
// so rejecting with a statically-imported `forbidden()`/`conflict()` would
// silently fall through to the generic 500 handler. Instead, each test
// imports `../errors.js` dynamically (via `errorsModule()`) after
// `resetModules` has already run for that test, so it resolves to the same
// module instance the routes use.
async function errorsModule() {
  return import("../errors.js") as Promise<typeof import("../errors.js")>;
}

// TECH-4929 stage 1 ownership routes live inline in routes/agents.ts (see the
// "TECH-4929 stage 1: agent ownership/roles" section there), not in a
// dedicated routes/agent-ownership.ts file. This suite follows the same
// mocking scaffolding as agent-permissions-routes.test.ts, which exercises
// the same route module.

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "55555555-5555-4555-8555-555555555555";
const ownerUserId = "owner-user";

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
  createdAt: new Date("2026-03-19T00:00:00.000Z"),
  updatedAt: new Date("2026-03-19T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBuiltInAgentService = vi.hoisted(() => ({
  ensureCompanyDefaultAgentGrants: vi.fn(),
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

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  findOpenHireApprovalForAgent: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  listTaskSessions: vi.fn(),
  resetRuntimeSession: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  cancelInvocationsForAgents: vi.fn(),
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
const mockTrackAgentCreated = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockSyncInstructionsBundleConfigFromFilePath = vi.hoisted(() => vi.fn());
const mockEnsureOpenCodeModelConfiguredAndAvailable = vi.hoisted(() => vi.fn());
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

const mockOwnershipService = vi.hoisted(() => ({
  listActiveGrants: vi.fn(),
  proposeTransfer: vi.fn(),
  acceptTransfer: vi.fn(),
  declineOrCancelTransfer: vi.fn(),
  setRole: vi.fn(),
  revokeRole: vi.fn(),
  forceTransferByInstanceAdmin: vi.fn(),
  bootstrapOwnership: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>("@paperclipai/adapter-opencode-local/server");
    return {
      ...actual,
      ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable,
    };
  });

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: mockTrackAgentCreated,
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/agent-ownership.js", () => ({
    agentOwnershipService: () => mockOwnershipService,
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/approvals.js", () => ({
    approvalService: () => mockApprovalService,
  }));

  vi.doMock("../services/company-skills.js", () => ({
    companySkillService: () => mockCompanySkillService,
  }));

  vi.doMock("../services/budgets.js", () => ({
    budgetService: () => mockBudgetService,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/issue-approvals.js", () => ({
    issueApprovalService: () => mockIssueApprovalService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/agent-instructions.js", () => ({
    agentInstructionsService: () => mockAgentInstructionsService,
    syncInstructionsBundleConfigFromFilePath: mockSyncInstructionsBundleConfigFromFilePath,
  }));

  vi.doMock("../services/workspace-operations.js", () => ({
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentOwnershipService: () => mockOwnershipService,
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    builtInAgentService: () => mockBuiltInAgentService,
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

function createDbStub(options: { requireBoardApprovalForNewAgents?: boolean } = {}) {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn((resolve) =>
            Promise.resolve(resolve([{
              id: companyId,
              name: "Paperclip",
              requireBoardApprovalForNewAgents: options.requireBoardApprovalForNewAgents ?? false,
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
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

const boardOwnerActor = {
  type: "board",
  userId: ownerUserId,
  source: "local_implicit",
  isInstanceAdmin: false,
  companyIds: [companyId],
};

const boardNonAdminActor = {
  type: "board",
  userId: "board-non-admin",
  source: "session",
  isInstanceAdmin: false,
  companyIds: [companyId],
};

const instanceAdminActor = {
  type: "board",
  userId: "instance-admin",
  source: "local_implicit",
  isInstanceAdmin: true,
  companyIds: [companyId],
};

const agentActor = {
  type: "agent",
  agentId,
  companyId,
  source: "agent_key",
  runId: "run-1",
};

describe.sequential("agent ownership routes (TECH-4929 stage 1)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agent-instructions.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/agent-ownership.js");
    vi.doUnmock("../services/approvals.js");
    vi.doUnmock("../services/budgets.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/instance-settings.js");
    vi.doUnmock("../services/issue-approvals.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/secrets.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/workspace-operations.js");
    vi.doUnmock("../adapters/index.js");
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("@paperclipai/adapter-opencode-local/server");
    registerModuleMocks();
    vi.resetAllMocks();

    mockAgentService.getById.mockReset();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockBuiltInAgentService.ensureCompanyDefaultAgentGrants.mockReset();
    mockAccessService.canUser.mockReset().mockResolvedValue(true);
    mockAccessService.decide.mockReset();
    mockAccessService.hasPermission.mockReset().mockResolvedValue(false);
    mockAccessService.getMembership.mockReset();
    mockAccessService.ensureMembership.mockReset();
    mockAccessService.listPrincipalGrants.mockReset().mockResolvedValue([]);
    mockAccessService.setPrincipalPermission.mockReset();
    mockApprovalService.create.mockReset();
    mockApprovalService.getById.mockReset();
    mockApprovalService.findOpenHireApprovalForAgent.mockReset();
    mockApprovalService.approve.mockReset();
    mockApprovalService.reject.mockReset();
    mockBudgetService.upsertPolicy.mockReset();
    mockHeartbeatService.listTaskSessions.mockReset();
    mockHeartbeatService.resetRuntimeSession.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockHeartbeatService.cancelInvocationsForAgents.mockReset();
    mockIssueApprovalService.linkManyForApproval.mockReset();
    mockIssueService.list.mockReset();
    mockSecretService.normalizeAdapterConfigForPersistence.mockReset();
    mockSecretService.resolveAdapterConfigForRuntime.mockReset();
    mockAgentInstructionsService.materializeManagedBundle.mockReset();
    mockCompanySkillService.listRuntimeSkillEntries.mockReset();
    mockCompanySkillService.resolveRequestedSkillKeys.mockReset();
    mockLogActivity.mockReset().mockResolvedValue(undefined);
    mockTrackAgentCreated.mockReset();
    mockGetTelemetryClient.mockReset().mockReturnValue({ track: vi.fn() });
    mockSyncInstructionsBundleConfigFromFilePath.mockReset();
    mockInstanceSettingsService.getGeneral.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockEnsureOpenCodeModelConfiguredAndAvailable.mockReset();

    mockOwnershipService.listActiveGrants.mockReset();
    mockOwnershipService.proposeTransfer.mockReset();
    mockOwnershipService.acceptTransfer.mockReset();
    mockOwnershipService.declineOrCancelTransfer.mockReset();
    mockOwnershipService.setRole.mockReset();
    mockOwnershipService.revokeRole.mockReset();
    mockOwnershipService.forceTransferByInstanceAdmin.mockReset();
    mockOwnershipService.bootstrapOwnership.mockReset();
  });

  it("rejects an agent-type actor before any ownership logic runs", async () => {
    const app = await createApp(agentActor);

    const res = await request(app).get(`/api/agents/${agentId}/ownership`);

    expect(res.status).toBe(403);
    expect(mockOwnershipService.listActiveGrants).not.toHaveBeenCalled();
  });

  it("rejects an agent-type actor from proposing a transfer before any ownership logic runs", async () => {
    const app = await createApp(agentActor);

    const res = await request(app)
      .post(`/api/agents/${agentId}/ownership/transfers`)
      .send({ toUserId: "someone-else" });

    expect(res.status).toBe(403);
    expect(mockOwnershipService.proposeTransfer).not.toHaveBeenCalled();
  });

  it("rejects an agent-type actor from force-transferring before any ownership logic runs", async () => {
    const app = await createApp(agentActor);

    const res = await request(app)
      .post(`/api/agents/${agentId}/ownership/force-transfer`)
      .send({ toUserId: "someone-else" });

    expect(res.status).toBe(403);
    expect(mockOwnershipService.forceTransferByInstanceAdmin).not.toHaveBeenCalled();
  });

  describe("propose transfer", () => {
    it("happy path: 201 with the created transfer, and logs the activity", async () => {
      const transfer = {
        id: "transfer-1",
        companyId,
        agentId,
        fromUserId: ownerUserId,
        toUserId: "new-owner",
        status: "pending",
      };
      mockOwnershipService.proposeTransfer.mockResolvedValue(transfer);

      const app = await createApp(boardOwnerActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/transfers`)
        .send({ toUserId: "new-owner" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ id: "transfer-1", status: "pending" });
      expect(mockOwnershipService.proposeTransfer).toHaveBeenCalledWith({
        companyId,
        agentId,
        toUserId: "new-owner",
        proposedByUserId: ownerUserId,
      });
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "agent.ownership_transfer_proposed",
      }));
    });

    it("returns 403 when the caller is not the current owner", async () => {
      const { forbidden } = await errorsModule();
      mockOwnershipService.proposeTransfer.mockRejectedValue(
        forbidden("Only the current owner can propose an ownership transfer"),
      );

      const app = await createApp(boardNonAdminActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/transfers`)
        .send({ toUserId: "new-owner" });

      expect(res.status).toBe(403);
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("returns 409 when a transfer is already pending for this agent", async () => {
      const { conflict } = await errorsModule();
      mockOwnershipService.proposeTransfer.mockRejectedValue(
        conflict("A transfer is already pending for this agent"),
      );

      const app = await createApp(boardOwnerActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/transfers`)
        .send({ toUserId: "new-owner" });

      expect(res.status).toBe(409);
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("returns 422 when toUserId is missing", async () => {
      const app = await createApp(boardOwnerActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/transfers`)
        .send({});

      expect(res.status).toBe(422);
      expect(mockOwnershipService.proposeTransfer).not.toHaveBeenCalled();
    });
  });

  describe("accept transfer", () => {
    it("returns 403 when called by anyone other than the proposed recipient", async () => {
      const { forbidden } = await errorsModule();
      mockOwnershipService.acceptTransfer.mockRejectedValue(
        forbidden("Only the proposed recipient can accept this transfer"),
      );

      const app = await createApp(boardNonAdminActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/transfers/transfer-1/accept`)
        .send({});

      expect(res.status).toBe(403);
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("happy path: 200 with the resulting grant when the recipient accepts", async () => {
      const grant = {
        id: "grant-2",
        companyId,
        agentId,
        principalType: "user",
        principalId: "new-owner",
        role: "owner",
      };
      mockOwnershipService.acceptTransfer.mockResolvedValue(grant);

      const app = await createApp({ ...boardNonAdminActor, userId: "new-owner" });
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/transfers/transfer-1/accept`)
        .send({});

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: "grant-2", principalId: "new-owner" });
      expect(mockOwnershipService.acceptTransfer).toHaveBeenCalledWith({
        transferId: "transfer-1",
        acceptingUserId: "new-owner",
      });
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "agent.ownership_transfer_accepted",
      }));
    });
  });

  describe("decline / cancel transfer", () => {
    it("declines successfully for the recipient (204)", async () => {
      mockOwnershipService.declineOrCancelTransfer.mockResolvedValue(undefined);

      const app = await createApp({ ...boardNonAdminActor, userId: "recipient-user" });
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/transfers/transfer-1/decline`)
        .send({});

      expect(res.status).toBe(204);
      expect(mockOwnershipService.declineOrCancelTransfer).toHaveBeenCalledWith({
        transferId: "transfer-1",
        byUserId: "recipient-user",
        action: "decline",
      });
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "agent.ownership_transfer_declined",
      }));
    });

    it("returns 403 when a non-recipient tries to decline", async () => {
      const { forbidden } = await errorsModule();
      mockOwnershipService.declineOrCancelTransfer.mockRejectedValue(
        forbidden("Only the proposed recipient can decline this transfer"),
      );

      const app = await createApp(boardNonAdminActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/transfers/transfer-1/decline`)
        .send({});

      expect(res.status).toBe(403);
    });

    it("cancels successfully for the proposing owner (204)", async () => {
      mockOwnershipService.declineOrCancelTransfer.mockResolvedValue(undefined);

      const app = await createApp(boardOwnerActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/transfers/transfer-1/cancel`)
        .send({});

      expect(res.status).toBe(204);
      expect(mockOwnershipService.declineOrCancelTransfer).toHaveBeenCalledWith({
        transferId: "transfer-1",
        byUserId: ownerUserId,
        action: "cancel",
      });
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "agent.ownership_transfer_cancelled",
      }));
    });

    it("returns 409 when cancelling a transfer that is no longer pending", async () => {
      const { conflict } = await errorsModule();
      mockOwnershipService.declineOrCancelTransfer.mockRejectedValue(
        conflict("Transfer is not pending (status: accepted)"),
      );

      const app = await createApp(boardOwnerActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/transfers/transfer-1/cancel`)
        .send({});

      expect(res.status).toBe(409);
    });
  });

  describe("force transfer (instance-admin break-glass)", () => {
    it("returns 403 when the caller is not an instance admin, and does not invoke the service", async () => {
      const app = await createApp(boardNonAdminActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/force-transfer`)
        .send({ toUserId: "new-owner" });

      expect(res.status).toBe(403);
      // Pins that assertInstanceAdmin runs before getAccessibleResource, not
      // just that the ownership service was never reached. The separate
      // "ordering pin" test below covers the consequence of getting this
      // wrong -- 403 vs 404 leaking whether an agent exists -- while this
      // one pins the call order directly.
      expect(mockAgentService.getById).not.toHaveBeenCalled();
      expect(mockOwnershipService.forceTransferByInstanceAdmin).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("returns 403 for a board member of the company who is not an instance admin (isInstanceAdmin: false)", async () => {
      // Distinguish "board access required" from "instance admin required":
      // this actor passes assertBoard but must still fail assertInstanceAdmin.
      const app = await createApp({
        type: "board",
        userId: "company-board-member",
        source: "session",
        isInstanceAdmin: false,
        companyIds: [companyId],
      });

      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/force-transfer`)
        .send({ toUserId: "new-owner" });

      expect(res.status).toBe(403);
      // Same ordering guarantee as above: the agent lookup must never run
      // for a caller who fails assertInstanceAdmin.
      expect(mockAgentService.getById).not.toHaveBeenCalled();
      expect(mockOwnershipService.forceTransferByInstanceAdmin).not.toHaveBeenCalled();
    });

    it("happy path: 200 with the result when called by an instance admin", async () => {
      const result = {
        grant: {
          id: "grant-3",
          companyId,
          agentId,
          principalType: "user",
          principalId: "new-owner",
          role: "owner",
          isInstanceAdminOverride: true,
        },
        transfer: {
          id: "transfer-forced-1",
          status: "forced",
        },
      };
      mockOwnershipService.forceTransferByInstanceAdmin.mockResolvedValue(result);

      const app = await createApp(instanceAdminActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/force-transfer`)
        .send({ toUserId: "new-owner", reason: "offboarding" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject(result);
      expect(mockOwnershipService.forceTransferByInstanceAdmin).toHaveBeenCalledWith({
        companyId,
        agentId,
        toUserId: "new-owner",
        instanceAdminUserId: "instance-admin",
        reason: "offboarding",
      });
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "agent.ownership_force_transfer",
        details: expect.objectContaining({ isInstanceAdminOverride: true }),
      }));
    });

    it("returns 422 when toUserId is missing", async () => {
      const app = await createApp(instanceAdminActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/force-transfer`)
        .send({});

      expect(res.status).toBe(422);
      expect(mockOwnershipService.forceTransferByInstanceAdmin).not.toHaveBeenCalled();
    });

    it("ordering pin: an unauthorised caller asking about a nonexistent agent gets the authorization failure, not a 404", async () => {
      // If the route looked the agent up before checking instance-admin
      // status, a non-admin caller could distinguish "agent exists" (403,
      // after the lookup succeeds) from "agent does not exist" (404) --
      // an existence oracle that never requires being an instance admin.
      // `assertInstanceAdmin` must run before `getAccessibleResource`, so
      // the DB is never even queried for an unauthorised caller.
      mockAgentService.getById.mockResolvedValue(null);
      const nonexistentAgentId = "99999999-9999-4999-8999-999999999999";

      const app = await createApp(boardNonAdminActor);
      const res = await request(app)
        .post(`/api/agents/${nonexistentAgentId}/ownership/force-transfer`)
        .send({ toUserId: "new-owner" });

      expect(res.status).toBe(403);
      expect(mockAgentService.getById).not.toHaveBeenCalled();
      expect(mockOwnershipService.forceTransferByInstanceAdmin).not.toHaveBeenCalled();
    });
  });

  describe("bootstrap ownership (instance-admin one-time backfill)", () => {
    it("returns 403 when the caller is not an instance admin, and does not invoke the service", async () => {
      const app = await createApp(boardNonAdminActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/bootstrap`)
        .send({ ownerUserId: "new-owner" });

      expect(res.status).toBe(403);
      expect(mockAgentService.getById).not.toHaveBeenCalled();
      expect(mockOwnershipService.bootstrapOwnership).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("happy path: 201 with the created grant when called by an instance admin", async () => {
      const grant = {
        id: "grant-4",
        companyId,
        agentId,
        principalType: "user",
        principalId: "new-owner",
        role: "owner",
        isInstanceAdminOverride: true,
        source: "instance_admin_bootstrap",
      };
      mockOwnershipService.bootstrapOwnership.mockResolvedValue(grant);

      const app = await createApp(instanceAdminActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/bootstrap`)
        .send({ ownerUserId: "new-owner" });

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject(grant);
      expect(mockOwnershipService.bootstrapOwnership).toHaveBeenCalledWith({
        companyId,
        agentId,
        ownerUserId: "new-owner",
        instanceAdminUserId: "instance-admin",
      });
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "agent.ownership_bootstrapped",
        details: expect.objectContaining({ ownerUserId: "new-owner", isInstanceAdminOverride: true }),
      }));
    });

    it("returns 422 when ownerUserId is missing", async () => {
      const app = await createApp(instanceAdminActor);
      const res = await request(app).post(`/api/agents/${agentId}/ownership/bootstrap`).send({});

      expect(res.status).toBe(422);
      expect(mockOwnershipService.bootstrapOwnership).not.toHaveBeenCalled();
    });

    it("propagates a 409 when the agent already has an active owner", async () => {
      const { conflict } = await errorsModule();
      mockOwnershipService.bootstrapOwnership.mockRejectedValue(
        conflict("Agent already has an active owner -- use the transfer flow to change it."),
      );

      const app = await createApp(instanceAdminActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/bootstrap`)
        .send({ ownerUserId: "new-owner" });

      expect(res.status).toBe(409);
    });

    it("propagates a 422 when the service rejects ownerUserId for not being an active company member (distinct from the missing-field 422 above)", async () => {
      const { unprocessable } = await errorsModule();
      mockOwnershipService.bootstrapOwnership.mockRejectedValue(
        unprocessable("ownerUserId must be an active, non-viewer member of this company"),
      );

      const app = await createApp(instanceAdminActor);
      const res = await request(app)
        .post(`/api/agents/${agentId}/ownership/bootstrap`)
        .send({ ownerUserId: "not-a-member" });

      expect(res.status).toBe(422);
      // This asserts the route's own behavior: an arbitrary unprocessable()
      // message from the service propagates through the error middleware
      // verbatim (err.message -> res.body.error), and does so at a status
      // code (422) distinct from the missing-field case above -- it does
      // NOT verify that agentOwnershipService actually produces this exact
      // string in production; that's agent-ownership-service.test.ts's job.
      expect(res.body).toMatchObject({ error: expect.stringMatching(/non-viewer member/) });
    });

    it("ordering pin: an unauthorised caller asking about a nonexistent agent gets the authorization failure, not a 404", async () => {
      mockAgentService.getById.mockResolvedValue(null);
      const nonexistentAgentId = "99999999-9999-4999-8999-999999999999";

      const app = await createApp(boardNonAdminActor);
      const res = await request(app)
        .post(`/api/agents/${nonexistentAgentId}/ownership/bootstrap`)
        .send({ ownerUserId: "new-owner" });

      expect(res.status).toBe(403);
      expect(mockAgentService.getById).not.toHaveBeenCalled();
      expect(mockOwnershipService.bootstrapOwnership).not.toHaveBeenCalled();
    });

    it("returns 404 for an authorized instance admin when the agent does not exist", async () => {
      mockAgentService.getById.mockResolvedValue(null);
      const nonexistentAgentId = "99999999-9999-4999-8999-999999999999";

      const app = await createApp(instanceAdminActor);
      const res = await request(app)
        .post(`/api/agents/${nonexistentAgentId}/ownership/bootstrap`)
        .send({ ownerUserId: "new-owner" });

      expect(res.status).toBe(404);
      expect(mockOwnershipService.bootstrapOwnership).not.toHaveBeenCalled();
    });
  });

  describe("get ownership", () => {
    it("happy path: 200 with { isPublic, grants }", async () => {
      const grants = [
        { id: "grant-1", agentId, principalType: "user", principalId: ownerUserId, role: "owner" },
      ];
      mockOwnershipService.listActiveGrants.mockResolvedValue(grants);
      mockAgentService.getById.mockResolvedValue({ ...baseAgent, isPublic: true });

      const app = await createApp(boardOwnerActor);
      const res = await request(app).get(`/api/agents/${agentId}/ownership`);

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toEqual({ isPublic: true, grants });
      expect(mockOwnershipService.listActiveGrants).toHaveBeenCalledWith(agentId);
    });

    it("returns 403 for a non-board (agent-type) actor, and does not invoke the service", async () => {
      const app = await createApp(agentActor);
      const res = await request(app).get(`/api/agents/${agentId}/ownership`);

      expect(res.status).toBe(403);
      expect(mockOwnershipService.listActiveGrants).not.toHaveBeenCalled();
    });

    // The cross-tenant 404 case for this route is covered by the
    // "cross-tenant existence oracle" describe block below (same route,
    // same setup, same assertions) -- see that block for the actor-choice
    // rationale.
  });

  describe("set role", () => {
    it("happy path: 200 with the created grant, and logs the activity", async () => {
      const grant = {
        id: "grant-4",
        companyId,
        agentId,
        principalType: "user",
        principalId: "some-user",
        role: "admin",
      };
      mockOwnershipService.setRole.mockResolvedValue(grant);

      const app = await createApp(boardOwnerActor);
      const res = await request(app)
        .put(`/api/agents/${agentId}/ownership/roles/user/some-user`)
        .send({ role: "admin" });

      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: "grant-4", role: "admin" });
      expect(mockOwnershipService.setRole).toHaveBeenCalledWith({
        companyId,
        agentId,
        principalType: "user",
        principalId: "some-user",
        role: "admin",
        grantedByUserId: ownerUserId,
      });
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "agent.ownership_role_set",
      }));
    });

    it("returns 403 for a non-board (agent-type) actor, and does not invoke the service", async () => {
      const app = await createApp(agentActor);
      const res = await request(app)
        .put(`/api/agents/${agentId}/ownership/roles/user/some-user`)
        .send({ role: "admin" });

      expect(res.status).toBe(403);
      expect(mockOwnershipService.setRole).not.toHaveBeenCalled();
    });

    it("returns 404, not 403, when the agent belongs to another company", async () => {
      mockAgentService.getById.mockResolvedValue({ ...baseAgent, companyId: otherCompanyId });

      const app = await createApp(boardNonAdminActor);
      const res = await request(app)
        .put(`/api/agents/${agentId}/ownership/roles/user/some-user`)
        .send({ role: "admin" });

      expect(res.status).toBe(404);
      expect(mockOwnershipService.setRole).not.toHaveBeenCalled();
    });

    it("returns 422 for an invalid principalType, and does not invoke the service", async () => {
      const app = await createApp(boardOwnerActor);
      const res = await request(app)
        .put(`/api/agents/${agentId}/ownership/roles/robot/some-user`)
        .send({ role: "admin" });

      expect(res.status).toBe(422);
      expect(mockOwnershipService.setRole).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("returns 422 for an invalid role body value, and does not invoke the service", async () => {
      const app = await createApp(boardOwnerActor);
      const res = await request(app)
        .put(`/api/agents/${agentId}/ownership/roles/user/some-user`)
        .send({ role: "owner" });

      expect(res.status).toBe(422);
      expect(mockOwnershipService.setRole).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });

    it("agent-actor + invalid principalType: the actor-type check wins (403, not 422)", async () => {
      // Two checks could fire here: assertBoard (actor is not board) and
      // assertValidPrincipalType (principalType is not in the allowlist).
      // assertBoard runs first, so an agent-type actor must get a plain
      // 403 without ever reaching principalType validation or the service
      // -- the safe answer, since letting an agent-type actor past to a
      // 422 would confirm the route logic ran for a caller class this
      // whole block is supposed to be unreachable by.
      const app = await createApp(agentActor);
      const res = await request(app)
        .put(`/api/agents/${agentId}/ownership/roles/robot/some-user`)
        .send({ role: "admin" });

      expect(res.status).toBe(403);
      expect(mockOwnershipService.setRole).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });
  });

  describe("revoke role", () => {
    it("happy path: 204, and logs the activity", async () => {
      mockOwnershipService.revokeRole.mockResolvedValue(undefined);

      const app = await createApp(boardOwnerActor);
      const res = await request(app).delete(`/api/agents/${agentId}/ownership/roles/user/some-user`);

      expect(res.status).toBe(204);
      expect(mockOwnershipService.revokeRole).toHaveBeenCalledWith({
        agentId,
        principalType: "user",
        principalId: "some-user",
        revokedByUserId: ownerUserId,
      });
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "agent.ownership_role_revoked",
      }));
    });

    it("rejects an agent-type actor before the service is called", async () => {
      const app = await createApp(agentActor);
      const res = await request(app).delete(`/api/agents/${agentId}/ownership/roles/user/some-user`);

      expect(res.status).toBe(403);
      expect(mockOwnershipService.revokeRole).not.toHaveBeenCalled();
    });

    it("returns 404, not 403, when the agent belongs to another company", async () => {
      mockAgentService.getById.mockResolvedValue({ ...baseAgent, companyId: otherCompanyId });

      const app = await createApp(boardNonAdminActor);
      const res = await request(app).delete(`/api/agents/${agentId}/ownership/roles/user/some-user`);

      expect(res.status).toBe(404);
      expect(mockOwnershipService.revokeRole).not.toHaveBeenCalled();
    });

    it("returns 422 for an invalid principalType, and does not invoke the service", async () => {
      const app = await createApp(boardOwnerActor);
      const res = await request(app).delete(`/api/agents/${agentId}/ownership/roles/robot/some-user`);

      expect(res.status).toBe(422);
      expect(mockOwnershipService.revokeRole).not.toHaveBeenCalled();
      expect(mockLogActivity).not.toHaveBeenCalled();
    });
  });

  describe("cross-tenant existence oracle", () => {
    it("returns 404, not 403, when the agent belongs to another company", async () => {
      // Uses `boardNonAdminActor` (source: "session"), not `boardOwnerActor",
      // because "local_implicit" board sessions have blanket cross-company
      // access (see `hasCompanyAccess` in routes/authz.ts) and would not
      // exercise the oracle-avoidance path this test targets.
      mockAgentService.getById.mockResolvedValue({ ...baseAgent, companyId: otherCompanyId });

      const app = await createApp(boardNonAdminActor);
      const res = await request(app).get(`/api/agents/${agentId}/ownership`);

      expect(res.status).toBe(404);
      expect(mockOwnershipService.listActiveGrants).not.toHaveBeenCalled();
    });
  });
});
