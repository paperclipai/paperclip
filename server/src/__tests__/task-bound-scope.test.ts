import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

// ---------- Mocked services ----------

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getCommentCursor: vi.fn(),
  listComments: vi.fn(),
  findMentionedAgents: vi.fn(),
  hasReachedStatus: vi.fn(),
  findMentionedProjectIds: vi.fn(async () => []),
  list: vi.fn(),
  checkout: vi.fn(),
  create: vi.fn(),
  release: vi.fn(),
  getAncestors: vi.fn(async () => []),
  countRecentByAgent: vi.fn(async () => 0),
  listAttachments: vi.fn(async () => []),
  getDepartmentLabelIds: vi.fn(async () => new Set(["d0000000-0000-4000-8000-000000000001"])),
  findDepartmentDuplicate: vi.fn(async () => null),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockHeartbeatGetRun = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getSettings: vi.fn(async () => ({})), findByCompany: vi.fn(async () => null) }),
  feedbackService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => ({
      id: AGENT_ID,
      companyId: "company-1",
      role: "ceo",
      permissions: { canCreateAgents: true },
    })),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
    listIssueDocuments: vi.fn(async () => []),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    getRun: mockHeartbeatGetRun,
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

// ---------- Helpers ----------

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOUND_ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "run-bound-1";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: BOUND_ISSUE_ID,
    companyId: "company-1",
    identifier: "PAP-100",
    title: "Bound issue",
    description: null,
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    createdByUserId: null,
    executionWorkspaceId: "ws-1",
    labels: [],
    labelIds: [],
    hiddenAt: null,
    updatedAt: new Date("2026-04-01T12:00:00Z"),
    ...overrides,
  };
}

function makeOtherIssue(overrides: Record<string, unknown> = {}) {
  return makeIssue({
    id: OTHER_ISSUE_ID,
    identifier: "PAP-200",
    title: "Other issue",
    ...overrides,
  });
}

