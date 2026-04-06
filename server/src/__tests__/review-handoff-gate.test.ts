import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getCommentCursor: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const ENGINEER_1 = "aaaa0001-0001-4001-8001-000000000001";
const QA_1 = "aaaa0002-0002-4002-8002-000000000002";

const engineerAgent = {
  id: ENGINEER_1,
  companyId: "company-1",
  name: "Engineer",
  role: "engineer",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const qaAgent = {
  id: QA_1,
  companyId: "company-1",
  name: "QA Agent",
  role: "qa",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const agentMap: Record<string, typeof engineerAgent> = {
  [ENGINEER_1]: engineerAgent,
  [QA_1]: qaAgent,
};

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getSettings: vi.fn(async () => ({})), findByCompany: vi.fn(async () => null) }),
  feedbackService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) => agentMap[id] ?? null),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
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
    getRun: vi.fn(async () => ({ contextSnapshot: {} })),
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

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "PAP-100",
    title: "Test issue",
    description: null,
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ENGINEER_1,
    assigneeUserId: null,
    createdByUserId: null,
    executionWorkspaceId: "ws-1",
    labels: [],
    labelIds: [],
    executionRunId: null,
    checkoutRunId: "run-1",
    executionLockedAt: null,
    activationRetriggerCount: 0,
    hiddenAt: null,
    updatedAt: new Date("2026-04-01T12:00:00Z"),
    ...overrides,
  };
}

function createAgentApp(agentId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: "company-1",
      runId: "run-1",
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

describe("review handoff gate", () => {
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
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "test" });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("blocks in_review transition when agent does not set assigneeAgentId", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("review_handoff_required");
  });

  it("allows in_review transition when agent explicitly sets assigneeAgentId", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: QA_1,
      status: "in_review",
    });
    // Engineer evidence gate: browse evidence + screenshot from the acting agent
    mockIssueService.listComments.mockResolvedValue([
      { body: "browser-test headless http://localhost:3000", authorAgentId: ENGINEER_1, authorUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: ENGINEER_1, createdByUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: QA_1, status: "in_review", comment: "Handing off to QA" });

    expect(res.status).toBe(200);
  });

  it("auto-infers assignee from @mention in inline comment", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.findMentionedAgents.mockResolvedValue([QA_1]);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: QA_1,
      status: "in_review",
    });
    // Engineer evidence gate: browse evidence + screenshot from the acting agent
    mockIssueService.listComments.mockResolvedValue([
      { body: "browser-test headless http://localhost:3000", authorAgentId: ENGINEER_1, authorUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: ENGINEER_1, createdByUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "@qa-agent please review" });

    expect(res.status).toBe(200);
  });

  it("auto-infers assignee from recent comment when PATCH comment has no mention", async () => {
    // Non-code issue (executionWorkspaceId: null) to test handoff logic in isolation from evidence gate
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress", executionWorkspaceId: null });
    mockIssueService.getById.mockResolvedValue(issue);
    // First call: inline comment has no mention → returns []
    // Second call: recent comment has @qa-agent → returns [QA_1]
    mockIssueService.findMentionedAgents
      .mockResolvedValueOnce([])  // inline PATCH comment
      .mockResolvedValueOnce([QA_1]);  // recent comment body
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "@qa-agent please review this PR",
        authorAgentId: ENGINEER_1,
        authorUserId: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: QA_1,
      status: "in_review",
    });

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Moving to review" });

    expect(res.status).toBe(200);
  });

  it("does not auto-infer from old comments (older than 2 minutes)", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "@qa-agent please review this PR",
        authorAgentId: ENGINEER_1,
        authorUserId: null,
        createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 minutes ago
      },
    ]);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Moving to review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("review_handoff_required");
  });

  it("board users bypass the review handoff gate", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      status: "in_review",
    });

    const res = await request(createBoardApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
  });

  it("does not block when issue is already in_review (re-patch)", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_review" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue(issue);
    // Engineer evidence gate: browse evidence from the acting agent
    mockIssueService.listComments.mockResolvedValue([
      { body: "browser-test headless http://localhost:3000", authorAgentId: ENGINEER_1, authorUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: ENGINEER_1, createdByUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Update" });

    expect(res.status).toBe(200);
  });

  it("does not block when agent is not the current assignee", async () => {
    const issue = makeIssue({ assigneeAgentId: QA_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      status: "in_review",
    });
    // Engineer evidence gate: browse evidence from the acting agent (ENGINEER_1)
    mockIssueService.listComments.mockResolvedValue([
      { body: "browser-test headless http://localhost:3000", authorAgentId: ENGINEER_1, authorUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: ENGINEER_1, createdByUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Review please" });

    // The checkout ownership check may reject this, but the review handoff gate won't
    // since the actor is not the current assignee
    expect(res.status).not.toBe(422);
  });

  it("allows in_review when agent sets assigneeUserId (handoff to board user)", async () => {
    const issue = makeIssue({ assigneeAgentId: ENGINEER_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: null,
      assigneeUserId: "board-user-1",
      status: "in_review",
    });
    // Engineer evidence gate: browse evidence from the acting agent (ENGINEER_1)
    mockIssueService.listComments.mockResolvedValue([
      { body: "browser-test headless http://localhost:3000", authorAgentId: ENGINEER_1, authorUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: ENGINEER_1, createdByUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);

    const res = await request(createAgentApp(ENGINEER_1))
      .patch(`/api/issues/${issue.id}`)
      .send({
        assigneeUserId: "board-user-1",
        assigneeAgentId: null,
        status: "in_review",
        comment: "Routing to board for review",
      });

    expect(res.status).toBe(200);
  });
});
