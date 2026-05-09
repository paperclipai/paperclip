import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const safeguardAgentId = "33333333-3333-4333-8333-333333333333";
const opsReaperAgentId = "44444444-4444-4444-8444-444444444444";
const routineId = "55555555-5555-4555-8555-555555555555";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listAttachments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
  getDependencyReadiness: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockRoutineService = vi.hoisted(() => ({
  get: vi.fn(),
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => mockCompanyService,
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => mockRoutineService,
    workProductService: () => ({}),
  }));
}

function makeRoutineExecutionIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: safeguardAgentId,
    assigneeUserId: null,
    createdByUserId: null,
    identifier: "GLA-1029",
    title: "Routine execution leaked",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    originKind: "routine_execution",
    originId: routineId,
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId,
    role: "engineer",
    reportsTo: null,
    permissions: { canCreateAgents: false },
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function reaperActor() {
  return {
    type: "agent",
    agentId: opsReaperAgentId,
    companyId,
    source: "agent_key",
    runId: "66666666-6666-4666-8666-666666666666",
  };
}

describe("routine-execution cancel by tasks:cancel_routine_execution permission (GLA-1064)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === safeguardAgentId) return makeAgent(safeguardAgentId);
      if (id === opsReaperAgentId) return makeAgent(opsReaperAgentId);
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      makeAgent(safeguardAgentId),
      makeAgent(opsReaperAgentId),
    ]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "GLA" });
    // Routine owner is *not* OpsReaper: this isolates the permission-grant
    // bypass from the pre-existing routine-owner carve-out (GLA-1048).
    mockRoutineService.get.mockResolvedValue({
      id: routineId,
      companyId,
      assigneeAgentId: safeguardAgentId,
    });
    mockIssueService.getById.mockResolvedValue(makeRoutineExecutionIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 0 });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeRoutineExecutionIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      issueId,
      companyId,
      body: "comment",
    });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockStorageService.putFile.mockReset();
    mockStorageService.getObject.mockReset();
    mockStorageService.deleteObject.mockResolvedValue(undefined);
  });

  function grantCancelPermissionToReaper() {
    mockAccessService.hasPermission.mockImplementation(async (
      _companyId: string,
      _principalType: string,
      principalId: string,
      permissionKey: string,
    ) => principalId === opsReaperAgentId && permissionKey === "tasks:cancel_routine_execution");
  }

  it("allows PATCH status=cancelled with tasks:cancel_routine_execution grant", async () => {
    grantCancelPermissionToReaper();

    const res = await request(await createApp(reaperActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "cross_assignee_routine_execution_cancel",
        entityType: "issue",
        entityId: issueId,
        details: expect.objectContaining({
          routine_execution_cancel_permission: true,
          callerAgentId: opsReaperAgentId,
          priorAssigneeAgentId: safeguardAgentId,
        }),
      }),
    );
  });

  it("rejects PATCH status=cancelled when grant is missing", async () => {
    // hasPermission stays default false.
    const res = await request(await createApp(reaperActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects PATCH status=cancelled when origin is not routine_execution", async () => {
    grantCancelPermissionToReaper();
    mockIssueService.getById.mockResolvedValue(
      makeRoutineExecutionIssue({ originKind: "manual", originId: null }),
    );

    const res = await request(await createApp(reaperActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects field changes beyond status=cancelled (+ optional comment) under permission bypass", async () => {
    grantCancelPermissionToReaper();

    const res = await request(await createApp(reaperActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", title: "hijacked", priority: "low" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toMatch(/tasks:cancel_routine_execution/);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects status other than cancelled even with grant", async () => {
    grantCancelPermissionToReaper();

    const res = await request(await createApp(reaperActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
