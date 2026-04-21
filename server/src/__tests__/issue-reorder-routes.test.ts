import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const beforeIssueId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  reorder: vi.fn(),
}));

const mockHeartbeatWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerServiceMocks() {
  vi.doMock("../routes/authz.js", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/authz.ts", async () =>
    vi.importActual<typeof import("../routes/authz.ts")>("../routes/authz.ts"),
  );
  vi.doMock("../routes/workspace-command-authz.js", async () =>
    vi.importActual<typeof import("../routes/workspace-command-authz.ts")>("../routes/workspace-command-authz.ts"),
  );
  vi.doMock("../routes/workspace-command-authz.ts", async () =>
    vi.importActual<typeof import("../routes/workspace-command-authz.ts")>("../routes/workspace-command-authz.ts"),
  );
  vi.doMock("../routes/issues-checkout-wakeup.js", async () =>
    vi.importActual<typeof import("../routes/issues-checkout-wakeup.ts")>("../routes/issues-checkout-wakeup.ts"),
  );
  vi.doMock("../routes/issues-checkout-wakeup.ts", async () =>
    vi.importActual<typeof import("../routes/issues-checkout-wakeup.ts")>("../routes/issues-checkout-wakeup.ts"),
  );
  const servicesIndexMock = () => ({
    accessService: () => ({
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
    }),
    agentService: () => ({
      getById: vi.fn(async () => null),
    }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({
      getById: vi.fn(async () => null),
    }),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => ({
      wakeup: mockHeartbeatWakeup,
      reportRunActivity: vi.fn(async () => undefined),
      getRun: vi.fn(async () => null),
      getActiveRunForAgent: vi.fn(async () => null),
      cancelRun: vi.fn(async () => null),
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
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({
      syncRunStatusForIssue: vi.fn(async () => undefined),
    }),
    workProductService: () => ({}),
  });

  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
  vi.doMock("../telemetry.ts", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
  vi.doMock("../services/index.js", servicesIndexMock);
  vi.doMock("../services/index.ts", servicesIndexMock);
  vi.doMock("../services/issue-assignment-wakeup.js", async () =>
    vi.importActual<typeof import("../services/issue-assignment-wakeup.ts")>(
      "../services/issue-assignment-wakeup.ts",
    ),
  );
  vi.doMock("../services/issue-assignment-wakeup.ts", async () =>
    vi.importActual<typeof import("../services/issue-assignment-wakeup.ts")>(
      "../services/issue-assignment-wakeup.ts",
    ),
  );
  vi.doMock("../services/issue-execution-policy.js", async () =>
    vi.importActual<typeof import("../services/issue-execution-policy.ts")>("../services/issue-execution-policy.ts"),
  );
  vi.doMock("../services/issue-execution-policy.ts", async () =>
    vi.importActual<typeof import("../services/issue-execution-policy.ts")>("../services/issue-execution-policy.ts"),
  );
  vi.doMock("../middleware/validate.js", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/validate.ts", async () =>
    vi.importActual<typeof import("../middleware/validate.ts")>("../middleware/validate.ts"),
  );
  vi.doMock("../middleware/index.js", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/index.ts", async () =>
    vi.importActual<typeof import("../middleware/index.ts")>("../middleware/index.ts"),
  );
  vi.doMock("../middleware/logger.js", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../middleware/logger.ts", async () =>
    vi.importActual<typeof import("../middleware/logger.ts")>("../middleware/logger.ts"),
  );
  vi.doMock("../attachment-types.js", async () =>
    vi.importActual<typeof import("../attachment-types.ts")>("../attachment-types.ts"),
  );
  vi.doMock("../attachment-types.ts", async () =>
    vi.importActual<typeof import("../attachment-types.ts")>("../attachment-types.ts"),
  );
}

function resetIssueRouteModules() {
  vi.resetModules();
  vi.doUnmock("@paperclipai/db");
  vi.doUnmock("@paperclipai/shared");
  vi.doUnmock("@paperclipai/shared/telemetry");
  vi.doUnmock("../attachment-types.js");
  vi.doUnmock("../attachment-types.ts");
  vi.doUnmock("../errors.js");
  vi.doUnmock("../errors.ts");
  vi.doUnmock("../telemetry.js");
  vi.doUnmock("../telemetry.ts");
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/index.ts");
  vi.doUnmock("../services/issue-assignment-wakeup.js");
  vi.doUnmock("../services/issue-assignment-wakeup.ts");
  vi.doUnmock("../services/issue-execution-policy.js");
  vi.doUnmock("../services/issue-execution-policy.ts");
  vi.doUnmock("../routes/issues.js");
  vi.doUnmock("../routes/issues.ts");
  vi.doUnmock("../routes/authz.js");
  vi.doUnmock("../routes/authz.ts");
  vi.doUnmock("../routes/issues-checkout-wakeup.js");
  vi.doUnmock("../routes/issues-checkout-wakeup.ts");
  vi.doUnmock("../routes/workspace-command-authz.js");
  vi.doUnmock("../routes/workspace-command-authz.ts");
  vi.doUnmock("../middleware/index.js");
  vi.doUnmock("../middleware/index.ts");
  vi.doUnmock("../middleware/validate.js");
  vi.doUnmock("../middleware/validate.ts");
  vi.doUnmock("../middleware/logger.js");
  vi.doUnmock("../middleware/logger.ts");
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId: "company-1",
    status: "todo",
    boardPosition: 1,
    assigneeAgentId: null,
    assigneeUserId: null,
    identifier: "PAP-11",
    title: "Reorder route issue",
    executionWorkspaceId: null,
    ...overrides,
  };
}

let issueRouteImportSeq = 0;

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  resetIssueRouteModules();
  registerServiceMocks();
  issueRouteImportSeq += 1;
  const routeModulePath = `../routes/issues.ts?issue-reorder-routes-${issueRouteImportSeq}`;
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/issues.ts")>,
    import("../middleware/index.ts"),
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

describe("issue reorder routes", () => {
  beforeEach(() => {
    resetIssueRouteModules();
    registerServiceMocks();
    vi.clearAllMocks();
    mockIssueService.getById.mockResolvedValue(makeIssue({
      status: "backlog",
      boardPosition: 0,
      assigneeAgentId: "agent-1",
    }));
    mockIssueService.reorder.mockResolvedValue(makeIssue({
      status: "todo",
      boardPosition: 1,
      assigneeAgentId: "agent-1",
    }));
  });

  it("reorders an issue, logs activity, and wakes assigned backlog work", async () => {
    const res = await request(await createApp())
      .post(`/api/issues/${issueId}/reorder`)
      .send({ status: "todo", beforeIssueId });

    expect(res.status).toBe(200);
    expect(mockIssueService.reorder).toHaveBeenCalledWith(issueId, {
      status: "todo",
      beforeIssueId,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.reordered",
        entityId: issueId,
        details: expect.objectContaining({
          status: "todo",
          boardPosition: 1,
          beforeIssueId,
          _previous: {
            status: "backlog",
            boardPosition: 0,
          },
        }),
      }),
    );
    expect(mockHeartbeatWakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        reason: "issue_status_changed",
        payload: { issueId, mutation: "reorder" },
      }),
    );
  });

  it("requires board access", async () => {
    const res = await request(await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    }))
      .post(`/api/issues/${issueId}/reorder`)
      .send({ status: "todo", beforeIssueId: null });

    expect(res.status).toBe(403);
    expect(mockIssueService.reorder).not.toHaveBeenCalled();
  });
});
