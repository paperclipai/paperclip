import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// THIAAAAAA-1872: authorized fallback reassignment endpoint.
// The fallback executor (a non-Claude identity, e.g. MC-Compiler) reassigns a
// limited primary's open issue to the registered sister via a scoped
// `tasks:fallback_reassign` grant, bypassing the cross-agent-mutation 403.

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const primaryAgentId = "33333333-3333-4333-8333-333333333333"; // watched primary (current assignee)
const sisterAgentId = "44444444-4444-4444-8444-444444444444"; // registered fallback sister (target)
const executorAgentId = "55555555-5555-4555-8555-555555555555"; // fallback executor (caller)

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
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

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockStorageService = vi.hoisted(() => ({
  provider: "local_disk",
  putFile: vi.fn(),
  getObject: vi.fn(),
  headObject: vi.fn(),
  deleteObject: vi.fn(),
}));

const logActivityMock = vi.hoisted(() => vi.fn(async () => undefined));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
  vi.doMock("../services/activity-log.js", () => ({ logActivity: logActivityMock }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => ({ getById: vi.fn(async () => ({ id: companyId, issuePrefix: "PAP" })) }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({ upsertIssueDocument: vi.fn() }),
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
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => [companyId]),
    }),
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      resolveActiveForIssue: vi.fn(async () => null),
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
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => ({
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    logActivity: logActivityMock,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
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
    assigneeAgentId: primaryAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "PAP-1872",
    title: "Primary-owned open issue",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function makeAgent(id: string, overrides: Record<string, unknown> = {}) {
  return { id, companyId, role: "engineer", reportsTo: null, permissions: { canCreateAgents: false }, ...overrides };
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

function executorActor() {
  return {
    type: "agent",
    agentId: executorAgentId,
    companyId,
    source: "agent_key",
    runId: "66666666-6666-4666-8666-666666666666",
  };
}

function grantedDecide() {
  return async (input: { action: string }) => ({
    allowed: input.action === "tasks:fallback_reassign",
    action: input.action,
    reason: input.action === "tasks:fallback_reassign" ? "allow_explicit_grant" : "deny_missing_grant",
    explanation: input.action === "tasks:fallback_reassign" ? "Allowed by scoped fallback grant." : "Missing permission.",
    grant:
      input.action === "tasks:fallback_reassign"
        ? { principalType: "agent", principalId: executorAgentId, permissionKey: "tasks:fallback_reassign", scope: { targetAgentIds: [sisterAgentId] } }
        : undefined,
  });
}

describe("authorized fallback reassignment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();

    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({ id: "c1", issueId, companyId, body: "comment" });
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, ref: string) => ({
      ambiguous: false,
      agent: ref === sisterAgentId ? makeAgent(sisterAgentId) : ref === primaryAgentId ? makeAgent(primaryAgentId) : null,
    }));
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockAccessService.decide.mockImplementation(grantedDecide());
  });

  it("reassigns a primary's issue to the registered sister when the scoped grant allows it", async () => {
    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({ toAgentId: sisterAgentId, expectedFromAgentId: primaryAgentId, reason: "primary hit usage limit" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ reassignedFromAgentId: primaryAgentId, reassignedToAgentId: sisterAgentId });
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({ assigneeAgentId: sisterAgentId }),
    );
    // Authorization is scoped to the target sister.
    expect(mockAccessService.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tasks:fallback_reassign",
        resource: expect.objectContaining({ type: "issue", companyId, issueId, assigneeAgentId: primaryAgentId }),
        scope: { targetAgentId: sisterAgentId },
      }),
    );
    // Sister is woken to pick up the failed-over work.
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      sisterAgentId,
      expect.objectContaining({ payload: expect.objectContaining({ issueId, mutation: "fallback_reassign" }) }),
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.fallback_reassigned", entityId: issueId }),
    );
  });

  it("rejects the executor when it lacks the fallback-reassignment grant", async () => {
    mockAccessService.decide.mockImplementation(async (input: { action: string }) => ({
      allowed: false,
      action: input.action,
      reason: "deny_missing_grant",
      explanation: "Missing permission.",
    }));

    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({ toAgentId: sisterAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("authorized fallback-reassignment grant");
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects when the caller's expected primary does not match the current assignee", async () => {
    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({ toAgentId: sisterAgentId, expectedFromAgentId: "00000000-0000-4000-8000-000000000000" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Fallback reassignment primary mismatch");
    expect(mockAccessService.decide).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects reassignment when the issue has no assigned primary", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: null }));

    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({ toAgentId: sisterAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Fallback reassignment requires an assigned primary");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("rejects when the target equals the current assignee (no-op swap)", async () => {
    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({ toAgentId: primaryAgentId });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Fallback reassignment target equals current assignee");
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
