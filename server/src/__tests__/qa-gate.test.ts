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

/** Provide a valid PR so the delivery gate passes — QA gate tests focus on the QA layer. */
const validPR = { type: "pull_request" as const, status: "merged", url: "https://github.com/org/repo/pull/1" };

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

describe("qa gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    // Default: delivery gate passes (valid PR exists)
    mockWorkProductService.listForIssue.mockResolvedValue([validPR]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "test" });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
  });

  it("agent → done, no comments → 422", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.listComments.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_qa_pass");
  });

  it("agent → done, QA pass comment with agent author → 200", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.update.mockResolvedValue({ ...codeIssue, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      { body: "QA: PASS — browser-test headless https://viracue.ai, no console errors", authorAgentId: "qa-agent-1", authorUserId: null, createdAt: new Date("2026-03-30T13:00:00Z") },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: "qa-agent-1", createdByUserId: null, createdAt: new Date("2026-03-30T13:01:00Z") },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(200);
  });

  it("agent → done, ghost QA pass (null author) → 422", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.listComments.mockResolvedValue([
      { body: "QA: PASS", authorAgentId: null, authorUserId: null },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_qa_pass");
  });

  it("board → done, no QA pass → 200 (bypass)", async () => {
    const issueForBoard = { ...codeIssue, assigneeAgentId: null };
    mockIssueService.getById.mockResolvedValue(issueForBoard);
    mockIssueService.update.mockResolvedValue({ ...issueForBoard, status: "done" });
    mockIssueService.listComments.mockResolvedValue([]);

    const app = createBoardApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
  });

  it("agent → done, non-code issue (no workspace), no QA pass → 422", async () => {
    mockIssueService.getById.mockResolvedValue(nonCodeIssue);
    mockIssueService.listComments.mockResolvedValue([]);
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${nonCodeIssue.id}`)
      .send({ status: "done", comment: "Done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_qa_pass");
  });

  it("agent → done, non-code issue (no workspace), with QA pass → 200", async () => {
    mockIssueService.getById.mockResolvedValue(nonCodeIssue);
    mockIssueService.update.mockResolvedValue({ ...nonCodeIssue, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      { body: "QA: PASS — verified in production", authorAgentId: "qa-agent-1", authorUserId: null },
    ]);
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${nonCodeIssue.id}`)
      .send({ status: "done", comment: "Done" });

    expect(res.status).toBe(200);
  });

  it("agent → in_review, no QA pass → 200 (gate only on done)", async () => {
    // assigneeAgentId differs from actor so review handoff gate doesn't fire
    const issue = { ...codeIssue, assigneeAgentId: "agent-other" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "in_review" });
    mockIssueService.listComments.mockResolvedValue([
      { body: "browser-test headless https://viracue.ai — tested", authorAgentId: "agent-1", authorUserId: null, createdAt: new Date("2026-03-30T13:00:00Z") },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: "agent-1", createdByUserId: null, createdAt: new Date("2026-03-30T13:01:00Z") },
    ]);
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "branch", status: "active" },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(200);
  });

  it('agent → done, "QA: passed" variant → 200', async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.update.mockResolvedValue({ ...codeIssue, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      { body: "QA: passed — browser-test headless https://viracue.ai", authorAgentId: "qa-agent-1", authorUserId: null, createdAt: new Date("2026-03-30T13:00:00Z") },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: "qa-agent-1", createdByUserId: null, createdAt: new Date("2026-03-30T13:01:00Z") },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(200);
  });

  it('agent → done, "QA PASS" variant → 200', async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.update.mockResolvedValue({ ...codeIssue, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      { body: "QA PASS — browser-test headless https://viracue.ai, all checks green", authorUserId: "user-1", authorAgentId: null, createdAt: new Date("2026-03-30T13:00:00Z") },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: null, createdByUserId: "user-1", createdAt: new Date("2026-03-30T13:01:00Z") },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(200);
  });

  it("activity log has gate details on rejection", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.listComments.mockResolvedValue([]);

    const app = createAgentApp();
    await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.qa_gate_blocked",
        entityType: "issue",
        entityId: codeIssue.id,
        details: expect.objectContaining({
          gate: "done_requires_qa_pass",
          targetStatus: "done",
        }),
      }),
    );
  });

  it("agent → done, assignee posts QA pass (self-QA) → 422", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.listComments.mockResolvedValue([
      // agent-1 is the assignee — self-approval should be rejected
      { body: "QA: PASS", authorAgentId: "agent-1", authorUserId: null },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_qa_pass");
  });

  it("agent → done, assignee self-QA ignored but different agent QA passes → 200", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.update.mockResolvedValue({ ...codeIssue, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      // Self-approval from assignee — ignored
      { body: "QA: PASS", authorAgentId: "agent-1", authorUserId: null, createdAt: new Date("2026-03-30T13:00:00Z") },
      // Real approval from a different agent with browse evidence
      { body: "QA: PASS — browser-test headless https://viracue.ai, reviewed and approved", authorAgentId: "qa-agent-1", authorUserId: null, createdAt: new Date("2026-03-30T13:00:00Z") },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: "qa-agent-1", createdByUserId: null, createdAt: new Date("2026-03-30T13:01:00Z") },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(200);
  });

  it("agent → done, board user QA passes even when assignee is agent → 200", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.update.mockResolvedValue({ ...codeIssue, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      { body: "QA: PASS — browser-test headless https://viracue.ai", authorAgentId: null, authorUserId: "board-user-1", createdAt: new Date("2026-03-30T13:00:00Z") },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      { contentType: "image/png", createdByAgentId: null, createdByUserId: "board-user-1", createdAt: new Date("2026-03-30T13:01:00Z") },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(200);
  });

  it("delivery gate fires before QA gate (no PR + no QA) → done_requires_pr", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.listComments.mockResolvedValue([]);
    // No work products — delivery gate should fire first
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_pr");
    // QA gate should NOT have been reached
    expect(mockIssueService.listComments).not.toHaveBeenCalled();
  });
});
