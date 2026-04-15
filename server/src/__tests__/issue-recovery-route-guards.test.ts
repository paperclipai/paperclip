import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
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

const mockDb = {} as any;
let issueRoutesFactory!: typeof import("../routes/issues.js").issueRoutes;
let errorHandlerMiddleware!: typeof import("../middleware/index.js").errorHandler;

function createApp(actor: Record<string, unknown>) {
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

function makeIssue(overrides?: Record<string, unknown>) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "COMA-1118",
    title: "Recovery target",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    projectId: null,
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

describe("issue recovery route guards", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ issueRoutes: issueRoutesFactory } = await import("../routes/issues.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
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

  it("rejects non-board recovery issue creation", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: null,
    }))
      .post("/api/companies/company-1/issues")
      .send({
        title: "Continuation",
        recoveryFromIssueId: "22222222-2222-4222-8222-222222222222",
        recoveryDisposition: "recovered_by_reissue",
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("allows board recovery issue creation", async () => {
    mockIssueService.create.mockResolvedValue(makeIssue({
      recoverySource: {
        id: "22222222-2222-4222-8222-222222222222",
        identifier: "COMA-1111",
        title: "Source",
      },
    }));

    const res = await request(createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post("/api/companies/company-1/issues")
      .send({
        title: "Continuation",
        recoveryFromIssueId: "22222222-2222-4222-8222-222222222222",
        recoveryDisposition: "recovered_by_reissue",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        recoveryFromIssueId: "22222222-2222-4222-8222-222222222222",
        recoveryDisposition: "recovered_by_reissue",
      }),
    );
  });

  it("rejects non-board recovery transitions on patch", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: null,
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        recovery: {
          successorIssueId: "33333333-3333-4333-8333-333333333333",
          disposition: "recovered_by_reissue",
        },
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows board recovery transitions on patch", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      status: "blocked",
    }));
    mockIssueService.update.mockResolvedValue(makeIssue({
      status: "cancelled",
      recoverySuccessor: {
        id: "33333333-3333-4333-8333-333333333333",
        identifier: "COMA-1119",
        title: "Continuation",
      },
    }));

    const res = await request(createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        recovery: {
          successorIssueId: "33333333-3333-4333-8333-333333333333",
          disposition: "recovered_by_reissue",
        },
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        recovery: {
          successorIssueId: "33333333-3333-4333-8333-333333333333",
          disposition: "recovered_by_reissue",
        },
      }),
    );
  });
});
