import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The first test imports the large `routes/issues.js` module through
// `vi.importActual` inside `createApp`. `vi.resetModules()` in `beforeEach`
// forces a fresh import each test, so the first test pays the one-time
// transform and execution cost of that module. Give the suite generous
// headroom, far above the observed cold-start.
vi.setConfig({ testTimeout: 30000 });

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
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
    listCompanyIds: vi.fn(async () => []),
    getExperimental: vi.fn(async () => ({ enableIsolatedWorkspaces: false })),
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
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByIssueDocument: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
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


const boardActor = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

const issueRow = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "FLE-7",
  title: "Escalation probe",
  status: "done",
};

// The most recent journaled transition into a terminal status (route update
// shape: changes.status plus _previous).
const terminalAnchorRow = {
  id: "event-1",
  companyId: "company-1",
  action: "issue.updated",
  entityType: "issue",
  entityId: "issue-1",
  actorType: "board",
  actorId: "local-board",
  createdAt: new Date("2026-09-30T07:00:00.000Z"),
  details: {
    status: "done",
    changes: { status: { to: "done", from: "in_progress" } },
    _previous: { status: "in_progress" },
    identifier: "FLE-7",
  },
};

function createRouteDb(anchorRows: Array<Record<string, unknown>>) {
  const whereResult: Record<string, unknown> = {
    orderBy: vi.fn(() => whereResult),
    limit: vi.fn(async () => anchorRows),
    then: async (resolve: (rows: unknown[]) => unknown) => resolve(anchorRows),
  };
  const query: Record<string, unknown> = {};
  query.innerJoin = vi.fn(() => query);
  query.where = vi.fn(() => whereResult);
  return {
    select: vi.fn(() => ({ from: vi.fn(() => query) })),
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
  };
}

interface AppOptions {
  anchorRows?: Array<Record<string, unknown>>;
  issue?: unknown;
  pubsub?: unknown;
  actor?: Record<string, unknown>;
}

async function createApp(options: AppOptions = {}) {
  const anchorRows = options.anchorRows ?? [terminalAnchorRow];
  const routeDb = createRouteDb(anchorRows);
  mockIssueService.getById.mockResolvedValue(options.issue === undefined ? issueRow : options.issue);
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor?: unknown }).actor = options.actor ?? boardActor;
    next();
  });
  if (options.pubsub !== undefined) app.locals.pubsub = options.pubsub;
  app.use("/api", issueRoutes(routeDb as never, {} as never));
  app.use(errorHandler);
  return app;
}

const endpoint = "/api/companies/company-1/issues/issue-1/review-escalation";

describe("issue review-escalation route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  it("re-publishes the last terminal transition on fleet.task.review with review required", async () => {
    const publishActivity = vi.fn(async () => ({ id: "msg-1", queued: 1 }));
    const res = await request(await createApp({ pubsub: { publishActivity } }))
      .post(endpoint)
      .send({ reason: "operator needs eyes on this" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: "msg-1", queued: 1 });
    expect(publishActivity).toHaveBeenCalledTimes(1);
    const [eventId, input] = publishActivity.mock.calls[0] as [string, { topic: string; payload: Record<string, unknown> }];
    expect(eventId).toBe("event-1");
    expect(input.topic).toBe("fleet.task.review");
    expect(input).toMatchObject({ companyId: "company-1", agentId: null, role: "system" });
    expect(input.payload).toEqual({
      eventId: "event-1",
      issueId: "issue-1",
      identifier: "FLE-7",
      status: "done",
      review: "required",
      reason: "operator needs eyes on this",
      createdAt: "2026-09-30T07:00:00.000Z",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: "company-1",
      action: "issue.review_escalated",
      entityType: "issue",
      entityId: "issue-1",
    }));
  });

  it("anchors repeated calls on the same journal event so the receipt dedupes", async () => {
    // First publication enqueues; the repeat hits the existing
    // pubsubActivityReceipts row and returns the stored message without a new
    // outbox row (dedupe itself is covered by the pubsub service tests).
    const publishActivity = vi.fn()
      .mockResolvedValueOnce({ id: "msg-1", queued: 1 })
      .mockResolvedValueOnce({ id: "msg-1", queued: 0 });
    const app = await createApp({ pubsub: { publishActivity } });

    const first = await request(app).post(endpoint).send({});
    const second = await request(app).post(endpoint).send({});

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ id: "msg-1", queued: 0 });
    expect(publishActivity).toHaveBeenCalledTimes(2);
    const firstAnchor = publishActivity.mock.calls[0][0] as string;
    const secondAnchor = publishActivity.mock.calls[1][0] as string;
    expect(secondAnchor).toBe(firstAnchor);
    expect(firstAnchor).toBe("event-1");
  });

  it("returns 404 for an unknown issue without publishing", async () => {
    const publishActivity = vi.fn();
    const res = await request(await createApp({ issue: null, pubsub: { publishActivity } }))
      .post(endpoint)
      .send({});
    expect(res.status).toBe(404);
    expect(publishActivity).not.toHaveBeenCalled();
  });

  it("returns 404 when the issue belongs to another company", async () => {
    const publishActivity = vi.fn();
    const res = await request(await createApp({ issue: { ...issueRow, companyId: "company-2" }, pubsub: { publishActivity } }))
      .post(endpoint)
      .send({});
    expect(res.status).toBe(404);
    expect(publishActivity).not.toHaveBeenCalled();
  });

  it("returns 400 when no done/blocked/cancelled transition is journaled", async () => {
    const publishActivity = vi.fn();
    const res = await request(await createApp({ anchorRows: [], pubsub: { publishActivity } }))
      .post(endpoint)
      .send({});
    expect(res.status).toBe(400);
    expect(publishActivity).not.toHaveBeenCalled();
  });

  it("rejects escalation with 400 once the terminal issue has been reopened", async () => {
    // The journaled done transition is still the newest terminal anchor, but
    // the issue was reopened since: publishing it as review-required would
    // wake a peer CEO to review a status the issue no longer has.
    const publishActivity = vi.fn();
    const res = await request(await createApp({ issue: { ...issueRow, status: "todo" }, pubsub: { publishActivity } }))
      .post(endpoint)
      .send({});
    expect(res.status).toBe(400);
    expect(publishActivity).not.toHaveBeenCalled();
  });

  it("returns 400 when the newest terminal-looking journal row is not a real transition", async () => {
    // A journaled status "value" equal to its previous value (for example a
    // no-op re-assertion of the current status) is not a transition to reference.
    const publishActivity = vi.fn();
    const notATransition = {
      ...terminalAnchorRow,
      id: "event-2",
      details: {
        changes: { status: { to: "done", from: "done" } },
        _previous: { status: "done" },
      },
    };
    const res = await request(await createApp({ anchorRows: [notATransition], pubsub: { publishActivity } }))
      .post(endpoint)
      .send({});
    expect(res.status).toBe(400);
    expect(publishActivity).not.toHaveBeenCalled();
  });

  it("rejects non-board principals with 403", async () => {
    const publishActivity = vi.fn();
    const actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    };
    const res = await request(await createApp({ actor, pubsub: { publishActivity } }))
      .post(endpoint)
      .send({});
    expect(res.status).toBe(403);
    expect(publishActivity).not.toHaveBeenCalled();
  });

  it("returns 503 when PubSub is disabled on the instance", async () => {
    const publishActivity = vi.fn();
    const res = await request(await createApp({ pubsub: undefined }))
      .post(endpoint)
      .send({});
    expect(res.status).toBe(503);
    expect(publishActivity).not.toHaveBeenCalled();
  });
});
