import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";
const ownerRunId = "55555555-5555-4555-8555-555555555555";

const mockIssueService = vi.hoisted(() => ({
  assertCheckoutOwner: vi.fn(),
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockExternalObjectsService = vi.hoisted(() => ({
  getIssueSummary: vi.fn(),
  getIssueSummaries: vi.fn(),
  listForIssue: vi.fn(),
  refreshIssueObjects: vi.fn(),
}));
const mockInstanceSettingsService = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

function registerRouteMocks() {
  vi.doMock("../services/external-objects.js", () => ({
    externalObjectService: () => mockExternalObjectsService,
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/task-watchdog-scope.js", () => ({
    TASK_WATCHDOG_ORIGIN_KIND: "task_watchdog",
    resolveTaskWatchdogMutationScope: vi.fn(async () => ({ kind: "none" })),
    taskWatchdogScopeAllowsIssueMutation: vi.fn(async () => ({ kind: "none" })),
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => ({
      getById: vi.fn(async () => null),
    }),
    companySearchService: () => ({}),
    documentAnnotationService: () => ({}),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({}),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
    }),
    issueApprovalService: () => ({}),
    issueRecoveryActionService: () => ({}),
    issueReferenceService: () => ({
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => ({}),
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({}),
    routineService: () => ({}),
    workProductService: () => ({}),
  }));
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    identifier: "PAP-2265",
    title: "External object routes",
    executionWorkspaceId: null,
    ...overrides,
  };
}

async function createApp(actor: Express.Request["actor"]) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, { provider: "local_disk" } as any));
  app.use(errorHandler);
  return app;
}

function boardActor(): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    userName: null,
    userEmail: null,
    companyIds: [companyId],
    memberships: [],
    isInstanceAdmin: false,
    source: "local_implicit",
  };
}

function ownerActor(): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: ownerAgentId,
    companyId,
    keyId: "key-1",
    runId: ownerRunId,
    source: "agent_key",
  };
}

function peerActor(): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: peerAgentId,
    companyId,
    keyId: "key-2",
    runId: "66666666-6666-4666-8666-666666666666",
    source: "agent_key",
  };
}

describe("external object routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/external-objects.js");
    registerRouteMocks();
    vi.resetAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockAccessService.hasPermission.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async ({ action }: { action: string }) => ({
      allowed: action === "issue:mutate",
      explanation: "Denied by test mock",
    }));
    mockAgentService.list.mockResolvedValue([
      { id: ownerAgentId, companyId, reportsTo: null, permissions: { canCreateAgents: false } },
      { id: peerAgentId, companyId, reportsTo: null, permissions: { canCreateAgents: false } },
    ]);
    mockExternalObjectsService.getIssueSummary.mockResolvedValue({ total: 1, objects: [] });
    mockExternalObjectsService.getIssueSummaries.mockResolvedValue(new Map([
      [issueId, { total: 1, objects: [] }],
    ]));
    mockExternalObjectsService.listForIssue.mockResolvedValue([]);
    mockExternalObjectsService.refreshIssueObjects.mockResolvedValue([
      { object: { id: "77777777-7777-4777-8777-777777777777" }, refreshed: false, reason: "no_resolver" },
    ]);
    mockInstanceSettingsService.getExperimental.mockResolvedValue({
      enableExternalObjects: true,
    });
  });

  it("enforces company access on read routes", async () => {
    const app = await createApp({ ...ownerActor(), companyId: "other-company" });

    const res = await request(app).get(`/api/issues/${issueId}/external-object-summary`);

    expect(res.status).toBe(403);
    expect(mockExternalObjectsService.getIssueSummary).not.toHaveBeenCalled();
  });

  it("allows board users to read issue external object summaries", async () => {
    const app = await createApp(boardActor());

    const res = await request(app).get(`/api/issues/${issueId}/external-object-summary`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(mockExternalObjectsService.getIssueSummary).toHaveBeenCalledWith(issueId);
  });

  it("allows board users to fetch company-scoped external object summaries in bulk", async () => {
    const app = await createApp(boardActor());

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/external-object-summaries`)
      .send({ issueIds: [issueId] });

    expect(res.status).toBe(200);
    expect(res.body.summaries[issueId].total).toBe(1);
    expect(mockExternalObjectsService.getIssueSummaries).toHaveBeenCalledWith(companyId, [issueId]);
  });

  it("enforces company access on bulk external object summaries", async () => {
    const app = await createApp({ ...ownerActor(), companyId: "other-company" });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues/external-object-summaries`)
      .send({ issueIds: [issueId] });

    expect(res.status).toBe(403);
    expect(mockExternalObjectsService.getIssueSummaries).not.toHaveBeenCalled();
  });

  it("requires active checkout ownership for agent manual refresh", async () => {
    const app = await createApp(peerActor());

    const res = await request(app)
      .post(`/api/issues/${issueId}/external-objects/refresh`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Issue is checked out by another agent");
    expect(mockExternalObjectsService.refreshIssueObjects).not.toHaveBeenCalled();
  });

  it("allows the checked-out agent to request manual refresh", async () => {
    const app = await createApp(ownerActor());

    const res = await request(app)
      .post(`/api/issues/${issueId}/external-objects/refresh`)
      .send({});

    expect(res.status).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).toHaveBeenCalledWith(issueId, ownerAgentId, ownerRunId);
    expect(mockExternalObjectsService.refreshIssueObjects).toHaveBeenCalledWith(issueId, expect.objectContaining({
      companyId,
      actor: expect.objectContaining({ actorType: "agent", actorId: ownerAgentId }),
    }));
  });
});
