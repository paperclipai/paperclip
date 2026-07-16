import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const COMPANY_ID = "company-1";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

const summary = {
  state: "live_run",
  reasonCode: "active_execution_run",
  reason: "Active heartbeat run run-1 is running.",
  nextActionOwner: "assignee_agent",
  evidence: {
    activeRun: {
      runId: "run-1",
      status: "running",
      livenessState: null,
      livenessReason: null,
      silenceLevel: "ok",
    },
  },
  evaluatedAt: "2026-04-27T15:00:00.000Z",
};

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getAncestors: vi.fn(async () => []),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  findMentionedProjectIds: vi.fn(async () => []),
  getCommentCursor: vi.fn(async () => ({ totalComments: 0, latestCommentId: null, latestCommentAt: null })),
  getComment: vi.fn(async () => null),
  listBlockerAttention: vi.fn(async () => new Map()),
  listProductivityReviews: vi.fn(async () => new Map()),
  getCurrentScheduledRetry: vi.fn(async () => null),
  getActiveInboxArchiveFields: vi.fn(async () => ({})),
  listAttachments: vi.fn(async () => []),
}));

const mockExecutionHealthService = vi.hoisted(() => ({
  summarize: vi.fn(),
}));

const mockExecutionHealthFactory = vi.hoisted(() => () => mockExecutionHealthService);

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  listByIds: vi.fn(async () => []),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  getDefaultCompanyGoal: vi.fn(async () => null),
}));

const mockDocumentsService = vi.hoisted(() => ({
  getIssueDocumentPayload: vi.fn(async () => ({})),
  getIssueDocumentByKey: vi.fn(async () => null),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));

const mockRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
  revalidateActiveSourceRecovery: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(async () => ({ allowed: true })),
  canUser: vi.fn(async () => true),
  hasPermission: vi.fn(async () => true),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));

const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(async () => []),
  saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
  })),
  listCompanyIds: vi.fn(async () => [COMPANY_ID]),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
}));

vi.mock("../services/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/index.js")>()),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => mockDocumentsService,
  environmentService: () => ({}),
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  feedbackService: () => mockFeedbackService,
  goalService: () => mockGoalService,
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueExecutionHealthService: mockExecutionHealthFactory,
  issueRecoveryActionService: () => mockRecoveryActionService,
  issueReferenceService: () => mockIssueReferenceService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  routineService: () => mockRoutineService,
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
}));

const issueFixture = {
  id: ISSUE_ID,
  companyId: COMPANY_ID,
  identifier: "PAP-2487",
  title: "Phase 1 health read model",
  description: null,
  status: "in_progress",
  priority: "medium",
  projectId: null,
  goalId: null,
  parentId: null,
  assigneeAgentId: "33333333-3333-4333-8333-333333333333",
  assigneeUserId: null,
  executionRunId: null,
  executionPolicy: null,
  executionState: null,
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
  updatedAt: new Date("2026-04-27T15:00:00.000Z"),
};

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: [COMPANY_ID],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const query = {
    from: vi.fn(() => query),
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
  };
  const db = { select: vi.fn(() => query) };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("issue execution health on issue routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(issueFixture);
    mockExecutionHealthService.summarize.mockResolvedValue(summary);
  });

  it("includes executionHealth on GET /issues/:id", async () => {
    const res = await request(createApp()).get(`/api/issues/${ISSUE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.executionHealth).toEqual(summary);
    expect(mockExecutionHealthService.summarize).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        identifier: "PAP-2487",
        status: "in_progress",
      }),
    );
  });

  it("includes executionHealth on GET /issues/:id/heartbeat-context", async () => {
    const res = await request(createApp()).get(`/api/issues/${ISSUE_ID}/heartbeat-context`);

    expect(res.status).toBe(200);
    expect(res.body.executionHealth).toEqual(summary);
  });

  it("denies cross-company access on GET /issues/:id", async () => {
    const otherActor = {
      type: "board",
      userId: "other-board",
      companyIds: ["other-company"],
      source: "session_cookie",
      isInstanceAdmin: false,
    };
    const res = await request(createApp(otherActor)).get(`/api/issues/${ISSUE_ID}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockExecutionHealthService.summarize).not.toHaveBeenCalled();
  });

  it("denies cross-company access on GET /issues/:id/heartbeat-context", async () => {
    const otherActor = {
      type: "board",
      userId: "other-board",
      companyIds: ["other-company"],
      source: "session_cookie",
      isInstanceAdmin: false,
    };
    const res = await request(createApp(otherActor)).get(`/api/issues/${ISSUE_ID}/heartbeat-context`);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockExecutionHealthService.summarize).not.toHaveBeenCalled();
  });
});
