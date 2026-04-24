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
  createChild: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  getByIdentifier: vi.fn(),
  assertCheckoutOwner: vi.fn(),
}));

const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockReferenceSummary = vi.hoisted(() => ({
  inbound: [],
  outbound: [],
  documentSources: [],
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  projectService: () => mockProjectService,
  issueService: () => mockIssueService,
  environmentService: () => mockEnvironmentService,
  secretService: () => ({
    normalizeEnvBindingsForPersistence: vi.fn(async (_companyId: string, env: unknown) => env),
    normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: unknown) => config),
  }),
  logActivity: mockLogActivity,
  workspaceOperationService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  executionWorkspaceService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    getRun: vi.fn(),
    getActiveRunForAgent: vi.fn(),
  }),
  issueApprovalService: () => ({
    listApprovalsForIssue: vi.fn(),
    unlink: vi.fn(),
  }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(),
    listFeedbackTraces: vi.fn(),
    getFeedbackTraceById: vi.fn(),
    getFeedbackTraceBundle: vi.fn(),
    saveIssueVote: vi.fn(),
  }),
  instanceSettingsService: () => ({
    get: vi.fn(async () => ({})),
    listCompanyIds: vi.fn(async () => []),
  }),
  issueReferenceService: () => ({
    emptySummary: vi.fn(() => mockReferenceSummary),
    syncIssue: vi.fn(),
    syncComment: vi.fn(),
    syncDocument: vi.fn(),
    deleteDocumentSource: vi.fn(),
    listIssueReferenceSummary: vi.fn(async () => mockReferenceSummary),
    diffIssueReferenceSummary: vi.fn(() => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    })),
  }),
  documentService: () => ({}),
  routineService: () => ({}),
  workProductService: () => ({}),
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
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

const sshEnvironmentId = "11111111-1111-4111-8111-111111111111";

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
    mockIssueService.createChild.mockReset();
    mockIssueService.getById.mockReset();
    mockIssueService.update.mockReset();
    mockIssueService.getByIdentifier.mockReset();
    mockIssueService.assertCheckoutOwner.mockReset();
    mockEnvironmentService.getById.mockReset();
    mockLogActivity.mockReset();
  });

  it("accepts SSH environments on project create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sshEnvironmentId,
      companyId: "company-1",
      driver: "ssh",
      config: {},
    });
    mockProjectService.create.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "SSH Project",
      status: "backlog",
    });
    const app = createProjectApp();

    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "SSH Project",
        executionWorkspacePolicy: {
          enabled: true,
          environmentId: sshEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockProjectService.create).toHaveBeenCalled();
  });

  it("accepts SSH environments on project update", async () => {
    mockProjectService.getById.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "SSH Project",
      status: "backlog",
      archivedAt: null,
    });
    mockEnvironmentService.getById.mockResolvedValue({
      id: sshEnvironmentId,
      companyId: "company-1",
      driver: "ssh",
      config: {},
    });
    mockProjectService.update.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "SSH Project",
      status: "backlog",
    });
    const app = createProjectApp();

    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        executionWorkspacePolicy: {
          enabled: true,
          environmentId: sshEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockProjectService.update).toHaveBeenCalled();
  });

  it("rejects cross-company environments on project create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sshEnvironmentId,
      companyId: "company-2",
      driver: "ssh",
      config: {},
    });
    const app = createProjectApp();

    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Cross Company Project",
        executionWorkspacePolicy: {
          enabled: true,
          environmentId: sshEnvironmentId,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Environment not found.");
    expect(mockProjectService.create).not.toHaveBeenCalled();
  });

  it("rejects unsupported driver environments on project update", async () => {
    mockProjectService.getById.mockResolvedValue({
      id: "project-1",
      companyId: "company-1",
      name: "SSH Project",
      status: "backlog",
      archivedAt: null,
    });
    mockEnvironmentService.getById.mockResolvedValue({
      id: sshEnvironmentId,
      companyId: "company-1",
      driver: "unsupported_driver",
      config: {},
    });
    const app = createProjectApp();

    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({
        executionWorkspacePolicy: {
          enabled: true,
          environmentId: sshEnvironmentId,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Environment driver "unsupported_driver" is not allowed here');
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("rejects archived environments on project create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sshEnvironmentId,
      companyId: "company-1",
      driver: "ssh",
      status: "archived",
      config: {},
    });
    const app = createProjectApp();

    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({
        name: "Archived Project",
        executionWorkspacePolicy: {
          enabled: true,
          environmentId: sshEnvironmentId,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Environment is archived.");
    expect(mockProjectService.create).not.toHaveBeenCalled();
  });

  it("rejects archived environments on issue create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sshEnvironmentId,
      companyId: "company-1",
      driver: "ssh",
      status: "archived",
      config: {},
    });
    const app = createIssueApp();

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "Archived Issue",
        executionWorkspaceSettings: {
          environmentId: sshEnvironmentId,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Environment is archived.");
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("accepts SSH environments on issue create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sshEnvironmentId,
      companyId: "company-1",
      driver: "ssh",
      config: {},
    });
    mockIssueService.create.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      title: "SSH Issue",
      status: "todo",
      identifier: "PAPA-999",
    });
    const app = createIssueApp();

    const res = await request(app)
      .post("/api/companies/company-1/issues")
      .send({
        title: "SSH Issue",
        executionWorkspaceSettings: {
          environmentId: sshEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockIssueService.create).toHaveBeenCalled();
  });

  it("rejects unsupported driver environments on issue create", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: sshEnvironmentId,
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
          environmentId: sshEnvironmentId,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Environment driver "unsupported_driver" is not allowed here');
    expect(mockIssueService.create).not.toHaveBeenCalled();
  });

  it("rejects unsupported driver environments on child issue create", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "parent-1",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: null,
      identifier: "PAPA-998",
    });
    mockEnvironmentService.getById.mockResolvedValue({
      id: sshEnvironmentId,
      companyId: "company-1",
      driver: "unsupported_driver",
      config: {},
    });
    const app = createIssueApp();

    const res = await request(app)
      .post("/api/issues/parent-1/children")
      .send({
        title: "Unsupported Child",
        executionWorkspaceSettings: {
          environmentId: sshEnvironmentId,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain('Environment driver "unsupported_driver" is not allowed here');
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("rejects cross-company environments on child issue create", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "parent-1",
      companyId: "company-1",
      status: "todo",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByUserId: null,
      identifier: "PAPA-998",
    });
    mockEnvironmentService.getById.mockResolvedValue({
      id: sshEnvironmentId,
      companyId: "company-2",
      driver: "ssh",
      config: {},
    });
    const app = createIssueApp();

    const res = await request(app)
      .post("/api/issues/parent-1/children")
      .send({
        title: "Cross Company Child",
        executionWorkspaceSettings: {
          environmentId: sshEnvironmentId,
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Environment not found.");
    expect(mockIssueService.createChild).not.toHaveBeenCalled();
  });

  it("accepts SSH environments on issue update", async () => {
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
      id: sshEnvironmentId,
      companyId: "company-1",
      driver: "ssh",
      config: {},
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
          environmentId: sshEnvironmentId,
        },
      });

    expect(res.status).not.toBe(422);
    expect(mockIssueService.update).toHaveBeenCalled();
  });
});
