import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  listComments: vi.fn(),
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

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(),
}));

const mockExecutionGateService = vi.hoisted(() => ({
  getExecutionBlock: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  saveIssueVote: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  reportRunActivity: vi.fn(),
  getRun: vi.fn(),
  getActiveRunForAgent: vi.fn(),
  cancelRun: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(),
  listCompanyIds: vi.fn(),
}));

const mockIssueWorkflowService = vi.hoisted(() => ({
  decorateIssue: vi.fn(),
  evaluateLaneCompletion: vi.fn(),
  applyTemplate: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

const mockComputeIssueBoardStateMap = vi.hoisted(() => vi.fn());

vi.mock("../services/issue-board-state.js", () => ({
  computeIssueBoardStateMap: mockComputeIssueBoardStateMap,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentService,
  executionGateService: () => mockExecutionGateService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => mockFeedbackService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  issueWorkflowService: () => mockIssueWorkflowService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/issue-merge.js", () => ({
  issueMergeService: () => ({
    getIssueMergeStatus: vi.fn(async () => null),
    attemptQaPassAutoMerge: vi.fn(async () => ({ outcome: "not_applicable" as const, status: null })),
  }),
}));

const mockDb = {
  select: vi.fn(),
} as any;
let issueRoutesFactory!: typeof import("../routes/issues.js").issueRoutes;
let errorHandlerMiddleware!: typeof import("../middleware/index.js").errorHandler;
let HttpErrorCtor!: typeof import("../errors.js").HttpError;

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
  app.use("/api", issueRoutesFactory(mockDb, {} as any));
  app.use(errorHandlerMiddleware);
  return app;
}

function makeIssue(overrides?: Record<string, unknown>) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "COMA-1118",
    title: "Leaf issue",
    description: null,
    status: "blocked",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    executionWorkspaceId: null,
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
    labels: [],
    labelIds: [],
    createdAt: new Date("2026-04-10T00:00:00Z"),
    updatedAt: new Date("2026-04-10T00:00:00Z"),
    ...overrides,
  };
}

describe("issue board state routes", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ issueRoutes: issueRoutesFactory } = await import("../routes/issues.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
    ({ HttpError: HttpErrorCtor } = await import("../errors.js"));
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockDocumentService.getIssueDocumentPayload.mockReset();
    mockExecutionGateService.getExecutionBlock.mockReset();
    mockExecutionWorkspaceService.getById.mockReset();
    mockFeedbackService.listIssueVotesForUser.mockReset();
    mockFeedbackService.saveIssueVote.mockReset();
    mockGoalService.getById.mockReset();
    mockGoalService.getDefaultCompanyGoal.mockReset();
    mockHeartbeatService.wakeup.mockReset();
    mockHeartbeatService.reportRunActivity.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockInstanceSettingsService.get.mockReset();
    mockInstanceSettingsService.listCompanyIds.mockReset();
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getById.mockReset();
    mockIssueService.list.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [],
      blocks: [],
      recoverySource: null,
      recoverySuccessor: null,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue(null);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([]);
    mockIssueWorkflowService.decorateIssue.mockReset();
    mockIssueWorkflowService.evaluateLaneCompletion.mockReset();
    mockIssueWorkflowService.applyTemplate.mockReset();
    mockLogActivity.mockReset();
    mockProjectService.getById.mockReset();
    mockProjectService.listByIds.mockReset();
    mockRoutineService.syncRunStatusForIssue.mockReset();
    mockWorkProductService.listForIssue.mockReset();
    mockComputeIssueBoardStateMap.mockResolvedValue(new Map());
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockDocumentService.getIssueDocumentPayload.mockResolvedValue({});
    mockExecutionGateService.getExecutionBlock.mockResolvedValue(null);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockFeedbackService.listIssueVotesForUser.mockResolvedValue([]);
    mockFeedbackService.saveIssueVote.mockResolvedValue({ vote: null, consentEnabledNow: false, sharingEnabled: false });
    mockGoalService.getById.mockResolvedValue(null);
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockInstanceSettingsService.get.mockResolvedValue({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    });
    mockInstanceSettingsService.listCompanyIds.mockResolvedValue(["company-1"]);
    mockIssueWorkflowService.decorateIssue.mockImplementation(async (issue: unknown) => issue);
    mockIssueWorkflowService.evaluateLaneCompletion.mockResolvedValue({ canComplete: true, blockingReasons: [], artifactStatuses: [] });
    mockLogActivity.mockResolvedValue(undefined);
    mockProjectService.getById.mockResolvedValue(null);
    mockProjectService.listByIds.mockResolvedValue([]);
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockWorkProductService.listForIssue.mockResolvedValue([]);
  }, 30_000);

  it("includes boardState and primaryBlocker on GET /issues/:id", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockComputeIssueBoardStateMap.mockResolvedValue(new Map([
      [issue.id, {
        boardState: {
          kind: "blocked",
          headline: "Blocked by COMA-1098",
          reasonCode: null,
          actorType: "issue",
          actorId: "blocker-1",
          primaryAction: {
            type: "open_blocker",
            label: "Go to blocker",
            targetEntity: "issue",
            targetId: "blocker-1",
          },
        },
        primaryBlocker: {
          issueId: "blocker-1",
          identifier: "COMA-1098",
          title: "Primary blocker",
          blockedIssueCount: 4,
          pathLength: 3,
        },
        rootBlockers: [{
          issueId: "blocker-1",
          identifier: "COMA-1098",
          title: "Primary blocker",
          blockedIssueCount: 4,
          pathLength: 3,
        }],
        blockerPath: [{
          issueId: "blocker-1",
          identifier: "COMA-1098",
          title: "Primary blocker",
          status: "todo",
          priority: "critical",
          assigneeAgentId: null,
          assigneeUserId: null,
        }],
      }],
    ]));

    const res = await request(createApp()).get(`/api/issues/${issue.id}`);

    expect(res.status).toBe(200);
    expect(res.body.boardState.headline).toBe("Blocked by COMA-1098");
    expect(res.body.primaryBlocker.identifier).toBe("COMA-1098");
    expect(res.body.rootBlockers).toHaveLength(1);
    expect(res.body.blockerPath).toHaveLength(1);
  });

  it("includes boardState headlines in company issue lists", async () => {
    const issue = makeIssue({ status: "in_review" });
    mockIssueService.list.mockResolvedValue([issue]);
    mockComputeIssueBoardStateMap.mockResolvedValue(new Map([
      [issue.id, {
        boardState: {
          kind: "waiting",
          headline: "Waiting on QA",
          reasonCode: "review",
          actorType: "agent",
          actorId: "agent-qa",
          primaryAction: {
            type: "open_issue",
            label: "Review QA state",
            targetEntity: "issue",
            targetId: issue.id,
          },
        },
        primaryBlocker: null,
      }],
    ]));

    const res = await request(createApp()).get("/api/companies/company-1/issues");

    expect(res.status).toBe(200);
    expect(res.body[0].boardState.headline).toBe("Waiting on QA");
    expect(res.body[0].primaryBlocker).toBeNull();
  });

  it("returns 422 when a mutation tries to persist blocked without blockers", async () => {
    const issue = makeIssue({ status: "todo" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockRejectedValue(
      new HttpErrorCtor(422, "Blocked issues require at least one blocker relation"),
    );

    const res = await request(createApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "blocked", blockedByIssueIds: [] });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/blocked issues require at least one blocker relation/i);
  });
});
