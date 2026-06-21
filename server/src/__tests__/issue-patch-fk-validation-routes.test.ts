import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const randomUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  decomposeAcceptedPlan: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getComment: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  list: vi.fn(),
  listAttachments: vi.fn(),
  listComments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
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

const mockDocumentService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  createForIssue: vi.fn(),
  getById: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));

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
  expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  link: vi.fn(),
  unlink: vi.fn(),
  listApprovalsForIssue: vi.fn(async () => []),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
  resolveActiveForIssue: vi.fn(async () => null),
}));

const mockTaskWatchdogService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  revalidateMutationScope: vi.fn(async () => ({
    allowed: true,
    classification: { state: "stopped", stopFingerprint: "task_watchdog_stop:test" },
  })),
  reconcileForIssueAndAncestors: vi.fn(async () => ({
    checked: 0,
    triggered: 0,
    skipped: 0,
    watchdogIssueIds: [],
  })),
  upsertForIssue: vi.fn(),
  disableForIssue: vi.fn(async () => null),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
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

  vi.doMock("../services/documents.js", () => ({
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/goals.js", () => ({
    goalService: () => mockGoalService,
  }));

  vi.doMock("../services/work-products.js", () => ({
    workProductService: () => mockWorkProductService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: vi.fn(async () => undefined),
  }));

  vi.doMock("../services/index.js", () => ({
    ISSUE_LIST_DEFAULT_LIMIT: 100,
    ISSUE_LIST_MAX_LIMIT: 500,
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    clampIssueListLimit: (value: number) => Math.min(Math.max(value, 1), 500),
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => mockGoalService,
    heartbeatService: () => mockHeartbeatService,
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
    issueApprovalService: () => mockIssueApprovalService,
    issueRecoveryActionService: () => mockIssueRecoveryActionService,
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
    taskWatchdogService: () => mockTaskWatchdogService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => mockWorkProductService,
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    identifier: "PAP-1",
    title: "Test issue",
    description: "A test issue",
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    createdByAgentId: ownerAgentId,
    createdByUserId: null,
    parentId: null,
    goalId: null,
    projectId: null,
    executionState: null,
    executionPolicy: null,
    executionRunId: null,
    checkoutRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    issueNumber: 1,
    originKind: "manual",
    originId: null,
    originRunId: null,
    originFingerprint: "default",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
    monitorLastTriggeredAt: null,
    monitorAttemptCount: 0,
    monitorNotes: null,
    monitorScheduledBy: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    sourceTrust: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any, {}));
  app.use(errorHandler);
  return app;
}

describe("PATCH /api/issues/:id FK validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/goals.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();

    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);

    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.update.mockResolvedValue(makeIssue());
    mockIssueService.getRelationSummaries.mockResolvedValue([]);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);

    mockGoalService.getById.mockResolvedValue(null);
    mockGoalService.list.mockResolvedValue([]);

    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.decide.mockResolvedValue({ allowed: true });

    mockAgentService.getById.mockResolvedValue({ id: ownerAgentId, name: "test-agent" });

    mockCompanyService.getById.mockResolvedValue({ id: companyId, name: "Test Company" });
  });

  describe("parentId validation", () => {
    it("returns 422 when parentId references a non-existent issue", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        agentId: null,
        source: "local_implicit",
      });

      mockIssueService.getById.mockImplementation(async (id: string) => {
        if (id === issueId) return makeIssue();
        return null;
      });

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ parentId: randomUuid });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("parent issue not found");
    });

    it("returns 422 when parentId references an issue from a different company", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        agentId: null,
        source: "local_implicit",
      });

      const otherCompanyId = "99999999-9999-4999-8999-999999999999";
      mockIssueService.getById.mockImplementation(async (id: string) => {
        if (id === issueId) return makeIssue();
        return makeIssue({ id: randomUuid, companyId: otherCompanyId });
      });

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ parentId: randomUuid });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("parent issue not found");
    });

    it("allows setting parentId to null (clears parent)", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        agentId: null,
        source: "local_implicit",
      });

      mockIssueService.getById.mockImplementation(async (id: string) => {
        if (id === issueId) return makeIssue({ parentId: "existing-parent-id" });
        return null;
      });

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ parentId: null });

      expect(res.status).toBe(200);
    });

    it("accepts a valid existing parentId within the same company", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        agentId: null,
        source: "local_implicit",
      });

      const validParentId = "11111111-1111-4111-8111-111111111112";
      mockIssueService.getById.mockImplementation(async (id: string) => {
        if (id === issueId) return makeIssue();
        if (id === validParentId) return makeIssue({ id: validParentId, parentId: null });
        return null;
      });

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ parentId: validParentId });

      expect(res.status).toBe(200);
    });
  });

  describe("goalId validation", () => {
    it("returns 422 when goalId references a non-existent goal", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        agentId: null,
        source: "local_implicit",
      });

      mockGoalService.getById.mockResolvedValue(null);

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ goalId: randomUuid });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("goal not found");
    });

    it("returns 422 when goalId references a goal from a different company", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        agentId: null,
        source: "local_implicit",
      });

      const otherCompanyId = "99999999-9999-4999-8999-999999999999";
      mockGoalService.getById.mockResolvedValue({
        id: randomUuid,
        companyId: otherCompanyId,
        title: "Other goal",
      });

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ goalId: randomUuid });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("goal not found");
    });

    it("allows setting goalId to null", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        agentId: null,
        source: "local_implicit",
      });

      mockGoalService.getById.mockResolvedValue(null);

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ goalId: null });

      expect(res.status).toBe(200);
    });

    it("accepts a valid existing goalId within the same company", async () => {
      const app = await createApp({
        type: "board",
        userId: "user-1",
        agentId: null,
        source: "local_implicit",
      });

      const validGoalId = "22222222-2222-4222-8222-222222222223";
      mockGoalService.getById.mockResolvedValue({
        id: validGoalId,
        companyId,
        title: "Valid goal",
      });

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send({ goalId: validGoalId });

      expect(res.status).toBe(200);
    });
  });
});
