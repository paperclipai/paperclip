import express from "express";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueActionExecute = vi.hoisted(() => vi.fn());
const mockIssueActionServiceFactory = vi.hoisted(() => vi.fn(() => ({
  execute: mockIssueActionExecute,
})));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockIssueWorkflowService = vi.hoisted(() => ({
  decorateIssue: vi.fn(async (issue: unknown) => issue),
  evaluateLaneCompletion: vi.fn(async () => ({ canComplete: true, blockingReasons: [] })),
  applyTemplate: vi.fn(),
  advanceWorkflowDependents: vi.fn(async () => []),
  invalidateWorkflowDescendants: vi.fn(async () => ({ invalidatedSelf: null, invalidatedDescendants: [] })),
  handbackWorkflowLane: vi.fn(async () => null),
}));
const mockRoutineService = vi.hoisted(() => ({
  syncRunStatusForIssue: vi.fn(async () => undefined),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  hasCommentContaining: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  getAncestors: vi.fn(),
  findMentionedProjectIds: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(async () => null),
    list: vi.fn(async () => []),
  }),
  companyService: () => ({
    getById: vi.fn(async () => null),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
    listIssueDocuments: vi.fn(async () => []),
  }),
  executionGateService: () => ({
    getExecutionBlock: vi.fn(),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
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
  issueActionService: mockIssueActionServiceFactory,
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  issueWorkflowService: () => mockIssueWorkflowService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => mockRoutineService,
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/issue-merge.js", () => ({
  issueMergeService: () => ({
    getIssueMergeStatus: vi.fn(async () => null),
    attemptQaPassAutoMerge: vi.fn(async () => ({ outcome: "not_applicable" as const, status: null })),
  }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  httpLogger: {},
}));

let issueRoutesFactory!: typeof import("../routes/issues.js").issueRoutes;
let errorHandlerMiddleware!: typeof import("../middleware/index.js").errorHandler;

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

async function requestWithApp<T>(
  app: express.Express,
  run: (agent: request.SuperTest<request.Test>) => Promise<T>,
) {
  const server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await run(request(server));
  } finally {
    await closeServer(server);
  }
}

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
  app.use("/api", issueRoutesFactory({} as any, {} as any, {
    awaitAsyncPostResponseHooks: true,
  }));
  app.use(errorHandlerMiddleware);
  return app;
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "PAP-501",
    title: "Typed action test",
    description: null,
    status: "in_review",
    priority: "medium",
    assigneeAgentId: "qa-agent-1",
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
    executionState: {
      status: "idle",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    },
    createdAt: new Date("2026-04-10T00:00:00Z"),
    updatedAt: new Date("2026-04-10T00:00:00Z"),
    workflowTemplateKey: null,
    workflowLaneRole: null,
    blockedByIssueIds: [],
    parentId: null,
    projectId: null,
    executionRunId: null,
    ...overrides,
  };
}

let currentIssue: ReturnType<typeof makeIssue> | null = null;

function resetMockObject(mockObject: Record<string, { mockReset: () => unknown }>) {
  for (const value of Object.values(mockObject)) {
    value.mockReset();
  }
}

