import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFeedbackService = vi.hoisted(() => ({
  getFeedbackTraceById: vi.fn(),
  getFeedbackTraceBundle: vi.fn(),
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  saveIssueVote: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockFeedbackExportService = vi.hoisted(() => ({
  flushPendingFeedbackTraces: vi.fn(async () => ({ attempted: 1, sent: 1, failed: 0 })),
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

function registerModuleMocks() {
  const sharedTelemetryMock = () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  });

  const telemetryMock = () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  });

  const servicesIndexMock = () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => mockFeedbackService,
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => mockInstanceSettingsService,
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => mockRoutineService,
    workProductService: () => ({}),
  });

  vi.doMock("@paperclipai/shared/telemetry", sharedTelemetryMock);
  vi.doMock("../telemetry.js", telemetryMock);
  vi.doMock("../telemetry.ts", telemetryMock);
  vi.doMock("../services/index.js", servicesIndexMock);
  vi.doMock("../services/index.ts", servicesIndexMock);
}

function resetIssueRouteModules() {
  vi.resetModules();
  vi.doUnmock("@paperclipai/db");
  vi.doUnmock("@paperclipai/shared");
  vi.doUnmock("@paperclipai/shared/telemetry");
  vi.doUnmock("../attachment-types.js");
  vi.doUnmock("../attachment-types.ts");
  vi.doUnmock("../errors.js");
  vi.doUnmock("../errors.ts");
  vi.doUnmock("../telemetry.js");
  vi.doUnmock("../telemetry.ts");
  vi.doUnmock("../routes/issues.js");
  vi.doUnmock("../routes/issues.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../routes/issues-checkout-wakeup.js");
  vi.doUnmock("../routes/issues-checkout-wakeup.ts");
  vi.doUnmock("../routes/workspace-command-authz.js");
  vi.doUnmock("../routes/workspace-command-authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../middleware/validate.ts");
  vi.doUnmock("../middleware/logger.js");
  vi.doUnmock("../middleware/logger.ts");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/index.ts");
  vi.doUnmock("../services/issue-assignment-wakeup.js");
  vi.doUnmock("../services/issue-assignment-wakeup.ts");
  vi.doUnmock("../services/issue-execution-policy.js");
  vi.doUnmock("../services/issue-execution-policy.ts");
}

async function createApp(actor: Record<string, unknown>) {
  resetIssueRouteModules();
  registerModuleMocks();
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.ts"),
    import("../middleware/index.ts"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any, { feedbackExportService: mockFeedbackExportService }));
  app.use(errorHandler);
  return app;
}

describe("issue feedback trace routes", () => {
  beforeEach(() => {
    resetIssueRouteModules();
    registerModuleMocks();
    vi.clearAllMocks();
    mockFeedbackExportService.flushPendingFeedbackTraces.mockResolvedValue({
      attempted: 1,
      sent: 1,
      failed: 0,
    });
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

  afterEach(() => {
    resetIssueRouteModules();
    vi.resetAllMocks();
  });

  it("flushes a newly shared feedback trace immediately after saving the vote", async () => {
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
    expect(mockFeedbackExportService.flushPendingFeedbackTraces).toHaveBeenCalledWith({
      companyId: "company-1",
      traceId: "trace-1",
      limit: 1,
    });
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

    expect(res.status).toBe(404);
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

    expect(res.status).toBe(404);
  });
});
