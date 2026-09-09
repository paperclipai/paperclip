import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// See issue-dependency-wakeups-routes.test.ts: the first test pays the
// one-time cost of importing the large routes/issues.ts module, which can
// cross vitest's default 5s timeout on a loaded serial shard.
vi.setConfig({ testTimeout: 15000 });

const OWNER_AGENT_ID = "00000000-0000-4000-8000-0000000000a1";
const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// Must sit after ROUTABLE_BLOCKED_ROLLOUT_AT or the delivery is declined by design.
const BLOCKED_AT = new Date("2026-08-21T19:19:58.733Z");

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(async () => []),
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(async () => null),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({ canUser: vi.fn(), hasPermission: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  companySkillService: () => ({ completeTestRunForIssue: vi.fn(async () => null) }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
  executionWorkspaceService: () => ({ getById: vi.fn() }),
  feedbackService: () => ({}),
  goalService: () => ({ getById: vi.fn(), getDefaultCompanyGoal: vi.fn() }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({ get: vi.fn(), listCompanyIds: vi.fn() }),
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
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({ getById: vi.fn(), listByIds: vi.fn(async () => []) }),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
}));

/**
 * `select` resolves to a single row so the route's "unblock owner agent must
 * belong to this company" lookup succeeds. `update` has to be a real stub
 * because recording delivery writes blockedOwnerNotifiedAt directly.
 */
function createRouteDb() {
  const rows = [{ id: OWNER_AGENT_ID }];
  const whereResult = {
    limit: vi.fn(async () => rows),
    then: async (resolve: (value: unknown[]) => unknown) => resolve(rows),
  };
  const query: Record<string, unknown> = {};
  query.innerJoin = vi.fn(() => query);
  query.where = vi.fn(() => whereResult);
  const updateWhere = vi.fn(async () => undefined);
  return {
    db: {
      select: vi.fn(() => ({ from: vi.fn(() => query) })),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: updateWhere })) })),
      transaction: async (cb: (tx: Record<string, never>) => Promise<unknown>) => cb({}),
    },
    updateWhere,
  };
}

async function createApp(routeDb: unknown) {
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
  app.use("/api", issueRoutes(routeDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

function issueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    identifier: "PAP-2377",
    title: "Already blocked, descriptor attached later",
    description: null,
    status: "blocked",
    priority: "medium",
    parentId: null,
    assigneeAgentId: "agent-assignee",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
    unblockDescriptor: null,
    blockedTransitionAt: BLOCKED_AT,
    blockedOwnerNotifiedAt: null,
    ...overrides,
  };
}

describe("blocked owner notification in issue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: ISSUE_ID,
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
  });

  // BRO-2453 / BRO-2377: the issue was blocked at 14:57 and the descriptor was
  // attached at 14:59. Notification was wired only to the blocked *transition*,
  // so the named owner was never woken and the issue sat untouched for a day.
  it("wakes the owner when a descriptor is attached to an already-blocked issue", async () => {
    const descriptor = { owner: { agentId: OWNER_AGENT_ID }, action: "Verify the rollout" };
    mockIssueService.getById.mockResolvedValue(issueRow());
    mockIssueService.update.mockResolvedValue(issueRow({ unblockDescriptor: descriptor }));

    const { db, updateWhere } = createRouteDb();
    const res = await request(await createApp(db))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ unblockDescriptor: descriptor });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        OWNER_AGENT_ID,
        expect.objectContaining({
          reason: "issue_unblock_requested",
          payload: { issueId: ISSUE_ID, action: "Verify the rollout" },
        }),
      );
    });
    // Delivery must be recorded, or the next PATCH re-wakes the same owner.
    expect(updateWhere).toHaveBeenCalled();
  });

  // A re-point names a *different* owner, so a prior delivery stamp must not
  // suppress it. Deduplication is the fingerprinted idempotency key's job.
  it("wakes the new owner when an already-notified descriptor is re-pointed", async () => {
    const descriptor = { owner: { agentId: OWNER_AGENT_ID }, action: "Take this over" };
    mockIssueService.getById.mockResolvedValue(issueRow({
      unblockDescriptor: { owner: { agentId: "00000000-0000-4000-8000-0000000000b2" }, action: "Old" },
      blockedOwnerNotifiedAt: new Date("2026-08-21T19:20:00.000Z"),
    }));
    mockIssueService.update.mockResolvedValue(issueRow({
      unblockDescriptor: descriptor,
      blockedOwnerNotifiedAt: new Date("2026-08-21T19:20:00.000Z"),
    }));

    const { db } = createRouteDb();
    const res = await request(await createApp(db))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ unblockDescriptor: descriptor });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(OWNER_AGENT_ID, expect.anything());
    });
  });

  it("does not re-wake when the descriptor is unchanged", async () => {
    const descriptor = { owner: { agentId: OWNER_AGENT_ID }, action: "Verify the rollout" };
    mockIssueService.getById.mockResolvedValue(issueRow({
      unblockDescriptor: descriptor,
      blockedOwnerNotifiedAt: new Date("2026-08-21T19:20:00.000Z"),
    }));
    mockIssueService.update.mockResolvedValue(issueRow({
      unblockDescriptor: descriptor,
      blockedOwnerNotifiedAt: new Date("2026-08-21T19:20:00.000Z"),
    }));

    const { db } = createRouteDb();
    const res = await request(await createApp(db))
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ unblockDescriptor: descriptor });

    expect(res.status).toBe(200);
    expect(mockWakeup).not.toHaveBeenCalledWith(OWNER_AGENT_ID, expect.objectContaining({
      reason: "issue_unblock_requested",
    }));
  });
});
