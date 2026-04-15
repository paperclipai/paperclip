import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const mockComputeIssueBoardStateMap = vi.hoisted(() => vi.fn());

vi.mock("../services/issue-board-state.js", () => ({
  computeIssueBoardStateMap: mockComputeIssueBoardStateMap,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => mockAgentService,
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionGateService: () => ({
    getExecutionBlock: vi.fn(async () => null),
  }),
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
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
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
  beforeAll(async () => {
    vi.resetModules();
    ({ issueRoutes: issueRoutesFactory } = await import("../routes/issues.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
    ({ HttpError: HttpErrorCtor } = await import("../errors.js"));
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.getAncestors.mockResolvedValue([]);
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
    mockComputeIssueBoardStateMap.mockResolvedValue(new Map());
  });

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
