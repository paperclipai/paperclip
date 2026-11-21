import express from "express";
import request from "supertest";
import { getTableName } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REVIEWER_ID = "22222222-2222-4222-8222-222222222222";
const agentStatusById: Record<string, string> = { [REVIEWER_ID]: "idle" };

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getWakeDiagnostics: vi.fn(),
  getBlockerDiagnostics: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockObserveCrossIssueInfluence = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../services/cross-issue-influence-limit.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../services/cross-issue-influence-limit.js")>(),
  observeCrossIssueInfluence: mockObserveCrossIssueInfluence,
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: true,
      action: input.action,
      reason: "allow_explicit_grant",
      explanation: "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) => ({
      id,
      companyId: "company-1",
      status: agentStatusById[id] ?? "idle",
    })),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: {
        id: raw,
        companyId: "company-1",
        status: agentStatusById[raw] ?? "idle",
        orgChainHealth: { status: "healthy" },
      },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
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
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => ({
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByHistoricalComments: vi.fn(async () => []),
  }),
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

function stubDb(): any {
  const query: any = {};
  for (const method of ["select", "from", "where", "innerJoin", "leftJoin", "orderBy", "limit", "groupBy", "for"]) {
    query[method] = () => query;
  }
  query.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([]));
  return { select: () => ({ from: (table: Parameters<typeof getTableName>[0]) => {
    const name = getTableName(table);
    if (name !== "issues" && name !== "agents") return query;
    const rows = async () => name === "issues"
      ? [await mockIssueService.getById()].filter(Boolean)
      : Object.entries(agentStatusById).map(([id, status]) => ({ id, status, companyId: "company-1", permissions: null }));
    const result = {
      where: () => result,
      orderBy: () => result,
      limit: () => result,
      for: () => result,
      then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        rows().then(resolve, reject),
    };
    return result;
  } }) };
}

function createApp() {
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
  app.use("/api", issueRoutes(stubDb() as any, {} as any));
  app.use(errorHandler);
  return app;
}

function skippedWake(reason: string) {
  return {
    agentId: REVIEWER_ID,
    source: "assignment",
    reason,
    status: "skipped",
    coalescedCount: 0,
    runId: null,
    requestedAt: new Date("2026-11-01T10:00:00.000Z"),
    claimedAt: null,
    finishedAt: new Date("2026-11-01T10:00:00.000Z"),
    error: "Raw gate text that must stay hidden",
  };
}

describe("issue wake diagnostics for gated wakes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: "company-1",
      identifier: "PAP-1",
      title: "Gated review",
      status: "in_review",
      priority: "medium",
      projectId: null,
      goalId: null,
      parentId: null,
      assigneeAgentId: REVIEWER_ID,
      assigneeUserId: null,
      createdByUserId: "local-board",
      executionPolicy: null,
      executionState: null,
      hiddenAt: null,
    });
    mockIssueService.getBlockerDiagnostics.mockResolvedValue({
      blockers: [],
      readiness: { allBlockersDone: true, isDependencyReady: true, unresolvedBlockerIssueIds: [], pendingFinalizeBlockerIssueIds: [] },
      truncated: false,
    });
  });

  it.each([
    ["agent.not_invokable", "An agent admin must resume or repair the target agent."],
    ["budget.blocked", "A budget owner must check Costs, then resolve pending or unpriced usage (or allow unpriced usage in the budget policy), raise the budget, or lift the budget stop."],
    ["company.inactive", "A company admin must reactivate the company."],
    ["heartbeat.wakeOnDemand.disabled", "An agent admin must turn on wake on demand for the target agent."],
  ])("names the %s gate and its next step", async (reason, nextStep) => {
    mockIssueService.getWakeDiagnostics.mockResolvedValue({
      wakeRequests: [skippedWake(reason)],
      activityRecords: [],
      truncatedWakeRequests: false,
      truncatedActivityRecords: false,
    });

    const res = await request(createApp()).get(`/api/issues/${ISSUE_ID}/diagnostics/wakes`);

    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({ kind: "wake_request", reason, status: "skipped", failureClass: "failed" });
    expect(res.body.diagnosis).toBe(`The most recent wake for PAP-1 was skipped for ${reason}. ${nextStep}`);
    expect(JSON.stringify(res.body)).not.toContain("Raw gate text");
  });

  it("keeps an unknown skip reason as other without a next step", async () => {
    mockIssueService.getWakeDiagnostics.mockResolvedValue({
      wakeRequests: [skippedWake("plugin.private_gate")],
      activityRecords: [],
      truncatedWakeRequests: false,
      truncatedActivityRecords: false,
    });

    const res = await request(createApp()).get(`/api/issues/${ISSUE_ID}/diagnostics/wakes`);

    expect(res.status).toBe(200);
    expect(res.body.events[0]).toMatchObject({ reason: "other", status: "skipped" });
    expect(res.body.diagnosis).toBe("The most recent wake for PAP-1 was skipped for other.");
  });
});
