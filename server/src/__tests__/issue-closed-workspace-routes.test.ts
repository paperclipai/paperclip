import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const closedWorkspaceId = "33333333-3333-4333-8333-333333333333";
const nextWorkspaceId = "44444444-4444-4444-8444-444444444444";
const agentId = "22222222-2222-4222-8222-222222222222";

// vi.waitFor's own default budget is 1000ms. A run under CPU contention
// measured a 1471ms wait for a background retry, so every waitFor call in
// this file uses this larger, named budget instead of the default.
const REOPEN_PENDING_WAIT_TIMEOUT_MS = 5_000;

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  checkout: vi.fn(),
  addComment: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
  reopenClosedIsolatedExecutionWorkspaceForIssue: vi.fn(),
  clearReopenPendingConsumptionForUnconsumedReopen: vi.fn(async () => ({ cleared: true })),
  refreshReopenPendingConsumption: vi.fn(async () => ({ refreshed: true })),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerServiceMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    STALE_REOPEN_PENDING_CONSUMPTION_GRACE_MS: 5 * 60 * 1000,
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/projects.js", () => ({
    projectService: () => mockProjectService,
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async () => null),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => mockExecutionWorkspaceService,
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({
      getDefaultCompanyGoal: vi.fn(async () => null),
      getById: vi.fn(async () => null),
    }),
    heartbeatService: () => mockHeartbeatService,
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
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

function makeIssue() {
  return {
    id: issueId,
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    assigneeAgentId: agentId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-1085",
    title: "Closed worktree issue",
    projectId: null,
    executionRunId: null,
    checkoutRunId: null,
    executionWorkspaceId: closedWorkspaceId,
  };
}

function makeClosedWorkspace() {
  return {
    id: closedWorkspaceId,
    name: "PAP-1085-fix-worktree-guard",
    mode: "isolated_workspace",
    status: "archived",
    closedAt: new Date("2026-04-04T17:00:00.000Z"),
  };
}

// A fake-timer advance flushes the microtask queue and every pending timer up
// to the given simulated duration in one deterministic step. A real-clock wait
// (a single setImmediate, or a fixed setTimeout) races the response's
// "finish" listener under CPU load and can resolve before a background retry
// chain schedules its next attempt. Advancing simulated time removes that
// race: it proves nothing fires within the window, independent of how fast
// the machine actually runs.
async function assertNoBackgroundClearWithinRetryWindow() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await vi.advanceTimersByTimeAsync(REOPEN_PENDING_WAIT_TIMEOUT_MS);
  } finally {
    vi.useRealTimers();
  }
  expect(mockExecutionWorkspaceService.clearReopenPendingConsumptionForUnconsumedReopen).not.toHaveBeenCalled();
}

