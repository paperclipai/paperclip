import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  companyService: () => ({ getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })) }),
  heartbeatService: () => ({ wakeup: vi.fn(async () => undefined), reportRunActivity: vi.fn(async () => undefined) }),
  feedbackService: () => ({ listIssueVotesForUser: vi.fn(async () => []), saveIssueVote: vi.fn(async () => ({ vote: null })) }),
  instanceSettingsService: () => ({ get: vi.fn(async () => ({ id: "inst", general: { censorUsernameInLogs: false } })) }),
  environmentService: () => ({}),
  agentService: () => ({ getById: vi.fn() }),
  projectService: () => ({ getById: vi.fn(), listByIds: vi.fn(async () => []) }),
  goalService: () => ({ getById: vi.fn(), getDefaultCompanyGoal: vi.fn() }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    syncComment: vi.fn(async () => undefined),
    syncDocument: vi.fn(async () => undefined),
    syncIssue: vi.fn(async () => undefined),
    deleteDocumentSource: vi.fn(async () => undefined),
    diffIssueReferenceSummary: vi.fn(() => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] })),
    emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
    listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  }),
  executionWorkspaceService: () => ({ getById: vi.fn() }),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
  documentService: () => ({
    getIssueDocumentByKey: vi.fn(async () => null),
    getIssueDocumentPayload: vi.fn(async () => ({})),
    listIssueDocuments: vi.fn(async () => []),
  }),
  logActivity: vi.fn(async () => undefined),
  ISSUE_LIST_DEFAULT_LIMIT: 200,
  ISSUE_LIST_MAX_LIMIT: 500,
  clampIssueListLimit: (n: number) => Math.max(1, Math.min(500, n)),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({ getById: vi.fn() }),
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

describe.sequential("issues route me filter normalization for agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([]);
  });

  it("normalizes assigneeAgentId=me to authenticated agent id", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-123",
      companyId: "company-1",
      runId: "run-1",
      source: "agent_key",
    });

    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ assigneeAgentId: "me" });

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
      assigneeAgentId: "agent-123",
    }));
  });

  it("returns non-empty results for CTO actor when assigneeAgentId=me", async () => {
    const ctoAgentId = "b692417f-bf8d-4c47-8dfa-973ff496481d";
    mockIssueService.list.mockImplementation(async (_companyId: string, query: { assigneeAgentId?: string }) => {
      if (query.assigneeAgentId === ctoAgentId) {
        return [
          {
            id: "issue-1",
            identifier: "LPA-23",
            title: "CTO: Validate project builds and runs correctly",
            status: "in_progress",
            assigneeAgentId: ctoAgentId,
          },
        ];
      }
      return [];
    });

    const app = createApp({
      type: "agent",
      agentId: ctoAgentId,
      companyId: "company-1",
      runId: "run-cto",
      source: "agent_key",
    });

    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ assigneeAgentId: "me" });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toEqual(expect.objectContaining({
      identifier: "LPA-23",
      assigneeAgentId: ctoAgentId,
    }));
  });

  it("normalizes participantAgentId=me to authenticated agent id", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-456",
      companyId: "company-1",
      runId: "run-2",
      source: "agent_key",
    });

    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ participantAgentId: "me" });

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
      participantAgentId: "agent-456",
    }));
  });

  it("rejects assigneeAgentId=me for board authentication", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ assigneeAgentId: "me" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "assigneeAgentId=me requires agent authentication" });
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("rejects participantAgentId=me for board authentication", async () => {
    const app = createApp({
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ participantAgentId: "me" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "participantAgentId=me requires agent authentication" });
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });
});
