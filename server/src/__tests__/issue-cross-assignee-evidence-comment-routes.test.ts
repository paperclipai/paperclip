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
const workspaceId = "99999999-9999-4999-8999-999999999999";

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

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  reopenClosedIsolatedExecutionWorkspaceForIssue: vi.fn(async () => ({
    ok: true,
    reopened: true,
    generation: 1,
  })),
  clearReopenPendingForIssue: vi.fn(async () => undefined),
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

const mockIssueTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
}));

const mockRunnerGoalService = vi.hoisted(() => ({
  projection: vi.fn(async () => null),
  act: vi.fn(),
}));

const mockExternalObjectService = vi.hoisted(() => ({
  syncCommentSafely: vi.fn(async () => undefined),
  syncIssueSafely: vi.fn(async () => undefined),
}));

const mockObserveCrossIssueInfluence = vi.hoisted(() =>
  vi.fn(async () => ({
    allowed: true,
    mode: "log_only",
    count: 1,
    cap: 20,
    enforceAt: "2026-08-11T00:00:00.000Z",
  })),
);
const mockCrossIssueInfluenceLimitError = vi.hoisted(() =>
  vi.fn((decision: { count: number; cap: number }) => ({
    error: `Cross-issue influence cap exceeded: this run is limited to ${decision.cap} cross-issue comments or updates`,
    details: {
      code: "cross_issue_influence_cap_exceeded",
      count: decision.count,
      cap: decision.cap,
    },
  })),
);
const mockCrossIssueInfluenceRunContextError = vi.hoisted(() =>
  vi.fn(
    () =>
      new Error(
        "Agent issue comments and updates require a valid heartbeat run so cross-issue influence can be contained",
      ),
  ),
);

