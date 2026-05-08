import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "99999999-9999-4999-8999-999999999999";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
// Allow-listed SafeguardReviewer (GLA-444 SAFEGUARD_COMMENT_ALLOWLIST entry).
const securityAgentId = "e65d2e79-f984-43a0-883b-9054611916d4";
// role=security but NOT in the allowlist (e.g. SecurityEngineer).
const otherSecurityAgentId = "274b7764-4444-4444-8444-444444444444";
const engineerAgentId = "55555555-5555-4555-8555-555555555555";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getDependencyReadiness: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listAttachments: vi.fn(),
  listComments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
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

const mockTreeControlService = vi.hoisted(() => ({
  getActivePauseHoldGate: vi.fn(async () => null),
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

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

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
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => mockCompanyService,
    documentService: () => ({ upsertIssueDocument: vi.fn(), getDocumentBundle: vi.fn() }),
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
    issueTreeControlService: () => mockTreeControlService,
    treeControlService: () => mockTreeControlService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({ getById: vi.fn(), update: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
    ISSUE_LIST_MAX_LIMIT: 100,
    clampIssueListLimit: (n: number) => n,
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
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "GLA-1",
    title: "Owned active issue",
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

function agentActor(agentId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
    runId: "66666666-6666-4666-8666-666666666666",
    ...overrides,
  };
}

describe("role=security cross-assignee comment exception (GLA-441)", () => {
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
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === ownerAgentId) return makeAgent(ownerAgentId);
      if (id === securityAgentId) return makeAgent(securityAgentId, { role: "security" });
      if (id === otherSecurityAgentId) return makeAgent(otherSecurityAgentId, { role: "security" });
      if (id === engineerAgentId) return makeAgent(engineerAgentId, { role: "engineer" });
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      makeAgent(ownerAgentId),
      makeAgent(securityAgentId, { role: "security" }),
      makeAgent(otherSecurityAgentId, { role: "security" }),
      makeAgent(engineerAgentId, { role: "engineer" }),
    ]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "GLA" });
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      unresolvedBlockerCount: 0,
      unresolvedBlockerIssueIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...makeIssue(),
      ...patch,
    }));
    mockIssueService.addComment.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      issueId,
      companyId,
      body: "audit comment",
    });
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.listComments.mockResolvedValue([]);
  });

  it("allows allow-listed SafeguardReviewer to POST /comments on cross-assignee high-priority issue and stamps safeguardBypass metadata", async () => {
    const app = await createApp(agentActor(securityAgentId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Safeguard reaper note" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    const addCommentArgs = mockIssueService.addComment.mock.calls[0];
    const stampedMetadata = (addCommentArgs[3] as any)?.metadata;
    expect(stampedMetadata?.safeguardBypass).toBe(true);
    expect(stampedMetadata?.version).toBe(1);
    expect(Array.isArray(stampedMetadata?.sections)).toBe(true);

    const auditCall = mockLogActivity.mock.calls.find(
      (call) => (call[1] as any)?.action === "cross_assignee_security_comment",
    );
    expect(auditCall, "audit log row missing").toBeTruthy();
    const auditDetails = (auditCall![1] as any).details;
    expect(auditDetails.safeguard_role_bypass).toBe(true);
    expect(auditDetails.callerAgentId).toBe(securityAgentId);
    expect(auditDetails.issueId).toBe(issueId);
  });

  it("allows allow-listed SafeguardReviewer to POST /comments on cross-assignee critical-priority issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ priority: "critical" }));
    const app = await createApp(agentActor(securityAgentId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Critical-prio safeguard ping" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    const stampedMetadata = (mockIssueService.addComment.mock.calls[0][3] as any)?.metadata;
    expect(stampedMetadata?.safeguardBypass).toBe(true);
  });

  it("rejects non-allow-listed role=security agent on cross-assignee high-priority issue", async () => {
    const app = await createApp(agentActor(otherSecurityAgentId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "should be blocked — not in allowlist" });

    expect(res.status).toBe(409);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    const auditCall = mockLogActivity.mock.calls.find(
      (call) => (call[1] as any)?.action === "cross_assignee_security_comment",
    );
    expect(auditCall).toBeFalsy();
  });

  it("rejects allow-listed SafeguardReviewer when issue belongs to another company", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ companyId: otherCompanyId }));
    const app = await createApp(agentActor(securityAgentId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "wrong company" });

    expect(res.status).toBe(403);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it("does not stamp safeguardBypass when the assignee posts on their own issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ assigneeAgentId: ownerAgentId }));
    const app = await createApp(agentActor(ownerAgentId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "owner note" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
    const stampedMetadata = (mockIssueService.addComment.mock.calls[0][3] as any)?.metadata;
    expect(stampedMetadata).toBeNull();
    const auditCall = mockLogActivity.mock.calls.find(
      (call) => (call[1] as any)?.action === "cross_assignee_security_comment",
    );
    expect(auditCall).toBeFalsy();
  });

  it("rejects security agent POST /comments on cross-assignee medium-priority issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ priority: "medium" }));
    const app = await createApp(agentActor(securityAgentId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "should be blocked" });

    expect(res.status).toBe(409);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    const auditCall = mockLogActivity.mock.calls.find(
      (call) => (call[1] as any)?.action === "cross_assignee_security_comment",
    );
    expect(auditCall).toBeFalsy();
  });

  it("rejects security agent PATCH on cross-assignee high-priority issue (gate stays scoped to comments)", async () => {
    const app = await createApp(agentActor(securityAgentId));

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should not pass" });

    expect(res.status).toBe(409);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    const auditCall = mockLogActivity.mock.calls.find(
      (call) => (call[1] as any)?.action === "cross_assignee_security_comment",
    );
    expect(auditCall).toBeFalsy();
  });

  it("rejects engineer agent POST /comments on cross-assignee critical-priority issue", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ priority: "critical" }));
    const app = await createApp(agentActor(engineerAgentId));

    const res = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "engineer should be blocked" });

    expect(res.status).toBe(409);
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });
});
