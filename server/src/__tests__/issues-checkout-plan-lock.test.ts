import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const parentIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const agentId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const interactionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const mockIssueService = vi.hoisted(() => ({
  checkout: vi.fn(),
  getAncestors: vi.fn(),
  getById: vi.fn(),
}));

const mockInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  hasPendingPlanConfirmationOnAnyIssue: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => false),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      list: vi.fn(async () => []),
      resolveByReference: vi.fn(async () => ({ ambiguous: false, agent: null })),
    }),
    clampIssueListLimit: (v: number) => v,
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    ISSUE_LIST_MAX_LIMIT: 1000,
    companyService: () => ({
      getById: vi.fn(async () => ({ id: companyId, issuePrefix: "TST" })),
    }),
    documentService: () => ({}),
    environmentService: () => ({}),
    executionWorkspaceService: () => ({ getById: vi.fn(async () => null) }),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({
      getById: vi.fn(async () => null),
    }),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({ getById: vi.fn(async () => null) }),
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: agentId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "TST-42",
    title: "A task",
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    hiddenAt: null,
    checkoutRunId: null,
    ...overrides,
  };
}

async function createApp() {
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
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("checkout plan lock (§3.5 Option A)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    // Default: issue found, no ancestors, checkout succeeds
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.checkout.mockResolvedValue(makeIssue({ checkoutRunId: "run-1" }));
    mockInteractionService.hasPendingPlanConfirmationOnAnyIssue.mockResolvedValue(null);
  });

  it("allows checkout when issue has no ancestors", async () => {
    mockIssueService.getAncestors.mockResolvedValue([]);

    const app = await createApp();
    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo", "in_progress"] });

    expect(res.status).toBe(200);
    expect(mockInteractionService.hasPendingPlanConfirmationOnAnyIssue).not.toHaveBeenCalled();
  });

  it("allows checkout when ancestors have no pending plan confirmation", async () => {
    mockIssueService.getAncestors.mockResolvedValue([
      { id: parentIssueId, identifier: "TST-10", title: "Parent" },
    ]);
    mockInteractionService.hasPendingPlanConfirmationOnAnyIssue.mockResolvedValue(null);

    const app = await createApp();
    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo", "in_progress"] });

    expect(res.status).toBe(200);
    expect(mockInteractionService.hasPendingPlanConfirmationOnAnyIssue).toHaveBeenCalledWith(
      [parentIssueId],
      companyId,
    );
  });

  it("returns 423 when an ancestor has a pending plan confirmation", async () => {
    mockIssueService.getAncestors.mockResolvedValue([
      { id: parentIssueId, identifier: "TST-10", title: "Parent" },
    ]);
    mockInteractionService.hasPendingPlanConfirmationOnAnyIssue.mockResolvedValue({
      id: interactionId,
      issueId: parentIssueId,
    });

    const app = await createApp();
    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo", "in_progress"] });

    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("pending plan confirmation"),
      lockedByIssueId: parentIssueId,
      interactionId,
    });
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("does not check ancestors when the issue itself is the root (no ancestors)", async () => {
    // Issue without parent — getAncestors returns []
    mockIssueService.getById.mockResolvedValue(makeIssue({ parentId: null }));
    mockIssueService.getAncestors.mockResolvedValue([]);

    const app = await createApp();
    const res = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo", "in_progress"] });

    expect(res.status).toBe(200);
    expect(mockIssueService.checkout).toHaveBeenCalled();
  });
});