function registerRouteMocks() {
  vi.doMock("../services/runner-goals.js", () => ({
    runnerGoalService: () => mockRunnerGoalService,
  }));

  vi.doMock("../services/queued-interaction-response.js", () => ({
    hasQueuedInteractionResponse: vi.fn(async () => false),
  }));

  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => mockExternalObjectService,
  }));

  vi.doMock("../services/cross-issue-influence-limit.js", () => ({
    observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
    crossIssueInfluenceLimitError: mockCrossIssueInfluenceLimitError,
    crossIssueInfluenceRunContextError: mockCrossIssueInfluenceRunContextError,
  }));
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
    companySkillService: () => ({
      listRuntimeSkillEntries: vi.fn(),
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => mockExecutionWorkspaceService,
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
    issueTreeControlService: () => mockIssueTreeControlService,
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
    executionWorkspaceId: null,
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

/**
 * Mirror master's `issue:comment` decision for a standard-trust agent: the
 * assignee is allowed as itself, everyone else is default-opened on a visible
 * issue (`allow_visible_issue_write`) unless a test overrides the reason.
 */
function allowPeerComments(reason = "allow_visible_issue_write") {
  mockAccessService.decide.mockImplementation(async (input: {
    action: string;
    actor?: { agentId?: string | null };
    resource?: { assigneeAgentId?: string | null };
  }) => {
    if (input.action === "issue:comment") {
      const assigneeAgentId = input.resource?.assigneeAgentId ?? null;
      const self = !assigneeAgentId || assigneeAgentId === input.actor?.agentId;
      return {
        allowed: true,
        action: input.action,
        reason: self ? "allow_self" : reason,
        explanation: "Allowed by test default.",
      };
    }
    return {
      allowed: input.action === "issue:mutate" || input.action === "issue:read",
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test default.",
    };
  });
}

function denyPeerComments() {
  mockAccessService.decide.mockImplementation(async (input: {
    action: string;
    actor?: { agentId?: string | null };
    resource?: { assigneeAgentId?: string | null };
  }) => {
    if (input.action === "issue:comment") {
      const assigneeAgentId = input.resource?.assigneeAgentId ?? null;
      const allowed = !assigneeAgentId || assigneeAgentId === input.actor?.agentId;
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_self" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test default." : "Denied by test default.",
      };
    }
    return {
      allowed: input.action === "issue:mutate" || input.action === "issue:read",
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test default.",
    };
  });
}

function crossAssigneeMetadata(
  trigger: "linked_checkout" | "mention" | "visible_issue",
  viaIssueId: string | null,
) {
  return {
    version: 1,
    crossAssignee: { trigger, viaIssueId },
    sections: [
      {
        title: "Cross-assignee evidence",
        rows: [
          { type: "key_value", label: "Trigger", value: trigger },
          ...(viaIssueId
            ? [{ type: "issue_link", label: "Evidence from", issueId: viaIssueId }]
            : []),
        ],
      },
    ],
  };
}

describe("cross-assignee evidence comments", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/runner-goals.js");
    vi.doUnmock("../services/queued-interaction-response.js");
    vi.doUnmock("../services/external-objects.js");
    vi.doUnmock("../services/cross-issue-influence-limit.js");
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

    allowPeerComments();
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
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockExecutionWorkspaceService.reopenClosedIsolatedExecutionWorkspaceForIssue.mockResolvedValue({
      ok: true,
      reopened: true,
      generation: 1,
    });
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("stamps a peer comment from a linked checked-out issue with its evidence source", async () => {
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
        metadata: crossAssigneeMetadata("linked_checkout", linkedIssueId),
      }),
      expect.anything(),
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        agentId: peerAgentId,
        runId: peerRunId,
        details: expect.objectContaining({
          // The gate's own reason is what authorized the write; the stamp is
          // additive attribution, never a reason of its own.
          authorizationReason: "allow_visible_issue_write",
          crossAssignee: true,
          crossAssigneeTrigger: "linked_checkout",
          crossAssigneeViaIssueId: linkedIssueId,
        }),
      }),
    );
  });

  it("labels a mention-granted peer comment as a mention", async () => {
    allowPeerComments("allow_issue_mention_grant");

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "responding to the mention" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "responding to the mention",
      expect.any(Object),
      expect.objectContaining({ metadata: crossAssigneeMetadata("mention", null) }),
      expect.anything(),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          authorizationReason: "allow_issue_mention_grant",
          crossAssigneeTrigger: "mention",
        }),
      }),
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("labels a default-open peer comment without a link or mention as a visible-issue write", async () => {
    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "context from a visible issue" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "context from a visible issue",
      expect.any(Object),
      expect.objectContaining({ metadata: crossAssigneeMetadata("visible_issue", null) }),
      expect.anything(),
    );
  });

  it("keeps the direct-parent report grant visible in the audit trail", async () => {
    allowPeerComments("allow_direct_parent_report");
    mockIssueService.findCrossAssigneeEvidenceLink.mockResolvedValue({ viaIssueId: linkedIssueId });

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "report to my parent" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_added",
        details: expect.objectContaining({
          authorizationReason: "allow_direct_parent_report",
          directParentReportGrant: true,
          crossAssignee: true,
          crossAssigneeTrigger: "linked_checkout",
        }),
      }),
    );
  });

  it("never widens access: a link cannot turn a denied comment into a grant", async () => {
    denyPeerComments();
    mockIssueService.findCrossAssigneeEvidenceLink.mockResolvedValue({ viaIssueId: linkedIssueId });

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "no grant for this issue" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("not visible to this agent");
    expect(mockIssueService.findCrossAssigneeEvidenceLink).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("appends to a done issue with a closed workspace without reopening either", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ status: "done", executionWorkspaceId: workspaceId }),
    );
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: workspaceId,
      mode: "isolated_workspace",
      status: "archived",
      closedAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    mockIssueService.findCrossAssigneeEvidenceLink.mockResolvedValue({ viaIssueId: linkedIssueId });

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "late evidence on a closed issue" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(
      mockExecutionWorkspaceService.reopenClosedIsolatedExecutionWorkspaceForIssue,
    ).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "late evidence on a closed issue",
      expect.any(Object),
      expect.objectContaining({
        metadata: crossAssigneeMetadata("linked_checkout", linkedIssueId),
      }),
      expect.anything(),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.updated" }),
    );
    // Flush the async wake dispatch before asserting no wake happened.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("leaves intent-bearing peer comments to their existing gates instead of stamping them", async () => {
    mockIssueService.findCrossAssigneeEvidenceLink.mockResolvedValue({ viaIssueId: linkedIssueId });

    const res = await request(await createApp(peerActor()))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "evidence with a stray interrupt flag", interrupt: true });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("Only board users can interrupt");
    expect(mockIssueService.findCrossAssigneeEvidenceLink).not.toHaveBeenCalled();
    expect(mockHeartbeatService.cancelRun).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
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
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "owner status update",
      expect.any(Object),
      expect.objectContaining({ metadata: null }),
      expect.anything(),
    );
  });
});
