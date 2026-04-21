import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const assigneeAgentId = "33333333-3333-4333-8333-333333333333";

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  listCoverAttachmentsForIssues: vi.fn(),
  listLinksForIssues: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  hasPermission: vi.fn(async () => false),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

function registerModuleMocks() {
  const sharedTelemetryMock = () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  });
  const telemetryMock = () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  });
  const servicesIndexMock = () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
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
      listCompanyIds: vi.fn(async () => [companyId]),
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
  vi.doMock("@paperclipai/shared/telemetry", sharedTelemetryMock);
  vi.doMock("../telemetry.js", telemetryMock);
  vi.doMock("../telemetry.ts", telemetryMock);
  vi.doMock("../services/index.js", servicesIndexMock);
  vi.doMock("../services/index.ts", servicesIndexMock);
}

function resetIssueRouteModules() {
  vi.resetModules();
  vi.doUnmock("@paperclipai/db");
  vi.doUnmock("@paperclipai/shared");
  vi.doUnmock("@paperclipai/shared/telemetry");
  vi.doUnmock("../telemetry.js");
  vi.doUnmock("../telemetry.ts");
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
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/index.ts");
  vi.doUnmock("../services/issue-assignment-wakeup.js");
  vi.doUnmock("../services/issue-assignment-wakeup.ts");
  vi.doUnmock("../services/issue-execution-policy.js");
  vi.doUnmock("../services/issue-execution-policy.ts");
  vi.doUnmock("../attachment-types.js");
  vi.doUnmock("../attachment-types.ts");
}

function registerRouteActuals() {
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

let issueRouteImportSeq = 0;

async function createApp(actor: Record<string, unknown>) {
  resetIssueRouteModules();
  registerRouteActuals();
  registerModuleMocks();
  issueRouteImportSeq += 1;
  const routeModulePath = `../routes/issues.ts?issue-create-authz-${issueRouteImportSeq}`;
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

describe("issue create authorization", () => {
  beforeEach(() => {
    resetIssueRouteModules();
    registerRouteActuals();
    registerModuleMocks();
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId,
      role: "manager",
      permissions: { canCreateAgents: false },
    });
    mockIssueService.create.mockImplementation(async (_companyId: string, body: Record<string, unknown>) => ({
      id: "issue-1",
      companyId,
      title: String(body.title),
      status: body.status ?? "backlog",
      priority: body.priority ?? "medium",
      dueDate: body.dueDate ?? null,
      assigneeAgentId: body.assigneeAgentId ?? null,
      assigneeUserId: null,
    }));
    mockIssueService.list.mockResolvedValue([
      {
        id: "issue-1",
        companyId,
        title: "Investigate stalled queue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        assigneeUserId: null,
      },
    ]);
    mockIssueService.listCoverAttachmentsForIssues.mockResolvedValue(new Map());
    mockIssueService.listLinksForIssues.mockResolvedValue(new Map());
  });

  it("lets agents list issues in their own company", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    });

    const res = await request(app).get(`/api/companies/${companyId}/issues`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({}),
    );
    expect(res.body).toHaveLength(1);
  });

  it("passes due date filters through issue reads", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({
        dueDate: "2026-04-19",
        dueFrom: "2026-04-19",
        dueTo: "2026-04-25",
      });

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        dueDate: "2026-04-19",
        dueFrom: "2026-04-19",
        dueTo: "2026-04-25",
      }),
    );
  });

  it("rejects invalid due date filters", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/issues`)
      .query({ dueFrom: "2026-02-30" });

    expect(res.status).toBe(400);
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("rejects agent issue reads for another company", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId: "other-company",
      runId: "run-1",
    });

    const res = await request(app).get(`/api/companies/${companyId}/issues`);

    expect(res.status).toBe(403);
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("lets agents create unassigned issues without tasks:assign", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Investigate stalled queue",
        status: "todo",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        title: "Investigate stalled queue",
        createdByAgentId: agentId,
      }),
    );
  });

  it("accepts date-only due dates when creating issues", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Finish launch notes",
        status: "todo",
        dueDate: "2026-05-01",
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        dueDate: "2026-05-01",
      }),
    );
  });

  it("rejects invalid issue due dates", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Bad due date",
        dueDate: "2026-02-30",
      });

    expect(res.status).toBe(400);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects agent issue creation for another company", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId: "other-company",
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Cross-company write attempt",
        status: "todo",
      });

    expect(res.status).toBe(403);
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects agent assignment changes without tasks:assign", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Escalate blocker to CEO",
        status: "todo",
        assigneeAgentId,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("tasks:assign");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("allows agent assignment changes when the agent has tasks:assign", async () => {
    mockAccessService.hasPermission.mockResolvedValue(true);
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Delegate unblock",
        status: "todo",
        assigneeAgentId,
      });

    expect(res.status).toBe(201);
    expect(mockIssueService.create).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        assigneeAgentId,
      }),
    );
  });
});
