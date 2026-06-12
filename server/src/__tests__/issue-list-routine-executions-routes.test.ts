import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

// Use importOriginal to keep the real exports for constants
// (ISSUE_LIST_DEFAULT_LIMIT, clampIssueListLimit, ...) and helper functions,
// then override only the service factories whose DB-touching behavior we
// don't want in this no-DB test.
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    accessService: () => ({
      canUser: vi.fn(),
      decide: vi.fn(async () => ({
        allowed: true,
        action: "company_scope:read",
        reason: "allow_company_agent",
        explanation: "Allowed by test.",
      })),
      hasPermission: vi.fn(),
    }),
    agentService: () => ({
      getById: vi.fn(),
    }),
    companyService: () => ({
      getById: vi.fn(),
      getSettings: vi.fn(async () => ({})),
    }),
    documentService: () => ({
      getIssueDocumentPayload: vi.fn(async () => ({})),
    }),
    executionWorkspaceService: () => ({
      getById: vi.fn(),
    }),
    feedbackService: () => ({
      submit: vi.fn(),
    }),
    goalService: () => ({
      getById: vi.fn(),
      getDefaultCompanyGoal: vi.fn(),
    }),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
    }),
    instanceSettingsService: () => ({
      getGeneral: vi.fn(async () => ({})),
      getExperimental: vi.fn(async () => ({})),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      listForIssue: vi.fn(async () => []),
    }),
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
  };
});

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
    // The route accumulates filters as it adds query params; pin the
    // ones this test cares about (the includeRoutineExecutions=true
    // implicit-when-self-assigned contract) instead of enumerating
    // every undefined-valued filter, so a new filter being added to
    // the route doesn't silently break this assertion.
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        status: "todo,in_progress,blocked",
        assigneeAgentId: "agent-1",
        includeRoutineExecutions: true,
      }),
    );
  });
});
