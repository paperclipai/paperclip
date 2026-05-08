import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockEvaluateOutcomeContract = vi.hoisted(() => vi.fn());

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
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
  vi.doMock("../services/issue-outcome-enforcement.js", () => ({
    evaluateOutcomeContract: mockEvaluateOutcomeContract,
  }));
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

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

function makeBaseIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "WER-99",
    title: "Test issue",
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    outcomeContract: null,
    ...overrides,
  };
}

describe("outcome contract PATCH gate", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issue-outcome-enforcement.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();

    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: ISSUE_ID,
      body: "comment body",
    });
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("happy path: satisfied contract lets status → done", async () => {
    const issue = makeBaseIssue({
      outcomeContract: { kind: "merged_pr" },
    });
    mockIssueService.getById.mockResolvedValue(issue);
    mockEvaluateOutcomeContract.mockResolvedValue({ satisfied: true });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
      updatedAt: new Date(),
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: AGENT_ID,
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockEvaluateOutcomeContract).toHaveBeenCalledWith(
      expect.anything(),
      ISSUE_ID,
      { kind: "merged_pr" },
    );
    expect(mockIssueService.update).toHaveBeenCalledWith(
      ISSUE_ID,
      expect.objectContaining({ status: "done" }),
    );
  });

  it("422 path: unsatisfied contract blocks status change and returns structured missing", async () => {
    const issue = makeBaseIssue({
      outcomeContract: { kind: "merged_pr" },
    });
    mockIssueService.getById.mockResolvedValue(issue);
    mockEvaluateOutcomeContract.mockResolvedValue({
      satisfied: false,
      missing: [
        {
          code: "no_merged_pr",
          message: "No merged pull request linked to this issue.",
          hint: "POST /api/issues/{id}/work-products with kind=pull_request",
        },
      ],
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: AGENT_ID,
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("outcome_not_satisfied");
    expect(res.body.missing).toHaveLength(1);
    expect(res.body.missing[0].code).toBe("no_merged_pr");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  describe("override path", () => {
    it("board user override succeeds when comment is provided", async () => {
      const issue = makeBaseIssue({
        outcomeContract: { kind: "merged_pr", allowHumanOverride: true },
      });
      mockIssueService.getById.mockResolvedValue(issue);
      mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
        ...issue,
        ...patch,
        updatedAt: new Date(),
      }));

      const res = await request(await createApp())
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ status: "done", comment: "Overriding: PR was merged in a hotfix branch not linked here." });

      expect(res.status).toBe(200);
      // Contract evaluation is skipped for allowed board override
      expect(mockEvaluateOutcomeContract).not.toHaveBeenCalled();
      // Structured override comment emitted with outcomeOverride metadata marker
      expect(mockIssueService.addComment).toHaveBeenCalledWith(
        ISSUE_ID,
        expect.any(String),
        expect.objectContaining({ userId: "local-board" }),
        expect.objectContaining({
          metadata: expect.objectContaining({ outcomeOverride: true }),
        }),
      );
    });

    it("board user override rejected when comment is missing", async () => {
      const issue = makeBaseIssue({
        outcomeContract: { kind: "merged_pr", allowHumanOverride: true },
      });
      mockIssueService.getById.mockResolvedValue(issue);

      const res = await request(await createApp())
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ status: "done" });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("outcome_override_requires_comment");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("agent cannot override: unsatisfied contract returns 422 even when allowHumanOverride=true", async () => {
      const issue = makeBaseIssue({
        outcomeContract: { kind: "merged_pr", allowHumanOverride: true },
      });
      mockIssueService.getById.mockResolvedValue(issue);
      mockEvaluateOutcomeContract.mockResolvedValue({
        satisfied: false,
        missing: [{ code: "no_merged_pr", message: "No merged PR.", hint: "..." }],
      });

      const res = await request(await createApp({
        type: "agent",
        agentId: AGENT_ID,
        companyId: "company-1",
        runId: "run-1",
      }))
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ status: "done", comment: "Trying to override as agent" });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("outcome_not_satisfied");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });

    it("board user must satisfy contract when allowHumanOverride=false", async () => {
      const issue = makeBaseIssue({
        outcomeContract: { kind: "merged_pr", allowHumanOverride: false },
      });
      mockIssueService.getById.mockResolvedValue(issue);
      mockEvaluateOutcomeContract.mockResolvedValue({
        satisfied: false,
        missing: [{ code: "no_merged_pr", message: "No merged PR.", hint: "..." }],
      });

      const res = await request(await createApp())
        .patch(`/api/issues/${ISSUE_ID}`)
        .send({ status: "done", comment: "Trying to override but override is disabled" });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe("outcome_not_satisfied");
      expect(mockIssueService.update).not.toHaveBeenCalled();
    });
  });

  it("ordering: satisfied execution policy stages but unsatisfied contract still returns 422", async () => {
    // All execution stages are already completed in executionState; no pending stages remain.
    // When the agent requests status → done, applyIssueExecutionPolicyTransition returns an empty patch
    // (no pending stages), so effectiveNextStatus stays "done" and the outcome contract gate fires.
    const stageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: stageId,
          type: "review",
          participants: [{ type: "agent", agentId: "44444444-4444-4444-8444-444444444444" }],
        },
      ],
    });
    const issue = makeBaseIssue({
      status: "in_review",
      executionPolicy: policy,
      executionState: {
        status: "completed",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: { type: "agent", agentId: AGENT_ID, userId: null },
        reviewRequest: null,
        completedStageIds: [stageId],
        lastDecisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        lastDecisionOutcome: "approved",
        monitor: null,
      },
      outcomeContract: { kind: "merged_pr" },
    });
    mockIssueService.getById.mockResolvedValue(issue);
    mockEvaluateOutcomeContract.mockResolvedValue({
      satisfied: false,
      missing: [{ code: "no_merged_pr", message: "No merged PR.", hint: "..." }],
    });

    const res = await request(await createApp({
      type: "agent",
      agentId: AGENT_ID,
      companyId: "company-1",
      runId: "run-1",
    }))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", comment: "All stages approved, trying to close" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("outcome_not_satisfied");
    // Execution stage processing completed (no pending stages) but contract gate blocked the transition
    expect(mockEvaluateOutcomeContract).toHaveBeenCalledWith(
      expect.anything(),
      ISSUE_ID,
      { kind: "merged_pr" },
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
