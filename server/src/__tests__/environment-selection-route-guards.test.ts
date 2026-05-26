import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";
import { issueRoutes } from "../routes/issues.js";

const mockProjectService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
  listWorkspaces: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  getByIdentifier: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueReferenceService = vi.hoisted(() => ({
  deleteDocumentSource: vi.fn(async () => undefined),
  diffIssueReferenceSummary: vi.fn(() => ({
    addedReferencedIssues: [],
    removedReferencedIssues: [],
    currentReferencedIssues: [],
  })),
  emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
  listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
  syncComment: vi.fn(async () => undefined),
  syncDocument: vi.fn(async () => undefined),
  syncIssue: vi.fn(async () => undefined),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(async (_companyId: string, env: Record<string, unknown>) => env),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  projectService: () => mockProjectService,
  issueService: () => mockIssueService,
  companyService: () => mockCompanyService,
  environmentService: () => mockEnvironmentService,
  issueReferenceService: () => mockIssueReferenceService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
    resolveByReference: vi.fn(async (_companyId: string, raw: string) => ({
      agent: { id: raw.trim(), companyId: "company-1" },
      ambiguous: false,
    })),
  }),
  executionWorkspaceService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    getRun: vi.fn(),
    getActiveRunForAgent: vi.fn(),
    reportRunActivity: vi.fn(async () => undefined),
    cancelRun: vi.fn(async () => null),
  }),
  issueApprovalService: () => ({
    listApprovalsForIssue: vi.fn(),
    unlink: vi.fn(),
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  documentService: () => ({}),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({}),
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

const mockQueueIssueAssignmentWakeup = vi.hoisted(() => vi.fn());

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockQueueIssueAssignmentWakeup,
}));

function buildApp(routerFactory: (app: express.Express) => void) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    };
    next();
  });
  routerFactory(app);
  app.use(errorHandler);
  return app;
}

let projectServer: Server | null = null;
let issueServer: Server | null = null;

function createProjectApp() {
  projectServer ??= buildApp((expressApp) => {
    expressApp.use("/api", projectRoutes({} as any));
  }).listen(0);
  return projectServer;
}

function createIssueApp() {
  issueServer ??= buildApp((expressApp) => {
    expressApp.use("/api", issueRoutes({} as any, {} as any));
  }).listen(0);
  return issueServer;
}

const sandboxEnvironmentId = "11111111-1111-4111-8111-111111111111";

async function closeServer(server: Server | null) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

