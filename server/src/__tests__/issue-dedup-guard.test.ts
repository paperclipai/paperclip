/**
 * FOC-956: Tests for the server-side duplicate-issue guard on POST /api/companies/:companyId/issues.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockQueueWakeup = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockQueueWakeup,
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      canUser: vi.fn(async () => true),
      decide: vi.fn(async (input: { action?: string }) => ({
        allowed: true,
        action: input.action,
        reason: "allow_explicit_grant",
        explanation: "Allowed by test grant.",
      })),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
      resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
        ambiguous: false,
        agent: { id: raw },
      })),
    }),
    clampIssueListLimit: (value: number) => value,
    companyService: () => ({
      getById: vi.fn(async () => ({ id: COMPANY_ID, attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    ISSUE_LIST_MAX_LIMIT: 1000,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: vi.fn(async () => undefined),
    }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => [COMPANY_ID]),
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
    issueThreadInteractionService: () => ({}),
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

function makeChainableQuery(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  const terminus = {
    limit: vi.fn().mockReturnValue(
      new Promise<unknown[]>((resolve) => resolve(rows)),
    ),
  };
  chain.select = vi.fn().mockReturnValue(chain);
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(terminus);
  return chain;
}

function makeDb(candidateRows: unknown[] = []) {
  return {
    select: vi.fn().mockImplementation(() => makeChainableQuery(candidateRows)),
  };
}

async function createApp(db: ReturnType<typeof makeDb>) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: AGENT_ID,
      companyId: COMPANY_ID,
      source: "agent_key",
    };
    next();
  });
  app.use("/api", issueRoutes(db as any, {} as any));
  app.use(errorHandler);
  return app;
}

const BASE_ISSUE_BODY = {
  title: "Deploy the widget",
  status: "todo",
  priority: "medium",
};

const EXISTING_ISSUE = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  identifier: "FOC-1",
  title: "Deploy the widget",
  createdAt: new Date(Date.now() - 5000), // 5 seconds ago
};

describe.sequential("issue dedup guard", () => {
  beforeEach(() => {
    vi.resetModules();
    mockIssueService.create.mockReset();
    mockLogActivity.mockReset();
    mockQueueWakeup.mockReset();
    registerModuleMocks();
  });

  it("returns 409 when the same agent creates a duplicate title under the same parent within the window", async () => {
    const db = makeDb([EXISTING_ISSUE]);
    const app = await createApp(db);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send(BASE_ISSUE_BODY);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "duplicate_issue",
      existingIssueId: EXISTING_ISSUE.id,
      existingIssueIdentifier: EXISTING_ISSUE.identifier,
    });
    expect(res.body.message).toMatch(/created \d+s ago/);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("passes through when no recent issues match the normalized title", async () => {
    const CREATED_ISSUE = { id: "new-id", identifier: "FOC-2", title: "Deploy the widget", companyId: COMPANY_ID };
    mockIssueService.create.mockResolvedValueOnce(CREATED_ISSUE);
    const db = makeDb([]); // no candidates
    const app = await createApp(db);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send(BASE_ISSUE_BODY);

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledOnce();
  });

  it("is case-insensitive and whitespace-tolerant when matching titles", async () => {
    const db = makeDb([{ ...EXISTING_ISSUE, title: "  DEPLOY  THE  WIDGET  " }]);
    const app = await createApp(db);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({ ...BASE_ISSUE_BODY, title: "deploy the widget" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("duplicate_issue");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("passes through when actor is a user (not an agent)", async () => {
    const CREATED_ISSUE = { id: "new-id", identifier: "FOC-3", title: "Deploy the widget", companyId: COMPANY_ID };
    mockIssueService.create.mockResolvedValueOnce(CREATED_ISSUE);
    const db = makeDb([EXISTING_ISSUE]);

    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/issues.js"),
      import("../middleware/index.js"),
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // User actor — agentId absent
      (req as any).actor = {
        type: "board",
        userId: "user-1",
        companyIds: [COMPANY_ID],
        source: "local_implicit",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db as any, {} as any));
    app.use(errorHandler);

    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send(BASE_ISSUE_BODY);

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledOnce();
  });
});
