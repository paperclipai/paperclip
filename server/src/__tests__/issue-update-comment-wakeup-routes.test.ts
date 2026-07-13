import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ASSIGNEE_AGENT_ID = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
  list: vi.fn(async () => []),
  resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
    ambiguous: false,
    agent: { id: raw },
  })),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => mockAgentService,
  budgetService: () => ({
    upsertPolicy: vi.fn(async () => undefined),
  }),
  documentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
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
  issueVisibilityService: () => ({
    ensureCollaborator: vi.fn(async () => undefined),
    resolveMentionsToCollaborators: vi.fn(async () => undefined),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueService: () => mockIssueService,
  issueThreadInteractionService: () => mockIssueThreadInteractionService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  webPushService: () => ({
    sendToUser: vi.fn(async () => undefined),
    listSubscriptionsForUser: vi.fn(async () => []),
    sendNotificationToSubscription: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => mockAgentService,
    budgetService: () => ({
      upsertPolicy: vi.fn(async () => undefined),
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
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
    issueVisibilityService: () => ({
      ensureCollaborator: vi.fn(async () => undefined),
      resolveMentionsToCollaborators: vi.fn(async () => undefined),
    }),
    issueApprovalService: () => ({}),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [],
        removedReferencedIssues: [],
        currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    webPushService: () => ({
      sendToUser: vi.fn(async () => undefined),
      listSubscriptionsForUser: vi.fn(async () => []),
      sendNotificationToSubscription: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

async function createApp(actorOverride?: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actorOverride ?? {
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

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: "local-board",
    createdByUserId: "local-board",
    identifier: "PAP-999",
    title: "Wake test",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

describe("issue update comment wakeups", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.update.mockReset();
    mockIssueService.list.mockResolvedValue([]);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockAgentService.getById.mockResolvedValue(null);
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: { id: raw, companyId: "company-1", name: raw, status: "idle", role: "general" },
    }));
  });

  it("wakes assignees when an agent creates a delegated child issue under unfinished parent work", async () => {
    const parent = makeIssue({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "in_progress",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      assigneeUserId: null,
    });
    const created = makeIssue({
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      parentId: parent.id,
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "todo",
    });

    mockIssueService.create.mockResolvedValue(created);
    mockIssueService.getById.mockResolvedValue(parent);

    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Delegated implementation task",
        parentId: parent.id,
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        status: "todo",
      });

    expect(res.status).toBe(201);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: created.id,
          mutation: "create",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: created.id,
          source: "issue.create",
        }),
      }),
    );
  });

  it("includes the new comment in assignment wakes from issue updates", async () => {
    const existing = makeIssue();
    const updated = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-1",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "write the whole thing",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        assigneeAgentId: ASSIGNEE_AGENT_ID,
        assigneeUserId: null,
        comment: "write the whole thing",
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-1",
          mutation: "update",
          assignmentHandoff: true,
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-1",
          wakeCommentId: "comment-1",
          source: "issue.update",
          assignmentHandoff: true,
        }),
      }),
    );
  });

  it("wakes the assignee on comment-only issue updates", async () => {
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    const updated = { ...existing };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(updated);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-2",
      issueId: existing.id,
      companyId: existing.companyId,
      body: "please revise this",
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        comment: "please revise this",
      });

    expect(res.status).toBe(200);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        source: "automation",
        reason: "issue_commented",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-2",
          mutation: "comment",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          taskId: existing.id,
          commentId: "comment-2",
          wakeCommentId: "comment-2",
          wakeReason: "issue_commented",
          source: "issue.comment",
        }),
      }),
    );
  });

  it("treats AI agent mentions as references and wakes only the current assignee", async () => {
    const mentionedAgentId = "33333333-3333-4333-8333-333333333333";
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing });
    mockIssueService.findMentionedAgents.mockResolvedValue([mentionedAgentId]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-mention-reference",
      issueId: existing.id,
      companyId: existing.companyId,
      body: `[@Reviewer](agent://${mentionedAgentId}) for context; assignee please continue.`,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${existing.id}`)
      .send({
        comment: `[@Reviewer](agent://${mentionedAgentId}) for context; assignee please continue.`,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.findMentionedAgents).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({
        reason: "issue_commented",
        contextSnapshot: expect.objectContaining({ source: "issue.comment" }),
      }),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      mentionedAgentId,
      expect.anything(),
    );
  });

  it("does not turn AI agent references in a posted comment into extra wakes", async () => {
    const mentionedAgentId = "33333333-3333-4333-8333-333333333333";
    const existing = makeIssue({
      assigneeAgentId: ASSIGNEE_AGENT_ID,
      assigneeUserId: null,
      status: "in_progress",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.findMentionedAgents.mockResolvedValue([mentionedAgentId]);
    mockIssueService.addComment.mockResolvedValue({
      id: "posted-comment-mention-reference",
      issueId: existing.id,
      companyId: existing.companyId,
      body: `[@Reviewer](agent://${mentionedAgentId}) is referenced for context.`,
    });

    const res = await request(await createApp())
      .post(`/api/issues/${existing.id}/comments`)
      .send({ body: `[@Reviewer](agent://${mentionedAgentId}) is referenced for context.` });

    expect(res.status).toBe(201);
    expect(mockIssueService.findMentionedAgents).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ASSIGNEE_AGENT_ID,
      expect.objectContaining({ reason: "issue_commented" }),
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(mentionedAgentId, expect.anything());
  });

  it("applies agent Next owner comments as assignment handoffs and wakes the resolved owner", async () => {
    const authorAgentId = "44444444-4444-4444-8444-444444444444";
    const ceoAgentId = "55555555-5555-4555-8555-555555555555";
    const existing = makeIssue({
      status: "blocked",
      assigneeAgentId: authorAgentId,
      assigneeUserId: null,
      parentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const commentBody = [
      "Status: waiting on a business decision.",
      "Next owner: Chrysler_Codex (or CEO/Chrysler)",
      "Next action: choose the canonical doc ID.",
    ].join("\n");
    const afterInitialUpdate = { ...existing };
    const afterHandoff = makeIssue({
      ...existing,
      status: "todo",
      assigneeAgentId: ceoAgentId,
      assigneeUserId: null,
    });

    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update
      .mockResolvedValueOnce(afterInitialUpdate)
      .mockResolvedValueOnce(afterHandoff);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-next-owner",
      issueId: existing.id,
      companyId: existing.companyId,
      body: commentBody,
    });
    const ceoAgent = { id: ceoAgentId, companyId: "company-1", name: "CEO", status: "running", role: "ceo" };
    mockAgentService.list.mockResolvedValue([ceoAgent]);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: raw === "CEO" ? ceoAgent : null,
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: authorAgentId,
      companyId: "company-1",
      runId: "run-next-owner",
    }))
      .patch(`/api/issues/${existing.id}`)
      .send({
        comment: commentBody,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenNthCalledWith(
      2,
      existing.id,
      expect.objectContaining({
        assigneeAgentId: ceoAgentId,
        assigneeUserId: null,
        actorAgentId: authorAgentId,
        status: "todo",
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ceoAgentId,
      expect.objectContaining({
        source: "assignment",
        reason: "next_owner_handoff",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-next-owner",
          mutation: "next_owner_handoff",
          assignmentHandoff: true,
          previousAssigneeAgentId: authorAgentId,
          previousStatus: "blocked",
          nextStatus: "todo",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          wakeReason: "next_owner_handoff",
          source: "issue.next_owner_handoff",
          assignmentHandoff: true,
        }),
      }),
    );
  });

  it("applies an embedded harness Next owner clause and wakes the resolved owner", async () => {
    const authorAgentId = "44444444-4444-4444-8444-444444444444";
    const ctoAgentId = "55555555-5555-4555-8555-555555555555";
    const existing = makeIssue({
      status: "in_progress",
      assigneeAgentId: authorAgentId,
      assigneeUserId: null,
      parentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const commentBody = [
      "Blocked on the platform configuration.",
      "Canonical stage: platform recovery. Current owner: Founding Engineer. Next owner: CTO/Paperclip platform owner. Return owner: Founding Engineer after approval.",
    ].join("\n");
    const afterInitialUpdate = makeIssue({
      ...existing,
      status: "blocked",
    });
    const afterHandoff = makeIssue({
      ...existing,
      status: "todo",
      assigneeAgentId: ctoAgentId,
      assigneeUserId: null,
    });

    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update
      .mockResolvedValueOnce(afterInitialUpdate)
      .mockResolvedValueOnce(afterHandoff);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-embedded-next-owner",
      issueId: existing.id,
      companyId: existing.companyId,
      body: commentBody,
    });
    const ctoAgent = { id: ctoAgentId, companyId: "company-1", name: "CTO", status: "running", role: "cto" };
    mockAgentService.list.mockResolvedValue([ctoAgent]);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: raw === "CTO" ? ctoAgent : null,
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: authorAgentId,
      companyId: "company-1",
      runId: "run-embedded-next-owner",
    }))
      .patch(`/api/issues/${existing.id}`)
      .send({
        status: "blocked",
        comment: commentBody,
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenNthCalledWith(
      2,
      existing.id,
      expect.objectContaining({
        assigneeAgentId: ctoAgentId,
        assigneeUserId: null,
        actorAgentId: authorAgentId,
        status: "todo",
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ctoAgentId,
      expect.objectContaining({
        reason: "next_owner_handoff",
        payload: expect.objectContaining({
          commentId: "comment-embedded-next-owner",
          sourceLine: expect.stringContaining("Next owner: CTO/Paperclip platform owner"),
        }),
      }),
    );
  });

  it("rejects an unresolved Next owner contract before saving a comment or status change", async () => {
    const authorAgentId = "44444444-4444-4444-8444-444444444444";
    const existing = makeIssue({
      status: "todo",
      assigneeAgentId: authorAgentId,
      assigneeUserId: null,
    });
    const commentBody =
      "Canonical stage: recovery. Current owner: Engineer. Next owner: Missing Platform Owner. Return owner: Engineer.";
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });

    const res = await request(await createApp({
      type: "agent",
      agentId: authorAgentId,
      companyId: "company-1",
      runId: "run-unresolved-next-owner",
    }))
      .patch(`/api/issues/${existing.id}`)
      .send({
        status: "blocked",
        comment: commentBody,
      });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("Next owner handoff could not be resolved"),
      details: expect.objectContaining({
        code: "next_owner_handoff_unresolved",
        reason: "no_assignable_agent",
        references: ["Missing Platform Owner"],
      }),
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("applies pure agent Next owner comments as assignment handoffs and wakes the resolved owner", async () => {
    const authorAgentId = "44444444-4444-4444-8444-444444444444";
    const ceoAgentId = "55555555-5555-4555-8555-555555555555";
    const existing = makeIssue({
      status: "blocked",
      assigneeAgentId: authorAgentId,
      assigneeUserId: null,
      parentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
    const commentBody = [
      "Status: waiting on a business decision.",
      "Next owner: Chrysler_Codex (or CEO/Chrysler)",
      "Next action: choose the canonical doc ID.",
    ].join("\n");
    const afterHandoff = makeIssue({
      ...existing,
      status: "todo",
      assigneeAgentId: ceoAgentId,
      assigneeUserId: null,
    });

    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(afterHandoff);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-next-owner-only",
      issueId: existing.id,
      companyId: existing.companyId,
      body: commentBody,
    });
    const ceoAgent = { id: ceoAgentId, companyId: "company-1", name: "CEO", status: "running", role: "ceo" };
    mockAgentService.list.mockResolvedValue([ceoAgent]);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, raw: string) => ({
      ambiguous: false,
      agent: raw === "CEO" ? ceoAgent : null,
    }));

    const res = await request(await createApp({
      type: "agent",
      agentId: authorAgentId,
      companyId: "company-1",
      runId: "run-next-owner-comment",
    }))
      .post(`/api/issues/${existing.id}/comments`)
      .send({
        body: commentBody,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      existing.id,
      expect.objectContaining({
        assigneeAgentId: ceoAgentId,
        assigneeUserId: null,
        actorAgentId: authorAgentId,
        status: "todo",
      }),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      ceoAgentId,
      expect.objectContaining({
        source: "assignment",
        reason: "next_owner_handoff",
        payload: expect.objectContaining({
          issueId: existing.id,
          commentId: "comment-next-owner-only",
          mutation: "next_owner_handoff",
          assignmentHandoff: true,
          previousAssigneeAgentId: authorAgentId,
          previousStatus: "blocked",
          nextStatus: "todo",
        }),
        contextSnapshot: expect.objectContaining({
          issueId: existing.id,
          wakeReason: "next_owner_handoff",
          source: "issue.next_owner_handoff",
          assignmentHandoff: true,
        }),
      }),
    );
  });
});
