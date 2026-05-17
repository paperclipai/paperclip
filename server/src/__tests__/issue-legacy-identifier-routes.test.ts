import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getByIdentifier: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentTaskCompleted: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    ISSUE_LIST_DEFAULT_LIMIT: 500,
    ISSUE_LIST_MAX_LIMIT: 1000,
    accessService: () => ({
      canUser: vi.fn(async () => true),
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
    companySearchService: () => ({
      search: vi.fn(async () => ({ results: [] })),
    }),
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    documentService: () => ({}),
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
    heartbeatService: () => ({
      getActiveRunForAgent: vi.fn(async () => null),
      getRun: vi.fn(async () => null),
    }),
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
    issueApprovalService: () => ({
      listApprovalsForIssue: vi.fn(async () => []),
      unlink: vi.fn(async () => undefined),
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueReferenceService: () => ({
      deleteDocumentSource: vi.fn(async () => undefined),
      diffIssueReferenceSummary: vi.fn(() => ({
        addedReferencedIssues: [],
        currentReferencedIssues: [],
        removedReferencedIssues: [],
      })),
      emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
      listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
      syncComment: vi.fn(async () => undefined),
      syncDocument: vi.fn(async () => undefined),
      syncIssue: vi.fn(async () => undefined),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
    }),
    logActivity: vi.fn(async () => undefined),
    projectService: () => mockProjectService,
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));

  vi.doMock("../services/execution-workspaces.js", () => ({
    executionWorkspaceService: () => ({
      getById: vi.fn(async () => null),
    }),
  }));

  vi.doMock("../services/feedback.js", () => ({
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
  }));

  vi.doMock("../services/issue-assignment-wakeup.js", () => ({
    queueIssueAssignmentWakeup: vi.fn(async () => undefined),
  }));
}

async function createApp() {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "cloud-user-1",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
      source: "cloud_tenant",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe.sequential("legacy issue identifier lookup routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/execution-workspaces.js");
    vi.doUnmock("../services/feedback.js");
    vi.doUnmock("../services/issue-assignment-wakeup.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockProjectService.getById.mockResolvedValue(null);
  });

  it("supports agent lookup paths that use issue identifiers without a company path", async () => {
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1",
      identifier: "CHRA-868",
      priority: "medium",
      status: "todo",
      title: "Agent identifier lookup",
    };
    mockIssueService.getByIdentifier.mockResolvedValue(issue);
    const app = await createApp();

    const byIdentifier = await request(app).get("/api/issues/by-identifier/chra-868");
    expect(byIdentifier.status, JSON.stringify(byIdentifier.body)).toBe(200);
    expect(byIdentifier.body).toMatchObject(issue);

    const identifierQuery = await request(app).get("/api/issues?identifier=CHRA-868&limit=1");
    expect(identifierQuery.status, JSON.stringify(identifierQuery.body)).toBe(200);
    expect(identifierQuery.body).toEqual([expect.objectContaining(issue)]);

    const qQuery = await request(app).get("/api/issues?q=CHRA-868&limit=5");
    expect(qQuery.status, JSON.stringify(qQuery.body)).toBe(200);
    expect(qQuery.body).toEqual([expect.objectContaining(issue)]);

    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("CHRA-868");
  });

  it("keeps the missing-company guard for generic issue list requests", async () => {
    const app = await createApp();

    const response = await request(app).get("/api/issues?limit=1");

    expect(response.status, JSON.stringify(response.body)).toBe(400);
    expect(response.body).toMatchObject({
      error: "Missing companyId in path. Use /api/companies/{companyId}/issues.",
    });
  });

  it("creates issues through legacy project-scoped create paths", async () => {
    const projectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const createdIssue = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      companyId: "company-1",
      identifier: "CHRA-1104",
      projectId,
      priority: "high",
      status: "todo",
      title: "Investigate agent create path",
    };
    mockProjectService.getById.mockResolvedValue({
      id: projectId,
      companyId: "company-1",
      goalIds: [],
    });
    mockIssueService.create.mockResolvedValue(createdIssue);
    const app = await createApp();

    const byProjectPath = await request(app)
      .post(`/api/projects/${projectId}/issues`)
      .send({
        title: createdIssue.title,
        description: "Created from a legacy project issue path.",
        priority: "high",
        status: "todo",
      });

    expect(byProjectPath.status, JSON.stringify(byProjectPath.body)).toBe(201);
    expect(byProjectPath.body).toMatchObject(createdIssue);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        projectId,
        title: createdIssue.title,
        priority: "high",
        status: "todo",
      }),
    );

    mockIssueService.create.mockClear();

    const byCreateAlias = await request(app)
      .post("/api/issues/create")
      .send({
        title: createdIssue.title,
        description: "Created from a legacy issue create path.",
        priority: "high",
        projectId,
        status: "todo",
      });

    expect(byCreateAlias.status, JSON.stringify(byCreateAlias.body)).toBe(201);
    expect(byCreateAlias.body).toMatchObject(createdIssue);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        projectId,
        title: createdIssue.title,
        priority: "high",
        status: "todo",
      }),
    );
  });
});
