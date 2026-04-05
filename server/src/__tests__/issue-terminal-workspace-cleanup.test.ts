import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

// ---------------------------------------------------------------------------
// Mock: issue-assignment-wakeup (imported by issues route)
// ---------------------------------------------------------------------------

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Mock: issues-checkout-wakeup (imported by issues route)
// ---------------------------------------------------------------------------

vi.mock("../routes/issues-checkout-wakeup.js", () => ({
  shouldWakeAssigneeOnCheckout: vi.fn(() => false),
}));

// ---------------------------------------------------------------------------
// Mock: services/index.js
// ---------------------------------------------------------------------------

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

const mockArchiveTerminalIssueExecutionWorkspace = vi.hoisted(() =>
  vi.fn(async () => ({ archived: true, warnings: [] })),
);

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  archiveTerminalIssueExecutionWorkspace: mockArchiveTerminalIssueExecutionWorkspace,
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({ getById: vi.fn() }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createApp() {
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

const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    companyId: "company-1",
    status: "in_progress",
    assigneeAgentId: "33333333-3333-4333-8333-333333333333",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "AET-99",
    title: "Test issue",
    executionWorkspaceId: WORKSPACE_ID,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: issue PATCH terminal-state → execution workspace archive
// ---------------------------------------------------------------------------

describe("issue terminal-state workspace cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("PATCH issue to done → triggers archive for linked execution workspace", async () => {
    const existing = makeIssue({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });

    const res = await request(createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockArchiveTerminalIssueExecutionWorkspace).toHaveBeenCalledWith({
        executionWorkspaceId: WORKSPACE_ID,
        companyId: "company-1",
        actor: { actorType: "user", actorId: "local-board", agentId: null, runId: null },
      });
    });
  });

  it("PATCH issue to cancelled → triggers archive for linked execution workspace", async () => {
    const existing = makeIssue({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "cancelled" });

    const res = await request(createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockArchiveTerminalIssueExecutionWorkspace).toHaveBeenCalledWith({
        executionWorkspaceId: WORKSPACE_ID,
        companyId: "company-1",
        actor: { actorType: "user", actorId: "local-board", agentId: null, runId: null },
      });
    });
  });

  it("PATCH issue to done with no execution workspace → no archive triggered, no error", async () => {
    const existing = makeIssue({ status: "in_progress", executionWorkspaceId: null });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });

    const res = await request(createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockArchiveTerminalIssueExecutionWorkspace).not.toHaveBeenCalled();
  });

  it("PATCH issue to in_progress → no archive triggered", async () => {
    const existing = makeIssue({ status: "todo" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "in_progress" });

    const res = await request(createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);
    expect(mockArchiveTerminalIssueExecutionWorkspace).not.toHaveBeenCalled();
  });

  it("PATCH already-done issue (e.g. add comment) → no re-archive triggered", async () => {
    const existing = makeIssue({ status: "done" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing });
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: ISSUE_ID,
      companyId: "company-1",
      body: "follow-up note",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });

    const res = await request(createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ comment: "follow-up note" });

    expect(res.status).toBe(200);
    expect(mockArchiveTerminalIssueExecutionWorkspace).not.toHaveBeenCalled();
  });

  it("archive failure does not affect HTTP response", async () => {
    mockArchiveTerminalIssueExecutionWorkspace.mockRejectedValueOnce(new Error("cleanup exploded"));
    const existing = makeIssue({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });

    const res = await request(createApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done" });

    // HTTP response succeeds even when archive fails (fire-and-forget)
    expect(res.status).toBe(200);
  });
});
