import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT_ID = "33333333-3333-4333-8333-333333333333";
const ISSUE_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getById: vi.fn(),
  listAttachments: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));

const mockDocumentService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
  wakeup: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => mockDocumentService,
  executionWorkspaceService: () => ({}),
  goalService: () => ({}),
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({}),
  workProductService: () => ({
    createForIssue: vi.fn(),
    getById: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
  }),
}));

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: ACTOR_AGENT_ID,
      companyId: COMPANY_ID,
      runId: RUN_ID,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function createAgentAppWithoutRun() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: ACTOR_AGENT_ID,
      companyId: COMPANY_ID,
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
      userId: "board-user",
      companyIds: [COMPANY_ID],
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue agent mutation guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("blocks an agent from patching another agent's issue", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "todo",
      assigneeAgentId: OTHER_AGENT_ID,
      assigneeUserId: null,
      createdByAgentId: OTHER_AGENT_ID,
      createdByUserId: null,
    });

    const res = await request(createAgentApp())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Agents can only mutate their own assigned issues" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("requires a live run id for mutating an assigned issue", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "blocked",
      assigneeAgentId: ACTOR_AGENT_ID,
      assigneeUserId: null,
      createdByAgentId: OTHER_AGENT_ID,
      createdByUserId: null,
    });

    const res = await request(createAgentAppWithoutRun())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Agent run id required" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("requires a live run id for mutating an agent-created draft issue", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByAgentId: ACTOR_AGENT_ID,
      createdByUserId: null,
    });

    const res = await request(createAgentAppWithoutRun())
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ title: "Updated draft title" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Agent run id required" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("blocks an agent from overwriting an issue document on someone else's issue", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "todo",
      assigneeAgentId: OTHER_AGENT_ID,
      assigneeUserId: null,
      createdByAgentId: OTHER_AGENT_ID,
      createdByUserId: null,
    });

    const res = await request(createAgentApp())
      .put(`/api/issues/${ISSUE_ID}/documents/plan`)
      .send({
        title: "Plan",
        format: "markdown",
        body: "# Plan",
        baseRevisionId: null,
      });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Agents can only mutate their own assigned issues" });
    expect(mockDocumentService.upsertIssueDocument).not.toHaveBeenCalled();
  });

  it("allows a mention-triggered agent run to comment on another agent's issue", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      identifier: "NOV-11",
      title: "Delegated work",
      status: "blocked",
      assigneeAgentId: OTHER_AGENT_ID,
      assigneeUserId: null,
      createdByAgentId: OTHER_AGENT_ID,
      createdByUserId: null,
      executionRunId: null,
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: RUN_ID,
      agentId: ACTOR_AGENT_ID,
      status: "running",
      contextSnapshot: {
        issueId: ISSUE_ID,
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
      },
    });
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-2",
      issueId: ISSUE_ID,
      body: "Here is the requested input.",
      createdAt: new Date("2026-03-21T03:30:00.000Z"),
    });

    const res = await request(createAgentApp())
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Here is the requested input." });

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      ISSUE_ID,
      "Here is the requested input.",
      expect.objectContaining({ agentId: ACTOR_AGENT_ID }),
    );
  });

  it("blocks a stale mention-triggered run from commenting on another agent's issue", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      identifier: "NOV-11",
      title: "Delegated work",
      status: "blocked",
      assigneeAgentId: OTHER_AGENT_ID,
      assigneeUserId: null,
      createdByAgentId: OTHER_AGENT_ID,
      createdByUserId: null,
      executionRunId: null,
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: RUN_ID,
      agentId: ACTOR_AGENT_ID,
      status: "succeeded",
      contextSnapshot: {
        issueId: ISSUE_ID,
        wakeReason: "issue_comment_mentioned",
        wakeCommentId: "comment-1",
      },
    });

    const res = await request(createAgentApp())
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Here is the requested input." });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Agents can only mutate their own assigned issues" });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("still blocks a mention-triggered agent run from reopening another agent's issue", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "done",
      assigneeAgentId: OTHER_AGENT_ID,
      assigneeUserId: null,
      createdByAgentId: OTHER_AGENT_ID,
      createdByUserId: null,
    });

    const res = await request(createAgentApp())
      .post(`/api/issues/${ISSUE_ID}/comments`)
      .send({ body: "Please reopen this.", reopen: true });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Agents can only mutate their own assigned issues" });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("blocks agents from deleting issues", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
    });

    const res = await request(createAgentApp()).delete(`/api/issues/${ISSUE_ID}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board authentication required" });
    expect(mockIssueService.remove).not.toHaveBeenCalled();
  });

  it("still allows board users to delete issues", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
    });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.remove.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
    });

    const res = await request(createBoardApp()).delete(`/api/issues/${ISSUE_ID}`);

    expect(res.status).toBe(200);
    expect(mockIssueService.remove).toHaveBeenCalledWith(ISSUE_ID);
  });
});
