import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getHeartbeatPolicy: vi.fn(async () => ({ enabled: true, intervalSec: 0, wakeOnDemand: true, wakeOnComment: true, maxConcurrentRuns: 1 })),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
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

function makeIssue(status: "todo" | "done") {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    status,
    assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-580",
    title: "Comment reopen default",
  };
}

describe("issue comment reopen routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      companyId: "company-1",
      body: "hello",
      createdAt: new Date(),
      updatedAt: new Date(),
      authorAgentId: null,
      authorUserId: "local-board",
    });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
  });

  it("treats reopen=true as a no-op when the issue is already open", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reopened: true }),
      }),
    );
  });

  describe("wakeOnComment policy", () => {
    // The POST /issues/:id/comments route fires assignee wakes in a void async
    // block after responding. A short flush lets those promises settle.
    const flush = () => new Promise((r) => setTimeout(r, 50));

    it("suppresses assignee wake when wakeOnComment is false", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
      mockHeartbeatService.getHeartbeatPolicy.mockResolvedValue({
        enabled: true, intervalSec: 0, wakeOnDemand: true, wakeOnComment: false, maxConcurrentRuns: 1,
      });

      const res = await request(createApp())
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({ body: "looks good, approved" });

      expect(res.status).toBe(201);
      await flush();
      // No wake should have been enqueued for the assignee
      expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    });

    it("still wakes assignee when wakeOnComment is true (default)", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
      mockHeartbeatService.getHeartbeatPolicy.mockResolvedValue({
        enabled: true, intervalSec: 0, wakeOnDemand: true, wakeOnComment: true, maxConcurrentRuns: 1,
      });

      const res = await request(createApp())
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({ body: "revision needed" });

      expect(res.status).toBe(201);
      await flush();
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "22222222-2222-4222-8222-222222222222",
        expect.objectContaining({ reason: "issue_commented" }),
      );
    });

    it("falls back to waking when getHeartbeatPolicy returns null", async () => {
      mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
      mockHeartbeatService.getHeartbeatPolicy.mockResolvedValue(null);

      const res = await request(createApp())
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({ body: "hello" });

      expect(res.status).toBe(201);
      await flush();
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        "22222222-2222-4222-8222-222222222222",
        expect.objectContaining({ reason: "issue_commented" }),
      );
    });

    it("still delivers @-mention wakes even when wakeOnComment is false", async () => {
      const mentionedAgentId = "33333333-3333-4333-8333-333333333333";
      mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
      mockHeartbeatService.getHeartbeatPolicy.mockResolvedValue({
        enabled: true, intervalSec: 0, wakeOnDemand: true, wakeOnComment: false, maxConcurrentRuns: 1,
      });
      mockIssueService.findMentionedAgents.mockResolvedValue([mentionedAgentId]);

      const res = await request(createApp())
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({ body: "hey @SomeAgent check this" });

      expect(res.status).toBe(201);
      await flush();
      // Assignee wake suppressed, but @-mention wake fires
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
      expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
        mentionedAgentId,
        expect.objectContaining({ reason: "issue_comment_mentioned" }),
      );
    });
  });

  it("reopens closed issues via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111", {
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      status: "todo",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.objectContaining({
          reopened: true,
          reopenedFrom: "done",
          status: "todo",
        }),
      }),
    );
  });
});
