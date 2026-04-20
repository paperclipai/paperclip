import express from "express";
import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  hasCommentContaining: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockExecutionGateService = vi.hoisted(() => ({
  getExecutionBlock: vi.fn(),
}));

const mockIssueMergeService = vi.hoisted(() => ({
  getIssueMergeStatus: vi.fn(async () => null),
  attemptQaPassAutoMerge: vi.fn(async () => ({ outcome: "not_applicable" as const, status: null })),
}));

const mockIssueWorkflowService = vi.hoisted(() => ({
  decorateIssue: vi.fn(async (issue: unknown) => issue),
  evaluateLaneCompletion: vi.fn(async () => ({ canComplete: true, blockingReasons: [] })),
  applyTemplate: vi.fn(async () => {
    throw new Error("not implemented in test");
  }),
  advanceWorkflowDependents: vi.fn(async () => []),
  invalidateWorkflowDescendants: vi.fn(async () => ({ invalidatedSelf: null, invalidatedDescendants: [] })),
  handbackWorkflowLane: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => mockAgentService,
  companyService: () => mockCompanyService,
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
    listIssueDocuments: vi.fn(async () => []),
  }),
  executionGateService: () => mockExecutionGateService,
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  issueWorkflowService: () => mockIssueWorkflowService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/issue-merge.js", () => ({
  issueMergeService: () => mockIssueMergeService,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: mockLogger,
  httpLogger: {},
}));

const mockDb = {} as any;
let issueRoutesFactory!: typeof import("../routes/issues.js").issueRoutes;
let errorHandlerMiddleware!: typeof import("../middleware/index.js").errorHandler;
let HttpErrorCtor!: typeof import("../errors.js").HttpError;
const QA_RELEASE_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const QA_RUNNER_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutesFactory(mockDb, {} as any));
  app.use(errorHandlerMiddleware);
  return app;
}

function makeIssue(status: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "PAP-901",
    title: "Ship candidate",
    description: null,
    status,
    priority: "medium",
    assigneeAgentId: "agent-engineer",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
    executionState: {
      status: "idle",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    },
    createdAt: new Date("2026-04-10T00:00:00Z"),
    updatedAt: new Date("2026-04-10T00:00:00Z"),
  };
}

function qaComment(body: string, authorAgentId = "agent-qa") {
  return {
    id: "comment-qa",
    companyId: "company-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    authorAgentId,
    authorUserId: null,
    body,
    createdAt: new Date("2026-04-10T10:00:00Z"),
    updatedAt: new Date("2026-04-10T10:00:00Z"),
  };
}

