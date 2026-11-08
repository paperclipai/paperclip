import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFeedbackService = vi.hoisted(() => ({
  getFeedbackTraceById: vi.fn(),
  getFeedbackTraceBundle: vi.fn(),
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  saveIssueVote: vi.fn(),
  flushPendingFeedbackTraces: vi.fn(() => new Promise(() => {})),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => ["company-1"]),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));
const mockExecutionWorkspaceService = vi.hoisted(() => ({}));
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

// Keep service factories stable while each request uses the hoisted test doubles.
vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({}),
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueReferenceService: () => mockIssueReferenceService,
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  STALE_REOPEN_PENDING_CONSUMPTION_GRACE_MS: 5 * 60 * 1000,
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => mockFeedbackService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => mockInstanceSettingsService,
}));

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
  app.use("/api", issueRoutes({} as any, {} as any));
  const routeErrors: string[] = [];
  app.locals.routeErrors = routeErrors;
  app.use((error: unknown, _req: express.Request, _res: express.Response, next: express.NextFunction) => {
    routeErrors.push(error instanceof Error ? error.stack ?? error.message : String(error));
    next(error);
  });
  app.use(errorHandler);
  return app;
}

describe("issue feedback trace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("returns the saved vote without waiting for feedback uploads", async () => {
    const targetId = "11111111-1111-4111-8111-111111111111";
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-1",
    });
    mockFeedbackService.saveIssueVote.mockResolvedValue({
      vote: {
        targetType: "issue_comment",
        targetId,
        vote: "up",
        reason: null,
      },
      traceId: "trace-1",
      consentEnabledNow: false,
      persistedSharingPreference: null,
      sharingEnabled: true,
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .post("/api/issues/issue-1/feedback-votes")
      .send({
        targetType: "issue_comment",
        targetId,
        vote: "up",
        allowSharing: true,
      });

    expect([200, 201]).toContain(res.status);
    expect(mockFeedbackService.saveIssueVote).toHaveBeenCalledTimes(1);
    expect(mockFeedbackService.flushPendingFeedbackTraces).not.toHaveBeenCalled();

  });

  it("rejects non-board callers before fetching a feedback trace", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/feedback-traces/trace-1");
    expect(res.status).toBe(403);
    expect(mockFeedbackService.getFeedbackTraceById).not.toHaveBeenCalled();
  });

  it("returns 404 when a board user lacks access to the trace company", async () => {
    mockFeedbackService.getFeedbackTraceById.mockResolvedValue({
      id: "trace-1",
      companyId: "company-2",
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/feedback-traces/trace-1");

    expect(res.status, JSON.stringify({ body: res.body, errors: app.locals.routeErrors })).toBe(404);
    expect(mockFeedbackService.getFeedbackTraceById).toHaveBeenCalledExactlyOnceWith("trace-1", true);
    expect(mockFeedbackService.getFeedbackTraceBundle).not.toHaveBeenCalled();
  });

  it("returns 404 for bundle fetches when a board user lacks access to the trace company", async () => {
    mockFeedbackService.getFeedbackTraceBundle.mockResolvedValue({
      id: "trace-1",
      companyId: "company-2",
      issueId: "issue-1",
      files: [],
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/feedback-traces/trace-1/bundle");

    expect(res.status, JSON.stringify({ body: res.body, errors: app.locals.routeErrors })).toBe(404);
    expect(mockFeedbackService.getFeedbackTraceBundle).toHaveBeenCalledExactlyOnceWith("trace-1");
    expect(mockFeedbackService.getFeedbackTraceById).not.toHaveBeenCalled();
  });
});
