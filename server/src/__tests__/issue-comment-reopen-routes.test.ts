import express from "express";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getRelationSummaries: vi.fn(),
  listAttachments: vi.fn(),
  listComments: vi.fn(),
  findMentionedAgents: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockExecutionGateService = vi.hoisted(() => ({
  getExecutionBlock: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueWorkflowService = vi.hoisted(() => ({
  decorateIssue: vi.fn(async (issue: unknown) => issue),
  evaluateLaneCompletion: vi.fn(async () => ({ canComplete: true, blockingReasons: [], artifactStatuses: [] })),
  applyTemplate: vi.fn(),
  advanceWorkflowDependents: vi.fn(async () => []),
  invalidateWorkflowDescendants: vi.fn(async () => ({ invalidatedSelf: null, invalidatedDescendants: [] })),
  handbackWorkflowLane: vi.fn(async () => null),
}));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));
const mockTx = vi.hoisted(() => ({
  insert: mockTxInsert,
}));
const mockDb = vi.hoisted(() => ({
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
    listIssueDocuments: vi.fn(async () => []),
  }),
  executionGateService: () => mockExecutionGateService,
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => mockHeartbeatService,
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({
      id: "instance-settings-1",
      general: {
        censorUsernameInLogs: false,
        feedbackDataSharingPreference: "prompt",
      },
    })),
    listCompanyIds: vi.fn(async () => ["company-1"]),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  issueWorkflowService: () => mockIssueWorkflowService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function sendIssueRouteRequest(
  app: express.Express,
  action: (agent: request.SuperTest<request.Test>) => Promise<request.Response>,
) {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await action(request(server));
  } finally {
    await closeServer(server);
  }
}

