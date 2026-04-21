import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

function registerModuleMocks() {
  const servicesIndexMock = () => ({
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
    feedbackService: () => ({}),
    goalService: () => ({
      getById: vi.fn(),
      getDefaultCompanyGoal: vi.fn(),
    }),
    heartbeatService: () => ({
      wakeup: mockWakeup,
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(),
      listCompanyIds: vi.fn(),
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
  });

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
  vi.doMock("../telemetry.ts", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
  vi.doMock("../services/index.js", servicesIndexMock);
  vi.doMock("../services/index.ts", servicesIndexMock);
  vi.doMock("../routes/issues.js", async () =>
    vi.importActual<typeof import("../routes/issues.ts")>("../routes/issues.ts"),
  );
  vi.doMock("../routes/issues.ts", async () =>
    vi.importActual<typeof import("../routes/issues.ts")>("../routes/issues.ts"),
  );
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/workspace-command-authz.js", async () =>
    vi.importActual<typeof import("../routes/workspace-command-authz.ts")>("../routes/workspace-command-authz.ts"),
  );
  vi.doMock("../routes/workspace-command-authz.ts", async () =>
    vi.importActual<typeof import("../routes/workspace-command-authz.ts")>("../routes/workspace-command-authz.ts"),
  );
  vi.doMock("../routes/issues-checkout-wakeup.js", async () =>
    vi.importActual<typeof import("../routes/issues-checkout-wakeup.ts")>("../routes/issues-checkout-wakeup.ts"),
  );
  vi.doMock("../routes/issues-checkout-wakeup.ts", async () =>
    vi.importActual<typeof import("../routes/issues-checkout-wakeup.ts")>("../routes/issues-checkout-wakeup.ts"),
  );
  vi.doMock("../services/issue-assignment-wakeup.js", async () =>
    vi.importActual<typeof import("../services/issue-assignment-wakeup.ts")>(
      "../services/issue-assignment-wakeup.ts",
    ),
  );
  vi.doMock("../services/issue-assignment-wakeup.ts", async () =>
    vi.importActual<typeof import("../services/issue-assignment-wakeup.ts")>(
      "../services/issue-assignment-wakeup.ts",
    ),
  );
  vi.doMock("../services/issue-execution-policy.js", async () =>
    vi.importActual<typeof import("../services/issue-execution-policy.ts")>("../services/issue-execution-policy.ts"),
  );
  vi.doMock("../services/issue-execution-policy.ts", async () =>
    vi.importActual<typeof import("../services/issue-execution-policy.ts")>("../services/issue-execution-policy.ts"),
  );
  vi.doMock("../middleware/index.js", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/index.ts", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/validate.ts", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/logger.js", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../middleware/logger.ts", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../attachment-types.js", async () =>
    vi.importActual<typeof import("../attachment-types.ts")>("../attachment-types.ts"),
  );
  vi.doMock("../attachment-types.ts", async () =>
    vi.importActual<typeof import("../attachment-types.ts")>("../attachment-types.ts"),
  );
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
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/index.ts");
  vi.doUnmock("../services/issue-assignment-wakeup.js");
  vi.doUnmock("../services/issue-assignment-wakeup.ts");
  vi.doUnmock("../services/issue-execution-policy.js");
  vi.doUnmock("../services/issue-execution-policy.ts");
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
}

let issueRouteImportSeq = 0;

async function createApp() {
  resetIssueRouteModules();
  registerModuleMocks();
  issueRouteImportSeq += 1;
  const routeModulePath = `../routes/issues.ts?issue-dependency-wakeups-routes-${issueRouteImportSeq}`;
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/issues.ts")>,
    import("../middleware/index.ts"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue dependency wakeups in issue routes", () => {
  beforeEach(() => {
    resetIssueRouteModules();
    vi.resetAllMocks();
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  afterEach(() => {
    resetIssueRouteModules();
    vi.resetAllMocks();
  });

  it("wakes dependents when the final blocker transitions to done", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "done",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1", "issue-3"],
      },
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: "issue-2",
            resolvedBlockerIssueId: "issue-1",
          }),
        }),
      );
    });
  });

  it("wakes the parent when all direct children become terminal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "done",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-9",
      childIssueIds: ["child-0", "child-1"],
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-9",
        expect.objectContaining({
          reason: "issue_children_completed",
          payload: expect.objectContaining({
            issueId: "parent-1",
            completedChildIssueId: "child-1",
          }),
        }),
      );
    });
  });
});
