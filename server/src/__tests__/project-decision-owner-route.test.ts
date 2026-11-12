import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
  getMembership: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => mockEnvironmentService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/activity-log.js", async () => ({
    ...await vi.importActual<typeof import("../services/activity-log.js")>("../services/activity-log.js"),
    persistActivity: async (db: unknown, input: unknown) => { await mockLogActivity(db, input); return { activity: { id: "activity" }, publication: null }; },
    publishActivity: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    environmentService: () => mockEnvironmentService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
}

const BOARD_ACTOR = {
  type: "board",
  userId: "board-user",
  companyIds: ["company-1"],
  source: "local_implicit",
  isInstanceAdmin: false,
};

async function createApp(actor: Record<string, unknown> = BOARD_ACTOR) {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", projectRoutes({ transaction: async (effect: (tx: unknown) => unknown) => effect({}) } as any));
  app.use(errorHandler);
  return app;
}

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "backlog",
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project",
      effectiveLocalFolder: "/tmp/project",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// PAP-749 task 1d: a project's decision owner gets the project's ownerless
// Needs You cards, so only a board user sets it, and only to an active member.
describe("project decision owner routes", { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/secrets.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.listWorkspaces.mockResolvedValue([]);
    mockProjectService.list.mockResolvedValue([]);
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(async (_companyId, env) => env);
  });

  it("sets an active member as the decision owner and logs the change", async () => {
    mockAccessService.getMembership.mockResolvedValue({ status: "active" });
    mockProjectService.update.mockResolvedValue(buildProject({ decisionOwnerUserId: "user-2" }));
    const app = await createApp();

    const res = await request(app).patch("/api/projects/project-1").send({ decisionOwnerUserId: "user-2" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.decisionOwnerUserId).toBe("user-2");
    expect(mockAccessService.getMembership).toHaveBeenCalledWith("company-1", "user", "user-2");
    expect(mockProjectService.update).toHaveBeenCalledWith("project-1", { decisionOwnerUserId: "user-2" });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "project.updated",
      details: expect.objectContaining({ changedKeys: ["decisionOwnerUserId"] }),
    }));
  });

  it("clears the decision owner without a membership lookup", async () => {
    mockProjectService.getById.mockResolvedValue(buildProject({ decisionOwnerUserId: "user-2" }));
    mockProjectService.update.mockResolvedValue(buildProject({ decisionOwnerUserId: null }));
    const app = await createApp();

    const res = await request(app).patch("/api/projects/project-1").send({ decisionOwnerUserId: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockAccessService.getMembership).not.toHaveBeenCalled();
  });

  it.each([
    ["not a member", null],
    ["a suspended member", { status: "suspended" }],
  ])("rejects a decision owner who is %s with 422", async (_label, membership) => {
    mockAccessService.getMembership.mockResolvedValue(membership);
    const app = await createApp();

    const res = await request(app).patch("/api/projects/project-1").send({ decisionOwnerUserId: "outsider" });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("active member");
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("validates the decision owner on create too", async () => {
    mockAccessService.getMembership.mockResolvedValue(null);
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/projects")
      .send({ name: "Project", decisionOwnerUserId: "outsider" });

    expect(res.status).toBe(422);
    expect(mockProjectService.create).not.toHaveBeenCalled();
  });

  it("does not let an agent change the decision owner", async () => {
    const app = await createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" });

    const res = await request(app).patch("/api/projects/project-1").send({ decisionOwnerUserId: "user-2" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });
});
