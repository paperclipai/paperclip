import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const BUILDER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const CEO_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(async () => undefined),
  update: vi.fn(),
  addComment: vi.fn(),
  getDependencyReadiness: vi.fn(async () => ({ unresolvedBlockerCount: 1, blockerIssueIds: [] })),
  getCurrentScheduledRetry: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockPermissionBlockEscalationService = vi.hoisted(() => ({
  evaluate: vi.fn(),
  findUnblockOwnerAgent: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => true),
  decide: vi.fn(async () => ({ allowed: true, action: "issue.comment", reason: "allow_explicit_grant", explanation: "" })),
  hasPermission: vi.fn(async () => true),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
  upsertSourceScoped: vi.fn(),
  resolveActiveForIssue: vi.fn(),
}));

const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => mockAccessService,
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({ ambiguous: false, agent: { id: raw } })),
  }),
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
      general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
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
  permissionBlockEscalationService: () => mockPermissionBlockEscalationService,
  projectService: () => ({}),
  routineService: () => mockRoutineService,
  workProductService: () => ({}),
}));

function makeBlockedIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "blocked",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: BUILDER_AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "HUM-162",
    title: "CTO hire",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

async function createApp(actorAgentId: string) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: actorAgentId,
      companyId: "company-1",
      runId: "run-1",
      source: "agent_key",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("blocked-comment permission escalation wakes the CEO", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.getDependencyReadiness.mockResolvedValue({ unresolvedBlockerCount: 1, blockerIssueIds: [] });
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockPermissionBlockEscalationService.evaluate.mockReset();
  });

  it("wakes the CEO with reason=direct_report_blocked_on_ceo_permission on the HUM-162 replay", async () => {
    const blocked = makeBlockedIssue();
    mockIssueService.getById.mockResolvedValue(blocked);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: blocked.id,
      companyId: blocked.companyId,
      body: "Blocked. Missing permission: agents:create. Unblock owner: CEO.",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: BUILDER_AGENT_ID,
      authorUserId: null,
    });
    mockPermissionBlockEscalationService.evaluate.mockResolvedValue({
      targetAgentId: CEO_AGENT_ID,
      targetAgentRole: "ceo",
      match: {
        trigger: "missing_permission",
        permissionKey: "agents:create",
        unblockOwnerRole: "ceo",
      },
    });

    const app = await createApp(BUILDER_AGENT_ID);
    const res = await request(app)
      .post(`/api/issues/${blocked.id}/comments`)
      .send({
        body: "Blocked. Missing permission: agents:create. Unblock owner: CEO.",
      });

    expect(res.status).toBe(201);

    await vi.waitFor(() => {
      expect(mockPermissionBlockEscalationService.evaluate).toHaveBeenCalledWith({
        companyId: blocked.companyId,
        issueStatus: "blocked",
        actorAgentId: BUILDER_AGENT_ID,
        commentBody: "Blocked. Missing permission: agents:create. Unblock owner: CEO.",
      });
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        CEO_AGENT_ID,
        expect.objectContaining({
          source: "automation",
          reason: "direct_report_blocked_on_ceo_permission",
          payload: expect.objectContaining({
            issueId: blocked.id,
            commentId: "comment-1",
            blockedAgentId: BUILDER_AGENT_ID,
            permissionKey: "agents:create",
            unblockOwnerRole: "ceo",
            trigger: "missing_permission",
          }),
          contextSnapshot: expect.objectContaining({
            issueId: blocked.id,
            taskId: blocked.id,
            commentId: "comment-1",
            wakeReason: "direct_report_blocked_on_ceo_permission",
            source: "issue.comment.permission_block_escalation",
          }),
        }),
      );
    });
  });

  it("does not wake the CEO when the comment does not name a permission gate", async () => {
    const blocked = makeBlockedIssue();
    mockIssueService.getById.mockResolvedValue(blocked);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-2",
      issueId: blocked.id,
      companyId: blocked.companyId,
      body: "Waiting on upstream API.",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: BUILDER_AGENT_ID,
      authorUserId: null,
    });
    mockPermissionBlockEscalationService.evaluate.mockResolvedValue(null);

    const app = await createApp(BUILDER_AGENT_ID);
    const res = await request(app)
      .post(`/api/issues/${blocked.id}/comments`)
      .send({ body: "Waiting on upstream API." });

    expect(res.status).toBe(201);

    await vi.waitFor(() => {
      expect(mockPermissionBlockEscalationService.evaluate).toHaveBeenCalled();
    });

    const ceoWakes = mockHeartbeatService.wakeup.mock.calls.filter(
      ([agentId]) => agentId === CEO_AGENT_ID,
    );
    expect(ceoWakes).toHaveLength(0);
  });

  it("does not double-wake when the assignee is already the CEO", async () => {
    const blocked = makeBlockedIssue({ assigneeAgentId: CEO_AGENT_ID });
    mockIssueService.getById.mockResolvedValue(blocked);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-3",
      issueId: blocked.id,
      companyId: blocked.companyId,
      body: "Missing permission: agents:create",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: BUILDER_AGENT_ID,
      authorUserId: null,
    });
    mockPermissionBlockEscalationService.evaluate.mockResolvedValue({
      targetAgentId: CEO_AGENT_ID,
      targetAgentRole: "ceo",
      match: { trigger: "missing_permission", permissionKey: "agents:create", unblockOwnerRole: "ceo" },
    });

    const app = await createApp(BUILDER_AGENT_ID);
    const res = await request(app)
      .post(`/api/issues/${blocked.id}/comments`)
      .send({ body: "Missing permission: agents:create" });

    expect(res.status).toBe(201);

    await vi.waitFor(() => {
      const ceoWakes = mockHeartbeatService.wakeup.mock.calls.filter(([agentId]) => agentId === CEO_AGENT_ID);
      // Either the assignee-wake or the escalation-wake fires, but not both.
      expect(ceoWakes.length).toBe(1);
    });
  });
});
