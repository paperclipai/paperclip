import express from "express";
import request from "supertest";
import { beforeEach, describe, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(), assertCheckoutOwner: vi.fn(), update: vi.fn(), createChild: vi.fn(),
  addComment: vi.fn(), findMentionedAgents: vi.fn(), getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(), getWakeableParentAfterChildCompletion: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined), triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined), getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null), cancelRun: vi.fn(async () => null),
}));
const mockAccessService = vi.hoisted(() => ({ canUser: vi.fn(async () => false), hasPermission: vi.fn(async () => false) }));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({ listApprovalsForIssue: vi.fn(async () => []) }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({ getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })) }),
    accessService: () => mockAccessService,
    agentService: () => ({ getById: vi.fn(async () => null), resolveByReference: vi.fn(async () => null) }),
    documentService: () => ({}), executionWorkspaceService: () => ({}),
    feedbackService: () => ({ listIssueVotesForUser: vi.fn(async () => []), saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })) }),
    goalService: () => ({}), heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({ getById: vi.fn(async () => null) }),
    instanceSettingsService: () => ({ get: vi.fn(async () => ({ id: "s", general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" } })), listCompanyIds: vi.fn(async () => ["company-1"]) }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({ deleteDocumentSource: async () => undefined, diffIssueReferenceSummary: () => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] }), emptySummary: () => ({ outbound: [], inbound: [] }), listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }), syncComment: async () => undefined, syncDocument: async () => undefined, syncIssue: async () => undefined }),
    issueRecoveryActionService: () => ({ getActiveForIssue: vi.fn(async () => null), listActiveForIssues: vi.fn(async () => new Map()) }),
    issueService: () => mockIssueService, issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity, projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

describe("routing debug", () => {
  beforeEach(() => {
    vi.resetModules(); vi.doUnmock("../services/index.js"); vi.doUnmock("../routes/issues.js"); vi.doUnmock("../middleware/index.js");
    registerModuleMocks(); vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(false); mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("debug board reassignment", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", companyId: "company-1", status: "in_progress",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111", assigneeUserId: null,
      createdByUserId: "local-board", identifier: "PAP-2002", title: "Board routing correction",
      executionPolicy: null, executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...issue, ...patch, updatedAt: new Date() }));

    const [{ issueRoutes }] = await Promise.all([import("../routes/issues.js")]);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.actor = { type: "board", userId: "local-board", companyIds: ["company-1"], source: "local_implicit", isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes({} as any, {} as any));
    app.use((err: any, _req: any, res: any, _next: any) => {
      console.error("ROUTE ERROR:", err?.message, err?.stack?.split('\n').slice(0, 3).join(' | '));
      res.status(500).json({ error: err?.message ?? "unknown" });
    });

    const res = await request(app).patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ status: "in_review", assigneeAgentId: "22222222-2222-4222-8222-222222222222" });
    console.log("Status:", res.status, "Body:", JSON.stringify(res.body));
  });
});