describe.sequential("execution environment route guards", () => {
  afterAll(async () => {
    await closeServer(projectServer);
    await closeServer(issueServer);
    projectServer = null;
    issueServer = null;
  });

  beforeEach(() => {
    mockProjectService.create.mockReset();
    mockProjectService.getById.mockReset();
    mockProjectService.update.mockReset();
    mockProjectService.createWorkspace.mockReset();
    mockProjectService.remove.mockReset();
    mockProjectService.resolveByReference.mockReset();
    mockProjectService.listWorkspaces.mockReset();
    mockIssueService.create.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockCompanyService.getById.mockReset();
    mockCompanyService.getById.mockResolvedValue({
      id: "company-1",
      attachmentMaxBytes: 10 * 1024 * 1024,
    });
    mockEnvironmentService.getById.mockReset();
    mockIssueReferenceService.deleteDocumentSource.mockClear();
    mockIssueReferenceService.diffIssueReferenceSummary.mockClear();
    mockIssueReferenceService.emptySummary.mockClear();
    mockIssueReferenceService.listIssueReferenceSummary.mockClear();
    mockIssueReferenceService.syncComment.mockClear();
    mockIssueReferenceService.syncDocument.mockClear();
    mockIssueReferenceService.syncIssue.mockClear();
    mockSecretService.normalizeEnvBindingsForPersistence.mockClear();
    mockLogActivity.mockReset();
  });

  it("accepts sandbox environments on project create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    mockProjectService.create.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Sandboxed Project",
      status: "backlog",
    });
    const app = createProjectApp();

    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Sandboxed Project",
        executionWorkspacePolicy: {
          enabled: true,
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockProjectService.create).toHaveBeenCalled();
  });

  it("accepts sandbox environments on project update", async () => {
    mockProjectService.getById.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Sandboxed Project",
      status: "backlog",
      archivedAt: null,
    });
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    mockProjectService.update.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "Sandboxed Project",
      status: "backlog",
    });
    const app = createProjectApp();

    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        executionWorkspacePolicy: {
          enabled: true,
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockProjectService.update).toHaveBeenCalled();
  });

  it("accepts sandbox environments on issue create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    mockIssueService.create.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      title: "Sandboxed Issue",
      status: "todo",
      identifier: "PAPA-999",
    });
    const app = createIssueApp();

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Sandboxed Issue",
        executionWorkspaceSettings: {
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("rejects unsupported driver environments on issue create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "unsupported_driver",
      config: {},
    });
    const app = createIssueApp();

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Unsupported Driver Issue",
        executionWorkspaceSettings: {
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Environment driver "unsupported_driver" is not allowed here');
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects built-in fake sandbox environments on issue create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake" },
    });
    const app = createIssueApp();

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Fake Sandbox Issue",
        executionWorkspaceSettings: {
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Environment sandbox provider "fake" is not allowed here');
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("accepts plugin-backed sandbox environments on issue create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    mockIssueService.create.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      title: "Plugin Sandbox Issue",
      status: "todo",
      identifier: "PAPA-999",
    });
    const app = createIssueApp();

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Plugin Sandbox Issue",
        executionWorkspaceSettings: {
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("accepts sandbox environments on issue update", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: null,
      identifier: "PAPA-999",
    });
    mockEnvironmentService.getById.mockResolvedValue({
      id: sandboxEnvironmentId,
      companyId: "company-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      status: "todo",
      identifier: "PAPA-999",
    });
    const app = createIssueApp();

    const res = await request(app)
      .patch("/api/issues/issue-1")
      .send({
        executionWorkspaceSettings: {
          environmentId: sandboxEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockIssueService.update).toHaveBeenCalled();
  });

  describe("PATCH assignment wakeup (MON-485)", () => {
    const agentA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const agentB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const patchWakeIssue = {
      id: "issue-patch-wakeup",
      companyId: "company-1",
      status: "todo" as const,
      assigneeAgentId: agentA,
      assigneeUserId: null,
      createdByUserId: null,
      identifier: "PAP-WAKE",
      title: "Wakeup PATCH",
      description: "desc",
      workMode: "planning" as const,
      priority: "medium" as const,
      executionPolicy: null,
      executionState: null,
      parentId: null,
      goalId: null,
      projectId: null,
      labels: [] as unknown[],
      labelIds: [] as unknown[],
      executionWorkspaceId: null,
      updatedAt: new Date(),
    };

    async function settleAfterPatch() {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    beforeEach(() => {
      mockQueueIssueAssignmentWakeup.mockClear();
      mockIssueService.getById.mockResolvedValue({ ...patchWakeIssue });
      mockIssueService.update.mockImplementation(async (_id: string, fields: Record<string, unknown>) =>
        ({
          ...patchWakeIssue,
          ...fields,
          assigneeAgentId:
            fields.assigneeAgentId === undefined ? patchWakeIssue.assigneeAgentId : fields.assigneeAgentId,
          assigneeUserId:
            fields.assigneeUserId === undefined ? patchWakeIssue.assigneeUserId : fields.assigneeUserId,
        }));
    });

    it("queues exactly one assignment wakeup when assigneeAgentId changes to another agent", async () => {
      const app = createIssueApp();
      const res = await request(app).patch(`/api/issues/${patchWakeIssue.id}`).send({ assigneeAgentId: agentB });
      await settleAfterPatch();

      expect(res.status).toBe(200);
      expect(mockQueueIssueAssignmentWakeup).toHaveBeenCalledTimes(1);
      expect(mockQueueIssueAssignmentWakeup).toHaveBeenCalledWith(
        expect.objectContaining({
          issue: expect.objectContaining({ id: patchWakeIssue.id, assigneeAgentId: agentB }),
          mutation: "patch",
          contextSource: "issue.patch",
          reason: "issue_assigned",
        }),
      );
    });

    it("queues no assignment wakeup when only description changes", async () => {
      const app = createIssueApp();
      const res = await request(app).patch(`/api/issues/${patchWakeIssue.id}`).send({
        description: "updated body",
      });
      await settleAfterPatch();

      expect(res.status).toBe(200);
      expect(mockQueueIssueAssignmentWakeup).not.toHaveBeenCalled();
    });

    it("routes unassign PATCH through wakeup helper without heartbeat (null assignee short-circuit)", async () => {
      const app = createIssueApp();
      const res = await request(app).patch(`/api/issues/${patchWakeIssue.id}`).send({ assigneeAgentId: null });
      await settleAfterPatch();

      expect(res.status).toBe(200);
      expect(mockQueueIssueAssignmentWakeup).not.toHaveBeenCalled();
    });
  });
});
