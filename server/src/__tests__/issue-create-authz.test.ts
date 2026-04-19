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

vi.mock("../services/index.js", () => ({
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
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
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
  }));
}

async function createApp(actor: Record<string, unknown>) {
  vi.resetModules();
  registerModuleMocks();
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
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
