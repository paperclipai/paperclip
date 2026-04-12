import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(async () => []),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(async () => null),
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
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
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
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

let issueRoutesFactory: typeof import("../routes/issues.js").issueRoutes;
let errorHandlerMiddleware: typeof import("../middleware/index.js").errorHandler;

function createApp(actorOverride?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      source: "agent_key",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      ...(actorOverride ?? {}),
    };
    next();
  });
  app.use("/api", issueRoutesFactory({} as any, {} as any));
  app.use(errorHandlerMiddleware);
  return app;
}

describe("issue discovery routing guard for assignment runs", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ issueRoutes: issueRoutesFactory } = await import("../routes/issues.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
  }, 20_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([]);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      contextSnapshot: { wakeReason: "heartbeat_timer" },
    });
  });

  it("blocks list/discovery endpoint for issue_assigned runs", async () => {
    const app = createApp();
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      contextSnapshot: {
        wakeReason: "issue_assigned",
        issueId: "issue-123",
      },
    });

    const res = await request(app).get("/api/companies/company-1/issues?assigneeAgentId=agent-1");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("assignment_mode_forbids_discovery");
    expect(res.body.issueId).toBe("issue-123");
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("allows project-scoped issue queries for issue_assigned runs", async () => {
    const app = createApp();
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "agent-1",
      contextSnapshot: {
        wakeReason: "issue_assigned",
        issueId: "issue-123",
      },
    });

    const res = await request(app).get("/api/companies/company-1/issues?projectId=project-1&assigneeAgentId=agent-1");

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledOnce();
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        projectId: "project-1",
        assigneeAgentId: "agent-1",
      }),
    );
  });

  it("allows list endpoint for non-assignment runs", async () => {
    const app = createApp();

    const res = await request(app).get("/api/companies/company-1/issues?assigneeAgentId=agent-1");

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledOnce();
  });
});