function makeIssue(status: "todo" | "done" | "cancelled") {
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

describe.sequential("issue comment reopen routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.listComments.mockReset();
    mockHeartbeatService.getRun.mockReset();
    mockHeartbeatService.getActiveRunForAgent.mockReset();
    mockHeartbeatService.cancelRun.mockReset();
    mockAgentService.getById.mockImplementation(async (id: string) => ({
      id,
      companyId: "company-1",
      role: id === "agent-qa" ? "qa" : "pm",
      name: "Operator",
    }));
    mockAgentService.list.mockResolvedValue([]);
    mockIssueWorkflowService.decorateIssue.mockImplementation(async (issue: unknown) => issue);
    mockIssueWorkflowService.evaluateLaneCompletion.mockResolvedValue({
      canComplete: true,
      blockingReasons: [],
      artifactStatuses: [],
    });
    mockIssueWorkflowService.applyTemplate.mockReset();
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([]);
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
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it.sequential("treats reopen=true as a no-op when the issue is already open", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("todo"),
      ...patch,
    }));

    const res = await sendIssueRouteRequest(createApp(), (agent) =>
      agent
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" }),
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.update.mock.calls[0]?.[0]).toBe("11111111-1111-4111-8111-111111111111");
    expect(mockIssueService.update.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
        details: expect.not.objectContaining({ reopened: true }),
      }),
    );
  });

  it.sequential("reopens closed issues via the PATCH comment path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue("done"),
      ...patch,
    }));

    const res = await sendIssueRouteRequest(createApp(), (agent) =>
      agent
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({ comment: "hello", reopen: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" }),
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        assigneeAgentId: "33333333-3333-4333-8333-333333333333",
        status: "todo",
        actorAgentId: null,
        actorUserId: "local-board",
      }),
    );
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

  it.sequential("rejects agent PATCH comments on closed issues unless reopening", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    const app = createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await sendIssueRouteRequest(app, (agent) =>
      agent
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({ comment: "still working" }),
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Issue is closed. Reopen it before posting agent updates." });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it.sequential("rejects agent POST comments on closed issues unless reopening", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    const app = createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await sendIssueRouteRequest(app, (agent) =>
      agent
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({ body: "still working" }),
    );

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Issue is closed. Reopen it before posting agent updates." });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it.sequential("does not wake assignees when reassignment keeps the issue cancelled", async () => {
    const issue = makeIssue("cancelled");
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
    });

    const res = await sendIssueRouteRequest(createApp(), (agent) =>
      agent
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({ assigneeAgentId: "33333333-3333-4333-8333-333333333333" }),
    );

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it.sequential("interrupts an active run before a combined comment update", async () => {
    const issue = {
      ...makeIssue("todo"),
      executionRunId: "run-1",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue,
      ...patch,
    }));
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
    });
    mockHeartbeatService.cancelRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "cancelled",
    });

    const res = await sendIssueRouteRequest(createApp(), (agent) =>
      agent
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({ comment: "hello", interrupt: true, assigneeAgentId: "33333333-3333-4333-8333-333333333333" }),
    );

    expect(res.status).toBe(200);
    expect(
      mockHeartbeatService.getRun.mock.calls.some(([runId]) => runId === "run-1")
      || mockHeartbeatService.getActiveRunForAgent.mock.calls.some(
        ([agentId]) => agentId === "22222222-2222-4222-8222-222222222222",
      ),
    ).toBe(true);
    expect(mockHeartbeatService.cancelRun).toHaveBeenCalledWith("run-1");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "heartbeat.cancelled",
        details: expect.objectContaining({
          source: "issue_comment_interrupt",
          issueId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it.sequential("rewrites recovery-source completion comments from successor-scoped runs to make the relationship explicit", async () => {
    const sourceIssue = {
      ...makeIssue("blocked" as any),
      id: "11111111-1111-4111-8111-111111111111",
      identifier: "COMA-1094",
      status: "blocked",
      recoverySuccessor: {
        id: "33333333-3333-4333-8333-333333333333",
        identifier: "COMA-1120",
        title: "QA successor",
      },
    };
    const successorIssue = {
      ...makeIssue("done" as any),
      id: "33333333-3333-4333-8333-333333333333",
      identifier: "COMA-1120",
      status: "done",
      recoverySource: {
        id: sourceIssue.id,
        identifier: sourceIssue.identifier,
        title: sourceIssue.title,
      },
    };
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === sourceIssue.id) return sourceIssue;
      if (id === successorIssue.id) return successorIssue;
      return null;
    });
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-qa-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
      contextSnapshot: {
        issueId: successorIssue.id,
      },
    });

    const app = createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-qa-1",
    });

    const res = await sendIssueRouteRequest(app, (agent) =>
      agent
        .post(`/api/issues/${sourceIssue.id}/comments`)
        .send({
          body: "QA Runner completed 33333333-3333-4333-8333-333333333333. COMA-1120 closed as done.",
        }),
    );

    expect(res.status).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      sourceIssue.id,
      expect.stringContaining("Successor issue COMA-1120 completed."),
      expect.objectContaining({
        agentId: "22222222-2222-4222-8222-222222222222",
        runId: "run-qa-1",
      }),
    );
    const persistedBody = mockIssueService.addComment.mock.calls[0]?.[1] as string;
    expect(persistedBody).toContain("COMA-1094 remains blocked as the recovery source.");
    expect(persistedBody).toContain("Original note:");
    expect(persistedBody).toContain("COMA-1120 closed as done.");
  });

  it.sequential("rewrites recovery-source completion comments on issue patch mutations too", async () => {
    const sourceIssue = {
      ...makeIssue("todo"),
      id: "11111111-1111-4111-8111-111111111111",
      identifier: "COMA-1094",
      status: "blocked",
      recoverySuccessor: {
        id: "33333333-3333-4333-8333-333333333333",
        identifier: "COMA-1120",
        title: "QA successor",
      },
    };
    const successorIssue = {
      ...makeIssue("done"),
      id: "33333333-3333-4333-8333-333333333333",
      identifier: "COMA-1120",
      status: "done",
      recoverySource: {
        id: sourceIssue.id,
        identifier: sourceIssue.identifier,
        title: sourceIssue.title,
      },
    };
    mockIssueService.getById.mockImplementation(async (id: string) => {
      if (id === sourceIssue.id) return sourceIssue;
      if (id === successorIssue.id) return successorIssue;
      return null;
    });
    mockIssueService.update.mockResolvedValue(sourceIssue);
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-qa-1",
      companyId: "company-1",
      agentId: "22222222-2222-4222-8222-222222222222",
      status: "running",
      contextSnapshot: {
        issueId: successorIssue.id,
      },
    });

    const app = createApp({
      type: "agent",
      agentId: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-qa-1",
    });

    const res = await sendIssueRouteRequest(app, (agent) =>
      agent
        .patch(`/api/issues/${sourceIssue.id}`)
        .send({
          comment: "QA Runner completed 33333333-3333-4333-8333-333333333333. COMA-1120 closed as done.",
        }),
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      sourceIssue.id,
      expect.stringContaining("Successor issue COMA-1120 completed."),
      expect.objectContaining({
        agentId: "22222222-2222-4222-8222-222222222222",
        runId: "run-qa-1",
      }),
    );
    const persistedBody = mockIssueService.addComment.mock.calls[0]?.[1] as string;
    expect(persistedBody).toContain("COMA-1094 remains blocked as the recovery source.");
    expect(persistedBody).toContain("Original note:");
    expect(persistedBody).toContain("COMA-1120 closed as done.");
  });

  it.sequential("writes decision ids into executionState when completing an approval stage", async () => {
    const policy = normalizeIssueExecutionPolicy({
      stages: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          type: "approval",
          participants: [{ type: "user", userId: "local-board" }],
        },
      ],
    })!;
    const issue = {
      ...makeIssue("todo"),
      status: "in_review",
      assigneeAgentId: "agent-qa",
      assigneeUserId: null,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: policy.stages[0].id,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "user", agentId: null, userId: "local-board" },
        returnAssignee: { type: "agent", agentId: "22222222-2222-4222-8222-222222222222", userId: null },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockAgentService.getById.mockImplementation(async (id: string) => ({
      id,
      companyId: "company-1",
      role: id === "agent-qa" ? "qa" : "pm",
      name: id === "agent-qa" ? "QA and Release Engineer" : "Operator",
    }));
    mockAgentService.list.mockResolvedValue([
      {
        id: "agent-qa",
        companyId: "company-1",
        role: "qa",
        name: "QA and Release Engineer",
        status: "idle",
      },
    ]);
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>, tx?: unknown) => ({
      ...issue,
      ...patch,
      executionState: patch.executionState,
      status: "done",
      completedAt: new Date(),
      updatedAt: new Date(),
      _tx: tx,
    }));
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "qa-comment-1",
        companyId: "company-1",
        issueId: "11111111-1111-4111-8111-111111111111",
        authorAgentId: "agent-qa",
        authorUserId: null,
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const res = await sendIssueRouteRequest(createApp(), (agent) =>
      agent
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({ status: "done", comment: "Approved for ship" }),
    );

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        executionState: expect.objectContaining({
          status: "completed",
          lastDecisionId: expect.any(String),
          lastDecisionOutcome: "approved",
        }),
      }),
      mockTx,
    );
  });
});