describe("issue QA gate routes", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ issueRoutes: issueRoutesFactory } = await import("../routes/issues.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
    ({ HttpError: HttpErrorCtor } = await import("../errors.js"));
  }, 60_000);

  beforeEach(() => {
    vi.resetAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.list.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.hasCommentContaining.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.listComments.mockReset();
    mockIssueService.listAttachments.mockReset();
    mockIssueService.getAncestors.mockReset();
    mockIssueService.findMentionedProjectIds.mockReset();
    mockIssueService.getRelationSummaries.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockCompanyService.getById.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockExecutionGateService.getExecutionBlock.mockReset();
    mockIssueMergeService.getIssueMergeStatus.mockReset();
    mockIssueMergeService.attemptQaPassAutoMerge.mockReset();
    mockIssueWorkflowService.decorateIssue.mockReset();
    mockIssueWorkflowService.evaluateLaneCompletion.mockReset();
    mockIssueWorkflowService.applyTemplate.mockReset();
    mockIssueWorkflowService.advanceWorkflowDependents.mockReset();
    mockIssueWorkflowService.invalidateWorkflowDescendants.mockReset();
    mockIssueWorkflowService.handbackWorkflowLane.mockReset();
    mockLogActivity.mockReset();
    mockLogger.debug.mockReset();
    mockLogger.info.mockReset();
    mockLogger.warn.mockReset();
    mockLogger.error.mockReset();
    mockHeartbeatService.wakeup.mockImplementation(async () => undefined);
    mockHeartbeatService.reportRunActivity.mockImplementation(async () => undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockExecutionGateService.getExecutionBlock.mockResolvedValue(null);
    mockIssueWorkflowService.decorateIssue.mockImplementation(async (issue: unknown) => issue);
    mockIssueWorkflowService.evaluateLaneCompletion.mockResolvedValue({
      canComplete: true,
      blockingReasons: [],
    });
    mockIssueWorkflowService.advanceWorkflowDependents.mockResolvedValue([]);
    mockIssueWorkflowService.invalidateWorkflowDescendants.mockResolvedValue({
      invalidatedSelf: null,
      invalidatedDescendants: [],
    });
    mockIssueWorkflowService.handbackWorkflowLane.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.hasCommentContaining.mockResolvedValue(false);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "PrivateClip",
      description: null,
      status: "active",
      pauseReason: null,
      pausedAt: null,
      issuePrefix: "PAP",
      issueCounter: 1,
      roadmapPath: null,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      releaseGateQaAgentId: null,
      resolvedReleaseGateQaAgentId: null,
      releaseGateQaResolutionSource: "none",
      releaseGateQaBlockingReason: null,
      requireBoardApprovalForNewAgents: false,
      feedbackDataSharingEnabled: false,
      feedbackDataSharingConsentAt: null,
      feedbackDataSharingConsentByUserId: null,
      feedbackDataSharingTermsVersion: null,
      dailyExecutiveSummaryEnabled: false,
      criticalBoardAlertsEmailEnabled: true,
      dailyExecutiveSummaryLastSentAt: null,
      dailyExecutiveSummaryLastStatus: null,
      dailyExecutiveSummaryLastError: null,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
      createdAt: new Date("2026-04-01T00:00:00Z"),
      updatedAt: new Date("2026-04-01T00:00:00Z"),
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-auto-fix",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      authorAgentId: null,
      authorUserId: "local-board",
      body: "auto-fix",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockIssueMergeService.getIssueMergeStatus.mockResolvedValue(null);
    mockIssueMergeService.attemptQaPassAutoMerge.mockResolvedValue({ outcome: "not_applicable", status: null });
    mockLogActivity.mockResolvedValue(undefined);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === "agent-qa") return { id, companyId: "company-1", role: "qa", name: "QA" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "agent-qa", companyId: "company-1", role: "qa", name: "QA", status: "idle" },
    ]);
  });

  afterEach(async () => {
    // The issue routes intentionally fire-and-forget wakeups and QA auto-fix
    // hooks after sending the response. Give those tasks time to settle before
    // the next case resets shared mocks, or later tests can observe leaked
    // background work from the previous request.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  it("rejects delivery issue done transition when current status is not in_review", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_requires_in_review",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects delivery issue done transition when latest QA comment is missing [QA PASS]", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("in_review"),
      assigneeAgentId: "agent-qa",
    });
    mockIssueService.listComments.mockResolvedValue([qaComment("QA checked basics only")]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_qa_pass",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects delivery issue done transition when no QA comment exists yet", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("in_review"),
      assigneeAgentId: "agent-qa",
    });
    mockIssueService.listComments.mockResolvedValue([]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_qa_comment",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects delivery issue done transition when latest QA comment is missing [RELEASE CONFIRMED]", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("in_review"),
      assigneeAgentId: "agent-qa",
    });
    mockIssueService.listComments.mockResolvedValue([qaComment("[QA PASS]\nNeeds release check")]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_release_confirmation",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects delivery issue done transition when the latest QA comment is missing the Smart Review summary", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("in_review"),
      assigneeAgentId: "agent-qa",
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]"),
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_qa_summary",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects delivery issue done transition when the latest QA review is failing despite ship markers", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("in_review"),
      assigneeAgentId: "agent-qa",
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:pass] [TC:fail] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
      ),
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_failing_review",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects closing a root workflow issue while any workflow lane remains incomplete", async () => {
    const existing = {
      ...makeIssue("in_review"),
      workflowTemplateKey: "engineering_delivery_v1",
      assigneeAgentId: "agent-qa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueWorkflowService.decorateIssue.mockResolvedValueOnce({
      ...existing,
      workflowSummary: {
        templateKey: "engineering_delivery_v1",
        isBlocked: true,
        blockingReasons: ["ENGINEER: lane must be done before the workflow can close."],
        activeRoles: ["engineer"],
        lanes: [
          {
            issueId: "lane-pm",
            role: "pm",
            title: "PM: Ship candidate",
            status: "done",
            assigneeAgentId: "agent-pm",
            assigneeUserId: null,
            workspaceMode: null,
            blockedByRoles: [],
            ready: false,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
          {
            issueId: "lane-engineer",
            role: "engineer",
            title: "Build: Ship candidate",
            status: "in_progress",
            assigneeAgentId: "agent-engineer",
            assigneeUserId: null,
            workspaceMode: "isolated_workspace",
            blockedByRoles: [],
            ready: true,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
        ],
      },
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      blockingReasons: ["ENGINEER: lane must be done before the workflow can close."],
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEvent: true,
        event: "workflow.root.close_blocked",
        companyId: existing.companyId,
        issueId: existing.id,
        rootIssueId: existing.id,
        templateKey: "engineering_delivery_v1",
        blockingReasons: ["ENGINEER: lane must be done before the workflow can close."],
        activeRoles: ["engineer"],
      }),
      "workflow.root.close_blocked",
    );
  });

  it("allows closing a root workflow issue when all workflow lanes are done without same-issue QA gating", async () => {
    const existing = {
      ...makeIssue("in_progress"),
      workflowTemplateKey: "engineering_delivery_v1",
      assigneeAgentId: "agent-engineer",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueWorkflowService.decorateIssue.mockResolvedValueOnce({
      ...existing,
      workflowSummary: {
        templateKey: "engineering_delivery_v1",
        isBlocked: false,
        blockingReasons: [],
        activeRoles: [],
        lanes: [
          {
            issueId: "lane-pm",
            role: "pm",
            title: "PM: Ship candidate",
            status: "done",
            assigneeAgentId: "agent-pm",
            assigneeUserId: null,
            workspaceMode: null,
            blockedByRoles: [],
            ready: false,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
          {
            issueId: "lane-designer",
            role: "designer",
            title: "Design: Ship candidate",
            status: "done",
            assigneeAgentId: "agent-designer",
            assigneeUserId: null,
            workspaceMode: null,
            blockedByRoles: [],
            ready: false,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
          {
            issueId: "lane-engineer",
            role: "engineer",
            title: "Build: Ship candidate",
            status: "done",
            assigneeAgentId: "agent-engineer",
            assigneeUserId: null,
            workspaceMode: "isolated_workspace",
            blockedByRoles: [],
            ready: false,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
          {
            issueId: "lane-security",
            role: "security",
            title: "Security: Ship candidate",
            status: "done",
            assigneeAgentId: "agent-security",
            assigneeUserId: null,
            workspaceMode: "isolated_workspace",
            blockedByRoles: [],
            ready: false,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
          {
            issueId: "lane-qa",
            role: "qa",
            title: "QA: Ship candidate",
            status: "done",
            assigneeAgentId: "agent-qa",
            assigneeUserId: null,
            workspaceMode: "isolated_workspace",
            blockedByRoles: [],
            ready: false,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
        ],
      },
    });
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "done",
      completedAt: new Date("2026-04-10T11:00:00Z"),
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("rejects delivery issue done transition when verification evidence is missing from the latest QA verdict", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("in_review"),
      assigneeAgentId: "agent-qa",
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[QA PASS]\n[RELEASE CONFIRMED]"),
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_verification",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects delivery issue done transition when the latest QA verdict only has a partial Smart Review summary", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: "agent-qa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]"),
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_qa_summary",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("uses the canonical release-gate QA owner's verdict when a later non-canonical QA comment exists", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: QA_RELEASE_AGENT_ID,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      {
        ...qaComment("QA runner follow-up note without ship markers", QA_RUNNER_AGENT_ID),
        id: "comment-runner",
        createdAt: new Date("2026-04-10T11:00:00Z"),
        updatedAt: new Date("2026-04-10T11:00:00Z"),
      },
      {
        ...qaComment(
          "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
          QA_RELEASE_AGENT_ID,
        ),
        id: "comment-release",
        createdAt: new Date("2026-04-10T10:00:00Z"),
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      },
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("rejects technical issue done transition when it was misassigned to a non-delivery role", async () => {
    const existing = {
      ...makeIssue("in_review"),
      identifier: "COMA-1063",
      title: "Merge branches",
      assigneeAgentId: "agent-pm",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.listComments.mockResolvedValue([]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-pm") return { id, companyId: "company-1", role: "pm", name: "Onboarding Agent" };
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === "agent-qa") return { id, companyId: "company-1", role: "qa", name: "QA" };
      return null;
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_requires_qa_assignee",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows delivery issue done transition when latest QA comment has both markers", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: QA_RELEASE_AGENT_ID,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RELEASE_AGENT_ID,
      ),
    ]);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "done",
      completedAt: new Date("2026-04-10T11:00:00Z"),
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("rejects delivery issue done transition when another QA agent is assigned but the canonical QA owner exists", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: QA_RUNNER_AGENT_ID,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RUNNER_AGENT_ID,
      ),
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RUNNER_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_requires_qa_assignee",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("auto-assigns the sole eligible QA agent when moving a delivery issue into in_review", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: "agent-qa",
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "agent-qa",
        assigneeUserId: null,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("Routed to QA"),
      expect.any(Object),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-qa",
      expect.objectContaining({
        reason: "issue_assigned",
      }),
    );
  });

  it("prefers the configured release-gate QA owner when moving a delivery issue into in_review", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: QA_RUNNER_AGENT_ID,
    });
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "PrivateClip",
      description: null,
      status: "active",
      pauseReason: null,
      pausedAt: null,
      issuePrefix: "PAP",
      issueCounter: 1,
      roadmapPath: null,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      releaseGateQaAgentId: QA_RUNNER_AGENT_ID,
      resolvedReleaseGateQaAgentId: QA_RUNNER_AGENT_ID,
      releaseGateQaResolutionSource: "configured",
      releaseGateQaBlockingReason: null,
      requireBoardApprovalForNewAgents: false,
      feedbackDataSharingEnabled: false,
      feedbackDataSharingConsentAt: null,
      feedbackDataSharingConsentByUserId: null,
      feedbackDataSharingTermsVersion: null,
      dailyExecutiveSummaryEnabled: false,
      criticalBoardAlertsEmailEnabled: true,
      dailyExecutiveSummaryLastSentAt: null,
      dailyExecutiveSummaryLastStatus: null,
      dailyExecutiveSummaryLastError: null,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
      createdAt: new Date("2026-04-01T00:00:00Z"),
      updatedAt: new Date("2026-04-01T00:00:00Z"),
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: QA_RUNNER_AGENT_ID,
        assigneeUserId: null,
      }),
    );
  });

  it("rejects delivery issue in_review transition when no eligible QA agent exists", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "agent-qa", companyId: "company-1", role: "qa", name: "QA", status: "paused" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_no_eligible_qa_agent",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows in_review transition when the existing assignee is already the canonical QA owner", async () => {
    const existing = {
      ...makeIssue("todo"),
      assigneeAgentId: QA_RELEASE_AGENT_ID,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[qa-routing]"),
      {},
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      QA_RELEASE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_status_changed",
      }),
    );
  });

  it("rejects in_review transition when another QA agent is requested but the canonical QA owner exists", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review", assigneeAgentId: QA_RUNNER_AGENT_ID });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_requires_qa_assignee",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects delivery issue in_review transition when assigned agent is not QA", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "22222222-2222-4222-8222-222222222222") {
        return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      }
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === "agent-qa") return { id, companyId: "company-1", role: "qa", name: "QA" };
      return null;
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review", assigneeAgentId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_requires_qa_assignee",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("supports board-only forceDone override with overrideReason", async () => {
    const existing = makeIssue("todo");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ forceDone: true, overrideReason: "Urgent customer unblock" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("does not write issue.updated activity for a no-op done patch", async () => {
    const existing = {
      ...makeIssue("done"),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(existing);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
      }),
    );
  });

  it("logs derived status activity when clearing the last blocker normalizes blocked to todo", async () => {
    const existing = {
      ...makeIssue("blocked"),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.getRelationSummaries
      .mockResolvedValueOnce({
        blockedBy: [{ id: "blocker-1" }],
        blocks: [],
      })
      .mockResolvedValueOnce({
        blockedBy: [],
        blocks: [],
      });
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "todo",
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ blockedByIssueIds: [] });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          status: "todo",
          blockedByIssueIds: [],
          _previous: expect.objectContaining({
            status: "blocked",
            blockedByIssueIds: ["blocker-1"],
          }),
        }),
      }),
    );
  });

  it("rejects in_review transition when more than one eligible QA agent matches the canonical release-gate designation", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", title: "QA and Release Engineer", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_requires_qa_assignee",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("requires QA ownership to be fixed before a delivery issue can be closed", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: QA_RUNNER_AGENT_ID,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RELEASE_AGENT_ID,
      ),
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done", assigneeAgentId: QA_RELEASE_AGENT_ID });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_requires_qa_assignee",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("returns invalid_status_transition reason codes from 422 route errors", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(() => {
      throw new HttpErrorCtor(422, "Invalid issue status transition", {
        reasonCode: "invalid_status_transition",
      });
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_progress" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "invalid_status_transition",
    });
  });

  it("rejects forceDone override for non-board actors", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-engineer",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ forceDone: true, overrideReason: "No gate needed" });

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("returns qaGate fields from issue detail payload", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: "agent-qa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:warn] [TC:fail] [CM:pass] [DOC:na]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
      ),
    ]);

    const res = await request(createApp()).get("/api/issues/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.qaGate).toMatchObject({
      isDeliveryScoped: true,
      canShip: false,
      missingRequirements: ["qa_gate_failing_review"],
      review: {
        codeQuality: "pass",
        errorHandling: "warn",
        testCoverage: "fail",
        commentQuality: "pass",
        docsImpact: "na",
        overall: "fail",
      },
    });
  });

  it("returns qaGate for in_review issues in company list responses", async () => {
    mockIssueService.list.mockResolvedValue([{
      ...makeIssue("in_review"),
      assigneeAgentId: "agent-qa",
    }]);
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
      ),
    ]);

    const res = await request(createApp()).get("/api/companies/company-1/issues?includeReviewSignals=true");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]?.qaGate).toMatchObject({
      canShip: true,
      review: { overall: "pass" },
    });
  });

  it("triggers bounded auto-fix attempts for in_review fail synthesis", async () => {
    const existing = makeIssue("in_review");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      priority: "high",
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass] [EH:pass] [TC:fail] [CM:warn] [DOC:na]"),
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ priority: "high" });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[AUTO-FIX ATTEMPT]"),
      {},
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-engineer",
      expect.objectContaining({
        reason: "qa_autofix_requested",
      }),
    );
  });

  it("skips same-issue QA auto-fix for workflow lane issues", async () => {
    const existing = {
      ...makeIssue("in_review"),
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      assigneeAgentId: "agent-qa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      priority: "high",
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass] [EH:pass] [TC:fail] [CM:warn] [DOC:na]"),
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ priority: "high" });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockIssueService.addComment).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[AUTO-FIX ATTEMPT]"),
      {},
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      "agent-qa",
      expect.objectContaining({
        reason: "qa_autofix_requested",
      }),
    );
  });

  it("allows closing a workflow lane from in_progress when lane completion passes without same-issue QA gating", async () => {
    const existing = {
      ...makeIssue("in_progress"),
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "engineer",
      workflowRequiredArtifacts: [
        {
          key: "implementation-summary",
          label: "Implementation artifact",
          kind: "document_or_work_product",
          blocking: true,
          documentKey: "implementation-summary",
          workProductTypes: ["branch"],
        },
      ],
      assigneeAgentId: "agent-engineer",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "done",
      completedAt: new Date("2026-04-10T11:00:00Z"),
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueWorkflowService.evaluateLaneCompletion).toHaveBeenCalledWith(existing);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("logs workflow lane closure blocks when artifact requirements are still failing", async () => {
    const existing = {
      ...makeIssue("in_progress"),
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "engineer",
      parentId: "root-1",
      workflowRequiredArtifacts: [
        {
          key: "implementation-summary",
          label: "Implementation artifact",
          kind: "document_or_work_product",
          blocking: true,
          documentKey: "implementation-summary",
          workProductTypes: ["branch"],
        },
      ],
      assigneeAgentId: "agent-engineer",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueWorkflowService.evaluateLaneCompletion.mockResolvedValueOnce({
      canComplete: false,
      blockingReasons: ["Implementation summary must be refreshed after the last workflow invalidation."],
      artifactStatuses: [],
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEvent: true,
        event: "workflow.lane.close_blocked",
        companyId: existing.companyId,
        issueId: existing.id,
        rootIssueId: "root-1",
        templateKey: "engineering_delivery_v1",
        laneRole: "engineer",
        blockingReasons: ["Implementation summary must be refreshed after the last workflow invalidation."],
      }),
      "workflow.lane.close_blocked",
    );
  });

  it("routes assignee completion comments into QA when delivery work is ready", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment
      .mockResolvedValueOnce({
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "agent-engineer",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:00:00Z"),
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      })
      .mockResolvedValueOnce({
        id: "comment-qa-route",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: "[QA ROUTE]\nRouted to QA",
        createdAt: new Date("2026-04-10T10:01:00Z"),
        updatedAt: new Date("2026-04-10T10:01:00Z"),
      });
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: "agent-qa",
      assigneeUserId: null,
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-engineer",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "agent-qa",
        assigneeUserId: null,
        actorAgentId: "agent-engineer",
        actorUserId: null,
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenNthCalledWith(
      2,
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[qa-routing]"),
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-qa",
      expect.objectContaining({
        reason: "issue_commented",
      }),
    );
  });

  it("does not route workflow engineer completion comments into same-issue QA", async () => {
    const existing = {
      ...makeIssue("in_progress"),
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "engineer",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-ready",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: "agent-engineer",
      authorUserId: null,
      body: "DONE: Implemented the fix and verified the regression coverage.",
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-engineer",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "agent-qa",
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
  });

  it("does not route root workflow completion comments into same-issue QA", async () => {
    const existing = {
      ...makeIssue("in_progress"),
      workflowTemplateKey: "engineering_delivery_v1",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-ready",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: "agent-engineer",
      authorUserId: null,
      body: "DONE: Root issue summary comment.",
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-engineer",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Root issue summary comment." });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
  });

  it("hands back failing workflow QA comments to the engineer lane", async () => {
    const existing = {
      ...makeIssue("todo"),
      assigneeAgentId: "agent-qa",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-qa-fail",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: "agent-qa",
      authorUserId: null,
      body: "[CQ:pass] [EH:pass] [TC:fail] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass] [EH:pass] [TC:fail] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]"),
    ]);
    mockIssueWorkflowService.handbackWorkflowLane.mockResolvedValue({
      sourceIssueId: existing.id,
      targetIssue: {
        ...makeIssue("todo"),
        id: "engineer-lane",
        assigneeAgentId: "agent-engineer",
        workflowTemplateKey: "engineering_delivery_v1",
        workflowLaneRole: "engineer",
      },
      invalidatedDescendants: [
        {
          ...existing,
          status: "blocked",
          workflowInvalidatedAt: new Date("2026-04-10T10:01:00Z"),
        },
      ],
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-qa",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "[CQ:pass] [EH:pass] [TC:fail] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]" });

    expect(res.status).toBe(201);
    expect(mockIssueWorkflowService.handbackWorkflowLane).toHaveBeenCalledWith(existing.id);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEvent: true,
        event: "workflow.handback",
        companyId: existing.companyId,
        issueId: existing.id,
        rootIssueId: null,
        templateKey: "engineering_delivery_v1",
        sourceLaneRole: "qa",
        targetLaneRole: "engineer",
        targetIssueId: "engineer-lane",
        invalidatedIssueIds: [existing.id],
        commentId: "comment-qa-fail",
      }),
      "workflow.handback",
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEvent: true,
        event: "workflow.lane.invalidated",
        companyId: existing.companyId,
        issueId: existing.id,
        rootIssueId: null,
        templateKey: "engineering_delivery_v1",
        laneRole: "qa",
        sourceLaneRole: "qa",
        targetLaneRole: "engineer",
        targetIssueId: "engineer-lane",
        reason: "workflow_handback",
      }),
      "workflow.lane.invalidated",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        action: "issue.workflow_lane_invalidated",
        entityType: "issue",
        entityId: existing.id,
        details: expect.objectContaining({
          parentId: existing.parentId,
          sourceIssueId: existing.id,
          targetIssueId: "engineer-lane",
        }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-engineer",
      expect.objectContaining({
        reason: "issue_status_changed",
        payload: expect.objectContaining({
          issueId: "engineer-lane",
          workflowHandbackFromIssueId: existing.id,
        }),
      }),
    );
  });

  it("does not hand back a workflow QA lane for lane-local review state without failing QA tokens", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: "agent-qa",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      executionState: {
        lastDecisionOutcome: "changes_requested",
      },
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-qa-pass",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: "agent-qa",
      authorUserId: null,
      body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-qa",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]" });

    expect(res.status).toBe(201);
    expect(mockIssueWorkflowService.handbackWorkflowLane).not.toHaveBeenCalled();
  });

  it("does not hand back a workflow QA lane from a board comment even if the body is failing", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: "agent-qa",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-board-fail",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: null,
      authorUserId: "local-board",
      body: "[CQ:pass] [EH:pass] [TC:fail] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });

    const res = await request(createApp())
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "[CQ:pass] [EH:pass] [TC:fail] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]" });

    expect(res.status).toBe(201);
    expect(mockIssueWorkflowService.handbackWorkflowLane).not.toHaveBeenCalled();
  });

  it("does not auto-merge a root workflow issue from QA ship markers", async () => {
    const existing = {
      ...makeIssue("in_review"),
      workflowTemplateKey: "engineering_delivery_v1",
      assigneeAgentId: QA_RELEASE_AGENT_ID,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-qa-pass-root",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: QA_RELEASE_AGENT_ID,
      authorUserId: null,
      body: [
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
        "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
        "[QA PASS]",
        "[RELEASE CONFIRMED]",
      ].join("\n"),
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return {
          id,
          companyId: "company-1",
          role: "qa",
          name: "QA and Release Engineer",
          title: "QA and Release Engineer",
        };
      }
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: [
          "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
          "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
          "[QA PASS]",
          "[RELEASE CONFIRMED]",
        ].join("\n"),
      });

    expect(res.status).toBe(201);
    expect(mockIssueMergeService.attemptQaPassAutoMerge).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      existing.id,
      expect.objectContaining({ status: "done" }),
    );
  });

  it("ignores QA agents in error state when routing assignee completion comments", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "agent-qa", companyId: "company-1", role: "qa", name: "QA", status: "idle" },
      { id: "agent-qa-error", companyId: "company-1", role: "qa", name: "QA Error", status: "error" },
    ]);
    mockIssueService.addComment
      .mockResolvedValueOnce({
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "agent-engineer",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:00:00Z"),
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      })
      .mockResolvedValueOnce({
        id: "comment-qa-route",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: "[QA ROUTE]\nRouted to QA",
        createdAt: new Date("2026-04-10T10:01:00Z"),
        updatedAt: new Date("2026-04-10T10:01:00Z"),
      });
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: "agent-qa",
      assigneeUserId: null,
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-engineer",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "agent-qa",
        assigneeUserId: null,
      }),
    );
  });

  it("posts a workflow gate comment instead of looping when QA routing is ambiguous", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "agent-qa-1", companyId: "company-1", role: "qa", name: "QA One", status: "idle" },
      { id: "agent-qa-2", companyId: "company-1", role: "qa", name: "QA Two", status: "idle" },
    ]);
    mockIssueService.addComment
      .mockResolvedValueOnce({
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "agent-engineer",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:00:00Z"),
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      })
      .mockResolvedValueOnce({
        id: "comment-qa-gate",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: "[qa-assignment-required]\nWorkflow gate: requires QA assignee before entering in_review.",
        createdAt: new Date("2026-04-10T10:01:00Z"),
        updatedAt: new Date("2026-04-10T10:01:00Z"),
      });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-engineer",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenNthCalledWith(
      2,
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("Workflow gate: requires QA assignee before entering in_review."),
      {},
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not repeat the workflow gate comment when one already exists", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "agent-qa-1", companyId: "company-1", role: "qa", name: "QA One", status: "idle" },
      { id: "agent-qa-2", companyId: "company-1", role: "qa", name: "QA Two", status: "idle" },
    ]);
    mockIssueService.hasCommentContaining.mockResolvedValue(true);
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "comment-qa-gate-existing",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: [
          "[qa-assignment-required]",
          "Workflow gate: requires QA assignee before entering in_review.",
          "Board action required.",
        ].join("\n"),
        createdAt: new Date("2026-04-10T09:59:00Z"),
        updatedAt: new Date("2026-04-10T09:59:00Z"),
      },
    ]);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-ready",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: "agent-engineer",
      authorUserId: null,
      body: "DONE: Implemented the fix and verified the regression coverage.",
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-engineer",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
  });

  it("does not repeat the workflow gate comment when an older marker falls outside a short recent window", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "agent-qa-1", companyId: "company-1", role: "qa", name: "QA One", status: "idle" },
      { id: "agent-qa-2", companyId: "company-1", role: "qa", name: "QA Two", status: "idle" },
    ]);
    const recentComments = [
      {
        id: "comment-new-1",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: "local-board",
        body: "Newest chatter",
        createdAt: new Date("2026-04-10T10:05:00Z"),
        updatedAt: new Date("2026-04-10T10:05:00Z"),
      },
      {
        id: "comment-new-2",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: "local-board",
        body: "More chatter",
        createdAt: new Date("2026-04-10T10:04:00Z"),
        updatedAt: new Date("2026-04-10T10:04:00Z"),
      },
      {
        id: "comment-new-3",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: "local-board",
        body: "Still active",
        createdAt: new Date("2026-04-10T10:03:00Z"),
        updatedAt: new Date("2026-04-10T10:03:00Z"),
      },
      {
        id: "comment-new-4",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: "local-board",
        body: "More thread traffic",
        createdAt: new Date("2026-04-10T10:02:00Z"),
        updatedAt: new Date("2026-04-10T10:02:00Z"),
      },
      {
        id: "comment-new-5",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: "local-board",
        body: "Another follow-up",
        createdAt: new Date("2026-04-10T10:01:30Z"),
        updatedAt: new Date("2026-04-10T10:01:30Z"),
      },
      {
        id: "comment-qa-gate-existing",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: [
          "[qa-assignment-required]",
          "Workflow gate: requires QA assignee before entering in_review.",
          "Board action required.",
        ].join("\n"),
        createdAt: new Date("2026-04-10T10:01:00Z"),
        updatedAt: new Date("2026-04-10T10:01:00Z"),
      },
    ];
    mockIssueService.hasCommentContaining.mockResolvedValue(true);
    mockIssueService.listComments.mockImplementation(async (_issueId: string, opts?: { limit?: number | null }) => {
      const limit = opts?.limit ?? recentComments.length;
      return recentComments.slice(0, limit);
    });
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-ready",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: "agent-engineer",
      authorUserId: null,
      body: "DONE: Implemented the fix and verified the regression coverage.",
      createdAt: new Date("2026-04-10T10:06:00Z"),
      updatedAt: new Date("2026-04-10T10:06:00Z"),
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-engineer",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
  });

  it("re-arms the workflow gate comment when a fresh completion truth arrives after an older gate marker", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "agent-qa-1", companyId: "company-1", role: "qa", name: "QA One", status: "idle" },
      { id: "agent-qa-2", companyId: "company-1", role: "qa", name: "QA Two", status: "idle" },
    ]);
    mockIssueService.hasCommentContaining.mockResolvedValue(true);
    mockIssueService.addComment
      .mockResolvedValueOnce({
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "agent-engineer",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:06:00Z"),
        updatedAt: new Date("2026-04-10T10:06:00Z"),
      })
      .mockResolvedValueOnce({
        id: "comment-qa-gate",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: [
          "[qa-assignment-required]",
          "Workflow gate: requires QA assignee before entering in_review.",
          "Board action required.",
        ].join("\n"),
        createdAt: new Date("2026-04-10T10:07:00Z"),
        updatedAt: new Date("2026-04-10T10:07:00Z"),
      });
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "agent-engineer",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:06:00Z"),
        updatedAt: new Date("2026-04-10T10:06:00Z"),
      },
      {
        id: "comment-chatter",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: "local-board",
        body: "Thanks, I will pick the QA owner next.",
        createdAt: new Date("2026-04-10T10:05:00Z"),
        updatedAt: new Date("2026-04-10T10:05:00Z"),
      },
      {
        id: "comment-qa-gate-existing",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: [
          "[qa-assignment-required]",
          "Workflow gate: requires QA assignee before entering in_review.",
          "Board action required.",
        ].join("\n"),
        createdAt: new Date("2026-04-10T10:01:00Z"),
        updatedAt: new Date("2026-04-10T10:01:00Z"),
      },
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-engineer",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(2);
    expect(mockIssueService.addComment).toHaveBeenNthCalledWith(
      2,
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("Workflow gate: requires QA assignee before entering in_review."),
      {},
    );
  });

  it("inspects the latest structured truth instead of relying on historical marker existence alone", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "agent-qa-1", companyId: "company-1", role: "qa", name: "QA One", status: "idle" },
      { id: "agent-qa-2", companyId: "company-1", role: "qa", name: "QA Two", status: "idle" },
    ]);
    mockIssueService.hasCommentContaining.mockResolvedValue(true);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-ready",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: "agent-engineer",
      authorUserId: null,
      body: "DONE: Implemented the fix and verified the regression coverage.",
      createdAt: new Date("2026-04-10T10:06:00Z"),
      updatedAt: new Date("2026-04-10T10:06:00Z"),
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-engineer",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status).toBe(201);
    expect(mockIssueService.listComments).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        order: "desc",
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(2);
    expect(mockIssueService.addComment).toHaveBeenLastCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[qa-assignment-required]"),
      {},
    );
  });

  it("auto-merges and closes an in_review issue when a QA comment includes both release markers", async () => {
    const existing = { ...makeIssue("in_review"), assigneeAgentId: QA_RELEASE_AGENT_ID };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });
    mockIssueService.addComment.mockResolvedValue({
      ...qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RELEASE_AGENT_ID,
      ),
      createdByRunId: null,
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RELEASE_AGENT_ID,
      ),
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);
    mockIssueMergeService.attemptQaPassAutoMerge.mockResolvedValue({
      outcome: "merged",
      status: {
        enabled: true,
        state: "merged",
        targetBranch: "master",
        sourceBranch: "feature/qa-pass",
        repoRoot: "/repo",
        reason: null,
        mergedCommit: "abc1234",
        mergedAt: new Date("2026-04-10T12:00:00Z"),
        lastAttemptedAt: new Date("2026-04-10T12:00:00Z"),
        lastIssueCommentStatus: null,
        createdByRuntime: true,
        branchProvenanceSource: "runtime_created",
      },
    });

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
      });

    expect(res.status).toBe(201);
    expect(mockIssueMergeService.attemptQaPassAutoMerge).toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("closes an in_review issue when a canonical QA comment satisfies the gate and merge-on-QA is not applicable", async () => {
    const existing = { ...makeIssue("in_review"), assigneeAgentId: QA_RELEASE_AGENT_ID };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });
    mockIssueService.addComment.mockResolvedValue({
      ...qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RELEASE_AGENT_ID,
      ),
      createdByRunId: null,
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RELEASE_AGENT_ID,
      ),
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);
    mockIssueMergeService.attemptQaPassAutoMerge.mockResolvedValue({
      outcome: "not_applicable",
      status: null,
    });

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
      });

    expect(res.status).toBe(201);
    expect(mockIssueMergeService.attemptQaPassAutoMerge).toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("rejects a canonical QA verdict comment that uses prose Smart Review output instead of the required token lines", async () => {
    const existing = { ...makeIssue("in_review"), assigneeAgentId: QA_RELEASE_AGENT_ID };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      ...qaComment("[QA PASS]\n[RELEASE CONFIRMED]", QA_RELEASE_AGENT_ID),
      createdByRunId: null,
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: [
          "[QA PASS][RELEASE CONFIRMED]",
          "",
          "Smart Review Summary",
          "Category\tStatus",
          "Code Quality\tPASS — fix confirmed",
          "Error Handling\tPASS — no syntax errors",
          "Test Coverage\tN/A — P0 hotfix",
          "Docs Impact\tNone",
          "Overall\tPASS — /cart route unblocked",
        ].join("\n"),
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_qa_summary",
    });
    expect(mockIssueMergeService.attemptQaPassAutoMerge).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects ship-marker verdict comments from a non-canonical QA agent while the canonical QA owner exists", async () => {
    const existing = { ...makeIssue("in_review"), assigneeAgentId: QA_RUNNER_AGENT_ID };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      ...qaComment("[QA PASS]\n[RELEASE CONFIRMED]", QA_RUNNER_AGENT_ID),
      createdByRunId: null,
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RUNNER_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: [
          "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
          "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
          "[QA PASS]",
          "[RELEASE CONFIRMED]",
        ].join("\n"),
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("authorized release-gate QA agent");
    expect(mockIssueMergeService.attemptQaPassAutoMerge).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });
});
