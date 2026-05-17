import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCloseExecutionWorkspace = vi.hoisted(() => vi.fn());
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(async () => []),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(async () => null),
  getCommentCursor: vi.fn(async () => ({
    totalComments: 0,
    latestCommentId: null,
    latestCommentAt: null,
  })),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  update: vi.fn(),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

function registerMocks() {
  vi.doMock("../services/execution-workspace-closeout.js", () => ({
    closeExecutionWorkspace: mockCloseExecutionWorkspace,
  }));
  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => mockExecutionWorkspaceService,
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(),
      hasPermission: vi.fn(),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
    }),
    documentService: () => ({
      getIssueDocumentPayload: vi.fn(async () => ({})),
    }),
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    feedbackService: () => ({}),
    goalService: () => ({
      getById: vi.fn(async () => null),
      getDefaultCompanyGoal: vi.fn(async () => null),
    }),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(),
      listCompanyIds: vi.fn(),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      syncIssue: vi.fn(async () => undefined),
      syncComment: vi.fn(async () => undefined),
      listIssueReferenceSummary: vi.fn(async () => ({
        outbound: [],
        inbound: [],
      })),
      diffIssueReferenceSummary: vi.fn(() => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      })),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => ({
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
      listForIssue: vi.fn(async () => []),
    }),
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
}

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
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

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-1201",
    title: "Close workspace on done",
    description: null,
    status: "in_progress",
    priority: "medium",
    parentId: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    executionWorkspaceId: "workspace-1",
    labels: [],
    labelIds: [],
    ...overrides,
  };
}

function makeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    sourceIssueId: "issue-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Feature workspace",
    status: "active",
    cwd: "/tmp/paperclip-worktree",
    repoUrl: null,
    baseRef: "main",
    branchName: "pap-1201-close-workspace",
    providerType: "git_worktree",
    providerRef: "/tmp/paperclip-worktree",
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-04-25T15:00:00.000Z"),
    openedAt: new Date("2026-04-25T15:00:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    runtimeServices: [],
    createdAt: new Date("2026-04-25T15:00:00.000Z"),
    updatedAt: new Date("2026-04-25T15:00:00.000Z"),
    ...overrides,
  };
}

describe("issue workspace closeout routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/execution-workspace-closeout.js");
    vi.doUnmock("../services/execution-workspaces.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerMocks();
    vi.resetAllMocks();
  });

  it("returns an explicit blocked closeout result when automatic issue completion cleanup is unsafe", async () => {
    const existingIssue = makeIssue();
    const completedIssue = makeIssue({ status: "done" });
    const openWorkspace = makeWorkspace();

    mockIssueService.getById.mockResolvedValue(existingIssue);
    mockIssueService.update.mockResolvedValue(completedIssue);
    mockExecutionWorkspaceService.getById.mockResolvedValue(openWorkspace);
    mockCloseExecutionWorkspace.mockResolvedValue({
      outcome: "blocked",
      workspace: openWorkspace,
      closeReadiness: {
        workspaceId: openWorkspace.id,
        state: "ready_with_warnings",
        blockingReasons: [],
        warnings: ["This workspace is 1 commit ahead of main and is not merged."],
        linkedIssues: [],
        plannedActions: [{ kind: "git_worktree_remove" }],
        isDestructiveCloseAllowed: true,
        isSharedWorkspace: false,
        isProjectPrimaryWorkspace: false,
        git: {
          workspacePath: openWorkspace.cwd,
          branchName: openWorkspace.branchName,
          baseRef: "main",
          hasDirtyTrackedFiles: false,
          hasUntrackedFiles: true,
          dirtyEntryCount: 0,
          untrackedEntryCount: 1,
          aheadCount: 1,
          behindCount: 0,
          isMergedIntoBase: false,
          createdByRuntime: true,
          repoRoot: "/tmp/paperclip",
        },
        runtimeServices: [],
      },
      cleanupWarnings: [],
      blockingReasons: [
        "Automatic issue-completion closeout skipped because this workspace is not merged into main.",
      ],
      failureReason: null,
    });

    const res = await request(await createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.executionWorkspaceId).toBe("workspace-1");
    expect(res.body.executionWorkspaceCloseout).toMatchObject({
      outcome: "blocked",
      blockingReasons: [
        "Automatic issue-completion closeout skipped because this workspace is not merged into main.",
      ],
    });
    expect(mockCloseExecutionWorkspace).toHaveBeenCalledWith(expect.anything(), {
      executionWorkspaceId: "workspace-1",
      mode: "issue_completion",
    });
  });

  it("refreshes the issue response after shared session closeout detaches the workspace id", async () => {
    const existingIssue = makeIssue();
    const completedIssue = makeIssue({ status: "done" });
    const detachedIssue = makeIssue({ status: "done", executionWorkspaceId: null });
    const openWorkspace = makeWorkspace({
      mode: "shared_workspace",
      strategyType: "project_primary",
      providerType: "local_fs",
      providerRef: null,
      cwd: "/tmp/project-primary",
      branchName: null,
      baseRef: null,
    });
    const archivedWorkspace = {
      ...openWorkspace,
      status: "archived",
      closedAt: new Date("2026-04-25T15:30:00.000Z"),
    };

    mockIssueService.getById
      .mockResolvedValueOnce(existingIssue)
      .mockResolvedValueOnce(detachedIssue);
    mockIssueService.update.mockResolvedValue(completedIssue);
    mockExecutionWorkspaceService.getById.mockResolvedValue(openWorkspace);
    mockCloseExecutionWorkspace.mockResolvedValue({
      outcome: "archived",
      workspace: archivedWorkspace,
      closeReadiness: {
        workspaceId: archivedWorkspace.id,
        state: "ready",
        blockingReasons: [],
        warnings: [],
        linkedIssues: [],
        plannedActions: [{ kind: "archive_record" }],
        isDestructiveCloseAllowed: true,
        isSharedWorkspace: true,
        isProjectPrimaryWorkspace: true,
        git: null,
        runtimeServices: [],
      },
      cleanupWarnings: [],
      blockingReasons: [],
      failureReason: null,
    });

    const res = await request(await createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
    expect(res.body.executionWorkspaceId).toBeNull();
    expect(res.body.executionWorkspaceCloseout).toMatchObject({
      outcome: "archived",
      workspace: {
        id: "workspace-1",
        status: "archived",
      },
    });
    expect(mockIssueService.getById).toHaveBeenCalledTimes(2);
  });
});
