import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TSMC-11078: authorized fallback reassignment endpoint.
// The sister agent performs a self-takeover of a primary's open issue after a
// validated pause or limit failure, using the registry-backed
// `tasks:fallback_reassign` override.

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const primaryAgentId = "33333333-3333-4333-8333-333333333333"; // watched primary (current assignee)
const sisterAgentId = "44444444-4444-4444-8444-444444444444"; // registered fallback sister (caller + target)
const thirdPartyAgentId = "55555555-5555-4555-8555-555555555555";
const recoveryOwnerAgentId = "77777777-7777-4777-8777-777777777778";
const stableNow = new Date("2026-06-25T08:00:00.000Z");
const validResetAt = "2026-06-25T10:00:00.000Z";
const outOfHorizonResetAt = "2026-06-25T20:30:00.000Z";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  fallbackReassign: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getFallbackRelationship: vi.fn(),
  getFallbackPrimaryRelationshipForSister: vi.fn(),
  getById: vi.fn(),
  isPausedOrLimitFailed: vi.fn(),
  list: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  resolveActiveForIssue: vi.fn(async () => null),
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
  vi.doMock("../services/task-watchdog-scope.js", () => ({
    TASK_WATCHDOG_ORIGIN_KIND: "task_watchdog",
    resolveTaskWatchdogMutationScope: vi.fn(async () => ({ kind: "none" })),
    taskWatchdogScopeAllowsIssueMutation: vi.fn(async (_db, scope) => scope),
  }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => ({ getById: vi.fn(async () => ({ id: companyId, issuePrefix: "PAP" })) }),
    companySkillService: () => ({}),
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
    issueRecoveryActionService: () => mockIssueRecoveryActionService,
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

// The route runs the assignee swap and the recovery-action disposal in one
// transaction, so the injected db has to hand out a tx. `createTransactionalDb`
// models commit/rollback well enough to observe whether a failed disposal takes
// the reassignment down with it.
function createTransactionalDb() {
  const committed: Record<string, unknown>[] = [];
  const transaction = vi.fn(async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
    const staged: Record<string, unknown>[] = [];
    const tx = { __tx: true, staged };
    const result = await callback(tx);
    committed.push(...staged);
    return result;
  });
  return { committed, transaction };
}

async function createApp(actor: Record<string, unknown>, db: unknown = createTransactionalDb()) {
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
  app.use("/api", issueRoutes(db as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function executorActor() {
  return {
    type: "agent",
    agentId: sisterAgentId,
    companyId,
    source: "agent_key",
    runId: "66666666-6666-4666-8666-666666666666",
  };
}

function delegatedExecutorActor() {
  return {
    type: "agent",
    agentId: "88888888-8888-4888-8888-888888888888",
    companyId,
    source: "agent_key",
    runId: "99999999-9999-4999-8999-999999999999",
  };
}

function grantedDecide() {
  return async (input: { action: string; scope?: { targetAgentId?: string } }) => ({
    allowed: input.action === "tasks:fallback_reassign" && input.scope?.targetAgentId === sisterAgentId,
    action: input.action,
    reason:
      input.action === "tasks:fallback_reassign" && input.scope?.targetAgentId === sisterAgentId
        ? "allow_explicit_grant"
        : "deny_missing_grant",
    explanation:
      input.action === "tasks:fallback_reassign" && input.scope?.targetAgentId === sisterAgentId
        ? "Allowed by scoped fallback grant."
        : "Missing permission.",
    grant:
      input.action === "tasks:fallback_reassign" && input.scope?.targetAgentId === sisterAgentId
      ? {
        principalType: "agent",
        principalId: sisterAgentId,
        permissionKey: "tasks:fallback_reassign",
        scope: { targetAgentIds: [sisterAgentId] },
      }
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
    vi.stubEnv("FEATURE_FALLBACK_REASSIGN", "on");
    vi.setSystemTime(stableNow);

    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.fallbackReassign.mockImplementation(async (
      issue: Record<string, unknown>,
      sister: { id: string },
      _reason: string,
      _resetAt: Date | null,
      _runId: string | null,
      tx?: { staged?: Record<string, unknown>[] },
    ) => {
      // Stage the swap on the caller's transaction rather than "committing" it,
      // so a later failure inside the same transaction discards it.
      tx?.staged?.push({ kind: "issue_reassigned", issueId: issue.id, assigneeAgentId: sister.id });
      return {
        issue: { ...makeIssue(), assigneeAgentId: sister.id },
        comment: { id: "c-system", issueId: issue.id, companyId, body: "system audit" },
        reassignedFromAgentId: issue.assigneeAgentId,
        reassignedToAgentId: sister.id,
      };
    });
    mockIssueService.addComment.mockResolvedValue({ id: "c1", issueId, companyId, body: "comment" });
    mockAgentService.resolveByReference.mockImplementation(async (_companyId: string, ref: string) => ({
      ambiguous: false,
      agent: ref === sisterAgentId
        ? makeAgent(sisterAgentId)
        : ref === primaryAgentId
          ? makeAgent(primaryAgentId)
          : ref === thirdPartyAgentId
            ? makeAgent(thirdPartyAgentId)
            : null,
    }));
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === primaryAgentId) return makeAgent(primaryAgentId, { status: "active" });
      if (id === sisterAgentId) return makeAgent(sisterAgentId, { status: "active" });
      return null;
    });
    mockAgentService.getFallbackRelationship.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      companyId,
      primaryAgentId,
      sisterAgentId,
      revokedAt: null,
    });
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue(null);
    mockIssueRecoveryActionService.resolveActiveForIssue.mockResolvedValue(null);
    mockAgentService.isPausedOrLimitFailed.mockResolvedValue(true);
    mockHeartbeatService.wakeup.mockResolvedValue(undefined);
    mockAccessService.decide.mockImplementation(grantedDecide());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("reassigns a primary's issue to the registered sister when the scoped grant allows it", async () => {
    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({
        toAgentId: sisterAgentId,
        expectedFromAgentId: primaryAgentId,
        reason: "usage_limit",
        resetAt: validResetAt,
        primaryRunId: primaryAgentId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ reassignedFromAgentId: primaryAgentId, reassignedToAgentId: sisterAgentId });
    expect(mockIssueService.fallbackReassign).toHaveBeenCalledWith(
      expect.objectContaining({ id: issueId, assigneeAgentId: primaryAgentId }),
      { id: sisterAgentId },
      "usage_limit",
      new Date(validResetAt),
      executorActor().runId,
      expect.objectContaining({ __tx: true }),
    );
    expect(mockAgentService.getFallbackRelationship).toHaveBeenCalledWith(companyId, primaryAgentId, sisterAgentId);
    expect(mockAgentService.isPausedOrLimitFailed).toHaveBeenCalledWith(
      { id: primaryAgentId, status: "active" },
      "usage_limit",
      primaryAgentId,
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

  it("rejects a non-sister executor even when it targets the registered sister", async () => {
    const res = await request(await createApp(delegatedExecutorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({
        toAgentId: sisterAgentId,
        expectedFromAgentId: primaryAgentId,
        reason: "paused_primary",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("target must match");
    expect(res.body.details).toMatchObject({
      reason: "third_party_target",
      actorAgentId: delegatedExecutorActor().agentId,
      targetAgentId: sisterAgentId,
    });
    expect(mockAccessService.decide).not.toHaveBeenCalled();
    expect(mockIssueService.fallbackReassign).not.toHaveBeenCalled();
  });

  it("allows the registered sister to take over a recovery-owned stranded issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: recoveryOwnerAgentId }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: "recovery-action-1",
      issueId,
      companyId,
      kind: "stranded_assigned_issue",
      ownerAgentId: recoveryOwnerAgentId,
      previousOwnerAgentId: primaryAgentId,
      returnOwnerAgentId: null,
    });

    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({
        toAgentId: sisterAgentId,
        expectedFromAgentId: primaryAgentId,
        reason: "paused_primary",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tasks:fallback_reassign",
        resource: expect.objectContaining({
          issueId,
          assigneeAgentId: primaryAgentId,
        }),
        scope: { targetAgentId: sisterAgentId },
      }),
    );
    expect(mockAgentService.getFallbackRelationship).toHaveBeenCalledWith(companyId, primaryAgentId, sisterAgentId);
    expect(mockIssueService.fallbackReassign).toHaveBeenCalledWith(
      expect.objectContaining({
        id: issueId,
        assigneeAgentId: primaryAgentId,
        currentAssigneeAgentId: recoveryOwnerAgentId,
      }),
      { id: sisterAgentId },
      "paused_primary",
      null,
      executorActor().runId,
      expect.objectContaining({ __tx: true }),
    );
  });

  it("resolves the recovery action so a recovery-owned takeover leaves nothing active and stale", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: recoveryOwnerAgentId }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: "recovery-action-1",
      issueId,
      companyId,
      status: "active",
      kind: "stranded_assigned_issue",
      ownerAgentId: recoveryOwnerAgentId,
      previousOwnerAgentId: primaryAgentId,
      returnOwnerAgentId: null,
    });
    mockIssueRecoveryActionService.resolveActiveForIssue.mockImplementation(async (input: Record<string, unknown>) => ({
      id: input.actionId,
      companyId,
      sourceIssueId: issueId,
      status: input.status,
      outcome: input.outcome,
      resolutionNote: input.resolutionNote,
      ownerAgentId: recoveryOwnerAgentId,
    }));

    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({
        toAgentId: sisterAgentId,
        expectedFromAgentId: primaryAgentId,
        reason: "paused_primary",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The action owned by the agent we took the issue from must not stay active.
    expect(mockIssueRecoveryActionService.resolveActiveForIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId,
        sourceIssueId: issueId,
        actionId: "recovery-action-1",
        status: "resolved",
        outcome: "delegated",
      }),
      expect.objectContaining({ __tx: true }),
    );
    // Same transaction as the reassignment, so the pair commits or rolls back together.
    expect(mockIssueRecoveryActionService.resolveActiveForIssue.mock.calls[0]![1]).toBe(
      mockIssueService.fallbackReassign.mock.calls[0]![5],
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.recovery_action_resolved",
        entityId: issueId,
        details: expect.objectContaining({
          recoveryActionId: "recovery-action-1",
          source: "fallback_reassign",
          recoveryOwnerAgentId: recoveryOwnerAgentId,
          toAgentId: sisterAgentId,
        }),
      }),
    );
    // Disposition happens before the sister is woken, so the sweep cannot see a
    // dangling action racing the woken takeover.
    const resolveOrder = mockIssueRecoveryActionService.resolveActiveForIssue.mock.invocationCallOrder[0]!;
    const wakeupOrder = mockHeartbeatService.wakeup.mock.invocationCallOrder[0]!;
    expect(resolveOrder).toBeLessThan(wakeupOrder);
  });

  it("fails the takeover request when the recovery action cannot be resolved", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: recoveryOwnerAgentId }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: "recovery-action-1",
      issueId,
      companyId,
      status: "active",
      kind: "stranded_assigned_issue",
      ownerAgentId: recoveryOwnerAgentId,
      previousOwnerAgentId: primaryAgentId,
      returnOwnerAgentId: null,
    });
    mockIssueRecoveryActionService.resolveActiveForIssue.mockRejectedValue(new Error("resolve failed"));

    const routeDb = createTransactionalDb();
    const res = await request(await createApp(executorActor(), routeDb))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({
        toAgentId: sisterAgentId,
        expectedFromAgentId: primaryAgentId,
        reason: "paused_primary",
      });

    // A 200 must imply the action was disposed of, so a failed disposition is
    // surfaced rather than silently leaving it active.
    expect(res.status).toBe(500);
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
    // Atomicity: the reassignment was attempted inside the same transaction as
    // the disposal, so the failed disposal must take it down with it. Nothing
    // committed — no issue reassigned with a still-active, stale-owner action.
    expect(mockIssueService.fallbackReassign).toHaveBeenCalled();
    expect(routeDb.committed).toEqual([]);
    expect(logActivityMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.fallback_reassigned" }),
    );
  });

  it("commits the reassignment and the recovery-action disposal together", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: recoveryOwnerAgentId }));
    mockIssueRecoveryActionService.getActiveForIssue.mockResolvedValue({
      id: "recovery-action-1",
      issueId,
      companyId,
      status: "active",
      kind: "stranded_assigned_issue",
      ownerAgentId: recoveryOwnerAgentId,
      previousOwnerAgentId: primaryAgentId,
      returnOwnerAgentId: null,
    });
    mockIssueRecoveryActionService.resolveActiveForIssue.mockImplementation(async (
      input: Record<string, unknown>,
      tx?: { staged?: Record<string, unknown>[] },
    ) => {
      tx?.staged?.push({ kind: "recovery_action_resolved", actionId: input.actionId });
      return {
        id: input.actionId,
        companyId,
        sourceIssueId: issueId,
        status: input.status,
        outcome: input.outcome,
        resolutionNote: input.resolutionNote,
        ownerAgentId: recoveryOwnerAgentId,
      };
    });

    const routeDb = createTransactionalDb();
    const res = await request(await createApp(executorActor(), routeDb))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({
        toAgentId: sisterAgentId,
        expectedFromAgentId: primaryAgentId,
        reason: "paused_primary",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(routeDb.transaction).toHaveBeenCalledTimes(1);
    expect(routeDb.committed).toEqual([
      { kind: "issue_reassigned", issueId, assigneeAgentId: sisterAgentId },
      { kind: "recovery_action_resolved", actionId: "recovery-action-1" },
    ]);
  });

  it("does not touch recovery actions when the takeover is not recovery-owned", async () => {
    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({
        toAgentId: sisterAgentId,
        expectedFromAgentId: primaryAgentId,
        reason: "usage_limit",
        resetAt: validResetAt,
        primaryRunId: primaryAgentId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueRecoveryActionService.resolveActiveForIssue).not.toHaveBeenCalled();
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
      .send({ toAgentId: sisterAgentId, reason: "usage_limit" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("outside this actor's authorization boundary");
    expect(mockIssueService.fallbackReassign).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("rejects when the target does not match the authenticated sister", async () => {
    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({
        toAgentId: thirdPartyAgentId,
        reason: "usage_limit",
        resetAt: validResetAt,
        primaryRunId: primaryAgentId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("target must match");
    expect(res.body.details.reason).toBe("third_party_target");
    expect(mockAccessService.decide).not.toHaveBeenCalled();
    expect(mockIssueService.fallbackReassign).not.toHaveBeenCalled();
  });

  it("rejects when the caller's expected primary does not match the current assignee", async () => {
    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({
        toAgentId: sisterAgentId,
        expectedFromAgentId: "00000000-0000-4000-8000-000000000000",
        reason: "usage_limit",
        resetAt: validResetAt,
        primaryRunId: primaryAgentId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Fallback reassignment primary mismatch");
    expect(mockAccessService.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "tasks:fallback_reassign",
        scope: { targetAgentId: sisterAgentId },
      }),
    );
    expect(mockIssueService.fallbackReassign).not.toHaveBeenCalled();
  });

  it("returns 404 when no fallback relationship is registered", async () => {
    mockAgentService.getFallbackRelationship.mockResolvedValue(null);

    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({
        toAgentId: sisterAgentId,
        reason: "usage_limit",
        resetAt: validResetAt,
        primaryRunId: primaryAgentId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(res.body.error).toBe("Registered fallback relationship not found");
    expect(mockIssueService.fallbackReassign).not.toHaveBeenCalled();
  });

  it("returns 422 when the primary is not fallback-eligible", async () => {
    mockAgentService.isPausedOrLimitFailed.mockResolvedValue(false);

    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({
        toAgentId: sisterAgentId,
        reason: "usage_limit",
        resetAt: validResetAt,
        primaryRunId: primaryAgentId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toBe("Primary is not in a fallback-eligible state");
    expect(mockIssueService.fallbackReassign).not.toHaveBeenCalled();
  });

  it("returns 422 when resetAt is outside the allowed horizon", async () => {
    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({
        toAgentId: sisterAgentId,
        reason: "usage_limit",
        resetAt: outOfHorizonResetAt,
        primaryRunId: primaryAgentId,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("outside the allowed horizon");
    expect(mockIssueService.fallbackReassign).not.toHaveBeenCalled();
  });

  it("returns 200 no-op when the issue is already assigned to the sister", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: sisterAgentId }));

    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({ toAgentId: sisterAgentId, reason: "paused_primary" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      reassignedFromAgentId: sisterAgentId,
      reassignedToAgentId: sisterAgentId,
      noop: true,
    });
    expect(mockIssueService.fallbackReassign).not.toHaveBeenCalled();
  });

  it("returns FEATURE_DISABLED when the route flag is off", async () => {
    vi.stubEnv("FEATURE_FALLBACK_REASSIGN", "off");

    const res = await request(await createApp(executorActor()))
      .post(`/api/issues/${issueId}/fallback-reassign`)
      .send({ toAgentId: sisterAgentId, reason: "usage_limit" });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "Fallback reassignment is not enabled",
      code: "FEATURE_DISABLED",
    });
    expect(mockIssueService.getById).not.toHaveBeenCalled();
  });
});