describe.sequential("closed isolated workspace issue routes", () => {
  const routeModules = hoistModuleGraph(registerServiceMocks, async () => {
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    return { issueRoutes, errorHandler };
  });

  function createApp(actor?: Record<string, unknown>) {
    const { issueRoutes, errorHandler } = routeModules.value;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor ?? {
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockExecutionWorkspaceService.getById.mockResolvedValue(makeClosedWorkspace());
    mockExecutionWorkspaceService.refreshReopenPendingConsumption.mockResolvedValue({ refreshed: true });
    // The guard reopens a closed isolated workspace and lets the request
    // continue. The default is a successful reopen.
    mockExecutionWorkspaceService.reopenClosedIsolatedExecutionWorkspaceForIssue.mockResolvedValue({
      ok: true,
      reopened: true,
      workspace: { ...makeClosedWorkspace(), status: "active", closedAt: null },
      generation: 4,
    });
  });

  it("reopens the closed isolated workspace and accepts a new comment", async () => {
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      body: "hello",
    });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hello" });

    expect(mockExecutionWorkspaceService.reopenClosedIsolatedExecutionWorkspaceForIssue).toHaveBeenCalledWith({
      workspaceId: closedWorkspaceId,
      issue: { id: issueId, companyId: "company-1", projectId: null },
      actor: expect.objectContaining({ actorType: "user" }),
    });
    // The closed-workspace dead end is gone: the comment is accepted.
    expect(res.status).toBe(201);
  });

  it("reopens the closed isolated workspace and accepts a comment update", async () => {
    mockIssueService.update.mockResolvedValue({ ...makeIssue(), status: "todo" });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "hello" });

    expect(mockExecutionWorkspaceService.reopenClosedIsolatedExecutionWorkspaceForIssue).toHaveBeenCalledTimes(1);
    // The closed-workspace dead end is gone: the update is accepted.
    expect(res.status).toBe(200);
  });

  it("reopens the closed isolated workspace and accepts a checkout", async () => {
    mockIssueService.checkout.mockResolvedValue({ ...makeIssue(), status: "in_progress" });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(mockExecutionWorkspaceService.reopenClosedIsolatedExecutionWorkspaceForIssue).toHaveBeenCalledTimes(1);
    // The closed-workspace dead end is gone: the checkout is accepted.
    expect(res.status).toBe(200);
  });

  it("returns 409 and blocks the comment when the workspace cannot be reopened", async () => {
    mockExecutionWorkspaceService.reopenClosedIsolatedExecutionWorkspaceForIssue.mockResolvedValue({
      ok: false,
      code: "not_reopenable",
      message: "Execution workspace is not reopenable",
    });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hello" });

    expect(res.status).toBe(409);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("returns 503 and blocks the checkout when the rebuild fails", async () => {
    mockExecutionWorkspaceService.reopenClosedIsolatedExecutionWorkspaceForIssue.mockResolvedValue({
      ok: false,
      code: "rebuild_failed",
      message: "Failed to rebuild the execution workspace",
    });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(503);
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("does not reopen the workspace when a checkout fails the run-id gate", async () => {
    // An agent checkout without a run id is rejected before the reopen runs. The
    // reopen must not rebuild and republish the workspace, or the still-terminal
    // issue keeps a leaked active workspace that the reaper skips.
    const agentActorWithoutRunId = {
      type: "agent",
      agentId,
      companyId: "company-1",
      runId: null,
      source: "agent_key",
    };

    const res = await request(createApp(agentActorWithoutRunId))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(401);
    expect(
      mockExecutionWorkspaceService.reopenClosedIsolatedExecutionWorkspaceForIssue,
    ).not.toHaveBeenCalled();
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  it("clears the reopen-pending flag when the comment update returns null after a reopen", async () => {
    // The workspace reopens, but the issue update then returns null. The issue
    // stays terminal, so the guard must clear the reopen-pending flag. Otherwise
    // the terminal reaper and the archive route skip the rebuilt worktree forever.
    mockIssueService.getById.mockResolvedValue({ ...makeIssue(), status: "done" });
    mockIssueService.update.mockResolvedValue(null);

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "hello" });

    expect(res.status).toBe(404);
    await vi.waitFor(() => {
      expect(
        mockExecutionWorkspaceService.clearReopenPendingConsumptionForUnconsumedReopen,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: closedWorkspaceId,
          issue: expect.objectContaining({ id: issueId }),
          expectedGeneration: 4,
        }),
      );
    }, { timeout: REOPEN_PENDING_WAIT_TIMEOUT_MS });
  });

  it("clears the reopen-pending flag when the checkout throws after a reopen", async () => {
    mockIssueService.getById.mockResolvedValue({ ...makeIssue(), status: "done" });
    mockIssueService.checkout.mockRejectedValue(new Error("checkout failed"));

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(500);
    await vi.waitFor(() => {
      expect(
        mockExecutionWorkspaceService.clearReopenPendingConsumptionForUnconsumedReopen,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: closedWorkspaceId,
          issue: expect.objectContaining({ id: issueId }),
          expectedGeneration: 4,
        }),
      );
    }, { timeout: REOPEN_PENDING_WAIT_TIMEOUT_MS });
  });

  it("does not clear the reopen-pending flag when the checkout resumes the issue", async () => {
    // The checkout moves the issue out of the terminal state, so the reaper clears
    // the flag on its next cycle. The route must not clear it here.
    mockIssueService.getById.mockResolvedValue({ ...makeIssue(), status: "done" });
    mockIssueService.checkout.mockResolvedValue({ ...makeIssue(), status: "in_progress" });

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(200);
    await assertNoBackgroundClearWithinRetryWindow();
  });

  it("does not clear the reopen-pending flag when a concurrent request already reopened the workspace", async () => {
    // A concurrent request reopened the workspace first, so this request receives
    // reopened: false and never set the flag. Even though the checkout leaves the
    // issue terminal, this request must not clear the flag that the other request
    // owns. Otherwise the reaper or the archive route can destroy the rebuilt
    // worktree while the other request still uses it.
    mockIssueService.getById.mockResolvedValue({ ...makeIssue(), status: "done" });
    mockExecutionWorkspaceService.reopenClosedIsolatedExecutionWorkspaceForIssue.mockResolvedValue({
      ok: true,
      reopened: false,
      workspace: { ...makeClosedWorkspace(), status: "active", closedAt: null },
      generation: 4,
    });
    mockIssueService.checkout.mockResolvedValue(null);

    const res = await request(createApp())
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(200);
    await assertNoBackgroundClearWithinRetryWindow();
  });

  it("retries the reopen-pending clear when the first attempt fails transiently", async () => {
    // The workspace reopens, but the comment update returns null, so the issue
    // stays terminal and the guard must clear the flag. A transient failure of the
    // first clear must not strand the flag; the guard retries until it succeeds.
    mockIssueService.getById.mockResolvedValue({ ...makeIssue(), status: "done" });
    mockIssueService.update.mockResolvedValue(null);
    mockExecutionWorkspaceService.clearReopenPendingConsumptionForUnconsumedReopen
      .mockRejectedValueOnce(new Error("transient database error"))
      .mockResolvedValue({ cleared: true });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "hello" });

    expect(res.status).toBe(404);
    await vi.waitFor(() => {
      expect(
        mockExecutionWorkspaceService.clearReopenPendingConsumptionForUnconsumedReopen.mock.calls.length,
      ).toBeGreaterThanOrEqual(2);
    }, { timeout: REOPEN_PENDING_WAIT_TIMEOUT_MS });
  });

  it("still allows non-comment board updates so the issue can be moved to a new workspace", async () => {
    mockIssueService.update.mockResolvedValue({
      ...makeIssue(),
      executionWorkspaceId: nextWorkspaceId,
    });

    const res = await request(createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ executionWorkspaceId: nextWorkspaceId });

    expect(res.status).toBe(200);
    expect(res.body.executionWorkspaceId).toBe(nextWorkspaceId);
  });
});
