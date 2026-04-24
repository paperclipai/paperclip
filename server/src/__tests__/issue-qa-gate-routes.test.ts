import express from "express";
import { createServer, type Server } from "node:http";
import supertest from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err && (err as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function createRequestChain(
  app: express.Express,
  method: "get" | "patch" | "post",
  path: string,
) {
  let bodySet = false;
  let body: unknown;
  let promise: Promise<supertest.Response> | null = null;
  const run = async () => {
    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const test = supertest(server)[method](path);
      if (bodySet) test.send(body);
      return await test;
    } finally {
      await closeServer(server);
    }
  };
  const chain = {
    send(nextBody: unknown) {
      bodySet = true;
      body = nextBody;
      return chain;
    },
    then<TResult1 = supertest.Response, TResult2 = never>(
      onFulfilled?: ((value: supertest.Response) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      promise ??= run();
      return promise.then(onFulfilled, onRejected);
    },
    catch<TResult = never>(
      onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ) {
      promise ??= run();
      return promise.catch(onRejected);
    },
    finally(onFinally?: (() => void) | null) {
      promise ??= run();
      return promise.finally(onFinally ?? undefined);
    },
  };
  return chain;
}

function request(app: express.Express) {
  return {
    get: (path: string) => createRequestChain(app, "get", path),
    patch: (path: string) => createRequestChain(app, "patch", path),
    post: (path: string) => createRequestChain(app, "post", path),
  };
}

function createMockIssueService() {
  return {
    getById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    hasCommentContaining: vi.fn(),
    assertCheckoutOwner: vi.fn(),
    listComments: vi.fn(),
    listAttachments: vi.fn(),
    getAncestors: vi.fn(),
    findMentionedProjectIds: vi.fn(),
    getRelationSummaries: vi.fn(),
    listWakeableBlockedDependents: vi.fn(),
    getWakeableParentAfterChildCompletion: vi.fn(),
    addComment: vi.fn(),
    findMentionedAgents: vi.fn(),
  };
}

function createMockAgentService() {
  return {
    getById: vi.fn(),
    list: vi.fn(),
  };
}

function createMockCompanyService() {
  return {
    getById: vi.fn(),
  };
}

function createMockHeartbeatService() {
  return {
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
  };
}

function createMockExecutionGateService() {
  return {
    getExecutionBlock: vi.fn(),
  };
}

function createMockIssueMergeService() {
  return {
    getIssueMergeStatus: vi.fn(async () => null),
    attemptQaPassAutoMerge: vi.fn(async () => ({ outcome: "not_applicable" as const, status: null })),
  };
}

function createMockIssueWorkflowService() {
  return {
    decorateIssue: vi.fn(async (issue: unknown) => issue),
    evaluateLaneCompletion: vi.fn(async () => ({ canComplete: true, blockingReasons: [] })),
    applyTemplate: vi.fn(async () => {
      throw new Error("not implemented in test");
    }),
    advanceWorkflowDependents: vi.fn(async () => []),
    invalidateWorkflowDescendants: vi.fn(async () => ({ invalidatedSelf: null, invalidatedDescendants: [] })),
    handbackWorkflowLane: vi.fn(async () => null),
  };
}

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const mockIssueService = createMockIssueService();
const mockAgentService = createMockAgentService();
const mockCompanyService = createMockCompanyService();
const mockHeartbeatService = createMockHeartbeatService();
const mockExecutionGateService = createMockExecutionGateService();
const mockIssueMergeService = createMockIssueMergeService();
const mockIssueWorkflowService = createMockIssueWorkflowService();
const mockLogActivity = vi.fn(async () => undefined);
const mockLogger = createMockLogger();

function resetMockObject<T extends Record<string, unknown>>(mockObject: T) {
  for (const value of Object.values(mockObject)) {
    const maybeMock = value as { mockReset?: () => unknown };
    if (typeof maybeMock.mockReset === "function") maybeMock.mockReset();
  }
}

let mockDb = {} as any;
let issueRoutesFactory!: typeof import("../routes/issues.js").issueRoutes;
let errorHandlerMiddleware!: typeof import("../middleware/index.js").errorHandler;
let HttpErrorCtor!: typeof import("../errors.js").HttpError;
const QA_RELEASE_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const QA_RUNNER_AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

vi.doMock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => mockAgentService,
  companyService: () => mockCompanyService,
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
    listIssueDocuments: vi.fn(async () => []),
  }),
  executionGateService: () => mockExecutionGateService,
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
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  issueWorkflowService: () => mockIssueWorkflowService,
  logActivity: mockLogActivity,
  projectService: (db: unknown) => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: (_db: unknown) => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: (_db: unknown) => ({
    listForIssue: vi.fn(async () => []),
  }),
}));
vi.doMock("../services/issue-merge.js", () => ({
  issueMergeService: () => mockIssueMergeService,
}));
vi.doMock("../middleware/logger.js", () => ({
  logger: mockLogger,
  httpLogger: {},
}));
function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "local-board",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
  },
) {
  const routesForApp = issueRoutesFactory;
  const errorHandlerForApp = errorHandlerMiddleware;
  const dbForApp = mockDb;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", routesForApp(dbForApp, {} as any, {
    awaitAsyncPostResponseHooks: true,
  }));
  app.use(errorHandlerForApp);
  return app;
}

function makeIssue(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "PAP-901",
    title: "Ship candidate",
    description: null,
    status,
    workIntent: "delivery",
    priority: "medium",
    assigneeAgentId: "11111111-2222-4333-8444-555555555555",
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
    ...overrides,
  };
}

function makeCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: "company-1",
    name: "PrivateClip",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "PAP",
    issueCounter: 1,
    roadmapPath: null,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    releaseGateQaAgentId: null,
    resolvedReleaseGateQaAgentId: null,
    releaseGateQaResolutionSource: "none",
    releaseGateQaBlockingReason: null,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    dailyExecutiveSummaryEnabled: false,
    criticalBoardAlertsEmailEnabled: true,
    dailyExecutiveSummaryLastSentAt: null,
    dailyExecutiveSummaryLastStatus: null,
    dailyExecutiveSummaryLastError: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  };
}

function expectPatchedIssueResponse(
  response: { body: unknown },
  patch: Record<string, unknown>,
  issueId = "11111111-1111-4111-8111-111111111111",
) {
  const lastUpdateCall = mockIssueService.update.mock.calls.at(-1);
  if (lastUpdateCall) {
    expect(lastUpdateCall[0]).toBe(issueId);
    expect(lastUpdateCall[1]).toEqual(expect.objectContaining(patch));
  }
  expect(response.body).toMatchObject(patch);
}

function qaComment(body: string, authorAgentId = "66666666-7777-4888-8999-aaaaaaaaaaaa") {
  return {
    id: "comment-qa",
    companyId: "company-1",
    issueId: "11111111-1111-4111-8111-111111111111",
    authorAgentId,
    authorUserId: null,
    body,
    createdAt: new Date("2026-04-10T10:00:00Z"),
    updatedAt: new Date("2026-04-10T10:00:00Z"),
  };
}

