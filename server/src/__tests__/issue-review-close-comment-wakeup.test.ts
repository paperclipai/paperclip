import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
const returnAgentId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
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

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDb = vi.hoisted(() => ({
  transaction: vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => callback(mockTx)),
}));

function registerModuleMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
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

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

type ActorInput = {
  type: "agent" | "board";
  agentId?: string;
  userId?: string;
  companyId?: string;
  companyIds?: string[];
  runId?: string;
};

async function installActor(app: express.Express, actor: ActorInput) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor.type === "agent"
      ? {
          type: "agent",
          agentId: actor.agentId,
          companyId: actor.companyId ?? "company-1",
          runId: actor.runId ?? null,
        }
      : {
          type: "board",
          userId: actor.userId ?? "local-board",
          companyIds: actor.companyIds ?? ["company-1"],
          source: "local_implicit",
          isInstanceAdmin: false,
        };
    next();
  });
  app.use("/api", issueRoutes(mockDb as never, {} as never));
  app.use(errorHandler);
  return app;
}

async function normalizePolicy(input: {
  stages: Array<{
    id: string;
    type: "review" | "approval";
    participants: Array<{ type: "agent"; agentId: string } | { type: "user"; userId: string }>;
  }>;
}) {
  const { normalizeIssueExecutionPolicy } = await import("../services/issue-execution-policy.js");
  return normalizeIssueExecutionPolicy(input);
}

describe("issue review-close comment wakeups", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("does not queue issue_commented when a reviewer closes the issue with approval", async () => {
    const policy = await normalizePolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "review",
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    });

    const issue = {
      id: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      status: "in_review",
      assigneeAgentId: reviewerAgentId,
      assigneeUserId: null,
      createdByUserId: "local-board",
      identifier: "PAP-580",
      title: "Comment reopen default",
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: returnAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };

    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: issue.id,
      companyId: issue.companyId,
      body: "Approved for ship",
    });
    mockIssueService.update.mockImplementation(async (_id: string, patch: { [key: string]: unknown }, tx?: unknown) => ({
      ...issue,
      ...patch,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
      _tx: tx,
    }));

    const response = await request(
      await installActor(createApp(), {
        type: "agent",
        agentId: reviewerAgentId,
        companyId: "company-1",
        runId: "run-review-approve",
      }),
    )
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done", comment: "Approved for ship" });

    expect(response.status).toBe(200);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    expect(mockTxInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: "11111111-1111-4111-8111-111111111111",
        outcome: "approved",
        body: "Approved for ship",
      }),
    );
  });
});
