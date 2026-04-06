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

const AGENT_1 = "aaaa0001-0001-4001-8001-000000000001";
const QA_1 = "aaaa0002-0002-4002-8002-000000000002";

const agentMap: Record<string, { id: string; companyId: string; name: string; role: string; status: string; pauseReason: string | null; permissions: { canCreateAgents: boolean } }> = {
  [AGENT_1]: {
    id: AGENT_1,
    companyId: "company-1",
    name: "Engineer",
    role: "engineer",
    status: "active",
    pauseReason: null,
    permissions: { canCreateAgents: false },
  },
  [QA_1]: {
    id: QA_1,
    companyId: "company-1",
    name: "QA",
    role: "qa",
    status: "active",
    pauseReason: null,
    permissions: { canCreateAgents: false },
  },
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
    identifier: "PAP-200",
    title: "Test issue",
    description: null,
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: AGENT_1,
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

describe("comment-required gate", () => {
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
      { body: "QA: PASS", authorAgentId: QA_1, authorUserId: null },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("rejects agent status change without comment", async () => {
    // assigneeAgentId differs from actor so review handoff gate doesn't fire
    // executionWorkspaceId: null bypasses engineer evidence gate (non-code issue)
    const issue = makeIssue({ status: "in_progress", assigneeAgentId: "agent-other", executionWorkspaceId: null });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp(AGENT_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("comment_required");
  });

  it("rejects agent assignee change without comment", async () => {
    const issue = makeIssue({ assigneeAgentId: AGENT_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp(AGENT_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: QA_1 });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("comment_required");
  });

  it("allows agent status change WITH comment", async () => {
    // assigneeAgentId differs from actor so review handoff gate doesn't fire
    const issue = makeIssue({ status: "in_progress", assigneeAgentId: "agent-other" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "in_review" });
    mockIssueService.addComment.mockResolvedValue({ id: "c-1", body: "Moving to review" });
    // Engineer evidence gate: browse evidence + screenshot from the acting agent
    mockIssueService.listComments.mockResolvedValue([
      { body: "browser-test headless http://localhost:3000", authorAgentId: AGENT_1, authorUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: AGENT_1, createdByUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);

    const res = await request(createAgentApp(AGENT_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Moving to review" });

    expect(res.status).toBe(200);
  });

  it("allows agent assignee change WITH comment", async () => {
    const issue = makeIssue({ assigneeAgentId: AGENT_1, status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: QA_1,
      status: "in_review",
    });
    mockIssueService.addComment.mockResolvedValue({ id: "c-2", body: "Handing off to QA" });
    // Engineer evidence gate: browse evidence + screenshot from the acting agent
    mockIssueService.listComments.mockResolvedValue([
      { body: "browser-test headless http://localhost:3000", authorAgentId: AGENT_1, authorUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: AGENT_1, createdByUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);

    const res = await request(createAgentApp(AGENT_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: QA_1, status: "in_review", comment: "Handing off to QA" });

    expect(res.status).toBe(200);
  });

  it("allows agent title/priority update without comment", async () => {
    const issue = makeIssue({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, title: "Updated title" });

    const res = await request(createAgentApp(AGENT_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ title: "Updated title" });

    expect(res.status).toBe(200);
  });

  it("board user bypasses comment-required gate", async () => {
    const issue = makeIssue({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "in_review" });

    const res = await request(createBoardApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
  });

  it("logs comment-required rejection to activity log", async () => {
    // assigneeAgentId differs from actor so review handoff gate doesn't fire
    // executionWorkspaceId: null bypasses engineer evidence gate (non-code issue)
    const issue = makeIssue({ status: "in_progress", assigneeAgentId: "agent-other", executionWorkspaceId: null });
    mockIssueService.getById.mockResolvedValue(issue);

    await request(createAgentApp(AGENT_1))
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.comment_required_blocked",
        entityId: issue.id,
      }),
    );
  });
});
