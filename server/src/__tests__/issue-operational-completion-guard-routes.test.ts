import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  listComments: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getCurrentScheduledRetry: vi.fn(),
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

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_test",
      explanation: "Allowed by test.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw },
    })),
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
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
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
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueTreeControlService: () => ({
    getActivePauseHoldGate: vi.fn(async () => null),
  }),
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

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

function makeOperationalIssue() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status: "todo",
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "VIVA-1960",
    title: "Pentest Swarm — execute supervised Phase-3 dry-run + Phase-4 prod passive/recon run (deploy host, operational)",
    description:
      "Operational execution issue. This is intentionally NOT linked to any code PR. Close only when green report/SARIF evidence is attached.",
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
  };
}

function makeImplementationIssue() {
  return {
    ...makeOperationalIssue(),
    identifier: "PAP-123",
    title: "Fix OAuth proxy request header",
    description: "Implement the proxy code path and merge the PR after QA passes.",
  };
}

describe("issue operational completion guard routes", () => {
  let currentIssue: ReturnType<typeof makeOperationalIssue>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentIssue = makeOperationalIssue();
    mockIssueService.getById.mockImplementation(async () => currentIssue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...currentIssue,
      ...patch,
    }));
    mockIssueService.addComment.mockImplementation(async (_id: string, body: string) => ({
      id: "comment-1",
      issueId: currentIssue.id,
      body,
      authorAgentId: null,
      authorUserId: "local-board",
      createdAt: new Date(),
    }));
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "Post-merge reconciliation: linked GitHub PR #898 is merged. Marking issue done.",
      },
      {
        body: "Disposition: blocked, not done. No green report/SARIF artifact was produced. No Phase-4 production run was started.",
      },
    ]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("rejects stale merge-only done updates for operational runtime-evidence issues", async () => {
    const app = await createApp();

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      "Operational/manual-run issue requires an explicit runtime completion evidence comment to transition to done.",
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects merge-only completion comments for operational runtime-evidence issues", async () => {
    const app = await createApp();

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        status: "done",
        comment: "Post-merge reconciliation: linked GitHub PR #898 is merged. Marking issue done.",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      "Operational/manual-run issue requires explicit runtime completion evidence; merge-only PR evidence cannot mark it done.",
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows operational done transitions when the comment includes runtime evidence", async () => {
    const app = await createApp();

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({
        status: "done",
        comment:
          "Phase-3 dry-run completed successfully. Green report and SARIF artifact attached; Phase-4 passive/recon run completed.",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("does not load recent comments for normal implementation issue done transitions", async () => {
    currentIssue = makeImplementationIssue();
    const app = await createApp();

    const res = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });
});
