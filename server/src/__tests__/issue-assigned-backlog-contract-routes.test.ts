import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const assigneeAgentId = "22222222-2222-4222-8222-222222222222";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockFindExistingManagerHandoffWake = vi.hoisted(() => vi.fn(async () => null as any));
const mockGetAgentById = vi.hoisted(() => vi.fn(async (_id: string) => null as any));
const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  createChild: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  update: vi.fn(),
}));

vi.mock("../services/issue-manager-handoff.js", () => ({
  ISSUE_MANAGER_HANDOFF_WAKE_REASON: "issue_manager_handoff",
  buildIssueManagerHandoffWakeIdempotencyKey: ({ initiatingRunId, issueId }: {
    initiatingRunId: string;
    issueId: string;
  }) => `issue-manager-handoff:${initiatingRunId}:${issueId}`,
  findExistingIssueManagerHandoffWake: mockFindExistingManagerHandoffWake,
}));

vi.mock("../services/task-watchdog-scope.js", () => ({
  TASK_WATCHDOG_ORIGIN_KIND: "task_watchdog",
  resolveTaskWatchdogMutationScope: vi.fn(async () => ({ kind: "none" })),
  taskWatchdogScopeAllowsIssueMutation: vi.fn(async () => ({ kind: "invalid", detail: "not in scope" })),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    decide: vi.fn(async (input: { action?: string }) => ({
      allowed: input.action !== "issue:mutate",
      action: input.action,
      reason: input.action === "issue:mutate" ? "deny_outside_issue_boundary" : "allow_explicit_grant",
      explanation: input.action === "issue:mutate"
        ? "Issue is outside this actor's authorization boundary."
        : "Allowed by test grant.",
    })),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: mockGetAgentById,
    resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
      ambiguous: false,
      agent: {
        id: reference,
        companyId: "company-1",
        status: "active",
        orgChainHealth: { status: "healthy" },
      },
    })),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
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
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
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
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
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

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(input: {
  id: string;
  title: string;
  status?: string;
  parentId?: string | null;
  assigneeAgentId?: string | null;
}) {
  return {
    id: input.id,
    companyId: "company-1",
    identifier: input.id === "child-1" ? "PAP-3701" : "PAP-3700",
    title: input.title,
    description: null,
    status: input.status ?? "todo",
    priority: "medium",
    parentId: input.parentId ?? null,
    assigneeAgentId: input.assigneeAgentId ?? null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    executionWorkspaceId: null,
    labels: [],
    labelIds: [],
  };
}

function expectClearAssignedStatusValidation(res: request.Response) {
  expect([400, 422]).toContain(res.status);
  expect(String(res.body?.error ?? res.text)).toMatch(/assign|assignee|status|backlog|todo/i);
}

describe("assigned backlog creation contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue({
      id: "parent-1",
      title: "Parent issue",
      status: "blocked",
      assigneeAgentId,
    }));
    mockIssueService.create.mockImplementation(async (_companyId: string, data: Record<string, unknown>) =>
      makeIssue({
        id: String(data.id),
        title: String(data.title),
        status: String(data.status),
        assigneeAgentId: data.assigneeAgentId as string | null | undefined,
      }));
    mockIssueService.createChild.mockImplementation(async (_parentId: string, data: Record<string, unknown>) => ({
      issue: makeIssue({
        id: "child-1",
        title: String(data.title),
        status: String(data.status),
        parentId: "parent-1",
        assigneeAgentId: data.assigneeAgentId as string | null | undefined,
      }),
      parentBlockerAdded: Boolean(data.blockParentUntilDone),
    }));
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
  });

  it("does not silently create a top-level assigned issue as backlog when status is omitted", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Assigned executable work",
        assigneeAgentId,
      });

    if (res.status !== 201) {
      expectClearAssignedStatusValidation(res);
      expect(mockIssueService.create).not.toHaveBeenCalled();
      expect(mockWakeup).not.toHaveBeenCalled();
      return;
    }

    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Assigned executable work",
        assigneeAgentId,
        status: "todo",
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      assigneeAgentId,
      status: "todo",
    }));
    expect(mockWakeup).toHaveBeenCalledWith(
      assigneeAgentId,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({ mutation: "create" }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.created",
        details: expect.objectContaining({
          status: "todo",
          statusDefaulted: true,
          statusDefaultReason: "assigned_omitted_status",
          assignmentWakeSkipped: false,
        }),
      }),
    );
  }, 15_000);

  it("does not let a parent-blocking assigned child become an unwoken backlog leaf by default", async () => {
    const res = await request(await createApp())
      .post("/api/issues/parent-1/children")
      .send({
        title: "Assigned child blocker",
        assigneeAgentId,
        blockParentUntilDone: true,
      });

    if (res.status !== 201) {
      expectClearAssignedStatusValidation(res);
      expect(mockIssueService.createChild).not.toHaveBeenCalled();
      expect(mockWakeup).not.toHaveBeenCalled();
      return;
    }

    expect(mockIssueService.createChild).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({
        title: "Assigned child blocker",
        assigneeAgentId,
        blockParentUntilDone: true,
        status: "todo",
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      assigneeAgentId,
      parentId: "parent-1",
      status: "todo",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.child_created",
        details: expect.objectContaining({
          status: "todo",
          statusDefaulted: true,
          statusDefaultReason: "assigned_omitted_status",
          assignmentWakeSkipped: false,
          parentBlockerAdded: true,
        }),
      }),
    );
    expect(mockWakeup).toHaveBeenCalledWith(
      assigneeAgentId,
      expect.objectContaining({
        source: "assignment",
        reason: "issue_assigned",
        payload: expect.objectContaining({ mutation: "create" }),
      }),
    );
  });

  it("preserves deliberate assigned backlog as parked work without assignment wakeup", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/issues")
      .send({
        title: "Parked assigned work",
        assigneeAgentId,
        status: "backlog",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Parked assigned work",
        assigneeAgentId,
        status: "backlog",
      }),
    );
    expect(res.body).toEqual(expect.objectContaining({
      assigneeAgentId,
      status: "backlog",
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.created",
        entityId: expect.any(String),
        details: expect.objectContaining({
          status: "backlog",
          statusDefaulted: false,
          statusDefaultReason: "explicit",
          assignmentWakeSkipped: true,
          assignmentWakeSkipReason: "assigned_backlog",
        }),
      }),
    );
    expect(mockWakeup).not.toHaveBeenCalled();
  });
});

