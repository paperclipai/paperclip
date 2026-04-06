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
  assigneeAgentId: "agent-other",
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

/** Valid branch work product so delivery gate passes on in_review transitions. */
const validBranch = { type: "branch" as const, status: "active" };

/** Valid PR work product so delivery gate passes on done transitions. */
const validPR = { type: "pull_request" as const, status: "merged", url: "https://github.com/org/repo/pull/1" };

/** Timestamp AFTER issue.updatedAt — valid for current review cycle. */
const FRESH_DATE = new Date("2026-04-01T10:00:00Z");

/** Timestamp BEFORE issue.updatedAt — stale, from a previous review cycle. */
const STALE_DATE = new Date("2026-03-29T10:00:00Z");

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

describe("engineer browse evidence gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockWorkProductService.listForIssue.mockResolvedValue([validBranch]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "test" });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    // Default: no comments, no attachments, update returns the issue
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.update.mockResolvedValue({ ...codeIssue, status: "in_review" });
  });

  it("agent → in_review, code issue, no evidence → 422", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("in_review_requires_browse_evidence");
  });

  it("agent → in_review, browse text but no image attachment → 422", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "browser-test headless http://localhost:3000 — no console errors",
        authorAgentId: "agent-1",
        authorUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("in_review_requires_browse_evidence");
  });

  it("agent → in_review, browse text + image attachment → 200", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.update.mockResolvedValue({ ...codeIssue, status: "in_review" });
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "browser-test headless http://localhost:3000 — no console errors",
        authorAgentId: "agent-1",
        authorUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      {
        contentType: "image/png",
        createdByAgentId: "agent-1",
        createdByUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(200);
  });

  it("agent → in_review, non-code issue (no workspace) → 200 (exempt)", async () => {
    mockIssueService.getById.mockResolvedValue(nonCodeIssue);
    mockIssueService.update.mockResolvedValue({ ...nonCodeIssue, status: "in_review" });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${nonCodeIssue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(200);
  });

  it("board → in_review, code issue, no evidence → 200 (bypass)", async () => {
    const issueForBoard = { ...codeIssue, assigneeAgentId: null };
    mockIssueService.getById.mockResolvedValue(issueForBoard);
    mockIssueService.update.mockResolvedValue({ ...issueForBoard, status: "in_review" });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);

    const app = createBoardApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
  });

  it("activity log records evidence_gate_blocked on rejection", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);

    const app = createAgentApp();
    await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.evidence_gate_blocked",
        entityType: "issue",
        entityId: codeIssue.id,
        details: expect.objectContaining({
          gate: "in_review_requires_browse_evidence",
          targetStatus: "in_review",
        }),
      }),
    );
  });

  it("agent → in_review, stale evidence (before updatedAt) → 422", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "browser-test headless http://localhost:3000 — screenshot saved",
        authorAgentId: "agent-1",
        authorUserId: null,
        createdAt: STALE_DATE,
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      {
        contentType: "image/png",
        createdByAgentId: "agent-1",
        createdByUserId: null,
        createdAt: STALE_DATE,
      },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("in_review_requires_browse_evidence");
  });

  it("agent → in_review, evidence from wrong agent → 422", async () => {
    mockIssueService.getById.mockResolvedValue(codeIssue);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "browser-test headless http://localhost:3000 — DOM dump looks clean",
        authorAgentId: "agent-other",
        authorUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      {
        contentType: "image/jpeg",
        createdByAgentId: "agent-other",
        createdByUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${codeIssue.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("in_review_requires_browse_evidence");
  });
});

describe("qa browse evidence gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockWorkProductService.listForIssue.mockResolvedValue([validPR]);
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", body: "test" });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("agent → done, QA PASS but no browse evidence from QA reviewer → 422", async () => {
    // assigneeAgentId is "agent-1" so QA PASS from qa-agent-1 passes self-QA check
    const issue = { ...codeIssue, assigneeAgentId: "agent-1" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "QA: PASS — looks good from code review",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_qa_browse_evidence");
  });

  it("agent → done, QA PASS with browse commands in same comment + screenshot → 200", async () => {
    const issue = { ...codeIssue, assigneeAgentId: "agent-1" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "QA: PASS — browser-test headless http://localhost:3000 no console errors",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      {
        contentType: "image/png",
        createdByAgentId: "qa-agent-1",
        createdByUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(200);
  });

  it("agent → done, QA PASS + browse evidence in separate QA comment → 200", async () => {
    const issue = { ...codeIssue, assigneeAgentId: "agent-1" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "DOM snapshot shows the fix is applied correctly. screenshot saved to /tmp/evidence.png",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: FRESH_DATE,
      },
      {
        body: "QA: PASS — verified interactively",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      {
        contentType: "image/png",
        createdByAgentId: "qa-agent-1",
        createdByUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(200);
  });

  it("agent → done, non-code issue, QA PASS without evidence → 200 (exempt)", async () => {
    const issue = { ...nonCodeIssue, assigneeAgentId: "agent-1" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({ ...issue, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "QA: PASS — docs updated correctly",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockWorkProductService.listForIssue.mockResolvedValue([]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(200);
  });

  it("activity log records qa_evidence_gate_blocked on rejection", async () => {
    const issue = { ...codeIssue, assigneeAgentId: "agent-1" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "QA: PASS — looks good",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([]);

    const app = createAgentApp();
    await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.qa_evidence_gate_blocked",
        entityType: "issue",
        entityId: issue.id,
        details: expect.objectContaining({
          gate: "done_requires_qa_browse_evidence",
          targetStatus: "done",
        }),
      }),
    );
  });

  it("agent → done, browse evidence from different agent than QA PASS author → 422 (split-actor)", async () => {
    const issue = { ...codeIssue, assigneeAgentId: "agent-1" };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.listComments.mockResolvedValue([
      {
        body: "browser-test headless http://localhost:3000 — screenshot saved",
        authorAgentId: "agent-other",
        authorUserId: null,
        createdAt: FRESH_DATE,
      },
      {
        body: "QA: PASS — verified",
        authorAgentId: "qa-agent-1",
        authorUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);
    mockIssueService.listAttachments.mockResolvedValue([
      {
        contentType: "image/png",
        createdByAgentId: "agent-other",
        createdByUserId: null,
        createdAt: FRESH_DATE,
      },
    ]);

    const app = createAgentApp();
    const res = await request(app)
      .patch(`/api/issues/${issue.id}`)
      .send({ status: "done", comment: "Marking done" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("done_requires_qa_browse_evidence");
  });
});
