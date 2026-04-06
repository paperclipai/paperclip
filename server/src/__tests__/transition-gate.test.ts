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

vi.mock("../services/index.js", () => ({
  instanceSettingsService: () => ({ getSettings: vi.fn(async () => ({})), findByCompany: vi.fn(async () => null) }),
  feedbackService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async () => ({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
      permissions: { canCreateAgents: true },
    })),
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
    assigneeAgentId: "agent-1",
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

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
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

describe("transition gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    // Default: delivery + QA gates pass
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "pull_request", status: "merged", url: "https://github.com/org/repo/pull/1" },
    ]);
    mockIssueService.listComments.mockResolvedValue([
      { body: "QA: PASS", authorAgentId: "qa-agent-1", authorUserId: null },
    ]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "test" });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("agent: done → backlog blocked", async () => {
    const issue = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "backlog" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("invalid_agent_transition");
  });

  it("agent: done → in_progress blocked", async () => {
    const issue = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("invalid_agent_transition");
  });

  it("agent: cancelled → todo blocked", async () => {
    const issue = makeIssue({ status: "cancelled" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "todo" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("invalid_agent_transition");
  });

  it("agent: in_progress → backlog blocked", async () => {
    const issue = makeIssue({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "backlog" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("invalid_agent_transition");
  });

  it("agent: in_progress → in_review allowed", async () => {
    // assigneeAgentId set to a different agent so the review handoff gate doesn't fire
    const issue = makeIssue({ status: "in_progress", assigneeAgentId: "agent-other" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "in_review" });
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "branch", status: "active" },
    ]);
    // Engineer evidence gate: browse evidence + screenshot from the acting agent
    mockIssueService.listComments.mockResolvedValue([
      { body: "browser-test headless http://localhost:3000", authorAgentId: "agent-1", authorUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: "agent-1", createdByUserId: null, createdAt: "2026-04-02T00:00:00Z" },
    ]);

    const res = await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Moving to review" });

    expect(res.status).toBe(200);
  });

  it("agent: in_review → in_progress allowed (rework)", async () => {
    const issue = makeIssue({ status: "in_review" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "in_progress" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_progress", comment: "Rework needed" });

    expect(res.status).toBe(200);
  });

  it("agent: blocked → in_progress allowed (unblocked)", async () => {
    const issue = makeIssue({ status: "blocked" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "in_progress" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_progress", comment: "Unblocked" });

    expect(res.status).toBe(200);
  });

  it("agent: todo → backlog allowed (deprioritize)", async () => {
    const issue = makeIssue({ status: "todo" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "backlog" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "backlog", comment: "Deprioritizing" });

    expect(res.status).toBe(200);
  });

  it("board: done → backlog allowed (bypass)", async () => {
    const issue = makeIssue({ status: "done", assigneeAgentId: null });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "backlog" });
    mockIssueService.listComments.mockResolvedValue([]);

    const res = await request(createBoardApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "backlog" });

    expect(res.status).toBe(200);
  });

  it("board: cancelled → todo allowed (reopen)", async () => {
    const issue = makeIssue({ status: "cancelled", assigneeAgentId: null });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "todo" });
    mockIssueService.listComments.mockResolvedValue([]);

    const res = await request(createBoardApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "todo" });

    expect(res.status).toBe(200);
  });

  it("activity log records transition rejection", async () => {
    const issue = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(issue);

    await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "backlog" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.transition_blocked",
        entityType: "issue",
        entityId: issue.id,
        details: expect.objectContaining({
          gate: "invalid_agent_transition",
          fromStatus: "done",
          targetStatus: "backlog",
        }),
      }),
    );
  });

  it("transition gate fires before delivery gate", async () => {
    const issue = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const res = await request(createAgentApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("invalid_agent_transition");
    // Delivery gate should NOT have been reached
    expect(mockWorkProductService.listForIssue).not.toHaveBeenCalled();
  });
});