function createAgentApp(runId = RUN_ID) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: AGENT_ID,
      companyId: "company-1",
      runId,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function createBoardApp() {
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

// ---------- Tests ----------

describe("task-bound scope enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "pull_request", status: "merged", url: "https://github.com/org/repo/pull/1" },
    ]);
    mockIssueService.listComments.mockResolvedValue([
      { body: "QA: PASS", authorAgentId: "qa-agent-1", authorUserId: null },
    ]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "test" });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    // Default: run resolves to bound issue
    mockHeartbeatGetRun.mockResolvedValue({
      contextSnapshot: { issueId: BOUND_ISSUE_ID },
    });
  });

  // ----- PATCH /issues/:id -----

  it("PATCH: bound issue → allowed", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue(issue);

    const res = await request(createAgentApp())
      .patch(`/api/issues/${BOUND_ISSUE_ID}`)
      .send({ comment: "Working on this" });

    expect(res.status).toBe(200);
  });

  it("PATCH: non-bound issue → 422 task_bound_scope", async () => {
    const other = makeOtherIssue();
    mockIssueService.getById.mockResolvedValue(other);

    const res = await request(createAgentApp())
      .patch(`/api/issues/${OTHER_ISSUE_ID}`)
      .send({ status: "done", comment: "Done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("task_bound_scope");
  });

  // ----- GET /issues/:id -----

  it("GET /issues/:id: bound issue → 200", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp())
      .get(`/api/issues/${BOUND_ISSUE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(BOUND_ISSUE_ID);
  });

  it("GET /issues/:id: non-bound issue → 403", async () => {
    const other = makeOtherIssue();
    mockIssueService.getById.mockResolvedValue(other);

    const res = await request(createAgentApp())
      .get(`/api/issues/${OTHER_ISSUE_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.gate).toBe("task_bound_scope");
  });

  // ----- POST /issues/:id/checkout -----

  it("checkout: bound issue → allowed", async () => {
    const issue = makeIssue({ status: "todo" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.checkout.mockResolvedValue(issue);

    const res = await request(createAgentApp())
      .post(`/api/issues/${BOUND_ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ID, expectedStatuses: ["todo"] });

    expect(res.status).toBe(200);
  });

  it("checkout: non-bound issue → 422 task_bound_scope", async () => {
    const other = makeOtherIssue({ status: "todo" });
    mockIssueService.getById.mockResolvedValue(other);

    const res = await request(createAgentApp())
      .post(`/api/issues/${OTHER_ISSUE_ID}/checkout`)
      .send({ agentId: AGENT_ID, expectedStatuses: ["todo"] });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("task_bound_scope");
  });

  // ----- POST /issues/:id/comments -----

  it("comment: bound issue → allowed", async () => {
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp())
      .post(`/api/issues/${BOUND_ISSUE_ID}/comments`)
      .send({ body: "Progress update" });

    expect(res.status).toBe(201);
  });

  it("comment: non-bound issue → 422 task_bound_scope", async () => {
    const other = makeOtherIssue();
    mockIssueService.getById.mockResolvedValue(other);

    const res = await request(createAgentApp())
      .post(`/api/issues/${OTHER_ISSUE_ID}/comments`)
      .send({ body: "Cross-issue comment" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("task_bound_scope");
  });

  // ----- Board bypass -----

  it("board user → always allowed (bypass)", async () => {
    const other = makeOtherIssue();
    mockIssueService.getById.mockResolvedValue(other);

    const res = await request(createBoardApp())
      .get(`/api/issues/${OTHER_ISSUE_ID}`);

    expect(res.status).toBe(200);
  });

  // ----- Agent without runId → not task-bound -----

  it("agent without runId → not task-bound (full access)", async () => {
    const other = makeOtherIssue();
    mockIssueService.getById.mockResolvedValue(other);

    // Agent with no runId at all
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId: AGENT_ID,
        companyId: "company-1",
        // no runId
      };
      next();
    });
    app.use("/api", issueRoutes({} as any, {} as any));
    app.use(errorHandler);

    const res = await request(app)
      .get(`/api/issues/${OTHER_ISSUE_ID}`);

    expect(res.status).toBe(200);
    expect(mockHeartbeatGetRun).not.toHaveBeenCalled();
  });

  // ----- Timer wake (no issueId in context) → not task-bound -----

  it("timer wake (no issueId in context) → full access", async () => {
    mockHeartbeatGetRun.mockResolvedValue({
      contextSnapshot: { source: "timer" },
    });
    const other = makeOtherIssue();
    mockIssueService.getById.mockResolvedValue(other);

    const res = await request(createAgentApp())
      .get(`/api/issues/${OTHER_ISSUE_ID}`);

    expect(res.status).toBe(200);
  });

  // ----- Unknown runId (fail-closed) -----

  it("unknown runId → fail-closed (blocked)", async () => {
    mockHeartbeatGetRun.mockResolvedValue(null);
    const issue = makeIssue();
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp())
      .get(`/api/issues/${BOUND_ISSUE_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.gate).toBe("task_bound_scope");
  });

  // ----- Issue creation: always allowed (exempt) -----

  it("issue creation: always allowed (exempt)", async () => {
    mockIssueService.create.mockResolvedValue(makeIssue({ id: "new-issue-id", identifier: "PAP-999" }));

    const res = await request(createAgentApp())
      .post("/api/companies/company-1/issues")
      .send({ title: "New sub-task", status: "todo", issueType: "initiative", labelIds: ["d0000000-0000-4000-8000-000000000001"] });

    expect(res.status).toBe(201);
  });

  // ----- Issue release: always allowed (exempt) -----

  it("issue release: always allowed (exempt)", async () => {
    const other = makeOtherIssue({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(other);
    mockIssueService.release.mockResolvedValue(other);

    const res = await request(createAgentApp())
      .post(`/api/issues/${OTHER_ISSUE_ID}/release`)
      .send({});

    // Release bypasses task-bound scope (exempt)
    expect(res.status).toBe(200);
  });

  // ----- Activity log records scope block -----

  it("activity log records scope block with boundIssueId + endpoint", async () => {
    const other = makeOtherIssue();
    mockIssueService.getById.mockResolvedValue(other);

    await request(createAgentApp())
      .patch(`/api/issues/${OTHER_ISSUE_ID}`)
      .send({ status: "done", comment: "Done" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.task_bound_scope_blocked",
        entityId: OTHER_ISSUE_ID,
        details: expect.objectContaining({
          gate: "task_bound_scope",
          boundIssueId: BOUND_ISSUE_ID,
        }),
      }),
    );
  });

  // ----- GET /issues/:id/comments: read guard -----

  it("GET /issues/:id/comments: non-bound → 403", async () => {
    const other = makeOtherIssue();
    mockIssueService.getById.mockResolvedValue(other);

    const res = await request(createAgentApp())
      .get(`/api/issues/${OTHER_ISSUE_ID}/comments`);

    expect(res.status).toBe(403);
    expect(res.body.gate).toBe("task_bound_scope");
  });

  // ----- GET /companies/:companyId/issues: task-bound scope does NOT apply -----

  it("list: task-bound → full results (scope bypassed for list)", async () => {
    mockIssueService.list.mockResolvedValue([makeIssue(), makeOtherIssue()]);

    const res = await request(createAgentApp())
      .get("/api/companies/company-1/issues");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(mockIssueService.list).toHaveBeenCalled();
    expect(mockIssueService.list).toHaveBeenCalledWith("company-1", expect.any(Object));
  });

  it("list: task-bound with unknown runId → full results (no fail-closed)", async () => {
    mockHeartbeatGetRun.mockResolvedValue(null);
    mockIssueService.list.mockResolvedValue([makeIssue(), makeOtherIssue()]);

    const res = await request(createAgentApp())
      .get("/api/companies/company-1/issues");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(mockIssueService.list).toHaveBeenCalled();
  });

  it("list: board user → full results", async () => {
    mockIssueService.list.mockResolvedValue([makeIssue(), makeOtherIssue()]);

    const res = await request(createBoardApp())
      .get("/api/companies/company-1/issues");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(mockIssueService.list).toHaveBeenCalled();
  });

  it("list: timer wake → full results", async () => {
    mockHeartbeatGetRun.mockResolvedValue({
      contextSnapshot: { source: "timer" },
    });
    mockIssueService.list.mockResolvedValue([makeIssue(), makeOtherIssue()]);

    const res = await request(createAgentApp())
      .get("/api/companies/company-1/issues");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(mockIssueService.list).toHaveBeenCalled();
  });
});
