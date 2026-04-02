import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockFeedbackService = vi.hoisted(() => ({
  getFeedbackTraceById: vi.fn(),
  getFeedbackTraceBundle: vi.fn(),
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  saveIssueVote: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => mockFeedbackService,
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
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => ({
    getById: vi.fn(),
    update: vi.fn(),
    addComment: vi.fn(),
    findMentionedAgents: vi.fn(),
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue feedback trace routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects non-board callers before fetching a feedback trace", async () => {
    const app = createApp({
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
    const app = createApp({
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
    const app = createApp({
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