describe.sequential("issue action routes", () => {
  beforeAll(async () => {
    ({ issueRoutes: issueRoutesFactory } = await import("../routes/issues.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
  });

  beforeEach(() => {
    mockIssueActionServiceFactory.mockReset();
    mockIssueActionExecute.mockReset();
    resetMockObject(mockHeartbeatService);
    resetMockObject(mockIssueWorkflowService);
    resetMockObject(mockRoutineService);
    resetMockObject(mockIssueService);
    currentIssue = makeIssue();
    mockIssueActionServiceFactory.mockImplementation(() => ({
      execute: mockIssueActionExecute,
    }));
    mockIssueService.getById.mockImplementation(async () => currentIssue);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockHeartbeatService.reportRunActivity.mockResolvedValue(undefined);
    mockIssueWorkflowService.advanceWorkflowDependents.mockResolvedValue([]);
    mockIssueWorkflowService.invalidateWorkflowDescendants.mockResolvedValue({
      invalidatedSelf: null,
      invalidatedDescendants: [],
    });
    mockRoutineService.syncRunStatusForIssue.mockResolvedValue(undefined);
    mockIssueActionExecute.mockImplementation(async ({ issue, action }) => {
      const payload = action.payload ?? {};
      const commentBody = typeof payload.body === "string" ? payload.body : "hello";
      if (action.type === "append_note") {
        return {
          type: "append_note",
          issue,
          comment: {
            id: "comment-1",
            companyId: issue.companyId,
            issueId: issue.id,
            authorAgentId: null,
            authorUserId: "local-board",
            body: commentBody,
            createdAt: new Date("2026-04-22T10:00:00Z"),
            updatedAt: new Date("2026-04-22T10:00:00Z"),
          },
        };
      }
      if (action.type === "enter_review") {
        return {
          type: "enter_review",
          issue: { ...issue, status: "in_review", assigneeAgentId: "qa-agent-1" },
          comment: null,
        };
      }
      if (action.type === "handoff_issue") {
        return {
          type: "handoff_issue",
          issue: {
            ...issue,
            status: payload.reopen === true ? "todo" : issue.status,
            assigneeAgentId: payload.assigneeAgentId === undefined ? issue.assigneeAgentId : payload.assigneeAgentId,
            assigneeUserId: payload.assigneeUserId === undefined ? issue.assigneeUserId : payload.assigneeUserId,
          },
          comment: commentBody
            ? {
                id: "comment-handoff",
                companyId: issue.companyId,
                issueId: issue.id,
                authorAgentId: null,
                authorUserId: "local-board",
                body: commentBody,
                createdAt: new Date("2026-04-22T10:00:00Z"),
                updatedAt: new Date("2026-04-22T10:00:00Z"),
              }
            : null,
        };
      }
      if (action.type === "complete_issue") {
        return {
          type: "complete_issue",
          issue: { ...issue, status: "done" },
          comment: null,
        };
      }
      if (action.type === "reopen_issue") {
        return {
          type: "reopen_issue",
          issue: { ...issue, status: "todo" },
          comment: null,
        };
      }
      return {
        type: action.type,
        issue,
        comment: null,
      };
    });
  });

  it.sequential("dispatches typed issue actions through the action engine", async () => {
    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .post("/api/issues/11111111-1111-4111-8111-111111111111/actions")
        .send({
          type: "append_note",
          payload: {
            body: "hello",
          },
        })
    );

    expect(res.status).toBe(200);
    expect(mockIssueActionServiceFactory).toHaveBeenCalled();
    expect(res.body).toMatchObject({
      type: "append_note",
      comment: {
        body: "hello",
      },
    });
  });

  it.sequential("returns 404 when the target issue does not exist", async () => {
    currentIssue = null;

    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .post("/api/issues/11111111-1111-4111-8111-111111111111/actions")
        .send({
          type: "append_note",
          payload: {
            body: "hello",
          },
        })
    );

    expect(res.status).toBe(404);
    expect(mockIssueActionExecute).not.toHaveBeenCalled();
  });

  it.sequential("wakes the assigned QA owner when enter_review transitions the issue", async () => {
    currentIssue = makeIssue({
      status: "in_progress",
      assigneeAgentId: "engineer-1",
    });

    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .post("/api/issues/11111111-1111-4111-8111-111111111111/actions")
        .send({
          type: "enter_review",
          payload: {},
        })
    );

    expect(res.status).toBe(200);
    expect(mockRoutineService.syncRunStatusForIssue).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "qa-agent-1",
      expect.objectContaining({
        reason: "issue_assigned",
      }),
    );
  });

  it.sequential("wakes the new assignee once when handoff_issue reassigns with a comment", async () => {
    currentIssue = makeIssue({
      status: "done",
      assigneeAgentId: "qa-agent-1",
    });

    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .post("/api/issues/11111111-1111-4111-8111-111111111111/actions")
        .send({
          type: "handoff_issue",
          payload: {
            assigneeAgentId: "22222222-2222-4222-8222-222222222222",
            reopen: true,
            body: "[HANDOFF] Taking the follow-up.",
          },
        })
    );

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        reason: "issue_assigned",
      }),
    );
  });

  it.sequential("advances workflow dependents when complete_issue closes a workflow lane", async () => {
    currentIssue = makeIssue({
      status: "in_review",
      workflowTemplateKey: "delivery",
      workflowLaneRole: "engineering",
    });

    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .post("/api/issues/11111111-1111-4111-8111-111111111111/actions")
        .send({
          type: "complete_issue",
          payload: {},
        })
    );

    expect(res.status).toBe(200);
    expect(mockIssueWorkflowService.advanceWorkflowDependents).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it.sequential("invalidates workflow descendants when reopen_issue reopens a closed lane", async () => {
    currentIssue = makeIssue({
      status: "done",
      workflowTemplateKey: "delivery",
      workflowLaneRole: "engineering",
    });

    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .post("/api/issues/11111111-1111-4111-8111-111111111111/actions")
        .send({
          type: "reopen_issue",
          payload: {},
        })
    );

    expect(res.status).toBe(200);
    expect(mockIssueWorkflowService.invalidateWorkflowDescendants).toHaveBeenCalledWith({
      issueId: "11111111-1111-4111-8111-111111111111",
      invalidateSelf: true,
    });
  });

  it.sequential("rejects legacy status=in_review patches and points callers to typed actions", async () => {
    currentIssue = makeIssue({
      status: "todo",
      assigneeAgentId: "engineer-1",
    });

    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({
          status: "in_review",
          comment: "Ready for QA",
        })
    );

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      suggestedActionType: "enter_review",
    });
    expect(res.body.error).toContain('type="enter_review"');
    expect(mockIssueActionExecute).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.sequential("rejects legacy status=done patches and points callers to typed actions", async () => {
    currentIssue = makeIssue({
      status: "todo",
      assigneeAgentId: "engineer-1",
    });

    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({
          status: "done",
        })
    );

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      suggestedActionType: "complete_issue",
    });
    expect(res.body.error).toContain('type="complete_issue"');
    expect(mockIssueActionExecute).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.sequential("rejects legacy reopen patches and points callers to typed actions", async () => {
    currentIssue = makeIssue({
      status: "done",
      assigneeAgentId: "11111111-1111-4111-8111-111111111111",
    });

    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .patch("/api/issues/11111111-1111-4111-8111-111111111111")
        .send({
          comment: "Pick this back up.",
          assigneeAgentId: "22222222-2222-4222-8222-222222222222",
          status: "todo",
        })
    );

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      suggestedActionType: "handoff_issue",
    });
    expect(res.body.error).toContain('type="handoff_issue"');
    expect(mockIssueActionExecute).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.sequential("rejects canonical QA verdict comments and points callers to typed actions", async () => {
    currentIssue = makeIssue({
      status: "in_review",
      assigneeAgentId: "qa-agent-1",
    });

    const res = await requestWithApp(createApp({
      type: "agent",
      agentId: "qa-agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }), (agent) =>
      agent
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({
          body: "[CQ:pass] [EH:pass] [TC:pass] [CM:na] [DOC:na]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:na]\n[QA PASS]\n[RELEASE CONFIRMED]",
        })
    );

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      suggestedActionType: "submit_qa_verdict",
    });
    expect(res.body.error).toContain('type="submit_qa_verdict"');
    expect(mockIssueActionExecute).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it.sequential("rejects legacy reopen comments and points callers to typed actions", async () => {
    currentIssue = makeIssue({
      status: "done",
      assigneeAgentId: "engineer-1",
    });

    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({
          body: "Picking this back up.",
          reopen: true,
        })
    );

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      suggestedActionType: "reopen_issue",
    });
    expect(res.body.error).toContain('type="reopen_issue"');
    expect(mockIssueActionExecute).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it.sequential("keeps plain comments on the legacy comment path", async () => {
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-legacy",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      authorAgentId: null,
      authorUserId: "local-board",
      body: "hello from legacy",
      createdAt: new Date("2026-04-22T10:00:00Z"),
      updatedAt: new Date("2026-04-22T10:00:00Z"),
    });

    const res = await requestWithApp(createApp(), (agent) =>
      agent
        .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
        .send({
          body: "hello from legacy",
        })
    );

    expect(res.status).toBe(201);
    expect(mockIssueActionExecute).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "hello from legacy",
      expect.objectContaining({ userId: "local-board" }),
    );
  });
});
