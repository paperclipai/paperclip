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

const codeIssue = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  identifier: "PAP-100",
  title: "Implement feature",
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
  updatedAt: new Date("2026-03-30T12:00:00Z"),
};

const nonCodeIssue = {
  ...codeIssue,
  id: "22222222-2222-4222-8222-222222222222",
  identifier: "PAP-200",
  title: "Update docs",
  executionWorkspaceId: null,
};

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

describe("delivery gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    // Provide a QA pass comment by default so delivery gate tests that reach done → 200 pass the QA gate
    mockIssueService.listComments.mockResolvedValue([
      { body: "QA: PASS", authorAgentId: "qa-agent-1", authorUserId: null },
    ]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "test" });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("agent → in_review on code issue with no work products → 422", async () => {
    // assigneeAgentId differs from actor so review handoff gate doesn't fire
    const issue = { ...codeIssue, assigneeAgentId: "agent-other" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("in_review_requires_artifact");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.delivery_gate_blocked" }),
    );
  });

  it("agent → done on code issue with no PR → 422", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "branch", status: "active" },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_pr");
  });

  it("agent → done on code issue with draft PR → 422", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "pull_request", status: "draft", url: "https://github.com/org/repo/pull/1" },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_pr");
  });

  it("board → done on code issue with no work products → 200 (bypass)", async () => {
    const issueForBoard = { ...codeIssue, assigneeAgentId: null };
    mockIssueService.getById.mockResolvedValue(issueForBoard);
    mockIssueService.update.mockResolvedValue({ ...issueForBoard, status: "done" });
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const app = createBoardApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
  });

  it("agent → done on non-code issue (no workspace) → 200 (escape hatch)", async () => {
    mockIssueService.getById.mockResolvedValue(nonCodeIssue);
    mockIssueService.update.mockResolvedValue({ ...nonCodeIssue, status: "done" });
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${nonCodeIssue.id}`)
      .send({ status: "done", comment: "Done" });

    expect(res.status).toBe(200);
  });

  it("agent → in_review on code issue with branch work product → 200", async () => {
    // assigneeAgentId differs from actor so review handoff gate doesn't fire
    const issue = { ...codeIssue, assigneeAgentId: "agent-other" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "in_review" });
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "branch", status: "active" },
    ]);
    // Engineer evidence gate: browse evidence + screenshot from the acting agent
    mockIssueService.listComments.mockResolvedValue([
      { body: "browser-test headless http://localhost:3000", authorAgentId: "agent-1", authorUserId: null, createdAt: "2026-03-31T00:00:00Z" },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: "agent-1", createdByUserId: null, createdAt: "2026-03-31T00:00:00Z" },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(200);
  });

  it("agent → done on code issue with merged PR → 200", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.update.mockResolvedValue({ ...codeIssue, status: "done" });
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "pull_request", status: "merged", url: "https://github.com/org/repo/pull/1" },
    ]);
    // QA gate + QA browse evidence: QA PASS with browse evidence from the QA reviewer
    mockIssueService.listComments.mockResolvedValue([
      { body: "QA: PASS — browser-test headless http://localhost:3000 verified", authorAgentId: "qa-agent-1", authorUserId: null, createdAt: "2026-03-31T00:00:00Z" },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: "qa-agent-1", createdByUserId: null, createdAt: "2026-03-31T00:00:00Z" },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done", comment: "Merged and complete" });

    expect(res.status).toBe(200);
  });

  it("agent → done on code issue with PR missing URL → 422", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "pull_request", status: "merged", url: null },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_pr");
  });

  it("agent → done on code issue with PR having non-GitHub URL → 422", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "pull_request", status: "merged", url: "https://example.com/fake-pr" },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_pr");
  });

  it("activity log contains gate details on rejection", async () => {
    // assigneeAgentId differs from actor so review handoff gate doesn't fire
    const issue = { ...codeIssue, assigneeAgentId: "agent-other" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const app = createAgentApp();
    await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.delivery_gate_blocked",
        entityType: "issue",
        entityId: codeIssue.id,
        details: expect.objectContaining({
          gate: "in_review_requires_artifact",
          targetStatus: "in_review",
        }),
      }),
    );
  });
});
