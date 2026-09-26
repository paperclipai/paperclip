import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { hoistModuleGraph } from "./helpers/hoist-module-graph.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const runId = "55555555-5555-4555-8555-555555555555";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  checkout: vi.fn(),
  addComment: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(async () => null),
}));

const mockRunnerGoalService = vi.hoisted(() => ({
  projection: vi.fn(async () => null),
  act: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockBindRunContextToCheckedOutIssue = vi.hoisted(() => vi.fn(async () => true));

function registerServiceMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

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

  vi.doMock("../services/activity-log.js", () => ({
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/cross-issue-influence-limit.js", () => ({
    bindRunContextToCheckedOutIssue: mockBindRunContextToCheckedOutIssue,
    observeCrossIssueInfluence: vi.fn(async () => null),
    crossIssueInfluenceLimitError: vi.fn(),
    crossIssueInfluenceRunContextError: () => new HttpError(
      403,
      "Agent issue comments and updates require a valid heartbeat run so cross-issue influence can be contained",
      { code: "cross_issue_influence_run_context_required" },
    ),
  }));

  vi.doMock("../services/heartbeat.js", () => ({
    heartbeatService: () => mockHeartbeatService,
  }));

  vi.doMock("../services/issues.js", () => ({
    issueService: () => mockIssueService,
  }));

  vi.doMock("../services/projects.js", () => ({
    projectService: () => mockProjectService,
  }));

  vi.doMock("../services/runner-goals.js", () => ({
    runnerGoalService: () => mockRunnerGoalService,
    RunnerGoalActionError: class RunnerGoalActionError extends Error {},
    RunnerGoalConflictError: class RunnerGoalConflictError extends Error {},
  }));

  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1" })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async () => null),
    }),
    companySkillService: () => ({
      completeTestRunForIssue: vi.fn(async () => null),
    }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({
      getById: vi.fn(async () => null),
    }),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({
      getDefaultCompanyGoal: vi.fn(async () => null),
      getById: vi.fn(async () => null),
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
    issueThreadInteractionService: () => ({
      listForIssue: vi.fn(async () => []),
      expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
      expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  }));
}

function makeIssue() {
  return {
    id: issueId,
    companyId: "company-1",
    status: "todo",
    priority: "medium",
    assigneeAgentId: agentId,
    assigneeUserId: null,
    createdByUserId: "local-board",
    identifier: "PAP-2943",
    title: "Taskless checkout run context",
    projectId: null,
    executionRunId: null,
    checkoutRunId: null,
    executionWorkspaceId: null,
  };
}

describe.sequential("issue checkout binds the run context to the checked-out issue", () => {
  const routeModules = hoistModuleGraph(registerServiceMocks, async () => {
    const [{ issueRoutes }, { errorHandler }] = await Promise.all([
      vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    return { issueRoutes, errorHandler };
  });

  function createApp(actor: Record<string, unknown>) {
    const { issueRoutes, errorHandler } = routeModules.value;
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

  function agentActor(overrides: Record<string, unknown> = {}) {
    return {
      type: "agent",
      agentId,
      companyId: "company-1",
      runId,
      source: "agent_key",
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.checkout.mockResolvedValue({ ...makeIssue(), status: "in_progress" });
    mockBindRunContextToCheckedOutIssue.mockResolvedValue(true);
  });

  it("anchors a taskless run to the issue it checked out", async () => {
    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(200);
    expect(mockBindRunContextToCheckedOutIssue).toHaveBeenCalledTimes(1);
    expect(mockBindRunContextToCheckedOutIssue).toHaveBeenCalledWith(expect.anything(), {
      companyId: "company-1",
      agentId,
      runId,
      issueId,
    });
  });

  it("does not bind when the actor has no run id", async () => {
    const res = await request(createApp(agentActor({ runId: null })))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(401);
    expect(mockIssueService.checkout).not.toHaveBeenCalled();
    expect(mockBindRunContextToCheckedOutIssue).not.toHaveBeenCalled();
  });

  it("does not bind when the checkout itself fails", async () => {
    mockIssueService.checkout.mockRejectedValue(new Error("checkout conflict"));

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(500);
    expect(mockBindRunContextToCheckedOutIssue).not.toHaveBeenCalled();
  });

  it("a bind failure never fails an otherwise successful checkout", async () => {
    mockBindRunContextToCheckedOutIssue.mockRejectedValue(new Error("bind failed"));

    const res = await request(createApp(agentActor()))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(200);
    expect(mockBindRunContextToCheckedOutIssue).toHaveBeenCalledTimes(1);
  });

  it("does not bind for board actors without a run", async () => {
    const res = await request(createApp({
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    }))
      .post(`/api/issues/${issueId}/checkout`)
      .send({
        agentId,
        expectedStatuses: ["todo", "backlog", "blocked"],
      });

    expect(res.status).toBe(200);
    expect(mockBindRunContextToCheckedOutIssue).not.toHaveBeenCalled();
  });
});
