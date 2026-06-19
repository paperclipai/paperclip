import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";
const peerRunId = "66666666-6666-4666-8666-666666666666";
const linkedIssueId = "88888888-8888-4888-8888-888888888888";
const commentId = "77777777-7777-4777-8777-777777777777";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  findCrossAssigneeEvidenceLink: vi.fn(),
  findMentionedAgents: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  list: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  update: vi.fn(),
  wasAgentMentionedOnIssue: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
  resolveActiveForIssue: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerRouteMocks() {
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

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    ISSUE_LIST_DEFAULT_LIMIT: 100,
    ISSUE_LIST_MAX_LIMIT: 500,
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    clampIssueListLimit: (value: number) => Math.min(Math.max(value, 1), 500),
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
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
    issueRecoveryActionService: () => mockIssueRecoveryActionService,
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
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1700",
    title: "Owned issue awaiting evidence",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function makeAgent(id: string) {
  return {
    id,
    companyId,
    role: "engineer",
    reportsTo: null,
    permissions: { canCreateAgents: false },
  };
}

function createRunContextDb() {
  const buildQuery = () => {
    const whereResult = {
      orderBy: vi.fn(async () => []),
      then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
    };
    const query = {
      innerJoin: vi.fn(() => query),
      where: vi.fn(() => whereResult),
    };
    return query;
  };
  return {
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
    select: vi.fn(() => ({
      from: vi.fn(() => buildQuery()),
    })),
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(createRunContextDb() as any, {} as any));
  app.use(errorHandler);
  return app;
}

function peerActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: peerAgentId,
    companyId,
    source: "agent_key",
    runId: peerRunId,
    ...overrides,
  };
}

describe("cross-assignee evidence comments", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();

    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: input.action === "issue:mutate" || input.action === "issue:read",
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test default.",
    }));
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === ownerAgentId) return makeAgent(ownerAgentId);
      if (id === peerAgentId) return makeAgent(peerAgentId);
      return null;
    });
    mockAgentService.list.mockResolvedValue([makeAgent(ownerAgentId), makeAgent(peerAgentId)]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "PAP" });

    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findCrossAssigneeEvidenceLink.mockResolvedValue(null);
    mockIssueService.wasAgentMentionedOnIssue.mockResolvedValue(false);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId,
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
    });
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: commentId,
      issueId,
      companyId,
      body: "evidence",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: peerAgentId,
      authorUserId: null,
    });

    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("allows a peer agent with a linked checked-out issue to append an evidence comment", async () => {
    mockIssueService.findCrossAssigneeEvidenceLink.mockResolvedValue({ viaIssueId: linkedIssueId });

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "evidence from my linked checkout" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.findCrossAssigneeEvidenceLink).toHaveBeenCalledWith({
      companyId,
      actorAgentId: peerAgentId,
      actorRunId: peerRunId,
      targetIssueId: issueId,
      targetParentId: null,
    });
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "evidence from my linked checkout",
      expect.objectContaining({ agentId: peerAgentId, runId: peerRunId }),
      expect.objectContaining({
        metadata: {
          version: 1,
          crossAssignee: { trigger: "linked_checkout", viaIssueId: linkedIssueId },
        },
      }),
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        agentId: peerAgentId,
        runId: peerRunId,
        details: expect.objectContaining({
          crossAssignee: true,
          crossAssigneeTrigger: "linked_checkout",
          crossAssigneeViaIssueId: linkedIssueId,
        }),
      }),
    );
  });

  it("allows a peer agent mentioned on the target issue to append an evidence comment", async () => {
    mockIssueService.wasAgentMentionedOnIssue.mockResolvedValue(true);

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "responding to the mention" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.wasAgentMentionedOnIssue).toHaveBeenCalledWith(issueId, peerAgentId);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "responding to the mention",
      expect.any(Object),
      expect.objectContaining({
        metadata: {
          version: 1,
          crossAssignee: { trigger: "mention", viaIssueId: null },
        },
      }),
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("keeps rejecting peer comments without a link or mention on an active checkout", async () => {
    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "no relationship to this issue" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("keeps rejecting peer comments without a link or mention on a todo issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "todo" }));

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "no relationship to this issue" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("does not grant cross-assignee access when the authorization boundary denies the issue", async () => {
    mockIssueService.findCrossAssigneeEvidenceLink.mockResolvedValue({ viaIssueId: linkedIssueId });
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_missing_grant",
      explanation: "Denied by test.",
    }));

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "outside my boundary" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("does not reopen a done issue from a cross-assignee comment, even with reopen/resume intents", async () => {
    // Regression (R1): effectiveMoveToTodoRequested must stay false for
    // cross-assignee comments — a cross-assignee comment on a done issue
    // must append only, never move the issue back to todo.
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "done" }));
    mockIssueService.findCrossAssigneeEvidenceLink.mockResolvedValue({ viaIssueId: linkedIssueId });

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "late evidence on a closed issue", reopen: true, resume: true });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "late evidence on a closed issue",
      expect.any(Object),
      expect.objectContaining({
        metadata: expect.objectContaining({
          crossAssignee: { trigger: "linked_checkout", viaIssueId: linkedIssueId },
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          suppressedCrossAssigneeIntents: ["reopen", "resume"],
        }),
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
      }),
    );
    // Flush the async wake dispatch before asserting no wake happened.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("suppresses interrupt intents on cross-assignee comments instead of cancelling runs", async () => {
    mockIssueService.findCrossAssigneeEvidenceLink.mockResolvedValue({ viaIssueId: linkedIssueId });

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "evidence with stray interrupt flag", interrupt: true });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          suppressedCrossAssigneeIntents: ["interrupt"],
        }),
      }),
    );
  });

  it("wakes the assignee for cross-assignee evidence comments on open issues", async () => {
    mockIssueService.findCrossAssigneeEvidenceLink.mockResolvedValue({ viaIssueId: linkedIssueId });

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "evidence for the assignee" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await vi.waitFor(() => {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        ownerAgentId,
        expect.objectContaining({ reason: "issue_commented" }),
      );
    });
  });

  it("leaves the assignee's own comment path untouched", async () => {
    const res = await request(await createApp(peerActor({ agentId: ownerAgentId, runId: peerRunId })))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "owner status update" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.findCrossAssigneeEvidenceLink).not.toHaveBeenCalled();
    expect(mockIssueService.wasAgentMentionedOnIssue).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "owner status update",
      expect.any(Object),
      expect.objectContaining({ metadata: null }),
    );
  });
});
