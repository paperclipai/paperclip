import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// SAM-1532: scoped cancel-only capability ("routines:sweep_cancel") that lets the
// stale-routine-fire sweep (SAM-1531 / policy SAM-758) cancel a stale, non-live
// cross-agent routine fire — and nothing else. These tests pin the guardrails.

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const sweepAgentId = "33333333-3333-4333-8333-333333333333"; // owns SAM-1531 (e.g. CTO)
const routineOwnerAgentId = "44444444-4444-4444-8444-444444444444"; // fire assignee (e.g. SMM)
const sweepRunId = "66666666-6666-4666-8666-666666666666";

const STALE_MS = 13 * 60 * 60 * 1000;

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
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

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
}));

const mockDocumentService = vi.hoisted(() => ({
  upsertIssueDocument: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  createForIssue: vi.fn(),
  getById: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  resolveActiveForIssue: vi.fn(async () => null),
}));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
  vi.doMock("../services/access.js", () => ({ accessService: () => mockAccessService }));
  vi.doMock("../services/agents.js", () => ({ agentService: () => mockAgentService }));
  vi.doMock("../services/issues.js", () => ({ issueService: () => mockIssueService }));
  vi.doMock("../services/documents.js", () => ({
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
  }));
  vi.doMock("../services/work-products.js", () => ({
    workProductService: () => mockWorkProductService,
  }));
  vi.doMock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => mockCompanyService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => mockDocumentService,
    executionWorkspaceService: () => ({}),
    issueRecoveryActionService: () => mockIssueRecoveryActionService,
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
      get: vi.fn(async () => ({ id: "s", general: { censorUsernameInLogs: false } })),
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
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => mockWorkProductService,
  }));
}

function makeFire(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "blocked",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: routineOwnerAgentId,
    assigneeUserId: null,
    createdByUserId: null,
    createdByAgentId: routineOwnerAgentId,
    identifier: "SAM-1524",
    title: "SocialOS Dashboard Check",
    originKind: "routine_execution",
    checkoutRunId: null,
    executionRunId: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    hiddenAt: null,
    updatedAt: new Date(Date.now() - STALE_MS),
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
  app.use("/api", issueRoutes({} as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function sweepActor() {
  return {
    type: "agent",
    agentId: sweepAgentId,
    companyId,
    source: "agent_key",
    runId: sweepRunId,
  };
}

const cancelNote = "Cancelled by stale-routine-fire sweep (SAM-1531 / policy SAM-758): blocked >12h, no live continuation, superseded by a fresh fire.";

describe("routine-fire sweep cancel capability (SAM-1532)", () => {
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

    mockAccessService.canUser.mockResolvedValue(true);
    // Override (tasks:manage_active_checkouts) is denied — the sweep owner holds only
    // the scoped routines:sweep_cancel grant, so the sweep branch is the only path.
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_missing_grant",
      explanation: "Denied by sweep test default.",
    }));
    // Default: sweep agent holds the scoped grant. Negative tests override.
    mockAccessService.hasPermission.mockImplementation(async (
      _companyId: string,
      principalType: string,
      principalId: string,
      permissionKey: string,
    ) => principalType === "agent" && principalId === sweepAgentId && permissionKey === "routines:sweep_cancel");

    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === sweepAgentId) return makeAgent(sweepAgentId);
      if (id === routineOwnerAgentId) return makeAgent(routineOwnerAgentId);
      return null;
    });
    mockAgentService.list.mockResolvedValue([makeAgent(sweepAgentId), makeAgent(routineOwnerAgentId)]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "SAM" });

    mockIssueService.getById.mockResolvedValue(makeFire());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeFire(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", issueId, companyId, body: cancelNote });
  });

  it("authorizes the sweep owner to cancel a stale cross-agent routine fire and writes an audit entry", async () => {
    const res = await request(await createApp(sweepActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", comment: cancelNote });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ status: "cancelled" }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.routine_sweep_cancel_authorized",
        entityId: issueId,
        details: expect.objectContaining({
          targetAssigneeAgentId: routineOwnerAgentId,
          actorAgentId: sweepAgentId,
          reason: "stale_routine_fire_sweep",
          sweepRunId,
        }),
      }),
    );
  });

  it("rejects cancel of a non-routine issue (originKind != routine_execution)", async () => {
    mockIssueService.getById.mockResolvedValue(makeFire({ originKind: "manual" }));

    const res = await request(await createApp(sweepActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", comment: cancelNote });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects cancel of a recently-updated (non-stale) routine fire", async () => {
    mockIssueService.getById.mockResolvedValue(makeFire({ updatedAt: new Date(Date.now() - 60 * 1000) }));

    const res = await request(await createApp(sweepActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", comment: cancelNote });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects cancel of a routine fire with a live checkout", async () => {
    mockIssueService.getById.mockResolvedValue(makeFire({ checkoutRunId: "99999999-9999-4999-8999-999999999999" }));

    const res = await request(await createApp(sweepActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", comment: cancelNote });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("returns 409 for an in-progress (live) routine fire instead of cancelling it", async () => {
    mockIssueService.getById.mockResolvedValue(makeFire({ status: "in_progress" }));

    const res = await request(await createApp(sweepActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", comment: cancelNote });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects a cancel bundled with any other field mutation (cancel-only)", async () => {
    const res = await request(await createApp(sweepActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", comment: cancelNote, title: "Renamed" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects a cancel bundled with a reassignment (no acting-as another agent)", async () => {
    const res = await request(await createApp(sweepActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", comment: cancelNote, assigneeAgentId: sweepAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects a non-cancel mutation (e.g. retitle) on the fire", async () => {
    const res = await request(await createApp(sweepActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Renamed" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects a cancel with no cancel note (traceability required)", async () => {
    const res = await request(await createApp(sweepActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects an agent without the routines:sweep_cancel grant", async () => {
    mockAccessService.hasPermission.mockResolvedValue(false);

    const res = await request(await createApp(sweepActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "cancelled", comment: cancelNote });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Agent cannot mutate another agent's issue");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.routine_sweep_cancel_authorized" }),
    );
  });
});