describe.sequential("issue QA gate routes", () => {
  beforeAll(async () => {
    ({ issueRoutes: issueRoutesFactory } = await import("../routes/issues.js"));
    ({ errorHandler: errorHandlerMiddleware } = await import("../middleware/index.js"));
    ({ HttpError: HttpErrorCtor } = await import("../errors.js"));
  });

  beforeEach(async () => {
    resetMockObject(mockIssueService);
    resetMockObject(mockAgentService);
    resetMockObject(mockCompanyService);
    resetMockObject(mockHeartbeatService);
    resetMockObject(mockExecutionGateService);
    resetMockObject(mockIssueMergeService);
    resetMockObject(mockIssueWorkflowService);
    resetMockObject(mockLogger);
    mockLogActivity.mockReset();
    mockHeartbeatService.wakeup.mockImplementation(async () => undefined);
    mockHeartbeatService.reportRunActivity.mockImplementation(async () => undefined);
    mockHeartbeatService.getRun.mockResolvedValue(null);
    mockHeartbeatService.getActiveRunForAgent.mockResolvedValue(null);
    mockHeartbeatService.cancelRun.mockResolvedValue(null);
    mockExecutionGateService.getExecutionBlock.mockResolvedValue(null);
    mockIssueWorkflowService.decorateIssue.mockImplementation(async (issue: unknown) => {
      if (!issue || (typeof issue === "object" && Object.keys(issue).length === 0)) {
        throw new Error("issue QA gate route test attempted to decorate an empty issue payload");
      }
      return issue;
    });
    mockIssueWorkflowService.evaluateLaneCompletion.mockResolvedValue({
      canComplete: true,
      blockingReasons: [],
    });
    mockIssueWorkflowService.advanceWorkflowDependents.mockResolvedValue([]);
    mockIssueWorkflowService.invalidateWorkflowDescendants.mockResolvedValue({
      invalidatedSelf: null,
      invalidatedDescendants: [],
    });
    mockIssueWorkflowService.handbackWorkflowLane.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.hasCommentContaining.mockResolvedValue(false);
    mockIssueService.listComments.mockResolvedValue([]);
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.findMentionedProjectIds.mockResolvedValue([]);
    mockCompanyService.getById.mockResolvedValue(makeCompany());
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-auto-fix",
      companyId: "company-1",
      issueId: "11111111-1111-4111-8111-111111111111",
      authorAgentId: null,
      authorUserId: "local-board",
      body: "auto-fix",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    mockIssueMergeService.getIssueMergeStatus.mockResolvedValue(null);
    mockIssueMergeService.attemptQaPassAutoMerge.mockResolvedValue({ outcome: "not_applicable", status: null });
    mockLogActivity.mockResolvedValue(undefined);
    mockDb = {} as any;
    mockDb.insert = vi.fn(() => ({
      values: vi.fn(async () => undefined),
    }));
    mockDb.transaction = vi.fn(async (callback: (tx: typeof mockDb) => Promise<unknown>) => await callback(mockDb));
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === "agent-qa") return { id, companyId: "company-1", role: "qa", name: "QA" };
      if (id === "66666666-7777-4888-8999-aaaaaaaaaaaa") return { id, companyId: "company-1", role: "qa", name: "QA" };
      if (id === QA_RELEASE_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "66666666-7777-4888-8999-aaaaaaaaaaaa", companyId: "company-1", role: "qa", name: "QA", status: "idle" },
    ]);
  });

  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  it.sequential("rejects delivery issue done transition when current status is not in_review", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_requires_in_review",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.sequential("rejects closing a root workflow issue while any workflow lane remains incomplete", async () => {
    const existing = {
      ...makeIssue("in_review"),
      workflowTemplateKey: "engineering_delivery_v1",
      assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueWorkflowService.decorateIssue.mockResolvedValueOnce({
      ...existing,
      workflowSummary: {
        templateKey: "engineering_delivery_v1",
        isBlocked: true,
        blockingReasons: ["ENGINEER: lane must be done before the workflow can close."],
        activeRoles: ["engineer"],
        lanes: [
          {
            issueId: "lane-pm",
            role: "pm",
            title: "PM: Ship candidate",
            status: "done",
            assigneeAgentId: "agent-pm",
            assigneeUserId: null,
            workspaceMode: null,
            blockedByRoles: [],
            ready: false,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
          {
            issueId: "lane-engineer",
            role: "engineer",
            title: "Build: Ship candidate",
            status: "in_progress",
            assigneeAgentId: "11111111-2222-4333-8444-555555555555",
            assigneeUserId: null,
            workspaceMode: "isolated_workspace",
            blockedByRoles: [],
            ready: true,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
        ],
      },
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      blockingReasons: ["ENGINEER: lane must be done before the workflow can close."],
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEvent: true,
        event: "workflow.root.close_blocked",
        companyId: existing.companyId,
        issueId: existing.id,
        rootIssueId: existing.id,
        templateKey: "engineering_delivery_v1",
        blockingReasons: ["ENGINEER: lane must be done before the workflow can close."],
        activeRoles: ["engineer"],
      }),
      "workflow.root.close_blocked",
    );
  });

  it.sequential("allows closing a root workflow issue when all workflow lanes are done without same-issue QA gating", async () => {
    const existing = {
      ...makeIssue("in_progress"),
      workflowTemplateKey: "engineering_delivery_v1",
      assigneeAgentId: "11111111-2222-4333-8444-555555555555",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueWorkflowService.decorateIssue.mockResolvedValueOnce({
      ...existing,
      workflowSummary: {
        templateKey: "engineering_delivery_v1",
        isBlocked: false,
        blockingReasons: [],
        activeRoles: [],
        lanes: [
          {
            issueId: "lane-pm",
            role: "pm",
            title: "PM: Ship candidate",
            status: "done",
            assigneeAgentId: "agent-pm",
            assigneeUserId: null,
            workspaceMode: null,
            blockedByRoles: [],
            ready: false,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
          {
            issueId: "lane-designer",
            role: "designer",
            title: "Design: Ship candidate",
            status: "done",
            assigneeAgentId: "agent-designer",
            assigneeUserId: null,
            workspaceMode: null,
            blockedByRoles: [],
            ready: false,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
          {
            issueId: "lane-engineer",
            role: "engineer",
            title: "Build: Ship candidate",
            status: "done",
            assigneeAgentId: "11111111-2222-4333-8444-555555555555",
            assigneeUserId: null,
            workspaceMode: "isolated_workspace",
            blockedByRoles: [],
            ready: false,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
          {
            issueId: "lane-security",
            role: "security",
            title: "Security: Ship candidate",
            status: "done",
            assigneeAgentId: "agent-security",
            assigneeUserId: null,
            workspaceMode: "isolated_workspace",
            blockedByRoles: [],
            ready: false,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
          {
            issueId: "lane-qa",
            role: "qa",
            title: "QA: Ship candidate",
            status: "done",
            assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
            assigneeUserId: null,
            workspaceMode: "isolated_workspace",
            blockedByRoles: [],
            ready: false,
            unresolvedOwnership: false,
            artifactStatuses: [],
            blockingReasons: [],
          },
        ],
      },
    });
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "done",
      completedAt: new Date("2026-04-10T11:00:00Z"),
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expectPatchedIssueResponse(res, { status: "done" });
  });

  it.sequential("rejects delivery issue done transition when verification evidence is missing from the latest QA verdict", async () => {
    mockIssueService.getById.mockResolvedValue({
      ...makeIssue("in_review"),
      assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[QA PASS]\n[RELEASE CONFIRMED]"),
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_verification",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.sequential("rejects delivery issue done transition when the latest QA verdict only has a partial Smart Review summary", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]"),
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_qa_summary",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.sequential("uses the active QA reviewer's verdict when a later comment from another QA exists", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: QA_RELEASE_AGENT_ID,
      executionState: {
        ...makeIssue("in_review").executionState,
        status: "pending",
        currentStageId: "stage-review",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: QA_RELEASE_AGENT_ID },
      },
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });
    mockIssueService.listComments.mockResolvedValue([
      {
        ...qaComment("QA runner follow-up note without ship markers", QA_RUNNER_AGENT_ID),
        id: "comment-runner",
        createdAt: new Date("2026-04-10T11:00:00Z"),
        updatedAt: new Date("2026-04-10T11:00:00Z"),
      },
      {
        ...qaComment(
          "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
          QA_RELEASE_AGENT_ID,
        ),
        id: "comment-release",
        createdAt: new Date("2026-04-10T10:00:00Z"),
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      },
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expectPatchedIssueResponse(res, { status: "done" });
  });

  it.sequential("uses sticky qaReviewerAgentId when standalone review rows lose currentParticipant", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: "11111111-2222-4333-8444-555555555555",
      qaReviewerAgentId: QA_RELEASE_AGENT_ID,
      executionState: {
        ...makeIssue("in_review").executionState,
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.listComments.mockResolvedValue([
      {
        ...qaComment(
          "[CQ:pass] [EH:pass] [TC:fail] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
          QA_RUNNER_AGENT_ID,
        ),
        id: "comment-runner-fail",
        createdAt: new Date("2026-04-10T11:00:00Z"),
        updatedAt: new Date("2026-04-10T11:00:00Z"),
      },
      {
        ...qaComment(
          "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
          QA_RELEASE_AGENT_ID,
        ),
        id: "comment-release-pass",
        createdAt: new Date("2026-04-10T10:00:00Z"),
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      },
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });

    const res = await request(createApp()).get("/api/issues/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.qaGate).toMatchObject({
      isDeliveryScoped: true,
      canShip: false,
      missingRequirements: ["qa_gate_requires_qa_assignee"],
      review: expect.objectContaining({
        overall: "pass",
        testCoverage: "pass",
      }),
    });
  });

  it.sequential("rejects technical issue done transition when it was misassigned to a non-delivery role", async () => {
    const existing = {
      ...makeIssue("in_review"),
      identifier: "COMA-1063",
      title: "Merge branches",
      assigneeAgentId: "agent-pm",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.listComments.mockResolvedValue([]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-pm") return { id, companyId: "company-1", role: "pm", name: "Onboarding Agent" };
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === "66666666-7777-4888-8999-aaaaaaaaaaaa") return { id, companyId: "company-1", role: "qa", name: "QA" };
      return null;
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_requires_qa_assignee",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.sequential("allows delivery issue done transition when latest QA comment has both markers", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: QA_RELEASE_AGENT_ID,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RELEASE_AGENT_ID,
      ),
    ]);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "done",
      completedAt: new Date("2026-04-10T11:00:00Z"),
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expectPatchedIssueResponse(res, { status: "done" });
  });

  it.sequential("allows delivery issue done transition when the active QA verdict uses a bold summary heading and equality verification tokens", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: QA_RELEASE_AGENT_ID,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockCompanyService.getById.mockResolvedValue(
      makeCompany({
        releaseGateQaAgentId: QA_RELEASE_AGENT_ID,
        resolvedReleaseGateQaAgentId: QA_RELEASE_AGENT_ID,
        releaseGateQaResolutionSource: "configured",
      }),
    );
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        [
          "[QA PASS]",
          "[RELEASE CONFIRMED]",
          "",
          "**Smart Review Summary**",
          "Root cause: the QA parser only recognized bracketed verification tokens.",
          "Fix: accept equality tokens without loosening prose-only verification.",
          "Files: server/src/services/qa-gate.ts",
          "",
          "TYPECHECK=pass",
          "TESTS=pass",
          "BUILD=pass",
          "SMOKE/NA=pass",
        ].join("\n"),
        QA_RELEASE_AGENT_ID,
      ),
    ]);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "done",
      completedAt: new Date("2026-04-10T11:00:00Z"),
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expectPatchedIssueResponse(res, { status: "done" });
  });

  it.sequential("rejects delivery issue done transition when the assignee diverges from the active QA reviewer", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: QA_RUNNER_AGENT_ID,
      executionState: {
        ...makeIssue("in_review").executionState,
        status: "pending",
        currentStageId: "stage-review",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: QA_RELEASE_AGENT_ID },
      },
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockCompanyService.getById.mockResolvedValue(
      makeCompany({
        releaseGateQaAgentId: QA_RELEASE_AGENT_ID,
        resolvedReleaseGateQaAgentId: QA_RELEASE_AGENT_ID,
        releaseGateQaResolutionSource: "configured",
      }),
    );
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RELEASE_AGENT_ID,
      ),
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RUNNER_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_requires_qa_assignee",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.sequential("auto-assigns the sole eligible QA agent when moving a delivery issue into in_review", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: "stage-review",
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: "participant-qa", type: "agent", agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa", userId: null }],
        }],
      },
      executionState: {
        ...existing.executionState,
        status: "pending",
        currentStageId: "stage-review",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa" },
        returnAssignee: { type: "agent", agentId: "11111111-2222-4333-8444-555555555555" },
      },
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expectPatchedIssueResponse(res, {
      status: "in_review",
      assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      assigneeUserId: null,
      executionPolicy: expect.objectContaining({
        stages: [
          expect.objectContaining({
            type: "review",
            participants: [expect.objectContaining({ agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa" })],
          }),
        ],
      }),
      executionState: expect.objectContaining({
        currentStageType: "review",
        currentParticipant: expect.objectContaining({
          type: "agent",
          agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        }),
        returnAssignee: expect.objectContaining({
          type: "agent",
          agentId: "11111111-2222-4333-8444-555555555555",
        }),
      }),
    });
    const lastUpdateCall = mockIssueService.update.mock.calls.at(-1);
    if (lastUpdateCall) {
      expect(lastUpdateCall[1]).toEqual(expect.objectContaining({
        qaReviewerAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("Routed to QA"),
      expect.any(Object),
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "66666666-7777-4888-8999-aaaaaaaaaaaa",
      expect.objectContaining({
        reason: "issue_assigned",
      }),
    );
  });

  it.sequential("uses the configured release-gate QA owner only as a load-tie tiebreaker when moving a delivery issue into in_review", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: QA_RUNNER_AGENT_ID,
      executionState: {
        ...existing.executionState,
        status: "pending",
        currentStageId: "stage-review",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: QA_RUNNER_AGENT_ID },
        returnAssignee: { type: "agent", agentId: "11111111-2222-4333-8444-555555555555" },
      },
    });
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "PrivateClip",
      description: null,
      status: "active",
      pauseReason: null,
      pausedAt: null,
      issuePrefix: "PAP",
      issueCounter: 1,
      roadmapPath: null,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      releaseGateQaAgentId: QA_RUNNER_AGENT_ID,
      resolvedReleaseGateQaAgentId: QA_RUNNER_AGENT_ID,
      releaseGateQaResolutionSource: "configured",
      releaseGateQaBlockingReason: null,
      requireBoardApprovalForNewAgents: false,
      feedbackDataSharingEnabled: false,
      feedbackDataSharingConsentAt: null,
      feedbackDataSharingConsentByUserId: null,
      feedbackDataSharingTermsVersion: null,
      dailyExecutiveSummaryEnabled: false,
      criticalBoardAlertsEmailEnabled: true,
      dailyExecutiveSummaryLastSentAt: null,
      dailyExecutiveSummaryLastStatus: null,
      dailyExecutiveSummaryLastError: null,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
      createdAt: new Date("2026-04-01T00:00:00Z"),
      updatedAt: new Date("2026-04-01T00:00:00Z"),
    });
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expectPatchedIssueResponse(res, {
      status: "in_review",
      assigneeAgentId: QA_RUNNER_AGENT_ID,
      assigneeUserId: null,
      executionState: expect.objectContaining({
        currentParticipant: expect.objectContaining({ type: "agent", agentId: QA_RUNNER_AGENT_ID }),
      }),
    });
  });

  it.sequential("rejects delivery issue in_review transition when no eligible QA agent exists", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "66666666-7777-4888-8999-aaaaaaaaaaaa", companyId: "company-1", role: "qa", name: "QA", status: "paused" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_no_eligible_qa_agent",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.sequential("keeps the existing eligible QA assignee when moving a delivery issue into in_review", async () => {
    const existing = {
      ...makeIssue("todo"),
      assigneeAgentId: QA_RUNNER_AGENT_ID,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      executionState: {
        ...existing.executionState,
        status: "pending",
        currentStageId: "stage-review",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: QA_RUNNER_AGENT_ID },
        returnAssignee: { type: "agent", agentId: QA_RUNNER_AGENT_ID },
      },
    });
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expectPatchedIssueResponse(res, {
      status: "in_review",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[qa-routing]"),
      {},
    );
  });

  it.sequential("allows in_review transition when an eligible QA reviewer is explicitly requested", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockCompanyService.getById.mockResolvedValue(
      makeCompany({
        releaseGateQaAgentId: QA_RELEASE_AGENT_ID,
        resolvedReleaseGateQaAgentId: QA_RELEASE_AGENT_ID,
        releaseGateQaResolutionSource: "configured",
      }),
    );
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: QA_RUNNER_AGENT_ID,
      executionState: {
        ...existing.executionState,
        status: "pending",
        currentStageId: "stage-review",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: QA_RUNNER_AGENT_ID },
        returnAssignee: { type: "agent", agentId: "11111111-2222-4333-8444-555555555555" },
      },
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review", assigneeAgentId: QA_RUNNER_AGENT_ID });

    expect(res.status).toBe(200);
    expectPatchedIssueResponse(res, {
      status: "in_review",
      assigneeAgentId: QA_RUNNER_AGENT_ID,
      assigneeUserId: null,
      executionState: expect.objectContaining({
        currentParticipant: expect.objectContaining({ type: "agent", agentId: QA_RUNNER_AGENT_ID }),
      }),
    });
  });

  it.sequential("rejects delivery issue in_review transition when assigned agent is not QA", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === "22222222-2222-4222-8222-222222222222") {
        return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      }
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === "66666666-7777-4888-8999-aaaaaaaaaaaa") return { id, companyId: "company-1", role: "qa", name: "QA" };
      return null;
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review", assigneeAgentId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_requires_qa_assignee",
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.sequential("does not reuse a stale cached role for an assignee across requests", async () => {
    const reassignedAgentId = "22222222-2222-4222-8222-222222222222";
    const app = createApp();
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      name: "PrivateClip",
      description: null,
      status: "active",
      pauseReason: null,
      pausedAt: null,
      issuePrefix: "PAP",
      issueCounter: 1,
      roadmapPath: null,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      releaseGateQaAgentId: reassignedAgentId,
      resolvedReleaseGateQaAgentId: reassignedAgentId,
      releaseGateQaResolutionSource: "configured",
      releaseGateQaBlockingReason: null,
      requireBoardApprovalForNewAgents: false,
      feedbackDataSharingEnabled: false,
      feedbackDataSharingConsentAt: null,
      feedbackDataSharingConsentByUserId: null,
      feedbackDataSharingTermsVersion: null,
      dailyExecutiveSummaryEnabled: false,
      criticalBoardAlertsEmailEnabled: true,
      dailyExecutiveSummaryLastSentAt: null,
      dailyExecutiveSummaryLastStatus: null,
      dailyExecutiveSummaryLastError: null,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
      createdAt: new Date("2026-04-01T00:00:00Z"),
      updatedAt: new Date("2026-04-01T00:00:00Z"),
    });
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    mockIssueService.update.mockResolvedValue({
      ...makeIssue("in_progress"),
      status: "in_review",
      assigneeAgentId: reassignedAgentId,
      assigneeUserId: null,
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: reassignedAgentId, companyId: "company-1", role: "qa", name: "QA Owner", status: "idle" },
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === reassignedAgentId) {
        return { id, companyId: "company-1", role: "qa", name: "QA Owner" };
      }
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === "agent-qa") return { id, companyId: "company-1", role: "qa", name: "QA" };
      return null;
    });

    const firstRes = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review", assigneeAgentId: reassignedAgentId });

    expect(firstRes.status).toBe(200);

    mockIssueService.update.mockReset();
    mockIssueService.getById.mockResolvedValue(makeIssue("in_progress"));
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: reassignedAgentId, companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === reassignedAgentId) {
        return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      }
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      if (id === "agent-qa") return { id, companyId: "company-1", role: "qa", name: "QA" };
      return null;
    });

    const secondRes = await request(app)
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review", assigneeAgentId: reassignedAgentId });

    expect(secondRes.status).toBe(422);
    expect(secondRes.body).toMatchObject({
      reasonCode: "qa_gate_requires_qa_assignee",
    });
  });

  it.sequential("supports board-only forceDone override with overrideReason", async () => {
    const existing = makeIssue("todo");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ forceDone: true, overrideReason: "Urgent customer unblock" });

    expect(res.status).toBe(200);
    expectPatchedIssueResponse(res, { status: "done" });
  });

  it.sequential("does not write issue.updated activity for a no-op done patch", async () => {
    const existing = {
      ...makeIssue("done"),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue(existing);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expectPatchedIssueResponse(res, { status: "done" });
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.updated",
      }),
    );
  });

  it.sequential("logs derived status activity when clearing the last blocker normalizes blocked to todo", async () => {
    const existing = {
      ...makeIssue("blocked"),
      executionState: null,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.getRelationSummaries
      .mockResolvedValueOnce({
        blockedBy: [{ id: "blocker-1" }],
        blocks: [],
      })
      .mockResolvedValueOnce({
        blockedBy: [],
        blocks: [],
      });
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "todo",
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ blockedByIssueIds: [] });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "todo",
      blockedBy: [],
    });
  });

  it.sequential("routes a delivery issue to the least-loaded QA reviewer when more than one QA agent is eligible", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.list.mockResolvedValue([
      {
        ...makeIssue("todo"),
        id: "load-1",
        assigneeAgentId: QA_RELEASE_AGENT_ID,
      },
      {
        ...makeIssue("in_progress"),
        id: "load-2",
        assigneeAgentId: QA_RELEASE_AGENT_ID,
      },
    ]);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: QA_RUNNER_AGENT_ID,
      executionState: {
        ...existing.executionState,
        status: "pending",
        currentStageId: "stage-review",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: QA_RUNNER_AGENT_ID },
        returnAssignee: { type: "agent", agentId: "11111111-2222-4333-8444-555555555555" },
      },
    });
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", title: "QA and Release Engineer", status: "idle" },
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_review" });

    expect(res.status).toBe(200);
    expectPatchedIssueResponse(res, {
      status: "in_review",
      assigneeAgentId: QA_RUNNER_AGENT_ID,
      assigneeUserId: null,
      executionState: expect.objectContaining({
        currentParticipant: expect.objectContaining({ type: "agent", agentId: QA_RUNNER_AGENT_ID }),
      }),
    });
  });

  it.sequential("returns invalid_status_transition reason codes from 422 route errors", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("done"));
    mockIssueService.update.mockImplementation(() => {
      throw new HttpErrorCtor(422, "Invalid issue status transition", {
        reasonCode: "invalid_status_transition",
      });
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "in_progress" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "invalid_status_transition",
    });
  });

  it.sequential("rejects forceDone override for non-board actors", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue("todo"));

    const res = await request(createApp({
      type: "agent",
      agentId: "11111111-2222-4333-8444-555555555555",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ forceDone: true, overrideReason: "No gate needed" });

    expect(res.status).toBe(403);
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.sequential("returns qaGate fields from issue detail payload", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:warn] [TC:fail] [CM:pass] [DOC:na]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
      ),
    ]);

    const res = await request(createApp()).get("/api/issues/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.qaGate).toMatchObject({
      isDeliveryScoped: true,
      canShip: false,
      missingRequirements: ["qa_gate_failing_review"],
      review: {
        codeQuality: "pass",
        errorHandling: "warn",
        testCoverage: "fail",
        commentQuality: "pass",
        docsImpact: "na",
        overall: "fail",
      },
    });
  });

  it.sequential("returns qaGate for in_review issues in company list responses", async () => {
    mockIssueService.list.mockResolvedValue([{
      ...makeIssue("in_review"),
      assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    }]);
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
      ),
    ]);

    const res = await request(createApp()).get("/api/companies/company-1/issues?includeReviewSignals=true");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]?.qaGate).toMatchObject({
      canShip: true,
      review: { overall: "pass" },
    });
  });

  it.sequential("triggers bounded auto-fix attempts for in_review fail synthesis", async () => {
    const existing = makeIssue("in_review");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      priority: "high",
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass] [EH:pass] [TC:fail] [CM:warn] [DOC:na]"),
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ priority: "high" });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[AUTO-FIX ATTEMPT]"),
      {},
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "11111111-2222-4333-8444-555555555555",
      expect.objectContaining({
        reason: "qa_autofix_requested",
      }),
    );
  });

  it.sequential("hands back standalone delivery review comments to the builder instead of waking QA for self-fix", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: QA_RELEASE_AGENT_ID,
      qaReviewerAgentId: QA_RELEASE_AGENT_ID,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: "11111111-1111-4111-8111-111111111111",
          type: "review",
          approvalsNeeded: 1,
          participants: [{
            id: "22222222-2222-4222-8222-222222222222",
            type: "agent",
            agentId: QA_RELEASE_AGENT_ID,
            userId: null,
          }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: "11111111-1111-4111-8111-111111111111",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: QA_RELEASE_AGENT_ID },
        returnAssignee: { type: "agent", agentId: "11111111-2222-4333-8444-555555555555" },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-review-fail",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: QA_RELEASE_AGENT_ID,
      authorUserId: null,
      body: "[CQ:pass] [EH:pass] [TC:fail] [CM:warn] [DOC:na]",
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_progress",
      assigneeAgentId: "11111111-2222-4333-8444-555555555555",
      assigneeUserId: null,
      executionState: {
        ...existing.executionState,
        status: "changes_requested",
        lastDecisionOutcome: "changes_requested",
      },
    });

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-qa-review",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "[CQ:pass] [EH:pass] [TC:fail] [CM:warn] [DOC:na]" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_progress",
        assigneeAgentId: "11111111-2222-4333-8444-555555555555",
        assigneeUserId: null,
        qaReviewerAgentId: QA_RELEASE_AGENT_ID,
        executionState: expect.objectContaining({
          status: "changes_requested",
          currentStageType: "review",
          lastDecisionOutcome: "changes_requested",
        }),
      }),
      expect.anything(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockIssueService.addComment).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[AUTO-FIX ATTEMPT]"),
      {},
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      QA_RELEASE_AGENT_ID,
      expect.objectContaining({
        reason: "qa_autofix_requested",
      }),
    );
  });

  it.sequential("skips same-issue QA auto-fix for workflow lane issues", async () => {
    const existing = {
      ...makeIssue("in_review"),
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      priority: "high",
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass] [EH:pass] [TC:fail] [CM:warn] [DOC:na]"),
    ]);

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ priority: "high" });

    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockIssueService.addComment).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[AUTO-FIX ATTEMPT]"),
      {},
    );
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalledWith(
      "66666666-7777-4888-8999-aaaaaaaaaaaa",
      expect.objectContaining({
        reason: "qa_autofix_requested",
      }),
    );
  });

  it.sequential("allows closing a workflow lane from in_progress when lane completion passes without same-issue QA gating", async () => {
    const existing = {
      ...makeIssue("in_progress"),
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "engineer",
      workflowRequiredArtifacts: [
        {
          key: "implementation-summary",
          label: "Implementation artifact",
          kind: "document_or_work_product",
          blocking: true,
          documentKey: "implementation-summary",
          workProductTypes: ["branch"],
        },
      ],
      assigneeAgentId: "11111111-2222-4333-8444-555555555555",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "done",
      completedAt: new Date("2026-04-10T11:00:00Z"),
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status).toBe(200);
    expect(mockIssueWorkflowService.evaluateLaneCompletion).toHaveBeenCalledWith(existing);
    expectPatchedIssueResponse(res, { status: "done" });
  });

  it.sequential("logs workflow lane closure blocks when artifact requirements are still failing", async () => {
    const existing = {
      ...makeIssue("in_progress"),
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "engineer",
      parentId: "root-1",
      workflowRequiredArtifacts: [
        {
          key: "implementation-summary",
          label: "Implementation artifact",
          kind: "document_or_work_product",
          blocking: true,
          documentKey: "implementation-summary",
          workProductTypes: ["branch"],
        },
      ],
      assigneeAgentId: "11111111-2222-4333-8444-555555555555",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueWorkflowService.evaluateLaneCompletion.mockResolvedValueOnce({
      canComplete: false,
      blockingReasons: ["Implementation summary must be refreshed after the last workflow invalidation."],
      artifactStatuses: [],
    });

    const res = await request(createApp())
      .patch("/api/issues/11111111-1111-4111-8111-111111111111")
      .send({ status: "done" });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEvent: true,
        event: "workflow.lane.close_blocked",
        companyId: existing.companyId,
        issueId: existing.id,
        rootIssueId: "root-1",
        templateKey: "engineering_delivery_v1",
        laneRole: "engineer",
        blockingReasons: ["Implementation summary must be refreshed after the last workflow invalidation."],
      }),
      "workflow.lane.close_blocked",
    );
  });

  it.sequential("routes assignee completion comments into QA when delivery work is ready", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment
      .mockResolvedValueOnce({
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "11111111-2222-4333-8444-555555555555",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:00:00Z"),
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      })
      .mockResolvedValueOnce({
        id: "comment-qa-route",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: "[QA ROUTE]\nRouted to QA",
        createdAt: new Date("2026-04-10T10:01:00Z"),
        updatedAt: new Date("2026-04-10T10:01:00Z"),
      });
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      assigneeUserId: null,
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "11111111-2222-4333-8444-555555555555",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        assigneeUserId: null,
        qaReviewerAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        actorAgentId: "11111111-2222-4333-8444-555555555555",
        actorUserId: null,
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenNthCalledWith(
      2,
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[qa-routing]"),
      {},
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "66666666-7777-4888-8999-aaaaaaaaaaaa",
      expect.objectContaining({
        reason: "issue_commented",
      }),
    );
  });

  it.sequential("does not route workflow engineer completion comments into same-issue QA", async () => {
    const existing = {
      ...makeIssue("in_progress"),
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "engineer",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment
      .mockResolvedValueOnce({
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "11111111-2222-4333-8444-555555555555",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:00:00Z"),
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      })
      .mockResolvedValueOnce({
        id: "comment-qa-routing",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: "[qa-routing]\nRouted to QA [@QA One](/agents/aaaaaaaa-1111-4111-8111-111111111111) because this delivery issue entered in_review.",
        createdAt: new Date("2026-04-10T10:01:00Z"),
        updatedAt: new Date("2026-04-10T10:01:00Z"),
      });

    const res = await request(createApp({
      type: "agent",
      agentId: "11111111-2222-4333-8444-555555555555",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
  });

  it.sequential("does not route root workflow completion comments into same-issue QA", async () => {
    const existing = {
      ...makeIssue("in_progress"),
      workflowTemplateKey: "engineering_delivery_v1",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-ready",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: "11111111-2222-4333-8444-555555555555",
      authorUserId: null,
      body: "DONE: Root issue summary comment.",
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "11111111-2222-4333-8444-555555555555",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Root issue summary comment." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
  });

  it.sequential("hands back failing workflow QA comments to the engineer lane", async () => {
    const existing = {
      ...makeIssue("todo"),
      assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-qa-fail",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      authorUserId: null,
      body: "[CQ:pass] [EH:pass] [TC:fail] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment("[CQ:pass] [EH:pass] [TC:fail] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]"),
    ]);
    mockIssueWorkflowService.handbackWorkflowLane.mockResolvedValue({
      sourceIssueId: existing.id,
      targetIssue: {
        ...makeIssue("todo"),
        id: "engineer-lane",
        assigneeAgentId: "11111111-2222-4333-8444-555555555555",
        workflowTemplateKey: "engineering_delivery_v1",
        workflowLaneRole: "engineer",
      },
      invalidatedDescendants: [
        {
          ...existing,
          status: "blocked",
          workflowInvalidatedAt: new Date("2026-04-10T10:01:00Z"),
        },
      ],
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "[CQ:pass] [EH:pass] [TC:fail] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueWorkflowService.handbackWorkflowLane).toHaveBeenCalledWith(existing.id);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEvent: true,
        event: "workflow.handback",
        companyId: existing.companyId,
        issueId: existing.id,
        rootIssueId: null,
        templateKey: "engineering_delivery_v1",
        sourceLaneRole: "qa",
        targetLaneRole: "engineer",
        targetIssueId: "engineer-lane",
        invalidatedIssueIds: [existing.id],
        commentId: "comment-qa-fail",
      }),
      "workflow.handback",
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        opsEvent: true,
        event: "workflow.lane.invalidated",
        companyId: existing.companyId,
        issueId: existing.id,
        rootIssueId: null,
        templateKey: "engineering_delivery_v1",
        laneRole: "qa",
        sourceLaneRole: "qa",
        targetLaneRole: "engineer",
        targetIssueId: "engineer-lane",
        reason: "workflow_handback",
      }),
      "workflow.lane.invalidated",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        action: "issue.workflow_lane_invalidated",
        entityType: "issue",
        entityId: existing.id,
        details: expect.objectContaining({
          parentId: existing.parentId,
          sourceIssueId: existing.id,
          targetIssueId: "engineer-lane",
        }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "11111111-2222-4333-8444-555555555555",
      expect.objectContaining({
        reason: "issue_status_changed",
        payload: expect.objectContaining({
          issueId: "engineer-lane",
          workflowHandbackFromIssueId: existing.id,
        }),
      }),
    );
  });

  it.sequential("does not hand back a workflow QA lane for lane-local review state without failing QA tokens", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
      executionState: {
        lastDecisionOutcome: "changes_requested",
      },
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-qa-pass",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      authorUserId: null,
      body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueWorkflowService.handbackWorkflowLane).not.toHaveBeenCalled();
  });

  it.sequential("does not auto-merge a root workflow issue from QA ship markers", async () => {
    const existing = {
      ...makeIssue("in_review"),
      workflowTemplateKey: "engineering_delivery_v1",
      assigneeAgentId: QA_RELEASE_AGENT_ID,
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValueOnce({
      id: "comment-qa-pass-root",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: QA_RELEASE_AGENT_ID,
      authorUserId: null,
      body: [
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
        "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
        "[QA PASS]",
        "[RELEASE CONFIRMED]",
      ].join("\n"),
      createdAt: new Date("2026-04-10T10:00:00Z"),
      updatedAt: new Date("2026-04-10T10:00:00Z"),
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return {
          id,
          companyId: "company-1",
          role: "qa",
          name: "QA and Release Engineer",
          title: "QA and Release Engineer",
        };
      }
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: [
          "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
          "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
          "[QA PASS]",
          "[RELEASE CONFIRMED]",
        ].join("\n"),
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueMergeService.attemptQaPassAutoMerge).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalledWith(
      existing.id,
      expect.objectContaining({ status: "done" }),
    );
  });

  it.sequential("ignores QA agents in error state when routing assignee completion comments", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "66666666-7777-4888-8999-aaaaaaaaaaaa", companyId: "company-1", role: "qa", name: "QA", status: "idle" },
      { id: "agent-qa-error", companyId: "company-1", role: "qa", name: "QA Error", status: "error" },
    ]);
    mockIssueService.addComment
      .mockResolvedValueOnce({
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "11111111-2222-4333-8444-555555555555",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:00:00Z"),
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      })
      .mockResolvedValueOnce({
        id: "comment-qa-route",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: "[QA ROUTE]\nRouted to QA",
        createdAt: new Date("2026-04-10T10:01:00Z"),
        updatedAt: new Date("2026-04-10T10:01:00Z"),
      });
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
      assigneeUserId: null,
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "11111111-2222-4333-8444-555555555555",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
        assigneeUserId: null,
      }),
    );
  });

  it.sequential("routes assignee completion comments to a pooled QA reviewer when multiple QA agents are eligible", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "aaaaaaaa-1111-4111-8111-111111111111", companyId: "company-1", role: "qa", name: "QA One", status: "idle" },
      { id: "bbbbbbbb-1111-4111-8111-111111111111", companyId: "company-1", role: "qa", name: "QA Two", status: "idle" },
    ]);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: "aaaaaaaa-1111-4111-8111-111111111111",
      assigneeUserId: null,
    });
    mockIssueService.addComment
      .mockResolvedValueOnce({
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "11111111-2222-4333-8444-555555555555",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:00:00Z"),
        updatedAt: new Date("2026-04-10T10:00:00Z"),
      })
      .mockResolvedValueOnce({
        id: "comment-qa-routing",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: "[qa-routing]\nRouted to QA [@QA One](/agents/aaaaaaaa-1111-4111-8111-111111111111) because this delivery issue entered in_review.",
        createdAt: new Date("2026-04-10T10:01:00Z"),
        updatedAt: new Date("2026-04-10T10:01:00Z"),
      });

    const res = await request(createApp({
      type: "agent",
      agentId: "11111111-2222-4333-8444-555555555555",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "aaaaaaaa-1111-4111-8111-111111111111",
        assigneeUserId: null,
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenNthCalledWith(
      2,
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[qa-routing]"),
      {},
    );
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "aaaaaaaa-1111-4111-8111-111111111111",
      expect.objectContaining({
        reason: "issue_commented",
      }),
    );
  });

  it.sequential("still routes to pooled QA when an older gate marker falls outside a short recent window", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "aaaaaaaa-1111-4111-8111-111111111111", companyId: "company-1", role: "qa", name: "QA One", status: "idle" },
      { id: "bbbbbbbb-1111-4111-8111-111111111111", companyId: "company-1", role: "qa", name: "QA Two", status: "idle" },
    ]);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: "aaaaaaaa-1111-4111-8111-111111111111",
      assigneeUserId: null,
    });
    const recentComments = [
      {
        id: "comment-new-1",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: "local-board",
        body: "Newest chatter",
        createdAt: new Date("2026-04-10T10:05:00Z"),
        updatedAt: new Date("2026-04-10T10:05:00Z"),
      },
      {
        id: "comment-new-2",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: "local-board",
        body: "More chatter",
        createdAt: new Date("2026-04-10T10:04:00Z"),
        updatedAt: new Date("2026-04-10T10:04:00Z"),
      },
      {
        id: "comment-new-3",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: "local-board",
        body: "Still active",
        createdAt: new Date("2026-04-10T10:03:00Z"),
        updatedAt: new Date("2026-04-10T10:03:00Z"),
      },
      {
        id: "comment-new-4",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: "local-board",
        body: "More thread traffic",
        createdAt: new Date("2026-04-10T10:02:00Z"),
        updatedAt: new Date("2026-04-10T10:02:00Z"),
      },
      {
        id: "comment-new-5",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: "local-board",
        body: "Another follow-up",
        createdAt: new Date("2026-04-10T10:01:30Z"),
        updatedAt: new Date("2026-04-10T10:01:30Z"),
      },
      {
        id: "comment-qa-gate-existing",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: [
          "[qa-assignment-required]",
          "Workflow gate: requires QA assignee before entering in_review.",
          "Board action required.",
        ].join("\n"),
        createdAt: new Date("2026-04-10T10:01:00Z"),
        updatedAt: new Date("2026-04-10T10:01:00Z"),
      },
    ];
    mockIssueService.hasCommentContaining.mockResolvedValue(true);
    mockIssueService.listComments.mockImplementation(async (_issueId: string, opts?: { limit?: number | null }) => {
      const limit = opts?.limit ?? recentComments.length;
      return recentComments.slice(0, limit);
    });
    mockIssueService.addComment
      .mockResolvedValueOnce({
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "11111111-2222-4333-8444-555555555555",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:06:00Z"),
        updatedAt: new Date("2026-04-10T10:06:00Z"),
      })
      .mockResolvedValueOnce({
        id: "comment-qa-routing",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: "[qa-routing]\nRouted to QA [@QA One](/agents/aaaaaaaa-1111-4111-8111-111111111111) because this delivery issue entered in_review.",
        createdAt: new Date("2026-04-10T10:06:30Z"),
        updatedAt: new Date("2026-04-10T10:06:30Z"),
      });

    const res = await request(createApp({
      type: "agent",
      agentId: "11111111-2222-4333-8444-555555555555",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "aaaaaaaa-1111-4111-8111-111111111111",
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(2);
    expect(mockIssueService.addComment).toHaveBeenLastCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[qa-routing]"),
      {},
    );
  });

  it.sequential("routes to pooled QA after fresh completion truth even when an older gate marker exists", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "aaaaaaaa-1111-4111-8111-111111111111", companyId: "company-1", role: "qa", name: "QA One", status: "idle" },
      { id: "bbbbbbbb-1111-4111-8111-111111111111", companyId: "company-1", role: "qa", name: "QA Two", status: "idle" },
    ]);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: "aaaaaaaa-1111-4111-8111-111111111111",
      assigneeUserId: null,
    });
    mockIssueService.hasCommentContaining.mockResolvedValue(true);
    mockIssueService.addComment
      .mockResolvedValueOnce({
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "11111111-2222-4333-8444-555555555555",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:06:00Z"),
        updatedAt: new Date("2026-04-10T10:06:00Z"),
      })
      .mockResolvedValueOnce({
        id: "comment-qa-gate",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: [
          "[qa-assignment-required]",
          "Workflow gate: requires QA assignee before entering in_review.",
          "Board action required.",
        ].join("\n"),
        createdAt: new Date("2026-04-10T10:07:00Z"),
        updatedAt: new Date("2026-04-10T10:07:00Z"),
      });
    mockIssueService.listComments.mockResolvedValue([
      {
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "11111111-2222-4333-8444-555555555555",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:06:00Z"),
        updatedAt: new Date("2026-04-10T10:06:00Z"),
      },
      {
        id: "comment-chatter",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: "local-board",
        body: "Thanks, I will pick the QA owner next.",
        createdAt: new Date("2026-04-10T10:05:00Z"),
        updatedAt: new Date("2026-04-10T10:05:00Z"),
      },
      {
        id: "comment-qa-gate-existing",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: [
          "[qa-assignment-required]",
          "Workflow gate: requires QA assignee before entering in_review.",
          "Board action required.",
        ].join("\n"),
        createdAt: new Date("2026-04-10T10:01:00Z"),
        updatedAt: new Date("2026-04-10T10:01:00Z"),
      },
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: "11111111-2222-4333-8444-555555555555",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        status: "in_review",
        assigneeAgentId: "aaaaaaaa-1111-4111-8111-111111111111",
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(2);
    expect(mockIssueService.addComment).toHaveBeenNthCalledWith(
      2,
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[qa-routing]"),
      {},
    );
  });

  it.sequential("does not auto-route ticket-authoring audit work into QA review after completion truth", async () => {
    const existing = makeIssue("in_progress", {
      title: "UI Audit - Review and incrementally improve the cart UI in this workspace using Hermes.",
      description: [
        "This is a ticket-authoring task, not an implementation task.",
        "Do not change code. Write implementation tickets only.",
      ].join("\n"),
      workIntent: "audit",
      assigneeAgentId: "11111111-2222-4333-8444-555555555555",
    });
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "aaaaaaaa-1111-4111-8111-111111111111", companyId: "company-1", role: "qa", name: "QA One", status: "idle" },
    ]);
    mockIssueService.addComment.mockResolvedValue({
      id: "comment-ready",
      companyId: "company-1",
      issueId: existing.id,
      authorAgentId: "11111111-2222-4333-8444-555555555555",
      authorUserId: null,
      body: "DONE: Audit completed and implementation tickets are ready.",
      createdAt: new Date("2026-04-10T10:06:00Z"),
      updatedAt: new Date("2026-04-10T10:06:00Z"),
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "11111111-2222-4333-8444-555555555555",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Audit completed and implementation tickets are ready." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(1);
  });

  it.sequential("does not need historical gate-comment inspection when pooled QA routing can proceed", async () => {
    const existing = makeIssue("in_progress");
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: "aaaaaaaa-1111-4111-8111-111111111111", companyId: "company-1", role: "qa", name: "QA One", status: "idle" },
      { id: "bbbbbbbb-1111-4111-8111-111111111111", companyId: "company-1", role: "qa", name: "QA Two", status: "idle" },
    ]);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      status: "in_review",
      assigneeAgentId: "aaaaaaaa-1111-4111-8111-111111111111",
      assigneeUserId: null,
    });
    mockIssueService.hasCommentContaining.mockResolvedValue(true);
    mockIssueService.addComment
      .mockResolvedValueOnce({
        id: "comment-ready",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: "11111111-2222-4333-8444-555555555555",
        authorUserId: null,
        body: "DONE: Implemented the fix and verified the regression coverage.",
        createdAt: new Date("2026-04-10T10:06:00Z"),
        updatedAt: new Date("2026-04-10T10:06:00Z"),
      })
      .mockResolvedValueOnce({
        id: "comment-qa-routing",
        companyId: "company-1",
        issueId: existing.id,
        authorAgentId: null,
        authorUserId: null,
        body: "[qa-routing]\nRouted to QA [@QA One](/agents/aaaaaaaa-1111-4111-8111-111111111111) because this delivery issue entered in_review.",
        createdAt: new Date("2026-04-10T10:06:30Z"),
        updatedAt: new Date("2026-04-10T10:06:30Z"),
      });

    const res = await request(createApp({
      type: "agent",
      agentId: "11111111-2222-4333-8444-555555555555",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({ body: "DONE: Implemented the fix and verified the regression coverage." });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.listComments).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        order: "desc",
        limit: 500,
      }),
    );
    expect(mockIssueService.addComment).toHaveBeenCalledTimes(2);
    expect(mockIssueService.addComment).toHaveBeenLastCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.stringContaining("[qa-routing]"),
      {},
    );
  });

  it.sequential("auto-merges and closes an in_review issue when a QA comment includes both release markers", async () => {
    const existing = { ...makeIssue("in_review"), assigneeAgentId: QA_RELEASE_AGENT_ID };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });
    mockIssueService.addComment.mockResolvedValue({
      ...qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RELEASE_AGENT_ID,
      ),
      createdByRunId: null,
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RELEASE_AGENT_ID,
      ),
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);
    mockIssueMergeService.attemptQaPassAutoMerge.mockResolvedValue({
      outcome: "merged",
      status: {
        enabled: true,
        state: "merged",
        targetBranch: "master",
        sourceBranch: "feature/qa-pass",
        repoRoot: "/repo",
        reason: null,
        mergedCommit: "abc1234",
        mergedAt: new Date("2026-04-10T12:00:00Z"),
        lastAttemptedAt: new Date("2026-04-10T12:00:00Z"),
        lastIssueCommentStatus: null,
        createdByRuntime: true,
        branchProvenanceSource: "runtime_created",
      },
    });

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueMergeService.attemptQaPassAutoMerge).toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it.sequential("closes an in_review issue when a canonical QA comment satisfies the gate and merge-on-QA is not applicable", async () => {
    const existing = { ...makeIssue("in_review"), assigneeAgentId: QA_RELEASE_AGENT_ID };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });
    mockIssueService.addComment.mockResolvedValue({
      ...qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RELEASE_AGENT_ID,
      ),
      createdByRunId: null,
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment(
        "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
        QA_RELEASE_AGENT_ID,
      ),
    ]);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);
    mockIssueMergeService.attemptQaPassAutoMerge.mockResolvedValue({
      outcome: "not_applicable",
      status: null,
    });

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]\n[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]\n[QA PASS]\n[RELEASE CONFIRMED]",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueMergeService.attemptQaPassAutoMerge).toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it.sequential("closes a workflow QA lane and wakes the workflow root when the lane gate is satisfied", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: QA_RELEASE_AGENT_ID,
      qaReviewerAgentId: QA_RELEASE_AGENT_ID,
      parentId: "root-issue-1",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({ ...existing, status: "done" });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "root-issue-1",
      assigneeAgentId: "agent-root",
      childIssueIds: [existing.id],
    });
    mockIssueWorkflowService.evaluateLaneCompletion.mockResolvedValue({
      canComplete: true,
      blockingReasons: [],
      artifactStatuses: [],
      authorizedOwnerAgentId: QA_RELEASE_AGENT_ID,
    });
    const verdictBody = [
      "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
      "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
      "[QA PASS]",
      "[RELEASE CONFIRMED]",
    ].join("\n");
    mockIssueService.addComment.mockResolvedValue({
      ...qaComment(verdictBody, QA_RELEASE_AGENT_ID),
      createdByRunId: null,
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment(verdictBody, QA_RELEASE_AGENT_ID),
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: verdictBody,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueWorkflowService.evaluateLaneCompletion).toHaveBeenCalledWith(existing);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
    expect(mockIssueService.getWakeableParentAfterChildCompletion).toHaveBeenCalledWith("root-issue-1");
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-root",
      expect.objectContaining({
        reason: "issue_children_completed",
        payload: expect.objectContaining({
          issueId: "root-issue-1",
          completedChildIssueId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it.sequential("accepts a workflow QA verdict from the current assignee when qaReviewerAgentId is stale", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: QA_RUNNER_AGENT_ID,
      qaReviewerAgentId: QA_RELEASE_AGENT_ID,
      parentId: "root-issue-1",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.update.mockResolvedValue({
      ...existing,
      qaReviewerAgentId: QA_RUNNER_AGENT_ID,
      status: "done",
    });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "root-issue-1",
      assigneeAgentId: "agent-root",
      childIssueIds: [existing.id],
    });
    mockIssueWorkflowService.evaluateLaneCompletion.mockResolvedValue({
      canComplete: true,
      blockingReasons: [],
      artifactStatuses: [],
      authorizedOwnerAgentId: QA_RUNNER_AGENT_ID,
    });
    const verdictBody = [
      "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
      "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
      "[QA PASS]",
      "[RELEASE CONFIRMED]",
    ].join("\n");
    mockIssueService.addComment.mockResolvedValue({
      ...qaComment(verdictBody, QA_RUNNER_AGENT_ID),
      createdByRunId: null,
    });
    mockIssueService.listComments.mockResolvedValue([
      qaComment(verdictBody, QA_RUNNER_AGENT_ID),
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RUNNER_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: verdictBody,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueWorkflowService.evaluateLaneCompletion).toHaveBeenCalledWith(existing);
    expect(mockIssueService.update).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({ status: "done" }),
    );
  });

  it.sequential("rejects workflow QA verdict comments when only a stale qaReviewerAgentId remains", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: null,
      qaReviewerAgentId: QA_RELEASE_AGENT_ID,
      parentId: "root-issue-1",
      workflowTemplateKey: "engineering_delivery_v1",
      workflowLaneRole: "qa",
    };
    mockIssueService.getById.mockResolvedValue(existing);

    const verdictBody = [
      "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
      "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
      "[QA PASS]",
      "[RELEASE CONFIRMED]",
    ].join("\n");

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: verdictBody,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("No active QA reviewer is assigned");
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it.sequential("rejects a ship-marker QA verdict comment that only uses structured prose Smart Review output", async () => {
    const existing = { ...makeIssue("in_review"), assigneeAgentId: QA_RELEASE_AGENT_ID };
    mockIssueService.getById.mockResolvedValue(existing);
    const verdictBody = [
      "[QA PASS]",
      "[RELEASE CONFIRMED]",
      "",
      "Smart Review Summary",
      "Root cause: cart mode label keys were nested under the wrong locale path.",
      "Fix: moved the keys under cart.modeStatus and verified the component wiring.",
      "Tests: 12/12 passing in cart mode coverage.",
      "Files: app/assets/js/pages/cart/page.tsx, app/assets/js/locales/es.json",
      "Verification: build verified and release readiness confirmed.",
    ].join("\n");
    mockIssueService.addComment.mockResolvedValue({
      ...qaComment(verdictBody, QA_RELEASE_AGENT_ID),
      createdByRunId: null,
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: verdictBody,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_qa_summary",
    });
    expect(mockIssueMergeService.attemptQaPassAutoMerge).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it.sequential("rejects ship-marker QA verdict comments that use equality verification tokens instead of the canonical token line", async () => {
    const existing = { ...makeIssue("in_review"), assigneeAgentId: QA_RELEASE_AGENT_ID };
    mockIssueService.getById.mockResolvedValue(existing);
    const verdictBody = [
      "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
      "TYPECHECK=pass",
      "TESTS=pass",
      "BUILD=pass",
      "SMOKE/NA=pass",
      "[QA PASS]",
      "[RELEASE CONFIRMED]",
    ].join("\n");
    mockIssueService.addComment.mockResolvedValue({
      ...qaComment(verdictBody, QA_RELEASE_AGENT_ID),
      createdByRunId: null,
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: verdictBody,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_verification",
    });
    expect(mockIssueMergeService.attemptQaPassAutoMerge).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it.sequential("rejects ship-marker verdict comments from a QA agent who is not the active reviewer", async () => {
    const existing = {
      ...makeIssue("in_review"),
      assigneeAgentId: QA_RELEASE_AGENT_ID,
      executionState: {
        ...makeIssue("in_review").executionState,
        status: "pending",
        currentStageId: "stage-review",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: QA_RELEASE_AGENT_ID },
      },
    };
    mockIssueService.getById.mockResolvedValue(existing);
    mockIssueService.addComment.mockResolvedValue({
      ...qaComment("[QA PASS]\n[RELEASE CONFIRMED]", QA_RUNNER_AGENT_ID),
      createdByRunId: null,
    });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === QA_RUNNER_AGENT_ID) return { id, companyId: "company-1", role: "qa", name: "QA Runner" };
      if (id === "11111111-2222-4333-8444-555555555555") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "11111111-2222-4333-8444-555555555555", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
      { id: QA_RUNNER_AGENT_ID, companyId: "company-1", role: "qa", name: "QA Runner", status: "idle" },
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RUNNER_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: [
          "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:pass]",
          "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
          "[QA PASS]",
          "[RELEASE CONFIRMED]",
        ].join("\n"),
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error).toContain("active QA reviewer");
    expect(mockIssueMergeService.attemptQaPassAutoMerge).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });

  it.sequential("rejects phrase-only QA verdict comments that omit the explicit [QA PASS] marker", async () => {
    const existing = { ...makeIssue("in_review"), assigneeAgentId: QA_RELEASE_AGENT_ID };
    mockIssueService.getById.mockResolvedValue(existing);
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === QA_RELEASE_AGENT_ID) {
        return { id, companyId: "company-1", role: "qa", name: "QA and Release Engineer" };
      }
      if (id === "agent-engineer") return { id, companyId: "company-1", role: "engineer", name: "Eng" };
      return null;
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-engineer", companyId: "company-1", role: "engineer", name: "Eng", status: "idle" },
      { id: QA_RELEASE_AGENT_ID, companyId: "company-1", role: "qa", name: "QA and Release Engineer", status: "idle" },
    ]);

    const res = await request(createApp({
      type: "agent",
      agentId: QA_RELEASE_AGENT_ID,
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    }))
      .post("/api/issues/11111111-1111-4111-8111-111111111111/comments")
      .send({
        body: [
          "Smart Review Summary",
          "Root cause: cart mode label keys were nested under the wrong locale path.",
          "Fix: moved the keys under cart.modeStatus and verified the component wiring.",
          "[CQ:pass] [EH:pass] [TC:pass] [CM:pass] [DOC:na]",
          "[TYPECHECK:pass] [TESTS:pass] [BUILD:pass] [SMOKE:pass]",
          "Verification: build verified and release readiness confirmed.",
          "Final verdict: QA PASS.",
        ].join("\n"),
      });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body).toMatchObject({
      reasonCode: "qa_gate_missing_qa_pass",
    });
    expect(mockIssueMergeService.attemptQaPassAutoMerge).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
  });
});
