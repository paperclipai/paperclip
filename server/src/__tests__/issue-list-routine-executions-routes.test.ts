import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue list route routine-execution visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.list.mockResolvedValue([]);
  });

  it("includes routine executions by default when an agent requests their own assigned issues", async () => {
    const app = createApp();

    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({ assigneeAgentId: "agent-1", status: "todo,in_progress,blocked" });

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith("company-1", {
      status: "todo,in_progress,blocked",
      assigneeAgentId: "agent-1",
      participantAgentId: undefined,
      assigneeUserId: undefined,
      touchedByUserId: undefined,
      inboxArchivedByUserId: undefined,
      unreadForUserId: undefined,
      projectId: undefined,
      executionWorkspaceId: undefined,
      parentId: undefined,
      labelId: undefined,
      originKind: undefined,
      originId: undefined,
      includeRoutineExecutions: true,
      q: undefined,
    });
  });
});
