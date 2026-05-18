import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "22222222-2222-4222-8222-222222222222";
const issueId = "11111111-1111-4111-8111-111111111111";
const managerAgentId = "33333333-3333-4333-8333-333333333333";
const subordinateAgentId = "44444444-4444-4444-8444-444444444444";
const peerAgentId = "55555555-5555-4555-8555-555555555555";
const otherSubordinateAgentId = "66666666-6666-4666-8666-666666666666";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  create: vi.fn(),
  findMentionedAgents: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listAttachments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));

  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));

  vi.doMock("../services/access.js", () => ({
    accessService: () => mockAccessService,
  }));

  vi.doMock("../services/agents.js", () => ({
    agentService: () => mockAgentService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: vi.fn(async () => undefined),
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => mockCompanyService,
    documentService: () => ({ upsertIssueDocument: vi.fn() }),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: {
          censorUsernameInLogs: false,
          feedbackDataSharingPreference: "prompt",
        },
      })),
      listCompanyIds: vi.fn(async () => [companyId]),
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
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => ({
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "todo",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-9001",
    title: "Reassignable issue",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    companyId,
    role: "engineer",
    reportsTo: null,
    permissions: { canCreateAgents: false },
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
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

function agentActor(actorAgentId: string) {
  return {
    type: "agent",
    agentId: actorAgentId,
    companyId,
    source: "agent_key",
    runId: "77777777-7777-4777-8777-777777777777",
  };
}

describe("task assignment authorization via reporting chain", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.canUser.mockReset();
    mockAccessService.hasPermission.mockReset();
    mockAgentService.getById.mockReset();
    mockAgentService.list.mockReset();
    mockAgentService.resolveByReference.mockReset();
    mockCompanyService.getById.mockReset();
    mockIssueService.addComment.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockIssueService.create.mockReset();
    mockIssueService.findMentionedAgents.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.getRelationSummaries.mockReset();
    mockIssueService.getWakeableParentAfterChildCompletion.mockReset();
    mockIssueService.listAttachments.mockReset();
    mockIssueService.listWakeableBlockedDependents.mockReset();
    mockIssueService.remove.mockReset();
    mockIssueService.update.mockReset();

    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === managerAgentId) return makeAgent(managerAgentId, { role: "cmo" });
      if (id === subordinateAgentId)
        return makeAgent(subordinateAgentId, { reportsTo: managerAgentId });
      if (id === peerAgentId) return makeAgent(peerAgentId, { reportsTo: managerAgentId });
      if (id === otherSubordinateAgentId)
        return makeAgent(otherSubordinateAgentId, { reportsTo: peerAgentId });
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      makeAgent(managerAgentId, { role: "cmo" }),
      makeAgent(subordinateAgentId, { reportsTo: managerAgentId }),
      makeAgent(peerAgentId, { reportsTo: managerAgentId }),
      makeAgent(otherSubordinateAgentId, { reportsTo: peerAgentId }),
    ]);
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, reference: string) => {
      const agent = await mockAgentService.getById(reference);
      return { ambiguous: false, agent };
    });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "PAP" });
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ assigneeAgentId: subordinateAgentId, status: "in_progress" }),
    );
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue({ assigneeAgentId: subordinateAgentId, status: "in_progress" }),
      ...patch,
    }));
    mockIssueService.create.mockImplementation(async (_companyId: string, input: Record<string, unknown>) => ({
      ...makeIssue(),
      ...input,
      id: issueId,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      issueId,
      companyId,
    });
  });

  it("lets a subordinate reassign their own issue up to their manager", async () => {
    const app = await createApp(agentActor(subordinateAgentId));

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: managerAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    const [, patch] = mockIssueService.update.mock.calls[0]!;
    expect(patch).toMatchObject({ assigneeAgentId: managerAgentId });
  });

  it("lets a manager assign an issue to a direct report", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ assigneeAgentId: managerAgentId, status: "in_progress" }),
    );
    const app = await createApp(agentActor(managerAgentId));

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: subordinateAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  it("rejects a peer assigning a task to another peer (no reporting relationship)", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ assigneeAgentId: subordinateAgentId, status: "in_progress" }),
    );
    const app = await createApp(agentActor(subordinateAgentId));

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: peerAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects a peer assigning a task to a non-descendant in another sub-tree", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ assigneeAgentId: subordinateAgentId, status: "in_progress" }),
    );
    const app = await createApp(agentActor(subordinateAgentId));

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: otherSubordinateAgentId });

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("allows a manager to create an issue assigned to a direct report", async () => {
    const app = await createApp(agentActor(managerAgentId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Created for report", assigneeAgentId: subordinateAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("rejects an agent creating an issue assigned to an unrelated peer", async () => {
    const app = await createApp(agentActor(subordinateAgentId));

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Cannot create for peer", assigneeAgentId: peerAgentId });

    expect(res.status).toBe(403);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("still honours explicit tasks:assign grants for cross-tree assignment", async () => {
    mockAccessService.hasPermission.mockImplementation(async (
      _companyId: string,
      _principalType: string,
      principalId: string,
      permissionKey: string,
    ) => principalId === subordinateAgentId && permissionKey === "tasks:assign");
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ assigneeAgentId: subordinateAgentId, status: "in_progress" }),
    );

    const app = await createApp(agentActor(subordinateAgentId));

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: peerAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
  });
});
