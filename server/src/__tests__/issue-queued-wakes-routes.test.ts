import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(async () => []),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(async () => null),
  getCommentCursor: vi.fn(async () => ({
    totalComments: 0,
    latestCommentId: null,
    latestCommentAt: null,
  })),
  getRelationSummaries: vi.fn(async () => ({ blockedBy: [], blocks: [] })),
  update: vi.fn(),
  listQueuedWakesForIssue: vi.fn(),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
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
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

type Actor = {
  type: "agent" | "board";
  companyId?: string;
  companyIds?: string[];
  agentId?: string;
  userId?: string;
  source?: string;
  isInstanceAdmin?: boolean;
  runId?: string | null;
};

async function createApp(actor: Actor) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

async function withServer<T>(
  app: express.Express,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

const boardLocalActor: Actor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const agentSameCompany: Actor = {
  type: "agent",
  companyId: "company-1",
  agentId: "agent-1",
};

const agentCrossCompany: Actor = {
  type: "agent",
  companyId: "company-other",
  agentId: "agent-x",
};

describe("GET /issues/:id/queued-wakes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  it("returns queued wakes for an issue in the agent's company (200)", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Polling CI via ScheduleWakeup",
      status: "in_progress",
    });
    const requestedAt = new Date("2026-06-10T18:00:00.000Z");
    mockIssueService.listQueuedWakesForIssue.mockResolvedValue([
      {
        id: "wake-queued",
        status: "queued",
        reason: "schedule_wakeup",
        agentId: "agent-1",
        requestedAt,
      },
      {
        id: "wake-deferred",
        status: "deferred_issue_execution",
        reason: "deferred_issue_execution",
        agentId: "agent-1",
        requestedAt,
      },
    ]);

    const res = await withServer(await createApp(agentSameCompany), (baseUrl) =>
      request(baseUrl).get("/api/issues/issue-1/queued-wakes"),
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.listQueuedWakesForIssue).toHaveBeenCalledWith(
      "company-1",
      "issue-1",
    );
    expect(res.body).toEqual({
      wakes: [
        {
          id: "wake-queued",
          status: "queued",
          reason: "schedule_wakeup",
          agentId: "agent-1",
          requestedAt: requestedAt.toISOString(),
        },
        {
          id: "wake-deferred",
          status: "deferred_issue_execution",
          reason: "deferred_issue_execution",
          agentId: "agent-1",
          requestedAt: requestedAt.toISOString(),
        },
      ],
    });
  });

  it("returns an empty wakes array when nothing is queued", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Idle issue",
      status: "in_progress",
    });
    mockIssueService.listQueuedWakesForIssue.mockResolvedValue([]);

    const res = await withServer(await createApp(boardLocalActor), (baseUrl) =>
      request(baseUrl).get("/api/issues/issue-1/queued-wakes"),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ wakes: [] });
  });

  it("returns 404 when the issue does not exist", async () => {
    mockIssueService.getById.mockResolvedValue(null);

    const res = await withServer(await createApp(agentSameCompany), (baseUrl) =>
      request(baseUrl).get("/api/issues/missing/queued-wakes"),
    );

    expect(res.status).toBe(404);
    expect(mockIssueService.listQueuedWakesForIssue).not.toHaveBeenCalled();
  });

  it("returns 403 when an agent key reaches across companies", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Cross-company issue",
      status: "in_progress",
    });

    const res = await withServer(await createApp(agentCrossCompany), (baseUrl) =>
      request(baseUrl).get("/api/issues/issue-1/queued-wakes"),
    );

    expect(res.status).toBe(403);
    expect(mockIssueService.listQueuedWakesForIssue).not.toHaveBeenCalled();
  });
});
