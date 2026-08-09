import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const closedWorkspaceId = "33333333-3333-4333-8333-333333333333";
const nextWorkspaceId = "44444444-4444-4444-8444-444444444444";
const agentId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  checkout: vi.fn(),
  addComment: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  // TECH-4930 stage 2: routes/issues.ts now also calls `access.decide` with
  // action "agent:wake" from the comment route and from checkout-when-
  // already-assignee, to run the (default-off) agent-ownership enforcement
  // check. Default to an unconditional allow so this file's existing
  // scenarios -- none of which are about ownership enforcement -- stay
  // byte-identical to before that call existed.
  decide: vi.fn(async (input: { action?: string }) => ({
    allowed: true,
    action: input.action,
    reason: "allow_test",
    explanation: "Allowed by test mock.",
  })),
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
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
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

describe.sequential("closed isolated workspace issue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/execution-workspaces.js");
    vi.doUnmock("../services/heartbeat.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/projects.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerServiceMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockExecutionWorkspaceService.getById.mockResolvedValue(makeClosedWorkspace());
  });

  it("rejects new issue comments when the linked isolated workspace is closed", async () => {
    const res = await request(await createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hello" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("closed workspace");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects comment updates when the linked isolated workspace is closed", async () => {
    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "hello" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("closed workspace");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("rejects checkout when the linked isolated workspace is closed", async () => {
    const res = await request(await createApp())
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("closed workspace");
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
  });

  // TECH-4930 stage 2, path 1 of 6: the comment route previously called
  // `addWakeup(assigneeId, ...)` unconditionally for a board actor
  // commenting on an agent-assigned issue -- `assertAgentIssueCommentAllowed`
  // short-circuited to `true` for any non-agent actor. This pins the new
  // "agent:wake" gate added at the top of that function: `decide` denies
  // specifically the assignee's wake, and the comment must never reach
  // `addComment`. Reverting that gate (or the shared enforcement layer in
  // authorization.ts it calls in production) makes this fall through to a
  // 200/201.
  it("blocks new issue comments when agent-ownership enforcement denies the assignee", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action?: string; resource?: { agentId?: string } }) => {
      if (input.action === "agent:wake") {
        return {
          allowed: false,
          action: "agent:wake",
          reason: "deny_agent_ownership_required",
          code: "AGENT_OWNERSHIP_REQUIRED",
          explanation: `Principal has no active ownership grant on agent ${input.resource?.agentId}.`,
        };
      }
      return { allowed: true, action: input.action, reason: "allow_test", explanation: "Allowed by test mock." };
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);

    const res = await request(await createApp())
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hello" });

    expect(res.status).toBe(403);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockAccessService.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent:wake",
        resource: expect.objectContaining({ type: "agent", agentId }),
      }),
    );
  });

  // TECH-4930 stage 2, path 3 of 6: checkout's `assertCanAssignTasks` call is
  // inside `if (issue.assigneeAgentId !== req.body.agentId)`, so it is
  // skipped in exactly the case where the agent already holds the issue --
  // this fixture's issue is already assigned to `agentId`, and the checkout
  // body below re-checks out that same agent, landing in the `else` branch
  // this ticket added the ownership gate to. Reverting that gate makes this
  // fall through to a successful checkout.
  it("blocks checkout when agent-ownership enforcement denies the already-assigned agent", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action?: string; resource?: { agentId?: string } }) => {
      if (input.action === "agent:wake") {
        return {
          allowed: false,
          action: "agent:wake",
          reason: "deny_agent_ownership_required",
          code: "AGENT_OWNERSHIP_REQUIRED",
          explanation: `Principal has no active ownership grant on agent ${input.resource?.agentId}.`,
        };
      }
      return { allowed: true, action: input.action, reason: "allow_test", explanation: "Allowed by test mock." };
    });
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);

    const res = await request(await createApp())
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
    expect(mockAccessService.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent:wake",
        resource: expect.objectContaining({ type: "agent", agentId }),
      }),
    );
  });

  it("still allows non-comment board updates so the issue can be moved to a new workspace", async () => {
    mockIssueService.update.mockResolvedValue({
      ...makeIssue(),
      executionWorkspaceId: nextWorkspaceId,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${issueId}`)
      .send({ executionWorkspaceId: nextWorkspaceId });

    expect(res.status).toBe(200);
    expect(res.body.executionWorkspaceId).toBe(nextWorkspaceId);
  });
});
