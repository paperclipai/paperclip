/**
 * Tests for phantom-done prevention (STAA-5202).
 * Validates that PATCH /api/issues/:id with status=done is rejected with 400
 * when the issue has no agent execution record (executionRunId or
 * executionAgentNameKey is null).
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const agentId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const execRunId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock("../middleware/logger.js", () => ({
  logger: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() },
}));

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
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
  findMentionedAgents: vi.fn(),
  getDependencyReadiness: vi.fn(),
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
    accessService: () => ({ canUser: vi.fn(async () => true), hasPermission: vi.fn(async () => false) }),
  }));
  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));
  vi.doMock("../services/agents.js", () => ({
    agentService: () => ({
      getById: vi.fn(async () => ({ id: agentId, companyId, role: "engineer", reportsTo: null, permissions: { canCreateAgents: false } })),
      list: vi.fn(async () => []),
      resolveByReference: vi.fn(async () => ({ ambiguous: false, agent: null })),
    }),
  }));
  vi.doMock("../services/documents.js", () => ({
    documentService: () => ({ upsertIssueDocument: vi.fn() }),
  }));
  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));
  vi.doMock("../services/work-products.js", () => ({
    workProductService: () => ({ getById: vi.fn(), update: vi.fn() }),
  }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({ canUser: vi.fn(async () => true), hasPermission: vi.fn(async () => false) }),
    agentService: () => ({
      getById: vi.fn(async () => ({ id: agentId, companyId, role: "engineer", reportsTo: null, permissions: { canCreateAgents: false } })),
      list: vi.fn(async () => []),
      resolveByReference: vi.fn(async () => ({ ambiguous: false, agent: null })),
    }),
    companyService: () => ({
      getById: vi.fn(async () => ({ id: companyId, issuePrefix: "TST" })),
    }),
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
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({ getActiveForIssue: vi.fn(async () => null) }),
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] }),
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
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({ getById: vi.fn(), update: vi.fn() }),
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: agentId,
    assigneeUserId: null,
    createdByUserId: null,
    identifier: "TST-100",
    title: "Test issue",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    executionRunId: null,
    executionAgentNameKey: null,
    ...overrides,
  };
}

function agentActor() {
  return { type: "agent", agentId, companyId, source: "agent_key", runId };
}

function boardActor() {
  return { type: "board", userId: "board-user", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: false };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("phantom-done prevention (STAA-5202)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/agents.js");
    vi.doUnmock("../services/documents.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/work-products.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({ id: "comment-1", issueId, companyId, body: "test" });
  });

  it("rejects with 400 when executionRunId and executionAgentNameKey are both null", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ executionRunId: null, executionAgentNameKey: null }));
    const app = await createApp(agentActor());
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("Content-Type", "application/json")
      .send({ status: "done", comment: "non-shippable: governance — no code change" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Cannot mark done without agent execution record" });
  });

  it("rejects with 400 when executionRunId is set but executionAgentNameKey is null", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ executionRunId: execRunId, executionAgentNameKey: null }));
    const app = await createApp(agentActor());
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("Content-Type", "application/json")
      .send({ status: "done", comment: "non-shippable: governance — no code change" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Cannot mark done without agent execution record" });
  });

  it("rejects with 400 when executionAgentNameKey is set but executionRunId is null", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ executionRunId: null, executionAgentNameKey: "cto" }));
    const app = await createApp(agentActor());
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("Content-Type", "application/json")
      .send({ status: "done", comment: "non-shippable: governance — no code change" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Cannot mark done without agent execution record" });
  });

  it("logs warning and audit entry on rejection", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ executionRunId: null, executionAgentNameKey: null }));
    const app = await createApp(agentActor());
    await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("Content-Type", "application/json")
      .send({ status: "done", comment: "non-shippable: governance — no code change" });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId,
        attemptedStatus: "done",
        requesterAgentId: agentId,
      }),
      expect.stringContaining("phantom-done rejected"),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.done_rejected_no_execution",
        entityType: "issue",
        entityId: issueId,
        companyId,
        agentId,
      }),
    );
  });

  it("does not block when both executionRunId and executionAgentNameKey are present", async () => {
    mockIssueService.getById.mockResolvedValue(
      makeIssue({ executionRunId: execRunId, executionAgentNameKey: "cto" }),
    );
    const app = await createApp(agentActor());
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("Content-Type", "application/json")
      .send({ status: "done", comment: "non-shippable: governance — no code change" });
    // Must not be 400 (phantom-done). Done-gate may still reject with 422
    // if the done gate finds the comment invalid — that's acceptable here.
    expect(res.status).not.toBe(400);
    expect(res.body?.error).not.toBe("Cannot mark done without agent execution record");
  });

  it("does not block board/user close with no execution record", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ executionRunId: null, executionAgentNameKey: null }));
    const app = await createApp(boardActor());
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("Content-Type", "application/json")
      .send({ status: "done" });
    expect(res.status).not.toBe(400);
    expect(res.body?.error).not.toBe("Cannot mark done without agent execution record");
  });

  it("does not fire on non-done status transitions", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ executionRunId: null, executionAgentNameKey: null }));
    const app = await createApp(agentActor());
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("Content-Type", "application/json")
      .send({ status: "in_review" });
    expect(res.status).not.toBe(400);
  });

  it("does not fire when issue is already done (idempotent re-close)", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "done", executionRunId: null, executionAgentNameKey: null }));
    const app = await createApp(agentActor());
    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("Content-Type", "application/json")
      .send({ status: "done" });
    expect(res.status).not.toBe(400);
  });
});