describe("manager assignment handoff", () => {
  const managerId = "11111111-1111-4111-8111-111111111111";
  const runId = "33333333-3333-4333-8333-333333333333";
  const issueId = "44444444-4444-4444-8444-444444444444";
  const managerActor = {
    type: "agent",
    agentId: managerId,
    companyId: "company-1",
    source: "agent_key",
    runId,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue({
      id: issueId,
      title: "Existing delegated lane",
      status: "backlog",
      assigneeAgentId,
    }));
    mockIssueService.update.mockResolvedValue(makeIssue({
      id: issueId,
      title: "Existing delegated lane",
      status: "todo",
      assigneeAgentId,
    }));
    mockGetAgentById.mockImplementation(async (id: string) => id === managerId
      ? {
          id: managerId,
          companyId: "company-1",
          reportsTo: null,
          status: "active",
          orgChainHealth: { status: "healthy" },
        }
      : {
          id: assigneeAgentId,
          companyId: "company-1",
          reportsTo: managerId,
          status: "idle",
          orgChainHealth: { status: "healthy" },
        });
  });

  it("activates an existing backlog issue for a healthy direct report and requests a run-bound wake", async () => {
    const wakeupRunId = "55555555-5555-4555-8555-555555555555";
    const wakeRequestId = "66666666-6666-4666-8666-666666666666";
    mockWakeup.mockResolvedValue({ id: wakeupRunId, wakeupRequestId: wakeRequestId } as any);

    const res = await request(await createApp(managerActor))
      .post(`/api/issues/${issueId}/manager-handoff`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(issueId, expect.objectContaining({
      status: "todo",
      actorAgentId: managerId,
      expectedStatus: "backlog",
      expectedAssigneeAgentId: assigneeAgentId,
    }));
    expect(mockWakeup).toHaveBeenCalledWith(assigneeAgentId, expect.objectContaining({
      source: "assignment",
      reason: "issue_manager_handoff",
      idempotencyKey: `issue-manager-handoff:${runId}:${issueId}`,
      payload: expect.objectContaining({ issueId, managerAgentId: managerId, initiatingRunId: runId }),
    }));
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.manager_handoff_requested",
      entityId: issueId,
      runId,
      details: expect.objectContaining({
        managerAgentId: managerId,
        targetAgentId: assigneeAgentId,
        targetIssueId: issueId,
      }),
    }));
    expect(res.body).toMatchObject({
      issue: { id: issueId, status: "todo", assigneeAgentId },
      handoff: {
        initiatingRunId: runId,
        managerAgentId: managerId,
        targetAgentId: assigneeAgentId,
        wakeRequestId,
        wakeupRunId,
      },
    });
  });

  it("requests a wake for an existing todo issue without mutating it", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      id: issueId,
      title: "Ready delegated lane",
      status: "todo",
      assigneeAgentId,
    }));
    const wakeupRunId = "55555555-5555-4555-8555-555555555555";
    const wakeRequestId = "66666666-6666-4666-8666-666666666666";
    mockWakeup.mockResolvedValue({ id: wakeupRunId, wakeupRequestId: wakeRequestId } as any);

    const res = await request(await createApp(managerActor))
      .post(`/api/issues/${issueId}/manager-handoff`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).toHaveBeenCalledWith(assigneeAgentId, expect.objectContaining({
      reason: "issue_manager_handoff",
      payload: expect.objectContaining({ mutation: "assignment_wake" }),
    }));
    expect(res.body.issue).toMatchObject({ id: issueId, status: "todo", assigneeAgentId });
  });

  it("fails closed when the issue changes between authorization and backlog activation", async () => {
    mockIssueService.update.mockResolvedValue(null);

    const res = await request(await createApp(managerActor))
      .post(`/api/issues/${issueId}/manager-handoff`)
      .send({});

    expect(res.status).toBe(409);
    expect(mockIssueService.update).toHaveBeenCalledWith(issueId, expect.objectContaining({
      expectedStatus: "backlog",
      expectedAssigneeAgentId: assigneeAgentId,
    }));
    expect(mockWakeup).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.manager_handoff_requested" }),
    );
  });

  it("keeps arbitrary non-direct-report issue mutation forbidden", async () => {
    mockGetAgentById.mockImplementation(async (id: string) => id === managerId
      ? { id: managerId, companyId: "company-1", reportsTo: null, orgChainHealth: { status: "healthy" } }
      : { id: assigneeAgentId, companyId: "company-1", reportsTo: "another-manager", orgChainHealth: { status: "healthy" } });

    const res = await request(await createApp(managerActor))
      .post(`/api/issues/${issueId}/manager-handoff`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("fails closed for an unhealthy org chain", async () => {
    mockGetAgentById.mockImplementation(async (id: string) => id === managerId
      ? { id: managerId, companyId: "company-1", reportsTo: null, status: "active", orgChainHealth: { status: "healthy" } }
      : { id: assigneeAgentId, companyId: "company-1", reportsTo: managerId, status: "idle", orgChainHealth: { status: "invalid_org_chain" } });

    const res = await request(await createApp(managerActor))
      .post(`/api/issues/${issueId}/manager-handoff`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("fails closed for a terminated direct report even when the stored org chain is otherwise healthy", async () => {
    mockGetAgentById.mockImplementation(async (id: string) => id === managerId
      ? { id: managerId, companyId: "company-1", reportsTo: null, status: "active", orgChainHealth: { status: "healthy" } }
      : { id: assigneeAgentId, companyId: "company-1", reportsTo: managerId, status: "terminated", orgChainHealth: { status: "healthy" } });

    const res = await request(await createApp(managerActor))
      .post(`/api/issues/${issueId}/manager-handoff`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it.each(["pending_approval", "paused"])(
    "fails closed when the direct report is %s and therefore cannot accept a wake",
    async (status) => {
      mockGetAgentById.mockImplementation(async (id: string) => id === managerId
        ? { id: managerId, companyId: "company-1", reportsTo: null, status: "active", orgChainHealth: { status: "healthy" } }
        : { id: assigneeAgentId, companyId: "company-1", reportsTo: managerId, status, orgChainHealth: { status: "healthy" } });

      const res = await request(await createApp(managerActor))
        .post(`/api/issues/${issueId}/manager-handoff`)
        .send({});

      expect(res.status).toBe(403);
      expect(mockIssueService.update).not.toHaveBeenCalled();
      expect(mockWakeup).not.toHaveBeenCalled();
    },
  );

  it("requires a run-bound agent key", async () => {
    const res = await request(await createApp({ ...managerActor, runId: undefined }))
      .post(`/api/issues/${issueId}/manager-handoff`)
      .send({});

    expect(res.status).toBe(401);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("preserves the original generic PATCH denial for a subordinate's issue", async () => {
    const res = await request(await createApp(managerActor))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "todo" });

    expect(res.status).toBe(403);
    expect(String(res.body?.error ?? res.text)).toMatch(/authorization boundary/i);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("replays the same run-bound handoff without a second mutation or wake", async () => {
    mockFindExistingManagerHandoffWake.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      status: "queued",
      runId: "55555555-5555-4555-8555-555555555555",
    });

    const res = await request(await createApp(managerActor))
      .post(`/api/issues/${issueId}/manager-handoff`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.handoff).toMatchObject({
      initiatingRunId: runId,
      managerAgentId: managerId,
      targetAgentId: assigneeAgentId,
      wakeRequestId: "66666666-6666-4666-8666-666666666666",
      wakeupRunId: "55555555-5555-4555-8555-555555555555",
      idempotentReplay: true,
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("fails closed when idempotency readback is unavailable", async () => {
    mockFindExistingManagerHandoffWake.mockRejectedValue(new Error("readback unavailable"));

    const res = await request(await createApp(managerActor))
      .post(`/api/issues/${issueId}/manager-handoff`)
      .send({});

    expect(res.status).toBe(500);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("fails closed when the assigned agent belongs to another company", async () => {
    mockGetAgentById.mockImplementation(async (id: string) => id === managerId
      ? { id: managerId, companyId: "company-1", reportsTo: null, orgChainHealth: { status: "healthy" } }
      : { id: assigneeAgentId, companyId: "company-2", reportsTo: managerId, orgChainHealth: { status: "healthy" } });

    const res = await request(await createApp(managerActor))
      .post(`/api/issues/${issueId}/manager-handoff`)
      .send({});

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });

  it("does not widen mutations beyond backlog and todo", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({
      id: issueId,
      title: "Already running lane",
      status: "in_progress",
      assigneeAgentId,
    }));

    const res = await request(await createApp(managerActor))
      .post(`/api/issues/${issueId}/manager-handoff`)
      .send({});

    expect(res.status).toBe(409);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockWakeup).not.toHaveBeenCalled();
  });
});
