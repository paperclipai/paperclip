import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  companySearchService: () => ({ search: vi.fn(async () => ({ results: [] })) }),
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
  goalService: () => ({ getById: vi.fn(async () => null), getDefaultCompanyGoal: vi.fn(async () => null) }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
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
  issueApprovalService: () => ({ listApprovalsForIssue: vi.fn(async () => []), unlink: vi.fn(async () => undefined) }),
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
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
  ISSUE_LIST_DEFAULT_LIMIT: 500,
  ISSUE_LIST_MAX_LIMIT: 1000,
  clampIssueListLimit: (value: number) => Math.min(1000, Math.max(1, Math.floor(value))),
}));

vi.mock("../services/feedback.js", () => ({
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => ({ getById: vi.fn(async () => null) }),
}));

vi.mock("../services/instance-settings.js", () => ({
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
}));

vi.mock("../services/company-search-rate-limit.js", () => ({
  createCompanySearchRateLimiter: () => ({
    consume: () => ({
      allowed: true,
      limit: 20,
      remaining: 19,
      retryAfterSeconds: 0,
    }),
  }),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

vi.mock("../services/recovery/successful-run-handoff.js", () => ({
  listSuccessfulRunHandoffStates: vi.fn(async () => new Map()),
}));

async function createApp() {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
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

describe("issue list assigneeAgentId route handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockIssueService.list.mockReset();
    mockIssueService.count.mockReset();
  });

  it("normalizes assigneeAgentId='null' to an explicit null-assignee filter", async () => {
    mockIssueService.list.mockResolvedValue([]);

    const res = await request(await createApp())
      .get("/api/companies/company-1/issues")
      .query({ status: "todo", assigneeAgentId: "null", limit: "20" });

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        status: "todo",
        assigneeAgentId: null,
      }),
    );
  });

  it("returns 422 for malformed assigneeAgentId instead of 500", async () => {
    mockIssueService.list.mockResolvedValue([]);

    const res = await request(await createApp())
      .get("/api/companies/company-1/issues")
      .query({ status: "todo", assigneeAgentId: "bad", limit: "20" });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "assigneeAgentId must be a UUID or 'null'" });
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("returns 422 for duplicate assigneeAgentId query values", async () => {
    mockIssueService.list.mockResolvedValue([]);

    const res = await request(await createApp())
      .get("/api/companies/company-1/issues")
      .query({
        status: "todo",
        assigneeAgentId: [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
        ],
        limit: "20",
      } as any);

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "assigneeAgentId must be a UUID or 'null'" });
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("applies the same null normalization on issues/count", async () => {
    mockIssueService.count.mockResolvedValue(3);

    const res = await request(await createApp())
      .get("/api/companies/company-1/issues/count")
      .query({ attention: "blocked", assigneeAgentId: "null" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 3 });
    expect(mockIssueService.count).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        attention: "blocked",
        assigneeAgentId: null,
      }),
    );
  });

  it("returns 422 for malformed assigneeAgentId on issues/count", async () => {
    mockIssueService.count.mockResolvedValue(0);

    const res = await request(await createApp())
      .get("/api/companies/company-1/issues/count")
      .query({ attention: "blocked", assigneeAgentId: "bad" });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "assigneeAgentId must be a UUID or 'null'" });
    expect(mockIssueService.count).not.toHaveBeenCalled();
  });
});
