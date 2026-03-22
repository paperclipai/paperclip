import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

// --- mocks ---

const PARENT_ISSUE = {
  id: "parent-1",
  companyId: "company-1",
  parentId: null,
  status: "in_progress",
  assigneeAgentId: "manager-agent",
  assigneeUserId: null,
  identifier: "QUA-100",
  title: "Parent task",
  checkoutRunId: null,
  executionRunId: null,
};

const CHILD_ISSUE_IN_PROGRESS = {
  id: "child-1",
  companyId: "company-1",
  parentId: "parent-1",
  status: "in_progress",
  assigneeAgentId: "worker-agent",
  assigneeUserId: null,
  identifier: "QUA-101",
  title: "Child subtask",
  checkoutRunId: "run-worker",
  executionRunId: "run-worker",
};

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  checkout: vi.fn(),
  release: vi.fn(),
  delete: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAncestors: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  assertPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  listByIssue: vi.fn(),
  getByKey: vi.fn(),
  upsertIssueDocument: vi.fn(),
  getRevisions: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  heartbeatService: () => mockHeartbeatService,
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  projectService: () => mockProjectService,
  goalService: () => mockGoalService,
  issueApprovalService: () => mockIssueApprovalService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  workProductService: () => mockWorkProductService,
  documentService: () => mockDocumentService,
  logActivity: mockLogActivity,
}));

function createApp(actor: { type: string; agentId?: string; runId?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actor.type === "agent") {
      (req as any).actor = {
        type: "agent",
        agentId: actor.agentId ?? null,
        companyId: "company-1",
        keyId: undefined,
        runId: actor.runId ?? null,
        source: "agent_jwt",
      };
    } else {
      (req as any).actor = {
        type: "board",
        userId: "user-1",
        companyIds: ["company-1"],
        source: "local_implicit",
        isInstanceAdmin: true,
      };
    }
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("subtask completion wakes parent assignee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockLogActivity.mockResolvedValue(undefined);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("wakes parent assignee when subtask status changes to done", async () => {
    // existing child issue is in_progress
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === "child-1") return CHILD_ISSUE_IN_PROGRESS;
      if (id === "parent-1") return PARENT_ISSUE;
      return null;
    });
    // after update, child is done
    mockIssueService.update.mockResolvedValue({
      ...CHILD_ISSUE_IN_PROGRESS,
      status: "done",
    });
    // checkout ownership check passes for the agent
    mockIssueService.assertCheckoutOwner.mockResolvedValue(CHILD_ISSUE_IN_PROGRESS);

    const app = createApp({
      type: "agent",
      agentId: "worker-agent",
      runId: "run-worker",
    });

    const res = await request(app)
      .patch("/api/issues/child-1")
      .send({ status: "done" });

    expect(res.status).toBe(200);

    // Give the async wakeup closure time to execute
    await vi.waitFor(() => {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "manager-agent",
        expect.objectContaining({
          reason: "subtask_completed",
          payload: expect.objectContaining({
            issueId: "parent-1",
            subtaskId: "child-1",
          }),
        }),
      );
    });
  });

  it("wakes parent assignee when subtask status changes to cancelled", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === "child-1") return CHILD_ISSUE_IN_PROGRESS;
      if (id === "parent-1") return PARENT_ISSUE;
      return null;
    });
    mockIssueService.update.mockResolvedValue({
      ...CHILD_ISSUE_IN_PROGRESS,
      status: "cancelled",
    });
    mockIssueService.assertCheckoutOwner.mockResolvedValue(CHILD_ISSUE_IN_PROGRESS);

    const app = createApp({
      type: "agent",
      agentId: "worker-agent",
      runId: "run-worker",
    });

    const res = await request(app)
      .patch("/api/issues/child-1")
      .send({ status: "cancelled" });

    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "manager-agent",
        expect.objectContaining({
          reason: "subtask_completed",
          payload: expect.objectContaining({
            issueId: "parent-1",
            subtaskId: "child-1",
          }),
        }),
      );
    });
  });

  it("does not wake parent when subtask moves to a non-terminal status", async () => {
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === "child-1") return { ...CHILD_ISSUE_IN_PROGRESS, status: "todo" };
      if (id === "parent-1") return PARENT_ISSUE;
      return null;
    });
    mockIssueService.update.mockResolvedValue({
      ...CHILD_ISSUE_IN_PROGRESS,
      status: "in_progress",
    });
    mockIssueService.assertCheckoutOwner.mockResolvedValue({
      ...CHILD_ISSUE_IN_PROGRESS,
      status: "todo",
    });

    const app = createApp({
      type: "agent",
      agentId: "worker-agent",
      runId: "run-worker",
    });

    const res = await request(app)
      .patch("/api/issues/child-1")
      .send({ status: "in_progress" });

    expect(res.status).toBe(200);

    // Small delay to ensure async wakeup would have fired
    await new Promise((r) => setTimeout(r, 50));

    // Parent should NOT be woken
    const wakeupCalls = mockHeartbeatService.wakeup.mock.calls;
    const parentWake = wakeupCalls.find(
      ([agentId]: [string]) => agentId === "manager-agent",
    );
    expect(parentWake).toBeUndefined();
  });

  it("does not wake parent when issue has no parentId", async () => {
    const rootIssue = { ...CHILD_ISSUE_IN_PROGRESS, parentId: null, id: "root-1" };
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === "root-1") return rootIssue;
      return null;
    });
    mockIssueService.update.mockResolvedValue({
      ...rootIssue,
      status: "done",
    });
    mockIssueService.assertCheckoutOwner.mockResolvedValue(rootIssue);

    const app = createApp({
      type: "agent",
      agentId: "worker-agent",
      runId: "run-worker",
    });

    const res = await request(app)
      .patch("/api/issues/root-1")
      .send({ status: "done" });

    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));

    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("does not double-wake when parent assignee is already in the wakeup map", async () => {
    // Parent assignee is "manager-agent", and there's a comment that @-mentions manager-agent
    // The dedup logic (wakeups.has) should prevent a second wakeup entry.
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === "child-1") return CHILD_ISSUE_IN_PROGRESS;
      if (id === "parent-1") return PARENT_ISSUE;
      return null;
    });
    mockIssueService.update.mockResolvedValue({
      ...CHILD_ISSUE_IN_PROGRESS,
      status: "done",
    });
    mockIssueService.assertCheckoutOwner.mockResolvedValue(CHILD_ISSUE_IN_PROGRESS);
    // Simulate @-mention of manager-agent in comment
    mockIssueService.findMentionedAgents.mockResolvedValue(["manager-agent"]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      body: "Done! @manager-agent",
      issueId: "child-1",
      authorAgentId: "worker-agent",
      authorUserId: null,
      companyId: "company-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const app = createApp({
      type: "agent",
      agentId: "worker-agent",
      runId: "run-worker",
    });

    const res = await request(app)
      .patch("/api/issues/child-1")
      .send({ status: "done", comment: "Done! @manager-agent" });

    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(mockHeartbeatService.wakeup).toHaveBeenCalled();
    });

    // manager-agent should be woken exactly once (mention OR subtask_completed, not both)
    const managerWakes = mockHeartbeatService.wakeup.mock.calls.filter(
      ([agentId]: [string]) => agentId === "manager-agent",
    );
    expect(managerWakes.length).toBe(1);
  });
});
