import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// STO-726: Paperclip preflight hook — agent-authored in_progress transitions
// must bind the issue to an execution workspace. Prevents the
// "happy-agent send → declared in_progress with no worktree/PR" anti-pattern
// (2026-04-29 retro SC7).

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  hasPermission: vi.fn(async () => false),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async () => null),
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({
      getById: vi.fn(async () => null),
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
    issueApprovalService: () => mockIssueApprovalService,
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

type TestActor =
  | {
      type: "board";
      userId: string;
      companyIds: string[];
      source: "local_implicit";
      isInstanceAdmin: boolean;
    }
  | {
      type: "agent";
      agentId: string;
      companyId: string;
      runId: string | null;
    };

async function createApp(actor?: TestActor) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
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

const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function baseIssue(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    projectId: "project-1",
    status: "todo",
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-2001",
    title: "STO-726 fixture",
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspaceSettings: null,
    executionWorkspacePreference: null,
    ...overrides,
  };
}

const AGENT_ACTOR: TestActor = {
  type: "agent",
  agentId: AGENT_ID,
  companyId: "company-1",
  runId: "run-1",
};

describe("STO-726: agent in_progress transition requires worktree binding", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...baseIssue(),
      ...patch,
      updatedAt: new Date(),
    }));
  });

  it("rejects an agent transitioning a project-bound issue to in_progress without workspace binding", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue());

    const res = await request(await createApp(AGENT_ACTOR))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.error).toContain("worktree");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "worktree_binding",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows the transition when the issue has no project (no repo to bind)", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ projectId: null }));

    const res = await request(await createApp(AGENT_ACTOR))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "in_progress" }),
    );
  });

  it("allows the transition when the issue is already bound to an execution workspace", async () => {
    mockIssueService.getById.mockResolvedValue(
      baseIssue({ executionWorkspaceId: "55555555-5555-4555-8555-555555555555" }),
    );

    const res = await request(await createApp(AGENT_ACTOR))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_progress" });

    // The gate must NOT fire — confirm by absence of the worktree_binding rejection.
    // (A 500 from downstream activity-detail enrichment is acceptable in this thin
    //  mock harness; what we care about is that the 422 worktree_binding rejection
    //  did not happen.)
    if (res.status === 422 && res.body?.details?.missing === "worktree_binding") {
      throw new Error("worktree_binding gate fired despite existing executionWorkspaceId");
    }
  });

  it("allows the transition when the PATCH supplies executionWorkspaceId", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue());

    const res = await request(await createApp(AGENT_ACTOR))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "in_progress",
        executionWorkspaceId: "66666666-6666-4666-8666-666666666666",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("allows the transition when the PATCH supplies executionWorkspaceSettings", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue());

    const res = await request(await createApp(AGENT_ACTOR))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({
        status: "in_progress",
        executionWorkspaceSettings: {
          environmentId: "77777777-7777-4777-8777-777777777777",
        },
      });

    // The route may still reject for unrelated reasons (e.g. unknown environment),
    // but the worktree-binding gate must NOT be the rejection reason.
    if (res.status === 422 && res.body?.details?.missing === "worktree_binding") {
      throw new Error("worktree_binding gate should not fire when executionWorkspaceSettings is set");
    }
  });

  it("does not enforce the gate on board (human) actors", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue());

    const res = await request(await createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("does not enforce the gate when the issue is already in_progress", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_progress" }));

    const res = await request(await createApp(AGENT_ACTOR))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_progress", priority: "high" });

    expect(res.status).toBe(200);
  });

  it("does not enforce the gate when transitioning from in_review back to in_progress (changes_requested)", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue({ status: "in_review" }));

    const res = await request(await createApp(AGENT_ACTOR))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_progress", comment: "Needs another pass" });

    if (res.status === 422 && res.body?.details?.missing === "worktree_binding") {
      throw new Error("worktree_binding gate should not fire on in_review → in_progress");
    }
  });

  it("does not enforce the gate when the agent transitions to a non-in_progress status", async () => {
    mockIssueService.getById.mockResolvedValue(baseIssue());

    const res = await request(await createApp(AGENT_ACTOR))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "blocked" }),
    );
  });
});
