import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));
const agentId = "22222222-2222-4222-8222-222222222222";

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
    issueRecoveryActionService: () => ({
      listActiveForIssues: vi.fn(async () => new Map()),
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
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(async () => []),
        })),
      })),
    })),
  };
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", issueRoutes(db as any, {} as any));
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
      .query({ assigneeAgentId: agentId, status: "todo,in_progress,blocked" });

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
        assigneeAgentId: agentId,
        includeRoutineExecutions: true,
      }),
    );
  });

  it("returns 200 for a large project-filtered backlog list that excludes routine executions", async () => {
    const app = createApp();
    const largeProjectIssues = Array.from({ length: 1000 }, (_, index) => ({
      id: `issue-${index}`,
      companyId: "company-1",
      projectId: "project-large",
      title: `Backlog issue ${index}`,
      description: null,
      status: "backlog",
      priority: "medium",
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      lastActivityAt: new Date("2026-06-01T00:00:00.000Z"),
      labels: [],
      labelIds: [],
      activeRun: null,
    }));
    mockIssueService.list.mockResolvedValueOnce(largeProjectIssues);

    const res = await request(app)
      .get("/api/companies/company-1/issues")
      .query({
        status: "backlog",
        projectId: "project-large",
        includeRoutineExecutions: "false",
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1000);
    expect(res.body[0]).toMatchObject({
      id: "issue-0",
      projectId: "project-large",
      status: "backlog",
    });
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        status: "backlog",
        projectId: "project-large",
        includeRoutineExecutions: false,
      }),
    );
  });
});
