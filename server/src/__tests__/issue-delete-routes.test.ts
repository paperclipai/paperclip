import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";

const mockIssueService = vi.hoisted(() => ({
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  listAttachments: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerServiceMocks() {
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
      wakeup: vi.fn(async () => undefined),
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
    assigneeAgentId: null,
    assigneeUserId: null,
    identifier: "PAP-187",
    title: "Delete route issue",
    executionWorkspaceId: null,
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
}) {
  resetIssueRouteModules();
  registerServiceMocks();
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.ts"),
    import("../middleware/index.ts"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes({} as any, { deleteObject: vi.fn(async () => undefined) } as any));
  app.use(errorHandler);
  return app;
}

describe("issue delete routes", () => {
  beforeEach(() => {
    resetIssueRouteModules();
    registerServiceMocks();
    vi.clearAllMocks();
    mockIssueService.getByIdentifier.mockResolvedValue(makeIssue());
    mockIssueService.getById.mockResolvedValue(makeIssue());
    mockIssueService.listAttachments.mockResolvedValue([]);
    mockIssueService.remove.mockResolvedValue(makeIssue());
  });

  it("deletes identifier-routed issues by resolved UUID and logs activity", async () => {
    const res = await request(await createApp()).delete("/api/issues/PAP-187");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-187");
    expect(mockIssueService.getById).toHaveBeenCalledWith(issueId);
    expect(mockIssueService.listAttachments).toHaveBeenCalledWith(issueId);
    expect(mockIssueService.remove).toHaveBeenCalledWith(issueId);
    expect(mockIssueService.remove).not.toHaveBeenCalledWith("PAP-187");
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.deleted",
        entityId: issueId,
      }),
    );
  });

  it("returns not found without deleting when the issue reference does not resolve", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.getById.mockResolvedValue(null);

    const res = await request(await createApp()).delete("/api/issues/PAP-404");

    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-404");
    expect(mockIssueService.getById).toHaveBeenCalledWith("PAP-404");
    expect(mockIssueService.listAttachments).not.toHaveBeenCalled();
    expect(mockIssueService.remove).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
