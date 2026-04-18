import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const AGENT_1 = "aaaa0001-0001-4001-8001-000000000001";
const TASK_ID = "b0000000-0000-4000-8000-000000000002";
const INITIATIVE_ID = "a0000000-0000-4000-8000-000000000001";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getCommentCursor: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  findMentionedAgents: vi.fn(),
  hasReachedStatus: vi.fn(),
  getActiveChildCount: vi.fn(),
  countRecentByAgent: vi.fn(),
  getDepartmentLabelIds: vi.fn(),
  findDepartmentDuplicate: vi.fn(),
  getIssueTypeById: vi.fn(),
  getLabelsByIssueId: vi.fn(),
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
    hasPermission: vi.fn(async (_c: string, _kind: string, _id: string, key: string) => key !== "tickets:bypass_authoring_gates"),
  }),
  agentService: () => ({
    getById: vi.fn(async () => ({
      id: AGENT_1,
      companyId: "company-1",
      name: "Engineer",
      role: "engineer",
      status: "active",
      pauseReason: null,
      permissions: { canCreateAgents: false },
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

// Minimal db mock for inline queries in the route handler
const mockDbQuery = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue([]),
};
const mockDb = { select: vi.fn(() => mockDbQuery) } as any;

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    companyId: "company-1",
    identifier: "DLD-200",
    title: "Test task",
    description: null,
    status: "in_progress",
    priority: "medium",
    issueType: "task",
    projectId: null,
    goalId: null,
    parentId: INITIATIVE_ID,
    assigneeAgentId: AGENT_1,
    assigneeUserId: null,
    createdByUserId: null,
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
    hiddenAt: null,
    updatedAt: new Date("2026-04-10T12:00:00Z"),
    ...overrides,
  };
}

function makeInitiative(overrides: Record<string, unknown> = {}) {
  return {
    ...makeTask(),
    id: INITIATIVE_ID,
    identifier: "DLD-100",
    title: "Test initiative",
    issueType: "initiative",
    parentId: null,
    ...overrides,
  };
}

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: AGENT_1,
      companyId: "company-1",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb, {} as any));
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

describe("cancellation replacement gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockWorkProductService.listForIssue.mockResolvedValue([]);
  });

  it("agent cancels task with comment but no reference -> 422 cancellation_replacement_required", async () => {
    const task = makeTask({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(task);

    const res = await request(createAgentApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "cancelled", comment: "This work is no longer needed" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("cancellation_replacement_required");
  });

  it("agent cancels task with DLD-456 in comment -> allowed", async () => {
    const task = makeTask({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(task);
    mockIssueService.update.mockResolvedValue({ ...task, status: "cancelled" });
    mockIssueService.addComment.mockResolvedValue({ id: "c-1", body: "Replaced by DLD-456" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "cancelled", comment: "Replaced by DLD-456" });

    expect(res.body.gate).not.toBe("cancellation_replacement_required");
  });

  it("agent cancels task with no-replacement-needed in comment -> allowed", async () => {
    const task = makeTask({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(task);
    mockIssueService.update.mockResolvedValue({ ...task, status: "cancelled" });
    mockIssueService.addComment.mockResolvedValue({ id: "c-2", body: "Scope removed, no-replacement-needed" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "cancelled", comment: "Scope removed, no-replacement-needed" });

    expect(res.body.gate).not.toBe("cancellation_replacement_required");
  });

  it("agent cancels task with No-Replacement-Needed (case insensitive) -> allowed", async () => {
    const task = makeTask({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(task);
    mockIssueService.update.mockResolvedValue({ ...task, status: "cancelled" });
    mockIssueService.addComment.mockResolvedValue({ id: "c-3", body: "No-Replacement-Needed -- out of scope" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "cancelled", comment: "No-Replacement-Needed -- out of scope" });

    expect(res.body.gate).not.toBe("cancellation_replacement_required");
  });

  it("board user cancels task without reference -> allowed (bypass)", async () => {
    const task = makeTask({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(task);
    mockIssueService.update.mockResolvedValue({ ...task, status: "cancelled" });

    const res = await request(createBoardApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "cancelled" });

    expect(res.body.gate).not.toBe("cancellation_replacement_required");
  });

  it("agent transitions task to non-cancelled status -> gate does not fire", async () => {
    const task = makeTask({ status: "in_progress", assigneeAgentId: "agent-other", executionWorkspaceId: null });
    mockIssueService.getById.mockResolvedValue(task);
    mockIssueService.update.mockResolvedValue({ ...task, status: "in_review" });
    mockIssueService.addComment.mockResolvedValue({ id: "c-4", body: "Ready for review" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "in_review", comment: "Ready for review" });

    expect(res.body.gate).not.toBe("cancellation_replacement_required");
  });

  it("agent cancels initiative -> gate does not fire (tasks only)", async () => {
    const initiative = makeInitiative({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(initiative);
    mockIssueService.getActiveChildCount.mockResolvedValue({ count: 0, identifiers: [] });
    mockIssueService.update.mockResolvedValue({ ...initiative, status: "cancelled" });
    mockIssueService.addComment.mockResolvedValue({ id: "c-5", body: "Shutting this down" });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${initiative.id}`)
      .send({ status: "cancelled", comment: "Shutting this down" });

    expect(res.body.gate).not.toBe("cancellation_replacement_required");
  });

  it("agent cancels task without comment -> hits comment_required, not this gate", async () => {
    const task = makeTask({ status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(task);

    const res = await request(createAgentApp())
      .patch(`/api/issues/${task.id}`)
      .send({ status: "cancelled" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("comment_required");
  });
});
