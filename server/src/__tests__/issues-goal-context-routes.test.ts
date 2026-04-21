import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getAncestors: vi.fn(),
  getRelationSummaries: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getCommentCursor: vi.fn(),
  getComment: vi.fn(),
  listAttachments: vi.fn(),
  listChecklistItems: vi.fn(),
  listLinks: vi.fn(),
  listCoverAttachmentsForIssues: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
  listByIds: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
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
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => mockGoalService,
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
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
    issueService: () => mockIssueService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => mockProjectService,
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({
      listForIssue: vi.fn(async () => []),
    }),
  });
  vi.doMock("../services/index.js", servicesIndexMock);
  vi.doMock("../services/index.ts", servicesIndexMock);
}

function resetIssueRouteModules() {
  vi.resetModules();
  vi.doUnmock("@paperclipai/shared/telemetry");
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
  vi.doUnmock("../attachment-types.js");
  vi.doUnmock("../attachment-types.ts");
}

function registerRouteActuals() {
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.js")>("../routes/authz.js"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.js")>("../routes/authz.js"),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.js")>("../middleware/validate.js"),
  );
  vi.doMock("../middleware/validate.ts", async () =>
    vi.importActual<typeof import("../middleware/validate.js")>("../middleware/validate.js"),
  );
}

async function createApp() {
  resetIssueRouteModules();
  registerRouteActuals();
  registerModuleMocks();
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
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

const legacyProjectLinkedIssue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  identifier: "PAP-581",
  title: "Legacy onboarding task",
  description: "Seed the first CEO task",
  status: "todo",
  priority: "medium",
  projectId: "22222222-2222-4222-8222-222222222222",
  goalId: null,
  parentId: null,
  assigneeAgentId: "33333333-3333-4333-8333-333333333333",
  assigneeUserId: null,
  updatedAt: new Date("2026-03-24T12:00:00Z"),
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
};

const projectGoal = {
  id: "44444444-4444-4444-8444-444444444444",
  companyId: "company-1",
  title: "Launch the company",
  description: null,
  level: "company",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-03-20T00:00:00Z"),
  updatedAt: new Date("2026-03-20T00:00:00Z"),
};

const companyGoal = {
  id: "66666666-6666-4666-8666-666666666666",
  companyId: "company-1",
  title: "Keep home network changes safe and reversible",
  description: null,
  level: "company",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-03-18T00:00:00Z"),
  updatedAt: new Date("2026-03-18T00:00:00Z"),
};

describe("issue goal context routes", () => {
  beforeEach(() => {
    resetIssueRouteModules();
    registerRouteActuals();
    registerModuleMocks();
    vi.resetAllMocks();
    mockIssueService.getById.mockResolvedValue(legacyProjectLinkedIssue);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.listChecklistItems.mockResolvedValue([]);
    mockIssueService.listLinks.mockResolvedValue([]);
    mockIssueService.listCoverAttachmentsForIssues.mockResolvedValue(new Map());
    mockProjectService.getById.mockResolvedValue({
      id: legacyProjectLinkedIssue.projectId,
      companyId: "company-1",
      urlKey: "onboarding",
      goalId: projectGoal.id,
      goalIds: [projectGoal.id],
      goals: [{ id: projectGoal.id, title: projectGoal.title }],
      name: "Onboarding",
      description: null,
      status: "in_progress",
      leadAgentId: null,
      targetDate: null,
      color: null,
      pauseReason: null,
      pausedAt: null,
      executionWorkspacePolicy: null,
      codebase: {
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
        defaultRef: null,
        repoName: null,
        localFolder: null,
        managedFolder: "/tmp/company-1/project-1",
        effectiveLocalFolder: "/tmp/company-1/project-1",
        origin: "managed_checkout",
      },
      workspaces: [],
      primaryWorkspace: null,
      archivedAt: null,
      createdAt: new Date("2026-03-20T00:00:00Z"),
      updatedAt: new Date("2026-03-20T00:00:00Z"),
    });
    mockProjectService.listByIds.mockResolvedValue([]);
    mockGoalService.getById.mockImplementation(async (id: string) =>
      id === projectGoal.id ? projectGoal : null,
    );
    mockGoalService.getDefaultCompanyGoal.mockResolvedValue(companyGoal);
  });

  it("surfaces project goals and the company goal from GET /issues/:id", async () => {
    const res = await request(await createApp()).get("/api/issues/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.goalId).toBe(projectGoal.id);
    expect(res.body.goal).toEqual(
      expect.objectContaining({
        id: projectGoal.id,
        title: projectGoal.title,
      }),
    );
    expect(res.body.projectGoals).toEqual([
      expect.objectContaining({
        id: projectGoal.id,
        title: projectGoal.title,
      }),
    ]);
    expect(res.body.companyGoal).toEqual(
      expect.objectContaining({
        id: companyGoal.id,
        title: companyGoal.title,
      }),
    );
    expect(res.body.checklistItems).toEqual([]);
    expect(res.body.links).toEqual([]);
    expect(res.body.coverAttachment).toBeNull();
  });

  it("surfaces project goals and company goal from GET /issues/:id/heartbeat-context", async () => {
    const res = await request(await createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.issue.goalId).toBe(projectGoal.id);
    expect(res.body.issue.checklistItems).toEqual([]);
    expect(res.body.issue.links).toEqual([]);
    expect(res.body.issue.coverAttachment).toBeNull();
    expect(res.body.goal).toEqual(
      expect.objectContaining({
        id: projectGoal.id,
        title: projectGoal.title,
      }),
    );
    expect(res.body.projectGoals).toEqual([
      expect.objectContaining({
        id: projectGoal.id,
        title: projectGoal.title,
      }),
    ]);
    expect(res.body.companyGoal).toEqual(
      expect.objectContaining({
        id: companyGoal.id,
        title: companyGoal.title,
      }),
    );
    expect(res.body.attachments).toEqual([]);
  });

  it("surfaces blocker summaries on GET /issues/:id/heartbeat-context", async () => {
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          identifier: "PAP-580",
          title: "Finish wakeup plumbing",
          status: "done",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
      blocks: [],
    });

    const res = await request(await createApp()).get(
      "/api/issues/11111111-1111-4111-8111-111111111111/heartbeat-context",
    );

    expect(res.status).toBe(200);
    expect(res.body.issue.blockedBy).toEqual([
      expect.objectContaining({
        id: "55555555-5555-4555-8555-555555555555",
        identifier: "PAP-580",
      }),
    ]);
  });
});
