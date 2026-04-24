import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getAncestors: vi.fn(async () => []),
  getComment: vi.fn(async () => null),
  getCommentCursor: vi.fn(async () => ({ totalComments: 0, latestCommentId: null, latestCommentAt: null })),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  getCompanyGraphHealth: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
  reportRunActivity: vi.fn(async () => undefined),
  listIssueGraphLivenessFindings: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
  executionWorkspaceService: () => ({ getById: vi.fn() }),
  feedbackService: () => ({}),
  goalService: () => ({ getById: vi.fn(), getDefaultCompanyGoal: vi.fn() }),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({ get: vi.fn(), listCompanyIds: vi.fn() }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({ getById: vi.fn(), listByIds: vi.fn(async () => []) }),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
  ISSUE_LIST_DEFAULT_LIMIT: 500,
  ISSUE_LIST_MAX_LIMIT: 1000,
  clampIssueListLimit: (limit: number) => limit,
}));

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
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

describe("issue graph health route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.resetAllMocks();
  });

  it("returns company graph health plus current liveness findings", async () => {
    mockIssueService.getCompanyGraphHealth.mockResolvedValue({
      summary: {
        blockedIssues: 3,
        blockedWithoutExplicitBlockers: 1,
        blockedWithUnresolvedBlockers: 1,
        blockedReadyToUnblock: 1,
        frontierReadyIssues: 1,
      },
      blockedWithoutExplicitBlockers: [{ issueId: "issue-1", title: "Blocked without edges", graphState: "blocked_no_relations" }],
      blockedWithUnresolvedBlockers: [{ issueId: "issue-2", title: "Blocked waiting", graphState: "blocked_waiting_on_relations" }],
      blockedReadyToUnblock: [{ issueId: "issue-3", title: "Blocked but ready", graphState: "blocked_relations_resolved" }],
      frontierReady: [{ issueId: "issue-3", title: "Blocked but ready", graphState: "blocked_relations_resolved" }],
    });
    mockHeartbeatService.listIssueGraphLivenessFindings.mockResolvedValue([
      {
        issueId: "issue-2",
        companyId: "company-1",
        identifier: "PAP-2",
        state: "blocked_by_unassigned_issue",
        severity: "critical",
        reason: "PAP-2 is blocked by unassigned issue PAP-3.",
        dependencyPath: [],
        recommendedOwnerAgentId: "agent-9",
        recommendedOwnerCandidateAgentIds: ["agent-9"],
        recommendedAction: "Assign the blocker.",
        incidentKey: "harness_liveness:company-1:issue-2:blocked_by_unassigned_issue:issue-3",
      },
    ]);

    const res = await request(await createApp()).get("/api/companies/company-1/issues/graph-health");

    expect(res.status).toBe(200);
    expect(mockIssueService.getCompanyGraphHealth).toHaveBeenCalledWith("company-1");
    expect(mockHeartbeatService.listIssueGraphLivenessFindings).toHaveBeenCalledWith({ companyId: "company-1" });
    expect(res.body).toMatchObject({
      companyId: "company-1",
      summary: {
        blockedIssues: 3,
        blockedWithoutExplicitBlockers: 1,
        blockedWithUnresolvedBlockers: 1,
        blockedReadyToUnblock: 1,
        frontierReadyIssues: 1,
        livenessFindings: 1,
      },
      blockedWithoutExplicitBlockers: [{ issueId: "issue-1" }],
      blockedWithUnresolvedBlockers: [{ issueId: "issue-2" }],
      blockedReadyToUnblock: [{ issueId: "issue-3" }],
      frontierReady: [{ issueId: "issue-3" }],
      livenessFindings: [
        expect.objectContaining({
          issueId: "issue-2",
          state: "blocked_by_unassigned_issue",
        }),
      ],
    });
  });
});
